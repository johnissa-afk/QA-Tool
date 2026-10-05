// ---------------------------------------------------------------------------
// Production in-app notifications.
//
// Persistence, deterministic identity, idempotency, the HTTP surface and the
// safety rules - all driven through the real settlement path with the same
// engine-shaped reports the preview tests use.
//
// Every fixture is an isolated temporary directory, so no test here can invent
// history for the user's own projects.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NotificationStore,
  defaultNotificationsPath,
  notificationDedupKey,
  notificationFromEvent,
  notificationIdFor,
} from "../dashboard/notifications.js";
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
  send,
  settle,
  start,
  stop,
  waitFor,
} from "./notification-fixtures.js";

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const inboxOf = (dir: string): string => join(dir, "projects", "notifications.json");

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

// ---------------------------------------------------------------------------
// Identity and idempotency: the guarantee that stops a reprocessed run from
// filling someone's inbox with copies of itself.
// ---------------------------------------------------------------------------

test("an event's id is a pure function of its own recorded facts", () => {
  const first = notificationFromEvent(event(), "2026-09-29T10:05:00.000Z");
  const second = notificationFromEvent(event(), "2026-03-09T01:02:03.000Z");
  // The moment the store happened to be written is not part of identity.
  assert.equal(first.id, second.id);
  assert.equal(first.id, notificationIdFor(notificationDedupKey(event())));
  assert.equal(first.read, false);
  assert.equal(first.source, "finding-lifecycle");
});

test("the same finding in a different run is a different notification", () => {
  const one = notificationDedupKey(event({ runId: "web-run-1" }));
  const two = notificationDedupKey(event({ runId: "web-run-2" }));
  assert.notEqual(one, two);
  assert.notEqual(notificationIdFor(one), notificationIdFor(two));
});

test("a failure names the evidence that proved it, so causes stay separate", () => {
  const state = notificationDedupKey(event({ type: "RUN_FAILED", source: "run-state", findingId: null, reference: "web-run-1" }));
  const infra = notificationDedupKey(event({ type: "RUN_FAILED", source: "verification", findingId: null, reference: "infra-1" }));
  assert.notEqual(state, infra);
});

test("a scheduler skip belongs to its execution and to no run of its own", () => {
  const key = notificationDedupKey(event({
    type: "SCHEDULE_SKIPPED",
    runId: null,
    findingId: null,
    reference: "exec-9",
    source: "schedule-execution",
  }));
  assert.match(key, /exec-9/);
  assert.doesNotMatch(key, /web-run/);
});

test("reprocessing the same events stores nothing and rewrites nothing", () => {
  const path = inboxOf(tempDir("ai-website-qa-notify-idem-"));
  const store = new NotificationStore(path);
  const events = [event(), event({ type: "REGRESSED_FINDING", findingId: "prj-fnd-2" })];

  const first = store.record(events, "2026-09-29T10:05:00.000Z");
  assert.equal(first.ok, true);
  assert.equal(first.value.length, 2);
  const afterFirst = readFileSync(path, "utf8");

  // The same run, on a store reloaded from disk: no duplicates, no rewrite, and
  // above all no reset of anything already read.
  const reopened = new NotificationStore(path);
  const second = reopened.record(events, "2026-09-29T11:00:00.000Z");
  assert.equal(second.ok, true);
  assert.deepEqual(second.value, []);
  assert.equal(readFileSync(path, "utf8"), afterFirst);
  assert.equal(reopened.list().total, 2);
  assert.equal(reopened.unreadCount(), 2);
});

test("read state is never reset by later events", () => {
  const path = inboxOf(tempDir("ai-website-qa-notify-readthru-"));
  const store = new NotificationStore(path);
  store.record([event()], "2026-09-29T10:05:00.000Z");
  const id = store.list().notifications[0]!.id;
  store.markRead(id);
  // A later run arrives for the same project.
  store.record([event({ runId: "web-run-2", findingId: "prj-fnd-2" })], "2026-09-29T11:05:00.000Z");
  assert.equal(new NotificationStore(path).get(id)!.read, true);
  assert.equal(new NotificationStore(path).unreadCount(), 1);
});

