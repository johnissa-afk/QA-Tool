import assert from "node:assert/strict";
import test from "node:test";
import { detectIssues, groupIssues, isWellFormedLanguageTag } from "../checks.js";
import { buildFindings, domainFor, labelFor } from "../ai/analysis.js";
import { classifyIssue, SeverityContext } from "../ai/severity.js";
import { buildSummary } from "../ai/summary.js";
import type { DiscoveredElement, Issue, ScanReport } from "../types.js";

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

type Heading = { level: number; text: string };
const meta = (overrides: { title?: string; lang?: string | null; viewport?: string | null; headings?: Heading[] } = {}) => ({
  title: "QA target",
  lang: "en",
  viewport: "width=device-width",
  headings: [{ level: 1, text: "Title" }, { level: 2, text: "Section" }, { level: 3, text: "Details" }],
  ...overrides,
});

const codes = (issues: Issue[]) => issues.map(issue => issue.code);
const context: SeverityContext = { navigationStatus: 200, authenticationAccepted: true, interactiveElementCount: 5, brokenLinkCount: 0 };
const A11Y_CODES = ["invalid-lang", "missing-h1", "heading-skipped-level"] as const;

test("compliant markup produces no findings at all", () => {
  assert.deepEqual(detectIssues([], meta()), []);
  assert.deepEqual(detectIssues([element()], meta()), []);
  assert.deepEqual(detectIssues([], meta({ headings: [{ level: 1, text: "Only" }] })), []);
});

test("BCP 47 syntax check accepts well-formed tags", () => {
  const valid = ["en", "en-US", "fr", "pt-BR", "zh-Hans", "zh-Hant-CN", "es-419", "de-CH-1901", "sl-rozaj-biske", "sr-Latn-RS", "hy-Latn-IT-nedis-fonipa", "en-GB-oed", "art-lojban", "zh-min-nan", "en-x-custom", "x-private", "en-USA"];
  for (const tag of valid) assert.equal(isWellFormedLanguageTag(tag), true, `expected valid: ${tag}`);
});

test("BCP 47 syntax check rejects malformed tags", () => {
  const invalid = ["e", "en--US", "en_US", "123", "-en", "en-", "-", "a", "toolonglanguagesubtag", "   ", ""];
  for (const tag of invalid) assert.equal(isWellFormedLanguageTag(tag), false, `expected invalid: ${JSON.stringify(tag)}`);
});

test("invalid lang reports a WARNING quoting the observed value", () => {
  const issues = detectIssues([], meta({ lang: "en_US" }));
  assert.deepEqual(codes(issues), ["invalid-lang"]);
  assert.equal(issues[0].status, "WARNING");
  assert.ok(issues[0].message.includes('"en_US"'), issues[0].message);
  assert.ok(issues[0].message.includes("BCP 47"), issues[0].message);
});

test("whitespace-only lang is invalid, not missing", () => {
  const issues = detectIssues([], meta({ lang: "   " }));
  assert.deepEqual(codes(issues), ["invalid-lang"], "truthy whitespace is not missing-lang");
});

test("missing lang still uses the existing missing-lang code", () => {
  const issues = detectIssues([], meta({ lang: null }));
  assert.deepEqual(codes(issues), ["missing-lang"]);
  assert.equal(isWellFormedLanguageTag("   "), false, "whitespace never counts as a language tag");
});

test("heading skips are reported with evidence pointing at the offending heading", () => {
  const issues = detectIssues([], meta({ headings: [{ level: 1, text: "Title" }, { level: 3, text: "Deep" }] }));
  assert.deepEqual(codes(issues), ["heading-skipped-level"]);
  const issue = issues[0];
  assert.equal(issue.status, "WARNING");
  assert.equal(issue.message, "An h3 heading follows an h1 heading and skips h2.");
  assert.equal(issue.element?.tag, "h3");
  assert.equal(issue.element?.text, "Deep");
  assert.equal(issue.element?.role, "heading");
  assert.equal(issue.element?.recommendedLocator, "page.getByRole(\"heading\", { level: 3, name: \"Deep\" })");
  assert.equal(issue.element?.locatorQuality, "high");
});

test("a larger skip reports the exact skipped level", () => {
  const issues = detectIssues([], meta({ headings: [{ level: 1, text: "T" }, { level: 2, text: "S" }, { level: 5, text: "D" }] }));
  assert.deepEqual(codes(issues), ["heading-skipped-level"]);
  assert.equal(issues[0].message, "An h5 heading follows an h2 heading and skips h3.");
});

test("sequential headings and a lone first heading never trigger a skip", () => {
  assert.deepEqual(codes(detectIssues([], meta({ headings: [{ level: 2, text: "Start" }] }))).filter(code => code === "heading-skipped-level"), []);
  assert.deepEqual(codes(detectIssues([], meta({ headings: [{ level: 1, text: "A" }, { level: 2, text: "B" }, { level: 3, text: "C" }] }))), []);
  assert.deepEqual(codes(detectIssues([], meta({ headings: [{ level: 4, text: "A" }, { level: 5, text: "B" }] }))), ["missing-h1"], "a sequential start below h1 is a missing-h1, not a skip");
});

test("missing h1 fires with or without other headings", () => {
  const noHeadings = detectIssues([], meta({ headings: [] }));
  assert.deepEqual(codes(noHeadings), ["missing-h1"]);
  assert.equal(noHeadings[0].status, "INFO");
  const startsAtH2 = detectIssues([], meta({ headings: [{ level: 2, text: "Start" }, { level: 3, text: "Next" }] }));
  assert.deepEqual(codes(startsAtH2), ["missing-h1"]);
  assert.deepEqual(codes(detectIssues([], meta({ headings: [{ level: 1, text: "Only" }] }))), []);
});

