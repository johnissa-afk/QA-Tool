// Restart and recovery acceptance for automatic email delivery.
//
// A dashboard restart is the one event this feature cannot control and cannot
// detect. Every other failure in the delivery path is caught and recorded; a kill
// -9 in the middle of a send is not. These tests pin down what the system
// actually guarantees across that boundary, because the guarantee is weaker than
// "sent exactly once" and a release note that implies otherwise is a defect.
//
// What is guaranteed, and asserted below:
//   - a send that never completed leaves no SENT, so it is retried;
//   - a send that completed and was recorded is never sent again;
//   - a send that failed is retried as a NEW, numbered attempt;
//   - attempt numbering is read from the persisted document, not from memory,
//     so it survives a restart rather than restarting at 1;
//   - a record that failed to reach disk leaves no in-memory belief in it.
//
// What is NOT guaranteed, and asserted as such in one test: a send that reached
// the server but whose record did not reach disk is re-sent after a restart. That
// is at-least-once delivery, and the suite says so out loud instead of papering
// over it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALICE,
  breakDeliveryWrites,
  deliveriesOf,
  fakeTransport,
  fileDigest,
  harness,
  hangingTransport,
  perRecipientTransport,
  qaFingerprint,
  readDeliveries,
  readNotifications,
  restartOn,
  unbreakDeliveryWrites,
} from "./notification-email-fixtures.js";
import { NotificationDeliveryStore, deliveryKey } from "../dashboard/notification-delivery.js";


/**
 * Re-delivers one existing notification through the live dispatcher, exactly as a
 * retry after a restart would. No new run, no new notification: only the
 * delivery attempt is being repeated.
 */
const redeliver = async (dash: { emailDeliveryDispatcher: { deliver: (n: any, r: string) => Promise<any> } }, notification: any, recipient: string) =>
  dash.emailDeliveryDispatcher.deliver(notification, recipient);

// ===========================================================================
// 1. Crash BEFORE delivery completed: nothing claimed, so it is retried
// ===========================================================================

test("restart: a process killed mid-send leaves no SENT, so the notification is sent after a restart", async () => {
  const hanging = hangingTransport();
  const first = await harness({ transport: hanging.transport });
  const dir = first.dir;
  const projectId = first.projectId;

  // The run completes and the notification is stored. The send has started and
  // will never answer - this is the window a kill lands in.
  await first.runFindingUnsettled();

  assert.equal(hanging.attempts.length, 1, "the send was genuinely started");
  const inbox = await first.notifications();
  assert.equal(inbox.length, 1, "the notification was created before the send");
  assert.equal(readDeliveries(dir).length, 0, "and nothing was recorded, because nothing finished");

  // Kill it. The hanging promise dies with the process.
  await first.cleanup();

  const working = fakeTransport();
  const second = await restartOn(dir, projectId, working.transport);
  try {
    const [notification] = readNotifications(second.dir);
    const result = await redeliver(second.dash, notification, ALICE);
    await second.dash.settleEmailDeliveries();

    assert.equal(result.ok, true, "the retried send succeeds");
    assert.equal(working.attempts.length, 1, "exactly one send after the restart");

    const records = readDeliveries(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "SENT", "the retry is recorded as a real send");
    assert.equal(records[0]!.attempt, 1, "an unrecorded attempt did not consume attempt number 1");
  } finally {
    await second.cleanup();
  }
});

// ===========================================================================
// 2. Crash AFTER a recorded success: never sent twice
// ===========================================================================

