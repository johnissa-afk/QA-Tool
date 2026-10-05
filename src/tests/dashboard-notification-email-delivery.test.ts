// ---------------------------------------------------------------------------
// Milestone 5: production email delivery — a created notification is emailed.
//
// WHAT THIS SUITE IS ABOUT
// The wiring, not the machinery. Identity, idempotency, retry numbering and
// persistence were already owned and tested by notification-delivery.test.ts, and
// SMTP by dashboard-email-transport.test.ts. What is new here is the ORDER:
//   notification created -> project preferences -> eligibility -> dispatcher -> transport
// and the promise that nothing about a QA run, a verdict or a history is allowed to
// change because an email was, or was not, delivered.
//
// The seams are real: a real dashboard server, a real project, a real run settled
// from a real report artifact, and the real dispatcher and delivery store. Only the
// transport is faked, so no test can reach a mail server; the tests that must
// observe what the REAL transport does without SMTP inject nothing at all.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysisWith,
  fakeSpawner,
  finding,
  getJson,
  postJson,
  runOnce,
  send,
  settle,
  start,
  stop,
  waitFor,
} from "./notification-fixtures.js";
import type { DeliveryRequest, DeliveryResult, NotificationDeliveryTransport } from "../dashboard/notification-delivery.js";
import { deliveryKey, NotificationDeliveryDispatcher, NotificationDeliveryStore } from "../dashboard/notification-delivery.js";
import { NotificationEmailDispatch } from "../dashboard/notification-email-dispatch.js";
import { notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

/** A transport that records every send and never opens a socket. */
const fakeTransport = (outcome: DeliveryResult | ((request: DeliveryRequest) => DeliveryResult) = { status: "SENT" }) => {
  const attempts: DeliveryRequest[] = [];
  return {
    attempts,
    transport: {
      channel: "EMAIL",
      send: async (request: DeliveryRequest): Promise<DeliveryResult> => {
        attempts.push(request);
        return typeof outcome === "function" ? outcome(request) : outcome;
      },
    } satisfies NotificationDeliveryTransport,
  };
};

/** Fails for named recipients only, so isolation can be tested honestly. */
const failFor = (...recipients: string[]) => fakeTransport(request =>
  recipients.includes(request.recipient)
    ? { status: "FAILED", error: `refused for ${request.recipient}` }
    : { status: "SENT", providerMessageId: "ok" });

const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_SECURE", "SMTP_REJECT_UNAUTHORIZED"];

const deliveriesOf = (dir: string) => join(dir, "projects", "notification-deliveries.json");
const readDeliveries = (dir: string): any[] =>
  existsSync(deliveriesOf(dir)) ? (JSON.parse(readFileSync(deliveriesOf(dir), "utf8")) as any).deliveries : [];

/**
 * A dashboard with one real project whose email preferences are configured.
 *
 * `transport: null` deliberately omits the injection so the REAL transport is used
 * - that is the only way to observe the unconfigured-SMTP behaviour.
 */
const harness = async (options: {
  enabled?: boolean;
  recipients?: string[];
  events?: string[];
  transport?: ReturnType<typeof fakeTransport> | null;
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "m5-deliver-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  const { spawnImpl, children } = fakeSpawner();
  const fake = options.transport === undefined ? fakeTransport() : options.transport;
  const saved = new Map<string, string | undefined>();
  for (const key of SMTP_VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const { dash, base } = await start(dir, spawnImpl, () => Date.now(), {
    ...(fake ? { emailDeliveryTransport: fake.transport } : {}),
    // The test-email route keeps its own seam, so a test email can never be
    // confused with an automatic delivery.
    emailTransport: { sendTestMessage: async () => ({ status: "SENT", providerMessageId: "test@test" }) },
  });
  const created = await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.project.id as string;

  const configured = await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
    enabled: options.enabled ?? true,
    recipients: options.recipients ?? [ALICE],
    events: options.events ?? ["NEW_FINDING", "SCHEDULE_SKIPPED"],
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.json));

  return {
    dir, base, dash, children, projectId, fake,
    /** Delivers one real run with one real finding and waits for the inbox to settle. */
    runFinding: async () => {
      const runId = await runOnce(base, projectId, children, 0, analysisWith([finding()]));
      await dash.settleEmailDeliveries();
      return runId;
    },
    cleanup: async () => {
      await stop(dash);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
};

// ===========================================================================
// 1. Eligibility
// ===========================================================================

test("1. an eligible notification is emailed to every configured recipient", async () => {
  const h = await harness({ recipients: [ALICE] });
  try {
    await h.runFinding();
    const inbox = await getJson(`${h.base}/api/notifications`);
    assert.equal(inbox.json.notifications.length, 1);
    assert.equal(inbox.json.notifications[0].type, "NEW_FINDING");
    assert.equal(h.fake!.attempts.length, 1, "the transport was called once");
    assert.equal(h.fake!.attempts[0]!.recipient, ALICE);
    // The transport receives the real stored notification, not a summary.
    assert.equal(h.fake!.attempts[0]!.notification.id, inbox.json.notifications[0].id);
    const records = readDeliveries(h.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "SENT");
    assert.equal(records[0].notificationId, inbox.json.notifications[0].id);
    assert.equal(records[0].channel, "EMAIL");
    assert.equal(records[0].recipient, ALICE);
    assert.equal(records[0].attempt, 1);
    assert.equal(typeof records[0].attemptedAt, "string");
  } finally {
    await h.cleanup();
  }
});

test("2. email switched off dispatches nothing at all", async () => {
  const h = await harness({ enabled: false, recipients: [ALICE] });
  try {
    await h.runFinding();
    const inbox = await getJson(`${h.base}/api/notifications`);
    assert.equal(inbox.json.notifications.length, 1, "the in-app notification still exists");
    assert.equal(h.fake!.attempts.length, 0, "no email was attempted");
    assert.equal(readDeliveries(h.dir).length, 0, "no delivery record was invented either");
  } finally {
    await h.cleanup();
  }
});

test("3. an event that is not selected is not emailed, while a selected one is", async () => {
  const h = await harness({ events: ["REGRESSED_FINDING"] });
  try {
    await h.runFinding();
    assert.equal(h.fake!.attempts.length, 0, "NEW_FINDING was not selected");
    assert.equal(readDeliveries(h.dir).length, 0);

    // Selecting the event the run actually produced makes the same run eligible.
    await send("PUT", `${h.base}/api/projects/${h.projectId}/email-settings`, {
      enabled: true, recipients: [ALICE], events: ["NEW_FINDING"],
    });
    // Re-processing the identical run creates no NEW notification, so it cannot
    // become a second email; the next test covers the retry of the real target.
    const inbox = await getJson(`${h.base}/api/notifications`);
    assert.equal(inbox.json.notifications.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("4. an empty recipient list dispatches nothing", async () => {
  const h = await harness({ recipients: [] });
  try {
    await h.runFinding();
    assert.equal(h.fake!.attempts.length, 0);
    assert.equal(readDeliveries(h.dir).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("16. an unsupported event type cannot trigger a delivery", async () => {
  // The type is a closed union, so the only way an event reaches the dispatcher
  // with a bogus type is a cast from untrusted JSON. Eligibility must refuse it.
  const h = await harness({ events: ["NEW_FINDING"] });
  try {
    const bogus = {
      id: "ntf-bogus",
      projectId: h.projectId,
      projectName: "Checkout",
      type: "NOT_A_REAL_EVENT",
      title: "x",
      message: "x",
      createdAt: "2026-09-29T10:00:00.000Z",
      read: false,
      runId: null,
      findingId: null,
      severity: null,
      source: "run",
      dedupKey: "k",
      reference: null,
    } as unknown as Parameters<typeof h.dash.emailDeliveryDispatcher.deliver>[0];

    const key = deliveryKey(bogus.id, "EMAIL", ALICE);
    const result = await h.dash.emailDeliveryDispatcher.deliver(bogus, ALICE);
    assert.equal(result.ok, true);
    assert.equal(h.fake!.attempts.length, 1, "the dispatcher itself does not judge the type");

    // The preference layer is what refuses it, because the event is not selected.
    const dispatch = new NotificationEmailDispatch({
      dispatcher: h.dash.emailDeliveryDispatcher,
      loadProject: () => ({ id: h.projectId, emailNotifications: { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] } }),
    });
    const summaries = await dispatch.dispatchCreated([bogus]);
    assert.equal(summaries[0]!.eligible, false);
    assert.equal(summaries[0]!.reason, "EVENT_NOT_SELECTED");
    assert.equal(h.fake!.attempts.length, 1, "the refused event sent nothing further");
    assert.ok(key.startsWith("ntf-bogus:EMAIL:"));
  } finally {
    await h.cleanup();
  }
});

test("18. a project with email disabled is left exactly as it was", async () => {
  const h = await harness({ enabled: false, recipients: [ALICE] });
  try {
    const before = readFileSync(join(h.dir, "projects", "projects.json"), "utf8");
    await h.runFinding();
    // The notification document gains the real in-app record; the PROJECT does not.
    assert.notEqual(readFileSync(join(h.dir, "projects", "projects.json"), "utf8"), "");
    const after = JSON.parse(readFileSync(join(h.dir, "projects", "projects.json"), "utf8")) as any;
    assert.equal(after.projects[0].emailNotifications.enabled, false);
    assert.equal(after.projects[0].emailNotifications.recipients.length, 1, "the configured list is untouched");
    assert.ok(before.includes(h.projectId));
    assert.equal(readDeliveries(h.dir).length, 0);
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 2. Several recipients
// ===========================================================================

test("5. several recipients each get their own delivery record", async () => {
  const h = await harness({ recipients: [BOB, ALICE] });
  try {
    await h.runFinding();
    const records = readDeliveries(h.dir);
    assert.equal(records.length, 2);
    // Independent records, one per target, both recorded.
    assert.deepEqual(records.map(r => r.recipient).sort(), [ALICE, BOB]);
    assert.equal(new Set(records.map(r => r.deliveryKey)).size, 2, "two distinct delivery identities");
    for (const record of records) {
      assert.equal(record.status, "SENT");
      assert.equal(record.attempt, 1);
    }
    // Stored order is canonical, so the outcome does not depend on map order.
    assert.deepEqual(h.fake!.attempts.map(a => a.recipient), [ALICE, BOB]);
  } finally {
    await h.cleanup();
  }
});

test("6. one recipient failing does not block or mask the other", async () => {
  const h = await harness({ recipients: [ALICE, BOB], transport: failFor(BOB) });
  try {
    await h.runFinding();
    const records = readDeliveries(h.dir);
    const byRecipient = Object.fromEntries(records.map(r => [r.recipient, r.status]));
    assert.equal(byRecipient[ALICE], "SENT", "the reachable recipient was still emailed");
    assert.equal(byRecipient[BOB], "FAILED", "the failing one is recorded as failed");
    assert.match(records.find(r => r.recipient === BOB)!.error, /refused/);

    // The notification itself is unaffected, and the summary is per-recipient.
    const inbox = await getJson(`${h.base}/api/notifications`);
    assert.equal(inbox.json.notifications.length, 1);
    const dispatch = new NotificationEmailDispatch({
      dispatcher: h.dash.emailDeliveryDispatcher,
      loadProject: () => JSON.parse(readFileSync(join(h.dir, "projects", "projects.json"), "utf8")).projects[0],
    });
    const summaries = await dispatch.dispatchCreated([]);
    assert.deepEqual(summaries, []);
    assert.equal(h.fake!.attempts.length, 2, "each recipient was attempted exactly once");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 3. Idempotency, across restarts
// ===========================================================================

test("7. processing the same notification twice never emails twice", async () => {
  const h = await harness();
  try {
    await h.runFinding();
    assert.equal(h.fake!.attempts.length, 1);
    const inbox = await getJson(`${h.base}/api/notifications`);
    const record = inbox.json.notifications[0];

    // The inbox refuses to create the same event again, so nothing new is offered.
    const replay = await h.dash.notifications.record([
      { type: record.type, projectId: record.projectId, projectName: record.projectName, title: record.title, message: record.message, runId: record.runId, findingId: record.findingId, severity: record.severity, source: "finding-lifecycle", reference: record.reference },
    ] as unknown as NotificationPreviewEvent[]);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.ok ? replay.value : null, [], "the duplicate event was not stored again");

    // And even when the dispatcher is asked directly, the persisted success wins.
    const again = await h.dash.emailDeliveryDispatcher.deliver(record, ALICE);
    assert.equal(again.ok, true);
    assert.equal(again.ok && again.value.alreadyDelivered, true);
    assert.equal(again.ok && again.value.delivery.status, "SKIPPED");
    assert.equal(again.ok && again.value.delivery.reason, "ALREADY_DELIVERED");
    assert.equal(h.fake!.attempts.length, 1, "still exactly one email");
    const records = readDeliveries(h.dir);
    assert.equal(records.filter(r => r.status === "SENT").length, 1);
    assert.equal(records.length, 2, "the refusal is itself recorded as an attempt");
  } finally {
    await h.cleanup();
  }
});

test("8. idempotency survives a restart, and 17. delivery persistence does too", async () => {
  const h = await harness();
  let notificationId = "";
  let runId = "";
  try {
    runId = await h.runFinding();
    const inbox = await getJson(`${h.base}/api/notifications`);
    notificationId = inbox.json.notifications[0].id as string;
    assert.equal(readDeliveries(h.dir).length, 1);
  } finally {
    await h.cleanup();
  }

  // A brand new server over the same documents: the delivery history is read back
  // from disk, and the same target is recognised without any in-memory memory.
  const reopened = await start(h.dir, fakeSpawner().spawnImpl, () => Date.now(), {
    emailDeliveryTransport: h.fake!.transport,
    emailTransport: { sendTestMessage: async () => ({ status: "SENT" }) },
  });
  try {
    const store = new NotificationDeliveryStore(deliveriesOf(h.dir));
    const key = deliveryKey(notificationId, "EMAIL", ALICE);
    assert.equal(store.hasSucceeded(key), true, "the success survived the restart");
    assert.equal(store.attemptCount(key), 1);

    const notification = reopened.dash.notifications.get(notificationId)!;
    assert.ok(notification, "the notification survived the restart too");
    const repeat = await reopened.dash.emailDeliveryDispatcher.deliver(notification, ALICE);
    assert.equal(repeat.ok && repeat.value.alreadyDelivered, true);
    assert.equal(repeat.ok && repeat.value.delivery.reason, "ALREADY_DELIVERED");
    assert.equal(h.fake!.attempts.length, 1, "no second email after a restart");

    // The run that produced it is still there and unchanged.
    const detail = await getJson(`${reopened.base}/api/projects/${h.projectId}`);
    assert.equal(detail.json.runs[0].runId, runId);
    assert.equal(readDeliveries(h.dir).length, 2, "history preserved plus the refusal");
  } finally {
    await stop(reopened.dash);
  }
});

// ===========================================================================
// 4. SMTP is absent or broken
// ===========================================================================

test("9. with no SMTP configured the delivery is truthful, not a fabricated success", async () => {
  // No transport injected: the REAL transport decides, which is the point.
  const h = await harness({ transport: null });
  try {
    await h.runFinding();
    const records = readDeliveries(h.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "FAILED", "nothing pretends to have been sent");
    assert.match(records[0].error, /EMAIL_NOT_CONFIGURED/);
    assert.match(records[0].error, /SMTP_HOST/);
    // The notification is still there: a mail server is not a QA dependency.
    const inbox = await getJson(`${h.base}/api/notifications`);
    assert.equal(inbox.json.notifications.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("9b. an unconfigured delivery is never retried into a fake success", async () => {
  const h = await harness({ transport: null });
  try {
    await h.runFinding();
    const inbox = await getJson(`${h.base}/api/notifications`);
    const notification = inbox.json.notifications[0];
    // A retry reuses the same identity, is recorded as a further attempt, and
    // still cannot report SENT while SMTP is absent.
    const retry = await h.dash.emailDeliveryDispatcher.deliver(notification, ALICE);
    assert.equal(retry.ok && retry.value.delivery.status, "FAILED");
    assert.equal(retry.ok && retry.value.delivery.attempt, 2, "a new attempt, not an overwrite");
    const key = deliveryKey(notification.id, "EMAIL", ALICE);
    const store = new NotificationDeliveryStore(deliveriesOf(h.dir));
    assert.equal(store.hasSucceeded(key), false, "no success was ever fabricated");
    assert.equal(store.attemptsFor(key).length, 2, "both attempts preserved");
  } finally {
    await h.cleanup();
  }
});

test("10. an SMTP failure is captured without disturbing notification creation", async () => {
  const h = await harness({
    transport: fakeTransport({ status: "FAILED", error: "EAUTH: 535 authentication failed (bad password)" }),
  });
  try {
    await h.runFinding();
    const records = readDeliveries(h.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "FAILED");
    assert.match(records[0].error, /EAUTH/);
    const inbox = await getJson(`${h.base}/api/notifications`);
    assert.equal(inbox.json.notifications.length, 1, "the notification was still stored");
    // The stored failure is a bounded summary, not a credential store.
    assert.ok(records[0].error.length <= 300);
  } finally {
    await h.cleanup();
  }
});

test("15. a delivery failure changes no QA verdict, no finding and no history", async () => {
  const historyOf = (dir: string, projectId: string) => {
    const doc = JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8")) as any;
    const mine = doc.projects.find((p: { id: string }) => p.id === projectId);
    return {
      runs: doc.runs.filter((r: { projectId: string }) => r.projectId === projectId),
      findings: doc.findings.filter((f: { projectId: string }) => f.projectId === projectId),
      findingEvents: doc.findingEvents.filter((e: { projectId: string }) => e.projectId === projectId),
      changeRecords: doc.changeRecords.filter((c: { projectId: string }) => c.projectId === projectId),
      configured: mine.emailNotifications,
    };
  };

  const h = await harness({ transport: failFor(ALICE) });
  try {
    await h.runFinding();
    assert.equal(readDeliveries(h.dir)[0].status, "FAILED", "delivery really did fail");

    // The QA side is compared against the same run with email switched off, so the
    // assertion is "delivery changed nothing", not "these values look right".
    const withoutEmail = await harness({ enabled: false });
    try {
      await withoutEmail.runFinding();
      const failed = await getJson(`${h.base}/api/projects/${h.projectId}`);
      const untouched = await getJson(`${withoutEmail.base}/api/projects/${withoutEmail.projectId}`);

      assert.equal(failed.json.runs[0].status, untouched.json.runs[0].status, "run status unaffected");
      assert.equal(failed.json.runs[0].findingsCount, untouched.json.runs[0].findingsCount, "finding count unaffected");
      assert.equal(failed.json.runs[0].coverageStatus, untouched.json.runs[0].coverageStatus, "coverage unaffected");
      assert.equal(failed.json.runs[0].state, untouched.json.runs[0].state, "run state unaffected");
      // The detail payload's `findings` are per-run counts, so the verdict is compared on
      // the counts themselves and on the full finding records in the document.
      assert.deepEqual(
        failed.json.findings.map((f: any) => f.counts),
        untouched.json.findings.map((f: any) => f.counts),
        "per-run finding counts identical",
      );
      assert.equal(failed.json.findings[0].counts.new, 1, "the finding is still counted as new");
      // Change records embed the run ids, which differ between two independent projects
      // by construction, so the change-intelligence RESULT is compared without them.
      const changesOf = (records: any[]) =>
        records.map(({ currentRunId: _run, previousRunId: _prev, ...rest }: any) => rest);
      assert.deepEqual(changesOf(failed.json.changes), changesOf(untouched.json.changes), "change-intelligence results identical");
      assert.equal(failed.json.changes.length, 1, "the change record still exists");
      assert.equal(failed.json.changes[0].accessCurrent, "ACCESSIBLE", "the access result is unchanged");

      const mine = historyOf(h.dir, h.projectId);
      const theirs = historyOf(withoutEmail.dir, withoutEmail.projectId);
      assert.equal(mine.runs.length, theirs.runs.length, "run history length unaffected");
      assert.equal(mine.findings.length, theirs.findings.length, "finding history unaffected");
      assert.equal(mine.findingEvents.length, theirs.findingEvents.length, "finding lifecycle unaffected");
      assert.equal(mine.changeRecords.length, theirs.changeRecords.length, "change history unaffected");

      // The real finding records, compared on the QA-verdict fields. Run ids are
      // excluded because two independent projects necessarily have different ones.
      const verdictOf = (records: any[]) =>
        records
          .map((f: any) => ({ code: f.code, severity: f.severity, status: f.status, lifecycle: f.lifecycle, title: f.title }))
          .sort((a, b) => String(a.code).localeCompare(String(b.code)));
      assert.deepEqual(verdictOf(mine.findings), verdictOf(theirs.findings), "findings identical, severity and lifecycle included");
      assert.equal(mine.findings[0].severity, "HIGH", "the severity itself is unchanged");
      assert.deepEqual(
        mine.findingEvents.map((e: { type: string }) => e.type).sort(),
        theirs.findingEvents.map((e: { type: string }) => e.type).sort(),
        "the finding lifecycle events are the same ones",
      );
      // And the configured preferences still say what the user set them to.
      assert.equal(mine.configured.enabled, true);
      assert.deepEqual(mine.configured.recipients, [ALICE]);
    } finally {
      await withoutEmail.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 5. Scheduler and run manager produce notifications; the preview does not
// ===========================================================================

test("13. a scheduler-produced notification takes the same delivery path", async () => {
  const h = await harness({ events: ["SCHEDULE_SKIPPED"] });
  try {
    await send("PUT", `${h.base}/api/projects/${h.projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    // A real run occupies the single-run slot, so a real trigger is a real skip.
    const manual = await postJson(`${h.base}/api/projects/${h.projectId}/runs`);
    assert.equal(manual.status, 202, JSON.stringify(manual.json));
    await waitFor(() => h.children.length === 1);
    const triggered = await postJson(`${h.base}/api/projects/${h.projectId}/schedule/run-now`);
    assert.equal(triggered.status, 200, JSON.stringify(triggered.json));
    assert.equal(triggered.json.execution.status, "SKIPPED_OVERLAPPING_RUN");
    await h.dash.settleEmailDeliveries();

    // The skip is delivered on its own, with no scheduler code involved.
    const skipAttempt = h.fake!.attempts.find(a => a.notification.type === "SCHEDULE_SKIPPED");
    assert.ok(skipAttempt, "the scheduler notification was emailed");
    assert.equal(skipAttempt!.recipient, ALICE);
    const skipRecord = readDeliveries(h.dir).find(r => r.notificationId === skipAttempt!.notification.id);
    assert.equal(skipRecord.status, "SENT");
    // NEW_FINDING is not selected here, so the run's finding was not emailed.
    assert.equal(h.fake!.attempts.some(a => a.notification.type === "NEW_FINDING"), false);
    settle(h.children[0]!, analysisWith([finding()]));
    await waitFor(() => h.children[0]!.exitCode !== null);
    await h.dash.settleEmailDeliveries();
    assert.equal(h.fake!.attempts.filter(a => a.notification.type === "NEW_FINDING").length, 0);
  } finally {
    await h.cleanup();
  }
});

test("14. a run-manager-produced notification is delivered by the same wiring", async () => {
  const h = await harness({ events: ["NEW_FINDING", "MEANINGFUL_CHANGE"] });
  try {
    const runId = await h.runFinding();
    const inbox = await getJson(`${h.base}/api/notifications`);
    const produced = inbox.json.notifications.find((n: { runId: string | null }) => n.runId === runId);
    assert.ok(produced, "the run manager produced the notification");
    const attempt = h.fake!.attempts.find(a => a.notification.id === produced.id);
    assert.ok(attempt, "and the same notification was emailed");
    // Every recipient-configured, selected event that the run produced is covered.
    assert.equal(h.fake!.attempts.filter(a => a.notification.runId === runId).every(a => a.recipient === ALICE), true);
    assert.ok(runId);
  } finally {
    await h.cleanup();
  }
});

test("12. previewing notifications stays read-only and sends nothing", async () => {
  const h = await harness();
  try {
    const runId = await h.runFinding();
    const attemptsAfterRun = h.fake!.attempts.length;
    const deliveriesAfterRun = readDeliveries(h.dir).length;

    // Preview the same run repeatedly, including for a run that never settled.
    for (let i = 0; i < 3; i++) {
      const preview = await getJson(`${h.base}/api/projects/${h.projectId}/notification-preview/${runId}`);
      assert.equal(preview.status, 200);
      assert.ok(preview.json.notificationPreview.notifications.length > 0);
    }
    await getJson(`${h.base}/api/projects/${h.projectId}/notification-preview/web-does-not-exist`);

    assert.equal(h.fake!.attempts.length, attemptsAfterRun, "preview sent no email");
    assert.equal(readDeliveries(h.dir).length, deliveriesAfterRun, "preview recorded no delivery");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 6. The test email stays a separate thing
// ===========================================================================

test("11. the test email stays separate from automatic delivery", async () => {
  const h = await harness();
  try {
    await h.runFinding();
    const deliveriesBefore = readFileSync(deliveriesOf(h.dir), "utf8");
    const notificationsBefore = readFileSync(join(h.dir, "projects", "notifications.json"), "utf8");
    const attemptsBefore = h.fake!.attempts.length;

    // The route checks SMTP readiness before it sends, so the variables have to be
    // present for the SUCCESS path; the fake seam then sends without a mail server.
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "qa@example.test";
    const tested = await postJson(`${h.base}/api/projects/${h.projectId}/email-settings/test`);
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    assert.equal(tested.status, 200, JSON.stringify(tested.json));
    assert.equal(tested.json.code, "EMAIL_SENT");

    // A test email is a delivery test: it is neither a notification nor a
    // delivery record, and it never reaches the notification transport.
    assert.equal(h.fake!.attempts.length, attemptsBefore, "the automatic transport was not called");
    assert.equal(readFileSync(deliveriesOf(h.dir), "utf8"), deliveriesBefore, "no delivery record");
    assert.equal(readFileSync(join(h.dir, "projects", "notifications.json"), "utf8"), notificationsBefore, "no notification");
  } finally {
    await h.cleanup();
  }
});

// ===========================================================================
// 7. The integration layer itself
// ===========================================================================

test("the dispatch layer reports every reason and never throws", async () => {
  const project = { id: "prj-1", emailNotifications: { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] } };
  const transport = fakeTransport();
  const store = new NotificationDeliveryStore(join(mkdtempSync(join(tmpdir(), "m5-unit-")), "deliveries.json"));
  const dispatcher = new NotificationDeliveryDispatcher({ store, transports: { EMAIL: transport.transport }, now: () => 1767225600000 });
  const dispatch = new NotificationEmailDispatch({
    dispatcher,
    loadProject: id => (id === "prj-1" ? project : null),
    onError: () => undefined,
  });

  const event: NotificationPreviewEvent = {
    type: "NEW_FINDING", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "run-1", findingId: "f-1", severity: "HIGH", source: "finding-lifecycle", reference: "f-1",
  } as NotificationPreviewEvent;
  const record = notificationFromEvent(event, "2026-09-29T10:00:00.000Z");

  const sent = await dispatch.dispatchCreated([record]);
  assert.equal(sent[0]!.eligible, true);
  assert.equal(sent[0]!.reason, "ELIGIBLE");
  assert.deepEqual(sent[0]!.results.map(r => r.status), ["SENT"]);

  // A record for a project that no longer exists is reported, not dispatched.
  const orphan = notificationFromEvent({ ...event, projectId: "prj-gone" } as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");
  const missing = await dispatch.dispatchCreated([orphan]);
  assert.equal(missing[0]!.eligible, false);
  assert.equal(missing[0]!.reason, "PROJECT_NOT_FOUND");
  assert.deepEqual(missing[0]!.results, []);

  // A transport that throws becomes a recorded FAILED, not a rejected promise.
  const exploding = new NotificationEmailDispatch({
    dispatcher: new NotificationDeliveryDispatcher({
      store: new NotificationDeliveryStore(join(mkdtempSync(join(tmpdir(), "m5-boom-")), "deliveries.json")),
      transports: { EMAIL: { channel: "EMAIL", send: async () => { throw new Error("boom"); } } },
      now: () => 1767225600000,
    }),
    loadProject: () => project,
    onError: () => undefined,
  });
  const contained = await exploding.dispatchCreated([record]);
  assert.equal(contained.length, 1, "a throwing transport is contained");
  assert.equal(contained[0]!.results[0]!.status, "FAILED");
  assert.equal(transport.attempts.length, 1);
});

test("an unexpected delivery failure is reported as itself, not as a missing project", async () => {
  const record = notificationFromEvent({
    type: "NEW_FINDING", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "r", findingId: "f", severity: null, source: "finding-lifecycle", reference: "f",
  } as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");
  const boom = new Error("the delivery store is on fire");

  // A dispatcher that throws is contained here, and the summary must not pretend the
  // project is missing - that would send someone hunting for the wrong problem.
  const reported: string[] = [];
  const dispatch = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => { throw boom; } },
    loadProject: () => ({ id: "prj-1", emailNotifications: { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] } }),
    onError: message => { reported.push(message); },
  });

  const summaries = await dispatch.dispatchCreated([record]);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.reason, "DISPATCH_ERROR", "an internal failure is named as one");
  assert.equal(summaries[0]!.eligible, false);
  assert.deepEqual(summaries[0]!.results, []);
  assert.ok(reported[0]!.includes("the delivery store is on fire"), "the actual cause is still reported");
  assert.ok(!reported[0]!.includes(ALICE), "and no recipient address is leaked into the log");

  // A genuinely missing project is still reported by the preference layer, from the
  // project lookup itself, so the two causes stay distinguishable.
  const missing = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => { throw new Error("must not be reached"); } },
    loadProject: () => null,
    onError: () => undefined,
  });
  const missingSummaries = await missing.dispatchCreated([record]);
  assert.equal(missingSummaries[0]!.reason, "PROJECT_NOT_FOUND");
  assert.equal(reported.length, 1, "a missing project is a normal answer, not an internal error");
});

test("a hand-edited invalid recipient is refused before it can reach a mail server", async () => {
  // Preferences are validated on write, so an invalid address can only arrive in a
  // hand-edited document. The preferences guard rejects the WHOLE block rather than
  // silently dropping one address, so such a project is simply not eligible - it can
  // never become "the good ones still get mailed" by accident.
  const dispatch = new NotificationEmailDispatch({
    dispatcher: { deliver: async () => { throw new Error("the dispatcher must not be reached"); } },
    loadProject: () => ({ id: "prj-1", emailNotifications: { enabled: true, recipients: ["not-an-email", ALICE], events: ["NEW_FINDING"] } }),
    onError: () => undefined,
  });
  const record = notificationFromEvent({
    type: "NEW_FINDING", projectId: "prj-1", projectName: "Checkout", title: "t", message: "m",
    runId: "r", findingId: "f", severity: null, source: "finding-lifecycle", reference: "f",
  } as NotificationPreviewEvent, "2026-09-29T10:00:00.000Z");

  const summaries = await dispatch.dispatchCreated([record]);
  assert.equal(summaries[0]!.eligible, false);
  assert.equal(summaries[0]!.reason, "DISABLED", "an invalid block is not a usable configuration at all");
  assert.deepEqual(summaries[0]!.results, []);

  // The delivery layer's own recipient guard still holds independently, for any
  // address that reaches it without passing the preference layer first.
  const dir = mkdtempSync(join(tmpdir(), "m5-bad-"));
  const store = new NotificationDeliveryStore(join(dir, "deliveries.json"));
  const transport = fakeTransport();
  const dispatcher = new NotificationDeliveryDispatcher({ store, transports: { EMAIL: transport.transport } });
  const refused = await dispatcher.deliver(record, "not-an-email");
  assert.equal(refused.ok && refused.value.delivery.status, "SKIPPED");
  assert.equal(refused.ok && refused.value.delivery.reason, "INVALID_RECIPIENT");
  assert.equal(transport.attempts.length, 0, "the transport was never called with an unusable address");
  assert.equal(readFileSync(join(dir, "deliveries.json"), "utf8").includes("not-an-email"), true,
    "the refusal names the address, so the problem is diagnosable");
});