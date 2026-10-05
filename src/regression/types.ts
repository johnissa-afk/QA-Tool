// ---------------------------------------------------------------------------
// Phase 5: regression intelligence.
//
// Two QA runs are compared deterministically into a list of change records.
// A regression is ONLY claimed when evidence shows a previously verified or
// expected condition changed negatively — never because two DOM snapshots
// differ. Infrastructure failures are INFRASTRUCTURE_PROBLEM, never a
// regression. Missing evidence alone is never a FIX: it becomes
// REVIEW_REQUIRED. The classification is always deterministic; an optional AI
// provider may only reword the summary headline or attach per-change notes.
// ---------------------------------------------------------------------------

/** Why a change record carries its confidence. Explicit, evidence-first —
 *  never a fabricated percentage. */
export type RegressionConfidence =
  | "HIGH_CONFIDENCE"
  | "MEDIUM_CONFIDENCE"
  | "LOW_CONFIDENCE"
  | "INSUFFICIENT_EVIDENCE";

export type ChangeCategory =
  | "FINDING"
  | "FLOW"
  | "COVERAGE"
  | "RECOMMENDATION"
  | "PAGE"
  | "RUN";

export type ChangeClassification =
  | "NEW"
  | "FIXED"
  | "REGRESSION"
  | "UNCHANGED"
  | "CHANGED"
  | "NEW_FLOW"
  | "REMOVED_FLOW"
  | "UNCHANGED_FLOW"
  | "CHANGED_FLOW"
  | "COVERAGE_CHANGED"
  | "INFRASTRUCTURE_PROBLEM"
  | "REVIEW_REQUIRED";

/** Compact, comparison-relevant identity of one QA run. No secrets. */
export type RunIdentity = {
  runId: string;
  runLabel: "current" | "baseline";
  origin: string;
  sourceUrl: string;
  scannedAt: string;
  mode: string;
  aiProvider: string;
  schemaVersion: number;
  /** Hash of comparison-relevant configuration (origin, mode, execution/crawl flags). */
  configDigest: string;
};

export type RegressionChange = {
  changeId: string;
  category: ChangeCategory;
  classification: ChangeClassification;
  confidence: RegressionConfidence;
  /** Why this exact confidence was chosen, in plain language. */
  confidenceReason: string;
  /** Stable touchstone: finding code|page, flow category|page, coverage name, etc. */
  anchor: string;
  /** Reference in the current run (id/code/URL), or "(none)". */
  currentReference: string;
  /** Counterpart reference in the baseline run, or "(none)". */
  baselineReference: string;
  /** One-line "what". */
  summary: string;
  /** Evidence-driven "why". */
  explanation: string;
  /** Explicit evidence notes (verification outcomes, executions, statuses). */
  evidence: string[];
  recommendedAction: string;
  relatedFindingIds: string[];
  relatedFlowIds: string[];
  relatedCoverageIds: string[];
  relatedRecommendationIds: string[];
};

export type RegressionSummary = {
  comparable: boolean;
  notComparableReason: string | null;
  changeCount: number;
  counts: Record<ChangeClassification, number>;
  headline: string;
};

/** Bounded AI layer: may reword the headline and add per-change notes.
 *  May never change classifications, confidence, references, or evidence. */
export type RegressionEnhancement = {
  headline?: string;
  notes?: { changeId: string; note: string }[];
  provider?: string | null;
};

export type RegressionMap = {
  schemaVersion: number;
  generatedAt: string;
  baselinePath: string | null;
  summary: RegressionSummary;
  runs: { baseline: RunIdentity; current: RunIdentity };
  changes: RegressionChange[];
  aiNotes: RegressionEnhancement | null;
};

/** A compact regression digest sent to an AI provider so it can summarize or
 *  prioritize what the DETERMINISTIC comparison already established. */
export type RegressionDigest = {
  url: string;
  title: string;
  comparable: boolean;
  counts: Record<ChangeClassification, number>;
  changes: {
    changeId: string;
    category: ChangeCategory;
    classification: ChangeClassification;
    confidence: RegressionConfidence;
    summary: string;
  }[];
};

export type RegressionCompareOptions = {
  /** Path the baseline was loaded from, when it came from a file. */
  baselinePath?: string | null;
  /** Query keys proven volatile for this origin; stripped from page identity.
   *  Empty by default — meaningful parameters are never dropped. */
  ignoreQueryKeys?: string[];
};