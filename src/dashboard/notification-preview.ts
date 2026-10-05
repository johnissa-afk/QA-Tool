// ---------------------------------------------------------------------------
// Notification events + the TEMPORARY preview endpoint's view model.
//
// WHAT THIS IS
// The single source of truth for WHICH NOTIFICATION EVENTS EXIST. It reads the
// data the QA engine already produces and shapes it as notification events.
// Both the temporary preview endpoint and production notification generation
// call these same functions, so a preview can never disagree with what the
// production system stored.
//
// The preview (`buildNotificationPreview`) is TEMPORARY and read-only. It exists
// as a deterministic debugging tool for one question: given a project and a run,
// which notifications WOULD this system generate? It stores nothing, delivers
// nothing, schedules nothing, and has no UI. Keep it while the production
// notification system settles in real use; it can be deleted later.
//
// WHAT THIS IS NOT
// It is NOT a second intelligence layer. Every event is derived from an
// existing recorded verdict:
//   * NEW / REGRESSED / RESOLVED come from the project finding lifecycle
//     (project-findings.ts) via the snapshot and comparison the project store
//     already recorded for this run. Resolution safety (blocked run, incomplete
//     run, infrastructure-broken run, untested page, ABSENCE_UNVERIFIED) is that
//     module's rule and is not re-decided here: a finding only appears in
//     `refs.resolved` when the lifecycle already concluded it was resolved.
//   * ACCESS_CHANGED comes from the existing access comparison (run-comparison.ts).
//   * MEANINGFUL_CHANGE reuses `highlightsOf`, the existing change-intelligence
//     summary lines. No score, no weight, no new threshold.
//   * RUN_FAILED comes from the recorded run/execution state and the recorded
//     verification counters. Log text is never parsed.
//   * SCHEDULE_SKIPPED comes from the recorded scheduler execution status.
//
// DETERMINISM AND READ-ONLY
// This module performs no I/O and reads no clock. Given identical input it
// returns identical JSON, byte for byte. Sorting is total: by notification type,
// then by the event's own stable identifier.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Notification events — the SHARED, SINGLE-SOURCE derivation.
//
// THIS IS THE ONE PLACE A NOTIFICATION EVENT IS DECIDED.
// Both consumers call exactly these functions:
//   * the temporary preview endpoint  -> deriveNotificationEvents()
//   * production notification storage -> deriveNotificationEvents() and
//                                       deriveScheduleExecutionEvents()
// Nothing re-derives an event, and nothing here stores, delivers or schedules
// anything: this layer only turns already-recorded verdicts into events.
// ---------------------------------------------------------------------------
import type { QaAnalysis, Severity } from "../ai/types.js";
import type {
  ProjectComparisonFindingRef,
  ProjectRunComparisonResult,
  ProjectRunFindingsSnapshot,
} from "./project-findings.js";
import type {
  ChangeSummary,
  ComparisonAvailability,
  ComparisonUnavailableReason,
} from "./run-comparison.js";
import { highlightsOf, verificationCountsOf } from "./run-comparison.js";
import type { Project, ProjectRunRecord } from "./projects.js";
import { SCHEDULE_EXECUTION_STATUSES, type ScheduledExecution } from "./project-schedules.js";

/**
 * The notification kinds this preview can produce. A closed list: a preview
 * never invents a kind that the system would not eventually be able to send.
 */
export type NotificationPreviewType =
  | "NEW_FINDING"
  | "REGRESSED_FINDING"
  | "RESOLVED_FINDING"
  | "RUN_FAILED"
  | "ACCESS_CHANGED"
  | "SCHEDULE_SKIPPED"
  | "MEANINGFUL_CHANGE";

/**
 * Which existing subsystem the event was read from. Reported so a reader can
 * see that nothing was classified by a new opinion.
 */
export type NotificationPreviewSource =
  | "finding-lifecycle"
  | "run-state"
  | "verification"
  | "schedule-execution"
  | "access-comparison"
  | "change-intelligence";

/**
 * One previewed notification.
 *
 * `severity` carries the finding's OWN recorded severity vocabulary
 * (CRITICAL/HIGH/MEDIUM/LOW/INFO). There is deliberately no P1/P2 scale and no
 * priority number: ranking things is not this milestone's job.
 */
export type NotificationPreviewEvent = {
  type: NotificationPreviewType;
  projectId: string;
  projectName: string;
  runId: string | null;
  findingId: string | null;
  severity: Severity | null;
  title: string;
  message: string;
  source: NotificationPreviewSource;
  /** A stable, linkable id: a finding id, an execution id, or a run id. */
  reference: string | null;
  /** The existing recorded details this event was read from, verbatim. */
  details?: string[];
};

