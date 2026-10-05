import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDashboard } from "../dashboard/server.js";
import { ProjectStore, defaultProjectsPath } from "../dashboard/projects.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-projects-"));

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[] };

/** Stands in for the real CLI child. QA still runs in production; this only
 *  keeps the tests offline and deterministic. */
const fakeSpawner = (): { spawnImpl: typeof import("node:child_process").spawn; children: FakeChild[] } => {
  const children: FakeChild[] = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.args = args;
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, children };
};

const reportFixture = (overrides: object = {}): object => ({
  schemaVersion: 1,
  generatedAt: "2026-09-29T10:00:00.000Z",
  scan: { scan: { url: "https://qa.test/en", title: "QA target" } },
  findings: [
    { id: "QA-F-001", code: "BTN", severity: "HIGH", status: "FAIL", lifecycle: "TEST_EXECUTED", title: "Button lacks an accessible name", description: "d", recommendation: "r", userImpact: "u", rationale: "why", count: 2, domain: "Accessibility", confidence: "HIGH_CONFIDENCE", relatedScenarioIds: [], verification: { disposition: "REPRODUCED", status: "REPRODUCED", category: "WEBSITE", verdict: "CONFIRMED", reason: "seen", safety: "safe", locator: "#a", executedAt: null, durationMs: 12, error: null }, evidence: [] },
  ],
  coverage: { generatedAt: "2026-09-29T10:00:00.000Z", summary: { pages: { discovered: 8, tested: 6, partial: 1, untested: 2, blocked: 0, review: 0 }, flows: { discovered: 5, executed: 3, passed: 2, reproduced: 1, notReproduced: 0, review: 0, blocked: 0 }, interactions: { tested: 10, partial: 2, untested: 3, review: 0, notApplicable: 1 }, findings: { analyzed: 1, verified: 1, reproduced: 1, notReproduced: 0, unverified: 0 }, recommendations: 1 }, testPlan: [], aiNotes: { gaps: ["Two pages were never reached."] } },
  flowDiscovery: { limits: {}, graph: { pages: [] }, flows: [], executions: [], summary: { pages: 8, flows: 5, executable: 5, review: 0, highRisk: 0, blocked: 0, steps: 10, executed: 3, passed: 2, reproduced: 1, notReproduced: 0, reviewRequired: 0, infrastructure: 0 } },
  summary: { overallStatus: "FAIL", headline: "1 confirmed problem", issueCount: 2, flowsDetected: 2, scheduled: 1, executed: 1, reproduced: 1, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 0, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 } },
  history: { status: "AVAILABLE", currentRunId: "hist-1", runsAvailable: 1 },
  execution: { status: "FAIL", tests: 1, passed: 0, failed: 1, skipped: 0, failures: [] },
  ...overrides,
});

const start = async (dir: string, spawnImpl: typeof import("node:child_process").spawn) => {
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    projectRoot: process.cwd(),
    spawnImpl,
  });
  return { dash, base: `http://127.0.0.1:${dash.port}` };
};

const stop = async (dash: Awaited<ReturnType<typeof startDashboard>>): Promise<void> => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

const post = async (url: string, body: unknown = {}): Promise<{ status: number; json: any }> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const get = async (url: string): Promise<{ status: number; body: string; json: any }> => {
  const res = await fetch(url);
  const body = await res.text();
  let json: any = null;
  try { json = JSON.parse(body); } catch { /* not json */ }
  return { status: res.status, body, json };
};

const patch = async (url: string, body: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const del = async (url: string): Promise<{ status: number; json: any }> => {
  const res = await fetch(url, { method: "DELETE" });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

/** Writes a report where the spawned child was told to put it, then closes. */
const settle = (child: FakeChild, fixture: object = reportFixture()): string => {
  const index = child.args.indexOf("--output");
  const output = child.args[index + 1]!;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(fixture), "utf8");
  child.emit("close", 0);
  return output;
};

const createProject = async (base: string, name: string, url: string) => {
  const created = await post(`${base}/api/projects`, { name, url });
  assert.equal(created.status, 201, `project creation failed: ${JSON.stringify(created.json)}`);
  return created.json.project as { id: string; name: string; url: string; lastStatus: string | null; lastFindingsCount: number | null; lastCoverageStatus: string | null; lastRunId: string | null };
};

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

test("a project is created from a name and a real website URL", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://devv2ayn.dotcomlb.com/");
    assert.equal(project.name, "AYN TV");
    assert.equal(project.url, "https://devv2ayn.dotcomlb.com/");
    assert.equal(project.lastRunId, null);
    assert.equal(project.lastStatus, null, "a project that never ran has no status to show");

    const list = await get(`${base}/api/projects`);
    assert.equal(list.status, 200);
    assert.equal(list.json.projects.length, 1);
    assert.equal(list.json.projects[0].id, project.id);
  } finally {
    await stop(dash);
  }
});

