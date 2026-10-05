import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  localTimeToInstant,
  nextRunAtFor,
  ScheduleStore,
  SCHEDULE_FREQUENCIES,
  isValidTimeZone,
} from "../dashboard/project-schedules.js";
import { Scheduler } from "../dashboard/scheduler.js";
import { startDashboard } from "../dashboard/server.js";

const SITE = "https://example.com";
const localStamp = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ms));

const tempStore = (nowMs = Date.UTC(2026, 0, 5, 10, 0, 0)) => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-sched-"));
  const store = new ScheduleStore(join(dir, "projects", "schedules.json"), { now: () => nowMs });
  return { dir, store, file: store.filePath };
};

// ---------------------------------------------------------------------------
// Timezone resolution
// ---------------------------------------------------------------------------

test("only real IANA timezones are accepted", () => {
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
  assert.equal(isValidTimeZone("Europe/Nowhere"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(42), false);
  // A prototype name must never be mistaken for a zone.
  assert.equal(isValidTimeZone("constructor"), false);
  assert.equal(isValidTimeZone("toString"), false);
});

test("a normal local time resolves to the expected instant in its zone", () => {
  assert.equal(localTimeToInstant(2026, 6, 10, 9, 0, "UTC"), Date.UTC(2026, 5, 10, 9, 0));
  assert.equal(localTimeToInstant(2026, 6, 10, 9, 0, "Europe/Berlin"), Date.UTC(2026, 5, 10, 7, 0));
  assert.equal(localTimeToInstant(2026, 6, 10, 9, 0, "America/New_York"), Date.UTC(2026, 5, 10, 13, 0));
  // Half-hour and 45-minute offsets are not rounded away.
  assert.equal(localTimeToInstant(2026, 6, 10, 9, 0, "Asia/Kolkata"), Date.UTC(2026, 5, 10, 3, 30));
  assert.equal(localTimeToInstant(2026, 6, 10, 9, 0, "Asia/Kathmandu"), Date.UTC(2026, 5, 10, 3, 15));
});

test("a nonexistent local time resolves to the instant the DST gap closes", () => {
  // 02:30 does not exist on these dates: the clock jumps 02:00 -> 03:00.
  const berlin = localTimeToInstant(2026, 3, 29, 2, 30, "Europe/Berlin");
  assert.equal(localStamp(berlin, "Europe/Berlin"), "29/03/2026, 03:00");
  const newYork = localTimeToInstant(2026, 3, 8, 2, 30, "America/New_York");
  assert.equal(localStamp(newYork, "America/New_York"), "08/03/2026, 03:00");
});

test("an ambiguous local time resolves to the earlier occurrence", () => {
  // 02:30 happens twice on this date: the clock goes 03:00 -> 02:00.
  const berlin = localTimeToInstant(2026, 10, 25, 2, 30, "Europe/Berlin");
  assert.equal(localStamp(berlin, "Europe/Berlin"), "25/10/2026, 02:30");
  assert.equal(berlin, Date.UTC(2026, 9, 25, 0, 30));
  const newYork = localTimeToInstant(2026, 11, 1, 1, 30, "America/New_York");
  assert.equal(localStamp(newYork, "America/New_York"), "01/11/2026, 01:30");
});

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

test("interval frequencies step by exact elapsed time and ignore DST", () => {
  const cases: [typeof SCHEDULE_FREQUENCIES[number], number][] = [
    ["EVERY_15_MINUTES", 15 * 60_000],
    ["HOURLY", 3_600_000],
    ["EVERY_6_HOURS", 6 * 3_600_000],
  ];
  const across = Date.UTC(2026, 2, 29, 0, 30);
  for (const [frequency, ms] of cases) {
    assert.equal(nextRunAtFor(frequency, "Europe/Berlin", 0, 0, across), across + ms, frequency);
  }
});

test("a daily schedule keeps its local wall-clock time across a DST change", () => {
  // Start the evening before Europe/Berlin springs forward.
  let at = Date.UTC(2026, 2, 27, 22, 0);
  const seen: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    at = nextRunAtFor("DAILY", "Europe/Berlin", 9 * 60, 0, at)!;
    seen.push(localStamp(at, "Europe/Berlin"));
  }
  // 09:00 local on every day, before and after the transition.
  for (const stamp of seen) assert.match(stamp, /, 09:00$/);
  // The UTC instant moves by an hour across the boundary, which is exactly why
  // the local time is anchored instead of the UTC time.
  assert.equal(Date.UTC(2026, 2, 28, 8, 0), nextRunAtFor("DAILY", "Europe/Berlin", 9 * 60, 0, Date.UTC(2026, 2, 27, 22, 0))!);
  assert.equal(Date.UTC(2026, 2, 29, 7, 0), nextRunAtFor("DAILY", "Europe/Berlin", 9 * 60, 0, Date.UTC(2026, 2, 28, 8, 0))!);
});

