// ---------------------------------------------------------------------------
// Notification delivery core.
//
// Delivery identity, idempotency, retry, persistence and the read-only HTTP
// surface - all driven through the real settlement path with the same
// engine-shaped reports the notification tests use.
//
// Every fixture is an isolated temporary directory, so no test here can invent
// delivery history against the user's own projects.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultNotificationDeliveriesPath,
  deliveryErrorSummary,
  deliveryIdFor,
  deliveryKey,
  InMemoryDeliveryTransport,
  NotificationDeliveryDispatcher,
  NotificationDeliveryStore,
  normalizeRecipient,
} from "../dashboard/notification-delivery.js";
import type {
  NotificationChannel,
  NotificationDelivery,
  NotificationDeliveryTransport,
  DeliveryRequest,
  DeliveryResult,
} from "../dashboard/notification-delivery.js";
import { NotificationStore, notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";
import {
  analysisWith,
  crash,
  fakeSpawner,
  finding,
  getJson,
  labelFinding,
  postJson,
  runOnce,
  settle,
  send,
  start,
  stop,
  waitFor,
} from "./notification-fixtures.js";

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const inboxOf = (dir: string): string => join(dir, "projects", "notifications.json");
const deliveriesOf = (dir: string): string => join(dir, "projects", "notification-deliveries.json");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const event = (overrides: Partial<NotificationPreviewEvent> = {}): NotificationPreviewEvent => ({
  type: "NEW_FINDING",
  projectId: "web-abc123",
  projectName: "Checkout",
  runId: "web-run-1",
  findingId: "prj-fnd-1",
  severity: "HIGH",
  title: "New finding",
  message: "A tracked finding appeared for the first time.",
  source: "finding-lifecycle",
  reference: "prj-fnd-1",
  ...overrides,
});

const storedNotification = (overrides: Partial<NotificationPreviewEvent> = {}) =>
  notificationFromEvent(event(overrides), "2026-09-29T10:05:00.000Z");

/** A fixed clock, so `attemptedAt` is never a source of nondeterminism. */
const clock = (iso: string) => () => Date.parse(iso);

const build = (
  dir: string,
  options: { transports?: Partial<Record<NotificationChannel, NotificationDeliveryTransport>>; now?: () => number } = {},
) => {
  const store = new NotificationDeliveryStore(deliveriesOf(dir));
  const dispatcher = new NotificationDeliveryDispatcher({ store, ...options });
  return { store, dispatcher };
};

const read = (dir: string): NotificationDelivery[] => {
  if (!existsSync(deliveriesOf(dir))) return [];
  const parsed = JSON.parse(readFileSync(deliveriesOf(dir), "utf8"));
  return parsed.deliveries as NotificationDelivery[];
};

// ---------------------------------------------------------------------------
// Delivery creation
// ---------------------------------------------------------------------------

test("a notification delivered through the test transport is recorded as SENT", async () => {
  const dir = tempDir("ai-website-qa-dlv-sent-");
  const transport = new InMemoryDeliveryTransport();
  const { dispatcher, store } = build(dir, { transports: { EMAIL: transport }, now: clock("2026-09-29T10:06:00.000Z") });
  const notification = storedNotification();

  const result = await dispatcher.deliver(notification, ALICE);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.delivery.status, "SENT");
  assert.equal(result.ok && result.value.alreadyDelivered, false);

  // The transport really received the notification and the recipient.
  assert.equal(transport.attempts.length, 1);
  assert.equal(transport.attempts[0]!.recipient, ALICE);
  assert.equal(transport.attempts[0]!.notification.id, notification.id);
  assert.equal(transport.attempts[0]!.notification.message, notification.message);

  // And the attempt was persisted, not merely returned.
  assert.equal(store.list({ notificationId: notification.id }).total, 1);
  const persisted = read(dir);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.status, "SENT");
  assert.equal(persisted[0]!.recipient, ALICE);
  assert.equal(persisted[0]!.channel, "EMAIL");
  assert.equal(persisted[0]!.attempt, 1);
  assert.equal(persisted[0]!.attemptedAt, "2026-09-29T10:06:00.000Z");
  assert.equal(persisted[0]!.providerMessageId, "mem-1");
});

