import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { QaAnalysis } from "../ai/types.js";
import { buildResultsView } from "../dashboard/results-view.js";
import { startDashboard } from "../dashboard/server.js";

const RUN_ID = "web-test-run";

// ---------------------------------------------------------------------------
// A realistic report factory. Every field is a real pipeline field; the tests
// only vary the values so each productization rule can be asserted in isolation.
// ---------------------------------------------------------------------------
const report = (overrides: Record<string, unknown> = {}): QaAnalysis => {
  const base = {
    schemaVersion: 1,
    generatedAt: "2026-09-29T10:05:00.000Z",
    mode: "deterministic",
    aiProvider: "none",
    scan: {
      scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: "2026-09-29T10:00:00.000Z", durationMs: 4200 },
      authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: null },
      summary: { totalElements: 120, interactiveElements: 34, passes: 0, warnings: 0, failures: 1, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 1, groupedIssueCounts: { passes: 0, warnings: 0, failures: 1, infos: 0 } },
      page: { language: "en", viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
      elements: [],
      issues: [],
      links: [],
      consoleErrors: [],
      consoleDiagnostics: [],
      pageErrors: [],
    },
    findings: [],
    flows: [],
    scenarios: [],
    elementScenarios: [],
    verifications: [],
    flowDiscovery: null,
    coverage: null,
    regression: null,
    intelligence: null,
    execution: null,
    history: { status: "AVAILABLE", siteIdentity: "https://qa.test", currentRunId: "hist-1", runsAvailable: 3 },
    summary: {
      sourceUrl: "https://qa.test/en",
      scannedAt: "2026-09-29T10:00:00.000Z",
      mode: "deterministic",
      aiProvider: "none",
      elementCount: 120,
      interactiveElements: 34,
      issueCount: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      byConfidence: { high: 0, medium: 0, low: 0 },
      brokenLinks: 0,
      flowsDetected: 0,
      intentScenarios: 0,
      automatedScenarios: 0,
      manualScenarios: 0,
      reviewScenarios: 0,
      reviewTests: 0,
      excludedScenarios: 0,
      highRiskScenarios: 0,
      overallStatus: "NOT_TESTED",
      headline: "No executable test ran",
      topRecommendations: [],
      verified: 0,
      reproduced: 0,
      notReproduced: 0,
      pass: 0,
      review: 0,
      infrastructureFailures: 0,
      unverified: 0,
      scheduled: 0,
      executed: 0,
      skippedUnsupported: 0,
      skippedLocatorGuard: 0,
      skippedSafety: 0,
      reviewRequired: 0,
      infrastructureProblems: 0,
      flowSummary: null,
      coverageSummary: null,
    },
  };
  return { ...base, ...overrides } as unknown as QaAnalysis;
};

const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "QA-F-001",
  code: "BTN-NAME",
  status: "FAIL",
  lifecycle: "TEST_EXECUTED",
  relatedScenarioIds: [],
  verification: null,
  domain: "accessibility",
  severity: "HIGH",
  confidence: "high",
  title: "Button has no accessible name",
  description: "The submit button has no accessible name.",
  recommendation: "Add a text label or aria-label.",
  userImpact: "Screen reader users cannot activate the form.",
  rationale: "The scanner found a button with an empty accessible name.",
  count: 2,
  evidence: [],
  ...overrides,
});

const coverageSummary = {
  pages: { discovered: 8, tested: 5, partial: 1, untested: 2, blocked: 0, review: 0 },
  flows: { discovered: 5, executed: 3, passed: 2, reproduced: 0, notReproduced: 0, review: 1, blocked: 0 },
  interactions: { tested: 10, partial: 2, untested: 3, review: 1, notApplicable: 1 },
  findings: { analyzed: 2, verified: 2, reproduced: 0, notReproduced: 2, unverified: 0 },
  recommendations: 1,
};

const coverageMap = (items: unknown[] = [], testPlan: unknown[] = []) => ({
  generatedAt: "2026-09-29T10:05:00.000Z",
  items,
  summary: coverageSummary,
  testPlan,
  aiNotes: { gaps: ["Two pages were never reached."], prioritization: [], provider: null },
});

const build = (analysis: QaAnalysis, executionAvailable = true) => buildResultsView(analysis, { runId: RUN_ID, executionAvailable });