test("a weekly schedule lands on its anchored weekday", () => {
  // Wednesday anchored, stepping forward from Wednesday itself.
  const from = Date.UTC(2026, 5, 10, 12, 0);
  assert.equal(localStamp(nextRunAtFor("WEEKLY", "Europe/Berlin", 9 * 60, 3, from)!, "Europe/Berlin"), "17/06/2026, 09:00");
  // A Sunday schedule from the same Wednesday resolves forward to the next Sunday.
  assert.equal(localStamp(nextRunAtFor("WEEKLY", "Europe/Berlin", 9 * 60, 0, from)!, "Europe/Berlin"), "14/06/2026, 09:00");
  // A Friday schedule wraps around the week boundary rather than going back.
  assert.equal(localStamp(nextRunAtFor("WEEKLY", "Europe/Berlin", 9 * 60, 5, from)!, "Europe/Berlin"), "12/06/2026, 09:00");
});

test("every computed next run is strictly in the future", () => {
  const at = Date.UTC(2026, 5, 10, 12, 34, 56);
  for (const frequency of SCHEDULE_FREQUENCIES) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const next = nextRunAtFor(frequency, "Pacific/Auckland", 9 * 60, weekday, at);
      assert.ok(next !== null, `${frequency} produced no next run`);
      assert.ok(next! > at, `${frequency} produced a past run`);
    }
  }
});

test("an unsupported frequency produces no run at all", () => {
  assert.equal(nextRunAtFor("MINUTELY" as never, "UTC", 0, 0, Date.now()), null);
});

// ---------------------------------------------------------------------------
// Store: validation, CRUD, persistence
// ---------------------------------------------------------------------------

test("an invalid frequency is rejected with the allowed values", () => {
  const { store } = tempStore();
  const result = store.upsert("prj-1", { frequency: "MINUTELY" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  if (!result.ok) for (const value of SCHEDULE_FREQUENCIES) assert.match(result.error, new RegExp(value));
  assert.deepEqual(store.list(), []);
});

test("an invalid timezone is rejected", () => {
  const { store } = tempStore();
  const result = store.upsert("prj-1", { frequency: "DAILY", timezone: "Mars/Olympus" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.deepEqual(store.list(), []);
});

test("a non-boolean enabled value is rejected rather than silently coerced", () => {
  const { store } = tempStore();
  const result = store.upsert("prj-1", { enabled: "yes" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("upsert creates one schedule per project and edits in place", () => {
  const { store } = tempStore();
  const first = store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = store.upsert("prj-1", { frequency: "DAILY", timezone: "Europe/Berlin" });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.id, first.value.id, "the schedule id must be stable across edits");
  assert.equal(second.value.version, first.value.version + 1);
  assert.equal(store.list().length, 1);
});

test("an edit keeps the local anchor when frequency and zone are unchanged", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  const created = store.upsert("prj-1", { frequency: "DAILY", timezone: "UTC" });
  if (!created.ok) return assert.fail("create failed");
  // Later that day, with only the enabled flag changing: 09:00 local must stay.
  const edited = store.upsert("prj-1", { enabled: true, frequency: "DAILY", timezone: "UTC" }, nowMs + 6 * 3_600_000);
  if (!edited.ok) return assert.fail("edit failed");
  assert.equal(edited.value.anchorLocalMinutes, created.value.anchorLocalMinutes);
});

test("a disabled schedule has no next run and is never due", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  const result = store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC", enabled: false });
  if (!result.ok) return assert.fail("create failed");
  assert.equal(result.value.nextRunAt, null);
  assert.deepEqual(store.dueSchedules(nowMs + 10 * 24 * 3_600_000), []);
});

test("disabling and re-enabling preserves execution history", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 15 * 60_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  store.markSettled(claimed.value.executionId, { ok: true, runId: "web-real-1", qaStatus: "PASS" }, nowMs + 16 * 60_000);

  store.setEnabled("prj-1", false, nowMs + 20 * 60_000);
  assert.equal(store.list().length, 1, "disabling must not delete the schedule");
  store.setEnabled("prj-1", true, nowMs + 30 * 60_000);
  const history = store.executionsFor("prj-1");
  assert.equal(history.length, 1);
  assert.equal(history[0]!.status, "COMPLETED");
  assert.equal(history[0]!.runId, "web-real-1");
});

test("history survives a frequency and timezone edit", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 15 * 60_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  store.upsert("prj-1", { frequency: "WEEKLY", timezone: "Asia/Tokyo" }, nowMs + 20 * 60_000);
  assert.equal(store.executionsFor("prj-1").length, 1);
});

test("schedules and history survive a reload from disk", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store, file } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "Europe/Berlin" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  if (!claimed.ok) return assert.fail("claim failed");

  const reloaded = new ScheduleStore(file, { now: () => nowMs });
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get("prj-1")!.frequency, "HOURLY");
  assert.equal(reloaded.get("prj-1")!.timezone, "Europe/Berlin");
  assert.equal(reloaded.executionsFor("prj-1").length, 1);
  assert.equal(reloaded.executionsFor("prj-1")[0]!.executionId, claimed.value.executionId);
});