test("restart: a recorded SENT is not sent again, and is not renumbered", async () => {
  const first = fakeTransport();
  const h = await harness({ transport: first.transport });
  const dir = h.dir;
  const projectId = h.projectId;
  try {
    await h.runFinding();
    assert.equal(first.attempts.length, 1);
    const before = fileDigest(deliveriesOf(dir));

    await h.cleanup();

    const after = fakeTransport();
    const second = await restartOn(dir, projectId, after.transport);
    try {
      const [notification] = readNotifications(second.dir);

      // The persisted document is the only thing that can suppress this send.
      assert.equal(fileDigest(deliveriesOf(dir)), before, "the record survived the restart");

      const result = await redeliver(second.dash, notification, ALICE);
      await second.dash.settleEmailDeliveries();

      assert.equal(after.attempts.length, 0, "the transport was never dialled a second time");
      assert.equal(result.ok, true);
      const delivery = result.ok ? result.value.delivery : null;
      assert.equal(delivery?.status, "SKIPPED");
      assert.equal(delivery?.reason, "ALREADY_DELIVERED", "the suppression names itself");
      assert.equal(delivery?.attempt, 2,
        "the refusal is a numbered attempt of its own, so attempt 1 stays the one real send");
      assert.equal(delivery?.providerMessageId, undefined, "a suppression invents no provider message id");

      assert.equal(readDeliveries(dir).length, 2,
        "the original send plus one suppression, so 'we did not mail you twice' is itself auditable");
      assert.deepEqual(
        readDeliveries(dir).map(r => [r.status, r.reason ?? null]).sort(),
        [["SENT", null], ["SKIPPED", "ALREADY_DELIVERED"]],
      );
      assert.equal(qaFingerprint(dir, projectId).runs.length, 1, "and touches no QA state");
    } finally {
      await second.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 3. Crash AFTER a failure: retried as a NEW numbered attempt
// ===========================================================================

test("restart: a failed send is retried as attempt 2, and the history of both is kept", async () => {
  const failing = perRecipientTransport(() => ({ status: "FAILED", error: "the connection was refused" }));
  const first = await harness({ transport: failing.transport });
  const dir = first.dir;
  const projectId = first.projectId;
  try {
    await first.runFinding();
    assert.equal(readDeliveries(dir)[0]!.status, "FAILED");
    assert.equal(readDeliveries(dir)[0]!.attempt, 1);

    await first.cleanup();

    const working = fakeTransport();
    const second = await restartOn(dir, projectId, working.transport);
    try {
      const [notification] = readNotifications(second.dir);
      const result = await redeliver(second.dash, notification, ALICE);
      await second.dash.settleEmailDeliveries();

      assert.equal(working.attempts.length, 1, "the retry actually reached the transport");
      assert.equal(result.ok && result.value.delivery.status, "SENT");

      const records = readDeliveries(dir).sort((a, b) => a.attempt - b.attempt);
      assert.equal(records.length, 2, "both attempts are on record: the failure is not overwritten");
      assert.deepEqual(records.map(r => [r.attempt, r.status]), [[1, "FAILED"], [2, "SENT"]],
        "the retry is numbered from the persisted document, not from memory");
      assert.notEqual(records[1]!.id, records[0]!.id,
        "a retry is a new record, not an overwrite of the failure it is retrying");
      assert.equal(records[1]!.deliveryKey, records[0]!.deliveryKey,
        "but both attempts share one delivery identity");

      // And a third request is suppressed, because attempt 2 succeeded.
      const again = await redeliver(second.dash, notification, ALICE);
      assert.equal(again.ok && again.value.delivery.reason, "ALREADY_DELIVERED");
      assert.equal(working.attempts.length, 1, "no third send");
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.cleanup();
  }
});

// ===========================================================================
// 4. Interrupted persistence: no memory believes what disk does not
// ===========================================================================

test("restart: a delivery record that failed to save leaves no belief behind, before or after a restart", async () => {
  const h = await harness({});
  const dir = h.dir;
  try {
    // A directory sits where the document belongs, so every write fails.
    breakDeliveryWrites(dir);
    const store = new NotificationDeliveryStore(deliveriesOf(dir));
    const attempt = {
      id: "dlv-restart-probe", deliveryKey: "probe-key", notificationId: "n-1", channel: "EMAIL" as const,
      recipient: ALICE, attempt: 1, status: "SENT" as const, attemptedAt: new Date(0).toISOString(),
    };

    assert.equal(store.record(attempt).ok, false, "the save failed");
    assert.equal(store.hasSucceeded("probe-key"), false, "this process does not believe it");
    assert.equal(store.attemptCount("probe-key"), 0, "and has not consumed an attempt number");

    await h.cleanup();

    const second = await restartOn(dir, h.projectId);
    try {
      const afterRestart = new NotificationDeliveryStore(deliveriesOf(dir));
      assert.equal(afterRestart.hasSucceeded("probe-key"), false, "nor does the next one");
      assert.equal(afterRestart.attemptCount("probe-key"), 0);
      assert.equal(afterRestart.list().deliveries.length, 0);
    } finally {
      await second.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test("restart: the delivery key is derived from the target, so it is identical in any process", async () => {
  // If this were process-local, idempotency would not survive a restart at all.
  const key = deliveryKey("n-1", "EMAIL", ALICE);
  assert.equal(key, deliveryKey("n-1", "EMAIL", ALICE), "the same target yields the same key");
  assert.notEqual(key, deliveryKey("n-2", "EMAIL", ALICE), "a different notification does not");
  assert.notEqual(key, deliveryKey("n-1", "EMAIL", "bob@example.com"), "a different recipient does not");
});

// ===========================================================================
// 5. The honest limit: at-least-once, not exactly-once
// ===========================================================================

test("release limit: a send that succeeded but could not be recorded is re-sent after a restart", async () => {
  // This test exists to document a real duplicate-email window rather than to
  // wish it away. The window is between the SMTP server accepting a message and
  // the delivery record reaching disk. No amount of local bookkeeping closes it:
  // if the process dies in that gap, the next process cannot know whether the
  // message was sent. Claiming exactly-once here would be a false guarantee.
  const working = fakeTransport();
  const first = await harness({ transport: working.transport });
  const dir = first.dir;
  const projectId = first.projectId;
  try {
    // The message reaches the server, then the record cannot be written.
    breakDeliveryWrites(dir);
    await first.runFinding();
    assert.equal(working.attempts.length, 1, "the message really was accepted by the transport");
    assert.equal(readDeliveries(dir).length, 0, "but nothing survived to say so");

    await first.cleanup();

    // The disk becomes writable again - as it would after the fault that caused
    // the write to fail is cleared. Without this the retry could not be recorded
    // either, and the test would be measuring the fault rather than the restart.
    unbreakDeliveryWrites(dir);

    const again = fakeTransport();
    const second = await restartOn(dir, projectId, again.transport);
    try {
      const [notification] = readNotifications(second.dir);
      const result = await redeliver(second.dash, notification, ALICE);
      await second.dash.settleEmailDeliveries();

      // The documented consequence: two sends, one notification.
      assert.equal(again.attempts.length, 1, "the recipient receives the alert a second time");
      assert.equal(result.ok && result.value.delivery.status, "SENT");

      const records = readDeliveries(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0]!.attempt, 1, "and only the surviving record exists, numbering from 1");

      // What the product must never do is call this a success it cannot see:
      // before the restart there is no record at all, so nothing reports SENT.
      assert.equal(new NotificationDeliveryStore(deliveriesOf(dir)).list().deliveries.length, 1);
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.cleanup();
  }
});

// ===========================================================================
// 6. Restart does not disturb QA
// ===========================================================================

test("restart: re-delivering after a restart does not change the project's QA state", async () => {
  const first = fakeTransport();
  const h = await harness({ transport: first.transport });
  const dir = h.dir;
  const projectId = h.projectId;
  try {
    await h.runFinding();
    const before = qaFingerprint(dir, projectId);
    await h.cleanup();

    const again = fakeTransport();
    const second = await restartOn(dir, projectId, again.transport);
    try {
      const [notification] = readNotifications(second.dir);
      for (let i = 0; i < 3; i += 1) {
        await redeliver(second.dash, notification, ALICE);
      }
      await second.dash.settleEmailDeliveries();

      assert.deepEqual(qaFingerprint(dir, projectId), before,
        "three delivery attempts are invisible to run state, verdict, findings, lifecycle and change intelligence");
      assert.equal(again.attempts.length, 0, "and none of them even reached the transport");

      const records = readDeliveries(dir);
      assert.equal(records.filter(r => r.status === "SENT").length, 1,
        "there is exactly one real send, no matter how many times delivery was requested");
      assert.equal(records.filter(r => r.reason === "ALREADY_DELIVERED").length, 3,
        "and every refusal is on record rather than silently dropped");
    } finally {
      await second.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});
