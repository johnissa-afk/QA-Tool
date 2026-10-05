// ---------------------------------------------------------------------------
// Productized QA results view model.
//
// This module is a PURE CONSUMER of a completed run's QaAnalysis artifact. It
// re-derives nothing, runs nothing, and invents nothing: every number, status,
// and sentence below is either copied from the report or composed from real
// report counts. Its only job is to reshape the report into the exact view the
// results screen renders, so the browser stays a thin renderer and the mapping
// is unit-testable without a DOM.
//
// Rules enforced here (productization contract):
//   - No overall quality/health score, and no percentage that the backend does
//     not already provide. Only direct counts.
//   - The five QA statuses are passed through untouched: PASS, FAIL, REVIEW,
//     BLOCKED, NOT_TESTED. Nothing is collapsed into "OK".
//   - An access prerequisite (login wall, bot protection) is reported as an
//     ACCESS BOUNDARY, never as a website defect.
//   - Untested work is always stated, never silently dropped, and every gap
//     carries the real reason the report recorded for it.
//   - Archived/history runs that do not carry a full report are not rendered
//     here; callers surface an honest unavailable message instead.
// ---------------------------------------------------------------------------
import type { QaAnalysis, QaFinding } from "../ai/types.js";
import type { CoverageCategory, CoverageItem, CoverageStatus } from "../coverage/types.js";
import type {
  DiscoveredFlow,
  FlowCategory,
  FlowDiscovery,
  FlowExecutionResult,
  FlowPriority,
  FlowStep,
  FlowStepExecutionResult,
  FlowStepOutcome,
} from "../flow/types.js";
import type { AccessPrerequisite } from "../types.js";
import { listFindings, type FindingSummary, type RunArtifact } from "./evidence.js";

export type QaStatus = "PASS" | "FAIL" | "REVIEW" | "BLOCKED" | "NOT_TESTED";

export const QA_STATUSES: readonly QaStatus[] = ["PASS", "FAIL", "REVIEW", "BLOCKED", "NOT_TESTED"];

const isQaStatus = (value: unknown): value is QaStatus => (QA_STATUSES as readonly string[]).includes(String(value));

/** A single labelled count. `detail` carries the plain-language definition. */
export type CountRow = { id: string; label: string; value: number; detail?: string };

/** A recorded engine error, never reworded into a verdict. */
export type ErrorView = { type: string | null; message: string } | null;

export type OverviewView = {
  url: string;
  finalUrl: string | null;
  title: string | null;
  /** Web run id — the id used by the dashboard API and by the URL. */
  runId: string;
  /** Engine history run id, when this run was persisted. */
  historyRunId: string | null;
  historyRunsAvailable: number | null;
  generatedAt: string;
  scannedAt: string | null;
  durationMs: number | null;
  mode: string;
  aiProvider: string | null;
  status: QaStatus;
  statusExplanation: string;
  headline: string;
  /** A short, real coverage statement, e.g. "6 of 8 pages tested". */
  coverageStatement: string | null;
  findingsAnalyzed: number;
};

export type AccessBannerView = {
  kind: "AUTHENTICATION_REQUIRED" | "BOT_PROTECTION" | "ACCESS_BLOCKED" | "UNKNOWN";
  headline: string;
  message: string;
  httpStatus: number | null;
  challenge: string | null;
  /** Always true: an access prerequisite is a test boundary, not a defect. */
  isNotADefect: true;
  /** What could not be tested because of the boundary. */
  impact: string;
};

export type FindingCardView = {
  id: string;
  code: string;
  title: string;
  severity: string;
  status: string;
  lifecycle: string;
  domain: string;
  confidence: string;
  page: string | null;
  occurrenceCount: number;
  rootCauseCandidates: number;
  verification: { disposition: string; status: string | null; verdict: string | null } | null;
  /** The single most useful sentence for a collapsed finding. */
  headline: string;
  /** Direct link to the bounded detail view for this finding. */
  detailPath: string;
};

export type VerificationView = {
  available: boolean;
  headline: string;
  counters: CountRow[];
  verdicts: {
    findingId: string;
    findingTitle: string | null;
    scenarioId: string;
    locator: string | null;
    status: string | null;
    category: string | null;
    verdict: string | null;
    reason: string;
    durationMs: number | null;
    error: ErrorView;
  }[];
  infrastructureNotes: string[];
  /** False when the run recorded no verification outcome at all. */
  executed: boolean;
  emptyMessage: string | null;
};

export type CoverageGroupView = {
  id: "discovered" | "executed" | "untested";
  title: string;
  note: string;
  rows: CountRow[];
};

export type GapItemView = {
  coverageId: string;
  name: string;
  category: string;
  status: string;
  reason: string;
  url: string | null;
  safety: string;
  relatedFlows: string[];
  relatedFindings: string[];
};

