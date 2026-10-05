import assert from "node:assert/strict";
import test from "node:test";
import { detectIssues, groupIssues } from "../checks.js";
import { analyzeScan } from "../ai/index.js";
import { buildFindings } from "../ai/analysis.js";
import { detectFlows, relateFlows } from "../ai/flows.js";
import { renderQaHtml } from "../ai/report.js";
import { decorateScenarios, intentFor, buildIntentScenarios, priorityFor } from "../ai/scenarios.js";
import { classifyIssue, SeverityContext } from "../ai/severity.js";
import { buildSummary } from "../ai/summary.js";
import { generateTestSuite } from "../test-generator.js";
import { DiscoveredElement, Issue, LinkResult, ScanReport } from "../types.js";

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const report = (elements: DiscoveredElement[], extra: Partial<ScanReport> = {}, links: LinkResult[] = []): ScanReport => {
  const issues = [...detectIssues(elements, { title: "QA target", lang: "en", viewport: "width=device-width" }), ...(extra.issues ?? [])];
  const grouped = groupIssues(issues);
  return {
    scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.filter(item => item.interactive).length, passes: 0, warnings: grouped.filter(issue => issue.status === "WARNING").length, failures: grouped.filter(issue => issue.status === "FAIL").length, infos: grouped.filter(issue => issue.status === "INFO").length, linksChecked: links.length, brokenLinks: links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length, consoleErrors: 0, pageErrors: 0, issueGroups: grouped.length, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements, issues: grouped, links, consoleErrors: [], consoleDiagnostics: [], pageErrors: [], ...extra,
  };
};

const context: SeverityContext = { navigationStatus: 200, authenticationAccepted: true, interactiveElementCount: 12, brokenLinkCount: 0 };

const namedIssues = (issues: Issue[]): Record<string, Issue[]> => {
  const map: Record<string, Issue[]> = {};
  for (const issue of issues) (map[issue.code] = map[issue.code] ?? []).push(issue);
  return map;
};

// ---------------------------------------------------------------------------
// Severity rubric
// ---------------------------------------------------------------------------
test("severity rubric classifies core issue codes deterministically", () => {
  assert.equal(classifyIssue({ status: "FAIL", code: "page-http-error", message: "Page navigation returned HTTP 500." }, context).severity, "CRITICAL");
  assert.equal(classifyIssue({ status: "FAIL", code: "authentication-failed", message: "Navigation returned HTTP 401." }, context).severity, "CRITICAL");
  assert.equal(classifyIssue({ status: "FAIL", code: "unhealthy-link", message: "x returned 404." }, { ...context, brokenLinkCount: 1 }).severity, "MEDIUM");
  assert.equal(classifyIssue({ status: "FAIL", code: "unhealthy-link", message: "x returned 404." }, { ...context, brokenLinkCount: 4 }).severity, "HIGH");
  assert.equal(classifyIssue({ status: "WARNING", code: "missing-lang", message: "x" }, context).severity, "LOW");
  assert.equal(classifyIssue({ status: "WARNING", code: "missing-viewport", message: "x" }, context).severity, "MEDIUM");
  assert.equal(classifyIssue({ status: "WARNING", code: "missing-viewport", message: "x" }, { ...context, interactiveElementCount: 1 }).severity, "LOW");
});

test("missing-name severity depends on visibility and context", () => {
  const visible: Issue = { status: "WARNING", code: "button-missing-name", message: "x", element: { tag: "button", role: "button", text: "", ariaLabel: null, id: null, testId: null, type: null, name: null, placeholder: null, accessibleName: null, href: null, alt: null, visible: true, enabled: true, recommendedLocator: "page.getByRole(\"button\", { name: \"?\" })", locatorQuality: "high" } };
  assert.equal(classifyIssue(visible, context).severity, "HIGH", "visible name gap in an authenticated app is HIGH");
  assert.equal(classifyIssue(visible, { ...context, authenticationAccepted: false }).severity, "MEDIUM");
  const hidden = { ...visible, element: { ...visible.element!, visible: false } };
  assert.equal(classifyIssue(hidden, context).severity, "LOW", "hidden name gap is deferred");
  const password: Issue = { ...visible, code: "password-missing-label", element: { ...visible.element!, type: "password" } };
  assert.equal(classifyIssue(password, { ...context, authenticationAccepted: false }).severity, "HIGH", "password labels are always critical for users");
  assert.ok(classifyIssue(visible, context).rationale.length > 0);
  assert.ok(classifyIssue(visible, context).recommendation.length > 0);
});

