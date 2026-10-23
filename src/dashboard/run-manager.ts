// ---------------------------------------------------------------------------
// Phase 12 — dashboard run manager.
//
// Starts a REAL QA run by invoking the existing QA CLI (src/qa-cli.ts) as a
// child process. The engine is not reimplemented, reconfigured or duplicated
// here: the dashboard runs the exact command a developer would type, so the web
// UI and the CLI can never drift apart and every result is the same evidence
// artifact the CLI produces.
//
// Progress is real, not simulated. The engine reports its own stage transitions
// as structured events on a sidecar channel, which this manager consumes; the
// finished QA status is read from the report artifact the run wrote, never
// assumed from the process exit code.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { QaAnalysis } from "../ai/types.js";
import { parseStageEvent, runningStageOf, buildStageView, QA_STAGES, STAGE_EVENT_FILENAME, type LogicalStage, type QaStage, type QaStageEvent, type QaStageState } from "../qa/stages.js";

/** Real lifecycle stages, in the order the engine runs them. */
export type RunStage = Uppercase<QaStage>;

/**
 * Display order for the stage tracker, taken straight from the engine's own
 * stage list so the UI can never drift from the pipeline it is reporting.
 */
export const RUN_STAGES: readonly RunStage[] = QA_STAGES.map(stage => stage.toUpperCase() as RunStage) as readonly RunStage[];

/** Tracker entry for each engine-emitted stage, so both views stay in step. */
const RUN_STAGE_BY_QA_STAGE: Record<QaStage, RunStage> = Object.fromEntries(
  QA_STAGES.map(stage => [stage, stage.toUpperCase() as RunStage]),
) as Record<QaStage, RunStage>;

/** How often the sidecar event channel is drained. Polling reads real events
 *  only — no stage is ever synthesized, advanced, or timed by this timer. */
const STAGE_POLL_MS = 250;

/** Web run lifecycle — distinct from the QA verdict it produces. */
export type RunState = "RUNNING" | "COMPLETED" | "FAILED";

/** The only QA verdict values the engine can produce. */
export type QaStatus = "PASS" | "FAIL" | "REVIEW" | "BLOCKED" | "NOT_TESTED";

const QA_STATUSES: readonly string[] = ["PASS", "FAIL", "REVIEW", "BLOCKED", "NOT_TESTED"];

export type QaRun = {
  runId: string;
  url: string;
  state: RunState;
  stage: RunStage;
  /** Stages the engine has actually reported, in first-seen order. */
  observedStages: RunStage[];
  /** Last engine-emitted stage, and whether it is running, done, or failed. */
  currentStage: QaStage | null;
  stageState: QaStageState | null;
  /** Every real stage transition, in order, with the time it happened. */
  stageHistory: QaStageEvent[];
  /** The same history collapsed to one logical state per stage. */
  stageView: LogicalStage[];
  /** The stage the engine is actually working in right now, if any. */
  runningStage: QaStage | null;
  /** The saved project this run belongs to, when it was started from one. */
  projectId: string | null;
  /**
   * Scheduling metadata, present only when a scheduler launched this run. These
   * are labels, not behaviour: a scheduled run is the same run, the same CLI,
   * the same artifacts.
   */
  scheduleId: string | null;
  scheduledExecutionId: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Real verdict from the report artifact; null until the run finishes. */
  qaStatus: QaStatus | null;
  headline: string | null;
  /** Artifact paths (absolute) for the report/execution links. */
  artifacts: { reportJson: string; reportHtml: string; executionJson: string | null };
  /** Persisted history run id (the engine's own run id), when history ran. */
  historyRunId: string | null;
  /** Populated only when the run could not produce a report. */
  error: string | null;
  /** Tail of engine output, retained for diagnosing a failed run. */
  log: string[];
};

/**
 * Scheduling labels supplied when a scheduler launches a run. Both are optional
 * and neither changes how the run executes; they exist so a run can always be
 * traced back to the schedule slot that dispatched it.
 */
export type RunScheduling = {
  scheduleId?: string | null;
  scheduledExecutionId?: string | null;
};

export const MAX_CONCURRENT_RUNS_LIMIT = 4;

/** Parses a configured run limit; anything missing or invalid means the safe default of 1. */
export function parseMaxConcurrentRuns(raw: unknown): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_CONCURRENT_RUNS_LIMIT);
}

