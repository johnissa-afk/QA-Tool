import { GeneratedScenario, IntentCategory, Issue, Priority, RiskLevel, ScanReport, AccessPrerequisite } from "../types.js";
import type { FlowAnalysisEnhancement, FlowDigest, FlowDiscovery, FlowSummary } from "../flow/types.js";
import type { CoverageDigest, CoverageEnhancement, CoverageMap, CoverageSummary } from "../coverage/types.js";
import type { RegressionDigest, RegressionEnhancement, RegressionMap } from "../regression/types.js";
import type { IntelligenceDigest, IntelligenceEnhancement, IntelligenceMap } from "../intelligence/types.js";
import type { HistoryReportSection } from "../history/types.js";
import type { HistoricalIntelligenceDigest, HistoricalIntelligenceEnhancement, HistoricalIntelligenceReportSection } from "../history-intelligence/types.js";

export type { CoverageDigest, CoverageEnhancement, CoverageMap, CoverageSummary } from "../coverage/types.js";
export type { RegressionDigest, RegressionEnhancement, RegressionMap } from "../regression/types.js";
export type { IntelligenceDigest, IntelligenceEnhancement, IntelligenceMap } from "../intelligence/types.js";
export type { HistoricalIntelligenceDigest, HistoricalIntelligenceEnhancement, HistoricalIntelligenceReportSection } from "../history-intelligence/types.js";

export const AI_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Core analysis vocabulary.
// ---------------------------------------------------------------------------
export type Mode = "deterministic" | "ai-enhanced";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type Confidence = "high" | "medium" | "low";
export type AutomationStatus = "AUTOMATED" | "REVIEW" | "MANUAL";

// ---------------------------------------------------------------------------
// Finding lifecycle (EXECUTOR = VERIFICATION).
//
// A finding moves through pipeline stages (DISCOVERED -> ANALYZED ->
// TEST_GENERATED -> TEST_EXECUTED) and settles on a terminal outcome after a
// safe verification run: REPRODUCED, NOT_REPRODUCED, PASS, or REVIEW.
//
// The scanner calls an evidence heuristic a POTENTIAL issue (DISCOVERED), the
// analysis layer interprets it deterministically (ANALYZED), a verification
// task may exist (TEST_GENERATED) and run (TEST_EXECUTED). A failed runner
// assertion is NEVER automatically a confirmed website defect: the executor
// classifies LOCATOR / EXPECTATION / INFRASTRUCTURE / WEBSITE / CONDITIONAL /
// AUTHENTICATION / REVIEW failures and the AI triage explains the verdict.
// ---------------------------------------------------------------------------
export type FindingStatus =
  | "DISCOVERED"
  | "ANALYZED"
  | "TEST_GENERATED"
  | "TEST_EXECUTED"
  | "REPRODUCED"
  | "NOT_REPRODUCED"
  | "PASS"
  | "REVIEW";

export type VerificationStatus = "REPRODUCED" | "NOT_REPRODUCED" | "PASS" | "REVIEW";

export type FailureCategory =
  | "WEBSITE"   // live DOM matches the suspected problem (strongest evidence)
  | "EXPECTATION" // element found but the suspected condition did not hold
  | "LOCATOR"   // element no longer present / could not be located reliably
  | "INFRASTRUCTURE" // runner, browser, network, or timeout — not a site check
  | "CONDITIONAL" // state-dependent UI (hidden responsive clone etc.)
  | "AUTHENTICATION" // session/auth gating prevented verification
  | "REVIEW";   // cannot safely determine the result automatically

/** Explicit per-finding verification disposition. Every finding carries one of
 *  these once a verification run completes — nothing is silently dropped. */
export type VerificationDisposition =
  | "SCHEDULED"            // a safe task exists but no outcome was recorded yet
  | "REPRODUCED"           // live DOM matched the suspected problem
  | "NOT_REPRODUCED"       // the problem could not be observed on the live page
  | "PASSED"               // element present but clean (scanner expectation not met)
  | "REVIEW_REQUIRED"      // cannot confirm or rule out without human review
  | "SKIPPED_UNSUPPORTED"  // no safe verification strategy exists for this code
  | "SKIPPED_LOCATOR_GUARD"// no safe/unambiguous locator could be derived
  | "SKIPPED_SAFETY"       // executing the check would exceed safe-guard rails
  | "INFRASTRUCTURE_PROBLEM"; // runner/network/browser failure — not a site verdict

