// ---------------------------------------------------------------------------
// Phase 7A — QA Run History & Persistence.
//
// Phase 7A establishes the MEMORY layer: it persists comparable QA runs and
// gives stable SEMANTIC identity to the site, findings, flows, and coverage
// items so the SAME thing can be recognized across runs. It does NOT yet
// interpret history (no recurrence, trends, stability scoring, intermittency,
// or investigation intelligence — those are Phase 7B).
//
// Two hard contracts:
//   1. NEVER a second identity system. Everything here rides on the Phase 5/6
//      identity primitives (regression/identity.ts + intelligence/identity.ts).
//   2. NEVER a claim about what history MEANS. Phase 7A answers "are these the
//      same things across runs?" — never "what does that mean?"
//
// Schema version 1, additive-only. Secrets never persisted.
// ---------------------------------------------------------------------------

export const HISTORY_SCHEMA_VERSION = 1;

export type HistorySiteKey = {
  origin: string;
  normalizedStartPage: string;
  configDigest: string;
};

/** Stable per-run identity, secret-free. */
export type HistoryRunIdentity = HistorySiteKey & {
  runId: string;
};

/** Canonical, inspectable site-identity string (origin + start page + config
 *  digest). Stable across runs that target the same site under the same
 *  configuration. Never contains generated ids, selectors, or secrets. */
export type HistorySiteIdentity = string;

/** Per-run metadata record. Persisted in the history index AND derivable from
 *  the run artifact. Represents the execution itself, never historical
 *  interpretation. */
export type QaRunRecord = {
  runId: string;
  siteKey: HistorySiteKey;
  siteIdentity: string;
  entryUrl: string;
  startedAt: string;
  completedAt?: string | null;
  schemaVersion: number;
  mode: string;
  aiProvider: string;
  scannedOriginUrl: string;
  environment?: string;
  browser?: string;
  findingCount: number;
  flowCount: number;
  coverageCount: number;
  /** Verification surface: findings that ended up with an explicit disposition. */
  executionPlanned: number;
  executionReproduced: number;
  executionNotReproduced: number;
  executionInfraProblems: number;
  headline: string;
  /** sha1 digest over every semantic identity recorded for this run; lets a
   *  later phase detect "same run, different content" cheaply. */
  identityDigest: string;
  /** Path of the persisted run artifact, when this record came from the store. */
  artifactPath?: string;
};

export type HistoryState = {
  schemaVersion: number;
  runs: QaRunRecord[];
  latestRunId: string | null;
};

export type HistoryStatus = "AVAILABLE" | "EMPTY" | "UNAVAILABLE" | "INCOMPATIBLE";

export type HistoryLoadResult = {
  status: HistoryStatus;
  /** Plain-language reason, when status is not AVAILABLE (or when warnings exist). */
  reason: string | null;
  /** Per-run problems (missing/malformed/mismatched artifact, duplicate id) —
   *  never silently swallowed, never treated as valid history. */
  warnings: string[];
  state: HistoryState | null;
  historyDir: string;
};

export type PersistRunResult = {
  persisted: boolean;
  runId: string | null;
  status: HistoryStatus;
  runsAvailable: number;
  /** Set when a run with the same runId already exists and was NOT overwritten. */
  duplicateRunId: boolean;
  historyDir: string;
  reason: string | null;
};

export type ResetHistoryResult = {
  reset: boolean;
  historyDir: string;
  /** Absolute paths of the history files that were removed. */
  removed: string[];
};

/** Per-site bucket inside the history index. Keeps sites isolated: persisting
 *  or loading for one site never touches another site's bucket. */
export type HistorySiteBucket = {
  siteKey: HistorySiteKey;
  siteKeyId: string;
  runs: QaRunRecord[];
};

/** The persistent history index. Metadata only — full run artifacts live in
 *  `runs/<run-id>.json` and are the source of truth for every run. */
export type HistoryIndex = {
  schemaVersion: number;
  sites: HistorySiteBucket[];
};

// ---------------------------------------------------------------------------
// Run artifact snapshot types (persisted evidence). Every identity below is a
// SEMANTIC key computed from Phase 5/6 identity rules — never a generated id,
// array position, or raw selector.
// ---------------------------------------------------------------------------

export type FindingHistorySnapshot = {
  /** Run-local reference (QA-F-001) — kept for traceability, NEVER identity. */
  findingId: string;
  /** Normalized page identity (Phase 5 normalizePageUrl). */
  page: string;
  /** semantic identity (findingSignature.key). */
  semanticKey: string;
  /** coarse family anchor (findingSignature.family). */
  family: string;
  code: string;
  domain: string;
  severity: string;
  status: string;
  lifecycle: string;
  title: string;
  description: string;
  verification: {
    disposition: string;
    status: string | null;
    category: string | null;
    verdict: string | null;
    reason: string;
    safety: string;
    executedAt: string | null;
    durationMs: number | null;
  } | null;
  /** Redacted evidence references (locator text included, secrets stripped). */
  evidence: { type: string; index: number | null; locator?: string; accessibleName?: string; tag?: string }[];
};