// ---------------------------------------------------------------------------
// View-model unit tests
// ---------------------------------------------------------------------------
test("the five QA statuses pass through untouched and each carries its own explanation", () => {
  for (const status of ["PASS", "FAIL", "REVIEW", "BLOCKED", "NOT_TESTED"] as const) {
    const view = build(report({ summary: { ...(report().summary as object), overallStatus: status, executed: status === "NOT_TESTED" ? 0 : 3, reproduced: status === "FAIL" ? 2 : 0 } }));
    assert.equal(view.overview.status, status);
    assert.ok(view.overview.statusExplanation.length > 20, `${status} must explain itself`);
    assert.ok(!/score|rating|grade|overall quality|health score/i.test(view.overview.statusExplanation), `${status} explanation must not introduce a score`);
  }
});

test("the view never exposes a score or an invented percentage", () => {
  const view = build(report({ findings: [finding()], coverage: coverageMap() }));
  const serialized = JSON.stringify(view);
  assert.ok(!/"(score|rating|grade|healthScore|qualityScore)"\s*:/.test(serialized));
  assert.ok(!/%\s*\d/.test(serialized.replace(/%20/g, "")), "no computed percentage may appear");
});

test("a NOT_TESTED run says health is unconfirmed instead of implying a pass", () => {
  const view = build(report({ coverage: coverageMap([{ coverageId: "COV-PAGE-9", category: "PAGE", name: "Legal page", status: "NOT_TESTED", reason: "Never crawled.", safety: "NOT_APPLICABLE", executionStatus: null, pageId: "p9", url: null, relatedFlows: [], relatedScenarios: [], relatedFindings: [], evidence: [] }]) }));
  assert.equal(view.overview.status, "NOT_TESTED");
  assert.match(view.overview.statusExplanation, /unconfirmed/i);
  assert.match(view.overview.statusExplanation, /never tested/i);
  assert.equal(view.verification.executed, false);
  assert.ok(view.verification.emptyMessage, "an unverified run must say so");
});

test("a run with no findings does not repeat its empty message twice", () => {
  const view = build(report());
  assert.equal(view.empty.messages.findings, "No findings were recorded for this run.");
  assert.equal(view.verification.emptyMessage, "This run produced no verification outcomes, and no findings were recorded. Website health is unconfirmed.");
});

test("flow counts and the flow section never contradict each other", () => {
  // Coverage recorded a discovered flow, but no per-flow detail was saved.
  const view = build(report({ coverage: coverageMap() }));
  const metric = view.metrics.find((m) => m.id === "flows-discovered");
  assert.equal(metric!.value, 5, "the metric reflects the coverage count");
  assert.equal(view.flows.available, false);
  assert.match(view.flows.headline, /recorded 5 flows/i);
  assert.match(view.flows.headline, /no per-flow detail/i);
  assert.equal(view.flows.counters.find((c) => c.id === "discovered")!.value, 5);
  assert.match(view.flows.emptyMessage!, /not available/i);
  assert.doesNotMatch(view.flows.emptyMessage!, /no user flows were discovered/i);
});

test("when neither flow discovery nor coverage ran, the flow section says so plainly", () => {
  const view = build(report());
  assert.match(view.flows.emptyMessage!, /no user flows were discovered/i);
  assert.equal(view.flows.counters.length, 0);
  assert.equal(view.metrics.find((m) => m.id === "flows-discovered")!.value, 0);
});

test("the flows-discovered metric is never taken from the unrelated flowsDetected summary field", () => {
  const view = build(report({ summary: { ...(report().summary as object), flowsDetected: 42 } }));
  assert.equal(view.metrics.find((m) => m.id === "flows-discovered")!.value, 0);
});

test("the metrics strip reports real counts only, including discovered versus executed flows", () => {
  const view = build(report({
    findings: [finding(), finding({ id: "QA-F-002", severity: "LOW", title: "Second finding" })],
    flowDiscovery: { limits: {}, graph: { sourceUrl: "https://qa.test/en", pages: [] }, flows: [], executions: [], summary: { pages: 8, flows: 5, executable: 4, review: 1, highRisk: 0, blocked: 0, steps: 12, executed: 3, passed: 2, reproduced: 0, notReproduced: 0, reviewRequired: 1, infrastructure: 0 } },
    coverage: coverageMap(),
  }));
  const byId = new Map(view.metrics.map((m) => [m.id, m.value]));
  assert.equal(byId.get("pages"), 8);
  assert.equal(byId.get("elements"), 120);
  assert.equal(byId.get("interactive"), 34);
  assert.equal(byId.get("flows-discovered"), 5);
  assert.equal(byId.get("flows-executed"), 3);
  assert.equal(byId.get("findings"), 2);
  assert.equal(view.findings.total, 2);
});

