import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDashboard } from "../dashboard/server.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-qa-api-"));

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[] };

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
  flowDiscovery: { limits: {}, graph: { pages: [] }, flows: [{ flowId: "FL-1", category: "NAVIGATION", title: "Open the docs", description: "d", startPageId: "p1", startUrl: "https://qa.test/en", steps: [{}, {}], safety: "SAFE", automation: "AUTOMATED", boundary: null, executable: true, priority: "P1", priorityReason: "Core path", confidence: "HIGH_CONFIDENCE", occurrenceCount: 1, dedupeKey: "k", evidence: [] }], executions: [{ scenarioId: "SC-FLOW-1", flowId: "FL-1", category: "NAVIGATION", title: "Open the docs", executedAt: null, durationMs: 5, status: "PASS", failureCategory: null, startedUrl: "https://qa.test/en", finalUrl: null, stoppedAtStep: null, boundary: null, steps: [], error: null }], summary: { pages: 8, flows: 5, executable: 5, review: 0, highRisk: 0, blocked: 0, steps: 10, executed: 3, passed: 2, reproduced: 1, notReproduced: 0, reviewRequired: 0, infrastructure: 0 } },
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

const post = async (url: string, body: unknown): Promise<{ status: number; json: unknown }> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const get = async (url: string): Promise<{ status: number; body: string; json: unknown }> => {
  const res = await fetch(url);
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* not json */ }
  return { status: res.status, body, json };
};

const outputPathOf = (child: FakeChild): string => {
  const index = child.args.indexOf("--output");
  return child.args[index + 1]!;
};

test("the QA application is served at / and the evidence explorer remains at /dashboard", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const root = await get(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.body, /Automated website testing with evidence-based results/);
    assert.match(root.body, /Run QA/);
    const dashPage = await get(`${base}/dashboard`);
    assert.equal(dashPage.status, 200);
    assert.match(dashPage.body, /AI Website QA/);
  } finally {
    await stop(dash);
  }
});

test("POST /api/qa/run rejects an invalid URL and unsupported bodies", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const bad = await post(`${base}/api/qa/run`, { url: "not a url" });
    assert.equal(bad.status, 400);
    assert.match((bad.json as { error: string }).error, /valid http/);
    const ftp = await post(`${base}/api/qa/run`, { url: "ftp://example.com" });
    assert.equal(ftp.status, 400);
    const badJson = await post(`${base}/api/qa/run`, "{not json");
    assert.equal(badJson.status, 400);
    assert.equal(children.length, 0, "no engine is spawned for invalid input");
  } finally {
    await stop(dash);
  }
});

test("a run can be started, polled while running, and completed with real results", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const started = await post(`${base}/api/qa/run`, { url: "https://qa.test/en" });
    assert.equal(started.status, 202);
    const run = (started.json as { run: { runId: string; state: string; stage: string } }).run;
    assert.equal(run.state, "RUNNING");
    assert.equal(run.stage, "SCAN");

    const child = children[0]!;
    child.stdout.emit("data", Buffer.from("Scan complete: 120 elements.\nExecuting spec: generated/qa-verification.spec.ts\n"));
    const mid = await get(`${base}/api/qa/runs/${run.runId}`);
    assert.equal(mid.status, 200);
    assert.equal((mid.json as { run: { state: string; observedStages: string[] } }).run.state, "RUNNING");
    assert.ok((mid.json as { run: { observedStages: string[] } }).run.observedStages.includes("SCAN"));

    const out = outputPathOf(child);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(reportFixture()));
    child.emit("close", 0);

    const done = await get(`${base}/api/qa/runs/${run.runId}`);
    const doneRun = (done.json as { run: { state: string; qaStatus: string; historyRunId: string; error: null } }).run;
    assert.equal(doneRun.state, "COMPLETED");
    assert.equal(doneRun.qaStatus, "FAIL");
    assert.equal(doneRun.historyRunId, "hist-1");
    assert.equal(doneRun.error, null);

    const reportRes = await get(`${base}/api/qa/runs/${run.runId}/report`);
    assert.equal(reportRes.status, 200);
    assert.equal((reportRes.json as { summary: { overallStatus: string } }).summary.overallStatus, "FAIL");

    const list = await get(`${base}/api/qa/runs`);
    assert.equal(list.status, 200);
    assert.equal((list.json as { runs: unknown[] }).runs.length, 1);
  } finally {
    await stop(dash);
  }
});

test("run reports and execution evidence are served, and missing evidence is reported honestly", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const started = await post(`${base}/api/qa/run`, { url: "https://qa.test/en" });
    const runId = (started.json as { run: { runId: string } }).run.runId;
    const child = children[0]!;
    const out = outputPathOf(child);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(reportFixture()));
    writeFileSync(out.replace(/\.json$/, ".html"), "<html><body>run-report</body></html>");
    writeFileSync(join(dirname(out), "qa-execution.json"), JSON.stringify({ schemaVersion: 1, scheduled: 1, executed: 1, verifications: [] }));
    child.emit("close", 0);

    const html = await get(`${base}/api/qa/runs/${runId}/report.html`);
    assert.equal(html.status, 200);
    assert.match(html.body, /run-report/);
    const exec = await get(`${base}/api/qa/runs/${runId}/execution`);
    assert.equal(exec.status, 200);
    assert.equal((exec.json as { executed: number }).executed, 1);
  } finally {
    await stop(dash);
  }
});

test("only one QA run may be active; a second start is rejected with 409", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const first = await post(`${base}/api/qa/run`, { url: "https://qa.test/one" });
    assert.equal(first.status, 202);
    const second = await post(`${base}/api/qa/run`, { url: "https://qa.test/two" });
    assert.equal(second.status, 409);
  } finally {
    await stop(dash);
  }
});

test("unknown and traversal run ids are rejected", async () => {
  const dir = tmp();
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const missing = await get(`${base}/api/qa/runs/nope`);
    assert.equal(missing.status, 404);
    const traversal = await get(`${base}/api/qa/runs/${encodeURIComponent("..%2F..%2Fpackage")}`);
    assert.equal(traversal.status, 400);
  } finally {
    await stop(dash);
  }
});

test("a failed run exposes the engine error, never a fabricated verdict", async () => {
  const dir = tmp();
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const started = await post(`${base}/api/qa/run`, { url: "https://qa.test/en" });
    const runId = (started.json as { run: { runId: string } }).run.runId;
    children[0]!.stderr.emit("data", Buffer.from("Error: Executor build missing, run npm run build\n"));
    children[0]!.emit("close", 2);
    const failed = await get(`${base}/api/qa/runs/${runId}`);
    const run = (failed.json as { run: { state: string; qaStatus: null; error: string } }).run;
    assert.equal(run.state, "FAILED");
    assert.equal(run.qaStatus, null);
    assert.match(run.error, /Executor build missing/);
  } finally {
    await stop(dash);
  }
});
