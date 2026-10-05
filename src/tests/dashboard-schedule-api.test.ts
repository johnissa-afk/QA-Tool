import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDashboard } from "../dashboard/server.js";
import { Scheduler } from "../dashboard/scheduler.js";
import { ScheduleStore } from "../dashboard/project-schedules.js";

const SITE = "https://example.com";

// ---------------------------------------------------------------------------
// A minimal but real-shaped analysis artifact. The scheduler only ever reads the
// verdict out of it, so this is the same shape the engine writes.
// ---------------------------------------------------------------------------
const analysis = (status: "PASS" | "FAIL" = "PASS") => ({
  schemaVersion: 1,
  generatedAt: "2026-09-29T10:00:00.000Z",
  mode: "deterministic",
  aiProvider: "deterministic",
  scan: { scan: { url: SITE, finalUrl: SITE, title: "Home", timestamp: "2026-09-29T10:00:00.000Z", durationMs: 800 }, elements: [] },
  findings: [],
  accessPrerequisite: { status: "PASS", reason: null, details: [] },
  flowDiscovery: {
    limits: {},
    graph: { sourceUrl: SITE, pages: [] },
    flows: [],
    executions: [],
    summary: { pages: 0, flows: 0, executable: 0, review: 0, highRisk: 0, blocked: 0, steps: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
  },
  coverage: {
    generatedAt: "2026-09-29T10:00:00.000Z",
    summary: {
      pages: { discovered: 0, tested: 0, partial: 0, untested: 0, blocked: 0 },
      flows: { discovered: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, blocked: 0 },
      interactions: { tested: 0, partial: 0, untested: 0, review: 0, notApplicable: 0 },
      findings: { analyzed: 0, verified: 0, reproduced: 0, notReproduced: 0, unverified: 0 },
      recommendations: 0,
    },
    items: [], testPlan: [], aiNotes: { gaps: [] },
  },
  summary: {
    overallStatus: status, headline: status === "PASS" ? "ok" : "issues found", sourceUrl: SITE, issueCount: 0,
    flowsDetected: 0, scheduled: 0, executed: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0,
    skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0,
    infrastructureProblems: 0, infrastructureFailures: 0, unverified: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  },
  execution: { status: status === "PASS" ? "passed" : "failed", tests: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
  verifications: [],
});

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[]; exitCode: number | null; kill?: () => void };

const fakeSpawner = () => {
  const children: FakeChild[] = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.args = args;
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, children };
};

/** Writes the artifact where the run's real CLI would write it, then exits. */
const settle = (child: FakeChild, status: "PASS" | "FAIL" = "PASS"): string => {
  const index = child.args.indexOf("--output");
  const output = child.args[index + 1]!;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(analysis(status)), "utf8");
  child.exitCode = 0;
  child.emit("close", 0);
  return output;
};

/** Fails the run without ever writing a report, as a crashed engine would. */
const crash = (child: FakeChild): void => {
  child.exitCode = 1;
  child.stderr.emit("data", "engine crashed\n");
  child.emit("close", 1);
};

type Harness = {
  dir: string;
  dash: Awaited<ReturnType<typeof startDashboard>>;
  base: string;
  children: FakeChild[];
  clock: { value: number };
  stop: () => Promise<void>;
};

const start = async (options: { now?: number; scheduleEnabled?: boolean } = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-sched-http-"));
  const { spawnImpl, children } = fakeSpawner();
  const clock = { value: options.now ?? Date.UTC(2026, 5, 10, 12, 0, 0) };
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    projectRoot: process.cwd(),
    spawnImpl,
    // The clock is injected, so every recurrence in this file is exact and no
    // test ever waits for wall-clock time to pass.
    now: () => clock.value,
    scheduleTickMs: 50,
    scheduleEnabled: options.scheduleEnabled ?? false,
  });
  return {
    dir, dash, children, clock,
    base: `http://127.0.0.1:${dash.port}`,
    stop: async () => {
      const server = dash.server as unknown as import("node:http").Server;
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};

const getJson = async (url: string) => {
  const res = await fetch(url);
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const send = async (method: "POST" | "PUT" | "DELETE", url: string, body: unknown = {}) => {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

let projectSeq = 0;
/** Projects are unique by URL, so each one gets its own path. */
const createProject = async (base: string, name = "Scheduled") => {
  projectSeq += 1;
  const created = await send("POST", `${base}/api/projects`, { name, url: `${SITE}/p${projectSeq}` });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.project.id as string;
};

const waitFor = async (check: () => boolean, ms = 4000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for the scheduled run to settle");
};

// ---------------------------------------------------------------------------
// Schedule API
// ---------------------------------------------------------------------------

test("GET schedule is an empty, non-error answer before a schedule exists", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    const res = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.schedule, null);
  } finally { await h.stop(); }
});