export type TriageVerdict =
  | "LIKELY_DEFECT"
  | "NOT_REPRODUCED"
  | "CONDITIONAL"
  | "INFRASTRUCTURE_PROBLEM"
  | "REVIEW_REQUIRED";

export type VerificationStrategy =
  | "accessible-name"
  | "image-alt"
  | "duplicate-id"
  | "document-title"
  | "language"
  | "viewport"
  | "empty-link"
  | "input-type"
  | "visibility";

export type VerificationEvidence = {
  located: boolean;
  locator: string | null;
  tag: string | null;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  visible: boolean | null;
  enabled: boolean | null;
  href: string | null;
  url: string | null;
  id: string | null;
  attributes: Record<string, string> | null;
  count: number | null;
  screenshotPath: string | null;
};

export type VerificationError = { type: string; message: string };

export type TriageResult = {
  verdict: TriageVerdict;
  reason: string;
  confidence: Confidence;
  provider: string;
};

export type VerificationResult = {
  findingId: string;
  scenarioId: string;
  strategy: VerificationStrategy;
  locator: string | null;
  status: VerificationStatus;
  category: FailureCategory | null;
  executedAt: string | null;
  durationMs: number | null;
  expectation: string;
  evidence: VerificationEvidence;
  error: VerificationError | null;
  triage: TriageResult | null;
};

export type FlowKind =
  | "navigation"
  | "search"
  | "login"
  | "signup"
  | "form"
  | "language"
  | "media"
  | "content"
  | "profile"
  | "error";

export type FlowStatus = "identified" | "blocked";

export type FindingDomain =
  | "accessibility"
  | "navigation"
  | "authentication"
  | "robustness"
  | "content"
  | "console"
  | "performance"
  | "security";

// ---------------------------------------------------------------------------
// Evidence. The AI layer never invents evidence: every claim must trace back
// to a scanner artifact via an EvidenceRef (or an explicit "no element index"
// snapshot locator for issues scanner-side detail could not map to a live element).
// ---------------------------------------------------------------------------
export type EvidenceRef = {
  type: "element" | "console" | "link" | "page" | "authentication";
  /** Index into report.elements/report.consoleDiagnostics/report.links/report.pageErrors. */
  index: number | null;
  locator?: string;
  accessibleName?: string;
  tag?: string;
};

export type QaFinding = {
  id: string;
  code: string;
  status: "FAIL" | "WARNING" | "INFO";
  /** Finding lifecycle stage: DISCOVERED -> ANALYZED -> TEST_GENERATED -> TEST_EXECUTED -> terminal outcome. */
  lifecycle: FindingStatus;
  /** Verification scenarios (SC-VER-*) and related element/intent scenarios that can confirm this finding. */
  relatedScenarioIds: string[];
  /** Compact pointer to the full VerificationResult in QaAnalysis.verifications.
   *  Non-null once a verification run completes (executed, skipped, or
   *  unsupported) so every finding keeps an explicit disposition. */
  verification: {
    disposition: VerificationDisposition;
    scenarioId: string | null;
    status: VerificationStatus | null;
    category: FailureCategory | null;
    verdict: TriageVerdict | null;
    reason: string;
    safety: "safe" | "n/a";
    locator: string | null;
    executedAt: string | null;
    durationMs: number | null;
    error: VerificationError | null;
  } | null;
  domain: FindingDomain;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  recommendation: string;
  userImpact: string;
  rationale: string;
  count: number;
  occurrences?: number;
  evidence: EvidenceRef[];
  examples?: Issue["examples"];
};

export type UserFlow = {
  id: string;
  kind: FlowKind;
  title: string;
  description: string;
  confidence: Confidence;
  status: FlowStatus;
  blockReason?: string;
  trigger: string;
  elements: { locator: string; accessibleName: string | null; role: string | null; visible: boolean }[];
  evidence: EvidenceRef[];
  relatedScenarios: string[];
};

export type IntentScenario = {
  id: string;
  intent: IntentCategory;
  priority: Priority;
  title: string;
  description: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
  automation: AutomationStatus;
  automationReason: string;
  risk: RiskLevel;
  safetyNote?: string;
  evidence: EvidenceRef[];
  relatedScenarios: string[];
  /** QA findings this scenario can confirm, where one exists. */
  findingIds?: string[];
};

export type QaExecution = {
  status: "passed" | "failed" | "error" | "skipped" | "not-run";
  command: string;
  startedAt: string | null;
  durationMs: number | null;
  tests: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  flaky: number | null;
  reproduced: number | null;
  notReproduced: number | null;
  review: number | null;
  infrastructureFailures: number | null;
  failures: { title: string; message: string }[];
};

