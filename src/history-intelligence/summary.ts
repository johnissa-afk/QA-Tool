// ---------------------------------------------------------------------------
// Phase 7B — deterministic summary + limitations.
// ---------------------------------------------------------------------------
import type {
  CoverageTrendRecord,
  FlowStabilityRecord,
  HistoricalFinding,
  HistoricalIntelligenceSummary,
  HistoricalQueueEntry,
  HistoricalRelationship,
  RecurringInfrastructure,
} from "./types.js";

export function buildSummary(
  runsAnalyzed: number,
  orderedRuns: number,
  unorderedRuns: number,
  ordered: { record: { startedAt: string }; order: { stamp: string } }[],
  findings: HistoricalFinding[],
  flows: FlowStabilityRecord[],
  coverage: CoverageTrendRecord[],
  infrastructure: RecurringInfrastructure[],
  relationships: HistoricalRelationship[],
  queue: HistoricalQueueEntry[],
): HistoricalIntelligenceSummary {
  const count = (state: string) => findings.filter(finding => finding.lifecycle === state).length;
  return {
    runsAnalyzed,
    orderedRuns,
    unorderedRuns,
    dateRange: {
      firstRunStartedAt: ordered[0]?.record.startedAt ?? null,
      latestRunCompletedAt: ordered[ordered.length - 1]?.order.stamp ?? null,
    },
    findings: {
      observed: findings.length,
      new: count("NEW"),
      persisting: count("PERSISTING"),
      disappeared: count("DISAPPEARED"),
      reappeared: count("REAPPEARED"),
      recurring: count("RECURRING"),
      intermittent: count("INTERMITTENT"),
      changed: count("CHANGED"),
      unchanged: count("UNCHANGED"),
      reviewRequired: count("REVIEW_REQUIRED"),
      insufficientEvidence: count("INSUFFICIENT_EVIDENCE"),
    },
    flows: {
      observed: flows.length,
      stable: flows.filter(flow => flow.stability === "STABLE").length,
      variable: flows.filter(flow => flow.stability === "VARIABLE").length,
      unstable: flows.filter(flow => flow.stability === "UNSTABLE").length,
      insufficientEvidence: flows.filter(flow => flow.stability === "INSUFFICIENT_EVIDENCE").length,
      recurringFailures: flows.filter(flow => flow.failureRunIds.length >= 2).length,
    },
    coverage: {
      trends: coverage.length,
      newlyTested: coverage.filter(record => record.trend === "NEWLY_TESTED").length,
      persistentlyUntested: coverage.filter(record => record.trend === "PERSISTENTLY_UNTESTED").length,
      gained: coverage.filter(record => record.trend === "COVERAGE_GAIN").length,
      lost: coverage.filter(record => record.trend === "COVERAGE_LOSS").length,
      changed: coverage.filter(record => record.trend === "COVERAGE_CHANGED").length,
      stable: coverage.filter(record => record.trend === "COVERAGE_STABLE").length,
      insufficientEvidence: coverage.filter(record => record.trend === "INSUFFICIENT_EVIDENCE").length,
    },
    infrastructure: { recurringCount: infrastructure.length },
    relationships: relationships.length,
    investigationQueue: queue.length,
  };
}

export function buildLimitations(
  orderedRuns: number,
  unorderedRuns: number,
  findings: HistoricalFinding[],
  coverage: CoverageTrendRecord[],
): string[] {
  const limitations: string[] = [];
  limitations.push(
    orderedRuns <= 1
      ? `only ${orderedRuns} ordered run so far — classifications are preliminary and need more history`
      : `based on ${orderedRuns} ordered runs — more history strengthens every claim`,
  );
  if (unorderedRuns > 0) {
    limitations.push(`${unorderedRuns} run(s) had unusable persisted ordering and were counted but never used for pattern claims`);
  }
  const reviewCount = findings.filter(finding => finding.lifecycle === "REVIEW_REQUIRED").length;
  if (reviewCount > 0) {
    limitations.push(`${reviewCount} finding(s) need human review — ambiguous identity or absence that could not be interpreted as clean`);
  }
  const gapCount = coverage.filter(record => record.trend === "COVERAGE_LOSS" || record.trend === "PERSISTENTLY_UNTESTED").length;
  if (gapCount > 0) {
    limitations.push(`${gapCount} coverage area(s) show un-tested or lost status — absence is discovery variance, never a loss claim`);
  }
  limitations.push("classification is deterministic and confidence-aware; no overall quality or health score is offered");
  return limitations;
}