// Architectural isolation, and the claim that QA is unaffected by delivery.
//
// Two different things are checked, and both are claims a release note would
// otherwise make without evidence.
//
// The first is where delivery code is ALLOWED to live. Delivery is orchestrated
// in one place (`NotificationEmailDispatch`), which calls the preference layer,
// which calls the dispatcher, which owns the store and asks a transport to send.
// The scheduler and the run manager are NOT in that chain: they produce events,
// and the notification layer turns events into notifications. If SMTP or
// persistence code appeared in the scheduler or the run manager, delivery would
// start blocking or failing QA runs, so the absence is asserted directly against
// the source rather than left as an intention.
//
// The second is behavioural: whatever the transport does - hang, throw, refuse,
// return nonsense - a QA run must still finish with the same verdict, findings,
// lifecycle observations and change intelligence it would have produced with no
// email feature at all. That is checked against a control run, not against a
// hand-written expectation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALICE,
  failFor,
  fakeTransport,
  harness,
  hangingTransport,
  perRecipientTransport,
  qaFingerprint,
  readDeliveries,
  throwingTransport,
} from "./notification-email-fixtures.js";
import { labelFinding } from "./notification-fixtures.js";

const sourceOf = (relative: string): string =>
  readFileSync(join(process.cwd(), "src", "dashboard", relative), "utf8");

/** The single control every behavioural test below is compared against. */
let control: ReturnType<typeof qaFingerprint> | null = null;
const controlFingerprint = async (): Promise<ReturnType<typeof qaFingerprint>> => {
  if (control) return control;
  const h = await harness({ enabled: false });
  try {
    await h.runFinding();
    control = qaFingerprint(h.dir, h.projectId);
    return control;
  } finally {
    await h.cleanup();
  }
};

// ===========================================================================
// 1. The scheduler and the run manager contain no delivery code
// ===========================================================================

test("isolation: the scheduler does not know delivery exists", () => {
  const source = sourceOf("scheduler.ts");

  // Not a single delivery concept may appear in the scheduler.
  for (const forbidden of [
    "NotificationEmail",
    "NotificationDelivery",
    "NotificationEmailTransport",
    "EmailDeliveryDispatcher",
    "smtp",
    "SMTP_",
    "sendMail",
    "deliveryStore",
  ]) {
    assert.equal(source.includes(forbidden), false,
      `scheduler.ts must not mention ${forbidden}: the scheduler produces events, it does not deliver`);
  }
});

test("isolation: the run manager does not know delivery exists", () => {
  const source = sourceOf("run-manager.ts");

  for (const forbidden of [
    "NotificationEmail",
    "NotificationDelivery",
    "NotificationEmailTransport",
    "smtp",
    "SMTP_",
    "sendMail",
    "deliveryStore",
  ]) {
    assert.equal(source.includes(forbidden), false,
      `run-manager.ts must not mention ${forbidden}: a QA run must not be able to fail because mail could not be sent`);
  }
});

test("isolation: the notification preview stays read-only and delivery-free", () => {
  const source = sourceOf("notification-preview.ts");
  for (const forbidden of ["sendMail", "smtp", "NotificationDeliveryStore", "atomicWriteText", "createClient"]) {
    assert.equal(source.includes(forbidden), false,
      `notification-preview.ts must not mention ${forbidden}: previewing a notification cannot send or persist one`);
  }
});

test("isolation: notifications stay the authority on notification truth, not delivery", () => {
  const source = sourceOf("notifications.ts");
  // The notification store may know nothing about how a notification is delivered.
  for (const forbidden of ["sendMail", "smtp", "NotificationDeliveryTransport", "deliveryKey"]) {
    assert.equal(source.includes(forbidden), false,
      `notifications.ts must not mention ${forbidden}: the inbox is the record of what happened, independent of mail`);
  }
});

// ===========================================================================
// 2. Every delivery failure leaves QA identical
// ===========================================================================

test("non-interference: a throwing transport cannot change the QA outcome", async () => {
  const expected = await controlFingerprint();
  const transport = throwingTransport(new Error("the transport exploded"));
  const h = await harness({ transport: transport.transport });
  try {
    await h.runFinding();
    assert.deepEqual(qaFingerprint(h.dir, h.projectId), expected,
      "a run that reported a catastrophic mail failure still produced exactly the same QA result");
    assert.equal(readDeliveries(h.dir)[0]!.status, "FAILED", "and the failure was recorded");
  } finally {
    await h.cleanup();
  }
});

