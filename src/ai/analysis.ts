import { Issue, ScanReport } from "../types.js";
import { classifyIssue, SeverityContext } from "./severity.js";
import { EvidenceRef, FindingDomain, QaFinding } from "./types.js";

// ---------------------------------------------------------------------------
// Finding builder.
//
// One QaFinding per grouped scanner issue (status != PASS). Deterministic
// severity/confidence come from the rubric; evidence maps each finding back to
// concrete scanner artifacts (elements, console diagnostics, links, page errors).
//
// ACCESS_PREREQUISITE_CODE is the one code that is deliberately never turned
// into a finding: it describes an access condition, not a defect of the site.
// ---------------------------------------------------------------------------

/** The issue code reserved for access conditions. Never becomes a QaFinding. */
export const ACCESS_PREREQUISITE_CODE = "access-prerequisite";

const DOMAIN_BY_CODE: Record<string, FindingDomain> = {
  "image-missing-alt": "accessibility",
  "button-missing-name": "accessibility",
  "a-missing-name": "accessibility",
  "input-missing-label": "accessibility",
  "password-missing-label": "accessibility",
  "missing-lang": "accessibility",
  "missing-page-title": "accessibility",
  "missing-viewport": "accessibility",
  "duplicate-id": "accessibility",
  "unhealthy-link": "navigation",
  "empty-link": "navigation",
  "page-http-error": "navigation",
  "page-scanned": "navigation",
  "authentication-failed": "authentication",
  [ACCESS_PREREQUISITE_CODE]: "authentication",
  "password-missing-autocomplete": "authentication",
  "input-missing-type": "robustness",
  "fragile-locator": "robustness",
  "screenshot-unavailable": "robustness",
  "screenshot-diff-error": "robustness",
  "visual-regression": "robustness",
  "hidden-interactive-element": "content",
  "disabled-interactive-element": "content",
  "console-first-party-error": "console",
  "console-network-error": "console",
  "console-third-party-error": "console",
  "page-error": "console",
  "perf-budget-ttfb": "performance",
  "perf-budget-fcp": "performance",
  "perf-budget-lcp": "performance",
  "perf-budget-cls": "performance",
  "perf-budget-domContentLoaded": "performance",
  "perf-budget-loadEvent": "performance",
  "missing-content-security-policy": "security",
  "missing-hsts": "security",
  "missing-x-content-type-options": "security",
  "missing-frame-options": "security",
  "missing-referrer-policy": "security",
};

export const domainFor = (code: string): FindingDomain => DOMAIN_BY_CODE[code] ?? "robustness";

const LABEL_BY_CODE: Record<string, string> = {
  "page-http-error": "Page navigation failed",
  "authentication-failed": "Authentication was not accepted",
  [ACCESS_PREREQUISITE_CODE]: "Access prerequisite",
  "unhealthy-link": "Unhealthy link destination",
  "duplicate-id": "Duplicate element id",
  "button-missing-name": "Button without an accessible name",
  "a-missing-name": "Link without an accessible name",
  "input-missing-label": "Form control without an accessible label",
  "password-missing-label": "Password field without an accessible label",
  "image-missing-alt": "Image missing meaningful alt text",
  "missing-page-title": "Missing page title",
  "missing-lang": "Missing language attribute",
  "missing-viewport": "Missing viewport meta tag",
  "empty-link": "Link without a destination",
  "input-missing-type": "Input without an explicit type",
  "fragile-locator": "Fragile automation locator",
  "console-first-party-error": "First-party console error",
  "console-network-error": "Network or resource error",
  "console-third-party-error": "Third-party console error",
  "page-error": "Uncaught page error",
  "password-missing-autocomplete": "Password field without autocomplete",
  "screenshot-unavailable": "Screenshot unavailable",
  "screenshot-diff-error": "Screenshot comparison failed",
  "visual-regression": "Visual regression",
  "hidden-interactive-element": "Hidden interactive element",
  "disabled-interactive-element": "Disabled interactive element",
  "perf-budget-ttfb": "Performance budget exceeded: TTFB",
  "perf-budget-fcp": "Performance budget exceeded: FCP",
  "perf-budget-lcp": "Performance budget exceeded: LCP",
  "perf-budget-cls": "Performance budget exceeded: CLS",
  "perf-budget-domContentLoaded": "Performance budget exceeded: DOM Content Loaded",
  "perf-budget-loadEvent": "Performance budget exceeded: Load Event",
  "missing-content-security-policy": "Missing Content-Security-Policy",
  "missing-hsts": "Missing Strict-Transport-Security",
  "missing-x-content-type-options": "Missing X-Content-Type-Options",
  "missing-frame-options": "Missing clickjacking protection",
  "missing-referrer-policy": "Missing Referrer-Policy",
};