test("heading rules are skipped when the caller supplies no outline facts", () => {
  const issues = detectIssues([], { title: "QA target", lang: "en", viewport: "width=device-width" });
  assert.deepEqual(issues, [], "absent heading data is unknown, never a violation");
});

test("repeated evaluation of the same markup is byte-identical", () => {
  const headings = [{ level: 1, text: "Title" }, { level: 4, text: "Jump" }, { level: 5, text: "Back-to-h1?" }];
  const first = detectIssues([], meta({ lang: "bad_lang", headings }));
  const second = detectIssues([], meta({ lang: "bad_lang", headings }));
  assert.deepEqual(first, second);
  assert.deepEqual(groupIssues(first), groupIssues(second));
});

test("repeated skips group into one issue with per-occurrence evidence", () => {
  const headings = [{ level: 1, text: "A" }, { level: 3, text: "B" }, { level: 1, text: "A" }, { level: 3, text: "B" }];
  const grouped = groupIssues(detectIssues([], meta({ headings })));
  const skip = grouped.find(issue => issue.code === "heading-skipped-level");
  assert.ok(skip);
  assert.equal(skip.count, 2);
  assert.equal(skip.examples?.length, 2);
  assert.equal(skip.examples?.[0]?.element?.text, "B");
  assert.equal(skip.examples?.[1]?.element?.text, "B");
});

test("all three codes classify as accessibility domain with stable labels and LOW severity", () => {
  const expected: Record<string, string> = {
    "invalid-lang": "Invalid language attribute",
    "missing-h1": "Missing primary heading",
    "heading-skipped-level": "Heading levels skipped",
  };
  const violations = detectIssues([], meta({ lang: "en_US", headings: [{ level: 2, text: "Start" }, { level: 4, text: "Jump" }] }));
  assert.deepEqual(codes(violations).filter(code => A11Y_CODES.includes(code as (typeof A11Y_CODES)[number])).sort(), [...A11Y_CODES].sort());
  for (const code of A11Y_CODES) {
    assert.equal(domainFor(code), "accessibility", code);
    assert.equal(labelFor(code), expected[code], code);
    const issue = violations.find(candidate => candidate.code === code);
    assert.ok(issue, code);
    const verdict = classifyIssue(issue, context);
    assert.equal(verdict.severity, "LOW", code);
    assert.equal(verdict.confidence, "high", code);
    assert.ok(verdict.rationale.includes(issue.message), `${code} rationale must quote its evidence`);
    assert.ok(verdict.recommendation.length > 0, code);
    assert.ok(verdict.userImpact.length > 0, code);
  }
});

const reportWith = (issues: Issue[]): ScanReport => ({
  scan: { url: "https://qa.test/", finalUrl: "https://qa.test/", title: "QA target", timestamp: "2026-01-01T00:00:00.000Z", durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
  summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: issues.filter(issue => issue.status === "WARNING").length, failures: 0, infos: issues.filter(issue => issue.status === "INFO").length, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: issues.length, groupedIssueCounts: { passes: 0, warnings: issues.filter(issue => issue.status === "WARNING").length, failures: 0, infos: issues.filter(issue => issue.status === "INFO").length } },
  page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements: [], issues, links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
});

test("buildFindings maps evidence correctly: element snapshot for skips, page for document-level", () => {
  const violations = detectIssues([], meta({ lang: "en_US", headings: [{ level: 2, text: "Start" }, { level: 4, text: "Jump" }] }));
  const findings = buildFindings(reportWith(violations));
  assert.equal(findings.length, violations.length);
  const skip = findings.find(finding => finding.code === "heading-skipped-level");
  assert.ok(skip);
  assert.equal(skip.domain, "accessibility");
  assert.equal(skip.title, "Heading levels skipped");
  assert.equal(skip.evidence.length, 1);
  assert.equal(skip.evidence[0].type, "element");
  assert.equal(skip.evidence[0].index, null, "outline facts are not report.elements");
  assert.equal(skip.evidence[0].locator, "page.getByRole(\"heading\", { level: 4, name: \"Jump\" })");
  for (const code of ["invalid-lang", "missing-h1"]) {
    const finding = findings.find(candidate => candidate.code === code);
    assert.ok(finding, code);
    assert.equal(finding.domain, "accessibility");
    assert.equal(finding.evidence[0].type, "page", code);
    assert.equal(finding.evidence[0].index, null, code);
  }
  for (const finding of findings) {
    assert.notEqual(finding.severity, "HIGH", finding.code);
    assert.notEqual(finding.severity, "CRITICAL", finding.code);
  }
});

test("a page with only these accessibility findings keeps existing QA/CI semantics", () => {
  const violations = detectIssues([], meta({ lang: "en_US", headings: [] }));
  const findings = buildFindings(reportWith(violations));
  assert.ok(findings.length >= 2);
  const summary = buildSummary(reportWith(violations), findings, [], [], null, "deterministic", "deterministic", undefined, undefined, {
    verified: 0, reproduced: 0, notReproduced: 0, pass: findings.length, review: 0, infrastructureFailures: 0, unverified: 0,
    scheduled: 0, executed: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0,
    infrastructureProblems: 0, verificationRun: true,
  });
  assert.equal(summary.overallStatus, "PASS", "LOW-severity accessibility findings never flip the overall status");
});