export type GapGroupView = {
  id: string;
  kind: "not-tested" | "partial" | "review" | "blocked";
  title: string;
  count: number;
  confidenceNote: string;
  reasons: string[];
  items: GapItemView[];
  omitted: number;
};

export type RecommendationView = {
  recommendationId: string;
  title: string;
  reason: string;
  priority: FlowPriority;
  priorityReason: string;
  coverageIds: string[];
  relatedFindings: string[];
};

export type CoverageView = {
  available: boolean;
  headline: string;
  statement: string | null;
  groups: CoverageGroupView[];
  gapGroups: GapGroupView[];
  recommendations: RecommendationView[];
  emptyMessage: string | null;
};

export type FlowStepView = {
  index: number;
  action: string;
  targetUrl: string | null;
  locator: string | null;
  text: string | null;
  expected: string;
  safety: string;
  automation: string;
  reason: string;
  outcome: string | null;
  category: string | null;
  outcomeReason: string | null;
  durationMs: number | null;
  error: ErrorView;
};

export type FlowView = {
  flowId: string;
  title: string;
  description: string;
  category: FlowCategory;
  priority: FlowPriority;
  priorityReason: string;
  startUrl: string;
  safety: string;
  automation: string;
  executable: boolean;
  status: string;
  boundary: { stepIndex: number; safety: string; automation: string; reason: string } | null;
  steps: FlowStepView[];
  execution: {
    status: string;
    failureCategory: string | null;
    startedUrl: string;
    finalUrl: string | null;
    executedAt: string | null;
    durationMs: number | null;
    stoppedAtStep: number | null;
    boundary: string | null;
    error: ErrorView;
  } | null;
  reason: string;
  evidenceCount: number;
};

export type FlowSectionView = {
  available: boolean;
  headline: string;
  counters: CountRow[];
  items: FlowView[];
  /** Flows discovered but never executed, with the real reason. */
  notExecuted: { flowId: string; title: string; reason: string; priority: FlowPriority; safety: string; automation: string; boundary: string | null }[];
  emptyMessage: string | null;
};

export type ReportsView = {
  html: string | null;
  json: string;
  execution: string | null;
};

export type EmptyStatesView = {
  noFindings: boolean;
  noFlows: boolean;
  noVerification: boolean;
  noGaps: boolean;
  noCoverage: boolean;
  noAccessIssue: boolean;
  messages: {
    findings: string | null;
    flows: string | null;
    verification: string | null;
    gaps: string | null;
    coverage: string | null;
  };
};