test("coverage is split into discovered, executed, and not tested or review groups", () => {
  const view = build(report({ coverage: coverageMap() }));
  const groups = new Map(view.coverage.groups.map((g) => [g.id, g]));
  assert.equal(groups.size, 3);
  const discovered = new Map(groups.get("discovered")!.rows.map((r) => [r.id, r.value]));
  const executed = new Map(groups.get("executed")!.rows.map((r) => [r.id, r.value]));
  const untested = new Map(groups.get("untested")!.rows.map((r) => [r.id, r.value]));
  assert.equal(discovered.get("pages"), 8);
  assert.equal(discovered.get("flows"), 5);
  assert.equal(executed.get("pages-tested"), 5);
  assert.equal(executed.get("flows-executed"), 3);
  assert.equal(untested.get("pages-untested"), 2);
  assert.equal(untested.get("pages-partial"), 1);
  assert.equal(untested.get("interactions-untested"), 3);
  assert.equal(untested.get("findings-unverified"), 0);
});

test("untested work becomes actionable gaps that state what, why, and the confidence cost", () => {
  const view = build(report({
    coverage: coverageMap([
      { coverageId: "COV-PAGE-8", category: "PAGE", name: "Checkout page", status: "NOT_TESTED", reason: "The crawler never reached this page.", safety: "NOT_APPLICABLE", executionStatus: null, pageId: "p8", url: "https://qa.test/checkout", relatedFlows: [], relatedScenarios: [], relatedFindings: [], evidence: [] },
      { coverageId: "COV-INT-4", category: "INTERACTION", name: "Quantity selector", status: "REVIEW_REQUIRED", reason: "The step is HIGH_RISK: it submits a payment form.", safety: "HIGH_RISK", executionStatus: null, pageId: "p2", url: null, relatedFlows: ["FLOW-002"], relatedScenarios: [], relatedFindings: ["QA-F-001"], evidence: [] },
    ]),
  }));
  const notTested = view.coverage.gapGroups.find((g) => g.kind === "not-tested")!;
  assert.ok(notTested, "untested coverage must produce a gap group");
  assert.equal(notTested.count, 1);
  assert.equal(notTested.items[0]!.name, "Checkout page");
  assert.match(notTested.items[0]!.reason, /never reached/i);
  assert.match(notTested.confidenceNote, /no conclusion can be drawn/i);
  const review = view.coverage.gapGroups.find((g) => g.kind === "review")!;
  assert.equal(review.items[0]!.name, "Quantity selector");
  assert.match(review.confidenceNote, /person must decide/i);
});

test("gaps are capped for the screen but the omitted count stays visible", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ coverageId: `COV-PAGE-${i}`, category: "PAGE", name: `Page ${i}`, status: "NOT_TESTED", reason: "Never crawled.", safety: "NOT_APPLICABLE", executionStatus: null, pageId: `p${i}`, url: null, relatedFlows: [], relatedScenarios: [], relatedFindings: [], evidence: [] }));
  const view = build(report({ coverage: coverageMap(items) }));
  const group = view.coverage.gapGroups[0]!;
  assert.equal(group.count, 20);
  assert.equal(group.items.length, 12);
  assert.equal(group.omitted, 8);
});

test("test-plan recommendations are surfaced as prioritized next steps", () => {
  const view = build(report({
    coverage: coverageMap([], [{
      recommendationId: "REC-1",
      type: "TEST_PAGE",
      title: "Test the checkout page",
      reason: "It was discovered but never loaded.",
      priority: "P1",
      priorityReason: "Checkout is a revenue path.",
      coverageIds: ["COV-PAGE-8"],
      relatedFindings: [],
      evidence: [],
    }]),
  }));
  assert.equal(view.coverage.recommendations.length, 1);
  assert.equal(view.coverage.recommendations[0]!.priority, "P1");
  assert.match(view.coverage.recommendations[0]!.reason, /never loaded/i);
});

