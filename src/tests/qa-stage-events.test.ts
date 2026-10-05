// ---------------------------------------------------------------------------
// Structured QA stage events.
//
// The run reports its own progress: every real boundary in the pipeline emits
// `started` and then `completed` (or `failed`), on a sidecar channel that
// leaves the human-readable CLI output untouched. These tests cover the
// emitter, the file channel, the dashboard consumer, and one real CLI run.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectIssues, groupIssues } from "../checks.js";
import type { DiscoveredElement, ScanReport } from "../types.js";
import { QaStageEmitter, parseStageEvent, safeStageErrorMessage, STAGE_EVENT_FILENAME, createStageEventEmitter, QA_STAGES, buildStageView, runningStageOf, type QaStageEvent } from "../qa/stages.js";
import { RunManager } from "../dashboard/run-manager.js";

const CLI_PATH = join(process.cwd(), "dist", "qa-cli.js");
const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const collect = (): { events: QaStageEvent[]; emitter: QaStageEmitter } => {
  const events: QaStageEvent[] = [];
  const emitter = new QaStageEmitter();
  emitter.on(event => events.push(event));
  return { events, emitter };
};

const isIsoTimestamp = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));

/** Parses a whole sidecar channel, refusing to silently drop a bad line. */
const readEvents = (path: string): QaStageEvent[] => {
  const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => parseStageEvent(line));
  for (const [index, event] of events.entries()) {
    assert.ok(event, `line ${index + 1} of the event channel is not a valid event`);
  }
  return events as QaStageEvent[];
};

// --- The emitter ------------------------------------------------------------

test("stage events carry the stage, state and a real timestamp", () => {
  const { events, emitter } = collect();
  emitter.started("generate");
  emitter.completed("generate");

  assert.deepEqual(events.map(event => [event.stage, event.state]), [["generate", "started"], ["generate", "completed"]]);
  for (const event of events) {
    assert.ok(isIsoTimestamp(event.timestamp), `expected a real timestamp, got ${String(event.timestamp)}`);
    assert.equal(event.error, undefined);
  }
  // Started precedes completed, and the two times are not invented.
  assert.ok(Date.parse(events[1].timestamp) >= Date.parse(events[0].timestamp));
});

test("every stage in the pipeline can be reported", () => {
  const { events, emitter } = collect();
  for (const stage of QA_STAGES) {
    emitter.started(stage);
    emitter.completed(stage);
  }
  assert.equal(events.length, QA_STAGES.length * 2);
  // The tracker order is the order the unchanged engine really runs in: the
  // scenario suite has to exist before it can be analyzed, so Generate comes
  // before Analyze here.
  assert.deepEqual(QA_STAGES, ["scan", "access", "generate", "analyze", "execute", "verify", "coverage", "history", "complete"]);
});