test("duplicate-id is HIGH when the duplicates are interactive", () => {
  const issue: Issue = { status: "FAIL", code: "duplicate-id", message: "The id \"dup\" appears 2 times.", occurrences: 2, examples: [{ element: { tag: "input", role: "textbox", text: "", ariaLabel: null, id: "dup", testId: null, type: "text", name: null, placeholder: "one", accessibleName: "one", href: null, alt: null, visible: true, enabled: true, recommendedLocator: "page.getByPlaceholder(\"one\")", locatorQuality: "high" } }] };
  const info: Issue = { status: "FAIL", code: "duplicate-id", message: "x", occurrences: 2, examples: [{ element: { tag: "div", role: null, text: "", ariaLabel: null, id: "dup", testId: null, type: null, name: null, placeholder: null, accessibleName: null, href: null, alt: null, visible: true, enabled: true, recommendedLocator: "page.locator(\"#dup\")", locatorQuality: "medium" } }] };
  assert.equal(classifyIssue(issue, context).severity, "HIGH");
  assert.equal(classifyIssue(info, context).severity, "MEDIUM");
});

// ---------------------------------------------------------------------------
// Findings + evidence
// ---------------------------------------------------------------------------
test("findings carry deterministic severity, rationale, recommendations, and evidence indexes", () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: null, placeholder: "Search", recommendedLocator: "page.getByPlaceholder(\"Search\")" });
  const button = element({ tag: "button", role: "button", text: "", accessibleName: null, recommendedLocator: "page.getByRole(\"button\", { name: \"?\" })" });
  const page = report([search, button]);
  const findings = buildFindings(page);
  const labelFinding = findings.find(finding => finding.code === "input-missing-label");
  assert.ok(labelFinding);
  assert.equal(labelFinding?.severity, "HIGH", "visible name gap in authenticated context is HIGH");
  assert.equal(labelFinding?.confidence, "high");
  assert.equal(labelFinding?.evidence[0]?.type, "element");
  assert.equal(labelFinding?.evidence[0]?.index, 0);
  assert.equal(labelFinding?.evidence[0]?.locator, "page.getByPlaceholder(\"Search\")");
  assert.equal(labelFinding?.domain, "accessibility");
  const nameFinding = findings.find(finding => finding.code === "button-missing-name");
  assert.equal(nameFinding?.evidence[0]?.index, 1);
});

test("grouped duplicate-id produces one finding with occurrences preserved", () => {
  const first = element({ tag: "input", role: "textbox", type: "text", id: "dup", placeholder: "one", accessibleName: "one", recommendedLocator: "page.getByPlaceholder(\"one\")" });
  const second = element({ tag: "input", role: "textbox", type: "text", id: "dup", placeholder: "two", accessibleName: "two", recommendedLocator: "page.getByPlaceholder(\"two\")" });
  const findings = buildFindings(report([first, second]));
  const dup = findings.filter(finding => finding.code === "duplicate-id");
  assert.equal(dup.length, 1);
  assert.equal(dup[0]?.occurrences, 2);
  assert.equal(dup[0]?.count, 1);
});

// ---------------------------------------------------------------------------
// Flow detection
// ---------------------------------------------------------------------------
test("flows are detected from search, password, language, and media evidence", () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: "Search", text: "", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" });
  const password = element({ tag: "input", role: "textbox", type: "password", name: "password", accessibleName: "Password", autocomplete: "current-password", recommendedLocator: "page.getByLabel(\"Password\")" });
  const lang = element({ tag: "a", role: "link", text: "عربي", accessibleName: "عربي", href: "https://qa.test/ar/set-lang", recommendedLocator: "page.getByRole(\"link\", { name: \"عربي\" })" });
  const page = report([search, password, lang], { page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 2 } });
  const flows = detectFlows(page);
  const kinds = new Set(flows.map(flow => flow.kind));
  assert.ok(kinds.has("search"));
  assert.ok(kinds.has("login"));
  assert.ok(kinds.has("language"));
  assert.ok(kinds.has("media"));
  assert.ok(kinds.has("navigation"));
  const searchFlow = flows.find(flow => flow.kind === "search");
  assert.equal(searchFlow?.confidence, "high", "a searchbox role is a direct signal");
  assert.equal(searchFlow?.elements[0]?.locator, "page.getByRole(\"searchbox\", { name: \"Search\" })");
});

test("error flows are blocked when page errors or broken links exist", () => {
  const page = report([], {
    pageErrors: ["Cannot read properties of undefined"],
    consoleDiagnostics: [],
  });
  const flows = detectFlows(page);
  const errorFlow = flows.find(flow => flow.kind === "error");
  assert.ok(errorFlow);
  assert.equal(errorFlow?.status, "blocked");
  assert.ok(errorFlow?.blockReason?.length);
});