test("malformed records are dropped without taking the valid ones down", () => {
  const { dir, store } = tempStore();
  store.upsert("prj-keep", { frequency: "DAILY", timezone: "UTC" });
  const file = store.filePath;
  const raw = JSON.parse(readFileSync(file, "utf8")) as any;
  raw.schedules.push({ id: "sch-bad", projectId: "prj-bad", enabled: "yes", frequency: "NOPE", timezone: "Bad/Zone" });
  raw.schedules.push({ id: "sch-bad2", projectId: "prj-bad2", enabled: true, frequency: "DAILY", timezone: "UTC", nextRunAt: "not-a-date" });
  raw.executions.push({ executionId: "exe-bad", scheduleId: "sch-bad", projectId: "prj-bad", scheduledFor: "nope", status: "MADE_UP", version: 0 });
  writeFileSync(file, JSON.stringify(raw), "utf8");
  void dir;

  const reloaded = new ScheduleStore(file);
  assert.deepEqual(reloaded.list().map(s => s.projectId), ["prj-keep"]);
  assert.deepEqual(reloaded.executionsFor("prj-keep"), []);
});

test("a completely corrupt document loads as empty rather than throwing", () => {
  const { store, file } = tempStore();
  store.upsert("prj-1", { frequency: "DAILY", timezone: "UTC" });
  writeFileSync(file, "{not json at all", "utf8");
  const reloaded = new ScheduleStore(file);
  assert.deepEqual(reloaded.list(), []);
  // The corrupt document is replaced by a valid empty one on the next write,
  // so the store never stays permanently broken.
  reloaded.upsert("prj-2", { frequency: "DAILY", timezone: "UTC" });
  assert.deepEqual(new ScheduleStore(file).list().map(s => s.projectId), ["prj-2"]);
});

test("removing a schedule keeps its execution records", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  const id = store.get("prj-1")!.id;
  store.claimDue(id, { nowMs: nowMs + 15 * 60_000 });
  const removed = store.remove(id);
  if (!removed.ok) return assert.fail("remove failed");
  assert.equal(removed.value.keptExecutions, 1);
  assert.deepEqual(store.list(), []);
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

test("a slot can only be claimed once, and the schedule advances immediately", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  const dueAt = store.get("prj-1")!.nextRunAt!;
  const first = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  assert.equal(first.ok, true);
  // The second claim for the same slot is refused.
  const second = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.status, 409);
  // The claim is durable, so a fresh process also refuses it.
  const reloaded = new ScheduleStore(store.filePath, { now: () => nowMs });
  const third = reloaded.claimDue(reloaded.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  assert.equal(third.ok, false, "a claimed slot must not be claimable after a restart");
  assert.ok(store.get("prj-1")!.nextRunAt! > dueAt);
});

test("claiming a slot that is not due is refused", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  // One millisecond after creation the hourly slot is still an hour away.
  const early = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 1 });
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.status, 409);
});

test("an overlap skip advances the schedule so it is not skipped forever", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  const before = store.get("prj-1")!.nextRunAt!;
  const recorded = store.recordSkippedOverlap("prj-1", before, "a run was already in progress", nowMs + 15 * 60_000);
  assert.equal(recorded.ok, true);
  assert.equal(store.get("prj-1")!.nextRunAt! > before, true);
  // The slot is no longer due, so the next tick dispatches instead of skipping.
  assert.deepEqual(store.dueSchedules(nowMs + 15 * 60_000), []);
});

test("a completion without a real run id is recorded as a failure", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  const settled = store.markSettled(claimed.value.executionId, { ok: true, runId: null, qaStatus: "PASS" }, nowMs + 3_700_000);
  if (!settled.ok) return assert.fail("settle failed");
  assert.equal(settled.value.status, "FAILED");
});

