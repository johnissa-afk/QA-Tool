// ---------------------------------------------------------------------------
// Phase 7B — historical relationships.
//
// Relationships are explicit, typed edges between a historical entity name and
// an entity it is related to in time. They are DERIVED from the deterministic
// classifications (never from matching text alone) and carry the same
// confidence as the classification that produced them. Every edge is named,
// reasons in plain language, and lists the exact run ids it is built on.
// ---------------------------------------------------------------------------
import type {
  CoverageTrendRecord,
  FlowStabilityRecord,
  HistoricalFinding,
  HistoricalRelationship,
  HistoricalRelationshipKind,
  RecurringInfrastructure,
} from "./types.js";

function relationshipOf(
  kind: HistoricalRelationshipKind,
  source: string,
  target: string,
  reason: string,
  runIds: string[],
  confidence: HistoricalRelationship["confidence"],
): HistoricalRelationship {
  return { relationshipId: "", kind, source, target, reason, runIds: [...runIds], confidence };
}

export function buildHistoricalRelationships(
  findings: HistoricalFinding[],
  flows: FlowStabilityRecord[],
  coverage: CoverageTrendRecord[],
  infrastructure: RecurringInfrastructure[],
): HistoricalRelationship[] {
  const all: HistoricalRelationship[] = [];

  for (const finding of findings) {
    if (finding.confidence === "INSUFFICIENT") continue;
    const presentRuns = finding.evidence.filter(observation => observation.status === "PRESENT").map(observation => observation.runId);
    const absentAfterPresent = finding.evidence.some(observation => observation.status === "PRESENT") &&
      finding.evidence[finding.evidence.length - 1]?.status === "ABSENT";
    const returned = finding.evidence.some((observation, index) => index > 0 && observation.status === "PRESENT" && finding.evidence[index - 1]?.status === "ABSENT");
    const hasGap = finding.evidence.some((observation, index) => index > 0 && observation.status === "ABSENT" && finding.evidence[index - 1]?.status === "PRESENT" && finding.evidence.slice(index + 1).some(later => later.status === "PRESENT"));

    if (presentRuns.length >= 2) {
      all.push(relationshipOf("PERSISTS_ACROSS_RUNS", finding.key, "run-history", `the finding was observed in ${presentRuns.length} runs`, presentRuns, finding.confidence));
    }
    if (absentAfterPresent && presentRuns.length >= 1) {
      all.push(relationshipOf("DISAPPEARS_AFTER_RUN", finding.key, "latest-runs", "the finding was observed and then absent in every later run", presentRuns, finding.confidence));
    }
    if (returned) {
      all.push(relationshipOf("REAPPEARS_IN_RUN", finding.key, "run-history", "the finding returned after at least one absence", presentRuns, finding.confidence));
    }
    if (finding.runsObserved >= 3 && hasGap) {
      all.push(relationshipOf("RECURS_IN_RUNS", finding.key, "run-history", `the finding was present in ${finding.runsObserved} non-consecutive runs`, presentRuns, finding.confidence));
    }
    if (finding.contradictions.length > 0) {
      all.push(relationshipOf("CONTRADICTED_BY_RUN", finding.key, "run-history", `the finding was reproduced in some runs and observed-clear in others`, finding.runIds, finding.confidence === "LOW" ? "LOW" : "MEDIUM"));
    }
    if (finding.reproducedRunIds.length >= 2) {
      all.push(relationshipOf("SUPPORTED_BY_RUN", finding.key, "run-history", `the finding was reproduced in ${finding.reproducedRunIds.length} runs`, finding.reproducedRunIds, finding.confidence));
    }
  }

  for (const record of coverage) {
    if (record.confidence === "INSUFFICIENT") continue;
    if (record.trend === "COVERAGE_LOSS" || record.trend === "PERSISTENTLY_UNTESTED") {
      all.push(relationshipOf("COVERAGE_GAP", record.semanticKey, "coverage", `${record.trend.toLowerCase().replace(/_/g, " ")} — ${record.confidenceReason}`, record.runIds, record.confidence));
    }
  }

  for (const record of flows) {
    if (record.confidence === "INSUFFICIENT") continue;
    if (record.stability === "VARIABLE" || record.stability === "UNSTABLE") {
      all.push(relationshipOf("FLOW_VARIANCE", record.familyKey, "flow-history", `${record.stability.toLowerCase()} — ${record.confidenceReason}`, record.runIds, record.confidence));
    }
  }

  for (const record of infrastructure) {
    if (record.count >= 2) {
      all.push(relationshipOf("INFRASTRUCTURE_REPEAT", record.infrastructureId, "run-history", `infrastructure problems appeared in ${record.count} runs`, record.runIds, record.confidence));
    }
  }

  all.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
  return all.map((relationship, index) => ({ ...relationship, relationshipId: `REL-${String(index + 1).padStart(3, "0")}` }));
}