test("verification counters carry their definitions and the full skip breakdown", () => {
  const view = build(report({
    summary: { ...(report().summary as object), scheduled: 9, executed: 5, reproduced: 1, notReproduced: 2, pass: 1, reviewRequired: 1, unverified: 4, skippedUnsupported: 2, skippedLocatorGuard: 1, skippedSafety: 1, infrastructureProblems: 1, overallStatus: "FAIL" },
    verifications: [{ findingId: "QA-F-001", scenarioId: "SC-VER-1", strategy: "accessible-name", locator: "#submit", status: "REPRODUCED", category: "WEBSITE", executedAt: "2026-09-29T10:02:00.000Z", durationMs: 40, expectation: "The button exposes an accessible name.", evidence: { located: true, locator: "#submit", tag: "button", role: "button", accessibleName: null, text: "", visible: true, enabled: true, href: null, url: "https://qa.test/en", id: "submit", attributes: null, count: 1, screenshotPath: null }, error: null, triage: { verdict: "LIKELY_DEFECT", reason: "The live button has no accessible name.", confidence: "high", provider: "deterministic" } }],
  }));
  const counters = new Map(view.verification.counters.map((c) => [c.id, c]));
  assert.equal(counters.get("scheduled")!.value, 9);
  assert.equal(counters.get("executed")!.value, 5);
  assert.equal(counters.get("reproduced")!.value, 1);
  assert.equal(counters.get("skipped-unsupported")!.value, 2);
  assert.equal(counters.get("skipped-locator")!.value, 1);
  assert.equal(counters.get("skipped-safety")!.value, 1);
  assert.equal(counters.get("infrastructure")!.value, 1);
  for (const counter of view.verification.counters) {
    assert.ok(counter.detail && counter.detail.length > 10, `${counter.id} must be defined`);
  }
  assert.equal(view.verification.verdicts.length, 1);
  assert.equal(view.verification.verdicts[0]!.verdict, "LIKELY_DEFECT");
});

test("infrastructure failures are labelled as runner problems, not website defects", () => {
  const view = build(report({
    summary: { ...(report().summary as object), executed: 1, infrastructureProblems: 1, overallStatus: "REVIEW" },
    verifications: [{ findingId: "QA-F-001", scenarioId: "SC-VER-1", strategy: "accessible-name", locator: "#submit", status: "REVIEW", category: "INFRASTRUCTURE", executedAt: null, durationMs: 5000, expectation: "x", evidence: { located: false, locator: null, tag: null, role: null, accessibleName: null, text: null, visible: null, enabled: null, href: null, url: null, id: null, attributes: null, count: null, screenshotPath: null }, error: { type: "TIMEOUT", message: "Browser navigation timed out" }, triage: { verdict: "INFRASTRUCTURE_PROBLEM", reason: "The browser timed out before the check could run.", confidence: "high", provider: "deterministic" } }],
  }));
  assert.equal(view.verification.infrastructureNotes.length, 1);
  assert.match(view.verification.infrastructureNotes[0]!, /browser timed out/i);
  assert.ok(view.verification.counters.find((c) => c.id === "infrastructure")!.detail!.includes("not website defects"));
});