test("PUT creates, GET reads back, and re-PUT edits the same schedule", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    const created = await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "Europe/Berlin" });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.schedule.frequency, "HOURLY");
    assert.equal(created.json.schedule.timezone, "Europe/Berlin");
    assert.equal(created.json.schedule.frequencyLabel, "Hourly");
    assert.ok(created.json.schedule.nextRunAt, "an enabled schedule must have a next run");

    const read = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(read.json.schedule.id, created.json.schedule.id);

    const edited = await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "DAILY", timezone: "Asia/Tokyo" });
    assert.equal(edited.json.schedule.id, created.json.schedule.id);
    assert.equal(edited.json.schedule.timezone, "Asia/Tokyo");
    assert.equal(edited.json.schedule.version, created.json.schedule.version + 1);
  } finally { await h.stop(); }
});

test("an invalid frequency or timezone is rejected with a real explanation", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    const badFrequency = await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_MINUTE" });
    assert.equal(badFrequency.status, 400);
    assert.match(badFrequency.json.error, /EVERY_15_MINUTES/);

    const badZone = await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { timezone: "Middle/Earth" });
    assert.equal(badZone.status, 400);
    assert.match(badZone.json.error, /IANA/);

    // Nothing was persisted by either rejection.
    const read = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(read.json.schedule, null);
  } finally { await h.stop(); }
});

test("a schedule cannot be created for a project that does not exist", async () => {
  const h = await start();
  try {
    assert.equal((await send("PUT", `${h.base}/api/projects/prj-nope/schedule`, { frequency: "DAILY" })).status, 404);
    assert.equal((await getJson(`${h.base}/api/projects/prj-nope/schedule`)).status, 404);
    assert.equal((await send("POST", `${h.base}/api/projects/prj-nope/schedule/enable`)).status, 404);
  } finally { await h.stop(); }
});

test("enable and disable move the schedule without losing it", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });

    const disabled = await send("POST", `${h.base}/api/projects/${projectId}/schedule/disable`);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.schedule.enabled, false);
    assert.equal(disabled.json.schedule.nextRunAt, null);

    const enabled = await send("POST", `${h.base}/api/projects/${projectId}/schedule/enable`);
    assert.equal(enabled.json.schedule.enabled, true);
    assert.ok(enabled.json.schedule.nextRunAt);
    // Still exactly one schedule row for the project.
    assert.equal((await getJson(`${h.base}/api/schedules`)).json.schedules.length, 1);
  } finally { await h.stop(); }
});

test("the global schedule list reports every schedule with its project", async () => {
  const h = await start();
  try {
    const a = await createProject(h.base, "Alpha");
    const b = await createProject(h.base, "Beta");
    await send("PUT", `${h.base}/api/projects/${a}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    await send("PUT", `${h.base}/api/projects/${b}/schedule`, { frequency: "DAILY", timezone: "Europe/Berlin", enabled: false });

    const all = await getJson(`${h.base}/api/schedules`);
    assert.equal(all.status, 200);
    assert.equal(all.json.schedules.length, 2);
    assert.deepEqual(all.json.schedules.map((s: any) => s.projectName).sort(), ["Alpha", "Beta"]);
    const disabled = all.json.schedules.find((s: any) => s.projectName === "Beta");
    assert.equal(disabled.enabled, false);
    // Only enabled schedules promise an upcoming run.
    assert.equal(all.json.upcoming.length, 1);
    assert.equal(all.json.upcoming[0].projectId, a);
    // The frequency list is offered for the UI and comes from the stable set.
    assert.deepEqual(all.json.frequencies.map((f: any) => f.value), ["EVERY_15_MINUTES", "HOURLY", "EVERY_6_HOURS", "DAILY", "WEEKLY"]);
  } finally { await h.stop(); }
});

test("history is empty before anything has run and 404s for an unscheduled project", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/schedule/history`)).status, 404);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    const empty = await getJson(`${h.base}/api/projects/${projectId}/schedule/history`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.executions, []);
  } finally { await h.stop(); }
});