export type VerificationHistorySnapshot = {
  scenarioId: string;
  findingId: string;
  strategy: string;
  status: string | null;
  category: string | null;
  verdict: string | null;
  confidence: string | null;
  executedAt: string | null;
  durationMs: number | null;
  locator: string | null;
};

export type FlowStepHistorySnapshot = {
  index: number;
  action: string;
  /** semantic step identity (flowStepKey) — locator-free. */
  targetKey: string;
  targetUrl: string | null;
  safety: string;
  automation: string;
  expected: string;
};

export type FlowHistorySnapshot = {
  /** Run-local reference (FLOW-001) — NEVER identity. */
  flowId: string;
  category: string;
  /** Normalized start page. */
  startPage: string;
  /** Loose semantic identity: category + normalized start page. */
  familyKey: string;
  /** Full semantic identity: category + start page + meaningful step sequence. */
  signature: string;
  title: string;
  description: string;
  safety: string;
  automation: string;
  executable: boolean;
  priority: string;
  occurrenceCount: number;
  confidence: string;
  boundary: { stepIndex: number; safety: string; automation: string; reason: string } | null;
  steps: FlowStepHistorySnapshot[];
};

export type CoverageHistorySnapshot = {
  /** Run-local reference (COV-*) — NEVER identity. */
  coverageId: string;
  /** semantic identity (coverageItemSignature). */
  semanticKey: string;
  category: string;
  name: string;
  status: string;
  reason: string;
  safety: string;
  executionStatus: string | null;
  pageId: string | null;
  url: string | null;
  relatedFlows: string[];
  relatedScenarios: string[];
  relatedFindings: string[];
  evidence: { pageId: string | null; elementIndex: number | null; detail: string }[];
};

export type RegressionHistorySnapshot = {
  comparable: boolean;
  notComparableReason: string | null;
  changeCount: number;
  counts: Record<string, number>;
  headline: string;
  baselineReference: { runId: string; scannedAt: string } | null;
  currentReference: { runId: string; scannedAt: string } | null;
  /** Compact change records (classifications + anchors only; full evidence
   *  stays in the run's own regression map in the main report). */
  changes: { changeId: string; category: string; classification: string; confidence: string; anchor: string; summary: string }[];
};

export type IntelligenceHistorySnapshot = {
  generatedAt: string;
  candidates: number;
  actionable: number;
  investigationRequired: number;
  insufficientEvidence: number;
  informational: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  insufficientConfidence: number;
  relationships: number;
  contradictions: number;
  investigationQueue: number;
  rootCauseCandidates: {
    candidateId: string;
    pattern: string;
    status: string;
    confidence: string;
    title: string;
    findingIds: string[];
    flowIds: string[];
    affectedPages: string[];
  }[];
};

/** Complete persisted run artifact. Contains the run metadata plus every
 *  semantic identity and the evidence needed for later historical matching.
 *  Never contains secrets, full DOM snapshots, or raw crawl ordering. */
export type HistoryRunSnapshot = {
  schemaVersion: number;
  runId: string;
  siteKey: HistorySiteKey;
  siteIdentity: string;
  entryUrl: string;
  startedAt: string;
  completedAt: string | null;
  mode: string;
  aiProvider: string;
  scannedOriginUrl: string;
  environment: string | null;
  browser: string | null;
  summary: {
    headline: string;
    findingCount: number;
    flowCount: number;
    coverageCount: number;
    executionPlanned: number;
    executionReproduced: number;
    executionNotReproduced: number;
    executionInfraProblems: number;
  };
  findings: FindingHistorySnapshot[];
  verifications: VerificationHistorySnapshot[];
  flows: FlowHistorySnapshot[];
  coverage: CoverageHistorySnapshot[];
  regression: RegressionHistorySnapshot | null;
  intelligence: IntelligenceHistorySnapshot | null;
  /** sha1 over every semantic identity in this snapshot. */
  identityDigest: string;
};

/** Additive `history` section attached to the current QaAnalysis JSON/HTML
 *  report. References the store; never duplicates full standalone history. */
export type HistoryReportSection = {
  status: HistoryStatus;
  schemaVersion: number;
  siteIdentity: string;
  currentRunId: string | null;
  runsAvailable: number;
  historyDir: string;
  note: string;
};