test("non-interference: a transport that never answers cannot hold up a QA run", async () => {
  // This is the important one: delivery is detached from the run, so a hung SMTP
  // socket must not turn into a hung QA run. If delivery were awaited inline, the
  // run would never be reported as complete.
  const transport = hangingTransport();
  const h = await harness({ transport: transport.transport });
  try {
    // runFindingUnsettled waits for the RUN to finish, and does not drain delivery.
    const runId = await h.runFindingUnsettled();

    const detail = await (await fetch(`${h.base}/api/projects/${h.projectId}`)).json();
    const run = detail.runs.find((r: { runId: string }) => r.runId === runId);
    assert.ok(run, "the run is visible");
    assert.ok(["COMPLETED", "FAILED"].includes(run.state),
      `the run reached a terminal state while delivery was still outstanding (was ${run.state})`);
    assert.equal(run.hasResult, true, "and its result is readable, which is what a hung send would prevent");

    // The finding itself is on the ledger, fully processed.
    assert.deepEqual(qaFingerprint(h.dir, h.projectId), await controlFingerprint(),
      "the QA outcome is exactly the control, even though the email will never be sent");
    assert.equal(readDeliveries(h.dir).length, 0, "and no delivery was invented");
  } finally {
    await h.cleanup();
  }
});

test("non-interference: an unconfigured SMTP environment cannot change a QA run", async () => {
  // No injected transport at all: the real transport runs and finds the
  // environment unconfigured, which is the default state of a fresh install.
  const h = await harness({});
  try {
    await h.runFinding();
    assert.deepEqual(qaFingerprint(h.dir, h.projectId), await controlFingerprint());

    const records = readDeliveries(h.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "FAILED");
    assert.match(String(records[0]!.error), /EMAIL_NOT_CONFIGURED/,
      "and it says which class of configuration is missing, without naming a value");
  } finally {
    await h.cleanup();
  }
});

test("non-interference: a per-recipient failure leaves the other recipients and QA untouched", async () => {
  const expected = await controlFingerprint();
  const transport = failFor(ALICE);
  const h = await harness({ recipients: [ALICE, "bob@example.com"], transport: transport.transport });
  try {
    await h.runFinding();
    assert.deepEqual(qaFingerprint(h.dir, h.projectId), expected,
      "one recipient's failure does not affect the run, and does not affect the other recipient's outcome");
    assert.deepEqual(
      Object.fromEntries(readDeliveries(h.dir).map(r => [r.recipient, r.status])),
      { [ALICE]: "FAILED", "bob@example.com": "SENT" },
      "each recipient carries its own result",
    );
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 3. A second finding in the same run is its own notification
// ===========================================================================

test("notification correctness: each subscribed notification delivers exactly once, and unsubscribed ones never do", async () => {
  const transport = fakeTransport();
  // Subscribed to NEW_FINDING only, which is the point: the same runs also
  // produce notification types this project has not opted into.
  const h = await harness({ transport: transport.transport, events: ["NEW_FINDING"] });
  try {
    // Two runs, each carrying a different finding. Between them the first finding
    // is resolved and a change summary appears, so more notifications exist than
    // the project asked to hear about.
    await h.runFinding();
    await h.runFinding(labelFinding());

    const inbox = await h.notifications();
    const byType = inbox.reduce<Record<string, number>>((counts, n) => {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      return counts;
    }, {});

    assert.equal(byType.NEW_FINDING, 2, "two distinct new findings, so two notifications of that type");
    assert.ok((byType.RESOLVED_FINDING ?? 0) >= 1, "and the resolution was notified inside the product");

    const records = readDeliveries(h.dir);
    assert.equal(records.length, 2, "exactly two emails: one per subscribed notification, none for the rest");
    assert.deepEqual(new Set(records.map(r => r.status)), new Set(["SENT"]));
    assert.equal(new Set(records.map(r => r.notificationId)).size, 2,
      "each delivery refers to a different notification, so neither can be confused with the other");

    // Every delivered notification is one of the subscribed type, and none of the
    // unsubscribed notifications was mailed.
    const deliveredIds = new Set(records.map(r => r.notificationId));
    for (const notification of inbox) {
      const wasDelivered = deliveredIds.has(notification.id);
      assert.equal(wasDelivered, notification.type === "NEW_FINDING",
        `${notification.type} was ${wasDelivered ? "delivered" : "not delivered"}, which matches the project's subscription`);
    }
    assert.equal(transport.attempts.length, 2, "and the transport was dialled once per delivered notification");
  } finally {
    await h.cleanup();
  }
});

test("notification correctness: re-reporting the same finding does not alert again", async () => {
  const transport = perRecipientTransport(() => ({ status: "SENT" }));
  const h = await harness({ transport: transport.transport });
  try {
    await h.runFinding();
    const afterFirst = transport.attempts.length;

    // The same problem is found again. Re-announcing an unchanged finding every
    // run would train people to ignore the channel.
    await h.runFinding();

    assert.equal(readDeliveries(h.dir).length, 1, "the finding led to exactly one notification and one delivery");
    assert.equal(transport.attempts.length, afterFirst, "no second email for an unchanged finding");
    assert.equal(readDeliveries(h.dir)[0]!.attempt, 1, "and no second attempt");
  } finally {
    await h.cleanup();
  }
});