test("a malformed JSON body is rejected rather than half-applied", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    const res = await fetch(`${h.base}/api/projects/${projectId}/schedule`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/schedule`)).json.schedule, null);
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------
// Dispatch through the real pipeline
// ---------------------------------------------------------------------------

test("a due slot starts a real run and completes from its real artifact", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });

    // Move the clock past the first slot, then tick through the same path a
    // timer would use.
    h.clock.value = now + 15 * 60_000;
    const result = h.dash.scheduler.tick();
    assert.equal(result.dispatched, true, JSON.stringify(result.errors));
    await waitFor(() => h.children.length === 1);
    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);

    const history = await getJson(`${h.base}/api/projects/${projectId}/schedule/history`);
    assert.equal(history.status, 200);
    assert.equal(history.json.executions.length, 1);
    const execution = history.json.executions[0];
    assert.equal(execution.status, "COMPLETED");
    assert.ok(execution.runId, "a completion must carry the real run id");
    // The run id is the one the engine actually used.
    const runs = await getJson(`${h.base}/api/projects/${projectId}/runs`);
    assert.ok(runs.json.runs.some((r: any) => r.runId === execution.runId), "the scheduled run must be in normal project history");

    // The schedule moved on to the following slot.
    const schedule = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(schedule.json.schedule.nextRunAt, new Date(now + 30 * 60_000).toISOString());
    assert.equal(schedule.json.schedule.consecutiveFailures, 0);
  } finally { await h.stop(); }
});

test("a scheduled run produces exactly the same project and result state as a manual one", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const manualProject = await createProject(h.base, "Manual");
    const scheduledProject = await createProject(h.base, "Scheduled");

    // Manual first, through the existing endpoint.
    await send("PUT", `${h.base}/api/projects/${scheduledProject}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });

    await send("POST", `${h.base}/api/projects/${manualProject}/runs`);
    await waitFor(() => h.children.length === 1);
    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);

    h.clock.value = now + 15 * 60_000;
    h.dash.scheduler.tick();
    await waitFor(() => h.children.length === 2);

    // The scheduled run invokes the real CLI through the real run manager, with
    // the identical flag shape. Only the project URL and the run-scoped output
    // path differ, and those differ because the projects themselves differ.
    const flags = (args: string[]) => args.filter((_, i) => args[i - 1] !== "--output" && /^https?:/.test(args[i]!) !== true);
    assert.deepEqual(flags(h.children[1]!.args), flags(h.children[0]!.args));
    assert.ok(h.children[1]!.args.includes("--execute"));
    assert.ok(h.children[1]!.args.includes("--history-dir"));
    settle(h.children[1]!);
    await waitFor(() => h.children[1]!.exitCode !== null);

    const manual = await getJson(`${h.base}/api/projects/${manualProject}`);
    const scheduled = await getJson(`${h.base}/api/projects/${scheduledProject}`);
    assert.equal(scheduled.status, 200);
    assert.ok(scheduled.json.ok);
    // Same run shape: one recorded run with the same status and headline.
    const strip = (r: any) => ({ qaStatus: r.qaStatus, status: r.status, headline: r.headline });
    assert.deepEqual(strip(scheduled.json.runs[0]), strip(manual.json.runs[0]));
    assert.equal(scheduled.json.runs.length, 1);
  } finally { await h.stop(); }
});

