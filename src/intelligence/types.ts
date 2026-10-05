// ---------------------------------------------------------------------------
// Phase 6: QA Intelligence & Root-Cause Analysis.
//
// The intelligence layer aggregates deterministic evidence (findings,
// executions, discovered flows, coverage, regression) into EXPLAINABLE
// groupings and root-cause CANDIDATES. Every claim traces back to an evidence
// relationship with an explicit reason; contradicting evidence is actively
// sought and never hidden; confidence is derived from evidence strength (never
// a fabricated percentage); and only safe, read-only investigation actions are
// proposed. Nothing here knows a specific website.
// ---------------------------------------------------------------------------

export type IntelligenceStatus =
  | "ACTIONABLE"              // evidence points to a concrete defect and a safe next step
  | "INVESTIGATION_REQUIRED"  // signals exist BUT contradicting/weak evidence forces human review
  | "INSUFFICIENT_EVIDENCE"   // too weak or conflicted to reason about reliably
  | "INFORMATIONAL";          // observation only — explicitly NOT a website-defect claim

export type RootCauseConfidence =
  | "HIGH"          // multiple independent evidence sources agree
  | "MEDIUM"        // multiple related observations, incomplete causal evidence
  | "LOW"           // a weak or single signal
  | "INSUFFICIENT"; // contradicting or too weak to decide

export type EvidenceRelation =
  | "SUPPORTS"
  | "CONTRADICTS"
  | "RELATED";

/** Why two pieces of evidence are related. Relationships are only ever built
 *  on normalized semantic identity — never on shared words, strings, severity,
 *  URL text, selectors, or a category alone. */
export type EvidenceRelationReason =
  | "SAME_SEMANTIC_TARGET"      // both resolve to the same normalized element identity
  | "SAME_NORMALIZED_PAGE"      // both live on the same normalized page
  | "SAME_FLOW"                 // both belong to one discovered flow (finding → flow scenario)
  | "SAME_EXECUTION_EVIDENCE"   // identical failure signature across executions
  | "REGRESSION_CORRELATION"    // the regression comparison linked them explicitly
  | "SAME_CATEGORY";            // same domain/category — supporting CONTEXT only, never identity

export type EvidenceSourceKind =
  | "FINDING"
  | "EXECUTION"
  | "FLOW"
  | "SCENARIO"
  | "REGRESSION"
  | "COVERAGE";

export type RelationshipEndpoint = {
  kind: EvidenceSourceKind;
  refId: string;
  label: string;
};

export type EvidenceRelationship = {
  relationshipId: string;
  relation: EvidenceRelation;
  reason: EvidenceRelationReason;
  description: string;
  from: RelationshipEndpoint;
  to: RelationshipEndpoint;
};

export type CandidatePattern =
  | "VERIFIED_REGENERATION"  // A: a11y finding + flow stall on the same semantic target
  | "SHARED_SEMANTIC_TARGET" // B: multiple flows stall at the same semantic target
  | "VERIFIED_REGRESSION"    // C: baseline passed → current failed, reproduced + same target
  | "INFRASTRUCTURE"         // D: runner/network failures — never a website defect
  | "DISCOVERY_VARIANCE"     // E: removed flow / coverage change without verification evidence
  | "SINGLE_OBSERVATION";    // one weak signal — cannot support a defect claim

export type InvestigationActionKind =
  | "INSPECT_ELEMENT"             // read the live accessible name/role of the target
  | "COMPARE_BASELINE_ATTRIBUTES" // diff current attributes vs baseline evidence
  | "RE_RUN_SAFE_NAV_FLOW"        // re-run a safe navigation flow and observe
  | "VERIFY_SECOND_FLOW_TARGET"   // confirm the same target stalls a second flow
  | "CHECK_OUTSIDE_AUTH_BOUNDARY" // re-check the target outside the auth boundary
  | "CHECK_CRAWL_VARIANCE";       // re-crawl and compare discovery stability

export type InvestigationAction = {
  actionId: string;
  kind: InvestigationActionKind;
  title: string;
  detail: string;
  /** Every proposed action is safe and read-only. Destructive actions are never
   *  generated. The type is a literal `true` so a wrong value cannot compile. */
  safe: true;
  target: string | null;
};

export type RootCauseCandidate = {
  candidateId: string;
  title: string;
  description: string;
  pattern: CandidatePattern;
  confidence: RootCauseConfidence;
  /** Why this confidence was chosen, in plain language. */
  confidenceReason: string;
  status: IntelligenceStatus;
  findingIds: string[];
  scenarioIds: string[];
  flowIds: string[];
  affectedPages: string[];
  affectedCategories: string[];
  supportingEvidence: EvidenceRelationship[];
  contradictingEvidence: EvidenceRelationship[];
  investigationActions: InvestigationAction[];
  /** Coverage map status of the affected items — evidence only, never edited. */
  coverageImpact: string[];
  /** Regression change summaries correlated to this candidate. */
  regressionContext: string[];
};

export type InvestigationPriority = "P1" | "P2" | "P3";

export type InvestigationQueueEntry = {
  entryId: string;
  candidateId: string;
  priority: InvestigationPriority;
  /** Why this priority was chosen, in plain language (no arbitrary scores). */
  priorityReason: string;
  title: string;
};

export type IntelligenceSummary = {
  candidates: number;
  /** Direct counts of candidates by status/confidence — never percentages. */
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
};

export type IntelligenceAiNotes = {
  wording?: { candidateId: string; title?: string; description?: string }[];
  provider: string | null;
};

export type IntelligenceMap = {
  status: "AVAILABLE";
  schemaVersion: number;
  generatedAt: string;
  summary: IntelligenceSummary;
  rootCauseCandidates: RootCauseCandidate[];
  evidenceRelationships: EvidenceRelationship[];
  investigationQueue: InvestigationQueueEntry[];
  aiNotes: IntelligenceAiNotes | null;
};

/** Compact intelligence view sent to an AI provider for bounded refinement.
 *  The candidate set, confidence, statuses, and evidence are FACTS the provider
 *  may cite; it may only reword a candidate title/description. */
export type IntelligenceDigest = {
  url: string;
  title: string;
  candidates: {
    candidateId: string;
    status: IntelligenceStatus;
    confidence: RootCauseConfidence;
    pattern: CandidatePattern;
    title: string;
    findingIds: string[];
    flowIds: string[];
    affectedPages: string[];
  }[];
};

/** Bounded AI output: title/description rewrites for EXISTING candidate ids. */
export type IntelligenceEnhancement = {
  wording?: { candidateId: string; title?: string; description?: string }[];
};