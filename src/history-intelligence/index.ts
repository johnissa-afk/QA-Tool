// ---------------------------------------------------------------------------
// Phase 7B — Historical Intelligence & Trends. Public entry point.
//
// Consumes the Phase 7A history for ONE site and produces a deterministic,
// explainable, confidence-aware interpretation: finding lifecycle timelines,
// flow stability, coverage trends, recurring infrastructure, typed historical
// relationships, an evidence-backed investigation queue, and a mandatory list
// of limitations. Ordering, identity, and bounded-loading rules live in
// matching.ts; every module self-guards so the whole map stays valid even when
// only one run exists (status INSUFFICIENT_HISTORY, claims INSUFFICIENT_EVIDENCE).
// ---------------------------------------------------------------------------
import type { QaRunRecord } from "../history/index.js";
import { buildCoverageTrends } from "./coverage.js";
import { loadOrderedRuns } from "./matching.js";
import { buildHistoricalFindings } from "./findings.js";
import { buildHistoricalFlows } from "./flows.js";
import { buildHistoricalInfrastructure } from "./infrastructure.js";
import { buildHistoricalRelationships } from "./relationships.js";
import { buildHistoricalInvQueue, resetEntryCounter } from "./queue.js";
import { buildLimitations, buildSummary } from "./summary.js";
import type { HistoricalIntelligenceAiNotes, HistoricalIntelligenceDigest, HistoricalIntelligenceEnhancement, HistoricalIntelligenceMap, HistoricalIntelligenceReportSection } from "./types.js";
import { HISTORICAL_INTELLIGENCE_SCHEMA_VERSION } from "./types.js";

export type HistoricalIntelligenceInput = {
  /** The site's persisted run records (from the history index). */
  runs: QaRunRecord[];
  historyDir: string;
  siteIdentity: string;
  currentRunId: string | null;
  /** Bounded loading — only the <maxRuns> most recent ordered runs are read. */
  maxRuns?: number;
};

export function historicalIntelligenceForRuns(input: HistoricalIntelligenceInput): HistoricalIntelligenceMap | null {
  const { runs, historyDir, siteIdentity, currentRunId, maxRuns } = input;
  if (!runs.length) return null;

  const { ordered, unordered } = loadOrderedRuns(runs, historyDir, maxRuns);
  if (!ordered.length && !unordered.length) return null;

  resetEntryCounter();
  const findings = buildHistoricalFindings(ordered);
  const flows = buildHistoricalFlows(ordered);
  const coverage = buildCoverageTrends(ordered);
  const infrastructure = buildHistoricalInfrastructure(ordered);
  const relationships = buildHistoricalRelationships(findings, flows, coverage, infrastructure);
  const queue = buildHistoricalInvQueue(findings, flows, coverage, infrastructure);

  const status = ordered.length < 2 ? "INSUFFICIENT_HISTORY" : "AVAILABLE";
  const summary = buildSummary(
    ordered.length + unordered.length,
    ordered.length,
    unordered.length,
    ordered,
    findings,
    flows,
    coverage,
    infrastructure,
    relationships,
    queue,
  );

  return {
    status,
    schemaVersion: HISTORICAL_INTELLIGENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    siteIdentity,
    historyDir,
    currentRunId,
    summary,
    findings,
    flows,
    coverage,
    infrastructure,
    relationships,
    investigationQueue: queue,
    limitations: buildLimitations(ordered.length, unordered.length, findings, coverage),
    aiNotes: null,
  };
}

/** Merge an optional bounded AI headline into the deterministic map. The
 *  classifications, run ids, confidence, and queue are never altered. */
export function applyHistoricalIntelligenceNotes(
  map: HistoricalIntelligenceMap,
  notes: HistoricalIntelligenceEnhancement,
  provider: string | null,
): HistoricalIntelligenceMap {
  const aiNotes: HistoricalIntelligenceAiNotes | null =
    typeof notes.headline === "string" && notes.headline.trim()
      ? { headline: notes.headline.trim(), provider }
      : null;
  return { ...map, aiNotes };
}

export function buildHistoricalIntelligenceDigest(map: HistoricalIntelligenceMap): HistoricalIntelligenceDigest {
  const count = (state: string) => map.findings.filter(finding => finding.lifecycle === state).length;
  return {
    url: map.findings[0]?.page ?? map.siteIdentity,
    title: "QA historical intelligence summary",
    runsAnalyzed: map.summary.orderedRuns,
    orderingUnusable: map.summary.unorderedRuns,
    summary: {
      new: count("NEW"),
      persisting: count("PERSISTING"),
      disappeared: count("DISAPPEARED"),
      reappeared: count("REAPPEARED"),
      recurring: count("RECURRING"),
      intermittent: count("INTERMITTENT"),
    },
    findings: map.findings.map(finding => ({ key: finding.key, lifecycle: finding.lifecycle, confidence: finding.confidence, severity: finding.severity, runIds: finding.runIds })),
    flows: map.flows.map(flow => ({ familyKey: flow.familyKey, stability: flow.stability, confidence: flow.confidence })),
    coverage: map.coverage.map(record => ({ semanticKey: record.semanticKey, trend: record.trend })),
    infrastructureCount: map.infrastructure.length,
    queue: map.investigationQueue.map(entry => ({ entryId: entry.entryId, kind: entry.kind, priority: entry.priority, title: entry.title })),
  };
}

// ---------------------------------------------------------------------------
// Public surface. Consumers may reuse the primitives the map is built from,
// but ONE identity system stays the contract (the Phase 7A/5/6 keys).
// ---------------------------------------------------------------------------
export { HISTORY_MAX_RUNS, loadOrderedRuns, runOrderKey, identityMapsOf, relationCoverageStatus, pageCoverageStatus, meaningfullyTested } from "./matching.js";
export { deriveConfidence } from "./confidence.js";
export { classifyCoverageTrend, buildCoverageTrends } from "./coverage.js";
export { classifyFlowStability, buildHistoricalFlows } from "./flows.js";
export { buildHistoricalFindings } from "./findings.js";
export { buildHistoricalInfrastructure, runInfraProblemCount } from "./infrastructure.js";
export { buildHistoricalRelationships } from "./relationships.js";
export { buildHistoricalInvQueue, resetEntryCounter } from "./queue.js";
export { HISTORICAL_INTELLIGENCE_SCHEMA_VERSION } from "./types.js";
export type {
  HistorySiteKey,
  HistoryRunIdentity,
  QaRunRecord,
  FindingHistorySnapshot,
  FlowHistorySnapshot,
  CoverageHistorySnapshot,
  HistoryRunSnapshot,
} from "../history/index.js";
export type {
  HistoricalStatus,
  HistoricalFindingState,
  HistoricalConfidence,
  DiscoveryVariance,
  FindingObservationStatus,
  FindingObservation,
  HistoricalFinding,
  FlowStability,
  FlowHistoricalOutcome,
  FlowStabilityRecord,
  CoverageTrend,
  CoverageTrendStatus,
  CoverageTrendRecord,
  RecurringInfrastructure,
  HistoricalRelationshipKind,
  HistoricalRelationship,
  HistoricalQueueKind,
  HistoricalInvPriority,
  HistoricalQueueEntry,
  HistoricalIntelligenceSummary,
  HistoricalIntelligenceAiNotes,
  HistoricalIntelligenceMap,
  HistoricalIntelligenceReportSection,
  HistoricalIntelligenceDigest,
  PlaySummary,
  HistoricalIntelligenceEnhancement,
} from "./types.js";