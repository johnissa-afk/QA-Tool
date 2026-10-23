import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_CONCURRENT_RUNS_LIMIT, RUN_STAGES, RunManager, parseMaxConcurrentRuns, stageFromLine, validateRunUrl } from "../dashboard/run-manager.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-runmanager-"));

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
  findings: [],
  summary: { overallStatus: "PASS", headline: "No problems found", issueCount: 0, scheduled: 0, executed: 0, reproduced: 0, notReproduced: 0, pass: 0 },
  history: { currentRunId: "run-abc", runsAvailable: 2 },
  ...overrides,
});

/** Builds a manager whose fake child we can drive, plus the captured spawner. */
const drivenManager = (): { mgr: RunManager; children: FakeChild[]; dir: string } => {
  const dir = tmp();
  const runsDir = join(dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const { spawnImpl, children } = fakeSpawner();
  const mgr = new RunManager({ projectRoot: process.cwd(), runsDir, historyDir: join(dir, "history"), spawnImpl });
  return { mgr, children, dir };
};

const outputPathOf = (child: FakeChild): string => {
  const index = child.args.indexOf("--output");
  return child.args[index + 1]!;
};

const writeReport = (child: FakeChild, report: object): void => {
  const out = outputPathOf(child);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report));
};

// --- URL validation --------------------------------------------------------

test("validateRunUrl accepts http and https urls and normalizes them", () => {
  assert.equal(validateRunUrl("https://example.com"), "https://example.com/");
  assert.equal(validateRunUrl("  http://example.com/path "), "http://example.com/path");
});

test("validateRunUrl rejects empty, non-string, non-http, and malformed targets", () => {
  assert.equal(validateRunUrl(""), null);
  assert.equal(validateRunUrl("   "), null);
  assert.equal(validateRunUrl(undefined), null);
  assert.equal(validateRunUrl(42), null);
  assert.equal(validateRunUrl("ftp://example.com"), null);
  assert.equal(validateRunUrl("not a url"), null);
  assert.equal(validateRunUrl("javascript:alert(1)"), null);
});

// --- Stage derivation ------------------------------------------------------

test("stageFromLine maps real CLI markers to lifecycle stages", () => {
  assert.equal(stageFromLine("Access: ALLOWED — authentication none — continue scan true — human review false."), "ACCESS");
  assert.equal(stageFromLine("Access prerequisite:"), "ACCESS");
  assert.equal(stageFromLine("Scan complete: 120 elements, 40 interactive, HTTP 200 (0 failures, 1 warnings)."), "SCAN");
  assert.equal(stageFromLine("Crawl complete: 8 page(s) discovered (limits: 25 pages, depth 2, actions 40)."), "SCAN");
  assert.equal(stageFromLine("Flows: 20 discovered (20 executable, 0 review, 0 high-risk, 0 blocked) on 8 page(s)."), "SCAN");
  assert.equal(stageFromLine("Generated suite: 12 scenarios (8 automated, 3 review, 1 high-risk, 0 conditional)."), "ANALYZE");
  assert.equal(stageFromLine("Generating element suite spec: generated/generated-tests.spec.ts"), "GENERATE");
  assert.equal(stageFromLine("Executing spec: generated/qa-verification.spec.ts"), "EXECUTE");
  assert.equal(stageFromLine("Verification: 1 finding(s) scheduled, 0 skipped."), "VERIFY");
  assert.equal(stageFromLine("Coverage:"), "COVERAGE");
  assert.equal(stageFromLine("History: run 2026-... persisted to reports/history (3 run(s) for this site)."), "HISTORY");
  assert.equal(stageFromLine("QA status: PASS — No problems found"), "COMPLETE");
});

test("stageFromLine ignores unrelated engine output", () => {
  assert.equal(stageFromLine("Configuration: defaults"), null);
  assert.equal(stageFromLine("  scheduled: 1"), null);
  assert.equal(stageFromLine(""), null);
});

test("the stage list contains the required stages in display order", () => {
  // Display order is the order the engine really runs in. The engine builds the
  // scenario suite before analyzing it, so Generate precedes Analyze.
  assert.deepEqual([...RUN_STAGES], ["SCAN", "ACCESS", "GENERATE", "ANALYZE", "EXECUTE", "VERIFY", "COVERAGE", "HISTORY", "COMPLETE"]);
});