export const labelFor = (code: string): string => LABEL_BY_CODE[code] ?? code;

export function evidenceForIssue(issue: Issue, report: ScanReport): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const pushElement = (locator: string | undefined, accessibleName: string | null | undefined, tag: string | undefined) => {
    let index: number | null = null;
    if (locator) {
      const match = report.elements.findIndex(element => element.recommendedLocator === locator);
      index = match >= 0 ? match : null;
    }
    refs.push({ type: "element", index, locator, accessibleName: accessibleName ?? undefined, tag });
  };

  let detail: string | undefined;
  if (issue.element) {
    pushElement(issue.element.recommendedLocator, issue.element.accessibleName, issue.element.tag);
    return refs;
  }
  const example = issue.examples?.[0];
  if (example?.element) {
    pushElement(example.element.recommendedLocator, example.element.accessibleName, example.element.tag);
    return refs;
  }
  detail = example?.detail;

  if (issue.code.startsWith("console-")) {
    const index = report.consoleDiagnostics.findIndex(diagnostic => Boolean(detail && (detail.includes(diagnostic.message) || diagnostic.message.includes(detail))));
    refs.push({ type: "console", index: index >= 0 ? index : null });
    return refs;
  }
  if (issue.code === "page-error") {
    refs.push({ type: "page", index: 0 });
    return refs;
  }
  if (issue.code === "unhealthy-link") {
    const index = report.links.findIndex(link => issue.message.includes(link.url));
    refs.push({ type: "link", index: index >= 0 ? index : null });
    return refs;
  }
  if (issue.code === "authentication-failed") {
    refs.push({ type: "authentication", index: null });
    return refs;
  }
  refs.push({ type: "page", index: null });
  return refs;
}

export function buildFindings(report: ScanReport): QaFinding[] {
  const context: SeverityContext = {
    navigationStatus: report.scan.navigationStatus ?? null,
    authenticationAccepted: report.authentication.accepted === true,
    interactiveElementCount: report.summary.interactiveElements,
    brokenLinkCount: report.summary.brokenLinks,
  };
  const findings: QaFinding[] = [];
  let sequence = 0;
  for (const issue of report.issues) {
    if (issue.status === "PASS") continue;
    // An access prerequisite is an access condition, never a website defect.
    // It lives on report.accessPrerequisite; admitting it here would inflate
    // the finding count, occurrence count, and severity totals with something
    // that is not a defect of the site.
    if (issue.code === ACCESS_PREREQUISITE_CODE) continue;
    const verdict = classifyIssue(issue, context);
    const code = issue.code;
    findings.push({
      id: `QA-F-${String(++sequence).padStart(3, "0")}`,
      code,
      status: issue.status,
      lifecycle: "DISCOVERED",
      relatedScenarioIds: [],
      verification: null,
      domain: domainFor(code),
      severity: verdict.severity,
      confidence: verdict.confidence,
      title: labelFor(code),
      description: issue.message,
      recommendation: verdict.recommendation,
      userImpact: verdict.userImpact,
      rationale: verdict.rationale,
      count: issue.count ?? 1,
      occurrences: issue.occurrences,
      evidence: evidenceForIssue(issue, report),
      examples: issue.examples,
    });
  }
  return findings;
}