/** Always lists every kind, including the ones that fired zero times. */
export type NotificationPreviewCounts = Record<NotificationPreviewType, number>;

export type NotificationPreviewRun = {
  id: string;
  status: string | null;
  state: string | null;
  startedAt: string | null;
  completedAt: string | null;
  findingsCount: number | null;
  hasResult: boolean;
  error: string | null;
};

export type NotificationPreviewComparison = {
  /** The existing comparison availability, reported as-is (never collapsed). */
  status: ComparisonAvailability;
  previousRunId: string | null;
  reason: ComparisonUnavailableReason | null;
  reasonDetail: string | null;
};

export type NotificationPreview = {
  project: { id: string; name: string; url: string };
  run: NotificationPreviewRun;
  comparison: NotificationPreviewComparison;
  notifications: NotificationPreviewEvent[];
  counts: NotificationPreviewCounts;
};

/**
 * Everything the preview reads. Supplied by the caller so this module stays a
 * pure function of already-recorded facts: no store, no filesystem, no clock.
 */
export type NotificationPreviewInput = {
  project: Pick<Project, "id" | "name" | "url">;
  /** The recorded project run. Must belong to `project`. */
  run: Pick<
    ProjectRunRecord,
    "runId" | "status" | "state" | "startedAt" | "completedAt" | "findingsCount" | "hasResult" | "error"
  >;
  /** The run's real report, when one exists. Used only for recorded counters. */
  analysis: QaAnalysis | null;
  /** The lifecycle snapshot recorded when this run settled. */
  snapshot: ProjectRunFindingsSnapshot | null;
  /** The lifecycle comparison recorded when this run settled. */
  comparison: ProjectRunComparisonResult | null;
  /** The run-to-run change summary, or null when it could not be built. */
  changeSummary: ChangeSummary | null;
  /** Every scheduler execution recorded for this project. */
  executions: readonly ScheduledExecution[];
};

/**
 * Reporting order. Run problems first, then access, then regressions, then new
 * and resolved findings, then scheduler skips, then the change summary.
 */
const TYPE_ORDER: readonly NotificationPreviewType[] = [
  "RUN_FAILED",
  "ACCESS_CHANGED",
  "REGRESSED_FINDING",
  "NEW_FINDING",
  "RESOLVED_FINDING",
  "SCHEDULE_SKIPPED",
  "MEANINGFUL_CHANGE",
];

const RANK: Record<NotificationPreviewType, number> = TYPE_ORDER.reduce(
  (ranks, type, index) => ({ ...ranks, [type]: index }),
  {} as Record<NotificationPreviewType, number>,
);

/**
 * Skip statuses are derived from the scheduler's own status list rather than
 * written out again here, so a new skip status cannot be silently ignored by
 * this preview.
 */
const SKIP_STATUSES: readonly string[] = SCHEDULE_EXECUTION_STATUSES.filter(status =>
  status.startsWith("SKIPPED_"),
);

/** ISO instants compare correctly as strings; parsed to ms so a bad value cannot
 *  silently become "always inside the window". */
const msOf = (value: string | null | undefined): number => {
  if (typeof value !== "string" || value === "") return Number.NaN;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : ms;
};

const emptyCounts = (): NotificationPreviewCounts =>
  TYPE_ORDER.reduce(
    (counts, type) => ({ ...counts, [type]: 0 }),
    {} as NotificationPreviewCounts,
  );

/** A single event builder, so every event carries the same identifying fields. */
function event(
  input: NotificationPreviewInput,
  type: NotificationPreviewType,
  source: NotificationPreviewSource,
  title: string,
  message: string,
  extra: {
    runId?: string | null;
    findingId?: string | null;
    severity?: Severity | null;
    reference?: string | null;
    details?: string[];
  } = {},
): NotificationPreviewEvent {
  return {
    type,
    projectId: input.project.id,
    projectName: input.project.name,
    runId: extra.runId ?? input.run.runId,
    findingId: extra.findingId ?? null,
    severity: extra.severity ?? null,
    title,
    message,
    source,
    reference: extra.reference ?? input.run.runId,
    ...(extra.details ? { details: extra.details } : {}),
  };
}

// ---------------------------------------------------------------------------
// RUN_FAILED
// ---------------------------------------------------------------------------