test("the delivery document is written beside notifications.json, and only on demand", async () => {
  const dir = tempDir("ai-website-qa-dlv-path-");
  assert.equal(defaultNotificationDeliveriesPath(dir), deliveriesOf(dir));

  // Constructing the store creates nothing: this milestone never auto-delivers,
  // so merely starting up must not invent delivery history.
  const store = new NotificationDeliveryStore(deliveriesOf(dir));
  assert.equal(store.list().total, 0);
  assert.equal(existsSync(deliveriesOf(dir)), false);

  const { dispatcher } = build(dir, { transports: { EMAIL: new InMemoryDeliveryTransport() } });
  await dispatcher.deliver(storedNotification(), ALICE);
  assert.equal(existsSync(deliveriesOf(dir)), true);
  assert.ok(statSync(deliveriesOf(dir)).size > 0);
});

test("recording a delivery never rewrites the notification document", async () => {
  const dir = tempDir("ai-website-qa-dlv-inbox-");
  const inbox = new NotificationStore(inboxOf(dir));
  inbox.record([event()], "2026-09-29T10:05:00.000Z");
  const before = readFileSync(inboxOf(dir), "utf8");

  const { dispatcher } = build(dir, { transports: { EMAIL: new InMemoryDeliveryTransport() } });
  await dispatcher.deliver(storedNotification(), ALICE);
  await dispatcher.deliver(storedNotification(), BOB);

  assert.equal(readFileSync(inboxOf(dir), "utf8"), before);
  assert.equal(new NotificationStore(inboxOf(dir)).list().total, 1);
});

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

test("a delivery id is a pure function of its target and attempt, not of the clock", () => {
  const key = deliveryKey("ntf-abc", "EMAIL", ALICE);
  assert.equal(deliveryIdFor(key, 1), deliveryIdFor(key, 1));
  assert.notEqual(deliveryIdFor(key, 1), deliveryIdFor(key, 2));
  assert.match(deliveryIdFor(key, 1), /^dlv-[0-9a-f]{32}$/);

  // A different recipient is a different target, so the same person cannot be
  // reached through two spellings of their address.
  assert.notEqual(deliveryIdFor(key, 1), deliveryIdFor(deliveryKey("ntf-abc", "EMAIL", BOB), 1));
  // A different notification is a different target.
  assert.notEqual(deliveryIdFor(key, 1), deliveryIdFor(deliveryKey("ntf-xyz", "EMAIL", ALICE), 1));
  // And a different channel would be too.
  assert.notEqual(deliveryKey("ntf-abc", "EMAIL", ALICE), "ntf-abc:WEBHOOK:" + ALICE);
});

test("the recipient grammar refuses empty dot labels, not just obvious junk", () => {
  // The grammar this app shares with project email preferences. These all LOOK
  // plausible in a text box but leave an empty label, which no mail server
  // accepts - so they are refused here rather than becoming a delivery target
  // that silently never arrives.
  for (const malformed of [
    "alice..bob@example.com",
    ".alice@example.com",
    "alice.@example.com",
    "alice@example..com",
    "alice@.example.com",
    "alice@example.com.",
    "alice@-example.com",
    "alice@example-.com",
    "@example.com",
    "alice@",
    "alice",
    "alice example@example.com",
    "alice@example.com, bob@example.com",
    "alice@example.com;",
  ]) {
    assert.equal(normalizeRecipient(malformed), null, `${malformed} must be refused`);
  }

  // ...while the ordinary shapes a person actually types still pass.
  for (const valid of [
    "alice@example.com",
    "alice.smith@example.co.uk",
    "alice+tag@example.com",
    "alice_smith@example.com",
    "a@b.example",
    "qa@localhost",
  ]) {
    assert.equal(normalizeRecipient(valid), valid.toLowerCase(), `${valid} must be accepted`);
  }
});

