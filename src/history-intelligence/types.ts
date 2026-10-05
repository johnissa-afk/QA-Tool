// ---------------------------------------------------------------------------
// Phase 7B — Historical Intelligence & Trends.
//
// Phase 7B sits on top of the Phase 7A memory layer and answers ONE question:
// "what do the persisted runs tell us, taken together?" It never re-runs the
// store, never invents a second identity system (it matches exclusively on the
// Phase 7A/5/6 SEMANTIC keys already persisted in run artifacts — finding
// semanticKey/family, flow familyKey/signature, coverage semanticKey), and it
// never hard-codes a single website.
//
// Hard rules (evidence first):
//   - Ordering is the persisted `completedAt`, tie-broken by `runId`.
//   - 1 run  -> history exists only; every pattern classification is
//              INSUFFICIENT_EVIDENCE.
//   2 runs  -> PERSISTING / DISAPPEARED / NEW / CHANGED (and their absence-side
//              REVIEW_REQUIRED fallbacks) may be claimed.
//   3+ runs -> REAPPEARED / RECURRING / INTERMITTENT / PERSISTENT may be claimed.
//   - Absence is NEVER a fix. A vanished finding is DISAPPEARED only when the
//     area was meaningfully re-tested; otherwise REVIEW_REQUIRED / NOT_OBSERVED.
//   - Contradicting evidence is preserved, never hidden.
//   - Infrastructure failures are infrastructure, never product regressions.
//   - Confidence is an explainable HIGH/MEDIUM/LOW/INSUFFICIENT, never a number.
//   - No overall quality / health / stability score of any kind.
//   - Schema version 1, additive-only. Secrets never touched.
// ---------------------------------------------------------------------------

export const HISTORICAL_INTELLIGENCE_SCHEMA_VERSION = 1;

export type HistoricalStatus =
  | "AVAILABLE"
  | "INSUFFICIENT_HISTORY" // history loads but fewer than 2 comparable, ordered runs
  | "UNAVAILABLE";         // history cannot be loaded for this site

/** Lifecycle of a semantic finding across the ordered run history. */
export type HistoricalFindingState =
  | "NEW"                   // first observed in the latest run
  | "PERSISTING"            // observed in the latest run and at least one earlier run
  | "DISAPPEARED"           // observed earlier, absent in later runs while the area was re-tested
  | "REAPPEARED"            // disappeared exactly once and returned
  | "RECURRING"             // came back through more than one absence (between runs)
  | "INTERMITTENT"          // presence strictly alternates across runs
  | "UNCHANGED"             // present in multiple runs with identical recorded details
  | "CHANGED"               // present in multiple runs with changed details (severity/title)
  | "REVIEW_REQUIRED"       // evidence insufficient or contradictory to interpret
  | "INSUFFICIENT_EVIDENCE";

export type HistoricalConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

/** Why a finding was not observed in a run. Absence is never automatically a
 *  fix: NOT_OBSERVED means the area was not meaningfully exercised that run,
 *  OBSERVED_AND_CLEAR means it was probed and came back clean. */
export type DiscoveryVariance = "NOT_OBSERVED" | "OBSERVED_AND_CLEAR";

export type FindingObservationStatus = "PRESENT" | "ABSENT";

export type FindingObservation = {
  runId: string;
  page: string;
  status: FindingObservationStatus;
  /** Run-local finding reference when the finding was present, else null. */
  findingId: string | null;
  code: string | null;
  severity: string | null;
  title: string | null;
  /** Explicit verification disposition when the finding was present. */
  disposition: string | null;
  verdict: string | null;
  /** Status of the most relevant coverage item for this finding in this run,
   *  or null when no coverage evidence exists. */
  relationCoverage: string | null;
  /** Set for ABSENT observations only. */
  discoveryVariance: DiscoveryVariance | null;
  /** True when the observation gives direct evidence the area is clean. */
  verifiedClear: boolean;
};