/**
 * A run that genuinely failed, distinguished by cause.
 *
 * Three recorded causes, each from an existing field rather than from text:
 *   * `run-state`         - the run itself did not complete. A run that finished
 *                           and returned a FAIL verdict completed: its findings
 *                           are reported as findings, not as a failed run.
 *   * `verification`      - the recorded verification counters show infrastructure
 *                           problems or the verification execution itself failed
 *                           for infrastructure reasons. Infrastructure is our
 *                           problem, not the website's, so it is named as its
 *                           own cause. Flow-discovery infrastructure problems
 *                           alone do not fail a run whose verification completed.
 *   * `schedule-execution`- the scheduler execution recorded for this run failed
 *                           or was interrupted.
 */
function runFailedEvents(input: NotificationPreviewInput): NotificationPreviewEvent[] {
  const events: NotificationPreviewEvent[] = [];
  const { run } = input;

  if (run.state === "FAILED") {
    const why = run.error ?? `the run did not complete (recorded state ${run.state})`;
    events.push(
      event(input, "RUN_FAILED", "run-state", "QA run failed", `QA run ${run.runId} failed: ${why}`, {
        reference: run.runId,
      }),
    );
  }

  if (input.analysis) {
    const counts = verificationCountsOf(input.analysis);
    const problems = counts.infrastructureProblems ?? 0;
    // Only the QA verification's own recorded failures count here. A flow
    // discovery execution marked INFRASTRUCTURE_PROBLEM means an exploratory
    // flow could not run; when the verification itself still completed, that is
    // not a failed run, so it is deliberately not treated as one.
    const failures = input.analysis.execution?.infrastructureFailures ?? 0;
    if (problems > 0 || failures > 0) {
      events.push(
        event(
          input,
          "RUN_FAILED",
          "verification",
          "Infrastructure problems during the QA run",
          `Run ${run.runId} recorded ${problems} infrastructure problem(s) and ${failures} infrastructure failure(s). These are test-environment problems, not website defects.`,
          { reference: run.runId, details: [`infrastructureProblems=${problems}`, `infrastructureFailures=${failures}`] },
        ),
      );
    }
  }

  for (const execution of input.executions) {
    if (execution.runId !== run.runId) continue;
    // Only the scheduler's own two "this did not finish" states. A skip is a
    // SCHEDULE_SKIPPED event, not a failure, and a completed execution is not
    // news.
    if (execution.status !== "FAILED" && execution.status !== "INTERRUPTED") continue;
    events.push(
      event(
        input,
        "RUN_FAILED",
        "schedule-execution",
        `Scheduled QA execution ${execution.status.toLowerCase()}`,
        `Scheduler execution ${execution.executionId} for run ${run.runId} is recorded as ${execution.status}.${execution.detail ? ` Reason: ${execution.detail}` : ""}`,
        { reference: execution.executionId },
      ),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// Finding lifecycle
// ---------------------------------------------------------------------------

function findingEvent(
  input: NotificationPreviewInput,
  type: NotificationPreviewType,
  ref: ProjectComparisonFindingRef,
  title: string,
  message: string,
): NotificationPreviewEvent {
  return event(input, type, "finding-lifecycle", title, message, {
    findingId: ref.id,
    severity: ref.severity,
    reference: ref.id,
    details: [`code=${ref.code}`, `page=${ref.page}`, `runFindingId=${ref.runFindingId ?? "none"}`],
  });
}

/**
 * New, regressed and resolved findings, read from the comparison the project
 * store already recorded for this run.
 *
 * The lifecycle owns every safety rule here. A finding only reaches
 * `refs.resolved` when the run genuinely exercised the area that contained it,
 * so a blocked, incomplete, infrastructure-broken, untested or
 * ABSENCE_UNVERIFIED case produces no entry and therefore no event. The
 * explicit gate below is a second, honest check rather than a re-decision.
 */
function findingEvents(input: NotificationPreviewInput): NotificationPreviewEvent[] {
  const comparison = input.comparison;
  const snapshot = input.snapshot;
  if (!comparison) return [];

  const events: NotificationPreviewEvent[] = [];

  // A NEW finding is a fact about this run alone: the lifecycle identified it as
  // never-seen-before. Nothing about a prior state is being claimed, so it is
  // reported even when there is nothing to compare against.
  for (const ref of comparison.new) {
    events.push(
      findingEvent(
        input,
        "NEW_FINDING",
        ref,
        "New finding",
        `${ref.title} (${ref.code}) is new on ${ref.page} in run ${input.run.runId}.`,
      ),
    );
  }

  // Regression and resolution both assert something about a prior state, so they
  // require a recorded comparison.
  if (!comparison.comparisonAvailable) return events;

  for (const ref of comparison.regressed) {
    events.push(
      findingEvent(
        input,
        "REGRESSED_FINDING",
        ref,
        "Finding regressed",
        `${ref.title} (${ref.code}) regressed on ${ref.page} in run ${input.run.runId}. It was previously resolved and is present again.`,
      ),
    );
  }

  // Resolution is additionally gated on this run's own recorded trust. A run
  // that could not meaningfully test the site resolves nothing.
  if (snapshot?.resolutionTrustworthy === false) return events;

  for (const ref of comparison.resolved) {
    events.push(
      findingEvent(
        input,
        "RESOLVED_FINDING",
        ref,
        "Finding resolved",
        `${ref.title} (${ref.code}) on ${ref.page} was resolved in run ${input.run.runId}. The lifecycle recorded it as verified clear.`,
      ),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// ACCESS_CHANGED
// ---------------------------------------------------------------------------

/**
 * An access-state transition between the selected run and the run it was
 * compared against. This is the recorded `AccessChange` verbatim: a state
 * transition, explicitly not a judgement about the website. An unchanged state
 * produces nothing.
 */
function accessChangedEvents(input: NotificationPreviewInput): NotificationPreviewEvent[] {
  const summary = input.changeSummary;
  if (!summary) return [];
  const access = summary.access;
  if (!access.changed) return [];
  if (access.previous === access.current) return [];
  // The recorded comparison marks a change whenever the two labels differ, which
  // includes "we could not tell before". An UNKNOWN side is an unmeasured
  // baseline, not a state the site was in, so it is never reported as a
  // transition - the same rule the change summary itself follows for deltas.
  if (access.previous === "UNKNOWN" || access.current === "UNKNOWN") return [];
  return [
    event(
      input,
      "ACCESS_CHANGED",
      "access-comparison",
      "Access state changed",
      `Access state changed from ${access.previous} to ${access.current} between run ${summary.previousRunId ?? "none"} and run ${summary.currentRunId}. ${access.note}`,
      {
        runId: summary.currentRunId,
        reference: `${summary.currentRunId}:access`,
        details: [`previous=${access.previous}`, `current=${access.current}`],
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// SCHEDULE_SKIPPED
// ---------------------------------------------------------------------------

/** True for the scheduler's own skip statuses, derived from its status list. */
export const isScheduleSkipStatus = (status: string): boolean => SKIP_STATUSES.indexOf(status) !== -1;

/**
 * The ONE definition of a scheduler-skip notification event.
 *
 * Both consumers build it here. They differ only in how they decide WHICH run a
 * skip belongs to:
 *   * production passes the run the scheduler recorded as in flight;
 *   * the preview, which is asked about one specific run, matches the skip's own
 *     recorded instant against that run's recorded start-to-complete window.
 * The event itself - type, title, message, source, reference, details - is built
 * in exactly one place, so the two can never describe the same skip differently.
 */
export function buildScheduleSkipEvent(
  project: Pick<Project, "id" | "name" | "url">,
  execution: ScheduledExecution,
  runId: string | null,
): NotificationPreviewEvent {
  return {
    type: "SCHEDULE_SKIPPED",
    projectId: project.id,
    projectName: project.name,
    runId,
    findingId: null,
    severity: null,
    title: `Scheduled QA run skipped (${execution.status})`,
    message: `Scheduler execution ${execution.executionId}, due ${execution.scheduledFor}, was skipped with status ${execution.status}.${execution.detail ? ` Reason: ${execution.detail}` : ""}`,
    source: "schedule-execution",
    reference: execution.executionId,
    details: [`status=${execution.status}`, `scheduledFor=${execution.scheduledFor}`, `trigger=${execution.trigger}`],
  };
}

/**
 * Events for one recorded scheduler execution, as production notification
 * generation needs them at the moment the scheduler persists that execution.
 *
 * A skip is news about the schedule; a failed or interrupted execution is a
 * failure of the run it was executing for. A completed execution is ordinary
 * activity and deliberately produces nothing.
 */
export function deriveScheduleExecutionEvents(
  project: Pick<Project, "id" | "name" | "url">,
  execution: ScheduledExecution,
  runId: string | null,
): NotificationPreviewEvent[] {
  // A skip is news about the schedule, never about a run: the preview emits it
  // with no run of its own, so production emits exactly the same event. Passing
  // the run that happened to be in flight would make the same skip mean two
  // different things in the two views.
  if (isScheduleSkipStatus(execution.status)) return [buildScheduleSkipEvent(project, execution, null)];
  if (execution.status !== "FAILED" && execution.status !== "INTERRUPTED") return [];
  // A failed execution, by contrast, is the failure of the run it was executing.
  const run = runId ?? execution.runId;
  if (!run) return [];
  return [
    {
      type: "RUN_FAILED",
      projectId: project.id,
      projectName: project.name,
      runId: run,
      findingId: null,
      severity: null,
      title: `Scheduled QA execution ${execution.status.toLowerCase()}`,
      message: `Scheduler execution ${execution.executionId} for run ${run} is recorded as ${execution.status}.${execution.detail ? ` Reason: ${execution.detail}` : ""}`,
      source: "schedule-execution",
      reference: execution.executionId,
      details: [`status=${execution.status}`, `scheduledFor=${execution.scheduledFor}`, `trigger=${execution.trigger}`],
    },
  ];
}

/**
 * A scheduler slot that was skipped, as attributed to one specific run by the
 * preview: a skip has no run of its own, so it can only be claimed by a run whose
 * own recorded window contains the skip instant. When no such window contains it
 * the skip is not attributed to this run and no event is emitted - never guessed.
 */
function scheduleSkippedEvents(input: NotificationPreviewInput): NotificationPreviewEvent[] {
  const startMs = msOf(input.run.startedAt);
  const endMs = msOf(input.run.completedAt ?? input.run.startedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];

  const events: NotificationPreviewEvent[] = [];
  for (const execution of input.executions) {
    if (!isScheduleSkipStatus(execution.status)) continue;
    const skipMs = msOf(execution.completedAt ?? execution.scheduledFor);
    if (!Number.isFinite(skipMs)) continue;
    if (skipMs < startMs || skipMs > endMs) continue;
    events.push(buildScheduleSkipEvent(input.project, execution, null));
  }
  return events;
}

// ---------------------------------------------------------------------------
// MEANINGFUL_CHANGE
// ---------------------------------------------------------------------------

/**
 * The existing change-intelligence summary lines for this run.
 *
 * `highlightsOf` only emits a line for a dimension that recorded a difference,
 * so an unchanged pair produces no lines and therefore no event. The lines are
 * passed through untouched: no new category, no score, no threshold.
 */
function meaningfulChangeEvents(input: NotificationPreviewInput): NotificationPreviewEvent[] {
  const summary = input.changeSummary;
  if (!summary) return [];
  if (summary.availability === "UNAVAILABLE") return [];
  const lines = highlightsOf(summary);
  if (!lines.length) return [];
  return [
    event(
      input,
      "MEANINGFUL_CHANGE",
      "change-intelligence",
      "Meaningful changes since the previous run",
      `Run ${summary.currentRunId} differs from ${summary.previousRunId ?? "none"} in ${lines.length} recorded dimension(s): ${lines.join("; ")}.`,
      {
        runId: summary.currentRunId,
        reference: `${summary.currentRunId}:change-summary`,
        details: lines,
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Every notification event this run actually has, in the agreed type order.
 *
 * This is the function production notification generation and the preview
 * endpoint both call. It is pure and clock-free: identical input produces an
 * identical list, so reprocessing a run cannot invent or reorder anything.
 */
export function deriveNotificationEvents(input: NotificationPreviewInput): NotificationPreviewEvent[] {
  return [
    ...runFailedEvents(input),
    ...accessChangedEvents(input),
    ...findingEvents(input),
    ...scheduleSkippedEvents(input),
    ...meaningfulChangeEvents(input),
  ].sort((a, b) => {
    const byType = RANK[a.type] - RANK[b.type];
    if (byType !== 0) return byType;
    const aKey = `${a.findingId ?? a.reference ?? ""}|${a.title}`;
    const bKey = `${b.findingId ?? b.reference ?? ""}|${b.title}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

/**
 * Builds the full preview. Pure: identical input produces identical output.
 */
export function buildNotificationPreview(input: NotificationPreviewInput): NotificationPreview {
  const notifications = deriveNotificationEvents(input);

  const counts = emptyCounts();
  for (const item of notifications) counts[item.type] += 1;

  const summary = input.changeSummary;
  return {
    project: { id: input.project.id, name: input.project.name, url: input.project.url },
    run: {
      id: input.run.runId,
      status: input.run.status,
      state: input.run.state,
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
      findingsCount: input.run.findingsCount,
      hasResult: input.run.hasResult,
      error: input.run.error,
    },
    comparison: {
      status: summary?.availability ?? "UNAVAILABLE",
      previousRunId: summary?.previousRunId ?? null,
      reason: summary?.reason ?? null,
      reasonDetail: summary?.reasonDetail ?? null,
    },
    notifications,
    counts,
  };
}

/** Exported for tests and for a future UI that needs the same ordering. */
export const notificationPreviewTypeOrder = (): readonly NotificationPreviewType[] => TYPE_ORDER;