test("findings are ordered most-critical-first and link to their bounded detail view", () => {
  const view = build(report({
    findings: [
      finding({ id: "QA-F-LOW", severity: "LOW", title: "Minor" }),
      finding({ id: "QA-F-CRIT", severity: "CRITICAL", title: "Critical one" }),
      finding({ id: "QA-F-HIGH", severity: "HIGH", title: "High one", verification: { disposition: "REPRODUCED", scenarioId: "SC-1", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", reason: "confirmed", safety: "safe", locator: "#a", executedAt: "2026-09-29T10:02:00.000Z", durationMs: 12, error: null } }),
      finding({ id: "QA-F-MED", severity: "MEDIUM", title: "Medium one" }),
    ],
  }));
  assert.deepEqual(view.findings.items.map((f) => f.severity), ["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
  assert.equal(view.findings.reproduced, 1);
  assert.equal(view.findings.unverified, 3);
  const first = view.findings.items[0]!;
  assert.equal(first.detailPath, `/api/qa/runs/${RUN_ID}/findings/QA-F-CRIT`);
  assert.ok(first.headline.length > 5, "a collapsed finding must state its outcome");
});

test("every finding disposition is described in plain language, never as a raw token", () => {
  const dispositions = [
    ["REPRODUCED", "REPRODUCED"],
    ["NOT_REPRODUCED", "NOT_REPRODUCED"],
    ["PASSED", "PASS"],
    ["SCHEDULED", null],
    ["REVIEW_REQUIRED", "REVIEW"],
    ["SKIPPED_UNSUPPORTED", null],
    ["SKIPPED_LOCATOR_GUARD", null],
    ["SKIPPED_SAFETY", null],
    ["INFRASTRUCTURE_PROBLEM", null],
  ] as const;
  for (const [disposition, status] of dispositions) {
    const view = build(report({ findings: [finding({ verification: { disposition, scenarioId: "SC-1", status, category: null, verdict: null, reason: "", safety: "safe", locator: null, executedAt: null, durationMs: null, error: null } })] }));
    const headline = view.findings.items[0]!.headline;
    assert.ok(headline.length > 8, `${disposition} needs a readable headline`);
    assert.ok(!headline.includes("_"), `${disposition} must not surface a raw token`);
  }
});

test("an authentication wall is an access boundary, never a website defect", () => {
  const view = build(report({
    accessPrerequisite: { type: "authentication-required", status: "REVIEW_REQUIRED", message: "The site redirected to a login page.", httpStatus: 302, challenge: "login form" },
    summary: { ...(report().summary as object), overallStatus: "REVIEW", headline: "Login required" },
  }));
  assert.ok(view.access, "an access banner is required");
  assert.equal(view.access!.kind, "AUTHENTICATION_REQUIRED");
  assert.equal(view.access!.isNotADefect, true);
  assert.match(view.access!.impact, /not a website defect/i);
  assert.match(view.overview.statusExplanation, /human review is required/i);
  assert.equal(view.findings.total, 0, "an access wall produces no findings");
  assert.equal(view.empty.noFindings, true);
  assert.match(view.empty.messages.findings!, /authenticated content/i);
});

test("bot protection and hard blocks each get their own banner, and accessible sites get none", () => {
  const bot = build(report({ accessPrerequisite: { type: "bot-protection", status: "BLOCKED", message: "Challenge page detected." }, summary: { ...(report().summary as object), overallStatus: "BLOCKED" } }));
  assert.equal(bot.access!.kind, "BOT_PROTECTION");
  assert.match(bot.overview.statusExplanation, /blocked/i);
  const blocked = build(report({ accessPrerequisite: { type: "access-blocked", status: "BLOCKED", message: "The server refused the request." }, summary: { ...(report().summary as object), overallStatus: "BLOCKED" } }));
  assert.equal(blocked.access!.kind, "ACCESS_BLOCKED");
  const ok = build(report({ accessPrerequisite: { type: "accessible", status: "PASS", message: "Reachable." } }));
  assert.equal(ok.access, null);
  assert.equal(ok.empty.noAccessIssue, true);
});

test("flows expose what ran, what did not, and why a flow was never executed", () => {
  const step = (action: string, target?: string) => ({ action, targetUrl: target, locator: "a[href='/x']", elementIndex: 1, text: null, expected: "The page loads.", safety: "SAFE", automation: "AUTOMATED", reason: "Safe link click.", evidence: [] });
  const risky = { action: "submit", targetUrl: undefined, locator: "#pay", elementIndex: 2, text: null, expected: "Payment succeeds.", safety: "HIGH_RISK", automation: "AUTOMATED", reason: "Submits a payment form.", evidence: [] };
  const view = build(report({
    flowDiscovery: {
      limits: {},
      graph: { sourceUrl: "https://qa.test/en", pages: [] },
      flows: [
        { flowId: "FLOW-001", category: "NAVIGATION", title: "Open the docs", description: "Navigate to docs.", startPageId: "p1", startUrl: "https://qa.test/en", steps: [step("open", "https://qa.test/docs"), step("click-link")], safety: "SAFE", automation: "AUTOMATED", boundary: null, executable: true, priority: "P1", priorityReason: "Core path.", confidence: "high", occurrenceCount: 1, dedupeKey: "k1", evidence: [{ pageId: "p1", elementIndex: 1, detail: "Docs link" }] },
        { flowId: "FLOW-002", category: "FORM_INTERACTION", title: "Pay for an order", description: "Checkout flow.", startPageId: "p2", startUrl: "https://qa.test/checkout", steps: [risky], safety: "HIGH_RISK", automation: "AUTOMATED", boundary: { stepIndex: 0, safety: "HIGH_RISK", automation: "AUTOMATED", reason: "Submits a payment form." }, executable: false, priority: "P0", priorityReason: "Revenue path.", confidence: "high", occurrenceCount: 1, dedupeKey: "k2", evidence: [] },
      ],
      executions: [{ scenarioId: "SC-FLOW-1", flowId: "FLOW-001", category: "NAVIGATION", title: "Open the docs", executedAt: "2026-09-29T10:03:00.000Z", durationMs: 900, status: "PASS", failureCategory: null, startedUrl: "https://qa.test/en", finalUrl: "https://qa.test/docs", stoppedAtStep: null, boundary: null, steps: [{ flowId: "FLOW-001", scenarioId: "SC-FLOW-1", stepIndex: 0, action: "open", outcome: "PASS", category: null, reason: "Loaded.", locator: null, url: "https://qa.test/docs", durationMs: 700, error: null }, { flowId: "FLOW-001", scenarioId: "SC-FLOW-1", stepIndex: 1, action: "click-link", outcome: "PASS", category: null, reason: "Navigated.", locator: "a[href='/docs']", url: "https://qa.test/docs", durationMs: 200, error: null }], error: null }],
      summary: { pages: 8, flows: 2, executable: 1, review: 0, highRisk: 1, blocked: 0, steps: 3, executed: 1, passed: 1, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
    },
  }));
  const passed = view.flows.items.find((f) => f.flowId === "FLOW-001")!;
  assert.equal(passed.status, "PASS");
  assert.equal(passed.steps.length, 2);
  assert.equal(passed.steps[0]!.outcome, "PASS");
  const skipped = view.flows.items.find((f) => f.flowId === "FLOW-002")!;
  assert.equal(skipped.status, "DISCOVERED_ONLY");
  assert.equal(skipped.execution, null);
  assert.match(skipped.reason, /not executed/i);
  assert.match(skipped.reason, /HIGH_RISK/);
  assert.equal(view.flows.notExecuted.length, 1);
  const counters = new Map(view.flows.counters.map((c) => [c.id, c.value]));
  assert.equal(counters.get("discovered"), 2);
  assert.equal(counters.get("executed"), 1);
  assert.equal(counters.get("blocked"), 0);
});

test("an executable flow with no execution result is reported as NOT_EXECUTED, never as passed", () => {
  const view = build(report({
    flowDiscovery: {
      limits: {},
      graph: { sourceUrl: "https://qa.test/en", pages: [] },
      flows: [{ flowId: "FLOW-001", category: "NAVIGATION", title: "Open docs", description: "", startPageId: "p1", startUrl: "https://qa.test/en", steps: [{ action: "open", targetUrl: "https://qa.test/docs", locator: null, elementIndex: null, text: null, expected: "Loads.", safety: "SAFE", automation: "AUTOMATED", reason: "safe", evidence: [] }], safety: "SAFE", automation: "AUTOMATED", boundary: null, executable: true, priority: "P1", priorityReason: "", confidence: "high", occurrenceCount: 1, dedupeKey: "k", evidence: [] }],
      executions: [],
      summary: { pages: 1, flows: 1, executable: 1, review: 0, highRisk: 0, blocked: 0, steps: 1, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
    },
  }));
  assert.equal(view.flows.items[0]!.status, "NOT_EXECUTED");
  assert.match(view.flows.items[0]!.reason, /no execution result/i);
});

test("every empty state is explicit rather than a blank section", () => {
  const view = build(report());
  assert.equal(view.empty.noFindings, true);
  assert.equal(view.empty.noFlows, true);
  assert.equal(view.empty.noVerification, true);
  assert.equal(view.empty.noCoverage, true);
  assert.equal(view.empty.noGaps, true);
  assert.ok(view.empty.messages.findings);
  assert.ok(view.empty.messages.flows);
  assert.ok(view.empty.messages.verification);
  assert.ok(view.empty.messages.coverage);
});

test("a run with coverage but no gaps says so instead of implying a perfect run", () => {
  const view = build(report({
    coverage: coverageMap([{ coverageId: "COV-PAGE-1", category: "PAGE", name: "Home", status: "TESTED", reason: "Executed.", safety: "NOT_APPLICABLE", executionStatus: "PASS", pageId: "p1", url: "https://qa.test/en", relatedFlows: [], relatedScenarios: [], relatedFindings: [], evidence: [] }]),
  }));
  assert.equal(view.empty.noGaps, true);
  assert.ok(view.coverage.emptyMessage);
});

test("report links point at the run's own artifacts and the history explorer when persisted", () => {
  const view = build(report());
  assert.equal(view.reports.json, `/api/qa/runs/${RUN_ID}/report`);
  assert.equal(view.reports.html, `/api/qa/runs/${RUN_ID}/report.html`);
  assert.equal(view.reports.execution, `/api/qa/runs/${RUN_ID}/execution`);
  assert.equal(view.overview.historyRunId, "hist-1");
  assert.equal(view.overview.historyRunsAvailable, 3);
  const withoutExecution = build(report(), false);
  assert.equal(withoutExecution.reports.execution, null);
});

test("the overview states when it is, mode, and duration, omitting what the run did not record", () => {
  const view = build(report());
  assert.equal(view.overview.url, "https://qa.test/en");
  assert.equal(view.overview.title, "QA target");
  assert.equal(view.overview.durationMs, 4200);
  assert.equal(view.overview.mode, "deterministic");
  assert.equal(view.overview.scannedAt, "2026-09-29T10:00:00.000Z");
  const bare = build(report({ summary: { ...(report().summary as object), sourceUrl: "", scannedAt: "" }, scan: { ...(report().scan as object), scan: { url: "", finalUrl: "", title: "", timestamp: "", durationMs: 0 } } }));
  assert.equal(bare.overview.durationMs, 0);
  assert.equal(bare.overview.title, null);
});

test("a sparse report does not crash the view and states its own limits", () => {
  const sparse = { schemaVersion: 1, generatedAt: "2026-09-29T10:05:00.000Z", summary: { overallStatus: "NOT_TESTED", headline: "Nothing ran." } } as unknown as QaAnalysis;
  const view = build(sparse);
  assert.equal(view.overview.status, "NOT_TESTED");
  assert.equal(view.findings.total, 0);
  assert.equal(view.flows.available, false);
  assert.equal(view.coverage.available, false);
  assert.equal(view.verification.executed, false);
  assert.ok(view.overview.statusExplanation.length > 10);
});

test("an unknown overall status degrades to NOT_TESTED rather than being passed through", () => {
  const view = build(report({ summary: { ...(report().summary as object), overallStatus: "GREAT" } }));
  assert.equal(view.overview.status, "NOT_TESTED");
});

// ---------------------------------------------------------------------------
// API tests
// ---------------------------------------------------------------------------
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[] };

const fakeSpawner = (): { spawnImpl: typeof import("node:child_process").spawn; children: FakeChild[] } => {
  const children: FakeChild[] = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.args = args;
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, children };
};

const start = async (dir: string, spawnImpl: typeof import("node:child_process").spawn) => {
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    projectRoot: process.cwd(),
    spawnImpl,
  });
  return { dash, base: `http://127.0.0.1:${dash.port}` };
};

const stop = async (dash: Awaited<ReturnType<typeof startDashboard>>): Promise<void> => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

const post = async (url: string, body: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const get = async (url: string): Promise<{ status: number; json: any }> => {
  const res = await fetch(url);
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** Starts a run and writes a real report artifact, exactly as the CLI would. */
const completeRunWith = async (base: string, children: FakeChild[], analysis: QaAnalysis) => {
  const started = await post(`${base}/api/qa/run`, { url: "https://qa.test/en" });
  const runId = started.json.run.runId as string;
  const child = children[0]!;
  const out = child.args[child.args.indexOf("--output") + 1]!;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(analysis));
  writeFileSync(out.replace(/\.json$/, ".html"), "<html><body>report</body></html>");
  writeFileSync(join(dirname(out), "qa-execution.json"), JSON.stringify({ schemaVersion: 1, scheduled: 1, executed: 1, verifications: [] }));
  child.emit("close", 0);
  return runId;
};

test("GET /api/qa/runs/:id/results serves the productized view for a completed run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-results-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const runId = await completeRunWith(base, children, report({
      findings: [finding({ verification: { disposition: "REPRODUCED", scenarioId: "SC-1", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", reason: "confirmed", safety: "safe", locator: "#submit", executedAt: "2026-09-29T10:02:00.000Z", durationMs: 12, error: null } })],
      coverage: coverageMap([{ coverageId: "COV-PAGE-8", category: "PAGE", name: "Checkout", status: "NOT_TESTED", reason: "Never crawled.", safety: "NOT_APPLICABLE", executionStatus: null, pageId: "p8", url: null, relatedFlows: [], relatedScenarios: [], relatedFindings: [], evidence: [] }]),
      summary: { ...(report().summary as object), overallStatus: "FAIL", executed: 1, reproduced: 1, issueCount: 1 },
    }));
    const res = await get(`${base}/api/qa/runs/${runId}/results`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const view = res.json.results;
    assert.equal(view.overview.status, "FAIL");
    assert.match(view.overview.statusExplanation, /reproduced/i);
    assert.equal(view.findings.total, 1);
    assert.equal(view.findings.reproduced, 1);
    assert.equal(view.findings.items[0].detailPath, `/api/qa/runs/${runId}/findings/QA-F-001`);
    assert.equal(view.coverage.gapGroups[0].kind, "not-tested");
    assert.equal(view.reports.html, `/api/qa/runs/${runId}/report.html`);

    const list = await get(`${base}/api/qa/runs/${runId}/findings`);
    assert.equal(list.status, 200);
    assert.equal(list.json.findings.length, 1);
    assert.equal(list.json.findings[0].id, "QA-F-001");

    const detail = await get(`${base}/api/qa/runs/${runId}/findings/QA-F-001`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.finding.id, "QA-F-001");
    assert.equal(detail.json.finding.description, "The submit button has no accessible name.");
  } finally {
    await stop(dash);
  }
});

test("the results endpoints are honest when a run has no report or an unknown finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-results-404-"));
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const started = await post(`${base}/api/qa/run`, { url: "https://qa.test/en" });
    const runId = started.json.run.runId as string;
    const running = await get(`${base}/api/qa/runs/${runId}/results`);
    assert.equal(running.status, 404);
    assert.match(running.json.error, /no report artifact/i);

    const missingRun = await get(`${base}/api/qa/runs/web-nope/results`);
    assert.equal(missingRun.status, 404);
    const badRunId = await get(`${base}/api/qa/runs/${encodeURIComponent("..%2F..%2Fpackage")}/results`);
    assert.equal(badRunId.status, 400);
  } finally {
    await stop(dash);
  }
});