export type ResultsView = {
  overview: OverviewView;
  access: AccessBannerView | null;
  metrics: CountRow[];
  findings: {
    items: FindingCardView[];
    total: number;
    reproduced: number;
    notReproduced: number;
    passed: number;
    reviewRequired: number;
    unverified: number;
  };
  verification: VerificationView;
  coverage: CoverageView;
  flows: FlowSectionView;
  reports: ReportsView;
  empty: EmptyStatesView;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" && value.trim() !== "" ? value.trim() : "");
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOrNull = (value: unknown): string | null => (str(value) || null);
const array = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

/** Maps a recorded disposition/status to a plain-language outcome label. */
const DISPOSITION_LABEL: Record<string, string> = {
  REPRODUCED: "Reproduced on the live page",
  NOT_REPRODUCED: "Not reproduced on the live page",
  PASSED: "Checked and clean",
  SCHEDULED: "Verification scheduled but not yet executed",
  REVIEW_REQUIRED: "Requires human review",
  SKIPPED_UNSUPPORTED: "Skipped — no safe verification strategy exists",
  SKIPPED_LOCATOR_GUARD: "Skipped — no safe, unambiguous locator",
  SKIPPED_SAFETY: "Skipped — executing the check would exceed safety limits",
  INFRASTRUCTURE_PROBLEM: "Skipped — runner, browser, or network problem",
};

const dispositionLabel = (disposition: string | null | undefined, status: string | null | undefined): string => {
  if (status === "REPRODUCED") return DISPOSITION_LABEL.REPRODUCED!;
  if (status === "NOT_REPRODUCED") return DISPOSITION_LABEL.NOT_REPRODUCED!;
  if (status === "PASS") return DISPOSITION_LABEL.PASSED!;
  if (status === "REVIEW") return DISPOSITION_LABEL.REVIEW_REQUIRED!;
  if (disposition && DISPOSITION_LABEL[disposition]) return DISPOSITION_LABEL[disposition]!;
  if (disposition) return disposition.replace(/_/g, " ").toLowerCase();
  return "No verification outcome was recorded for this finding";
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function statusExplanation(analysis: QaAnalysis, status: QaStatus, access: AccessBannerView | null, executed: number, reproduced: number, reviewRequired: number, untestedItems: number): string {
  const accessMessage = access ? (access.message || access.headline) : "";
  switch (status) {
    case "BLOCKED":
      return accessMessage
        ? `Website access was blocked, so normal testing did not run. ${accessMessage}`
        : "Website access was blocked, so normal testing did not run.";
    case "REVIEW":
      if (access) return `Human review is required before this result can be considered complete. ${accessMessage}`;
      if (reviewRequired > 0) {
        return `Automated verification could not decide ${plural(reviewRequired, "item")} with confidence, so human review is required.`;
      }
      return "This run requires human review before the result can be considered complete.";
    case "FAIL":
      if (reproduced > 0) {
        return `Automated verification reproduced ${plural(reproduced, "issue")} on the live website.${untestedItems > 0 ? ` ${plural(untestedItems, "item")} also remain untested.` : ""}`;
      }
      return accessMessage || "This run failed without a reproduced finding. Review the evidence and gaps below.";
    case "PASS":
      if (executed === 0) return "No executable automated check ran, so this result cannot confirm website health.";
      if (untestedItems > 0) {
        return `Verification completed and reproduced no issues, but ${plural(untestedItems, "item")} remain untested or need review.`;
      }
      return "Verification completed and reproduced no issues. Every discovered area was executed or did not apply.";
    case "NOT_TESTED":
    default:
      if (executed === 0) {
        return untestedItems > 0
          ? `No executable automated check completed, so website health is unconfirmed. ${plural(untestedItems, "item")} were discovered but never tested.`
          : "No executable automated check completed, so website health is unconfirmed.";
      }
      return "Automated checks ran, but the run did not produce a pass or failure verdict.";
  }
}

function coverageStatement(analysis: QaAnalysis): string | null {
  const pages = analysis.coverage?.summary.pages;
  if (pages) {
    const detail = [`${pages.tested} of ${pages.discovered} pages tested`];
    if (pages.partial > 0) detail.push(`${pages.partial} partial`);
    if (pages.untested > 0) detail.push(`${pages.untested} untested`);
    if (pages.blocked > 0) detail.push(`${pages.blocked} blocked`);
    if (pages.review > 0) detail.push(`${pages.review} needing review`);
    return detail.join(", ");
  }
  const flowSummary = analysis.flowDiscovery?.summary;
  if (flowSummary) return `${flowSummary.executed} of ${flowSummary.flows} discovered flows executed`;
  return null;
}

function buildOverview(analysis: QaAnalysis, runId: string, access: AccessBannerView | null, executed: number, reproduced: number, reviewRequired: number, untestedItems: number): OverviewView {
  const summary = analysis.summary ?? ({} as QaAnalysis["summary"]);
  const rawStatus = summary?.overallStatus;
  const status: QaStatus = isQaStatus(rawStatus) ? rawStatus : "NOT_TESTED";
  const scan = (analysis.scan ?? undefined)?.scan;
  return {
    url: str(summary?.sourceUrl) || str(scan?.url) || str(analysis.scan?.scan?.url),
    finalUrl: textOrNull(scan?.finalUrl),
    title: textOrNull(scan?.title),
    runId,
    historyRunId: textOrNull(analysis.history?.currentRunId),
    historyRunsAvailable: numOrNull(analysis.history?.runsAvailable),
    generatedAt: str(analysis.generatedAt),
    scannedAt: textOrNull(scan?.timestamp) || textOrNull(summary?.scannedAt),
    durationMs: numOrNull(scan?.durationMs) ?? numOrNull(analysis.execution?.durationMs),
    mode: str(summary?.mode) || str(analysis.mode),
    aiProvider: textOrNull(summary?.aiProvider) ?? textOrNull(analysis.aiProvider),
    status,
    statusExplanation: statusExplanation(analysis, status, access, executed, reproduced, reviewRequired, untestedItems),
    headline: str(summary?.headline) || "This run recorded no headline summary.",
    coverageStatement: coverageStatement(analysis),
    findingsAnalyzed: num(summary?.issueCount) || array<QaFinding>(analysis.findings).length,
  };
}

// ---------------------------------------------------------------------------
// Access boundary
// ---------------------------------------------------------------------------
function buildAccess(analysis: QaAnalysis): AccessBannerView | null {
  const prereq: AccessPrerequisite | undefined = analysis.accessPrerequisite ?? analysis.scan?.accessPrerequisite;
  if (!prereq) return null;
  const type = str(prereq.type);
  if (type === "accessible") return null;

  let kind: AccessBannerView["kind"];
  if (type === "authentication-required" || type === "login-required") kind = "AUTHENTICATION_REQUIRED";
  else if (type === "bot-protection") kind = "BOT_PROTECTION";
  else if (type === "access-blocked") kind = "ACCESS_BLOCKED";
  else kind = "UNKNOWN";

  const headline =
    kind === "AUTHENTICATION_REQUIRED"
      ? "AUTHENTICATION REQUIRED"
      : kind === "BOT_PROTECTION"
        ? "BOT / ACCESS PROTECTION"
        : kind === "ACCESS_BLOCKED"
          ? "ACCESS BLOCKED"
          : "ACCESS COULD NOT BE DETERMINED";

  const message = str(prereq.message) || "Automated testing could not reach the normal website content.";
  return {
    kind,
    headline,
    message,
    httpStatus: numOrNull(prereq.httpStatus),
    challenge: textOrNull(prereq.challenge),
    isNotADefect: true,
    impact:
      "This is a test access boundary, not a website defect. Results below cover only what could be reached without credentials.",
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function buildMetrics(analysis: QaAnalysis, findingCount: number): CountRow[] {
  const summary = analysis.summary ?? ({} as QaAnalysis["summary"]);
  const coverage = analysis.coverage?.summary;
  const flowSummary = analysis.flowDiscovery?.summary;
  const scanSummary = analysis.scan?.summary;
  return [
    { id: "pages", label: "Pages discovered", value: num(coverage?.pages.discovered) || num(flowSummary?.pages) },
    { id: "elements", label: "Elements scanned", value: num(scanSummary?.totalElements) || num(summary?.elementCount) },
    { id: "interactive", label: "Interactive elements", value: num(scanSummary?.interactiveElements) || num(summary?.interactiveElements) },
    { id: "flows-discovered", label: "Flows discovered", value: num(coverage?.flows.discovered) || num(flowSummary?.flows) },
    { id: "flows-executed", label: "Flows executed", value: num(coverage?.flows.executed) || num(flowSummary?.executed) },
    { id: "findings", label: "Findings analyzed", value: findingCount || num(summary?.issueCount) },
    { id: "verified", label: "Findings verified", value: num(summary?.verified) },
    { id: "reproduced", label: "Findings reproduced", value: num(summary?.reproduced) },
  ];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
function buildFindings(analysis: QaAnalysis, runId: string): { view: ResultsView["findings"]; cards: FindingCardView[] } {
  const artifact: RunArtifact = { kind: "report", analysis };
  const { findings } = listFindings(artifact);
  const cards: FindingCardView[] = findings.map((finding) => ({
    id: finding.id,
    code: finding.code,
    title: finding.title,
    severity: finding.severity,
    status: finding.status,
    lifecycle: finding.lifecycle,
    domain: finding.domain,
    confidence: finding.confidence,
    page: finding.page,
    occurrenceCount: finding.occurrenceCount,
    rootCauseCandidates: finding.rootCause,
    verification: finding.verification,
    headline: dispositionLabel(finding.verification?.disposition ?? null, finding.verification?.status ?? null),
    detailPath: `/api/qa/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(finding.id)}`,
  }));
  // Most critical first, then reproduced-before-unverified within a severity.
  cards.sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    const weight = (card: FindingCardView): number => {
      const status = card.verification?.status;
      if (status === "REPRODUCED") return 0;
      if (status === "REVIEW" || card.verification?.disposition === "REVIEW_REQUIRED") return 1;
      if (status === "NOT_REPRODUCED" || status === "PASS") return 2;
      return 3;
    };
    return weight(a) - weight(b);
  });

  const count = (match: (card: FindingCardView) => boolean): number => cards.filter(match).length;
  return {
    cards,
    view: {
      items: cards,
      total: cards.length,
      reproduced: count((card) => card.verification?.status === "REPRODUCED"),
      notReproduced: count((card) => card.verification?.status === "NOT_REPRODUCED"),
      passed: count((card) => card.verification?.status === "PASS"),
      reviewRequired: count((card) => card.verification?.status === "REVIEW" || card.verification?.disposition === "REVIEW_REQUIRED"),
      unverified: count((card) => !card.verification || card.verification.disposition === "SCHEDULED"),
    },
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
function buildVerification(analysis: QaAnalysis, findingCount: number): VerificationView {
  const summary = analysis.summary ?? ({} as QaAnalysis["summary"]);
  const results = array<QaAnalysis["verifications"][number]>(analysis.verifications);
  const titleOf = new Map(array<QaFinding>(analysis.findings).map((finding) => [finding.id, finding.title]));
  const executed = num(summary?.executed);

  const counters: CountRow[] = [
    { id: "scheduled", label: "Scheduled", value: num(summary?.scheduled), detail: "Findings that received a safe verification task, whether or not it later ran." },
    { id: "executed", label: "Executed", value: executed, detail: "Verification tests that actually ran and produced an outcome." },
    { id: "reproduced", label: "Reproduced", value: num(summary?.reproduced), detail: "The live page matched the suspected problem. Confirmed." },
    { id: "not-reproduced", label: "Not reproduced", value: num(summary?.notReproduced), detail: "The suspected problem could not be observed on the live page." },
    { id: "pass", label: "Checked and clean", value: num(summary?.pass), detail: "The element was located and did not show the suspected problem." },
    { id: "review-required", label: "Needs human review", value: num(summary?.reviewRequired), detail: "Could not be decided automatically; a person must check it." },
    { id: "unverified", label: "Unverified", value: num(summary?.unverified), detail: "Findings with no verification outcome recorded." },
    { id: "skipped-unsupported", label: "Skipped: unsupported", value: num(summary?.skippedUnsupported), detail: "No safe verification strategy exists for this check." },
    { id: "skipped-locator", label: "Skipped: locator guard", value: num(summary?.skippedLocatorGuard), detail: "No safe, unambiguous locator could be derived." },
    { id: "skipped-safety", label: "Skipped: safety", value: num(summary?.skippedSafety), detail: "Running the check would exceed the safe-guard rails." },
    { id: "infrastructure", label: "Infrastructure problems", value: num(summary?.infrastructureProblems), detail: "Runner, browser, or network failures. These are not website defects." },
  ];

  const verdicts = results.map((result) => ({
    findingId: result.findingId,
    findingTitle: titleOf.get(result.findingId) ?? null,
    scenarioId: str(result.scenarioId),
    locator: textOrNull(result.locator),
    status: result.status ?? null,
    category: result.category ?? null,
    verdict: result.triage?.verdict ?? null,
    reason: str(result.triage?.reason) || str(result.expectation) || "No reason was recorded for this verification.",
    durationMs: numOrNull(result.durationMs),
    error: result.error ? { type: textOrNull(result.error.type), message: str(result.error.message) || str(result.error.type) } : null,
  }));

  const infrastructureNotes = results
    .filter((result) => result.category === "INFRASTRUCTURE" || result.triage?.verdict === "INFRASTRUCTURE_PROBLEM")
    .map((result) => `${result.findingId}: ${str(result.triage?.reason) || str(result.error?.message) || "infrastructure failure during verification"}`);

  const headline = executed > 0
    ? `${plural(executed, "verification check")} ran, reproducing ${plural(num(summary?.reproduced), "issue")}.`
    : "No verification check ran for this run, so no finding is confirmed.";

  return {
    available: results.length > 0 || num(summary?.scheduled) > 0,
    headline,
    counters,
    verdicts,
    infrastructureNotes,
    executed: executed > 0,
    emptyMessage:
      results.length === 0 && executed === 0
        ? findingCount === 0
          ? "This run produced no verification outcomes, and no findings were recorded. Website health is unconfirmed."
          : "This run produced no verification outcomes. Every finding above is a discovered, unverified observation from the scan, not a confirmed defect."
        : null,
  };
}

// ---------------------------------------------------------------------------
// Coverage + actionable gaps
// ---------------------------------------------------------------------------
const GAP_STATUS_ORDER: CoverageStatus[] = ["NOT_TESTED", "PARTIALLY_TESTED", "REVIEW_REQUIRED", "BLOCKED"];

const GAP_KIND: Record<string, GapGroupView["kind"]> = {
  NOT_TESTED: "not-tested",
  PARTIALLY_TESTED: "partial",
  REVIEW_REQUIRED: "review",
  BLOCKED: "blocked",
};

const GAP_TITLE: Record<string, string> = {
  NOT_TESTED: "never tested",
  PARTIALLY_TESTED: "only partially tested",
  REVIEW_REQUIRED: "needs human review",
  BLOCKED: "blocked before it could be tested",
};

const GAP_CONFIDENCE_NOTE: Record<string, string> = {
  NOT_TESTED: "Discovered but never executed. No conclusion can be drawn about this area, so overall confidence stays limited.",
  PARTIALLY_TESTED: "Part of this area ran. The remainder is unverified.",
  REVIEW_REQUIRED: "Automation stopped at a safety or ambiguity boundary, so a person must decide this.",
  BLOCKED: "Access or safety stopped this check. It is neither passed nor failed.",
};

const MAX_ITEMS_PER_GROUP = 12;

function buildCoverage(analysis: QaAnalysis): CoverageView {
  const coverage = analysis.coverage;
  const flowSummary = analysis.flowDiscovery?.summary;
  const summary = analysis.coverage?.summary;

  if (!coverage) {
    const counters: CountRow[] = flowSummary
      ? [
          { id: "flows-discovered", label: "Flows discovered", value: num(flowSummary.flows) },
          { id: "flows-executed", label: "Flows executed", value: num(flowSummary.executed) },
        ]
      : [];
    return {
      available: false,
      headline: "This run recorded no coverage map, so coverage cannot be stated area by area.",
      statement: null,
      groups: [],
      gapGroups: [],
      recommendations: [],
      emptyMessage:
        "No coverage map was produced for this run. Discovery and execution counts above still come from the real scan.",
    };
  }

  const pages = summary?.pages;
  const flows = summary?.flows;
  const interactions = summary?.interactions;
  const analysisSummary = analysis.summary ?? ({} as QaAnalysis["summary"]);

  const groups: CoverageGroupView[] = [
    {
      id: "discovered",
      title: "Discovered",
      note: "What the scan and crawler actually found. Discovery is not testing.",
      rows: [
        { id: "pages", label: "Pages", value: num(pages?.discovered) || num(flowSummary?.pages) },
        { id: "flows", label: "User flows", value: num(flows?.discovered) || num(flowSummary?.flows) },
        { id: "elements", label: "Elements scanned", value: num(analysis.scan?.summary?.totalElements) || num(analysisSummary.elementCount) },
        { id: "interactive", label: "Interactive elements", value: num(analysis.scan?.summary?.interactiveElements) || num(analysisSummary.interactiveElements) },
      ],
    },
    {
      id: "executed",
      title: "Executed",
      note: "Areas with real execution evidence behind them.",
      rows: [
        { id: "pages-tested", label: "Pages tested", value: num(pages?.tested) },
        { id: "flows-executed", label: "Flows executed", value: num(flows?.executed) || num(flowSummary?.executed) },
        { id: "flows-passed", label: "Flows passed", value: num(flows?.passed) || num(flowSummary?.passed) },
        { id: "interactions-tested", label: "Interactions tested", value: num(interactions?.tested) },
        { id: "findings-verified", label: "Findings verified", value: num(summary?.findings.verified) || num(analysisSummary.verified) },
      ],
    },
    {
      id: "untested",
      title: "Not Tested or Review",
      note: "Areas that were discovered but not confirmed. This is what limits the result.",
      rows: [
        { id: "pages-untested", label: "Pages never tested", value: num(pages?.untested) },
        { id: "pages-partial", label: "Pages partially tested", value: num(pages?.partial) },
        { id: "pages-review", label: "Pages needing review", value: num(pages?.review) },
        { id: "pages-blocked", label: "Pages blocked", value: num(pages?.blocked) },
        { id: "flows-review", label: "Flows needing review", value: num(flows?.review) || num(flowSummary?.reviewRequired) },
        { id: "flows-blocked", label: "Flows blocked", value: num(flows?.blocked) || num(flowSummary?.blocked) },
        { id: "interactions-untested", label: "Interactions untested", value: num(interactions?.untested) },
        { id: "interactions-partial", label: "Interactions partially tested", value: num(interactions?.partial) },
        { id: "interactions-review", label: "Interactions needing review", value: num(interactions?.review) },
        { id: "findings-unverified", label: "Findings unverified", value: num(summary?.findings.unverified) || num(analysisSummary.unverified) },
      ],
    },
  ];

  const items = array<CoverageItem>(coverage.items);
  const gapGroups: GapGroupView[] = [];
  for (const status of GAP_STATUS_ORDER) {
    const group = items.filter((item) => item.status === status);
    if (group.length === 0) continue;
    const mapped = group.map<GapItemView>((item) => ({
      coverageId: str(item.coverageId),
      name: str(item.name) || item.category,
      category: str(item.category) as CoverageCategory,
      status: str(item.status),
      reason: str(item.reason) || "No reason was recorded for this coverage item.",
      url: textOrNull(item.url),
      safety: str(item.safety),
      relatedFlows: array<string>(item.relatedFlows),
      relatedFindings: array<string>(item.relatedFindings),
    }));
    const reasons = [...new Set(mapped.map((item) => item.reason).filter(Boolean))].slice(0, 5);
    gapGroups.push({
      id: `gaps-${status.toLowerCase().replace(/_/g, "-")}`,
      kind: GAP_KIND[status] ?? "not-tested",
      title: `${plural(mapped.length, "item")} ${GAP_TITLE[status] ?? "not tested"}`,
      count: mapped.length,
      confidenceNote: GAP_CONFIDENCE_NOTE[status] ?? "This area is unconfirmed.",
      reasons,
      items: mapped.slice(0, MAX_ITEMS_PER_GROUP),
      omitted: Math.max(0, mapped.length - MAX_ITEMS_PER_GROUP),
    });
  }

  const recommendations = array<CoverageMap_Recommendation>(coverage.testPlan).map((item) => ({
    recommendationId: str(item.recommendationId),
    title: str(item.title),
    reason: str(item.reason) || "No reason was recorded for this recommendation.",
    priority: (str(item.priority) || "P4") as FlowPriority,
    priorityReason: str(item.priorityReason),
    coverageIds: array<string>(item.coverageIds),
    relatedFindings: array<string>(item.relatedFindings),
  }));

  return {
    available: true,
    headline: coverageStatement(analysis) ?? "Coverage totals are recorded per area below.",
    statement: coverageStatement(analysis),
    groups,
    gapGroups,
    recommendations,
    emptyMessage:
      gapGroups.length === 0
        ? "The coverage map records no untested, partial, blocked, or review-required area."
        : null,
  };
}

type CoverageMap_Recommendation = NonNullable<QaAnalysis["coverage"]>["testPlan"][number];

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------
function stepViews(flow: DiscoveredFlow, execution: FlowExecutionResult | null): FlowStepView[] {
  const byIndex = new Map<number, FlowStepExecutionResult>();
  for (const step of array<FlowStepExecutionResult>(execution?.steps)) {
    if (typeof step?.stepIndex === "number") byIndex.set(step.stepIndex, step);
  }
  return array<FlowStep>(flow.steps).map((step, index) => {
    const outcome = byIndex.get(index) ?? null;
    return {
      index: index + 1,
      action: str(step.action) || "step",
      targetUrl: textOrNull(step.targetUrl),
      locator: textOrNull(step.locator),
      text: textOrNull(step.text),
      expected: str(step.expected),
      safety: str(step.safety),
      automation: str(step.automation),
      reason: str(step.reason) || "No reason was recorded for this step.",
      outcome: outcome ? str(outcome.outcome) : null,
      category: outcome ? str(outcome.category) : null,
      outcomeReason: outcome ? str(outcome.reason) : null,
      durationMs: numOrNull(outcome?.durationMs),
      error: outcome?.error ? { type: textOrNull(outcome.error.type), message: str(outcome.error.message) || str(outcome.error.type) } : null,
    };
  });
}

function flowNotExecutedReason(flow: DiscoveredFlow, execution: FlowExecutionResult | null): string {
  if (execution) {
    if (execution.error) return `Execution failed: ${str(execution.error.message) || str(execution.error.type)}`;
    if (execution.boundary) return `Stopped at a safety boundary. ${str(execution.boundary)}`;
    if (execution.stoppedAtStep !== null) return `Stopped before step ${execution.stoppedAtStep + 1}. ${str(execution.boundary) || ""}`.trim();
    if (execution.status) return `Executed with outcome ${execution.status}.`;
    return "Execution finished without recording an outcome.";
  }
  if (flow.boundary) return `Not executed. Step ${flow.boundary.stepIndex + 1} is ${flow.boundary.safety}: ${str(flow.boundary.reason) || "outside the safe execution boundary"}`;
  if (!flow.executable) return `Not executed. The flow has no ${"SAFE"} + AUTOMATED step, so it was never safe to run.`;
  return "Not executed. No execution result was recorded for this discovered flow.";
}

function buildFlows(analysis: QaAnalysis): FlowSectionView {
  const discovery: FlowDiscovery | null = analysis.flowDiscovery ?? null;
  if (!discovery) {
    // The coverage map can still record how many flows it found. Report those
    // counts, but say plainly that per-flow detail is unavailable rather than
    // claiming no flows exist.
    const coverageFlows = analysis.coverage?.summary.flows;
    const discovered = num(coverageFlows?.discovered);
    if (!coverageFlows || discovered === 0) {
      return {
        available: false,
        headline: "This run recorded no user-flow discovery, so no flow-level results are available.",
        counters: [],
        items: [],
        notExecuted: [],
        emptyMessage: "No user flows were discovered for this run.",
      };
    }
    return {
      available: false,
      headline: `The coverage map recorded ${plural(discovered, "flow")}, but this run saved no per-flow detail, so individual steps and outcomes cannot be shown.`,
      counters: [
        { id: "discovered", label: "Flows discovered", value: discovered },
        { id: "executed", label: "Flows executed", value: num(coverageFlows.executed) },
        { id: "passed", label: "Passed", value: num(coverageFlows.passed) },
        { id: "reproduced", label: "Reproduced", value: num(coverageFlows.reproduced) },
        { id: "not-reproduced", label: "Not reproduced", value: num(coverageFlows.notReproduced) },
        { id: "review-required", label: "Need review", value: num(coverageFlows.review) },
        { id: "blocked", label: "Blocked", value: num(coverageFlows.blocked) },
      ],
      items: [],
      notExecuted: [],
      emptyMessage: "Per-flow detail is not available for this run. The counts above come from the coverage map; open the full report for the individual flows.",
    };
  }
  const flows = array<DiscoveredFlow>(discovery.flows);
  const executions = array<FlowExecutionResult>(discovery.executions);
  const executionByFlow = new Map<string, FlowExecutionResult>();
  for (const execution of executions) {
    const flowId = str(execution?.flowId);
    if (flowId) executionByFlow.set(flowId, execution);
  }

  const items: FlowView[] = flows.map((flow) => {
    const execution = executionByFlow.get(str(flow.flowId)) ?? null;
    const status: FlowStepOutcome | "NOT_EXECUTED" | "DISCOVERED_ONLY" = execution
      ? execution.status
      : flow.executable
        ? "NOT_EXECUTED"
        : "DISCOVERED_ONLY";
    return {
      flowId: str(flow.flowId),
      title: str(flow.title) || flow.flowId,
      description: str(flow.description),
      category: flow.category,
      priority: flow.priority,
      priorityReason: str(flow.priorityReason),
      startUrl: str(flow.startUrl),
      safety: str(flow.safety),
      automation: str(flow.automation),
      executable: Boolean(flow.executable),
      status,
      boundary: flow.boundary
        ? { stepIndex: flow.boundary.stepIndex, safety: str(flow.boundary.safety), automation: str(flow.boundary.automation), reason: str(flow.boundary.reason) }
        : null,
      steps: stepViews(flow, execution),
      execution: execution
        ? {
            status: str(execution.status),
            failureCategory: textOrNull(execution.failureCategory),
            startedUrl: str(execution.startedUrl),
            finalUrl: textOrNull(execution.finalUrl),
            executedAt: textOrNull(execution.executedAt),
            durationMs: numOrNull(execution.durationMs),
            stoppedAtStep: numOrNull(execution.stoppedAtStep),
            boundary: textOrNull(execution.boundary),
            error: execution.error ? { type: textOrNull(execution.error.type), message: str(execution.error.message) || str(execution.error.type) } : null,
          }
        : null,
      reason: flowNotExecutedReason(flow, execution),
      evidenceCount: array(flow.evidence).length,
    };
  });

  items.sort((a, b) => {
    const rank = (status: string): number => (status === "REPRODUCED" ? 0 : status === "PASS" ? 1 : status === "NOT_EXECUTED" ? 4 : 3);
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    return a.flowId.localeCompare(b.flowId);
  });

  const summary = discovery.summary;
  const counters: CountRow[] = [
    { id: "discovered", label: "Flows discovered", value: num(summary?.flows) || flows.length },
    { id: "executed", label: "Flows executed", value: num(summary?.executed) || executions.length },
    { id: "passed", label: "Passed", value: num(summary?.passed) },
    { id: "reproduced", label: "Reproduced", value: num(summary?.reproduced) },
    { id: "not-reproduced", label: "Not reproduced", value: num(summary?.notReproduced) },
    { id: "review-required", label: "Need review", value: num(summary?.reviewRequired) },
    { id: "blocked", label: "Blocked", value: num(summary?.blocked) },
    { id: "infrastructure", label: "Infrastructure", value: num(summary?.infrastructure) },
  ];

  const notExecuted = items
    .filter((flow) => !flow.execution)
    .map((flow) => ({
      flowId: flow.flowId,
      title: flow.title,
      reason: flow.reason,
      priority: flow.priority,
      safety: flow.safety,
      automation: flow.automation,
      boundary: flow.boundary ? flow.boundary.reason : null,
    }));

  return {
    available: true,
    headline: executions.length > 0
      ? `${plural(executions.length, "flow")} executed, reproducing ${plural(num(summary?.reproduced), "issue")}.`
      : `${plural(flows.length, "flow")} discovered, none executed.`,
    counters,
    items,
    notExecuted,
    emptyMessage: flows.length === 0 ? "No user flows were discovered for this run." : null,
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function buildReports(runId: string, executionAvailable: boolean): ReportsView {
  const base = `/api/qa/runs/${encodeURIComponent(runId)}`;
  return { html: `${base}/report.html`, json: `${base}/report`, execution: executionAvailable ? `${base}/execution` : null };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export type BuildResultsOptions = {
  /** Web run id used by the dashboard API. */
  runId: string;
  /** True when a qa-execution.json artifact exists for this run. */
  executionAvailable?: boolean;
};

/**
 * Build the complete productized results view for a COMPLETED run.
 * Accepts the raw parsed qa-analysis.json report. Never mutates it.
 */
export function buildResultsView(analysis: QaAnalysis, options: BuildResultsOptions): ResultsView {
  const access = buildAccess(analysis);
  const { view: findings, cards } = buildFindings(analysis, options.runId);
  const coverage = buildCoverage(analysis);
  const flows = buildFlows(analysis);
  const verification = buildVerification(analysis, cards.length);
  const untestedItems = coverage.gapGroups.reduce((total, group) => total + group.count, 0);
  const reviewRequired = num(analysis.summary?.reviewRequired);
  const overview = buildOverview(
    analysis,
    options.runId,
    access,
    num(analysis.summary?.executed),
    num(analysis.summary?.reproduced),
    reviewRequired,
    untestedItems,
  );

  const emptyMessages: ResultsView["empty"]["messages"] = {
    findings: cards.length === 0
      ? access
        ? "No findings were recorded. The scan could not reach authenticated content, so this covers the public surface only."
        : "No findings were recorded for this run."
      : null,    flows: flows.emptyMessage,
    verification: verification.emptyMessage,
    gaps: coverage.emptyMessage,
    coverage: coverage.available ? null : coverage.emptyMessage,
  };

  return {
    overview,
    access,
    metrics: buildMetrics(analysis, cards.length),
    findings,
    verification,
    coverage,
    flows,
    reports: buildReports(options.runId, options.executionAvailable !== false),
    empty: {
      noFindings: cards.length === 0,
      noFlows: flows.items.length === 0,
      noVerification: !verification.executed,
      noGaps: coverage.gapGroups.length === 0,
      noCoverage: !coverage.available,
      noAccessIssue: access === null,
      messages: emptyMessages,
    },
  };
}