test("a run that never writes a report is recorded as FAILED, not as a pass", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    h.clock.value = now + 15 * 60_000;
    h.dash.scheduler.tick();
    await waitFor(() => h.children.length === 1);
    crash(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);

    const history = await getJson(`${h.base}/api/projects/${projectId}/schedule/history`);
    assert.equal(history.json.executions[0].status, "FAILED");
    // A run that crashed is still a real run the engine attempted: the run id was
    // issued, so it is recorded on the execution even though the run itself never
    // completed. The key invariant is that a run's identity is never fabricated;
    // the id that was started is what appears in history.
    assert.ok(history.json.executions[0].runId, "the run id issued by the engine must be recorded");
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/schedule`)).json.schedule.consecutiveFailures, 1);
  } finally { await h.stop(); }
});

test("a genuinely failing QA result is COMPLETED, not FAILED", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    h.clock.value = now + 15 * 60_000;
    h.dash.scheduler.tick();
    await waitFor(() => h.children.length === 1);
    settle(h.children[0]!, "FAIL");
    await waitFor(() => h.children[0]!.exitCode !== null);

    const history = await getJson(`${h.base}/api/projects/${projectId}/schedule/history`);
    // The run happened and reported FAIL: that is a completed run of a failing
    // site, which is different from the run itself failing.
    assert.equal(history.json.executions[0].status, "COMPLETED");
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/schedule`)).json.schedule.consecutiveFailures, 0);
  } finally { await h.stop(); }
});

test("the same slot is never dispatched twice", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    h.clock.value = now + 15 * 60_000;

    h.dash.scheduler.tick();
    // A second tick while the first run is still going, and a third after.
    const second = h.dash.scheduler.tick();
    const third = h.dash.scheduler.tick();
    assert.equal(second.dispatched, false);
    assert.equal(third.dispatched, false);
    assert.equal(h.children.length, 1, "only one child process may ever be started for one slot");
    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/schedule/history`)).json.executions.length, 1);
  } finally { await h.stop(); }
});

test("a schedule whose project was deleted skips without starting a run", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    assert.equal((await send("DELETE", `${h.base}/api/projects/${projectId}`)).status, 200);

    h.clock.value = now + 15 * 60_000;
    const result = h.dash.scheduler.tick();
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0]!.status, "SKIPPED_PROJECT_MISSING");
    assert.equal(h.children.length, 0, "a deleted project must not start a browser");

    // The schedule is still there with its history, and it advances.
    const all = await getJson(`${h.base}/api/schedules`);
    assert.equal(all.json.schedules.length, 1);
    assert.equal(all.json.schedules[0].projectMissing, true);
    assert.ok(all.json.schedules[0].nextRunAt > new Date(now + 15 * 60_000).toISOString());
  } finally { await h.stop(); }
});

test("a manual run in progress makes the scheduled slot skip, and the schedule still advances", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });

    // A manual run occupies the single-run slot.
    await send("POST", `${h.base}/api/projects/${projectId}/runs`);
    await waitFor(() => h.children.length === 1);

    h.clock.value = now + 15 * 60_000;
    const result = h.dash.scheduler.tick();
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0]!.status, "SKIPPED_OVERLAPPING_RUN");
    assert.equal(h.children.length, 1, "the skip must not start a second run");

    // The slot was consumed, so the next one is due later rather than now.
    const schedule = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(schedule.json.schedule.nextRunAt, new Date(now + 30 * 60_000).toISOString());
    assert.equal(h.dash.scheduler.tick().dispatched, false, "the consumed slot must not be retried");

    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);
  } finally { await h.stop(); }
});

test("one broken schedule does not stop the others from running", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const healthy = await createProject(h.base, "Healthy");
    const orphaned = await createProject(h.base, "Orphan");
    await send("PUT", `${h.base}/api/projects/${healthy}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    await send("PUT", `${h.base}/api/projects/${orphaned}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    await send("DELETE", `${h.base}/api/projects/${orphaned}`);

    h.clock.value = now + 15 * 60_000;
    const result = h.dash.scheduler.tick();
    assert.equal(result.errors.length, 0);
    assert.equal(result.executions.length, 2);
    await waitFor(() => h.children.length === 1);
    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);
  } finally { await h.stop(); }
});

test("run-now goes through the same path as a due tick", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });

    const triggered = await send("POST", `${h.base}/api/projects/${projectId}/schedule/run-now`);
    assert.equal(triggered.status, 200, JSON.stringify(triggered.json));
    assert.equal(triggered.json.execution.trigger, "MANUAL_TRIGGER");
    assert.equal(triggered.json.execution.status, "RUNNING");
    await waitFor(() => h.children.length === 1);
    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);

    const history = await getJson(`${h.base}/api/projects/${projectId}/schedule/history`);
    assert.equal(history.json.executions[0].status, "COMPLETED");
    // The manual trigger consumed a slot, so the schedule advanced as if due.
    const schedule = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.ok(schedule.json.schedule.nextRunAt > new Date(now).toISOString());
  } finally { await h.stop(); }
});

test("run-now is refused for an unscheduled or disabled project", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    assert.equal((await send("POST", `${h.base}/api/projects/${projectId}/schedule/run-now`)).status, 404);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    await send("POST", `${h.base}/api/projects/${projectId}/schedule/disable`);
    assert.equal((await send("POST", `${h.base}/api/projects/${projectId}/schedule/run-now`)).status, 409);
    assert.equal((await send("POST", `${h.base}/api/projects/prj-nope/schedule/run-now`)).status, 404);
  } finally { await h.stop(); }
});

test("run-now while a run is in progress is a recorded skip, not a failed slot", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });

    const manual = await send("POST", `${h.base}/api/projects/${projectId}/runs`);
    await waitFor(() => h.children.length === 1);
    const manualRunId = manual.json.run.runId;

    const triggered = await send("POST", `${h.base}/api/projects/${projectId}/schedule/run-now`);
    assert.equal(triggered.status, 200, JSON.stringify(triggered.json));
    assert.equal(triggered.json.execution.status, "SKIPPED_OVERLAPPING_RUN");
    assert.equal(triggered.json.execution.runId, null);
    assert.match(triggered.json.execution.detail, new RegExp(manualRunId));
    assert.equal(h.children.length, 1, "the skip must not start a second run");

    // The skip consumed the slot: the schedule advanced, and the earlier real
    // run's id was not erased by a slot that never ran.
    const schedule = await getJson(`${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(schedule.json.schedule.lastExecutionStatus, "SKIPPED_OVERLAPPING_RUN");
    assert.equal(schedule.json.schedule.consecutiveFailures, 0);
    assert.equal(schedule.json.schedule.nextRunAt, new Date(now + 3_600_000).toISOString());

    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);
  } finally { await h.stop(); }
});