test("recipients are normalized, so case and padding cannot fork the identity", async () => {
  const dir = tempDir("ai-website-qa-dlv-norm-");
  const transport = new InMemoryDeliveryTransport();
  const { dispatcher, store } = build(dir, { transports: { EMAIL: transport } });
  const notification = storedNotification();

  assert.equal(normalizeRecipient("  Alice@Example.COM "), ALICE);
  assert.equal(normalizeRecipient("alice@example.com"), ALICE);
  assert.equal(normalizeRecipient("not-an-address"), null);
  // Header injection is refused outright, not stripped into a valid address.
  assert.equal(normalizeRecipient("alice@example.com\r\nBcc: victim@example.com"), null);

  await dispatcher.deliver(notification, "Alice@Example.COM");
  assert.equal(transport.attempts.length, 1);
  assert.equal(store.hasSucceeded(deliveryKey(notification.id, "EMAIL", ALICE)), true);
  assert.equal(store.list({ notificationId: notification.id }).targets, 1);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("a second request after SENT does not call the transport and records SKIPPED", async () => {
  const dir = tempDir("ai-website-qa-dlv-idem-");
  const transport = new InMemoryDeliveryTransport();
  const { dispatcher, store } = build(dir, { transports: { EMAIL: transport } });
  const notification = storedNotification();

  const first = await dispatcher.deliver(notification, ALICE);
  assert.equal(first.ok && first.value.delivery.status, "SENT");
  assert.equal(first.ok && first.value.alreadyDelivered, false);
  const sentCalls = transport.attempts.length;

  const second = await dispatcher.deliver(notification, ALICE);
  assert.equal(second.ok, true);
  assert.equal(second.ok && second.value.delivery.status, "SKIPPED");
  assert.equal(second.ok && second.value.delivery.reason, "ALREADY_DELIVERED");
  assert.equal(second.ok && second.value.alreadyDelivered, true);

  // The transport was asked exactly once, ever.
  assert.equal(transport.attempts.length, sentCalls);
  assert.equal(transport.sendCount(ALICE), 1);
  // No duplicate successful delivery exists for the target.
  assert.equal(store.list({ notificationId: notification.id, status: "SENT" }).total, 1);
  assert.equal(store.list({ notificationId: notification.id }).targets, 1);
});

test("idempotency is remembered across a restart, not just in memory", async () => {
  const dir = tempDir("ai-website-qa-dlv-idem-restart-");
  const notification = storedNotification();
  const first = build(dir, { transports: { EMAIL: new InMemoryDeliveryTransport() } });
  await first.dispatcher.deliver(notification, ALICE);

  // A brand new store and dispatcher, as after a process restart, must still know
  // the target was delivered - without consulting the old transport.
  const transport = new InMemoryDeliveryTransport();
  const reopened = build(dir, { transports: { EMAIL: transport } });
  assert.equal(reopened.store.hasSucceeded(deliveryKey(notification.id, "EMAIL", ALICE)), true);

  const again = await reopened.dispatcher.deliver(notification, ALICE);
  assert.equal(again.ok && again.value.delivery.status, "SKIPPED");
  assert.equal(again.ok && again.value.delivery.reason, "ALREADY_DELIVERED");
  assert.equal(transport.attempts.length, 0);
});

test("two recipients of one notification are tracked independently", async () => {
  const dir = tempDir("ai-website-qa-dlv-multi-");
  const transport = new InMemoryDeliveryTransport();
  const { dispatcher, store } = build(dir, { transports: { EMAIL: transport } });
  const notification = storedNotification();

  await dispatcher.deliver(notification, ALICE);
  await dispatcher.deliver(notification, BOB);

  assert.equal(transport.sendCount(ALICE), 1);
  assert.equal(transport.sendCount(BOB), 1);
  assert.equal(store.list({ notificationId: notification.id }).total, 2);
  assert.equal(store.list({ notificationId: notification.id }).targets, 2);

  // Alice being delivered never implies Bob was.
  await dispatcher.deliver(notification, ALICE);
  assert.equal(transport.sendCount(ALICE), 1);
  assert.equal(store.list({ notificationId: notification.id, recipient: BOB, status: "SENT" }).total, 1);
});

test("a channel with no transport is skipped rather than silently succeeding", async () => {
  const dir = tempDir("ai-website-qa-dlv-notransport-");
  const { dispatcher } = build(dir, { transports: {} });
  const result = await dispatcher.deliver(storedNotification(), ALICE);
  assert.equal(result.ok && result.value.delivery.status, "SKIPPED");
  assert.equal(result.ok && result.value.delivery.reason, "NO_TRANSPORT");
  assert.equal(read(dir).length, 1);
});

// ---------------------------------------------------------------------------
// Failure handling and retry
// ---------------------------------------------------------------------------

test("a transport failure is recorded FAILED with a bounded, single-line error", async () => {
  const dir = tempDir("ai-website-qa-dlv-fail-");
  const transport = new InMemoryDeliveryTransport({ failRecipients: [ALICE] });
  const { dispatcher, store } = build(dir, { transports: { EMAIL: transport } });

  const result = await dispatcher.deliver(storedNotification(), ALICE);
  assert.equal(result.ok && result.value.delivery.status, "FAILED");
  const failed = store.list({ notificationId: storedNotification().id, status: "FAILED" }).deliveries[0]!;
  assert.match(failed.error!, /transport refused/);
  assert.doesNotMatch(failed.error!, /\r?\n/);
  assert.ok(failed.error!.length <= 303);
  // A failure is never reported as a success, and never satisfies idempotency.
  assert.equal(store.hasSucceeded(failed.deliveryKey), false);
});

test("a transport that throws is a FAILED attempt, not a crashed dispatcher", async () => {
  const dir = tempDir("ai-website-qa-dlv-throw-");
  const throwing: NotificationDeliveryTransport = {
    channel: "EMAIL",
    send: async () => { throw new Error("connection reset by peer\nsecond line"); },
  };
  const { dispatcher, store } = build(dir, { transports: { EMAIL: throwing } });

  const result = await dispatcher.deliver(storedNotification(), ALICE);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.delivery.status, "FAILED");
  const failed = store.list({ status: "FAILED" }).deliveries[0]!;
  assert.equal(failed.error, "connection reset by peer second line");
});

test("a failed delivery is retried as a NEW attempt, and a successful retry does not overwrite the failure", async () => {
  const dir = tempDir("ai-website-qa-dlv-retry-");
  const notification = storedNotification();
  const key = deliveryKey(notification.id, "EMAIL", ALICE);

  // First transport always fails.
  const failing = build(dir, { transports: { EMAIL: new InMemoryDeliveryTransport({ failRecipients: [ALICE] }) } });
  await failing.dispatcher.deliver(notification, ALICE);
  assert.equal(failing.store.list({ notificationId: notification.id }).total, 1);

  // Retry through a transport that succeeds, as a later milestone would.
  const transport = new InMemoryDeliveryTransport();
  const retry = build(dir, { transports: { EMAIL: transport } });
  const result = await retry.dispatcher.deliver(notification, ALICE);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.delivery.status, "SENT");
  assert.equal(result.ok && result.value.delivery.attempt, 2);
  // The retry was a real transport attempt.
  assert.equal(transport.sendCount(ALICE), 1);
  // Both attempts survive, so the failure is still on the record.
  const attempts = retry.store.attemptsFor(key);
  assert.deepEqual(attempts.map(entry => [entry.attempt, entry.status]), [[1, "FAILED"], [2, "SENT"]]);
  assert.equal(retry.store.hasSucceeded(key), true);

  // Having succeeded, the target is now closed to further sends.
  const third = await retry.dispatcher.deliver(notification, ALICE);
  assert.equal(third.ok && third.value.delivery.status, "SKIPPED");
  assert.equal(third.ok && third.value.delivery.reason, "ALREADY_DELIVERED");
  assert.equal(transport.sendCount(ALICE), 1);
  assert.equal(retry.store.list({ notificationId: notification.id, status: "SENT" }).total, 1);
});