test("an unknown finding id is a 404 and a malformed finding id is a 400, never a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-results-detail-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const runId = await completeRunWith(base, children, report({ findings: [finding()] }));
    const missing = await get(`${base}/api/qa/runs/${runId}/findings/QA-F-999`);
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /not found/i);
    const bad = await get(`${base}/api/qa/runs/${runId}/findings/${encodeURIComponent("a b")}`);
    assert.equal(bad.status, 400);
  } finally {
    await stop(dash);
  }
});

test("the results screen and the evidence explorer agree on the same finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-results-parity-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const runId = await completeRunWith(base, children, report({
      findings: [finding(), finding({ id: "QA-F-002", code: "IMG-ALT", title: "Image missing alt", severity: "MEDIUM" })],
    }));
    const view = await get(`${base}/api/qa/runs/${runId}/results`);
    const explorer = await get(`${base}/api/qa/runs/${runId}/findings`);
    assert.deepEqual(
      view.json.results.findings.items.map((f: any) => f.id).sort(),
      explorer.json.findings.map((f: any) => f.id).sort(),
    );
    for (const item of view.json.results.findings.items) {
      const detail = await get(`${base}${item.detailPath}`);
      assert.equal(detail.status, 200);
      const listed = explorer.json.findings.find((f: any) => f.id === item.id);
      assert.equal(detail.json.finding.title, listed.title);
      assert.equal(detail.json.finding.severity, listed.severity);
    }
  } finally {
    await stop(dash);
  }
});

test("the application page renders the results UI and no longer fetches the raw report directly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-results-page-"));
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /\/results/);
    assert.match(html, /What Was Not Tested/);
    assert.match(html, /Coverage Overview/);
    assert.match(html, /Not Tested or Review/);
    assert.match(html, /Expanded to load|Expand to load/);
    assert.match(html, /Loading recent runs/);
  } finally {
    await stop(dash);
  }
});