test("a project requires a name and a valid http(s) URL", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    assert.equal((await post(`${base}/api/projects`, { name: "   ", url: "https://a.test/" })).status, 400);
    assert.equal((await post(`${base}/api/projects`, { name: "No URL" })).status, 400);
    assert.equal((await post(`${base}/api/projects`, { name: "Bad URL", url: "nonsense" })).status, 400);
    assert.equal((await post(`${base}/api/projects`, { name: "Bad scheme", url: "ftp://a.test/" })).status, 400);
    // Nothing invalid was written.
    assert.equal((await get(`${base}/api/projects`)).json.projects.length, 0);
  } finally {
    await stop(dash);
  }
});

test("the same website cannot be saved twice, and the conflict names the existing project", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    await createProject(base, "AYN TV", "https://devv2ayn.dotcomlb.com/");
    const dupe = await post(`${base}/api/projects`, { name: "Same site again", url: "  https://devv2ayn.dotcomlb.com/  " });
    assert.equal(dupe.status, 409);
    assert.match(dupe.json.error, /AYN TV/, "the conflict should point at the project that already exists");
    assert.equal((await get(`${base}/api/projects`)).json.projects.length, 1);
  } finally {
    await stop(dash);
  }
});

test("a project can be renamed and re-pointed, but not onto another project's URL", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const first = await createProject(base, "AYN TV", "https://a.test/");
    const second = await createProject(base, "Other", "https://b.test/");

    const renamed = await patch(`${base}/api/projects/${first.id}`, { name: "AYN TV Live" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.project.name, "AYN TV Live");

    const clash = await patch(`${base}/api/projects/${second.id}`, { url: "https://a.test/" });
    assert.equal(clash.status, 409);
    assert.equal((await get(`${base}/api/projects/${second.id}`)).json.project.url, "https://b.test/", "a rejected update changes nothing");

    assert.equal((await patch(`${base}/api/projects/${first.id}`, { url: "nonsense" })).status, 400);
    assert.equal((await patch(`${base}/api/projects/prj-nope`, { name: "x" })).status, 404);
  } finally {
    await stop(dash);
  }
});

test("a missing project is a 404 everywhere it is addressed", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    assert.equal((await get(`${base}/api/projects/prj-missing`)).status, 404);
    assert.equal((await get(`${base}/api/projects/prj-missing/runs`)).status, 404);
    assert.equal((await post(`${base}/api/projects/prj-missing/runs`)).status, 404);
    assert.equal((await del(`${base}/api/projects/prj-missing`)).status, 404);
  } finally {
    await stop(dash);
  }
});

// ---------------------------------------------------------------------------
// Project runs
// ---------------------------------------------------------------------------

