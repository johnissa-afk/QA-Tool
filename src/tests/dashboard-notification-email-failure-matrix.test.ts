// ---------------------------------------------------------------------------
// Final Release Hardening 1: the delivery failure matrix, and multi-recipient
// isolation.
//
// THE QUESTION EVERY CASE ANSWERS
// Ten different things can go wrong between "a notification was stored" and "an
// email arrived". Each case below provokes exactly one of them and then asserts
// the SAME seven things, because the promise does not vary with the failure:
//
//   1. the in-app notification was still created
//   2. the QA run still reached a terminal state with a real report
//   3. the QA verdict is identical to a control where email never existed
//   4. the finding ledger and its lifecycle are identical to that control
//   5. the change-intelligence result is identical to that control
//   6. the failure is PERSISTED with the existing reason vocabulary
//   7. nothing anywhere claims SENT that was not sent
//
// The control is the honest way to state (3)-(5). Hard-coding expected values
// would make the suite fail every time the engine legitimately improves; comparing
// against a run where email was switched off isolates the one variable that is
// under test.
//
// ERROR SEMANTICS ARE REUSED, NOT REINVENTED
// Every expectation below uses a reason that already exists: EMAIL_NOT_CONFIGURED
// from the transport, the delivery layer's SENT/FAILED/SKIPPED plus
// ALREADY_DELIVERED/NO_TRANSPORT/INVALID_RECIPIENT, the preference layer's
// ELIGIBLE/DISABLED/PROJECT_NOT_FOUND/NO_RECIPIENTS/EVENT_NOT_SELECTED, and this
// milestone's DISPATCH_ERROR. No case introduces a new taxonomy entry.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALICE,
  BOB,
  CAROL,
  breakDeliveryWrites,
  deliveriesOf,
  failFor,
  fakeTransport,
  harness,
  perRecipientTransport,
  qaFingerprint,
  readDeliveries,
  realTransportWith,
  restartOn,
  throwingTransport,
  type Harness,
  type NotificationDelivery,
  type QaFingerprint,
} from "./notification-email-fixtures.js";
import { NotificationDeliveryStore } from "../dashboard/notification-delivery.js";
import { NotificationEmailDispatch } from "../dashboard/notification-email-dispatch.js";
import { notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";

/** A complete SMTP configuration pointing at a host that is never dialled. */
const CONFIGURED_ENV = { SMTP_HOST: "127.0.0.1", SMTP_PORT: "2525", SMTP_FROM: "dashboard@example.test" };

const smtpError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

let controlCache: QaFingerprint | null = null;

/** The QA outcome of the identical run with email switched off. Computed once. */
const controlFingerprint = async (): Promise<QaFingerprint> => {
  if (controlCache) return controlCache;
  const h = await harness({ enabled: false });
  try {
    await h.runFinding();
    controlCache = qaFingerprint(h.dir, h.projectId);
    return controlCache;
  } finally {
    await h.cleanup();
  }
};

/**
 * Assertions (1)-(5), shared by every case, plus the delivery records for the
 * case to make its own claims about.
 */
const assertQaIsInert = async (h: Harness, expectedNotifications = 1): Promise<NotificationDelivery[]> => {
  const detail = await (await fetch(`${h.base}/api/projects/${h.projectId}`)).json();
  const run = detail.runs[0];
  assert.ok(["COMPLETED", "FAILED"].includes(run.state), `(2) the run still reached a terminal state, was ${run.state}`);
  assert.equal(run.hasResult, true, "(2) the run still produced a report artifact");

  assert.deepEqual(
    qaFingerprint(h.dir, h.projectId),
    await controlFingerprint(),
    "(3)(4)(5) verdict, findings, lifecycle and change intelligence match the email-disabled control",
  );

  const inbox = await h.notifications();
  assert.equal(inbox.length, expectedNotifications, "(1) the in-app notification was still created");
  return readDeliveries(h.dir);
};

const smtpErrorWithCode = (code: string, message: string) => Object.assign(new Error(message), { code });

// ===========================================================================
// 1. SMTP not configured
// ===========================================================================

test("matrix: SMTP not configured is decided before any socket is opened", async () => {
  const real = realTransportWith({ env: {} });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);

    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, "FAILED", "(7) nothing claims to have been sent");
    assert.match(records[0]!.error ?? "", /EMAIL_NOT_CONFIGURED/, "the existing transport reason is used verbatim");
    assert.match(records[0]!.error ?? "", /SMTP_HOST/);
    assert.match(records[0]!.error ?? "", /SMTP_FROM/);
    assert.equal(real.sent.length, 0, "no message was composed, because no client was ever created");
    assert.equal(records[0]!.recipient, ALICE);
    assert.equal(records[0]!.attempt, 1);
  } finally {
    await h.cleanup();
  }
});