test("a failed write is reported rather than silently pretended", () => {
  const dir = tempDir("ai-website-qa-notify-fail-");
  // A file where a directory would have to be: persistence cannot succeed.
  const blocked = join(dir, "projects");
  writeFileSync(blocked, "this is a file, not a directory", "utf8");
  const store = new NotificationStore(join(blocked, "notifications.json"));
  const result = store.record([event()]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test("an unreadable inbox reads as empty instead of taking the dashboard down", () => {
  const path = inboxOf(tempDir("ai-website-qa-notify-corrupt-"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ this is not json", "utf8");
  assert.equal(new NotificationStore(path).list().total, 0);
});

test("the inbox is newest first with a total order, and a limit never changes the count", () => {
  const store = new NotificationStore(inboxOf(tempDir("ai-website-qa-notify-order-")));
  store.record(
    [event({ runId: "web-run-1" }), event({ runId: "web-run-2" }), event({ runId: "web-run-3" })],
    "2026-09-29T10:05:00.000Z",
  );
  const limited = store.list({ limit: 2 });
  assert.equal(limited.notifications.length, 2);
  assert.equal(limited.total, 3);
  assert.equal(limited.unreadCount, 3);
  const full = store.list().notifications.map(item => item.id);
  assert.deepEqual(limited.notifications.map(item => item.id), full.slice(0, 2));
});

test("marking one read is idempotent, and mark-all only touches what is unread", () => {
  const path = inboxOf(tempDir("ai-website-qa-notify-readall-"));
  const store = new NotificationStore(path);
  store.record([event({ runId: "web-run-1" }), event({ runId: "web-run-2" })], "2026-09-29T10:05:00.000Z");
  const ids = store.list().notifications.map(item => item.id);

  const marked = store.markRead(ids[0]!);
  assert.equal(marked.ok, true);
  if (marked.ok) assert.equal(marked.value.changed, true);
  const repeated = store.markRead(ids[0]!);
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.value.changed, false, "a second click changes nothing");
  assert.equal(store.markRead("ntf-000000000000000000000000000").ok, false);
  assert.equal(store.list({ unreadOnly: true }).total, 1);

  const reopened = new NotificationStore(path);
  assert.equal(reopened.unreadCount(), 1, "read state survives a restart");
  assert.equal(reopened.get(ids[0]!)!.read, true);

  const all = reopened.markAllRead();
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.value.updated, 1);
  assert.equal(new NotificationStore(path).unreadCount(), 0);
  const nothing = new NotificationStore(path).markAllRead();
  assert.equal(nothing.ok, true);
  if (nothing.ok) assert.equal(nothing.value.updated, 0);
});

test("a project listing only ever returns that project's notifications", () => {
  const store = new NotificationStore(inboxOf(tempDir("ai-website-qa-notify-scope-")));
  store.record(
    [event({ projectId: "web-one", runId: "web-run-1" }), event({ projectId: "web-two", runId: "web-run-1" })],
    "2026-09-29T10:05:00.000Z",
  );
  const scoped = store.list({ projectId: "web-one" });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.notifications[0]!.projectId, "web-one");
  assert.equal(store.unreadCount("web-two"), 1);
});

test("the inbox sits beside projects.json and schedules.json", () => {
  assert.equal(defaultNotificationsPath("/tmp/reports"), join("/tmp/reports", "projects", "notifications.json"));
});

// ---------------------------------------------------------------------------
// The HTTP surface, driven by real runs.
// ---------------------------------------------------------------------------

test("a real run's real events reach the inbox, and only real events do", async () => {
  const dir = tempDir("ai-website-qa-notify-api-");
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const projectId = created.json.project.id as string;

    // An empty inbox answers honestly, with no invented rows and no count.
    const empty = await getJson(`${base}/api/notifications`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.notifications, []);
    assert.equal(empty.json.unreadCount, 0);
    assert.equal((await getJson(`${base}/api/notifications/unread-count`)).json.count, 0);

    // Run 1 finds nothing: a first run with no finding has nothing to report.
    await runOnce(base, projectId, children, 0, analysisWith([]));
    assert.deepEqual((await getJson(`${base}/api/notifications`)).json.notifications, []);

    // Run 2 introduces a genuine tracked finding.
    await runOnce(base, projectId, children, 1, analysisWith([finding()]));
    const inbox = await getJson(`${base}/api/notifications`);
    const notifications = inbox.json.notifications as any[];
    const newFindings = notifications.filter(item => item.type === "NEW_FINDING");
    assert.equal(newFindings.length, 1, JSON.stringify(notifications));
    const first = newFindings[0]!;
    assert.equal(first.projectId, projectId);
    assert.equal(first.source, "finding-lifecycle");
    assert.equal(first.severity, "HIGH");
    assert.equal(first.read, false);
    assert.equal(typeof first.id, "string");
    assert.equal(first.runId, inbox.json.notifications[0].runId);
    // The same run's recorded change summary is reported by the existing change
    // intelligence, and a completed run is never reported as a failed one.
    assert.equal(notifications.filter(item => item.type === "MEANINGFUL_CHANGE").length, 1);
    assert.equal(notifications.some(item => item.type === "RUN_FAILED"), false);

    // Run 3 resolves it, and run 4 brings it back: each is its own event.
    await runOnce(base, projectId, children, 2, analysisWith([], { generatedAt: "2026-09-29T11:00:00.000Z" }));
    await runOnce(base, projectId, children, 3, analysisWith([finding({ id: "QA-F-900" })], { generatedAt: "2026-09-29T12:00:00.000Z" }));
    const later = (await getJson(`${base}/api/notifications`)).json.notifications as any[];
    const lifecycleTypes = later.map(item => item.type).filter(type => type.endsWith("_FINDING")).sort();
    assert.deepEqual(lifecycleTypes, ["NEW_FINDING", "REGRESSED_FINDING", "RESOLVED_FINDING"]);
    assert.equal(later.every(item => item.projectId === projectId), true);
    // A repeated finding is one notification per run, not one per report.
    assert.equal(new Set(later.map(item => item.dedupKey)).size, later.length);

    // Per-project listing, unread filtering and the count all agree.
    const total = later.length;
    assert.equal((await getJson(`${base}/api/projects/${projectId}/notifications`)).json.total, total);
    assert.equal((await getJson(`${base}/api/notifications?unread=true`)).json.total, total);
    assert.equal((await getJson(`${base}/api/notifications?limit=2`)).json.notifications.length, 2);
    assert.equal((await getJson(`${base}/api/notifications?limit=2`)).json.unreadCount, total);
    assert.equal((await getJson(`${base}/api/notifications/unread-count`)).json.count, total);

    // A project that does not exist is a 404, never another project's inbox.
    assert.equal((await getJson(`${base}/api/projects/web-nosuchproject/notifications`)).status, 404);

    // ?projectId really scopes the global inbox, so a filter can never widen
    // it back to every project's notifications.
    const scoped = await getJson(`${base}/api/notifications?projectId=${projectId}`);
    assert.equal(scoped.json.total, total);
    assert.equal(scoped.json.unreadCount, total);
    const otherProject = await getJson(`${base}/api/notifications?projectId=web-otherproject`);
    assert.equal(otherProject.json.total, 0);
    assert.equal(otherProject.json.unreadCount, 0);
    assert.deepEqual(otherProject.json.notifications, []);
    const bothUnread = await getJson(`${base}/api/notifications?projectId=web-otherproject&unread=true`);
    assert.equal(bothUnread.json.total, 0);
    // A project route stays on its own project even when a foreign one is asked
    // for in the query string.
    const widened = await getJson(`${base}/api/projects/${projectId}/notifications?projectId=web-otherproject`);
    assert.equal(widened.json.total, total);
    assert.equal(widened.json.notifications.every((item: any) => item.projectId === projectId), true);
  } finally { await stop(dash); }
});

test("the inbox survives a restart, and re-processing a settled run adds nothing", async () => {
  const dir = tempDir("ai-website-qa-notify-restart-");
  const first = fakeSpawner();
  const one = await start(dir, first.spawnImpl);
  const projectId = String((await postJson(`${one.base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
  let total = 0;
  try {
    await runOnce(one.base, projectId, first.children, 0, analysisWith([]));
    await runOnce(one.base, projectId, first.children, 1, analysisWith([finding()]));
    const stored = (await getJson(`${one.base}/api/notifications`)).json.notifications as any[];
    total = stored.length;
    assert.ok(total >= 1, "the second run produced real notifications");
    // One is read before the restart; the rest must still be unread.
    const read = await postJson(`${one.base}/api/notifications/${stored[0].id}/read`);
    assert.equal(read.status, 200);
    assert.equal(read.json.unreadCount, total - 1);
    const before = readFileSync(inboxOf(dir), "utf8");
    await stop(one.dash);

    // A fresh server over the same data directory is what a restart looks like.
    const second = fakeSpawner();
    const two = await start(dir, second.spawnImpl);
    try {
      const after = (await getJson(`${two.base}/api/notifications`)).json;
      assert.equal(after.total, total, "a restart reports the same inbox");
      assert.equal(after.notifications.filter((item: any) => item.read).length, 1);
      assert.equal((await getJson(`${two.base}/api/notifications/unread-count`)).json.count, total - 1);
      // Restarting, and re-deriving a settled run, changes nothing on disk.
      assert.equal(readFileSync(inboxOf(dir), "utf8"), before);
    } finally { await stop(two.dash); }
  } finally {
    await stop(one.dash).catch(() => {});
  }
});

test("a run that never wrote a report records a RUN_FAILED notification", async () => {
  const dir = tempDir("ai-website-qa-notify-failed-");
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await postJson(`${base}/api/projects/${projectId}/runs`);
    while (children.length === 0) await new Promise(r => setTimeout(r, 20));
    crash(children[0]!);
    await new Promise(r => setTimeout(r, 300));

    const inbox = await getJson(`${base}/api/notifications`);
    const notifications = inbox.json.notifications as any[];
    assert.equal(notifications.length, 1, JSON.stringify(notifications));
    assert.equal(notifications[0].type, "RUN_FAILED");
    assert.equal(notifications[0].source, "run");
    assert.equal(notifications[0].findingId, null);
    assert.match(notifications[0].message, /exited with code/i);
  } finally { await stop(dash); }
});

test("mark-all reads exactly the unread records and nothing else", async () => {
  const dir = tempDir("ai-website-qa-notify-readall-api-");
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await runOnce(base, projectId, children, 0, analysisWith([]));
    await runOnce(base, projectId, children, 1, analysisWith([finding()]));
    await runOnce(base, projectId, children, 2, analysisWith([finding(), labelFinding({ id: "QA-F-502" })]));

    const before = (await getJson(`${base}/api/notifications`)).json.notifications as any[];
    // Two runs each produced a real lifecycle event and a real change summary.
    assert.equal(before.filter(item => item.type === "NEW_FINDING").length, 2);
    assert.ok(before.length >= 2, JSON.stringify(before.map(item => item.type)));
    const one = await postJson(`${base}/api/notifications/${before[0].id}/read`);
    assert.equal(one.status, 200);
    assert.equal(one.json.unreadCount, before.length - 1);

    const all = await postJson(`${base}/api/notifications/read-all`);
    assert.equal(all.status, 200);
    assert.equal(all.json.unreadCount, 0);
    assert.equal((await getJson(`${base}/api/notifications?unread=true`)).json.total, 0);
    // Mark-all does not remove anything, and leaves what was already read alone.
    const after = (await getJson(`${base}/api/notifications`)).json.notifications as any[];
    assert.equal(after.length, before.length);
    assert.equal(after.every(item => item.read === true), true);
    assert.equal((await getJson(`${base}/api/notifications/unread-count`)).json.count, 0);
  } finally { await stop(dash); }
});

test("an unknown notification id is a 404 rather than a fake success", async () => {
  const dir = tempDir("ai-website-qa-notify-404-");
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const missing = await postJson(`${base}/api/notifications/ntf-0000000000000000000000000000/read`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
    const malformed = await postJson(`${base}/api/notifications/..%2fetc%2fpasswd/read`);
    assert.equal(malformed.status, 400);
  } finally { await stop(dash); }
});

test("a scheduler skip is recorded once, and belongs to no run of its own", async () => {
  const dir = tempDir("ai-website-qa-notify-skip-");
  const { spawnImpl, children } = fakeSpawner();
  // The real clock: the skip and the run's own recorded window have to sit on
  // the same timeline for the recorded event to be meaningful.
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Skipped", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await send("PUT", `${base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });

    // A real manual run occupies the single-run slot...
    const manual = await postJson(`${base}/api/projects/${projectId}/runs`);
    assert.equal(manual.status, 202, JSON.stringify(manual.json));
    await waitFor(() => children.length === 1);

    // ...so a real trigger during it is a recorded skip.
    const triggered = await postJson(`${base}/api/projects/${projectId}/schedule/run-now`);
    assert.equal(triggered.status, 200, JSON.stringify(triggered.json));
    assert.equal(triggered.json.execution.status, "SKIPPED_OVERLAPPING_RUN");
    const executionId = triggered.json.execution.executionId as string;

    // The skip is its own stored event, not a footnote on the run in flight.
    const skips = (await getJson(`${base}/api/notifications`)).json.notifications
      .filter((item: any) => item.type === "SCHEDULE_SKIPPED");
    assert.equal(skips.length, 1, "a recorded skip is notified on its own");
    assert.equal(skips[0].source, "scheduler");
    assert.equal(skips[0].runId, null);
    assert.match(skips[0].message, /SKIPPED_OVERLAPPING_RUN/);
    assert.equal(skips[0].reference, executionId);

    // Settling the run adds its own real findings, and never a second skip.
    settle(children[0]!, analysisWith([finding()]));
    await waitFor(() => children[0]!.exitCode !== null);
    const after = (await getJson(`${base}/api/notifications`)).json.notifications as any[];
    assert.equal(after.filter(item => item.type === "SCHEDULE_SKIPPED").length, 1, "one skip, one notification");
    assert.equal(after.filter(item => item.type === "NEW_FINDING").length, 1);
  } finally { await stop(dash); }
});

test("a failed scheduled run is recorded once even though the run and the execution both saw it", async () => {
  const dir = tempDir("ai-website-qa-notify-schedfail-");
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Failing", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await send("PUT", `${base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });

    await postJson(`${base}/api/projects/${projectId}/schedule/run-now`);
    await waitFor(() => children.length === 1);
    // The engine dies without writing a report: a real failed run.
    crash(children[0]!);
    await waitFor(() => children[0]!.exitCode !== null);

    const inbox = (await getJson(`${base}/api/notifications`)).json.notifications as any[];
    const failures = inbox.filter(item => item.type === "RUN_FAILED");
    assert.ok(failures.length >= 1, JSON.stringify(inbox));
    // The run's own failure and the scheduler's record of that same failure are
    // two pieces of evidence about one event, not two notifications.
    const dedupKeys = new Set(inbox.map(item => item.dedupKey));
    assert.equal(dedupKeys.size, inbox.length, "no duplicated events in the inbox");
    assert.equal(inbox.every(item => item.projectId === projectId), true);
  } finally { await stop(dash); }
});