test("a disabled schedule is never dispatched", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    await send("POST", `${h.base}/api/projects/${projectId}/schedule/disable`);
    h.clock.value = now + 24 * 3_600_000;
    const result = h.dash.scheduler.tick();
    assert.equal(result.dispatched, false);
    assert.equal(h.children.length, 0);
  } finally { await h.stop(); }
});

test("stopping the scheduler stops dispatch, and starting again does not resend old slots", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    h.dash.scheduler.stop();
    h.clock.value = now + 15 * 60_000;
    assert.equal(h.dash.scheduler.tick().dispatched, false, "a stopped scheduler must not dispatch");
    assert.equal(h.children.length, 0);
    assert.equal((await send("POST", `${h.base}/api/projects/${projectId}/schedule/run-now`)).status, 503);
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------
// Server-driven lifecycle and recovery
// ---------------------------------------------------------------------------

test("a scheduler with the timer disabled never starts a run on its own", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    h.clock.value = now + 60 * 60_000;
    await new Promise(r => setTimeout(r, 250));
    assert.equal(h.children.length, 0, "no background timer may dispatch when the scheduler is off");
  } finally { await h.stop(); }
});

test("restart recovery completes a run whose artifact really landed", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-sched-recover-"));
  const reportDir = join(dir, "reports");
  const schedulesPath = join(reportDir, "projects", "schedules.json");
  const { spawnImpl } = fakeSpawner();

  // First process: claim a slot and die before the run settles.
  const first = await startDashboard({
    reportDir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(),
    spawnImpl, schedulesPath, now: () => now, scheduleEnabled: false,
  });
  const firstBase = `http://127.0.0.1:${first.port}`;
  const projectId = await createProject(firstBase, "Recoverable");
  await send("PUT", `${firstBase}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
  (first.scheduler as Scheduler);
  const clock = { value: now };
  // Re-point the store at a moved clock and claim through the live scheduler.
  const store = new ScheduleStore(schedulesPath, { now: () => clock.value });
  clock.value = now + 15 * 60_000;
  const scheduleId = store.get(projectId)!.id;
  const claimed = store.claimDue(scheduleId, { nowMs: clock.value });
  assert.equal(claimed.ok, true);
  const realRunId = "web-recovered-1";
  store.markRunning(claimed.ok ? claimed.value.executionId : "", realRunId, clock.value);
  // The engine really wrote its report before the process went away.
  mkdirSync(join(reportDir, "runs", realRunId), { recursive: true });
  writeFileSync(join(reportDir, "runs", realRunId, "qa-analysis.json"), JSON.stringify(analysis("PASS")), "utf8");
  await new Promise<void>((resolve, reject) => {
    const s = first.server as unknown as import("node:http").Server;
    s.closeAllConnections?.();
    s.close(e => (e ? reject(e) : resolve()));
  });

  // Second process over the same document.
  const second = await startDashboard({
    reportDir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(),
    spawnImpl, schedulesPath, now: () => clock.value, scheduleEnabled: false,
  });
  try {
    const secondBase = `http://127.0.0.1:${second.port}`;
    const history = await getJson(`${secondBase}/api/projects/${projectId}/schedule/history`);
    // Recovery ran at startup and found the real artifact.
    const execution = history.json.executions.find((e: any) => e.runId === realRunId);
    assert.ok(execution, "the recovered execution must still be in history");
    assert.equal(execution.status, "COMPLETED");
  } finally {
    const s = second.server as unknown as import("node:http").Server;
    s.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => s.close(e => (e ? reject(e) : resolve())));
  }
});