export type QaSummary = {
  sourceUrl: string;
  scannedAt: string;
  mode: Mode;
  aiProvider: string;
  elementCount: number;
  interactiveElements: number;
  issueCount: number;
  bySeverity: Record<Severity, number>;
  byConfidence: Record<Confidence, number>;
  brokenLinks: number;
  flowsDetected: number;
  intentScenarios: number;
  automatedScenarios: number;
  manualScenarios: number;
  reviewScenarios: number;
  reviewTests: number;
  excludedScenarios: number;
  highRiskScenarios: number;
  overallStatus: "PASS" | "REVIEW" | "FAIL" | "NOT_TESTED" | "BLOCKED";
  headline: string;
  topRecommendations: string[];
  // Verification (EXECUTOR) counts. A finding stays visible even when
  // verification cannot reproduce it — nothing is silently dropped.
  verified: number;
  reproduced: number;
  notReproduced: number;
  pass: number;
  review: number;
  infrastructureFailures: number;
  unverified: number;
  // Explicit disposition counts (Phase 2 hardening). These come directly from
  // the verification result model; the CLI/HTML never invent numbers.
  // `scheduled` = findings that received a verification task (created, whether
  // or not it later executed). `executed` = verification tests that actually
  // ran and produced an outcome. Flow/scenario execution is NEVER counted as
  // verification execution.
  scheduled: number;
  executed: number;
  skippedUnsupported: number;
  skippedLocatorGuard: number;
  skippedSafety: number;
  reviewRequired: number;
  infrastructureProblems: number;
  /** Phase 3: autonomous user-flow discovery + execution counts. */
  flowSummary: FlowSummary | null;
  /** Phase 4: coverage totals — direct counts, never an arbitrary percentage. */
  coverageSummary: CoverageSummary | null;
};

export type QaAnalysis = {
  schemaVersion: number;
  generatedAt: string;
  mode: Mode;
  aiProvider: string;
  scan: ScanReport;
  accessPrerequisite?: AccessPrerequisite;
  findings: QaFinding[];
  flows: UserFlow[];
  scenarios: IntentScenario[];
  /** Element scenarios decorated with intent + priority by the analysis layer. */
  elementScenarios: GeneratedScenario[];
  /** Explicit verification dispositions (EXECUTOR = VERIFICATION). */
  verifications: VerificationResult[];
  /** Phase 3: deterministic autonomous user-flow discovery + safe execution. */
  flowDiscovery: FlowDiscovery | null;
  /** Phase 4: deterministic, evidence-based coverage map + test plan. */
  coverage: CoverageMap | null;
  /** Phase 5: deterministic two-run regression comparison (null until a
   *  baseline is supplied via `--baseline`). Additive, schema stays version 1. */
  regression: RegressionMap | null;
  /** Phase 6: deterministic QA intelligence & root-cause candidates. Built
   *  after executions/coverage/regression land. Additive, schema stays version 1. */
  intelligence: IntelligenceMap | null;
  /** Phase 7A: QA run history & persistence. Additive report section — the
   *  persisted run artifact lives in the history store; this is only a pointer
   *  (status, site identity, current run id, run count). Additive, schema
   *  stays version 1. */
  history?: HistoryReportSection;
  /** Phase 7B: historical intelligence & trends. Deterministic interpretation
   *  of the persisted runs (lifecycle timelines, flow stability, coverage
   *  trends, recurring infrastructure, typed relationships, investigation
   *  queue). Full detail is embedded read-only. Additive, schema stays
   *  version 1, and its own schema is HISTORICAL_INTELLIGENCE_SCHEMA_VERSION. */
  historicalIntelligence?: HistoricalIntelligenceReportSection;
  /** Phase 8E: the resolved configuration this run was executed with. Minimal,
   *  secret-free (the config schema has no secret fields) and additive — the
   *  schema stays version 1. Enables reproducibility: run id + resolved
   *  configuration + pipeline result. */
  configuration?: QaConfigurationSnapshot;
  execution: QaExecution | null;
  summary: QaSummary;
};