export type HistoricalFinding = {
  /** Phase 7A/5 semantic finding identity (findingHistoryKey.key). */
  key: string;
  /** Coarse family anchor (findingHistoryKey.family). */
  family: string;
  page: string;
  code: string;
  domain: string;
  severity: string;
  title: string;
  lifecycle: HistoricalFindingState;
  confidence: HistoricalConfidence;
  confidenceReason: string;
  /** Ordered run ids in the analyzed window (present and absent alike). */
  runIds: string[];
  runsObserved: number;
  runsAbsent: number;
  firstSeenRunId: string | null;
  lastSeenRunId: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  latestDisposition: string | null;
  latestVerdict: string | null;
  /** For the latest observation: whether absence is discovery variance. */
  latestDiscoveryVariance: DiscoveryVariance | null;
  reproducedRunIds: string[];
  /** Runs with direct "area is clean" evidence for this finding. */
  clearedRunIds: string[];
  absentRunIds: string[];
  /** Contradictions preserved explicitly (reproduced vs cleared across runs). */
  contradictions: { runId: string; disposition: string; verdict: string | null; note: string }[];
  /** Read-only correlation to Phase 6 root-cause candidates of the latest run. */
  relatedCandidates: { candidateId: string; pattern: string; status: string; confidence: string }[];
  evidence: FindingObservation[];
  reviewNote: string | null;
};

export type FlowStability = "STABLE" | "VARIABLE" | "UNSTABLE" | "INSUFFICIENT_EVIDENCE";

export type FlowHistoricalOutcome = {
  runId: string;
  present: boolean;
  /** Full semantic signature when the flow was discovered this run. */
  signature: string | null;
  title: string | null;
  /** Best execution outcome derived from the run's FLOW coverage evidence. */
  executionOutcome: string | null;
  /** Coverage item status that carried the execution outcome, if any. */
  coverageStatus: string | null;
};

export type FlowStabilityRecord = {
  /** Phase 7A/5 flow family identity (category + normalized start page). */
  familyKey: string;
  /** Latest full signature (category + start page + meaningful step targets). */
  signature: string | null;
  category: string;
  title: string;
  startPage: string;
  stability: FlowStability;
  confidence: HistoricalConfidence;
  confidenceReason: string;
  runIds: string[];
  runCount: number;
  outcomes: FlowHistoricalOutcome[];
  /** Runs where the flow failed (REPRODUCED / REVIEW_REQUIRED). */
  failureRunIds: string[];
  infrastructureRunIds: string[];
  reviewNote: string | null;
};

export type CoverageTrend =
  | "NEWLY_TESTED"
  | "PERSISTENTLY_UNTESTED"
  | "COVERAGE_GAIN"
  | "COVERAGE_LOSS"
  | "COVERAGE_CHANGED"
  | "COVERAGE_STABLE"
  | "INSUFFICIENT_EVIDENCE";

export type CoverageTrendStatus = { runId: string; status: string | null };

export type CoverageTrendRecord = {
  /** Phase 7A/5 coverage semantic key (category + location + name). */
  semanticKey: string;
  category: string;
  name: string;
  trend: CoverageTrend;
  confidence: HistoricalConfidence;
  confidenceReason: string;
  runIds: string[];
  /** Status per run; absent runs are discovery variance, never a loss claim. */
  statuses: CoverageTrendStatus[];
  latestStatus: string | null;
  reviewNote: string | null;
};

/** Run-level infrastructure signal (execution / verification infra problems). */
export type RecurringInfrastructure = {
  infrastructureId: string;
  runIds: string[];
  count: number;
  latestRunId: string | null;
  latestRunCompletedAt: string | null;
  /** One plain-language note per affected run. */
  notes: string[];
  confidence: HistoricalConfidence;
  confidenceReason: string;
};

export type HistoricalRelationshipKind =
  | "PERSISTS_ACROSS_RUNS"   // semantic finding present in >= 2 consecutive-related runs
  | "DISAPPEARS_AFTER_RUN"   // observed in a run, absent in every later run
  | "REAPPEARS_IN_RUN"       // returned in a run after at least one absence
  | "RECURS_IN_RUNS"         // present in >= 3 non-consecutive runs
  | "CONTRADICTED_BY_RUN"    // reproduced in one run, observed-and-clear in another
  | "SUPPORTED_BY_RUN"       // reproduced in >= 2 runs
  | "COVERAGE_GAP"           // a coverage loss / persistently untested trend
  | "FLOW_VARIANCE"          // a flow's signature or outcomes changed across runs
  | "INFRASTRUCTURE_REPEAT"; // infrastructure problems appeared in >= 2 runs