test("a missing project skip advances the schedule and records the reason", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-gone", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  const before = store.get("prj-gone")!.nextRunAt!;
  const recorded = store.recordMissingProject("prj-gone", before, "The project no longer exists.", nowMs + 15 * 60_000);
  if (!recorded.ok) return assert.fail("record failed");
  assert.equal(recorded.value.status, "SKIPPED_PROJECT_MISSING");
  assert.equal(store.get("prj-gone")!.nextRunAt! > before, true);
});

test("a real failure raises the consecutive failure count and success resets it", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  const id = store.get("prj-1")!.id;

  const first = store.claimDue(id, { nowMs: nowMs + 15 * 60_000 });
  if (first.ok) store.markSettled(first.value.executionId, { ok: false, runId: "web-x", qaStatus: "FAIL" }, nowMs + 16 * 60_000);
  assert.equal(store.get("prj-1")!.consecutiveFailures, 1);

  const second = store.claimDue(id, { nowMs: nowMs + 30 * 60_000 });
  if (second.ok) store.markSettled(second.value.executionId, { ok: true, runId: "web-y", qaStatus: "PASS" }, nowMs + 31 * 60_000);
  assert.equal(store.get("prj-1")!.consecutiveFailures, 0);
  assert.equal(store.get("prj-1")!.lastRunId, "web-y");
});

test("a skip is not counted as a project failure", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  store.recordSkippedOverlap("prj-1", store.get("prj-1")!.nextRunAt!, "busy", nowMs + 15 * 60_000);
  assert.equal(store.get("prj-1")!.consecutiveFailures, 0);
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

test("recovery completes an execution only when the artifact proves it", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  store.markRunning(claimed.value.executionId, "web-proven", nowMs + 3_601_000);

  const proved = new ScheduleStore(store.filePath, { now: () => nowMs + 4 * 3_600_000 });
  const result = proved.recover(() => ({ completed: true, qaStatus: "PASS" }), nowMs + 4 * 3_600_000);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.interrupted.length, 0);
  assert.equal(proved.executionsFor("prj-1")[0]!.status, "COMPLETED");
});

test("recovery records an unprovable execution as INTERRUPTED and never reruns it", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  store.markRunning(claimed.value.executionId, "web-unknown", nowMs + 3_601_000);

  const restarted = new ScheduleStore(store.filePath, { now: () => nowMs + 4 * 3_600_000 });
  const result = restarted.recover(() => ({ completed: false }), nowMs + 4 * 3_600_000);
  assert.equal(result.interrupted.length, 1);
  assert.equal(result.reconciled.length, 0);
  const execution = restarted.executionsFor("prj-1")[0]!;
  assert.equal(execution.status, "INTERRUPTED");
  assert.ok(execution.detail && execution.detail.length > 0);
  // The uncertain execution is settled, not pending: recovery leaves exactly one
  // record for it and never replays it, so it cannot be mistaken for queued work.
  assert.equal(restarted.executionsFor("prj-1").length, 1);
  // A later tick claims the NEXT slot only, which is a new record, never a
  // re-dispatch of the interrupted one.
  const nextSlot = restarted.claimDue(restarted.get("prj-1")!.id, { nowMs: nowMs + 4 * 3_600_000 });
  assert.equal(nextSlot.ok, true);
  if (nextSlot.ok) assert.notEqual(nextSlot.value.executionId, execution.executionId);
  const history = restarted.executionsFor("prj-1");
  assert.equal(history.length, 2);
  assert.equal(history.filter(e => e.status === "INTERRUPTED").length, 1);
});

test("recovery ignores executions that were already settled", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  store.markSettled(claimed.value.executionId, { ok: true, runId: "web-done", qaStatus: "PASS" }, nowMs + 3_602_000);

  const restarted = new ScheduleStore(store.filePath, { now: () => nowMs });
  const result = restarted.recover(() => ({ completed: false }), nowMs);
  assert.equal(result.reconciled.length, 0);
  assert.equal(result.interrupted.length, 0);
  assert.equal(restarted.executionsFor("prj-1")[0]!.status, "COMPLETED");
});

test("a throwing proof function cannot fabricate a completion", () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0);
  const { store } = tempStore(nowMs);
  store.upsert("prj-1", { frequency: "HOURLY", timezone: "UTC" });
  const claimed = store.claimDue(store.get("prj-1")!.id, { nowMs: nowMs + 3_600_000 });
  if (!claimed.ok) return assert.fail("claim failed");
  store.markRunning(claimed.value.executionId, "web-throw", nowMs + 3_601_000);
  const result = store.recover(() => { throw new Error("artifact unreadable"); }, nowMs + 4 * 3_600_000);
  assert.equal(result.interrupted.length, 1);
  assert.equal(store.executionsFor("prj-1")[0]!.status, "INTERRUPTED");
});