export type RunManagerOptions = {
  /** Project root that holds src/qa-cli.ts and node_modules. */
  projectRoot: string;
  /** Directory that receives this run's report artifacts. */
  runsDir: string;
  /** Shared run-history directory (the engine's --history-dir). */
  historyDir: string;
  /** Injectable child spawner; tests use it to avoid a real browser. */
  spawnImpl?: typeof spawn;
  /**
   * How many runs may be active at once (1..MAX_CONCURRENT_RUNS_LIMIT). Defaults to 1, which keeps
   * the original one-run-at-a-time behaviour. Every run already owns its own report directory,
   * generated specs, outcome files and Playwright output (qa/run-workspace.ts), so runs do not
   * share files; the limit exists to bound CPU and memory (each run drives real browsers).
   */
  maxConcurrentRuns?: number;
  /** Called once a run has been created, before the engine is polled. */
  onRunStarted?: (run: QaRun) => void;
  /**
   * Called when a run reaches a terminal state, with the report artifact the
   * engine actually wrote (null when it never produced one). This is the seam
   * the project layer uses, so project summaries come from the real result
   * rather than from anything the browser reported.
   */
  onRunSettled?: (run: QaRun, analysis: QaAnalysis | null) => void;
};

export type StartResult = { ok: true; run: QaRun } | { ok: false; status: 400 | 409; error: string };

/**
 * Real stdout markers emitted by the existing CLI, mapped to the stage they
 * report. Each matcher is anchored to distinctive wording from qa-cli.ts so a
 * stage is only shown after the engine actually reached it. The final status
 * line locks the stage at COMPLETE so trailing summary output cannot rewind it.
 */
const STAGE_MATCHERS: readonly { stage: RunStage; test: (line: string) => boolean }[] = [
  { stage: "ACCESS", test: line => line.startsWith("Access:") || line.startsWith("Access prerequisite:") || line.startsWith("Normal QA scan: not run") },
  { stage: "SCAN", test: line => line.startsWith("Scan complete:") || line.startsWith("Crawl complete:") || (line.startsWith("Flows:") && line.includes("executable")) },
  { stage: "ANALYZE", test: line => line.startsWith("Generated suite:") || line.startsWith("AI provider:") },
  { stage: "GENERATE", test: line => line.startsWith("Generating element suite spec:") },
  { stage: "EXECUTE", test: line => line.startsWith("Executing spec:") || line.startsWith("Executing verification spec:") },
  { stage: "VERIFY", test: line => line.startsWith("Verification:") || line.startsWith("Verification disposition:") || line.startsWith("Flow execution:") },
  { stage: "COVERAGE", test: line => line.startsWith("Coverage") },
  { stage: "HISTORY", test: line => line.startsWith("History:") || line.startsWith("Historical intelligence:") },
  { stage: "COMPLETE", test: line => line.startsWith("QA status:") || line.startsWith("JSON report:") },
];

/** Exported for tests: derive a stage from one line of engine output. */
export function stageFromLine(line: string): RunStage | null {
  const trimmed = line.trimStart();
  for (const matcher of STAGE_MATCHERS) if (matcher.test(trimmed)) return matcher.stage;
  return null;
}

const MAX_LOG_LINES = 200;

/** Normalizes and validates a target URL. Returns null when unusable. */
export function validateRunUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  url.hash = "";
  return url.href;
}

const sanitizeRunId = (runId: string): string => runId.replace(/[^A-Za-z0-9._-]/g, "");

/**
 * Starts and tracks QA runs. Each run owns its report directory and, inside the
 * engine, its own generated specs, outcome files and Playwright output, so runs
 * do not interfere with each other. `maxConcurrentRuns` (default 1) bounds how
 * many may be active at once; two runs of the same website are never active
 * together.
 */
export class RunManager {
  private readonly options: Required<Omit<RunManagerOptions, "spawnImpl" | "onRunStarted" | "onRunSettled" | "maxConcurrentRuns">> & Pick<RunManagerOptions, "spawnImpl" | "onRunStarted" | "onRunSettled">;
  private readonly runs = new Map<string, QaRun>();
  private readonly order: string[] = [];
  private readonly MAX_RUNS = 20;
  private readonly maxConcurrentRuns: number;
  /** Per-run read offset into the sidecar event channel. */
  private readonly stageCursor = new Map<string, number>();
  private readonly stageTimers = new Map<string, NodeJS.Timeout>();
  /** Live engine children, so shutdown never leaves a detached process behind. */
  private readonly children = new Map<string, ReturnType<typeof spawn>>();

  constructor(options: RunManagerOptions) {
    this.maxConcurrentRuns = parseMaxConcurrentRuns(options.maxConcurrentRuns);
    this.options = {
      projectRoot: resolve(options.projectRoot),
      runsDir: resolve(options.runsDir),
      historyDir: resolve(options.historyDir),
      spawnImpl: options.spawnImpl ?? spawn,
      onRunStarted: options.onRunStarted,
      onRunSettled: options.onRunSettled,
    };
  }

  /** The run currently executing, if any. */
  activeRun(): QaRun | null {
    for (const id of this.order) {
      const run = this.runs.get(id);
      if (run && run.state === "RUNNING") return run;
    }
    return null;
  }