test("matrix: a half-configured credential is not completed with an invented value", async () => {
  // A user with no password is a misconfiguration, not an unauthenticated server:
  // guessing the other half would fail in a way that looks like a server problem.
  const real = realTransportWith({ env: { ...CONFIGURED_ENV, SMTP_USER: "mailer@example.test" } });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "FAILED");
    assert.match(records[0]!.error ?? "", /SMTP_PASSWORD/, "the missing half is named, not filled in");
    assert.equal(real.sent.length, 0);
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 2-4. The connection never completes
// ===========================================================================

test("matrix: SMTP connection refused", async () => {
  const real = realTransportWith({
    env: CONFIGURED_ENV,
    throws: smtpErrorWithCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:2525"),
  });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "FAILED", "(7) a refused connection is never a success");
    assert.match(records[0]!.error ?? "", /ECONNREFUSED/, "the machine-readable code is kept, it is what makes it actionable");
    assert.equal(real.sent.length, 1, "the send really was attempted");
  } finally {
    await h.cleanup();
  }
});

test("matrix: SMTP timeout", async () => {
  const real = realTransportWith({
    env: CONFIGURED_ENV,
    throws: smtpErrorWithCode("ETIMEDOUT", "connection timed out"),
  });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "FAILED");
    assert.match(records[0]!.error ?? "", /ETIMEDOUT/);
  } finally {
    await h.cleanup();
  }
});

test("matrix: SMTP transport error, with and without a machine-readable code", async () => {
  // An Error carrying nodemailer's code, and a rejection that is not an Error at
  // all: both must become a persisted FAILED rather than an exception.
  for (const thrown of [
    smtpErrorWithCode("EAUTH", "535 Authentication failed"),
    "socket hang up",
    { reason: "a shape no client should produce" },
  ]) {
    const real = realTransportWith({ env: CONFIGURED_ENV, throws: thrown });
    const h = await harness({ transport: real.transport });
    try {
      await h.runFinding();
      const records = await assertQaIsInert(h);
      assert.equal(records.length, 1, `one record for ${JSON.stringify(thrown)}`);
      assert.equal(records[0]!.status, "FAILED", "(7) a transport error is never a success");
      assert.equal(typeof records[0]!.error, "string");
      assert.ok((records[0]!.error ?? "").length > 0, "the failure says something");
      assert.ok((records[0]!.error ?? "").length <= 303, "and stays bounded");
    } finally {
      await h.cleanup();
    }
  }
});

// ===========================================================================
// 5. Malformed or unexpected transport response
// ===========================================================================

test("matrix: a malformed response is never reported as a success", async () => {
  // A client that resolves without an object at all has told us nothing. Claiming
  // SENT there would fabricate the one thing this whole layer exists not to do.
  for (const rejection of [null, undefined, "250 OK", 42] as unknown[]) {
    const real = realTransportWith({ env: CONFIGURED_ENV, rejection });
    const h = await harness({ transport: real.transport });
    try {
      await h.runFinding();
      const records = await assertQaIsInert(h);
      assert.equal(records[0]!.status, "FAILED", `(7) response ${JSON.stringify(rejection)} must not become SENT`);
      assert.ok((records[0]!.error ?? "").length > 0, "the malformed response is described");
    } finally {
      await h.cleanup();
    }
  }
});

test("matrix: a rejection the transport cannot read is never reported as a success", async () => {
  // `rejected` is supposed to be a list of addresses. A single address as a bare
  // string, or a list holding something that is not a string, cannot be compared
  // against the recipient - so acceptance cannot be claimed from it.
  for (const rejection of [{ rejected: ALICE }, { rejected: { address: ALICE } }, { rejected: [ALICE, 7] }]) {
    const real = realTransportWith({ env: CONFIGURED_ENV, rejection });
    const h = await harness({ transport: real.transport });
    try {
      await h.runFinding();
      const records = await assertQaIsInert(h);
      assert.equal(records[0]!.status, "FAILED", `(7) unreadable rejection ${JSON.stringify(rejection)} must not become SENT`);
    } finally {
      await h.cleanup();
    }
  }
});

