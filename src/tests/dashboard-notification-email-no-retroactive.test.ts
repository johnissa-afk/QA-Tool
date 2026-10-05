// No retroactive delivery, and notification correctness.
//
// Two promises are checked here, and they are different from each other.
//
// The first is that delivery follows NEW activity only. Turning email on, opening
// the dashboard, refreshing the page, marking a notification read, reading the
// preview of an old run, restarting the process - none of these is a reason to
// mail somebody about work that finished before email was ever switched on. Every
// one of them is a GET, a read-state write, or a restart, and all of them are
// exercised below against a notification that predates the switch.
//
// The second is that the in-app inbox and the email channel are independent
// facts. Email being switched off, broken, or failing must never cost the team
// the notification itself, because the notification is the product's own record
// of what happened and email is only one way of telling someone about it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALICE,
  fakeTransport,
  harness,
  readDeliveries,
  readNotifications,
  restartOn,
} from "./notification-email-fixtures.js";
import { labelFinding, send } from "./notification-fixtures.js";

const post = (url: string) => fetch(url, { method: "POST" }).then(r => r.json());

/** Every read surface the dashboard offers, each of which must stay inert. */
const readEverySurface = async (base: string, projectId: string, runId: string): Promise<string[]> => {
  const bodies = await Promise.all([
    fetch(`${base}/api/notifications`).then(r => r.json()),
    fetch(`${base}/api/notifications?unreadOnly=true`).then(r => r.json()),
    fetch(`${base}/api/notifications/unread-count`).then(r => r.json()),
    fetch(`${base}/api/projects/${projectId}/notifications`).then(r => r.json()),
    fetch(`${base}/api/projects/${projectId}/notification-preview/${runId}`).then(r => r.json()),
    fetch(`${base}/api/projects/${projectId}`).then(r => r.json()),
    fetch(`${base}/api/history`).then(r => r.json()),
  ]);
  return bodies.map(b => JSON.stringify(b));
};

// ===========================================================================
// 1. Reads of a pre-existing notification never deliver
// ===========================================================================

