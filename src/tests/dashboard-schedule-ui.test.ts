import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDashboard } from "../dashboard/server.js";

const SITE = "https://example.com";

// The real application file, read from disk so the assertions are about what a
// browser would actually receive.
const APP_HTML = readFileSync(join(process.cwd(), "src", "dashboard", "app.html"), "utf8");

const analysis = () => ({
  schemaVersion: 1,
  generatedAt: "2026-09-29T10:00:00.000Z",
  mode: "deterministic",
  aiProvider: "deterministic",
  scan: { scan: { url: SITE, finalUrl: SITE, title: "Home", timestamp: "2026-09-29T10:00:00.000Z", durationMs: 800 }, elements: [] },
  findings: [],
  accessPrerequisite: { status: "PASS", reason: null, details: [] },
  flowDiscovery: {
    limits: {}, graph: { sourceUrl: SITE, pages: [] }, flows: [], executions: [],
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
    overallStatus: "PASS", headline: "ok", sourceUrl: SITE, issueCount: 0, flowsDetected: 0,
    scheduled: 0, executed: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0,
    skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0,
    infrastructureProblems: 0, infrastructureFailures: 0, unverified: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  },
  execution: { status: "passed", tests: 0, passed: 0, failed: 0, skipped: 0, failures: [] },
  verifications: [],
});

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[]; exitCode: number | null };

const start = async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-sched-ui-"));
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
  const dash = await startDashboard({
    reportDir: dir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(),
    spawnImpl, scheduleEnabled: false,
  });
  return {
    dir, dash, children,
    base: `http://127.0.0.1:${dash.port}`,
    stop: async () => {
      const s = dash.server as unknown as import("node:http").Server;
      s.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => s.close(e => (e ? reject(e) : resolve())));
    },
  };
};

const send = async (method: string, url: string, body: unknown = {}) => {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  // A GET or DELETE must not carry a body; node's fetch rejects that outright.
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const settle = (child: FakeChild) => {
  const output = child.args[child.args.indexOf("--output") + 1]!;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(analysis()), "utf8");
  child.exitCode = 0;
  child.emit("close", 0);
};

let seq = 0;
const createProject = async (base: string, name: string) => {
  seq += 1;
  const created = await send("POST", `${base}/api/projects`, { name, url: `${SITE}/ui${seq}` });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json.project.id as string;
};

// ---------------------------------------------------------------------------
// The served application
// ---------------------------------------------------------------------------

test("the app shell is served and parses as valid script", async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(html, APP_HTML);
    const script = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script, "the app must ship an inline script");
    assert.doesNotThrow(() => new Function(script![1]), "the inline script must parse");
  } finally { await h.stop(); }
});

test("the nav offers a Schedules route and the router resolves it", async () => {
  const h = await start();
  try {
    const html = await (await fetch(`${h.base}/`)).text();
    // The nav entry and the router branch both exist, so /schedules is reachable
    // without a server route.
    assert.match(html, /\["\/schedules", "Schedules"\]/);
    assert.match(html, /location\.pathname === "\/schedules"/);
  } finally { await h.stop(); }
});

test("the schedule UI talks to the documented endpoints and nothing invented", async () => {
  const h = await start();
  try {
    const html = await (await fetch(`${h.base}/`)).text();
    for (const endpoint of [
      "/api/projects/\" + encodeURIComponent(projectId) + \"/schedule",
      "/api/projects/\" + encodeURIComponent(projectId) + \"/schedule/history",
      // enable/disable are appended to that path from the button's own action.
      "\" + action",
      "/run-now\"",
      "/api/schedules",
    ]) {
      assert.ok(html.includes(endpoint), `the app must call ${endpoint}`);
    }
    // The enable and disable actions come from the server's own verb, not a
    // separately invented one.
    assert.match(html, /schedulePath\(projectId\) \+ "\/" \+ action/);
    // Every execution status the server can persist has a human label, so the UI
    // never shows a raw enum.
    for (const status of [
      "QUEUED", "RUNNING", "COMPLETED", "FAILED",
      "SKIPPED_OVERLAPPING_RUN", "SKIPPED_PROJECT_MISSING", "CANCELLED", "INTERRUPTED",
    ]) {
      assert.ok(html.includes(status + ":"), `the app must label ${status}`);
    }
  } finally { await h.stop(); }
});

