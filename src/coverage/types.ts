import type { FlowEvidenceRef, FlowPriority, FlowSafety, FlowStepOutcome } from "../flow/types.js";

// ---------------------------------------------------------------------------
// Phase 4: intelligent test planning & coverage.
//
// Coverage is evidence-based — scanning an element is never "testing" it.
// Every coverage item carries the scanner/flow/verification evidence behind its
// status, and every recommendation in the test plan traces back to a coverage
// item. Nothing here knows a specific website: page ids, URLs, flows, findings,
// and verification results are all supplied by the caller.
// ---------------------------------------------------------------------------

/** Coverage domains. The model must at least support these; items reference
 *  concrete evidence (pages, flows, scenarios, findings) behind each one. */
export type CoverageCategory =
  | "PAGE"
  | "NAVIGATION"
  | "FLOW"
  | "INTERACTION"
  | "FORM"
  | "SEARCH"
  | "AUTHENTICATION_BOUNDARY"
  | "LANGUAGE"
  | "MEDIA"
  | "CONTENT_DISCOVERY"
  | "ERROR_HANDLING"
  | "ACCESSIBILITY_CHECK"
  | "RESPONSIVE_CHECK";

/** A coverage verdict. TESTED requires execution evidence: a flow step, a
 *  verification probe, or a live scanner read. Scanning alone never implies
 *  TESTED. */
export type CoverageStatus =
  | "TESTED"
  | "PARTIALLY_TESTED"
  | "NOT_TESTED"
  | "BLOCKED"
  | "REVIEW_REQUIRED"
  | "NOT_APPLICABLE";

export type CoverageSafety = FlowSafety | "NOT_APPLICABLE";

/** Execution evidence behind an item, when one exists. Uses the flow outcome
 *  and verification status vocabulary so the report never invents a new,
 *  disconnected status language. */
export type CoverageExecutionStatus = FlowStepOutcome | string | null;

export type CoverageItem = {
  /** Stable, deterministic id (COV-PAGE-001, COV-FLOW-002, ...). */
  coverageId: string;
  category: CoverageCategory;
  name: string;
  status: CoverageStatus;
  /** Why this item carries this status, in plain language. */
  reason: string;
  safety: CoverageSafety;
  /** The executed outcome behind the status, when available. */
  executionStatus: CoverageExecutionStatus;
  pageId: string | null;
  url: string | null;
  /** Discovered-flow ids (FLOW-001) that exercise this item. */
  relatedFlows: string[];
  /** Scenario ids (SC-VER-*, SC-*) attached to this item. */
  relatedScenarios: string[];
  /** Finding ids (QA-F-*) attached to this item. */
  relatedFindings: string[];
  /** Scanner/flow evidence trail. Never inferred — always a fact. */
  evidence: FlowEvidenceRef[];
};

/** A test-plan step. Every recommendation must trace to >= 1 coverage item
 *  (section 16) — orphan recommendations are not generated. */
export type TestPlanRecommendationType =
  | "TEST_PAGE"
  | "TEST_NAVIGATION"
  | "EXECUTE_FLOW"
  | "COMPLETE_FLOW"
  | "REVIEW_FLOW"
  | "REVIEW_BLOCKED_FLOW"
  | "TEST_SEARCH_FLOW"
  | "COMPLETE_SEARCH"
  | "REVIEW_LANGUAGE_SWITCH"
  | "REVIEW_MEDIA"
  | "REVIEW_AUTHENTICATION_BOUNDARY"
  | "INVESTIGATE_BROKEN_NAVIGATION"
  | "REVIEW_NAVIGATION"
  | "INVESTIGATE_ERROR_HANDLING"
  | "TEST_CONTENT_DISCOVERY"
  | "INSPECT_UNTESTED_FORM"
  | "REVIEW_FORM"
  | "REVIEW_BLOCKED_FORM"
  | "VERIFY_ACCESSIBILITY"
  | "REVIEW_ACCESSIBILITY"
  | "RESPONSIVE_CHECK"
  | "REVIEW_PAGE"
  | "TEST_INTERACTION_GROUP"
  | "REVIEW_INTERACTION_GROUP";

export type TestPlanRecommendation = {
  recommendationId: string;
  type: TestPlanRecommendationType;
  title: string;
  reason: string;
  priority: FlowPriority;
  priorityReason: string;
  /** Coverage items this recommendation targets. */
  coverageIds: string[];
  relatedFindings: string[];
  evidence: FlowEvidenceRef[];
};

/** Plain-language coverage totals (section 17). No arbitrary percentage is
 *  ever derived: each number is a direct count of items or executions. */
export type CoverageSummary = {
  pages: { discovered: number; tested: number; partial: number; untested: number; blocked: number; review: number };
  flows: { discovered: number; executed: number; passed: number; reproduced: number; notReproduced: number; review: number; blocked: number };
  interactions: { tested: number; partial: number; untested: number; review: number; notApplicable: number };
  findings: { analyzed: number; verified: number; reproduced: number; notReproduced: number; unverified: number };
  recommendations: number;
};

export function emptyCoverageSummary(): CoverageSummary {
  return {
    pages: { discovered: 0, tested: 0, partial: 0, untested: 0, blocked: 0, review: 0 },
    flows: { discovered: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, review: 0, blocked: 0 },
    interactions: { tested: 0, partial: 0, untested: 0, review: 0, notApplicable: 0 },
    findings: { analyzed: 0, verified: 0, reproduced: 0, notReproduced: 0, unverified: 0 },
    recommendations: 0,
  };
}

/** Bounded AI notes on top of the deterministic coverage map. AI may only
 *  reword gap summaries and adjust priority on EXISTING recommendations; it
 *  can never invent coverage, change statuses, or un-block actions. */
export type CoverageAiNotes = {
  gaps: string[];
  prioritization: { recommendationId: string; priority: FlowPriority; reason: string }[];
  provider: string | null;
};

export type CoverageMap = {
  generatedAt: string;
  items: CoverageItem[];
  summary: CoverageSummary;
  testPlan: TestPlanRecommendation[];
  aiNotes: CoverageAiNotes | null;
};

/** Compact coverage view sent to an AI provider for bounded refinement.
 *  Items and statuses are facts the provider can cite; it may reword gaps and
 *  reprioritize, never edit this shape. */
export type CoverageDigest = {
  url: string;
  title: string;
  pagesTotal: number;
  statusTotals: Record<CoverageStatus, number>;
  gaps: string[];
  recommendations: { recommendationId: string; type: TestPlanRecommendationType; title: string; priority: FlowPriority }[];
};

/** Bounded AI output. Gaps are rewrites of deterministic headlines; priorities
 *  apply to EXISTING recommendationIds only (P0–P4). Anything else is ignored. */
export type CoverageEnhancement = {
  gaps?: string[];
  prioritization?: { recommendationId: string; priority: FlowPriority; reason: string }[];
};