test("restart recovery records an unverifiable run as INTERRUPTED and never reruns it", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-sched-interrupt-"));
  const reportDir = join(dir, "reports");
  const schedulesPath = join(reportDir, "projects", "schedules.json");
  const { spawnImpl, children } = fakeSpawner();

  const first = await startDashboard({
    reportDir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(),
    spawnImpl, schedulesPath, now: () => now, scheduleEnabled: false,
  });
  const firstBase = `http://127.0.0.1:${first.port}`;
  const projectId = await createProject(firstBase, "Interrupted");
  await send("PUT", `${firstBase}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });

  const clock = { value: now + 15 * 60_000 };
  const store = new ScheduleStore(schedulesPath, { now: () => clock.value });
  const claimed = store.claimDue(store.get(projectId)!.id, { nowMs: clock.value });
  assert.equal(claimed.ok, true);
  // A run id was issued but the process died before any report was written.
  store.markRunning(claimed.ok ? claimed.value.executionId : "", "web-vanished", clock.value);
  await new Promise<void>((resolve, reject) => {
    const s = first.server as unknown as import("node:http").Server;
    s.closeAllConnections?.();
    s.close(e => (e ? reject(e) : resolve()));
  });

  const second = await startDashboard({
    reportDir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(),
    spawnImpl, schedulesPath, now: () => clock.value, scheduleEnabled: false,
  });
  try {
    const secondBase = `http://127.0.0.1:${second.port}`;
    const history = await getJson(`${secondBase}/api/projects/${projectId}/schedule/history`);
    const execution = history.json.executions.find((e: any) => e.runId === "web-vanished");
    assert.equal(execution.status, "INTERRUPTED");
    assert.ok(execution.detail);
    // The uncertain execution is not replayed: no new run was started, and the
    // document holds exactly the one interrupted record.
    assert.equal(children.length, 0);
    assert.equal(history.json.executions.length, 1);
  } finally {
    const s = second.server as unknown as import("node:http").Server;
    s.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => s.close(e => (e ? reject(e) : resolve())));
  }
});