/** Sanitized, reproducible snapshot of how a run was configured (Phase 8E). */
export type QaConfigurationSnapshot = {
  /** "defaults" when no qa.config.json was found, otherwise its file name. */
  source: string;
  /** Absolute path of the loaded config file, or null when defaults apply. */
  path: string | null;
  resolved: {
    crawlMaxPages: number;
    execution: boolean;
    coverage: boolean;
    regression: boolean;
    rootCause: boolean;
    history: boolean;
    historicalIntelligence: boolean;
    ciFailOn: string | null;
    /** Phase 9: gate threshold for NEW findings ("HIGH" | "CRITICAL"). */
    ciGateMinSeverity: string;
    /** Phase 10D: baseline rotation policy duration string, or null. */
    baselineMaxAge: string | null;
    /** Phase 11: default baseline artifact path (config baseline.path), or null. */
    baselinePath: string | null;
  };
};

// ---------------------------------------------------------------------------
// AI enhancement contract.
//
// Providers may refine wording, priorities, or severity within bounded limits.
// They may never invent evidence or add new scenarios: scenario authorship stays
// deterministic and evidence-driven.
// ---------------------------------------------------------------------------
export type FindingEnhancement = {
  findingId: string;
  severity?: Severity;
  confidence?: Confidence;
  recommendation?: string;
  userImpact?: string;
  rationale?: string;
};

export type FlowEnhancement = {
  flowId: string;
  title?: string;
  description?: string;
  status?: FlowStatus;
  blockReason?: string;
};

export type ScenarioEnhancement = {
  scenarioId: string;
  title?: string;
  description?: string;
  priority?: Priority;
};

export type Enhancement = {
  findings?: FindingEnhancement[];
  flows?: FlowEnhancement[];
  scenarios?: ScenarioEnhancement[];
  summary?: { headline?: string; topRecommendations?: string[] };
};

export type AIContext = {
  url: string;
  title: string;
  mode: Exclude<Mode, "ai-enhanced">;
  findings: { id: string; code: string; severity: Severity; confidence: Confidence; count: number; message: string }[];
  flows: { id: string; kind: FlowKind; title: string }[];
  scenarios: { id: string; intent: IntentCategory; priority: Priority; title: string }[];
};

export type TriageContext = {
  url: string;
  title: string;
};

export interface AIProvider {
  readonly name: string;
  readonly mode: Mode;
  readonly apiKeyPresent: boolean;
  enhance(context: AIContext): Promise<Enhancement | null>;
  /**
   * Optional EXECUTOR triage refinement: may replace the deterministic
   * verdicts on SOME verification results. Returns a copy with only the
   * `.triage` fields replaced, or null to keep the deterministic triage.
   * Never adds or removes results, and never touches evidence.
   */
  triageVerifications?(results: VerificationResult[], context: TriageContext): Promise<VerificationResult[] | null>;
  /**
   * Optional Phase 3 flow refinement: may reword discovery titles/descriptions
   * or adjust priority within bounds. Never changes evidence, steps, safety,
   * automation, or categories. Returns null to keep the deterministic discovery.
   */
  analyzeFlows?(flows: FlowDigest[], context: TriageContext): Promise<FlowAnalysisEnhancement[] | null>;
  /**
   * Optional Phase 4 coverage refinement: may reword the deterministic gap
   * headlines and reprioritize EXISTING test-plan recommendations (P0–P4).
   * It can never invent items, edit statuses, or unbundle blocked actions.
   * Returns null to keep the deterministic coverage notes.
   */
  analyzeCoverage?(digest: CoverageDigest, context: TriageContext): Promise<CoverageEnhancement | null>;
  /**
   * Optional Phase 5 regression refinement: may reword the comparison headline
   * or attach a note to an EXISTING change id. It can never invent changes,
   * edit classifications, change confidence, or touch evidence. Returns null
   * to keep the fully deterministic comparison.
   */
  analyzeRegression?(digest: RegressionDigest, context: TriageContext): Promise<RegressionEnhancement | null>;
  /**
   * Optional Phase 6 intelligence refinement: may reword an EXISTING root-cause
   * candidate title/description. It can never add or remove candidates, change
   * evidence, confidence, status, investigation actions, or coverage status.
   * Returns null to keep the fully deterministic intelligence map.
   */
  analyzeIntelligence?(digest: IntelligenceDigest, context: TriageContext): Promise<IntelligenceEnhancement | null>;
  /**
   * Optional Phase 7B historical-intelligence refinement: may reword the
   * deterministic summary headline only. It can never alter classifications,
   * run ids, confidence, the investigation queue, or limitations. Returns null
   * to keep the fully deterministic historical intelligence map.
   */
  analyzeHistoricalIntelligence?(digest: HistoricalIntelligenceDigest, context: TriageContext): Promise<HistoricalIntelligenceEnhancement | null>;
}