test("relateFlows links element scenarios to flows by accessible name and locator", () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: "Search", text: "", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" });
  const page = report([search]);
  const suite = generateTestSuite(page);
  const decorated = decorateScenarios(suite);
  const related = relateFlows(detectFlows(page), decorated);
  const searchFlow = related.find(flow => flow.kind === "search");
  assert.ok(searchFlow && searchFlow.relatedScenarios.length > 0, "search flow must reference its element scenarios");
});

// ---------------------------------------------------------------------------
// Intent decoration + intent scenarios
// ---------------------------------------------------------------------------
test("element scenarios are decorated with intent and priority without changing generation", () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: "Search", text: "", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" });
  const full = element({ tag: "button", type: "submit", accessibleName: "Sign in", recommendedLocator: "page.getByRole(\"button\", { name: \"Sign in\" })" });
  const suite = generateTestSuite(report([search, full]));
  const total = suite.scenarios.length;
  const decorated = decorateScenarios(suite);
  assert.equal(decorated.length, total, "decoration must not add or remove scenarios");
  const searchScenario = decorated.find(scenario => scenario.sourceElement.accessibleName === "Search");
  assert.equal(searchScenario?.intent, "SEARCH");
  assert.equal(intentFor(searchScenario!), "SEARCH");
  const submit = decorated.find(scenario => scenario.title.includes("Submit button"));
  assert.ok(submit);
  assert.equal(submit.intent, "AUTHENTICATION");
  assert.equal(submit.priority, "P1", "high-risk submit buttons are P1");
  const integrity = decorated.find(scenario => scenario.id === "SC-NAV-INTEGRITY");
  assert.equal(integrity?.intent, "NAVIGATION");
  assert.equal(integrity?.priority, "P2");
});

test("conditional hidden controls are decorated as P4 review", () => {
  const hidden = element({ tag: "a", role: "link", text: "close player", accessibleName: "close player", href: "https://qa.test/en#", visible: false, boundingBox: null, recommendedLocator: "page.getByRole(\"link\", { name: \"close player\" })" });
  const suite = generateTestSuite(report([hidden]));
  const decorated = decorateScenarios(suite);
  const scenario = decorated.find(item => item.locator === "page.getByRole(\"link\", { name: \"close player\" })");
  assert.ok(scenario);
  assert.equal(scenario.risk, "review");
  assert.equal(scenario.automated, false);
  assert.equal(scenario.requiresSetup, true);
  assert.equal(priorityFor(scenario), "P4");
});