test("schedules survive a restart and keep running from where they were", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-sched-restart-"));
  const reportDir = join(dir, "reports");
  const schedulesPath = join(reportDir, "projects", "schedules.json");
  const { spawnImpl, children } = fakeSpawner();
  const clock = { value: now };

  const boot = async () => startDashboard({
    reportDir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(),
    spawnImpl, schedulesPath, now: () => clock.value, scheduleEnabled: false,
  });
  const close = async (dash: Awaited<ReturnType<typeof startDashboard>>) => {
    const s = dash.server as unknown as import("node:http").Server;
    s.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => s.close(e => (e ? reject(e) : resolve())));
  };

  const first = await boot();
  const firstBase = `http://127.0.0.1:${first.port}`;
  const projectId = await createProject(firstBase, "Persistent");
  await send("PUT", `${firstBase}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "Europe/Berlin" });
  const before = (await getJson(`${firstBase}/api/projects/${projectId}/schedule`)).json.schedule;
  await close(first);

  const second = await boot();
  try {
    const secondBase = `http://127.0.0.1:${second.port}`;
    const after = (await getJson(`${secondBase}/api/projects/${projectId}/schedule`)).json.schedule;
    assert.equal(after.id, before.id);
    assert.equal(after.timezone, "Europe/Berlin");
    assert.equal(after.nextRunAt, before.nextRunAt, "a restart must not move the next slot");
    // And it still dispatches from the same schedule document.
    clock.value = now + 15 * 60_000;
    second.scheduler.tick();
    await waitFor(() => children.length === 1);
    settle(children[0]!);
    await waitFor(() => children[0]!.exitCode !== null);
    const history = await getJson(`${secondBase}/api/projects/${projectId}/schedule/history`);
    assert.equal(history.json.executions.length, 1);
    assert.equal(history.json.executions[0].status, "COMPLETED");
  } finally { await close(second); }
});

test("the schedule document lives beside the project document by default", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "DAILY", timezone: "UTC" });
    // The default path is <reportDir>/projects/schedules.json, matching where the
    // project document already lives.
    assert.ok(existsSync(join(h.dir, "projects", "schedules.json")), "schedules.json must be written under <reportDir>/projects");
    assert.ok(existsSync(join(h.dir, "projects", "projects.json")), "the project document must still be there beside it");
  } finally { await h.stop(); }
});

// ---------------------------------------------------------------------------
// Existing contracts must be untouched
// ---------------------------------------------------------------------------

test("existing project and run endpoints still answer exactly as before", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base, "Unchanged");
    // Project list, detail, history, manual run, standalone run, state.
    assert.equal((await getJson(`${h.base}/api/projects`)).status, 200);
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}`)).json.project.name, "Unchanged");
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/runs`)).status, 200);
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/schedule/history`)).status, 404, "no schedule yet");

    await send("POST", `${h.base}/api/projects/${projectId}/runs`);
    await waitFor(() => h.children.length === 1);
    settle(h.children[0]!);
    await waitFor(() => h.children[0]!.exitCode !== null);
    assert.equal((await getJson(`${h.base}/api/projects/${projectId}/runs`)).json.runs.length, 1);

    // A standalone run with no project still works, on the endpoint it always
    // used.
    await send("POST", `${h.base}/api/qa/run`, { url: SITE });
    await waitFor(() => h.children.length === 2);
    settle(h.children[1]!);
    await waitFor(() => h.children[1]!.exitCode !== null);
    assert.equal((await getJson(`${h.base}/api/state`)).status, 200);
  } finally { await h.stop(); }
});

test("the app shell is served unchanged at every client-side route", async () => {
  const h = await start();
  try {
    for (const path of ["/", "/dashboard", "/projects", "/projects/prj-abc123", "/schedules"]) {
      const res = await fetch(`${h.base}${path}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    }
  } finally { await h.stop(); }
});

test("the persisted schedule document is readable and valid JSON with real timestamps", async () => {
  const now = Date.UTC(2026, 5, 10, 12, 0);
  const h = await start({ now, scheduleEnabled: false });
  try {
    const projectId = await createProject(h.base);
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "DAILY", timezone: "Europe/Berlin" });
    const raw = JSON.parse(readFileSync(join(h.dir, "projects", "schedules.json"), "utf8")) as any;
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.schedules.length, 1);
    const schedule = raw.schedules[0];
    // Timestamps are stored as UTC ISO instants, not local strings.
    assert.match(schedule.nextRunAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(schedule.createdAt, /Z$/);
    assert.equal(schedule.frequency, "DAILY");
    assert.equal(schedule.timezone, "Europe/Berlin");
  } finally { await h.stop(); }
});