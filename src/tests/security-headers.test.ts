import assert from "node:assert/strict";
import test from "node:test";
import { checkSecurityHeaders, isSecurityHeaderCode, SECURITY_HEADER_CODES } from "../security-headers.js";
import { buildFindings, domainFor, labelFor } from "../ai/analysis.js";
import { classifyIssue, SeverityContext } from "../ai/severity.js";
import { buildSummary } from "../ai/summary.js";
import type { ScanReport } from "../types.js";

const SECURE_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const context: SeverityContext = { navigationStatus: 200, authenticationAccepted: true, interactiveElementCount: 5, brokenLinkCount: 0 };

const codes = (headers: Record<string, string>, url: string) => checkSecurityHeaders(headers, url).map(issue => issue.code);

test("a response carrying every security header produces no issues", () => {
  assert.deepEqual(checkSecurityHeaders(SECURE_HEADERS, "https://qa.test/"), []);
});

test("header names are matched case-insensitively", () => {
  const upper: Record<string, string> = {};
  for (const [name, value] of Object.entries(SECURE_HEADERS)) upper[name.toUpperCase()] = value;
  assert.deepEqual(checkSecurityHeaders(upper, "https://qa.test/"), []);
});

test("an empty header value counts as absent", () => {
  const issues = checkSecurityHeaders({ ...SECURE_HEADERS, "content-security-policy": "  " }, "https://qa.test/");
  assert.deepEqual(issues.map(issue => issue.code), ["missing-content-security-policy"]);
});

test("an https response with no security headers reports every check in stable order", () => {
  const issues = checkSecurityHeaders({}, "https://qa.test/");
  assert.deepEqual(issues.map(issue => issue.code), [...SECURITY_HEADER_CODES]);
  assert.deepEqual(issues.map(issue => issue.status), ["WARNING", "WARNING", "INFO", "INFO", "INFO"]);
  for (const issue of issues) assert.ok(issue.message.length > 0);
  assert.deepEqual(checkSecurityHeaders({}, "https://qa.test/"), issues, "repeated checks are deterministic");
});

test("hsts is only required for https targets", () => {
  assert.equal(codes({}, "http://qa.test/").includes("missing-hsts"), false);
  assert.equal(codes({}, "https://qa.test/").includes("missing-hsts"), true);
  assert.equal(codes({}, "not-a-url").includes("missing-hsts"), false, "an unparseable URL is never treated as https");
  assert.equal(codes({ "strict-transport-security": "max-age=1" }, "https://qa.test/").includes("missing-hsts"), false);
});

test("frame protection is satisfied by X-Frame-Options or a frame-ancestors directive", () => {
  const withXfo = checkSecurityHeaders({ ...SECURE_HEADERS, "content-security-policy": "default-src 'self'" }, "https://qa.test/");
  assert.equal(withXfo.some(issue => issue.code === "missing-frame-options"), false);
  const withFrameAncestors = checkSecurityHeaders({ ...SECURE_HEADERS, "x-frame-options": "" }, "https://qa.test/");
  assert.equal(withFrameAncestors.some(issue => issue.code === "missing-frame-options"), false);
  const unprotected = checkSecurityHeaders({ ...SECURE_HEADERS, "content-security-policy": "default-src 'self'", "x-frame-options": "" }, "https://qa.test/");
  assert.deepEqual(unprotected.map(issue => issue.code), ["missing-frame-options"]);
});

test("isSecurityHeaderCode identifies exactly this module's codes", () => {
  for (const code of SECURITY_HEADER_CODES) {
    assert.equal(isSecurityHeaderCode(code), true);
    assert.equal(isSecurityHeaderCode(code.toUpperCase()), false);
  }
  assert.equal(isSecurityHeaderCode("visual-regression"), false);
  assert.equal(isSecurityHeaderCode("perf-budget-lcp"), false);
});

test("security findings classify as security domain with stable labels", () => {
  const expected: Record<string, string> = {
    "missing-content-security-policy": "Missing Content-Security-Policy",
    "missing-hsts": "Missing Strict-Transport-Security",
    "missing-x-content-type-options": "Missing X-Content-Type-Options",
    "missing-frame-options": "Missing clickjacking protection",
    "missing-referrer-policy": "Missing Referrer-Policy",
  };
  for (const code of SECURITY_HEADER_CODES) {
    assert.equal(domainFor(code), "security", code);
    assert.equal(labelFor(code), expected[code], code);
  }
});

test("security severities are high-confidence and never exceed MEDIUM", () => {
  const expected: Record<string, "MEDIUM" | "LOW"> = {
    "missing-content-security-policy": "MEDIUM",
    "missing-hsts": "MEDIUM",
    "missing-x-content-type-options": "LOW",
    "missing-frame-options": "LOW",
    "missing-referrer-policy": "LOW",
  };
  for (const code of SECURITY_HEADER_CODES) {
    const issue = checkSecurityHeaders({}, "https://qa.test/").find(candidate => candidate.code === code);
    assert.ok(issue, code);
    const verdict = classifyIssue(issue, context);
    assert.equal(verdict.severity, expected[code], code);
    assert.equal(verdict.confidence, "high", code);
    assert.ok(verdict.rationale.includes(issue.message), `${code} rationale must quote its evidence`);
    assert.ok(verdict.recommendation.length > 0, code);
    assert.ok(verdict.userImpact.length > 0, code);
  }
});

test("buildFindings maps security issues to page evidence without inventing elements", () => {
  const issues = checkSecurityHeaders({}, "https://qa.test/");
  const report: ScanReport = {
    scan: { url: "https://qa.test/", finalUrl: "https://qa.test/", title: "QA target", timestamp: "2026-01-01T00:00:00.000Z", durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: issues.filter(issue => issue.status === "WARNING").length, failures: 0, infos: issues.filter(issue => issue.status === "INFO").length, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: issues.length, groupedIssueCounts: { passes: 0, warnings: issues.filter(issue => issue.status === "WARNING").length, failures: 0, infos: issues.filter(issue => issue.status === "INFO").length } },
    page: { language: "en", viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements: [], issues, links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
  };
  const findings = buildFindings(report);
  assert.equal(findings.length, issues.length);
  for (const finding of findings) {
    assert.equal(finding.domain, "security", finding.code);
    assert.equal(finding.evidence.length, 1, finding.code);
    assert.equal(finding.evidence[0].type, "page", finding.code);
    assert.equal(finding.evidence[0].index, null, finding.code);
    assert.notEqual(finding.severity, "HIGH", finding.code);
    assert.notEqual(finding.severity, "CRITICAL", finding.code);
  }
});

test("security findings alone never flip the overall QA status", () => {
  const report: ScanReport = {
    scan: { url: "https://qa.test/", finalUrl: "https://qa.test/", title: "QA target", timestamp: "2026-01-01T00:00:00.000Z", durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements: [], issues: checkSecurityHeaders({}, "https://qa.test/"), links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
  };
  const findings = buildFindings(report);
  assert.ok(findings.length > 0);
  const summary = buildSummary(report, findings, [], [], null, "deterministic", "deterministic", undefined, undefined, {
    verified: 0, reproduced: 0, notReproduced: 0, pass: findings.length, review: 0, infrastructureFailures: 0, unverified: 0,
    scheduled: 0, executed: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0,
    infrastructureProblems: 0, verificationRun: true,
  });
  assert.equal(summary.overallStatus, "PASS", "hardening findings are MEDIUM/LOW, so a verified run with only these stays PASS");
});