test("a failure is never converted into a success without another transport attempt", async () => {
  const dir = tempDir("ai-website-qa-dlv-nofakerecovery-");
  const notification = storedNotification();
  let calls = 0;
  const flaky: NotificationDeliveryTransport = {
    channel: "EMAIL",
    send: async (_request: DeliveryRequest): Promise<DeliveryResult> => {
      calls += 1;
      return { status: "FAILED", error: "still down" };
    },
  };
  const { dispatcher, store } = build(dir, { transports: { EMAIL: flaky } });

  await dispatcher.deliver(notification, ALICE);
  await dispatcher.deliver(notification, ALICE);

  assert.equal(calls, 2);
  assert.equal(store.list({ status: "SENT" }).total, 0);
  assert.equal(store.list({ status: "FAILED" }).total, 2);
  assert.equal(store.hasSucceeded(deliveryKey(notification.id, "EMAIL", ALICE)), false);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test("delivery history survives a reload, and the same attempt cannot be recorded twice", async () => {
  const dir = tempDir("ai-website-qa-dlv-persist-");
  const notification = storedNotification();
  const first = build(dir, { transports: { EMAIL: new InMemoryDeliveryTransport() } });
  await first.dispatcher.deliver(notification, ALICE);
  await first.dispatcher.deliver(notification, BOB);
  const afterFirst = readFileSync(deliveriesOf(dir), "utf8");

  const reopened = new NotificationDeliveryStore(deliveriesOf(dir));
  assert.equal(reopened.list().total, 2);
  assert.equal(reopened.list().targets, 2);
  assert.equal(reopened.hasSucceeded(deliveryKey(notification.id, "EMAIL", ALICE)), true);
  assert.equal(reopened.hasSucceeded(deliveryKey(notification.id, "EMAIL", BOB)), true);

  // Re-recording an existing attempt id is a no-op, not a second row.
  const duplicate = reopened.record(read(dir)[0]!);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.ok && duplicate.value.created, false);
  assert.equal(reopened.list().total, 2);
  assert.equal(readFileSync(deliveriesOf(dir), "utf8"), afterFirst);
});

test("a corrupt delivery document reads as an empty history, not a crash", () => {
  const dir = tempDir("ai-website-qa-dlv-corrupt-");
  const store = new NotificationDeliveryStore(deliveriesOf(dir));
  store.record({
    id: "dlv-x", deliveryKey: "k", notificationId: "n", channel: "EMAIL", recipient: ALICE,
    attempt: 1, status: "SENT", attemptedAt: "2026-09-29T10:00:00.000Z",
  });

  writeFileSync(deliveriesOf(dir), "{ truncated", "utf8");
  const reopened = new NotificationDeliveryStore(deliveriesOf(dir));
  assert.equal(reopened.list().total, 0);
});

// ---------------------------------------------------------------------------
// Read-only API
// ---------------------------------------------------------------------------

test("the deliveries endpoint reports a notification's attempts and nothing else", async () => {
  const dir = tempDir("ai-website-qa-dlv-api-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    // The REAL record the inbox recorded, not a synthetic stand-in: the route is
    // scoped to a notification that actually exists.
    const notification = (await getJson(`${base}/api/notifications`)).json.notifications[0];
    const notificationId = notification.id as string;

    const store = dash.notificationDeliveries;
    const dispatcher = new NotificationDeliveryDispatcher({ store, transports: { EMAIL: new InMemoryDeliveryTransport() } });
    // Alice is delivered; Bob is not, so the endpoint must report one target.
    await dispatcher.deliver(notification, ALICE);

    const response = await getJson(`${base}/api/notifications/${notificationId}/deliveries`);
    assert.equal(response.status, 200);
    assert.equal(response.json.notificationId, notificationId);
    assert.equal(response.json.total, 1);
    assert.equal(response.json.targets, 1);
    assert.equal(response.json.deliveries.length, 1);
    const record = response.json.deliveries[0];
    assert.equal(record.channel, "EMAIL");
    assert.equal(record.recipient, ALICE);
    assert.equal(record.status, "SENT");
    assert.equal(record.attempt, 1);
    assert.equal(record.attemptedAt, record.attemptedAt);
    assert.equal(store.list({ recipient: BOB }).total, 0);
    // The response carries no server path and nothing resembling a credential.
    assert.doesNotMatch(JSON.stringify(response.json), /[A-Za-z]:\\|\/home\/|password|secret|token|smtp|authorization/i);
  } finally { await stop(dash); }
});

test("the deliveries endpoint is read-only and 404s for an unknown notification", async () => {
  const dir = tempDir("ai-website-qa-dlv-api-guard-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    assert.equal((await getJson(`${base}/api/notifications/ntf-nosuchnotification/deliveries`)).status, 404);
    assert.equal((await postJson(`${base}/api/notifications/ntf-nosuchnotification/deliveries`)).status, 405);

    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    const notificationId = (await getJson(`${base}/api/notifications`)).json.notifications[0].id as string;

    // Writing through the endpoint is refused, and the document is not created.
    assert.equal((await send("DELETE", `${base}/api/notifications/${notificationId}/deliveries`)).status, 405);
    assert.equal(existsSync(deliveriesOf(dir)), false);

    // An unknown notification is never given an empty-but-successful history.
    const empty = await getJson(`${base}/api/notifications/${notificationId}/deliveries`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.deliveries, []);
    assert.equal(empty.json.total, 0);
  } finally { await stop(dash); }
});

test("the endpoint validates its filters instead of returning everything", async () => {
  const dir = tempDir("ai-website-qa-dlv-api-filter-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    const notificationId = (await getJson(`${base}/api/notifications`)).json.notifications[0].id as string;

    assert.equal((await getJson(`${base}/api/notifications/${notificationId}/deliveries?channel=SMS`)).status, 400);
    assert.equal((await getJson(`${base}/api/notifications/${notificationId}/deliveries?status=QUEUED`)).status, 400);
    assert.equal((await getJson(`${base}/api/notifications/${notificationId}/deliveries?channel=EMAIL`)).status, 200);
  } finally { await stop(dash); }
});

// ---------------------------------------------------------------------------
// Safety: delivery consumes notifications, it never redefines or disturbs them
// ---------------------------------------------------------------------------

test("the production pipeline delivers nothing on its own", async () => {
  const dir = tempDir("ai-website-qa-dlv-noauto-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    // Real events: a new finding, then a regression when it changes shape, then a
    // crash that never writes a report. Between them they exercise every
    // settlement path that could plausibly have tried to deliver something.
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    await runOnce(base, projectId, fake.children, 1, analysisWith([finding({ id: "QA-F-777", code: "NAV" })]));
    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => fake.children.length === 3);
    crash(fake.children[2]!);
    await waitFor(() => fake.children[2]!.exitCode !== null);

    const inbox = (await getJson(`${base}/api/notifications`)).json;
    const types = inbox.notifications.map((item: { type: string }) => item.type).sort();
    assert.ok(types.length >= 2, `the real events still exist, got ${JSON.stringify(types)}`);
    // Every notification is untouched and nothing was delivered for any of them.
    assert.equal(inbox.notifications.every((item: { read: boolean }) => item.read === false), true);
    assert.equal(dash.notificationDeliveries.list().total, 0);
    assert.equal(existsSync(deliveriesOf(dir)), false);
  } finally { await stop(dash); }
});

