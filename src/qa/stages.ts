// ---------------------------------------------------------------------------
// Structured QA stage lifecycle events.
//
// The QA pipeline reports its own progress. Every real boundary in the run
// emits a `started` event, and a `completed` (or `failed`) event when it
// finishes. Consumers — the dashboard run manager, tests, CI — read those
// events instead of guessing progress from human-readable stdout, so the
// displayed progression is always the progression the engine actually ran.
//
// Two properties are load-bearing:
//
//   1. Events never touch stdout/stderr. The CLI's human output is unchanged
//      (it stays exactly what a developer sees in a terminal); events travel
//      on a sidecar NDJSON channel, so a run's log remains clean.
//   2. Timestamps are real. `new Date().toISOString()` is sampled when the
//      event is created — no synthesized or interpolated times.
//
// The emitter is deterministic: listeners are invoked in registration order
// and the file writer appends synchronously, so events are durable before the
// process can exit.
// ---------------------------------------------------------------------------
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildRedactor, type Redactor } from "../executor/redact.js";

/**
 * Every real stage of a QA run, in the order the pipeline actually runs them.
 *
 * This order is the engine's, not a presentational preference. The scanner is
 * what produces the access information, so `scan` always precedes `access`; and
 * the scenario suite has to exist before it can be analyzed, so `generate`
 * precedes `analyze`. The dashboard renders this exact list, and
 * `QA_STAGES` is the single source of truth for it.
 */
export const QA_STAGES = [
  "scan",
  "access",
  "generate",
  "analyze",
  "execute",
  "verify",
  "coverage",
  "history",
  "complete",
] as const;

export type QaStage = (typeof QA_STAGES)[number];

/** A stage is either still running, done, or ended in failure. */
export type QaStageState = "started" | "completed" | "failed";

export const QA_STAGE_STATES: readonly QaStageState[] = ["started", "completed", "failed"];

/**
 * One observed stage transition. `timestamp` is when the transition happened;
 * `error` is present only on `failed` events and is always redacted.
 */
export type QaStageEvent = {
  stage: QaStage;
  state: QaStageState;
  timestamp: string;
  error?: string;
};

export type QaStageListener = (event: QaStageEvent) => void;

/** Sidecar filename written next to the run's report artifacts. */
export const STAGE_EVENT_FILENAME = "qa-stages.ndjson";

const STAGE_SET = new Set<string>(QA_STAGES);
const STAGE_STATE_SET = new Set<string>(QA_STAGE_STATES);

/** Truncation bound for redacted failure text, matching evidence conventions. */
const MAX_ERROR_LENGTH = 1000;

function isQaStage(value: unknown): value is QaStage {
  return typeof value === "string" && STAGE_SET.has(value);
}

function isQaStageState(value: unknown): value is QaStageState {
  return typeof value === "string" && STAGE_STATE_SET.has(value);
}

/**
 * Turns any thrown value into a message that is safe to persist and display.
 * Secrets are redacted through the same redactor used for verification
 * evidence, and the text is bounded so a huge error cannot bloat the log.
 */
export function safeStageErrorMessage(error: unknown, redact: Redactor = buildRedactor()): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const message = raw.trim() || "Unknown stage failure.";
  return redact(message).slice(0, MAX_ERROR_LENGTH);
}

export type QaStageEmitterOptions = {
  /** Injectable clock so tests can assert on exact event times. */
  now?: () => string;
  /** Injectable redactor; defaults to the standard environment redactor. */
  redact?: Redactor;
};

/**
 * A minimal, deterministic stage event bus. Listeners run in the order they
 * were registered; a throwing listener never prevents the remaining listeners
 * (or the run) from continuing.
 */
export class QaStageEmitter {
  private readonly listeners: QaStageListener[] = [];
  private readonly now: () => string;
  private readonly redact: Redactor;

  constructor(options: QaStageEmitterOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.redact = options.redact ?? buildRedactor(process.env);
  }

  on(listener: QaStageListener): void {
    this.listeners.push(listener);
  }