test("a project run goes through the real engine and the summary is folded from its report", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://devv2ayn.dotcomlb.com/");

    const started = await post(`${base}/api/projects/${project.id}/runs`);
    assert.equal(started.status, 202);
    assert.equal(started.json.projectId, project.id);
    assert.equal(children.length, 1, "a project run spawns the same real CLI as a console run");
    assert.ok(children[0]!.args.some(arg => arg.endsWith(join("src", "qa-cli.ts"))));
    assert.ok(children[0]!.args.includes("https://devv2ayn.dotcomlb.com/"), "the URL comes from the saved project");
    assert.ok(children[0]!.args.includes("--execute"));
    assert.equal(started.json.run.projectId, project.id, "the run is associated with its project");

    // While running, the project records the run but has no results to report.
    const running = await get(`${base}/api/projects/${project.id}`);
    assert.equal(running.json.runs.length, 1);
    assert.equal(running.json.runs[0].hasResult, false);
    assert.equal(running.json.project.lastStatus, null);

    settle(children[0]!);

    const done = await get(`${base}/api/projects/${project.id}`);
    const saved = done.json.project;
    // Every one of these is read back from the artifact the run just wrote.
    assert.equal(saved.lastStatus, "FAIL", "the status comes from the report, not from the UI");
    assert.equal(saved.lastFindingsCount, 1);
    assert.equal(saved.lastCoverageStatus, "PARTIALLY_TESTED", "coverage is the engine's own page-count label");
    assert.equal(saved.lastRunId, done.json.runs[0].runId);
    assert.ok(saved.lastRunAt, "a finished run has a real completion time");
    assert.equal(done.json.runs[0].hasResult, true);

    // The run is still a first-class run that opens the existing results view.
    const runId = saved.lastRunId as string;
    const results = await get(`${base}/api/qa/runs/${runId}/results`);
    assert.equal(results.status, 200);
    assert.equal(results.json.ok, true);
    assert.equal(results.json.results.findings.items.length, 1, "a historical project run opens the existing results experience");
  } finally {
    await stop(dash);
  }
});

test("a failed project run reports no status rather than inventing one", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://a.test/");
    await post(`${base}/api/projects/${project.id}/runs`);
    children[0]!.stderr.emit("data", Buffer.from("Error: browser launch failed\n"));
    children[0]!.emit("close", 2);

    const after = await get(`${base}/api/projects/${project.id}`);
    assert.equal(after.json.project.lastStatus, null, "a run that produced no report has no status");
    assert.equal(after.json.project.lastFindingsCount, null);
    assert.equal(after.json.project.lastCoverageStatus, null);
    assert.equal(after.json.runs[0].hasResult, false);
    assert.match(after.json.runs[0].error, /browser launch failed/);
  } finally {
    await stop(dash);
  }
});

test("project run history is newest first and keeps every run", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://a.test/");
    const first = await post(`${base}/api/projects/${project.id}/runs`);
    settle(children[0]!);
    const second = await post(`${base}/api/projects/${project.id}/runs`);
    settle(children[1]!);

    const history = await get(`${base}/api/projects/${project.id}/runs`);
    assert.equal(history.status, 200);
    assert.equal(history.json.runs.length, 2);
    assert.equal(history.json.runs[0].runId, second.json.run.runId, "the newest run is listed first");
    assert.equal(history.json.runs[1].runId, first.json.run.runId);
  } finally {
    await stop(dash);
  }
});

test("a standalone console run is not attached to any project", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://a.test/");
    const standalone = await post(`${base}/api/qa/run`, { url: "https://elsewhere.test/" });
    assert.equal(standalone.status, 202, "the console keeps working on its own");
    assert.equal(standalone.json.run.projectId, null);
    settle(children[0]!);

    // It did not leak into any project's history.
    const runs = await get(`${base}/api/projects/${project.id}/runs`);
    assert.equal(runs.json.runs.length, 0);
    assert.equal((await get(`${base}/api/projects/${project.id}`)).json.project.lastStatus, null);
  } finally {
    await stop(dash);
  }
});

// ---------------------------------------------------------------------------
// Persistence and deletion
// ---------------------------------------------------------------------------

test("projects survive a restart because they are stored atomically on disk", async () => {
  const dir = tmp();
  const file = join(dir, "projects", "projects.json");
  {
    const { spawnImpl } = fakeSpawner();
    const { dash, base } = await start(dir, spawnImpl);
    try {
      await createProject(base, "AYN TV", "https://a.test/");
    } finally {
      await stop(dash);
    }
  }
  assert.ok(existsSync(file), `expected a projects document at ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.projects.length, 1);

  // A brand new server reads the same document back.
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const list = await get(`${base}/api/projects`);
    assert.equal(list.json.projects.length, 1);
    assert.equal(list.json.projects[0].name, "AYN TV");
  } finally {
    await stop(dash);
  }
});

test("deleting a project removes the saved record but never the QA artifacts", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://a.test/");
    await post(`${base}/api/projects/${project.id}/runs`);
    const artifact = settle(children[0]!);
    assert.ok(existsSync(artifact), "the run really did write a report");

    const removed = await del(`${base}/api/projects/${project.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.deleted, project.id);
    assert.match(removed.json.note, /not touched/i);

    assert.equal((await get(`${base}/api/projects`)).json.projects.length, 0);
    assert.equal((await get(`${base}/api/projects/${project.id}`)).status, 404);
    // The engine's own output is untouched by an organizational delete.
    assert.ok(existsSync(artifact), "deleting a project must not delete QA run artifacts");
  } finally {
    await stop(dash);
  }
});