test("a failing delivery changes no QA result, no finding lifecycle and no schedule", async () => {
  const dir = tempDir("ai-website-qa-dlv-isolation-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    // A real schedule, so the schedule document exists and can be compared.
    await send("PUT", `${base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    await runOnce(base, projectId, fake.children, 1, analysisWith([finding(), labelFinding()]));

    const before = await getJson(`${base}/api/projects/${projectId}`);
    const inboxBefore = readFileSync(inboxOf(dir), "utf8");
    const schedulesBefore = readFileSync(join(dir, "projects", "schedules.json"), "utf8");
    const notificationId = (await getJson(`${base}/api/notifications`)).json.notifications[0].id as string;

    const dispatcher = new NotificationDeliveryDispatcher({
      store: dash.notificationDeliveries,
      transports: { EMAIL: new InMemoryDeliveryTransport({ failRecipients: [ALICE, BOB] }) },
    });
    for (const item of (await getJson(`${base}/api/notifications`)).json.notifications) {
      await dispatcher.deliver(item, ALICE);
    }
    await dispatcher.deliver(storedNotification({ projectId }), BOB);

    // The run states, finding counts and statuses are exactly as they were.
    const after = await getJson(`${base}/api/projects/${projectId}`);
    assert.deepEqual(after.json.runs.map((r: { runId: string; state: string; status: string }) => [r.runId, r.state, r.status]),
      before.json.runs.map((r: { runId: string; state: string; status: string }) => [r.runId, r.state, r.status]));
    assert.deepEqual(after.json.findings, before.json.findings);
    assert.equal(after.json.project.lastStatus, before.json.project.lastStatus);
    assert.equal(after.json.project.lastFindingsCount, before.json.project.lastFindingsCount);
    // Neither the inbox nor the schedule document moved.
    assert.equal(readFileSync(inboxOf(dir), "utf8"), inboxBefore);
    assert.equal(readFileSync(join(dir, "projects", "schedules.json"), "utf8"), schedulesBefore);
    // The failures are recorded and none of them is a success.
    assert.ok(dash.notificationDeliveries.list({ status: "FAILED" }).total >= 1);
    assert.equal(dash.notificationDeliveries.list({ status: "SENT" }).total, 0);
    assert.equal((await getJson(`${base}/api/notifications/${notificationId}/deliveries`)).json.total, 1);
  } finally { await stop(dash); }
});

test("error summaries are bounded and never multi-line", () => {
  assert.equal(deliveryErrorSummary(new Error("a\nb\tc  ")), "a b c");
  const empty = "The transport reported a failure without a message.";
  assert.equal(deliveryErrorSummary(""), empty);
  assert.equal(deliveryErrorSummary(undefined), empty);
  assert.equal(deliveryErrorSummary(new Error("")).length, empty.length);
  const huge = deliveryErrorSummary(new Error("x".repeat(5000)));
  assert.equal(huge.length, 303);
});

test("no SMTP, network or credential dependency exists in the delivery core", () => {
  const raw = readFileSync(join(process.cwd(), "src", "dashboard", "notification-delivery.ts"), "utf8");
  // Prose is allowed to say "there is no SMTP here"; CODE is not allowed to reach
  // for one. Comments and string literals are stripped so this checks behaviour,
  // not the documentation that explains the absence.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/^\s*\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'))
    .join("\n");

  // No network or socket dependency of any kind.
  for (const netModule of ["net", "http", "https", "tls", "dgram", "dns", "smtp"]) {
    assert.doesNotMatch(code, new RegExp(`node:${netModule}\\b`), `node:${netModule} must not be imported`);
  }
  assert.doesNotMatch(code, /createConnection|\.connect\(|new URL\(\s*["']smtp|fetch\(|XMLHttpRequest|require\(/);
  assert.doesNotMatch(code, /process\.env/);

  // No credential is ever named, read, accepted or stored as a value.
  for (const secretField of ["password", "passwd", "secret", "apikey", "api_key", "token", "credential", "authorization", "bearer", "smtps?://"]) {
    assert.doesNotMatch(code, new RegExp(secretField, "i"), `${secretField} must not appear in delivery code`);
  }
});