  /** Every run currently executing, newest first. */
  activeRuns(): QaRun[] {
    return this.order
      .map(id => this.runs.get(id))
      .filter((run): run is QaRun => run !== undefined && run.state === "RUNNING");
  }

  /** The executing run that belongs to a project, if any. */
  runForProject(projectId: string): QaRun | null {
    return this.activeRuns().find(run => run.projectId === projectId) ?? null;
  }

  get(runId: string): QaRun | null {
    return this.runs.get(sanitizeRunId(runId)) ?? null;
  }

  list(): QaRun[] {
    return this.order
      .map((id) => this.runs.get(id))
      .filter((run): run is QaRun => run !== undefined);
  }

  start(rawUrl: unknown, projectId: string | null = null, scheduling: RunScheduling = {}): StartResult {
    const url = validateRunUrl(rawUrl);
    if (url === null) return { ok: false, status: 400, error: "Enter a valid http:// or https:// website URL." };

    const running = this.activeRuns();
    if (running.length >= this.maxConcurrentRuns) {
      return this.maxConcurrentRuns === 1
        ? { ok: false, status: 409, error: `A QA run is already in progress (${running[0]!.runId}). Wait for it to finish.` }
        : { ok: false, status: 409, error: `The limit of ${this.maxConcurrentRuns} concurrent QA runs is reached (${running.map(run => run.runId).join(", ")}). Wait for one to finish.` };
    }
    const sameSite = running.find(run => run.url === url);
    if (sameSite) return { ok: false, status: 409, error: `A QA run for this website is already in progress (${sameSite.runId}). Wait for it to finish.` };

    const runId = `web-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const runDir = join(this.options.runsDir, runId);
    const reportJson = join(runDir, "qa-analysis.json");
    const run: QaRun = {
      runId,
      url,
      state: "RUNNING",
      stage: "SCAN",
      observedStages: ["SCAN"],
      currentStage: null,
      stageState: null,
      stageHistory: [],
      stageView: buildStageView([]),
      runningStage: null,
      projectId: projectId ? sanitizeRunId(projectId) : null,
      scheduleId: scheduling.scheduleId ? sanitizeRunId(scheduling.scheduleId) : null,
      scheduledExecutionId: scheduling.scheduledExecutionId ? sanitizeRunId(scheduling.scheduledExecutionId) : null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      qaStatus: null,
      headline: null,
      // The HTML report path mirrors the engine's outputPath -> .html derivation.
      artifacts: { reportJson, reportHtml: reportJson.replace(/\.json$/, ".html"), executionJson: join(runDir, "qa-execution.json") },
      historyRunId: null,
      error: null,
      log: [],
    };
    this.runs.set(runId, run);
    this.order.unshift(runId);
    this.evict();
    this.options.onRunStarted?.(run);

    this.spawnRun(run);
    return { ok: true, run };
  }

  private spawnRun(run: QaRun): void {
    const cliPath = join(this.options.projectRoot, "src", "qa-cli.ts");
    const args = ["--import", "tsx", cliPath, run.url, "--execute", "--output", run.artifacts.reportJson, "--history-dir", this.options.historyDir];
    // The real CLI is what executes; spawnImpl exists so tests can substitute it.
    const spawner = this.options.spawnImpl ?? spawn;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawner(process.execPath, args, { cwd: this.options.projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.fail(run, error instanceof Error ? error.message : String(error));
      return;
    }
    this.children.set(run.runId, child);
    if (typeof child.once === "function") {
      child.once("close", () => {
        this.children.delete(run.runId);
      });
    }
    this.consume(child, run);
  }

  /**
   * Releases every timer and terminates any engine child that is still running.
   *
   * The scheduler calls this on shutdown so a stopped server never leaves a QA
   * process alive. Runs that already settled are untouched.
   */
  stop(): void {
    for (const timer of this.stageTimers.values()) clearInterval(timer);
    this.stageTimers.clear();
    for (const child of this.children.values()) {
      // A test double need not be a full ChildProcess, so a missing kill is
      // not a shutdown failure.
      if (typeof child.kill === "function") child.kill();
    }
    this.children.clear();
  }

  private consume(child: ReturnType<typeof spawn>, run: QaRun): void {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) this.ingest(run, line);
      // Pick up any events the engine wrote alongside that output.
      this.drainStageEvents(run);
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", error => this.fail(run, error instanceof Error ? error.message : String(error)));
    child.on("close", code => {
      if (run.state !== "RUNNING") return;
      if (stdoutBuffer.trim()) this.ingest(run, stdoutBuffer);
      this.complete(run, code ?? null, stderrBuffer);
    });
    this.watchStageEvents(run);
  }

  /** Sidecar channel the engine writes its stage transitions to. */
  private stageEventPath(run: QaRun): string {
    return join(dirname(run.artifacts.reportJson), STAGE_EVENT_FILENAME);
  }

  private watchStageEvents(run: QaRun): void {
    this.drainStageEvents(run);
    const timer = setInterval(() => this.drainStageEvents(run), STAGE_POLL_MS);
    timer.unref?.();
    this.stageTimers.set(run.runId, timer);
  }

  private stopWatching(run: QaRun): void {
    const timer = this.stageTimers.get(run.runId);
    if (timer) {
      clearInterval(timer);
      this.stageTimers.delete(run.runId);
    }
    this.drainStageEvents(run);
  }

  /**
   * Applies every stage event the engine has written since the last read. Only
   * complete lines are consumed, so a partially flushed trailing line is picked
   * up on the next pass instead of being lost.
   */
  private drainStageEvents(run: QaRun): void {
    const path = this.stageEventPath(run);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    let from = this.stageCursor.get(run.runId) ?? 0;
    if (text.length < from) from = 0; // truncated/replaced: read it again
    if (text.length === from) return;
    const chunk = text.slice(from);
    const lines = chunk.split(/\r?\n/);
    const trailing = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseStageEvent(line);
      if (event) this.applyStageEvent(run, event);
    }
    this.stageCursor.set(run.runId, from + chunk.length - trailing.length);
  }

  /** Records one engine-emitted transition. */
  private applyStageEvent(run: QaRun, event: QaStageEvent): void {
    run.stageHistory.push(event);
    run.currentStage = event.stage;
    run.stageState = event.state;
    const stage = RUN_STAGE_BY_QA_STAGE[event.stage];
    if (!stage) return;
    if (!run.observedStages.includes(stage)) run.observedStages.push(stage);
    // A finished or failed run keeps the stage it settled on.
    if (run.state === "RUNNING") run.stage = stage;
    // The logical view is what the tracker draws: a stage that legitimately
    // runs twice (Generate) stays one step instead of flickering backwards.
    run.stageView = buildStageView(run.stageHistory);
    run.runningStage = runningStageOf(run.stageHistory);
  }

  private ingest(run: QaRun, line: string): void {
    if (line.trim()) {
      run.log.push(line);
      if (run.log.length > MAX_LOG_LINES) run.log.shift();
    }
    if (run.stage === "COMPLETE") return;
    // Log text is only used to track progress when the engine sent no
    // structured events; once it has, the events are authoritative.
    if (run.stageHistory.length > 0) return;
    const stage = stageFromLine(line);
    if (stage && !run.observedStages.includes(stage)) {
      run.observedStages.push(stage);
      run.stage = stage;
    }
  }

  private complete(run: QaRun, code: number | null, stderr: string): void {
    this.stopWatching(run);
    run.completedAt = new Date().toISOString();
    const analysis = this.readReport(run);
    if (analysis) {
      const status = analysis.summary?.overallStatus;
      run.qaStatus = status && QA_STATUSES.includes(status) ? (status as QaStatus) : null;
      run.headline = analysis.summary?.headline ?? null;
      run.historyRunId = analysis.history?.currentRunId ?? null;
      run.stage = "COMPLETE";
      run.state = "COMPLETED";
      this.options.onRunSettled?.(run, analysis);
      return;
    }
    // No report artifact: the pipeline never reached a verdict. Surface the
    // real reason (engine error text or a spawn/usage failure) — never a PASS.
    const reason = firstErrorLine(stderr) ?? firstErrorLine(run.log.join("\n")) ?? `QA run exited with code ${code ?? "unknown"} without writing a report.`;
    this.fail(run, reason);
  }

  private fail(run: QaRun, reason: string): void {
    this.stopWatching(run);
    run.state = "FAILED";
    run.completedAt = new Date().toISOString();
    run.qaStatus = null;
    run.error = reason;
    this.options.onRunSettled?.(run, null);
  }

  private readReport(run: QaRun): QaAnalysis | null {
    try {
      if (!existsSync(run.artifacts.reportJson)) return null;
      statSync(run.artifacts.reportJson);
      const parsed: unknown = JSON.parse(readFileSync(run.artifacts.reportJson, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as QaAnalysis) : null;
    } catch {
      return null;
    }
  }

  private evict(): void {
    while (this.order.length > this.MAX_RUNS) {
      const oldest = this.order.pop();
      if (oldest === undefined) break;
      const run = this.runs.get(oldest);
      if (run && run.state === "RUNNING") {
        this.order.unshift(oldest);
        break;
      }
      this.stageCursor.delete(oldest);
      this.runs.delete(oldest);
    }
  }
}

function firstErrorLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && /error|failed|refused|invalid|cannot|unable/i.test(line)) return line;
  }
  return null;
}