export type HistoricalRelationship = {
  relationshipId: string;
  kind: HistoricalRelationshipKind;
  source: string;
  target: string;
  reason: string;
  runIds: string[];
  confidence: HistoricalConfidence;
};

export type HistoricalQueueKind =
  | "REAPPEARED_HIGH_SEVERITY"
  | "PERSISTENT_HIGH_SEVERITY"
  | "INTERMITTENT_HIGH_SEVERITY"
  | "RECURRING_FLOW_FAILURE"
  | "RECURRING_INFRASTRUCTURE"
  | "PERSISTENT_COVERAGE_GAP";

export type HistoricalInvPriority = "P1" | "P2" | "P3";

export type HistoricalQueueEntry = {
  entryId: string;
  kind: HistoricalQueueKind;
  priority: HistoricalInvPriority;
  priorityReason: string;
  title: string;
  /** Semantic identifier this entry is about. */
  identifier: string;
  runIds: string[];
  confidence: HistoricalConfidence;
};

export type HistoricalIntelligenceSummary = {
  runsAnalyzed: number;
  /** Ordered runs actually used for pattern claims. */
  orderedRuns: number;
  /** Runs excluded from patterns because their persisted ordering is unusable. */
  unorderedRuns: number;
  dateRange: { firstRunStartedAt: string | null; latestRunCompletedAt: string | null };
  findings: { observed: number; new: number; persisting: number; disappeared: number; reappeared: number; recurring: number; intermittent: number; changed: number; unchanged: number; reviewRequired: number; insufficientEvidence: number };
  flows: { observed: number; stable: number; variable: number; unstable: number; insufficientEvidence: number; recurringFailures: number };
  coverage: { trends: number; newlyTested: number; persistentlyUntested: number; gained: number; lost: number; changed: number; stable: number; insufficientEvidence: number };
  infrastructure: { recurringCount: number };
  relationships: number;
  investigationQueue: number;
};

export type HistoricalIntelligenceAiNotes = {
  headline?: string;
  provider: string | null;
};

/** The complete deterministic historical-intelligence result. */
export type HistoricalIntelligenceMap = {
  status: HistoricalStatus;
  schemaVersion: number;
  generatedAt: string;
  siteIdentity: string;
  historyDir: string;
  currentRunId: string | null;
  summary: HistoricalIntelligenceSummary;
  findings: HistoricalFinding[];
  flows: FlowStabilityRecord[];
  coverage: CoverageTrendRecord[];
  infrastructure: RecurringInfrastructure[];
  relationships: HistoricalRelationship[];
  investigationQueue: HistoricalQueueEntry[];
  /** Mandatory: what could and could not be concluded, in plain language. */
  limitations: string[];
  aiNotes: HistoricalIntelligenceAiNotes | null;
};

/** Additive `historicalIntelligence` pointer attached to the QaAnalysis report.
 *  Full trend detail is embedded (read-only) in the JSON report; this is the
 *  section shape the JSON/HTML carry. */
export type HistoricalIntelligenceReportSection = HistoricalIntelligenceMap;

/** Compact view sent to an AI provider for a bounded summary headline. The
 *  classifications, run ids, confidence, and queue are FACTS the provider may
 *  cite but never alter. */
export type HistoricalIntelligenceDigest = {
  url: string;
  title: string;
  runsAnalyzed: number;
  orderingUnusable: number;
  summary: PlaySummary;
  findings: { key: string; lifecycle: HistoricalFindingState; confidence: HistoricalConfidence; severity: string; runIds: string[] }[];
  flows: { familyKey: string; stability: FlowStability; confidence: HistoricalConfidence }[];
  coverage: { semanticKey: string; trend: CoverageTrend }[];
  infrastructureCount: number;
  queue: { entryId: string; kind: HistoricalQueueKind; priority: HistoricalInvPriority; title: string }[];
};

export type PlaySummary = {
  new: number;
  persisting: number;
  disappeared: number;
  reappeared: number;
  recurring: number;
  intermittent: number;
};

/** Bounded AI output: a plain-language headline over the deterministic result. */
export type HistoricalIntelligenceEnhancement = {
  headline?: string;
};