test("matrix: a successful response with no message id is still a success", async () => {
  // The mirror image of the case above, so the rule is "no acceptance claim from
  // what we cannot read", not "refuse everything unusual".
  const real = realTransportWith({ env: CONFIGURED_ENV, rejection: {} });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "SENT");
    assert.equal(records[0]!.providerMessageId, undefined, "no id is invented when the server gave none");
  } finally {
    await h.cleanup();
  }
});

test("matrix: a non-string message id is ignored rather than persisted", async () => {
  const real = realTransportWith({ env: CONFIGURED_ENV, rejection: { messageId: 42, accepted: [ALICE] } });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "SENT");
    assert.equal(records[0]!.providerMessageId, undefined);
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 6. Recipient failure
// ===========================================================================

test("matrix: a server that accepts the message but rejects the recipient is a failure", async () => {
  const real = realTransportWith({ env: CONFIGURED_ENV, rejection: { rejected: [ALICE], messageId: "<1@x>" } });
  const h = await harness({ transport: real.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "FAILED", "(7) losing an alert must not be reported as sending it");
    assert.match(records[0]!.error ?? "", /rejected the recipient/i);
    assert.equal(records[0]!.providerMessageId, undefined, "a message id from a rejected send is not persisted");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 7 + Section 3. Multiple recipients, mixed outcomes
// ===========================================================================

test("matrix: three recipients, one failing, are isolated from each other", async () => {
  const h = await harness({ recipients: [ALICE, BOB, CAROL], transport: failFor(BOB) });
  try {
    await h.runFinding();
    await assertQaIsInert(h);

    const records = readDeliveries(h.dir);
    const byRecipient = Object.fromEntries(records.map(r => [r.recipient, r.status]));
    assert.deepEqual(byRecipient, { [ALICE]: "SENT", [BOB]: "FAILED", [CAROL]: "SENT" },
      "(6) each recipient carries its own outcome, and the failing one is reported as failing");

    // Section 3: identities stay recipient-specific.
    const keys = records.map(r => r.deliveryKey);
    assert.equal(new Set(keys).size, 3, "three distinct delivery identities");
    assert.equal(records.every(r => r.attempt === 1), true);
    assert.equal(records.find(r => r.recipient === BOB)!.error?.includes(BOB), true,
      "the failure names the recipient it applies to");
  } finally {
    await h.cleanup();
  }
});

test("isolation: retrying the failed recipient resends neither of the others", async () => {
  // BOB fails on his own first attempt only, so the failure is a property of BOB
  // and not of whoever happened to be dialled first.
  const transport = perRecipientTransport((request, seen) =>
    request.recipient === BOB && seen === 0
      ? { status: "FAILED", error: `refused for ${BOB}` }
      : { status: "SENT", providerMessageId: "retry-ok" });
  const h = await harness({ recipients: [ALICE, BOB, CAROL], transport });
  try {
    await h.runFinding();
    assert.deepEqual(
      Object.fromEntries(readDeliveries(h.dir).map(r => [r.recipient, r.status])),
      { [ALICE]: "SENT", [BOB]: "FAILED", [CAROL]: "SENT" },
      "the first pass isolates BOB's failure",
    );

    const notification = (await h.notifications())[0];
    // A retry of the same notification, exactly as a restart-and-retry would drive it.
    for (const recipient of [ALICE, BOB, CAROL]) {
      await h.dash.emailDeliveryDispatcher.deliver(notification, recipient);
    }
    const records = readDeliveries(h.dir);

    // A and C were already delivered, so they are refused without a second send.
    const sentPerRecipient = transport.attempts.filter(a => a.recipient === ALICE).length;
    assert.equal(sentPerRecipient, 1, "ALICE was mailed exactly once across the retry");
    assert.equal(transport.attempts.filter(a => a.recipient === CAROL).length, 1, "CAROL was mailed exactly once");

    const latest = (recipient: string) =>
      records.filter(r => r.recipient === recipient).sort((a, b) => b.attempt - a.attempt)[0]!;
    assert.equal(latest(ALICE).status, "SKIPPED");
    assert.equal(latest(ALICE).reason, "ALREADY_DELIVERED");
    assert.equal(latest(CAROL).status, "SKIPPED");
    assert.equal(latest(CAROL).reason, "ALREADY_DELIVERED");
    assert.equal(latest(BOB).status, "SENT", "BOB's retry is what finally sent");

    // BOB now has two attempts under one identity; the others have a refusal each.
    const bob = records.filter(r => r.recipient === BOB).sort((a, b) => a.attempt - b.attempt);
    assert.deepEqual(bob.map(r => [r.attempt, r.status]), [[1, "FAILED"], [2, "SENT"]],
      "the retry is a new attempt on the same delivery identity, and the failure is preserved");
    assert.equal(new Set(bob.map(r => r.deliveryKey)).size, 1);
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 8. Delivery store failure
// ===========================================================================

test("matrix: the delivery document cannot be written", async () => {
  const h = await harness({ transport: fakeTransport() });
  try {
    // A directory sits where the delivery document belongs, so the store's atomic
    // write fails exactly as a full disk would - with no product code changed.
    breakDeliveryWrites(h.dir);

    const runId = await h.runFinding();
    assert.ok(runId, "the run itself was unaffected");
    const detail = await (await fetch(`${h.base}/api/projects/${h.projectId}`)).json();
    assert.ok(["COMPLETED", "FAILED"].includes(detail.runs[0].state), "the run still completed");
    assert.equal(detail.runs[0].hasResult, true);
    assert.deepEqual(qaFingerprint(h.dir, h.projectId), await controlFingerprint(),
      "QA is identical to the control even though every delivery write failed");

    const inbox = await h.notifications();
    assert.equal(inbox.length, 1, "(1) the notification was still stored: it does not depend on delivery");
    assert.equal(inbox[0].type, "NEW_FINDING");

    // Nothing readable claims a delivery happened.
    const stored = readDeliveries(h.dir);
    assert.equal(stored.length, 0, "(7) no delivery record survived, so no false SENT exists");

    // And the store reports the failure rather than pretending it saved.
    const store = new NotificationDeliveryStore(deliveriesOf(h.dir));
    const written = store.record({
      id: "dlv-probe", deliveryKey: "k", notificationId: "n", channel: "EMAIL",
      recipient: ALICE, attempt: 1, status: "SENT", attemptedAt: new Date(0).toISOString(),
    });
    assert.equal(written.ok, false, "the store tells the truth about its own write");
    assert.equal(written.ok === false ? written.status : 0, 500);

    // The write is the commit point. A failed save must leave the store believing
    // nothing, or this process would treat the attempt as delivered while a
    // restart would not - and the retry would be silently swallowed.
    assert.equal(store.list().deliveries.length, 0,
      "a record that failed to reach disk is not visible in memory either");
    assert.equal(store.hasSucceeded("k"), false,
      "a failed save must not make a retry look already-delivered");

    const retried = store.record({
      id: "dlv-probe", deliveryKey: "k", notificationId: "n", channel: "EMAIL",
      recipient: ALICE, attempt: 1, status: "SENT", attemptedAt: new Date(0).toISOString(),
    });
    assert.equal(retried.ok, false, "the retry is attempted again, not refused as a duplicate");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 9. Preference store failure
// ===========================================================================

test("matrix: a preference read that throws cannot fail the run, and is not mislabelled", async () => {
  const record = notificationFromEvent({
    type: "NEW_FINDING", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "r", findingId: "f", severity: null, source: "finding-lifecycle", reference: "f",
  } as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");

  const reported: string[] = [];
  const dispatch = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => { throw new Error("the dispatcher must not be reached"); } },
    loadProject: () => { throw new Error("the project document is locked"); },
    onError: message => { reported.push(message); },
  });

  const summaries = await dispatch.dispatchCreated([record]);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.reason, "DISPATCH_ERROR", "an unreadable preference block is not PROJECT_NOT_FOUND");
  assert.deepEqual(summaries[0]!.results, []);
  assert.equal(reported.length, 1, "the actual cause is reported once");
  assert.match(reported[0]!, /the project document is locked/);
});

test("matrix: a project document with an unusable preferences block is treated as email off", async () => {
  // Hand-edited documents are the realistic source of a corrupt preferences block.
  // The corruption must be on disk BEFORE the process that reads it starts: the
  // project store holds its document in memory, so editing the file underneath a
  // running dashboard would test nothing about how it loads a bad block.
  const first = await harness({});
  const dir = first.dir;
  const projectId = first.projectId;
  await first.cleanup();

  const path = join(dir, "projects", "projects.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.projects[0].emailNotifications = { enabled: true, recipients: "alice@example.com", events: ["NEW_FINDING"] };
  writeFileSync(path, JSON.stringify(doc, null, 2));

  const fake = fakeTransport();
  const h = await restartOn(dir, projectId, fake.transport);
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records.length, 0, "(7) a corrupt block cannot become an email");
    assert.equal(fake.attempts.length, 0, "no transport was dialled for a project that read as email-off");

    // The in-app notification is unaffected: a broken email preference must not
    // cost the team the alert inside the product.
    const inbox = await h.notifications();
    assert.equal(inbox.length, 1, "the notification still exists");
    assert.equal(inbox[0]!.type, "NEW_FINDING");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 10. Dispatcher exception
// ===========================================================================

test("matrix: a transport that throws is contained by the delivery layer", async () => {
  const transport = throwingTransport(new Error("the transport exploded"));
  const h = await harness({ transport: transport.transport });
  try {
    await h.runFinding();
    const records = await assertQaIsInert(h);
    assert.equal(records[0]!.status, "FAILED", "a throwing transport is a FAILED attempt, not a crashed dispatcher");
    assert.match(records[0]!.error ?? "", /the transport exploded/);
    assert.equal(transport.attempts.length, 1, "and it really was called");
  } finally {
    await h.cleanup();
  }
});

test("matrix: a dispatcher that rejects cannot fail the run", async () => {
  const record = notificationFromEvent({
    type: "NEW_FINDING", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "r", findingId: "f", severity: null, source: "finding-lifecycle", reference: "f",
  } as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");

  const dispatch = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => { throw new Error("the dispatcher gave up"); } },
    loadProject: () => ({ id: "prj-1", emailNotifications: { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] } }),
    onError: () => undefined,
  });

  // No await-rejection escapes: this is called from notification recording, and an
  // escaped rejection would become an unhandled rejection in the QA pipeline.
  const summaries = await dispatch.dispatchCreated([record]);
  assert.equal(summaries[0]!.reason, "DISPATCH_ERROR");
  assert.equal(summaries[0]!.eligible, false);
  assert.deepEqual(summaries[0]!.results, []);
});

test("matrix: a dispatcher that reports a save failure does not become a SENT", async () => {
  const record = notificationFromEvent({
    type: "NEW_FINDING", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "r", findingId: "f", severity: null, source: "finding-lifecycle", reference: "f",
  } as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");

  const dispatch = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => ({ ok: false, status: 500 as const, error: "The delivery could not be saved." }) },
    loadProject: () => ({ id: "prj-1", emailNotifications: { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] } }),
    onError: () => undefined,
  });

  const summaries = await dispatch.dispatchCreated([record]);
  assert.equal(summaries[0]!.eligible, true, "the project WAS eligible; the failure was downstream");
  assert.equal(summaries[0]!.results[0]!.status, "FAILED");
  assert.match(summaries[0]!.results[0]!.error ?? "", /could not be saved/);
  assert.notEqual(summaries[0]!.results[0]!.status, "SENT");
});

// ===========================================================================
// Cross-cutting: an unknown notification type cannot smuggle a delivery through
// ===========================================================================

test("matrix: an unknown event type invalidates the whole preferences block, it does not narrow it", async () => {
  const record = notificationFromEvent({
    type: "SOMETHING_ELSE", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "r", findingId: null, severity: null, source: "finding-lifecycle", reference: "f",
  } as unknown as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");

  const dispatch = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => { throw new Error("must not be reached"); } },
    loadProject: () => ({ id: "prj-1", emailNotifications: { enabled: true, recipients: [ALICE], events: ["NEW_FINDING", "SOMETHING_ELSE"] } }),
    onError: () => undefined,
  });

  const summaries = await dispatch.dispatchCreated([record]);

  // The closed set is all-or-nothing. A block naming an event this build does not
  // know is refused in full, so the known event in the same list is NOT quietly
  // retained - otherwise `["NEW_FINDING", typo]` would be a way to turn on email
  // that an operator never fully specified, and the report would say something
  // narrower than what the document says.
  assert.equal(summaries[0]!.reason, "DISABLED",
    "a block with an event outside the closed set is unusable, so the project reads as email off");
  assert.equal(summaries[0]!.eligible, false);
  assert.deepEqual(summaries[0]!.results, [], "nothing was attempted");
});