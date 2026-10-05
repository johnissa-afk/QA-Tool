import { GeneratedTestSuite, ScanReport } from "../types.js";
import { SEVERITY_RANK } from "./severity.js";
import type { FlowSummary } from "../flow/types.js";
import type { CoverageSummary } from "../coverage/types.js";
import { Confidence, IntentScenario, Mode, QaFinding, QaSummary, Severity, UserFlow } from "./types.js";

// ---------------------------------------------------------------------------
// QA summary.
//
// No arbitrary quality score: the status is a direct, explainable gate —
// any CRITICAL finding fails the release gate, any HIGH finding requires
// review, otherwise the scan is PASS with the remaining counts described
// factually. reviewTests mirrors the Playwright spec fixme placeholder count.
// ---------------------------------------------------------------------------
const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const CONFIDENCES: Confidence[] = ["high", "medium", "low"];

export type VerificationCounts = {
  verified: number;
  reproduced: number;
  notReproduced: number;
  pass: number;
  review: number;
  infrastructureFailures: number;
  unverified: number;
  // Phase 2 hardening: explicit disposition counts.
  scheduled: number;
  /** Verification tests that actually executed and produced an outcome.
   *  Findings scheduled without execution are NOT counted here. */
  executed: number;
  skippedUnsupported: number;
  skippedLocatorGuard: number;
  skippedSafety: number;
  reviewRequired: number;
  infrastructureProblems: number;
  /** When true, a verification run was actually performed (--execute used). */
  verificationRun?: boolean;
};

export function buildSummary(
  report: ScanReport,
  findings: QaFinding[],
  flows: UserFlow[],
  intentScenarios: IntentScenario[],
  suite: GeneratedTestSuite | null,
  mode: Mode,
  aiProvider: string,
  headline?: string,
  topRecommendations?: string[],
  verification: VerificationCounts = { verified: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0, infrastructureFailures: 0, unverified: findings.length, scheduled: 0, executed: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0, infrastructureProblems: 0, verificationRun: false },
  flowSummary: FlowSummary | null = null,
  coverageSummary: CoverageSummary | null = null,
): QaSummary {
  const bySeverity = Object.fromEntries(SEVERITIES.map(severity => [severity, 0])) as Record<Severity, number>;
  const byConfidence = Object.fromEntries(CONFIDENCES.map(confidence => [confidence, 0])) as Record<Confidence, number>;
  for (const finding of findings) {
    bySeverity[finding.severity] += finding.count;
    byConfidence[finding.confidence] += finding.count;
  }

  const critical = bySeverity.CRITICAL;
  const high = bySeverity.HIGH;

  // Determine overall status:
  // - If an access prerequisite blocks normal QA: REVIEW or BLOCKED based on the
  //   prerequisite status (never PASS — the site was not tested).
  // - If verification was run: use finding severity (FAIL/REVIEW/PASS)
  // - If no verification run: NOT_TESTED (even if no findings)
  const hasAccessPrerequisite = report.accessPrerequisite != null;
  let overallStatus: QaSummary["overallStatus"];
  if (hasAccessPrerequisite) {
    const ap = report.accessPrerequisite!;
    overallStatus = ap.status === "BLOCKED" ? "BLOCKED" : ap.status === "PASS" ? "PASS" : "REVIEW";
  } else if (verification.verificationRun) {
    overallStatus = critical > 0 ? "FAIL" : high > 0 ? "REVIEW" : "PASS";
  } else {
    overallStatus = "NOT_TESTED";
  }

  const counts = suite?.counts;
  const manualScenarios = counts?.manual ?? 0;
  const conditional = counts?.conditional ?? 0;
  const highRisk = counts?.highRisk ?? 0;
  const reviewTests = Math.max(0, manualScenarios - conditional - highRisk);

  const fallbackHeadline = critical > 0
    ? `QA (${mode}): ${critical} critical finding(s) block release of ${report.scan.url}.`
    : high > 0
      ? `QA (${mode}): ${high} high-severity finding(s) require review before release of ${report.scan.url}.`
      : verification.verificationRun
        ? `QA (${mode}): no critical or high findings for ${report.scan.url} — ${report.summary.interactiveElements} interactive elements scanned, ${report.summary.brokenLinks} broken links.`
        : `QA (${mode}): no verification run performed for ${report.scan.url} — ${report.summary.interactiveElements} interactive elements scanned.`;

  const ranked = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Number(b.count) - Number(a.count));
  const top = [...new Set(ranked.map(finding => finding.recommendation))].slice(0, 5).filter(Boolean);

  return {
    sourceUrl: report.scan.url,
    scannedAt: report.scan.timestamp,
    mode,
    aiProvider,
    elementCount: report.summary.totalElements,
    interactiveElements: report.summary.interactiveElements,
    issueCount: findings.reduce((total, finding) => total + finding.count, 0),
    bySeverity,
    byConfidence,
    brokenLinks: report.summary.brokenLinks,
    flowsDetected: flows.length,
    intentScenarios: intentScenarios.length,
    automatedScenarios: counts?.automated ?? 0,
    manualScenarios,
    reviewScenarios: counts?.review ?? 0,
    reviewTests,
    excludedScenarios: conditional,
    highRiskScenarios: highRisk,
    overallStatus,
    headline: headline?.trim() ? headline : fallbackHeadline,
    topRecommendations: topRecommendations?.length ? topRecommendations.slice(0, 5) : top,
    verified: verification.verified,
    reproduced: verification.reproduced,
    notReproduced: verification.notReproduced,
    pass: verification.pass,
    review: verification.review,
    infrastructureFailures: verification.infrastructureFailures,
    unverified: verification.unverified,
    scheduled: verification.scheduled,
    executed: verification.executed ?? 0,
    skippedUnsupported: verification.skippedUnsupported,
    skippedLocatorGuard: verification.skippedLocatorGuard,
    skippedSafety: verification.skippedSafety,
    reviewRequired: verification.reviewRequired,
    infrastructureProblems: verification.infrastructureProblems,
    flowSummary,
    coverageSummary,
  };
}