// --- Run lifecycle ---------------------------------------------------------

test("start rejects an invalid URL and never spawns a child", () => {
  const { mgr, children } = drivenManager();
  const result = mgr.start("nonsense");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /valid http/);
  }
  assert.equal(children.length, 0);
});

test("start launches the real CLI and reports the initial SCAN stage", () => {
  const { mgr, children } = drivenManager();
  const result = mgr.start("https://qa.test/en");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.run.state, "RUNNING");
  assert.equal(result.run.stage, "SCAN");
  assert.equal(result.run.url, "https://qa.test/en");
  assert.equal(children.length, 1);
  // The engine is invoked as the same CLI a developer would run.
  assert.ok(children[0]!.args.some((a) => a.endsWith(join("src", "qa-cli.ts"))));
  assert.ok(children[0]!.args.includes("--execute"));
  assert.ok(outputPathOf(children[0]!).endsWith("qa-analysis.json"));
});

test("only one run may be active at a time", () => {
  const { mgr } = drivenManager();
  assert.equal(mgr.start("https://qa.test/one").ok, true);
  const second = mgr.start("https://qa.test/two");
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.status, 409);
});

test("a completed run adopts the real QA status from its report artifact", () => {
  const { mgr, children } = drivenManager();
  const result = mgr.start("https://qa.test/en");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const child = children[0]!;
  writeReport(child, reportFixture());
  child.emit("close", 0);
  const run = mgr.get(result.run.runId)!;
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.stage, "COMPLETE");
  assert.equal(run.qaStatus, "PASS");
  assert.equal(run.headline, "No problems found");
  assert.equal(run.historyRunId, "run-abc");
  assert.equal(run.error, null);
});

test("an access-blocked run keeps the REVIEW verdict from its report", () => {
  const { mgr, children } = drivenManager();
  const result = mgr.start("https://protected.test/");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  writeReport(children[0]!, reportFixture({
    accessPrerequisite: { type: "authentication-required", status: "REVIEW_REQUIRED", message: "Login required." },
    summary: { overallStatus: "REVIEW", headline: "Human review required", issueCount: 0 },
  }));
  children[0]!.emit("close", 0);
  const run = mgr.get(result.run.runId)!;
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.qaStatus, "REVIEW");
});

test("a run that writes no report fails honestly and never reports PASS", () => {
  const { mgr, children } = drivenManager();
  const result = mgr.start("https://qa.test/en");
  if (!result.ok) return;
  children[0]!.stderr.emit("data", Buffer.from("Error: browser launch failed: executable does not exist\n"));
  children[0]!.emit("close", 2);
  const run = mgr.get(result.run.runId)!;
  assert.equal(run.state, "FAILED");
  assert.equal(run.qaStatus, null);
  assert.match(run.error ?? "", /browser launch failed/);
});

test("observed stages advance from real engine output and lock at COMPLETE", () => {
  const { mgr, children } = drivenManager();
  const result = mgr.start("https://qa.test/en");
  if (!result.ok) return;
  const child = children[0]!;
  const emit = (line: string): void => { child.stdout.emit("data", Buffer.from(line + "\n")); };
  emit("Access prerequisite: not required");
  emit("Scan complete: 10 elements.");
  emit("Generated suite: 3 scenarios.");
  emit("Executing spec: generated/qa-verification.spec.ts");
  emit("Coverage:");
  emit("History: run persisted.");
  emit("QA status: PASS — clean");
  emit("Findings: 0 issue groups.");
  const run = mgr.get(result.run.runId)!;
  assert.equal(run.stage, "COMPLETE");
  // SCAN is observed from the start, ACCESS from its own line. "Generated
  // suite" is stdout-only text, so the fallback attributes it to the ANALYZE
  // phase that follows; the authoritative GENERATE stage comes from the
  // structured sidecar, not from parsing human output.
  for (const stage of ["SCAN", "ACCESS", "ANALYZE", "EXECUTE", "COVERAGE", "HISTORY", "COMPLETE"]) {
    assert.ok(run.observedStages.includes(stage as (typeof RUN_STAGES)[number]), `expected observed stage ${stage}`);
  }
});

