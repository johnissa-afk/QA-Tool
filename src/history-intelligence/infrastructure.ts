// ---------------------------------------------------------------------------
// Phase 7B — recurring infrastructure signals.
//
// Infrastructure problems (network, proxy, browser, page-load timeouts, rate
// limits — anything that is NOT product behavior) are tracked separately and
// NEVER become product regressions. Each ordered run contributes an aggregate
// infra problem count gathered from the run's own evidence:
//   - run summary executionInfraProblems,
//   - verifications whose category/status is an infrastructure signal,
//   - coverage items whose executionStatus is an infrastructure signal.
// A record exists only when the same kind of signal appears in >= 2 runs.
// ---------------------------------------------------------------------------
import { deriveConfidence } from "./confidence.js";
import type { HistoryRunSnapshot } from "../history/index.js";
import { OrderedRun } from "./matching.js";
import type { RecurringInfrastructure } from "./types.js";

const INFRA_SIGNALS = new Set(["INFRASTRUCTURE_PROBLEM", "INFRASTRUCTURE"]);

export function runInfraProblemCount(snapshot: HistoryRunSnapshot): number {
  const fromSummary = typeof snapshot.summary.executionInfraProblems === "number" ? snapshot.summary.executionInfraProblems : 0;
  const fromVerifications = snapshot.verifications.filter(
    verification =>
      (verification.category !== null && INFRA_SIGNALS.has(verification.category)) ||
      (verification.status !== null && INFRA_SIGNALS.has(verification.status)),
  ).length;
  const fromCoverage = snapshot.coverage.filter(item => typeof item.executionStatus === "string" && INFRA_SIGNALS.has(item.executionStatus)).length;
  return fromSummary + fromVerifications + fromCoverage;
}

export function buildHistoricalInfrastructure(ordered: OrderedRun[]): RecurringInfrastructure[] {
  const affected: { runId: string; completedAt: string | null; count: number }[] = [];
  for (const { record, snapshot, order } of ordered) {
    const count = runInfraProblemCount(snapshot);
    if (count > 0) affected.push({ runId: record.runId, completedAt: order.stamp, count });
  }
  if (affected.length < 2) return [];

  const runIds = affected.map(item => item.runId);
  const notes = affected.map(item => `run ${item.runId} recorded ${item.count} infrastructure problem(s) during execution`);
  const latest = affected[affected.length - 1]!;
  const confidence = deriveConfidence({
    orderedRunCount: ordered.length,
    observedRunCount: affected.length,
    contradictions: 0,
    verified: true,
    covered: true,
    gapDependent: false,
  });

  return [
    {
      infrastructureId: "INFRASTRUCTURE",
      runIds,
      count: affected.length,
      latestRunId: latest.runId,
      latestRunCompletedAt: latest.completedAt,
      notes,
      confidence: confidence.confidence,
      confidenceReason: `infrastructure problems appeared in ${affected.length} run(s). ${confidence.reason}`.trim(),
    },
  ];
}