  /** Emits an already-built event. Used by the typed helpers below. */
  emit(event: QaStageEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A stage observer must never break the pipeline it observes.
      }
    }
  }

  started(stage: QaStage): QaStageEvent {
    const event: QaStageEvent = { stage, state: "started", timestamp: this.now() };
    this.emit(event);
    return event;
  }

  completed(stage: QaStage): QaStageEvent {
    const event: QaStageEvent = { stage, state: "completed", timestamp: this.now() };
    this.emit(event);
    return event;
  }

  failed(stage: QaStage, error: unknown): QaStageEvent {
    const event: QaStageEvent = { stage, state: "failed", timestamp: this.now(), error: safeStageErrorMessage(error, this.redact) };
    this.emit(event);
    return event;
  }

  /**
   * Runs `work` as a stage: `started` before, `completed` after, `failed` on
   * throw. The error is rethrown unchanged so existing failure behavior
   * (error text, exit codes, artifacts) is completely unaffected.
   */
  async run<T>(stage: QaStage, work: () => Promise<T> | T): Promise<T> {
    this.started(stage);
    try {
      const value = await work();
      this.completed(stage);
      return value;
    } catch (error) {
      this.failed(stage, error);
      throw error;
    }
  }
}

/**
 * Streams events to a sidecar NDJSON file. Appends are synchronous, so every
 * event is on disk before the caller continues — a run that is killed still
 * leaves the transitions it actually reached.
 */
export function writeStageEventsTo(path: string, event: QaStageEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

/** Creates an emitter that also persists every event to `path`. */
export function createStageEventEmitter(path: string, options: QaStageEmitterOptions = {}): QaStageEmitter {
  const emitter = new QaStageEmitter(options);
  emitter.on(event => writeStageEventsTo(path, event));
  return emitter;
}

/**
 * Parses one NDJSON line into an event, or null when the line is blank or not
 * a well-formed event. Consumers use this to read the sidecar defensively —
 * a partially written trailing line (or a hand-edited file) is skipped rather
 * than crashing the reader.
 */
export function parseStageEvent(line: string): QaStageEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (!isQaStage(candidate.stage) || !isQaStageState(candidate.state)) return null;
  if (typeof candidate.timestamp !== "string" || !candidate.timestamp) return null;
  const event: QaStageEvent = {
    stage: candidate.stage,
    state: candidate.state,
    timestamp: candidate.timestamp,
  };
  if (candidate.state === "failed" && typeof candidate.error === "string" && candidate.error) {
    event.error = candidate.error;
  }
  return event;
}

/** A stage collapsed to the single logical step a person cares about. */
export type LogicalStageState = "pending" | "running" | "completed" | "failed";

export type LogicalStage = {
  stage: QaStage;
  state: LogicalStageState;
  /** When the stage first began. Never invented. */
  startedAt: string | null;
  /** When the stage first finished successfully. */
  completedAt: string | null;
  /** When the stage last failed, if it ever did. */
  failedAt: string | null;
  /**
   * How many separate pieces of work the engine opened under this stage. An
   * `--execute` run opens two Generate windows (the scenario suite, then the
   * verification spec); both are real and both stay in the event history.
   */
  windows: number;
  error?: string;
};

/**
 * Collapses the raw event stream into one logical state per stage.
 *
 * Some stages legitimately run more than once — Generate covers both suite and
 * spec generation. Replaying naively would show the stage flickering back to
 * "running" and read as the pipeline restarting, so once a stage reaches
 * `completed` a later `started` for that same stage records a new window
 * without regressing the logical state. A `failed` event always shows: it is
 * new information, not a repeat.
 *
 * Every window, its timestamps, and any error remain in the event history.
 * Nothing here is timed, estimated, or invented.
 */
export function buildStageView(events: readonly QaStageEvent[]): LogicalStage[] {
  const view = new Map<QaStage, LogicalStage>();
  for (const stage of QA_STAGES) {
    view.set(stage, { stage, state: "pending", startedAt: null, completedAt: null, failedAt: null, windows: 0 });
  }

  for (const event of events) {
    const entry = view.get(event.stage);
    if (!entry) continue;
    if (event.state === "started") {
      entry.windows += 1;
      if (entry.startedAt === null) entry.startedAt = event.timestamp;
      if (entry.state === "pending") entry.state = "running";
      // A stage that already completed keeps its completed state: this is a
      // further piece of the same logical step, not a new one.
      continue;
    }
    if (event.state === "completed") {
      entry.state = "completed";
      if (entry.completedAt === null) entry.completedAt = event.timestamp;
      delete entry.error;
      continue;
    }
    entry.state = "failed";
    if (entry.failedAt === null) entry.failedAt = event.timestamp;
    if (event.error) entry.error = event.error;
  }

  return QA_STAGES.map(stage => view.get(stage)!);
}

/** The stage currently doing work, or null when nothing is in progress. */
export function runningStageOf(events: readonly QaStageEvent[]): QaStage | null {
  const running = buildStageView(events).filter(stage => stage.state === "running");
  return running.length ? running[running.length - 1].stage : null;
}