test("no retroactive delivery: reading, refreshing and previewing an old notification sends nothing", async () => {
  // Email is off for this run, so the notification is guaranteed to predate any
  // possibility of delivery.
  const fake = fakeTransport();
  const h = await harness({ enabled: false, transport: fake.transport });
  try {
    const runId = await h.runFinding();
    await h.dash.settleEmailDeliveries();

    const inbox = await h.notifications();
    assert.equal(inbox.length, 1, "the notification exists");
    assert.equal(inbox[0].read, false);

    // A refresh in a browser is several reads and a read-state write.
    for (let i = 0; i < 3; i += 1) await readEverySurface(h.base, h.projectId, runId);
    await post(`${h.base}/api/notifications/${inbox[0]!.id}/read`);
    await post(`${h.base}/api/notifications/read-all`);
    await readEverySurface(h.base, h.projectId, runId);

    assert.equal(fake.attempts.length, 0, "no read produced an email");
    assert.equal(readDeliveries(h.dir).length, 0, "and no delivery record was invented");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 2. Switching email ON does not mail the backlog
// ===========================================================================

test("no retroactive delivery: enabling email does not mail notifications that already exist", async () => {
  const before = fakeTransport();
  const first = await harness({ enabled: false, transport: before.transport });
  const dir = first.dir;
  const projectId = first.projectId;
  let runId: string;
  // Captured by ID, not by position: two runs inside the same millisecond leave
  // the document order to chance, so "the newest is first" is not a fact this
  // test is allowed to depend on.
  let backlog = new Set<string>();
  try {
    runId = await first.runFinding();
    await first.dash.settleEmailDeliveries();
    assert.equal(before.attempts.length, 0);
    backlog = new Set(readNotifications(dir).map(n => String(n.id)));
  } finally {
    await first.cleanup();
  }

  // The operator now turns email on. The backlog is sitting right there.
  const after = fakeTransport();
  const second = await restartOn(dir, projectId, after.transport);
  try {
    const enabled = await send("PUT", `${second.base}/api/projects/${projectId}/email-settings`, {
      enabled: true, recipients: [ALICE], events: ["NEW_FINDING"],
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));

    // Every surface is read again with email now switched on.
    await readEverySurface(second.base, projectId, runId!);
    await second.dash.settleEmailDeliveries();

    assert.equal(after.attempts.length, 0,
      "turning email on is a change of preference, not an event: the backlog is not mailed");
    assert.equal(readDeliveries(dir).length, 0, "and nothing was recorded for it");

    // Only genuinely new activity delivers, and only its own notification.
    // The finding must be a DIFFERENT one: re-reporting the same finding is not a
    // new finding, and a repeat is deliberately not alerted on again.
    await second.runFinding(labelFinding());
    await second.dash.settleEmailDeliveries();

    assert.equal(after.attempts.length, 1, "exactly one email, for the new finding");
    const records = readDeliveries(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "SENT");
    assert.equal(backlog.has(records[0]!.notificationId), false,
      "and it refers to the new notification, not one of the backlog");
  } finally {
    await second.cleanup();
  }
});

// ===========================================================================
// 3. Restart does not mail the backlog either
// ===========================================================================

test("no retroactive delivery: restarting with email on does not replay old notifications", async () => {
  const first = fakeTransport();
  const h = await harness({ enabled: false, transport: first.transport });
  const dir = h.dir;
  const projectId = h.projectId;
  let runId: string;
  try {
    runId = await h.runFinding();
    await h.cleanup();
  } finally {
    await h.cleanup();
  }

  const after = fakeTransport();
  const second = await restartOn(dir, projectId, after.transport);
  try {
    const enabled = await send("PUT", `${second.base}/api/projects/${projectId}/email-settings`, {
      enabled: true, recipients: [ALICE], events: ["NEW_FINDING"],
    });
    assert.equal(enabled.status, 200);

    await readEverySurface(second.base, projectId, runId!);
    await second.dash.settleEmailDeliveries();

    assert.equal(after.attempts.length, 0,
      "a restart re-reads the inbox, and reading an inbox is not delivery");
    assert.equal(readDeliveries(dir).length, 0);
  } finally {
    await second.cleanup();
  }
});

// ===========================================================================
// 4. The inbox survives every email failure
// ===========================================================================

test("notification correctness: a total email failure never costs the team the notification", async () => {
  const broken = fakeTransport({ status: "FAILED", error: "SMTP send failed: EAUTH: authentication failed" });
  const h = await harness({ transport: broken.transport });
  try {
    await h.runFinding();

    const inbox = await h.notifications();
    assert.equal(inbox.length, 1, "the notification is created regardless of what the transport did");
    assert.equal(inbox[0]!.type, "NEW_FINDING", "and it is the right kind of notification");
    assert.equal(inbox[0]!.read, false, "it arrives unread, so it is actually noticed");
    assert.ok(inbox[0]!.title.length > 0 && inbox[0]!.message.length > 0, "with content a human can act on");

    const records = readDeliveries(h.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "FAILED");
    assert.equal(records[0]!.notificationId, inbox[0]!.id,
      "the failed attempt is linked to the notification it was trying to deliver");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 5. Notification ids are the ones the delivery records refer to
// ===========================================================================

test("notification correctness: every delivery record points at a real notification", async () => {
  const h = await harness({});
  try {
    await h.runFinding();
    const known = new Set(readNotifications(h.dir).map(n => n.id));

    for (const record of readDeliveries(h.dir)) {
      assert.equal(known.has(record.notificationId), true,
        `delivery ${record.id} refers to notification ${record.notificationId}, which does not exist`);
    }
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 6. Reading a notification does not change what was delivered
// ===========================================================================

test("notification correctness: marking a notification read is invisible to delivery records", async () => {
  const h = await harness({});
  try {
    await h.runFinding();
    const before = JSON.stringify(readDeliveries(h.dir));

    const inbox = await h.notifications();
    await post(`${h.base}/api/notifications/${inbox[0]!.id}/read`);
    await post(`${h.base}/api/notifications/read-all`);

    assert.equal(JSON.stringify(readDeliveries(h.dir)), before,
      "a read-state write is not a delivery event and rewrites no delivery history");
  } finally {
    await h.cleanup();
  }
});