test("intent scenarios are built from flows and respect the never-auto-submit rule", () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: "Search", text: "", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" });
  const password = element({ tag: "input", role: "textbox", type: "password", name: "password", accessibleName: "Password", autocomplete: "current-password", recommendedLocator: "page.getByLabel(\"Password\")" });
  const link = element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://qa.test/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const unnamed = element({ tag: "button", role: "button", text: "", accessibleName: null, recommendedLocator: "page.getByRole(\"button\", { name: \"?\" })" });
  const page = report([search, password, link, unnamed]);
  const suite = generateTestSuite(page);
  const flows = relateFlows(detectFlows(page), decorateScenarios(suite));
  const scenarios = buildIntentScenarios(page, flows, buildFindings(page), decorateScenarios(suite));
  const searchIntent = scenarios.find(scenario => scenario.id === "SC-SEARCH-001");
  assert.ok(searchIntent);
  assert.equal(searchIntent.intent, "SEARCH");
  assert.equal(searchIntent.automation, "REVIEW");
  assert.ok(searchIntent.relatedScenarios.length > 0);
  const loginIntent = scenarios.find(scenario => scenario.id === "SC-LOGIN-001");
  assert.ok(loginIntent);
  assert.equal(loginIntent.priority, "P1");
  assert.equal(loginIntent.automation, "REVIEW");
  assert.ok(loginIntent.safetyNote?.includes("dedicated test account"));
  const navIntent = scenarios.find(scenario => scenario.id === "SC-NAVIGATION-001");
  assert.ok(navIntent);
  assert.equal(navIntent.automation, "AUTOMATED", "navigation is verification-only and safe to automate");
  const accIntent = scenarios.find(scenario => scenario.id === "SC-ACC-001");
  assert.ok(accIntent, "accessibility intent gate is added when a11y findings exist");
  assert.ok(scenarios.every(scenario => scenario.steps.length > 0 && scenario.expected.length > 0));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
test("summary review counts match the spec exclusions without arbitrary scores", () => {
  const hidden = () => element({ tag: "a", role: "link", text: "close player", accessibleName: "close player", href: "https://qa.test/en#", visible: false, boundingBox: null, recommendedLocator: "page.getByRole(\"link\", { name: \"close player\" })" });
  const submit = element({ tag: "button", type: "submit", accessibleName: "Pay now", recommendedLocator: "page.getByRole(\"button\", { name: \"Pay now\" })" });
  const link = element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://qa.test/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const page = report([link, submit, ...Array.from({ length: 22 }, hidden)]);
  const suite = generateTestSuite(page);
  const findings = buildFindings(page);
  const flows = relateFlows(detectFlows(page), decorateScenarios(suite));
  const scenarios = buildIntentScenarios(page, flows, findings, decorateScenarios(suite));
  const summary = buildSummary(page, findings, flows, scenarios, suite, "deterministic", "deterministic", undefined, undefined, { verified: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0, infrastructureFailures: 0, unverified: findings.length, scheduled: 0, executed: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0, infrastructureProblems: 0, verificationRun: true });
  assert.equal(summary.reviewTests, summary.manualScenarios - summary.excludedScenarios - summary.highRiskScenarios);
  assert.equal(summary.overallStatus, "PASS", "no critical/high findings means PASS");
  assert.equal(summary.flowsDetected, flows.length);
  assert.ok(summary.headline.length > 0);
  assert.ok(summary.topRecommendations.length >= 0);
});

test("a critical finding flips the release gate to FAIL", () => {
  const page = report([], { issues: [{ status: "FAIL", code: "page-http-error", message: "Page navigation returned HTTP 500." }] });
  const suite = generateTestSuite(page);
  const findings = buildFindings(page);
  const flows = relateFlows(detectFlows(page), decorateScenarios(suite));
  const scenarios = buildIntentScenarios(page, flows, findings, decorateScenarios(suite));
  const summary = buildSummary(page, findings, flows, scenarios, suite, "deterministic", "deterministic", undefined, undefined, { verified: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0, infrastructureFailures: 0, unverified: findings.length, scheduled: 0, executed: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0, infrastructureProblems: 0, verificationRun: true });
  assert.equal(summary.bySeverity.CRITICAL, 1);
  assert.equal(summary.overallStatus, "FAIL");
});

// ---------------------------------------------------------------------------
// QaAnalysis document + HTML
// ---------------------------------------------------------------------------
test("analyzeScan produces a complete, schema-stable QaAnalysis", async () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: "Search", text: "", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" });
  const password = element({ tag: "input", role: "textbox", type: "password", name: "password", accessibleName: "Password", recommendedLocator: "page.getByLabel(\"Password\")" });
  const page = report([search, password]);
  const analysis = await analyzeScan(page, { suite: generateTestSuite(page) });
  assert.equal(analysis.schemaVersion, 1);
  assert.equal(analysis.mode, "deterministic");
  assert.equal(analysis.aiProvider, "deterministic");
  assert.ok(analysis.generatedAt.length > 0);
  assert.equal(analysis.execution, null);
  assert.ok(Array.isArray(analysis.findings));
  assert.ok(analysis.flows.some(flow => flow.kind === "search"));
  assert.ok(Array.isArray(analysis.elementScenarios));
  assert.ok(analysis.elementScenarios.every(scenario => scenario.intent && scenario.priority));
  assert.equal(analysis.summary.overallStatus, "NOT_TESTED");
  const serialized = JSON.stringify(analysis);
  assert.ok(!serialized.includes("AI_API_KEY"));
  assert.ok(!serialized.includes("AI_API_URL"));
});

test("HTML report renders all 12 sections and never the credential placeholders", async () => {
  const search = element({ tag: "input", role: "searchbox", type: "search", name: "q", accessibleName: "Search", text: "", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })" });
  const page = report([search]);
  const analysis = await analyzeScan(page, { suite: generateTestSuite(page) });
  const html = renderQaHtml(analysis);
  for (const heading of ["Executive Summary", "Scan Information", "QA Findings by Severity", "Accessibility Findings", "Navigation Findings", "User Flows", "Automated Test Coverage", "Manual / Review Scenarios", "High-Risk Scenarios", "Detailed Evidence", "Recommended Fixes", "Test Execution Results"]) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(!html.includes("AI_API_KEY"));
  assert.ok(!html.includes("AI_API_URL"));
});

test("authorization secret placeholders never leak into reports even with a structured scan", async () => {
  const page = report([element()]);
  const suite = generateTestSuite(page);
  const analysis = await analyzeScan(page, { suite });
  const serialized = JSON.stringify(analysis) + renderQaHtml(analysis);
  for (const secret of ["AI_API_KEY", "QA_AUTHORIZATION", "Bearer ", "dnoord"]) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
});

test("namedIssues helper groups codes", () => {
  const page = report([element({ accessibleName: null, text: "" }), element({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null })]);
  const grouped = namedIssues(page.issues);
  assert.ok(grouped["button-missing-name"]);
  assert.ok(grouped["image-missing-alt"]);
});