test("after a run finishes a new run can start", () => {
  const { mgr, children } = drivenManager();
  const first = mgr.start("https://qa.test/one");
  if (!first.ok) return;
  writeReport(children[0]!, reportFixture());
  children[0]!.emit("close", 0);
  assert.equal(mgr.activeRun(), null);
  assert.equal(mgr.start("https://qa.test/two").ok, true);
  assert.equal(children.length, 2);
});

test("get sanitizes run ids so traversal can never resolve a run", () => {
  const { mgr } = drivenManager();
  const result = mgr.start("https://qa.test/en");
  if (!result.ok) return;
  assert.equal(mgr.get("../../package"), null);
  assert.ok(mgr.get(result.run.runId));
});


// --- Concurrent runs ------------------------------------------------------------

const concurrentManager = (maxConcurrentRuns: number): { mgr: RunManager; children: FakeChild[] } => {
  const dir = tmp();
  const runsDir = join(dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const { spawnImpl, children } = fakeSpawner();
  return { mgr: new RunManager({ projectRoot: process.cwd(), runsDir, historyDir: join(dir, "history"), spawnImpl, maxConcurrentRuns }), children };
};

test("the default stays one run at a time, with the original message", () => {
  const { mgr } = drivenManager();
  assert.equal(mgr.start("https://qa.test/one").ok, true);
  const second = mgr.start("https://qa.test/two");
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /A QA run is already in progress \(web-/);
});

test("parseMaxConcurrentRuns defaults to 1 and clamps to the supported range", () => {
  assert.equal(parseMaxConcurrentRuns(undefined), 1);
  assert.equal(parseMaxConcurrentRuns(""), 1);
  assert.equal(parseMaxConcurrentRuns("abc"), 1);
  assert.equal(parseMaxConcurrentRuns(0), 1);
  assert.equal(parseMaxConcurrentRuns(-3), 1);
  assert.equal(parseMaxConcurrentRuns(2.5), 1);
  assert.equal(parseMaxConcurrentRuns("2"), 2);
  assert.equal(parseMaxConcurrentRuns(3), 3);
  assert.equal(parseMaxConcurrentRuns(99), MAX_CONCURRENT_RUNS_LIMIT);
});

test("with a limit of 2, two different sites run together and a third is refused", () => {
  const { mgr, children } = concurrentManager(2);
  const a = mgr.start("https://qa.test/a", "prj-a");
  const b = mgr.start("https://qa.test/b", "prj-b");
  assert.equal(a.ok && b.ok, true);
  assert.equal(children.length, 2);
  assert.equal(mgr.activeRuns().length, 2);
  const outputs = children.map(outputPathOf);
  assert.notEqual(outputs[0], outputs[1], "each run writes to its own report directory");
  const third = mgr.start("https://qa.test/c");
  assert.equal(third.ok, false);
  if (!third.ok) { assert.equal(third.status, 409); assert.match(third.error, /limit of 2 concurrent QA runs/); }
  assert.equal(children.length, 2, "a refused run never spawns a child");
});

test("the same website never runs twice at once, even with spare capacity", () => {
  const { mgr, children } = concurrentManager(3);
  assert.equal(mgr.start("https://qa.test/a").ok, true);
  const again = mgr.start("https://qa.test/a");
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.error, /for this website is already in progress/);
  assert.equal(children.length, 1);
});

test("runForProject finds a project's run even when it is not the newest active run", () => {
  const { mgr } = concurrentManager(2);
  mgr.start("https://qa.test/a", "prj-a");
  mgr.start("https://qa.test/b", "prj-b");
  assert.equal(mgr.activeRun()?.projectId, "prj-b", "activeRun() is still just the newest active run");
  assert.equal(mgr.runForProject("prj-a")?.url, "https://qa.test/a");
  assert.equal(mgr.runForProject("prj-b")?.url, "https://qa.test/b");
  assert.equal(mgr.runForProject("prj-missing"), null);
});

test("when one of two concurrent runs finishes, capacity frees up and the other keeps running", () => {
  const { mgr, children } = concurrentManager(2);
  mgr.start("https://qa.test/a");
  mgr.start("https://qa.test/b");
  writeReport(children[0]!, reportFixture());
  children[0]!.emit("close", 0);
  assert.equal(mgr.activeRuns().length, 1);
  assert.equal(mgr.activeRuns()[0]!.url, "https://qa.test/b");
  assert.equal(mgr.start("https://qa.test/c").ok, true);
  assert.equal(mgr.activeRuns().length, 2);
});