test("the stage order matches the order a real run actually emits", { timeout: 180000 }, () => {
  // Guards the list above against the engine drifting. Uses the same offline
  // --report fixture as the other real-CLI test, so no network is involved.
  // A --report run reuses an existing scan, so "scan" is legitimately absent.
  const dir = tmp("ai-website-qa-stage-order-");
  try {
    const fixture = join(dir, "fixture.json");
    writeFileSync(fixture, JSON.stringify(reportFixture()), "utf8");
    const output = join(dir, "out", "qa-analysis.json");
    const result = spawnSync(process.execPath, [CLI_PATH, "--report", fixture, "--output", output, "--history-dir", join(dir, "history")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 170000,
      env: { ...process.env, AI_API_KEY: "", QA_USERNAME: "", QA_PASSWORD: "", QA_AUTHORIZATION: "" },
    });
    assert.equal(result.status, 0, `CLI run failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);

    const observed = readEvents(join(dir, "out", STAGE_EVENT_FILENAME)).map(event => event.stage);
    // Every stage the run reported appears in the declared order, and the
    // tracker list is exactly that order minus the stages this run skipped.
    const order = QA_STAGES as readonly string[];
    const positions = observed.map(stage => order.indexOf(stage));
    assert.ok(!positions.includes(-1), `a stage is missing from QA_STAGES: ${observed.join(", ")}`);
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i - 1]! <= positions[i]!, `stages arrived out of declared order: ${observed.join(" → ")}`);
    }
    // The ordering fact the tracker depends on: the suite is generated before
    // it is analyzed, so Generate must precede Analyze.
    assert.ok(observed.indexOf("generate") < observed.indexOf("analyze"), "generate must run before analyze");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed stage reports the state and a redacted error", () => {
  const { events, emitter } = collect();
  emitter.failed("coverage", new Error("coverage failed: token=sk-live-SECRETVALUE123"));

  const [event] = events;
  assert.equal(event.stage, "coverage");
  assert.equal(event.state, "failed");
  assert.ok(isIsoTimestamp(event.timestamp));
  assert.ok(event.error, "a failed event must carry an error message");
  assert.ok(!event.error!.includes("SECRETVALUE123"), `error was not redacted: ${event.error}`);
  assert.match(event.error!, /token=\*\*\*/);
});

test("a failure message is redacted against the real environment secrets", () => {
  const previous = process.env.QA_PASSWORD;
  process.env.QA_PASSWORD = "hunter2-unique-secret";
  try {
    const { events, emitter } = collect();
    emitter.failed("execute", new Error("login failed for hunter2-unique-secret"));
    assert.ok(!events[0].error!.includes("hunter2-unique-secret"), `error leaked a credential: ${events[0].error}`);
  } finally {
    if (previous === undefined) delete process.env.QA_PASSWORD;
    else process.env.QA_PASSWORD = previous;
  }
});

test("safeStageErrorMessage bounds and redacts arbitrary thrown values", () => {
  assert.ok(!safeStageErrorMessage("api_key=sk-abcdef123456").includes("sk-abcdef123456"));
  assert.equal(safeStageErrorMessage("   "), "Unknown stage failure.");
  assert.ok(safeStageErrorMessage("x".repeat(5000)).length <= 1000);
});

test("run() brackets the work with started and completed", async () => {
  const { events, emitter } = collect();
  const value = await emitter.run("analyze", () => "result");

  assert.equal(value, "result");
  assert.deepEqual(events.map(event => event.state), ["started", "completed"]);
});

test("run() reports a failure and still propagates the original error", async () => {
  const { events, emitter } = collect();
  const boom = new Error("scan failed");
  await assert.rejects(() => emitter.run("scan", () => { throw boom; }), /scan failed/);

  assert.deepEqual(events.map(event => event.state), ["started", "failed"]);
  assert.equal(events[1].error, "scan failed");
});

test("listeners are notified in order and a broken one cannot break the run", () => {
  const seen: string[] = [];
  const emitter = new QaStageEmitter();
  emitter.on(() => { seen.push("first"); throw new Error("listener exploded"); });
  emitter.on(() => seen.push("second"));
  emitter.started("history");

  assert.deepEqual(seen, ["first", "second"]);
});

// --- The sidecar channel ---------------------------------------------------

test("the event channel is an NDJSON sidecar that parses back", () => {
  const dir = tmp("ai-website-qa-stages-");
  try {
    const path = join(dir, "nested", STAGE_EVENT_FILENAME);
    const emitter = createStageEventEmitter(path);
    emitter.started("scan");
    emitter.completed("scan");

    const events = readEvents(path);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.stage), ["scan", "scan"]);
    assert.deepEqual(events.map(event => event.state), ["started", "completed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed or partially written event line is skipped, not thrown on", () => {
  assert.equal(parseStageEvent(""), null);
  assert.equal(parseStageEvent("   "), null);
  assert.equal(parseStageEvent("not json"), null);
  assert.equal(parseStageEvent("[1,2,3]"), null);
  assert.equal(parseStageEvent(JSON.stringify({ stage: "nope", state: "started", timestamp: "2026-01-01T00:00:00.000Z" })), null);
  assert.equal(parseStageEvent(JSON.stringify({ stage: "scan", state: "invented", timestamp: "2026-01-01T00:00:00.000Z" })), null);
  assert.equal(parseStageEvent(JSON.stringify({ stage: "scan", state: "started" })), null);
  // A truncated line is exactly what a partially flushed write looks like.
  assert.equal(parseStageEvent('{"stage":"scan","sta'), null);

  const event = parseStageEvent(JSON.stringify({ stage: "verify", state: "failed", timestamp: "2026-01-01T00:00:00.000Z", error: "boom" }));
  assert.equal(event?.error, "boom");
  // A completed event never carries a stale error field.
  const done = parseStageEvent(JSON.stringify({ stage: "verify", state: "completed", timestamp: "2026-01-01T00:00:00.000Z", error: "boom" }));
  assert.equal(done?.error, undefined);
});

// --- The dashboard consumer ------------------------------------------------

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

const drivenManager = (): { mgr: RunManager; children: FakeChild[] } => {
  const runsDir = join(tmp("ai-website-qa-stagemgr-"), "runs");
  mkdirSync(runsDir, { recursive: true });
  const { spawnImpl, children } = fakeSpawner();
  return { mgr: new RunManager({ projectRoot: process.cwd(), runsDir, historyDir: join(runsDir, "history"), spawnImpl }), children };
};

const stagePathOf = (child: FakeChild): string => join(dirname(child.args[child.args.indexOf("--output") + 1]), STAGE_EVENT_FILENAME);

const appendEvents = (child: FakeChild, events: QaStageEvent[]): void => {
  const path = stagePathOf(child);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map(event => `${JSON.stringify(event)}\n`).join(""), "utf8");
};

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

test("run manager consumes real stage events into the run it is tracking", () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  assert.equal(started.ok, true);
  const child = children[0];

  appendEvents(child, [
    { stage: "scan", state: "started", timestamp: at(1) },
    { stage: "scan", state: "completed", timestamp: at(2) },
    { stage: "access", state: "started", timestamp: at(3) },
    { stage: "access", state: "completed", timestamp: at(4) },
  ]);
  child.stdout.emit("data", "Scan complete: 12 elements\n");

  const run = mgr.get(started.ok ? started.run.runId : "");
  assert.equal(run?.currentStage, "access");
  assert.equal(run?.stageState, "completed");
  assert.deepEqual(run?.stageHistory.map(event => [event.stage, event.state]), [
    ["scan", "started"], ["scan", "completed"], ["access", "started"], ["access", "completed"],
  ]);
  assert.equal(run?.stage, "ACCESS");
  assert.ok(run?.observedStages.includes("SCAN"));
  assert.ok(isIsoTimestamp(run?.startedAt));
});

test("generate is tracked as its own real stage, not lumped into another", () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  const child = children[0];

  appendEvents(child, [
    { stage: "analyze", state: "completed", timestamp: at(1) },
    { stage: "generate", state: "started", timestamp: at(2) },
  ]);
  child.stdout.emit("data", "Generated suite: 240 scenarios\n");

  let run = mgr.get(started.ok ? started.run.runId : "");
  assert.equal(run?.currentStage, "generate");
  assert.equal(run?.stageState, "started");
  assert.equal(run?.stage, "GENERATE");

  appendEvents(child, [{ stage: "generate", state: "completed", timestamp: at(3) }]);
  child.stdout.emit("data", "x\n");
  run = mgr.get(started.ok ? started.run.runId : "");
  assert.equal(run?.stageState, "completed");
  assert.ok(run?.stageHistory.some(event => event.stage === "generate" && event.state === "started"));
  assert.ok(run?.stageHistory.some(event => event.stage === "generate" && event.state === "completed"));
});

test("a failing stage is reported as failed with its error", () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  const child = children[0];

  appendEvents(child, [
    { stage: "execute", state: "started", timestamp: at(1) },
    { stage: "execute", state: "failed", timestamp: at(2), error: "browser closed unexpectedly" },
  ]);
  child.stdout.emit("data", "Executing spec: generated/qa.spec.ts\n");

  const run = mgr.get(started.ok ? started.run.runId : "");
  assert.equal(run?.currentStage, "execute");
  assert.equal(run?.stageState, "failed");
  assert.equal(run?.stage, "EXECUTE");
  assert.equal(run?.state, "RUNNING", "a failed stage is not the same as a failed run");
  assert.equal(run?.stageHistory.at(-1)?.error, "browser closed unexpectedly");
});

test("stage events take precedence over log text once the engine reports them", () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  const child = children[0];

  appendEvents(child, [{ stage: "history", state: "started", timestamp: at(1) }]);
  // A stray log line that would otherwise look like a much later stage.
  child.stdout.emit("data", "QA status: PASS — nothing to see here\n");

  const run = mgr.get(started.ok ? started.run.runId : "");
  assert.equal(run?.currentStage, "history");
  assert.equal(run?.stage, "HISTORY");
});

test("log text still drives progress when the engine reports no events", () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  const child = children[0];

  child.stdout.emit("data", "Scan complete: 12 elements\n");
  child.stdout.emit("data", "Generated suite: 4 scenarios (2 automated, 2 review).\n");

  const run = mgr.get(started.ok ? started.run.runId : "");
  assert.deepEqual(run?.stageHistory, [], "no events means no invented history");
  assert.equal(run?.currentStage, null);
  assert.equal(run?.stageState, null);
  assert.ok(run?.observedStages.includes("SCAN"));
  assert.ok(run?.observedStages.includes("ANALYZE"));
});

test("a partially written event line is picked up once it is complete", () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  const child = children[0];
  const path = stagePathOf(child);
  mkdirSync(dirname(path), { recursive: true });

  const full = `${JSON.stringify({ stage: "coverage", state: "started", timestamp: at(1) })}\n`;
  writeFileSync(path, full.slice(0, 20), "utf8");
  child.stdout.emit("data", "tick\n");
  assert.equal(mgr.get(started.ok ? started.run.runId : "")?.stageHistory.length, 0);

  writeFileSync(path, full, "utf8");
  child.stdout.emit("data", "tick\n");
  const run = mgr.get(started.ok ? started.run.runId : "");
  assert.deepEqual(run?.stageHistory.map(event => event.stage), ["coverage"]);
});

test("events already written before the run is polled are still reported", async () => {
  const { mgr, children } = drivenManager();
  const started = mgr.start("https://qa.test/en");
  const child = children[0];
  appendEvents(child, [
    { stage: "scan", state: "completed", timestamp: at(1) },
    { stage: "access", state: "completed", timestamp: at(2) },
    { stage: "generate", state: "completed", timestamp: at(3) },
    { stage: "complete", state: "completed", timestamp: at(4) },
  ]);

  // No stdout at all: the event channel alone must carry the run.
  await new Promise(resolve => setTimeout(resolve, 400));
  const run = mgr.get(started.ok ? started.run.runId : "");
  assert.equal(run?.currentStage, "complete");
  assert.equal(run?.stageState, "completed");
  assert.equal(run?.stage, "COMPLETE");
  assert.equal(run?.stageHistory.length, 4);
});

test("the run API exposes the current stage, its state, and the stage history", async () => {
  const dir = tmp("ai-website-qa-stageapi-");
  const { spawnImpl, children } = fakeSpawner();
  const { startDashboard } = await import("../dashboard/server.js");
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    projectRoot: process.cwd(),
    spawnImpl,
  });
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const started = await fetch(`${base}/api/qa/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://qa.test/en" }) });
    assert.equal(started.status, 202);
    const child = children[0];
    appendEvents(child, [
      { stage: "scan", state: "started", timestamp: at(1) },
      { stage: "scan", state: "completed", timestamp: at(2) },
      { stage: "generate", state: "started", timestamp: at(3) },
    ]);
    child.stdout.emit("data", "Scan complete: 1 element\n");

    const runId = (await started.json() as { run: { runId: string } }).run.runId;
    const response = await fetch(`${base}/api/qa/runs/${runId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { run: Record<string, unknown> };

    assert.equal(body.run.currentStage, "generate");
    assert.equal(body.run.stageState, "started");
    const history = body.run.stageHistory as QaStageEvent[];
    assert.deepEqual(history.map(event => `${event.stage}:${event.state}`), ["scan:started", "scan:completed", "generate:started"]);
    for (const event of history) assert.ok(isIsoTimestamp(event.timestamp));
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

// --- A real CLI run --------------------------------------------------------

const element = (): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null,
  type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null,
  interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high",
});

const reportFixture = (): ScanReport => {
  const elements = [element()];
  const issues = detectIssues(elements, { title: "Stage target", lang: "en", viewport: "width=device-width" });
  const grouped = groupIssues(issues);
  return {
    scan: { url: "https://qa-stages.test/en", finalUrl: "https://qa-stages.test/en", title: "Stage target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: 1, passes: 0, warnings: grouped.filter(issue => issue.status === "WARNING").length, failures: grouped.filter(issue => issue.status === "FAIL").length, infos: grouped.filter(issue => issue.status === "INFO").length, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: grouped.length, groupedIssueCounts: { passes: 0, warnings: grouped.filter(issue => issue.status === "WARNING").length, failures: grouped.filter(issue => issue.status === "FAIL").length, infos: grouped.filter(issue => issue.status === "INFO").length } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements, issues: grouped, links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
  };
};

test("a real CLI run reports every stage it actually reached, and stdout stays human-readable", { timeout: 180000 }, () => {
  assert.ok(existsSync(CLI_PATH), `the built CLI is required: ${CLI_PATH}`);
  const dir = tmp("ai-website-qa-stagecli-");
  try {
    const fixture = join(dir, "fixture.json");
    writeFileSync(fixture, JSON.stringify(reportFixture()), "utf8");
    const output = join(dir, "out", "qa-analysis.json");

    const result = spawnSync(process.execPath, [CLI_PATH, "--report", fixture, "--output", output, "--history-dir", join(dir, "history")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 170000,
      env: { ...process.env, AI_API_KEY: "", QA_USERNAME: "", QA_PASSWORD: "", QA_AUTHORIZATION: "" },
    });
    const stdout = result.stdout ?? "";
    assert.equal(result.status, 0, `CLI run failed:\n${stdout}\n${result.stderr ?? ""}`);

    // The normal human output is intact.
    assert.match(stdout, /Generated suite: \d+ scenarios/);
    assert.match(stdout, /QA status: /);

    // The structured channel carries the real progression, separately.
    const eventPath = join(dir, "out", STAGE_EVENT_FILENAME);
    assert.ok(existsSync(eventPath), `expected a stage event sidecar at ${eventPath}`);
    const events = readEvents(eventPath);
    assert.ok(events.length > 0);

    // Nothing leaked onto stdout: the channel is not human output.
    for (const line of stdout.split(/\r?\n/)) assert.equal(parseStageEvent(line), null, `stage events must not pollute stdout: ${line}`);

    const reached = events.map(event => `${event.stage}:${event.state}`);
    for (const stage of ["access", "generate", "analyze", "coverage", "history", "complete"]) {
      assert.ok(reached.includes(`${stage}:started`), `${stage} never reported that it started`);
      assert.ok(reached.includes(`${stage}:completed`), `${stage} never reported that it finished`);
    }
    assert.equal(reached.includes("scan:started"), false, "a --report run reuses an existing scan and does not run one");

    // Timestamps are real and move forward.
    for (const event of events) assert.ok(isIsoTimestamp(event.timestamp), `bad timestamp: ${String(event.timestamp)}`);
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(Date.parse(events[i].timestamp) >= Date.parse(events[i - 1].timestamp), "stage times must not go backwards");
    }

    // The last thing the run reports is that it finished.
    assert.equal(events.at(-1)?.stage, "complete");
    assert.equal(events.at(-1)?.state, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Logical stage view — the tracker a person actually reads
// ---------------------------------------------------------------------------

const logical = (events: QaStageEvent[]): Map<string, { state: string; windows: number }> => {
  const view = new Map<string, { state: string; windows: number }>();
  for (const stage of buildStageView(events)) view.set(stage.stage, { state: stage.state, windows: stage.windows });
  return view;
};

const ev = (stage: string, state: "started" | "completed" | "failed", extra: Partial<QaStageEvent> = {}): QaStageEvent =>
  ({ stage, state, timestamp: `2026-01-01T00:00:0${Math.floor(Math.random() * 9)}.000Z`, ...extra }) as QaStageEvent;

test("a stage that never ran stays pending and is still listed in order", () => {
  const view = logical([ev("scan", "started"), ev("scan", "completed")]);
  assert.equal(view.get("scan")?.state, "completed");
  assert.equal(view.get("access")?.state, "pending");
  // Every declared stage is present, so the tracker has a fixed shape.
  assert.equal(buildStageView([]).length, QA_STAGES.length);
  assert.deepEqual(buildStageView([]).map(stage => stage.stage), [...QA_STAGES]);
});

test("a stage that runs twice stays one completed chip instead of flickering back to running", () => {
  // This is the real shape of an --execute run: the scenario suite, then the
  // verification spec, both under Generate.
  const events = [
    ev("scan", "started"), ev("scan", "completed"),
    ev("access", "started"), ev("access", "completed"),
    ev("generate", "started"), ev("generate", "completed"),
    ev("analyze", "started"),
    ev("generate", "started"), ev("generate", "completed"),
    ev("analyze", "completed"),
  ];
  const view = logical(events);
  assert.equal(view.get("generate")?.state, "completed", "the second Generate window must not regress the chip");
  assert.equal(view.get("generate")?.windows, 2, "both real windows are still counted");
  // Both raw events survive, so nothing was hidden from the history.
  assert.equal(events.filter(event => event.stage === "generate" && event.state === "started").length, 2);
  // A stage that never restarted is unaffected.
  assert.equal(view.get("scan")?.windows, 1);
});

test("a failure always shows, even on a stage that had already completed", () => {
  const events = [
    ev("generate", "started"),
    ev("generate", "completed"),
    ev("analyze", "started"),
    ev("generate", "started"),
    ev("generate", "failed", { error: "spec generation failed" }),
  ];
  const view = buildStageView(events);
  const generate = view.find(stage => stage.stage === "generate")!;
  assert.equal(generate.state, "failed", "a failure is new information and must not be swallowed");
  assert.equal(generate.error, "spec generation failed");
  assert.equal(generate.windows, 2);
});

test("runningStageOf reports the stage doing work, not one that already finished", () => {
  assert.equal(runningStageOf([ev("scan", "started"), ev("scan", "completed")]), null);
  assert.equal(runningStageOf([ev("scan", "started")]), "scan");
  // Generate reopened behind Analyze: the live stage is the one still running.
  const events = [
    ev("generate", "started"), ev("generate", "completed"),
    ev("analyze", "started"),
    ev("generate", "started"),
  ];
  assert.equal(runningStageOf(events), "analyze");
});

test("the logical view never invents a timestamp", () => {
  const view = buildStageView([ev("scan", "started")]);
  const scan = view.find(stage => stage.stage === "scan")!;
  assert.ok(isIsoTimestamp(scan.startedAt!));
  assert.equal(scan.completedAt, null, "a running stage has no completion time to report");
  assert.equal(scan.failedAt, null);
});