test("a corrupt projects document degrades to empty instead of breaking QA", () => {
  const dir = tmp();
  const file = defaultProjectsPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{ this is not json", "utf8");
  const store = new ProjectStore(file);
  assert.deepEqual(store.list(), [], "a bad document must not take the app down");
});

// ---------------------------------------------------------------------------
// The Projects UI is served from the same console document
// ---------------------------------------------------------------------------

test("the project routes serve the console page, and the console links to Projects", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const project = await createProject(base, "AYN TV", "https://a.test/");
    for (const route of ["/projects", "/projects/", `/projects/${project.id}`]) {
      const page = await get(`${base}${route}`);
      assert.equal(page.status, 200, `${route} should be served`);
      assert.match(page.body, /<title>AI Website QA<\/title>/);
    }
    // The console itself reaches Projects and keeps the evidence explorer link.
    // The nav is built at runtime, so assert on the route table it ships with.
    const root = await get(`${base}/`);
    assert.match(root.body, /\["\/projects", "Projects"\]/, "the console must offer a way into Projects");
    assert.match(root.body, /\["\/dashboard", "Dashboard"\]/, "the evidence explorer link is preserved");
    assert.match(root.body, /navigate\("\/projects\/" \+ encodeURIComponent/, "creating a project lands on its own page");
    // The tracker renders the engine's own stage order, not a hardcoded guess.
    assert.match(root.body, /const STAGES = \["SCAN","ACCESS","GENERATE","ANALYZE"/);
    // The tracker reads the backend's logical view, so a repeated stage cannot
    // make the pipeline look like it restarted.
    assert.match(root.body, /stageViewFrom\(run\)/);
    assert.match(root.body, /run\.runningStage/);
  } finally {
    await stop(dash);
  }
});

test("the stage order the API publishes is the engine's real order", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const res = await get(`${base}/api/qa/stages`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.stages, ["SCAN", "ACCESS", "GENERATE", "ANALYZE", "EXECUTE", "VERIFY", "COVERAGE", "HISTORY", "COMPLETE"]);
  } finally {
    await stop(dash);
  }
});

test("a project id that is not a safe path segment is rejected", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    assert.equal((await get(`${base}/api/projects/..%2F..%2Fetc`)).status, 400);
    assert.equal((await get(`${base}/api/projects/bad$id`)).status, 400);
  } finally {
    await stop(dash);
  }
});

test("a project id is generated, not taken from user input", () => {
  const dir = tmp();
  const store = new ProjectStore(defaultProjectsPath(dir));
  const result = store.create({ name: "AYN TV", url: "https://a.test/" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value.id, /^prj-[0-9]+-[0-9a-f]{6}$/);
});

test("the store keeps at most 50 runs per project and still leaves the artifacts alone", () => {
  const dir = tmp();
  const store = new ProjectStore(defaultProjectsPath(dir));
  const created = store.create({ name: "AYN TV", url: "https://a.test/" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const project = created.value;
  for (let i = 0; i < 55; i += 1) {
    store.runStarted(project, {
      runId: `run-${i}`,
      projectId: project.id,
      url: project.url,
      startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      state: "COMPLETED",
      artifacts: { reportJson: `artifacts/${i}/qa-analysis.json`, reportHtml: `artifacts/${i}/qa-analysis.html`, executionJson: null },
    });
  }
  const history = store.history(project.id);
  assert.equal(history.length, 50, "the run index is bounded");
  assert.equal(history[0]!.runId, "run-54", "the newest runs are the ones kept");
});