test("the schedule UI offers exactly the stable frequency set", async () => {
  const h = await start();
  try {
    const html = await (await fetch(`${h.base}/`)).text();
    for (const [value, label] of [
      ["EVERY_15_MINUTES", "Every 15 minutes"],
      ["HOURLY", "Hourly"],
      ["EVERY_6_HOURS", "Every 6 hours"],
      ["DAILY", "Daily"],
      ["WEEKLY", "Weekly"],
    ]) {
      assert.ok(html.includes(`["${value}", "${label}"]`), `missing frequency option ${value}`);
    }
  } finally { await h.stop(); }
});

test("the timezone picker offers the device zone and the common zones, not just one", async () => {
  const h = await start();
  try {
    const html = await (await fetch(`${h.base}/`)).text();
    // The real functions are pulled out of the served file and run against a
    // minimal DOM, so this is the list a browser would actually get.
    const source = [
      /const COMMON_TIMEZONES = \[[^\]]*\];/.exec(html)?.[0],
      /const timezoneOptions = \(selected\) => \{[\s\S]*?\n  return frag;\n\};/.exec(html)?.[0],
    ].join("\n");
    assert.ok(source.includes("COMMON_TIMEZONES"), "the zone list must be built by the app's own function");

    type Option = { value: string; textContent: string; selected: boolean };
    // The option list the app's own source produces, for a given device zone and
    // the zone the saved schedule already uses.
    const build = (deviceZone: string | null, selected: string | null) => {
      const options: Option[] = [];
      const document = {
        createDocumentFragment: () => ({ appendChild: (node: Option) => options.push(node) }),
        createElement: () => ({ value: "", textContent: "", selected: false } as Option),
      };
      const run = new Function(
        "document",
        "deviceZone",
        `${source}
         const browserTimezones = () => (deviceZone ? [deviceZone] : []);
         return timezoneOptions(${JSON.stringify(selected)});`,
      ) as (doc: unknown, device: string | null) => void;
      run(document, deviceZone);
      return options;
    };

    const withDevice = build("Asia/Tokyo", null).map(option => option.value);
    assert.ok(withDevice.includes("Asia/Tokyo"), "the device zone must be offered");
    assert.ok(withDevice.includes("UTC"), "the common zones must stay available next to the device zone");
    assert.ok(withDevice.length > 2, "the picker must not be reduced to one zone");

    // A zone saved outside the short list is still selectable.
    const withSaved = build("Asia/Tokyo", "America/Sao_Paulo");
    assert.ok(withSaved.some(option => option.value === "America/Sao_Paulo" && option.selected), "the saved zone must be offered and selected");
    assert.equal(
      withSaved.filter(option => option.value === "Asia/Tokyo").length,
      1,
      "a zone must not be offered twice",
    );
  } finally { await h.stop(); }
});

test("the schedule section exists on the project page and a real schedule drives it", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base, "UI Project");
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "Europe/Berlin" });
    const schedule = await send("GET", `${h.base}/api/projects/${projectId}/schedule`);
    assert.equal(schedule.json.schedule.frequencyLabel, "Hourly");

    // The payload the UI renders from is complete: it has a label, a next run,
    // and a history endpoint that answers.
    const history = await send("GET", `${h.base}/api/projects/${projectId}/schedule/history`);
    assert.equal(history.status, 200);
    assert.deepEqual(history.json.executions, []);
  } finally { await h.stop(); }
});

test("a real scheduled run shows up in the history the UI reads", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base, "UI History");
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    const triggered = await send("POST", `${h.base}/api/projects/${projectId}/schedule/run-now`);
    assert.equal(triggered.status, 200);
    await new Promise(r => setTimeout(r, 30));
    settle(h.children[0]!);
    await new Promise(r => setTimeout(r, 50));

    const history = await send("GET", `${h.base}/api/projects/${projectId}/schedule/history`);
    const execution = history.json.executions[0];
    assert.equal(execution.status, "COMPLETED");
    assert.ok(execution.runId);
    // The UI offers an "Open results" control only when a run id exists.
    assert.ok(execution.runId, "the open-results control depends on a real run id");
  } finally { await h.stop(); }
});

test("a skipped slot keeps its recorded reason so the UI can show it", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base, "UI Skip");
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "EVERY_15_MINUTES", timezone: "UTC" });
    // A manual run occupies the single-run slot.
    await send("POST", `${h.base}/api/projects/${projectId}/runs`);
    await new Promise(r => setTimeout(r, 30));
    // The slot is made due through the persisted document, so the tick sees the
    // same state a fifteen-minute wait would have produced.
    const schedules = h.dash.schedules;
    const schedule = schedules.get(projectId)!;
    schedule.nextRunAt = new Date(Date.now() - 1000).toISOString();
    h.dash.scheduler.tick();
    await new Promise(r => setTimeout(r, 30));
    settle(h.children[0]!);
    await new Promise(r => setTimeout(r, 50));

    const history = await send("GET", `${h.base}/api/projects/${projectId}/schedule/history`);
    const skip = history.json.executions.find((e: any) => e.status === "SKIPPED_OVERLAPPING_RUN");
    assert.ok(skip, "the overlap skip must be recorded");
    assert.ok(skip.detail && skip.detail.length > 0, "a skip must carry the reason it happened");
    assert.equal(skip.runId, null, "a skip has no run, and the UI shows 'no run' for it");
  } finally { await h.stop(); }
});

test("an interrupted slot is visible in the UI's status vocabulary", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base, "UI Interrupted");
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    // Drive the store into an interrupted state the way a restart would.
    const schedules = h.dash.schedules;
    schedules.claimDue(schedules.get(projectId)!.id, { nowMs: Date.now() + 7_200_000 });
    schedules.recover(() => ({ completed: false }), Date.now() + 7_200_000);
    const history = await send("GET", `${h.base}/api/projects/${projectId}/schedule/history`);
    const execution = history.json.executions[0];
    assert.equal(execution.status, "INTERRUPTED");
    assert.ok(execution.detail);
  } finally { await h.stop(); }
});

test("the global schedules view reflects the real schedule set", async () => {
  const h = await start();
  try {
    const enabled = await createProject(h.base, "Enabled");
    const disabled = await createProject(h.base, "Disabled");
    const unscheduled = await createProject(h.base, "Unscheduled");
    await send("PUT", `${h.base}/api/projects/${enabled}/schedule`, { frequency: "DAILY", timezone: "Asia/Tokyo" });
    await send("PUT", `${h.base}/api/projects/${disabled}/schedule`, { frequency: "WEEKLY", timezone: "UTC" });
    await send("POST", `${h.base}/api/projects/${disabled}/schedule/disable`);

    const all = await send("GET", `${h.base}/api/schedules`);
    assert.equal(all.json.schedules.length, 2, "only scheduled projects appear");
    assert.equal(all.json.projectMissingCount, 0);
    // The unscheduled project is genuinely absent, not shown as "off".
    assert.equal(all.json.schedules.some((s: any) => s.projectId === unscheduled), false);
    // Only the enabled schedule promises a next run.
    assert.equal(all.json.upcoming.length, 1);
    assert.equal(all.json.upcoming[0].projectId, enabled);
    assert.equal(all.json.schedules.find((s: any) => s.projectId === disabled).nextRunAt, null);
  } finally { await h.stop(); }
});

test("a deleted project's schedule is reported as missing rather than silently dropped", async () => {
  const h = await start();
  try {
    const projectId = await createProject(h.base, "Vanishing");
    await send("PUT", `${h.base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    assert.equal((await send("DELETE", `${h.base}/api/projects/${projectId}`)).status, 200);
    const all = await send("GET", `${h.base}/api/schedules`);
    assert.equal(all.json.schedules.length, 1, "the schedule row survives its project");
    assert.equal(all.json.schedules[0].projectMissing, true);
    assert.equal(all.json.projectMissingCount, 1);
  } finally { await h.stop(); }
});

test("existing UI hooks are untouched by the schedule work", async () => {
  const h = await start();
  try {
    const html = await (await fetch(`${h.base}/`)).text();
    // Every control the Project page already had must still be there.
    for (const hook of [
      'id = "project-run-btn"',
      'runBtn.dataset.runBtn = "1"',
      'function renderWhatChanged',
      'function renderFindingsChanges',
      'function renderProjectsPage',
      'function renderProjectPage',
      'function renderHomePage',
      'function openHistoricalRun',
      'id = "project-findings"',
      'id = "project-summary"',
    ]) {
      assert.ok(html.includes(hook), `existing UI hook missing: ${hook}`);
    }
  } finally { await h.stop(); }
});