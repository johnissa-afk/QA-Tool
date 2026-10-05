import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { chromium } from "playwright";
import type { DiscoveredElement, LinkResult, ScanReport } from "../types.js";
import type {
  DiscoveredFlow,
  FlowDiscovery,
  FlowExecutionResult,
  FlowLimits,
  FlowStep,
  FlowStepExecutionResult,
  FlowSummary,
  NodeControl,
  NodeEdge,
  SitePageNode,
} from "../flow/types.js";
import type { FlowCategory, FlowFailureCategory, FlowStepAction, FlowStepOutcome, FlowPriority } from "../flow/types.js";
import type { QaAnalysis, QaFinding, QaSummary } from "../ai/types.js";
import type { CoverageItem, CoverageMap, TestPlanRecommendation, TestPlanRecommendationType } from "../coverage/types.js";
import { analyzeScan } from "../ai/index.js";
import { renderQaHtml } from "../ai/report.js";
import { scanWebsite } from "../scanner.js";
import { runFlow, defaultFlowLimits } from "../flow/index.js";
import { buildCoverage } from "../coverage/index.js";
import { applyRegressionNotes, compareRuns } from "../regression/index.js";
import type { ChangeClassification, RegressionMap } from "../regression/index.js";

// ---------------------------------------------------------------------------
// Phase 5 fixture tests. Every fixture is generic (https://qa.test/en only).
// The comparison is deterministic and website-agnostic: regressions require a
// previously verified/expected condition that changed negatively, infra is
// never a regression, and missing evidence never becomes a fix.
// ---------------------------------------------------------------------------

const limits = (overrides: Partial<FlowLimits> = {}): FlowLimits => ({ ...defaultFlowLimits(), ...overrides });

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button",
  role: "button",
  text: "",
  ariaLabel: null,
  placeholder: null,
  name: null,
  id: null,
  testId: null,
  type: null,
  hasExplicitType: true,
  autocomplete: null,
  href: null,
  alt: null,
  visible: true,
  enabled: true,
  boundingBox: null,
  interactive: true,
  accessibleName: null,
  recommendedLocator: "page.getByRole(\"button\", { name: \"x\" })",
  locatorQuality: "high",
  formIndex: null,
  ...overrides,
});

const report = (overrides: Partial<Record<string, unknown>> & { elements?: DiscoveredElement[]; links?: LinkResult[] } = {}): ScanReport => {
  const elements = overrides.elements ?? [];
  return {
    scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.length, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: elements.filter(e => e.tag === "a").length, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements,
    issues: [],
    links: overrides.links ?? [],
    consoleErrors: [],
    consoleDiagnostics: [],
    pageErrors: [],
    ...overrides,
  } as unknown as ScanReport;
};

const step = (overrides: Partial<FlowStep> & { action: FlowStepAction }): FlowStep => ({
  action: overrides.action,
  targetUrl: overrides.targetUrl,
  locator: overrides.locator ?? null,
  elementIndex: overrides.elementIndex ?? null,
  text: overrides.text ?? null,
  expected: overrides.expected ?? "expectation",
  safety: overrides.safety ?? "SAFE",
  automation: overrides.automation ?? "AUTOMATED",
  reason: overrides.reason ?? "deterministic step",
  evidence: [],
});

const flow = (overrides: Partial<DiscoveredFlow> & { flowId: string; category: FlowCategory; startPageId: string; startUrl: string; dedupeKey: string }): DiscoveredFlow => {
  const steps = overrides.steps ?? [step({ action: "open", targetUrl: overrides.startUrl, expected: "page loads" })];
  const safety = overrides.safety ?? (steps.some(s => s.safety === "BLOCKED") ? "BLOCKED" : steps.some(s => s.safety !== "SAFE") ? "REVIEW" : "SAFE");
  const executable = overrides.executable ?? steps.every(s => s.safety === "SAFE" && s.automation === "AUTOMATED");
  return {
    flowId: overrides.flowId,
    category: overrides.category,
    title: overrides.title ?? `${overrides.flowId} title`,
    description: overrides.description ?? "discovered flow",
    startPageId: overrides.startPageId,
    startUrl: overrides.startUrl,
    steps,
    safety,
    automation: overrides.automation ?? (steps.every(s => s.automation === "AUTOMATED") ? "AUTOMATED" : "MANUAL"),
    boundary: overrides.boundary ?? null,
    executable,
    priority: overrides.priority ?? "P2",
    priorityReason: overrides.priorityReason ?? "deterministic fixture priority.",
    confidence: overrides.confidence ?? "high",
    occurrenceCount: overrides.occurrenceCount ?? 1,
    dedupeKey: overrides.dedupeKey,
    evidence: [],
  };
};

const stepExec = (flowId: string, base: Partial<FlowStepExecutionResult> = {}): FlowStepExecutionResult => ({
  flowId,
  scenarioId: `SC-${flowId}`,
  stepIndex: base.stepIndex ?? 0,
  action: base.action ?? "open",
  outcome: base.outcome ?? "PASS",
  category: base.category ?? "WEBSITE",
  reason: base.reason ?? "executed",
  locator: null,
  url: null,
  durationMs: 10,
  error: null,
});

const exec = (overrides: Partial<FlowExecutionResult> & { flowId: string; status: FlowStepOutcome }): FlowExecutionResult => ({
  scenarioId: overrides.scenarioId ?? `SC-${overrides.flowId}`,
  flowId: overrides.flowId,
  category: overrides.category ?? "NAVIGATION",
  title: overrides.title ?? `execution of ${overrides.flowId}`,
  executedAt: overrides.executedAt ?? "2026-09-17T00:00:00.000Z",
  durationMs: overrides.durationMs ?? 100,
  status: overrides.status,
  failureCategory: overrides.failureCategory ?? null,
  startedUrl: overrides.startedUrl ?? "https://qa.test/en",
  finalUrl: overrides.finalUrl ?? null,
  stoppedAtStep: overrides.stoppedAtStep ?? null,
  boundary: overrides.boundary ?? null,
  steps: overrides.steps ?? [],
  error: overrides.error ?? null,
});

const pageNode = (overrides: Partial<SitePageNode> & { id: string; url: string }): SitePageNode => ({
  id: overrides.id,
  url: overrides.url,
  title: overrides.title ?? null,
  depth: overrides.depth ?? 0,
  sourceReportUrl: overrides.sourceReportUrl ?? overrides.url,
  navigationStatus: overrides.navigationStatus ?? 200,
  brokenLinks: overrides.brokenLinks ?? 0,
  controls: overrides.controls ?? [],
  edges: overrides.edges ?? [],
});

const summaryFor = (discovery: FlowDiscovery): FlowSummary => ({
  pages: discovery.graph.pages.length,
  flows: discovery.flows.length,
  executable: discovery.flows.filter(f => f.executable).length,
  review: discovery.flows.filter(f => f.safety === "REVIEW").length,
  highRisk: discovery.flows.filter(f => f.safety === "HIGH_RISK").length,
  blocked: discovery.flows.filter(f => f.safety === "BLOCKED").length,
  steps: discovery.flows.reduce((n, f) => n + f.steps.length, 0),
  executed: discovery.executions.length,
  passed: discovery.executions.filter(e => e.status === "PASS").length,
  reproduced: discovery.executions.filter(e => e.status === "REPRODUCED").length,
  notReproduced: discovery.executions.filter(e => e.status === "NOT_REPRODUCED").length,
  reviewRequired: discovery.executions.filter(e => e.status === "REVIEW_REQUIRED").length,
  infrastructure: discovery.executions.filter(e => e.status === "INFRASTRUCTURE_PROBLEM").length,
});

const discovery = (overrides: { pages: SitePageNode[]; flows: DiscoveredFlow[]; executions?: FlowExecutionResult[] }): FlowDiscovery => {
  const base: FlowDiscovery = {
    limits: limits(),
    graph: { sourceUrl: overrides.pages[0]?.url ?? "https://qa.test/en", pages: overrides.pages },
    flows: overrides.flows,
    executions: overrides.executions ?? [],
    summary: { pages: 0, flows: 0, executable: 0, review: 0, highRisk: 0, blocked: 0, steps: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
  };
  base.summary = summaryFor(base);
  return base;
};

const ver = (o: { disposition: NonNullable<QaFinding["verification"]>["disposition"]; status?: NonNullable<QaFinding["verification"]>["status"]; category?: NonNullable<QaFinding["verification"]>["category"]; verdict?: NonNullable<QaFinding["verification"]>["verdict"]; reason?: string }): NonNullable<QaFinding["verification"]> => ({
  disposition: o.disposition,
  scenarioId: null,
  status: o.status ?? (o.disposition === "REPRODUCED" ? "REPRODUCED" : o.disposition === "NOT_REPRODUCED" ? "NOT_REPRODUCED" : o.disposition === "PASSED" ? "PASS" : o.disposition === "REVIEW_REQUIRED" ? "REVIEW" : null),
  category: o.category ?? null,
  verdict: o.verdict ?? null,
  reason: o.reason ?? "verification probe completed",
  safety: "safe",
  locator: null,
  executedAt: "2026-09-17T00:00:00.000Z",
  durationMs: 50,
  error: null,
});

const finding = (overrides: Partial<QaFinding> & { id: string }): QaFinding => ({
  id: overrides.id,
  code: overrides.code ?? "button-missing-name",
  status: overrides.status ?? "WARNING",
  lifecycle: overrides.lifecycle ?? "ANALYZED",
  relatedScenarioIds: overrides.relatedScenarioIds ?? [],
  verification: overrides.verification ?? null,
  domain: overrides.domain ?? "accessibility",
  severity: overrides.severity ?? "MEDIUM",
  confidence: overrides.confidence ?? "high",
  title: overrides.title ?? `${overrides.id} title`,
  description: overrides.description ?? "description",
  recommendation: overrides.recommendation ?? "recommendation",
  userImpact: overrides.userImpact ?? "user impact",
  rationale: overrides.rationale ?? "rationale",
  count: overrides.count ?? 1,
  evidence: overrides.evidence ?? [],
});

const covItem = (overrides: Partial<CoverageItem> & { coverageId: string; name: string }): CoverageItem => ({
  category: overrides.category ?? "FLOW",
  name: overrides.name,
  status: overrides.status ?? "NOT_TESTED",
  reason: overrides.reason ?? "fixture coverage",
  safety: overrides.safety ?? "SAFE",
  executionStatus: overrides.executionStatus ?? null,
  pageId: overrides.pageId ?? null,
  url: overrides.url ?? null,
  relatedFlows: overrides.relatedFlows ?? [],
  relatedScenarios: overrides.relatedScenarios ?? [],
  relatedFindings: overrides.relatedFindings ?? [],
  evidence: overrides.evidence ?? [],
  coverageId: overrides.coverageId,
});

const covMap = (items: CoverageItem[], testPlan: TestPlanRecommendation[] = []): CoverageMap => ({
  generatedAt: new Date().toISOString(),
  items,
  testPlan,
  summary: {
    pages: { discovered: 0, tested: 0, partial: 0, untested: 0, blocked: 0, review: 0 },
    flows: { discovered: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, review: 0, blocked: 0 },
    interactions: { tested: 0, partial: 0, untested: 0, review: 0, notApplicable: 0 },
    findings: { analyzed: 0, verified: 0, reproduced: 0, notReproduced: 0, unverified: 0 },
    recommendations: testPlan.length,
  },
  aiNotes: null,
});

const rec = (overrides: Partial<TestPlanRecommendation> & { recommendationId: string; type: TestPlanRecommendationType }): TestPlanRecommendation => ({
  recommendationId: overrides.recommendationId,
  type: overrides.type,
  title: overrides.title ?? `${overrides.recommendationId} title`,
  reason: overrides.reason ?? "fixture recommendation",
  priority: overrides.priority ?? "P2",
  priorityReason: overrides.priorityReason ?? "fixture priority",
  coverageIds: overrides.coverageIds ?? [],
  relatedFindings: overrides.relatedFindings ?? [],
  evidence: overrides.evidence ?? [],
});

const emptySummary = (): QaSummary => ({
  sourceUrl: "https://qa.test/en",
  scannedAt: new Date().toISOString(),
  mode: "deterministic",
  aiProvider: "deterministic",
  elementCount: 0,
  interactiveElements: 0,
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
  overallStatus: "PASS",
  headline: "fixture",
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
});

type RunOverrides = {
  report: ScanReport;
  findings?: QaFinding[];
  flowDiscovery?: FlowDiscovery | null;
  coverage?: CoverageMap | null;
  execution?: unknown;
  generatedAt?: string;
};

const mkRun = (overrides: RunOverrides): QaAnalysis => ({
  schemaVersion: 1,
  generatedAt: overrides.generatedAt ?? new Date().toISOString(),
  mode: "deterministic",
  aiProvider: "deterministic",
  scan: overrides.report,
  findings: overrides.findings ?? [],
  flows: [],
  scenarios: [],
  elementScenarios: [],
  verifications: [],
  flowDiscovery: overrides.flowDiscovery ?? null,
  coverage: overrides.coverage ?? null,
  regression: null,
  intelligence: null,
  execution: (overrides.execution as QaAnalysis["execution"]) ?? null,
  summary: emptySummary(),
});

const baseRun = (overrides: RunOverrides): QaAnalysis =>
  mkRun({ generatedAt: "2026-01-01T00:00:00.000Z", ...overrides });

const navFlowSpec = (flowId: string) => flow({ flowId, category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: `nav:${flowId}`, priority: "P2" });

const pageForFinding = (btn: DiscoveredElement, flowId: string) =>
  discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })],
    flows: [navFlowSpec(flowId)],
    executions: [exec({ flowId, status: "PASS", steps: [stepExec(flowId, { action: "open" })] })],
  });

const count = (map: RegressionMap, classification: ChangeClassification): number => map.summary.counts[classification] ?? 0;

// ---------------------------------------------------------------------------

test("A: identical runs produce no NEW/FIXED/REGRESSION and honest UNCHANGED records", () => {
  const btn = element({
    tag: "button",
    role: "button",
    text: "Subscribe",
    accessibleName: "Subscribe",
    href: null,
    recommendedLocator: "page.getByRole(\"button\", { name: \"Subscribe\" })",
  });
  const r = report({ elements: [btn] });
  const flowId = "FLOW-NAV";
  const executed = pageForFinding(btn, flowId);
  const coverage = buildCoverage({ report: r, flowDiscovery: executed, findings: [], verifications: [] });
  const f = finding({ id: "QA-F-001", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });

  const baseline = baseRun({ report: r, findings: [f], flowDiscovery: executed, coverage });
  const current = mkRun({ report: r, findings: [f], flowDiscovery: executed, coverage, generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(current, baseline);
  assert.equal(result.summary.comparable, true);
  assert.equal(count(result, "NEW"), 0);
  assert.equal(count(result, "FIXED"), 0);
  assert.equal(count(result, "REGRESSION"), 0);
  assert.equal(count(result, "CHANGED"), 0);
  assert.equal(count(result, "COVERAGE_CHANGED"), 0);
  assert.equal(count(result, "REVIEW_REQUIRED"), 0);
  assert.equal(count(result, "NEW_FLOW"), 0);
  assert.equal(count(result, "REMOVED_FLOW"), 0);
  assert.equal(count(result, "CHANGED_FLOW"), 0);
  assert.ok(count(result, "UNCHANGED") > 0, "matched finding + coverage items recorded as UNCHANGED");
  assert.ok(count(result, "UNCHANGED_FLOW") > 0, "identical executing flow is UNCHANGED_FLOW");
  assert.ok(result.summary.headline.includes("no regressions") || result.summary.headline.includes("No changes detected"));
});

test("B: a finding only in the current run is NEW", () => {
  const btn = element({ accessibleName: "Config", text: "Config" });
  const r = report({ elements: [btn] });
  const d = pageForFinding(btn, "FLOW-NAV");
  const baseline = baseRun({ report: r, findings: [], flowDiscovery: d, coverage: buildCoverage({ report: r, flowDiscovery: d, findings: [], verifications: [] }) });
  const currentFinding = finding({ id: "QA-F-NEW", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const current = mkRun({ report: r, findings: [currentFinding], flowDiscovery: d, coverage: buildCoverage({ report: r, flowDiscovery: d, findings: [], verifications: [] }) });

  const result = compareRuns(current, baseline);
  const newChanges = result.changes.filter(change => change.category === "FINDING" && change.classification === "NEW");
  assert.equal(count(result, "NEW"), 1);
  assert.equal(newChanges.length, 1);
  assert.equal(newChanges[0]!.currentReference, "QA-F-NEW");
});

test("C: verified removals are FIXED; unverified removals are REVIEW_REQUIRED (never FIXED)", () => {
  const btn = element({ accessibleName: "Go", text: "Go" });
  const r = report({ elements: [btn] });
  const d = pageForFinding(btn, "FLOW-NAV");
  const baselineConfirmed = finding({ id: "QA-F-CONFIRMED", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const baselineUnverified = finding({ id: "QA-F-UNVERIFIED", code: "empty-link", verification: null, evidence: [{ type: "element", index: 0 }] });

  const baseline = baseRun({ report: r, findings: [baselineConfirmed, baselineUnverified], flowDiscovery: d });
  const current = mkRun({ report: r, findings: [], flowDiscovery: d, generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(current, baseline);
  const fixed = result.changes.filter(change => change.category === "FINDING" && change.classification === "FIXED");
  const review = result.changes.filter(change => change.category === "FINDING" && change.classification === "REVIEW_REQUIRED");
  assert.equal(fixed.length, 1, "verified (reproduced) finding removal is FIXED");
  assert.equal(fixed[0]!.baselineReference, "QA-F-CONFIRMED");
  assert.equal(fixed[0]!.confidence, "HIGH_CONFIDENCE");
  assert.equal(review.length, 1, "unverified finding removal must never claim a fix");
  assert.equal(review[0]!.baselineReference, "QA-F-UNVERIFIED");
});

test("D: previous PASS → confirmed reproduction is a REGRESSION with HIGH_CONFIDENCE", () => {
  const btn = element({ accessibleName: "Search", text: "Search" });
  const r = report({ elements: [btn] });
  const d = pageForFinding(btn, "FLOW-NAV");
  const baselineF = finding({ id: "QA-F-CLEAN", code: "button-missing-name", verification: ver({ disposition: "PASSED", status: "PASS", reason: "element present, name supplied" }), evidence: [{ type: "element", index: 0 }] });
  const currentF = finding({ id: "QA-F-REPRO", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED", reason: "name missing on the live page" }), evidence: [{ type: "element", index: 0 }] });

  const baseline = baseRun({ report: r, findings: [baselineF], flowDiscovery: d });
  const current = mkRun({ report: r, findings: [currentF], flowDiscovery: d, generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(current, baseline);
  const regressions = result.changes.filter(change => change.category === "FINDING" && change.classification === "REGRESSION");
  assert.equal(regressions.length, 1);
  assert.equal(regressions[0]!.confidence, "HIGH_CONFIDENCE");
  assert.equal(count(result, "REGRESSION"), 1);
});

test("E: infrastructure failures are never regressions", () => {
  const btn = element({ accessibleName: "Filter", text: "Filter" });
  const r = report({ elements: [btn] });
  const baseExec = pageForFinding(btn, "FLOW-NAV");
  const infraExec = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })],
    flows: [navFlowSpec("FLOW-NAV")],
    executions: [exec({ flowId: "FLOW-NAV", status: "INFRASTRUCTURE_PROBLEM", failureCategory: "INFRASTRUCTURE", steps: [stepExec("FLOW-NAV", { outcome: "INFRASTRUCTURE_PROBLEM", category: "INFRASTRUCTURE", reason: "network timeout" })] })],
  });
  const baseFlowRun = baseRun({ report: r, findings: [], flowDiscovery: baseExec, coverage: buildCoverage({ report: r, flowDiscovery: baseExec, findings: [], verifications: [] }) });
  const infraFinding = finding({ id: "QA-F-CONF", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const infraFindingNow = finding({ id: "QA-F-INFRA", code: "button-missing-name", verification: ver({ disposition: "INFRASTRUCTURE_PROBLEM", status: "REVIEW", category: "INFRASTRUCTURE", reason: "runner timeout" }), evidence: [{ type: "element", index: 0 }] });
  const baseRunWithFinding = baseRun({ report: r, findings: [infraFinding], flowDiscovery: baseExec, coverage: buildCoverage({ report: r, flowDiscovery: baseExec, findings: [], verifications: [] }) });
  const currentRun = mkRun({ report: r, findings: [infraFindingNow], flowDiscovery: infraExec, coverage: buildCoverage({ report: r, flowDiscovery: infraExec, findings: [], verifications: [] }), generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(currentRun, baseRunWithFinding);
  assert.equal(count(result, "REGRESSION"), 0, "no regression from infra");
  assert.equal(count(result, "INFRASTRUCTURE_PROBLEM"), 1, "flow PASS→INFRA is classified as infrastructure problem");
  assert.equal(count(result, "REVIEW_REQUIRED"), 1, "finding CONFIRMED→INFRA records review, not regression");
});

test("F: locator-only changes are UNCHANGED, never CHANGED", () => {
  const btn = element({ accessibleName: "Search", text: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })" });
  const btn2 = element({ accessibleName: "Search", text: "Search", recommendedLocator: "page.locator(\"#search-submit\")" });
  const r1 = report({ elements: [btn] });
  const r2 = report({ elements: [btn2] });
  const flowSteps1 = [step({ action: "open", targetUrl: "https://qa.test/en/about", locator: "page.locator(\"a[href='/about']\")", expected: "the site's nav opens" })];
  const flowSteps2 = [step({ action: "open", targetUrl: "https://qa.test/en/about", locator: "page.getByRole(\"link\", { name: \"About\" })", expected: "the site's nav opens" })];
  const d1 = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:1", steps: flowSteps1, priority: "P2" })], executions: [] });
  const d2 = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:1", steps: flowSteps2, priority: "P2" })], executions: [] });

  const f1 = finding({ id: "QA-F-1", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const f2 = finding({ id: "QA-F-2", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });

  const baseline = baseRun({ report: r1, findings: [f1], flowDiscovery: d1 });
  const current = mkRun({ report: r2, findings: [f2], flowDiscovery: d2, generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(current, baseline);
  assert.equal(count(result, "CHANGED"), 0, "locator/selector change alone is not a change");
  assert.equal(count(result, "CHANGED_FLOW"), 0);
  assert.ok(count(result, "UNCHANGED") >= 1);
  assert.ok(count(result, "UNCHANGED_FLOW") >= 1);
});

test("G: ambiguous identity (same element family, changed text) is REVIEW_REQUIRED, not FIXED", () => {
  const baselineBtn = element({ accessibleName: "Log in", text: "Log in", href: "https://qa.test/en/login", tag: "a", role: "link" });
  const currentBtn = element({ accessibleName: "Login", text: "Login", href: "https://qa.test/en/login", tag: "a", role: "link", id: "lnk-42" });
  const r1 = report({ elements: [baselineBtn] });
  const r2 = report({ elements: [currentBtn] });
  const d = pageForFinding(baselineBtn, "FLOW-NAV");
  const d2 = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [exec({ flowId: "FLOW-NAV", status: "PASS" })] });

  const baseF = finding({ id: "QA-F-LOGIN", code: "empty-link", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const currentF = finding({ id: "QA-F-LOGIN2", code: "empty-link", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });

  const baseline = baseRun({ report: r1, findings: [baseF], flowDiscovery: d });
  const current = mkRun({ report: r2, findings: [currentF], flowDiscovery: d2, generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(current, baseline);
  const ambiguous = result.changes.filter(change => change.category === "FINDING" && change.classification === "REVIEW_REQUIRED");
  assert.ok(ambiguous.length >= 1, "same family + changed text must be flagged ambiguous");
  assert.ok(ambiguous.some(change => change.confidenceReason.toLowerCase().includes("ambiguous")));
  assert.equal(count(result, "FIXED"), 0, "ambiguous identity must never be claimed fixed");
});

test("H: a flow only in the current run is NEW_FLOW", () => {
  const r = report({ elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about" })] });
  const dBase = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [], executions: [] });
  const dNow = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [] });
  const baseline = baseRun({ report: r, flowDiscovery: dBase });
  const current = mkRun({ report: r, flowDiscovery: dNow, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.equal(count(result, "NEW_FLOW"), 1);
  assert.equal(result.changes.filter(change => change.classification === "NEW_FLOW")[0]?.currentReference, "FLOW-NAV");
});

test("I: a flow only in the baseline run is REMOVED_FLOW", () => {
  const r = report({ elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about" })] });
  const dBase = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [] });
  const dNow = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [], executions: [] });
  const baseline = baseRun({ report: r, flowDiscovery: dBase });
  const current = mkRun({ report: r, flowDiscovery: dNow, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.equal(count(result, "REMOVED_FLOW"), 1);
  assert.equal(result.changes.filter(change => change.classification === "REMOVED_FLOW")[0]?.baselineReference, "FLOW-NAV");
});

test("J: same category + start page with different step semantics is CHANGED_FLOW", () => {
  const r = report({ elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about" })] });
  const steps1 = [step({ action: "open", targetUrl: "https://qa.test/en", expected: "page loads" }), step({ action: "click-link", targetUrl: "https://qa.test/en/about", expected: "the about page opens" })];
  const steps2 = [step({ action: "open", targetUrl: "https://qa.test/en", expected: "page loads" }), step({ action: "click-link", targetUrl: "https://qa.test/en/about", expected: "the about page opens" }), step({ action: "observe", expected: "contact link visible" })];
  const dBase = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [flow({ flowId: "FLOW-A", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:about", steps: steps1 })], executions: [] });
  const dNow = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [flow({ flowId: "FLOW-B", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:about", steps: steps2 })], executions: [] });
  const baseline = baseRun({ report: r, flowDiscovery: dBase });
  const current = mkRun({ report: r, flowDiscovery: dNow, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  const changed = result.changes.filter(change => change.classification === "CHANGED_FLOW");
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.confidence, "HIGH_CONFIDENCE");
});

test("K: coverage gained (NOT_TESTED → TESTED) is CHANGED, never a regression", () => {
  const r = report({ elements: [element({ tag: "input", role: "searchbox", text: "", accessibleName: "Search", type: "search" })] });
  const flowId = "FLOW-SEARCH";
  const searchFlow = flow({ flowId, category: "SEARCH", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "search:page-1", priority: "P2" });
  const d = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [searchFlow], executions: [] });
  const covBase = covMap([covItem({ coverageId: "COV-SEARCH-001", name: "Search flow", status: "NOT_TESTED", url: "https://qa.test/en", pageId: "page-1", relatedFlows: [flowId] })], []);
  const covNow = covMap([covItem({ coverageId: "COV-SEARCH-001", name: "Search flow", status: "TESTED", executionStatus: "PASS", url: "https://qa.test/en", pageId: "page-1", relatedFlows: [flowId] })], []);
  const baseline = baseRun({ report: r, flowDiscovery: d, coverage: covBase });
  const current = mkRun({ report: r, flowDiscovery: d, coverage: covNow, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.equal(count(result, "REGRESSION"), 0);
  assert.ok(count(result, "CHANGED") >= 1, "coverage gained is CHANGED, not a regression");
  assert.equal(count(result, "COVERAGE_CHANGED"), 0, "no coverage lost in this fixture");
});

test("L: coverage lost (TESTED → NOT_TESTED) is COVERAGE_CHANGED", () => {
  const r = report({ elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about" }), element({ tag: "a", role: "link", text: "Contact", accessibleName: "Contact", href: "https://qa.test/en/contact" })] });
  const about = flow({ flowId: "FLOW-A", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:about", priority: "P2", steps: [step({ action: "open", targetUrl: "https://qa.test/en/about", expected: "page loads" })] });
  const contact = flow({ flowId: "FLOW-C", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:contact", priority: "P2", steps: [step({ action: "open", targetUrl: "https://qa.test/en/contact", expected: "page loads" })] });
  const dBase = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [about, contact], executions: [exec({ flowId: "FLOW-A", status: "PASS" }), exec({ flowId: "FLOW-C", status: "PASS" })] });
  const dNow = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [about], executions: [exec({ flowId: "FLOW-A", status: "PASS" })] });
  const baseline = baseRun({ report: r, flowDiscovery: dBase, coverage: buildCoverage({ report: r, flowDiscovery: dBase, findings: [], verifications: [] }) });
  const current = mkRun({ report: r, flowDiscovery: dNow, coverage: buildCoverage({ report: r, flowDiscovery: dNow, findings: [], verifications: [] }), generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.equal(count(result, "COVERAGE_CHANGED"), 1, "the tested contact coverage item is the coverage loss");
  assert.equal(count(result, "REMOVED_FLOW"), 1, "the contact flow is removed from discovery");
  assert.equal(count(result, "REGRESSION"), 0);
});

test("M: recommendation comparison — priority change, new rec, and dropped rec", () => {
  const itemBoth = covItem({ coverageId: "COV-FLOW-001", name: "Search flow", status: "TESTED", url: "https://qa.test/en" });
  const itemCurrent = covItem({ coverageId: "COV-PAGE-001", name: "Landing page", status: "NOT_TESTED", url: "https://qa.test/en" });

  const rec1Base = rec({ recommendationId: "REC-1", type: "TEST_SEARCH_FLOW", title: "Exercise search flow", priority: "P1", coverageIds: ["COV-FLOW-001"] });
  const rec1Now = rec({ recommendationId: "REC-1", type: "TEST_SEARCH_FLOW", title: "Exercise search flow", priority: "P2", coverageIds: ["COV-FLOW-001"] });
  const recDropped = rec({ recommendationId: "REC-DROPPED", type: "TEST_PAGE", title: "Test the landing page", priority: "P2", coverageIds: ["COV-PAGE-001"] });
  const recNew = rec({ recommendationId: "REC-NEW", type: "REVIEW_PAGE", title: "Review the landing page", priority: "P3", coverageIds: ["COV-PAGE-001"] });

  const r = report({ elements: [] });
  const D = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [] });
  const baseline = baseRun({
    report: r,
    flowDiscovery: D,
    coverage: covMap([itemBoth, covItem({ coverageId: "COV-PAGE-001", name: "Landing page", status: "NOT_TESTED", url: "https://qa.test/en" })], [rec1Base, recDropped]),
  });
  const current = mkRun({ report: r, flowDiscovery: D, coverage: covMap([itemBoth, itemCurrent], [rec1Now, recNew]), generatedAt: "2026-01-02T00:00:00.000Z" });

  const result = compareRuns(current, baseline);
  const priorityChange = result.changes.find(change => change.category === "RECOMMENDATION" && change.classification === "CHANGED");
  assert.ok(priorityChange, "priority change is CHANGED");
  assert.ok(priorityChange!.summary.includes("P1") && priorityChange!.summary.includes("P2"));
  assert.ok(result.changes.some(change => change.category === "RECOMMENDATION" && change.classification === "NEW" && change.currentReference === "REC-NEW"));
  const dropped = result.changes.find(change => change.category === "RECOMMENDATION" && change.baselineReference === "REC-DROPPED");
  assert.equal(dropped?.classification, "REVIEW_REQUIRED", "a dropped recommendation with an unresolved target is never assumed fixed");
});

test("N: low-confidence comparisons carry explicit reasons, never fake percentages", () => {
  const r = report({ elements: [element({ accessibleName: "Search", text: "Search" })] });
  const dBase = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [] });
  const dNow = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [] });
  const baseF = finding({ id: "QA-F-U", code: "button-missing-name", verification: null, evidence: [{ type: "element", index: 0 }] });
  const nowF = finding({ id: "QA-F-C", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const baseline = baseRun({ report: r, findings: [baseF], flowDiscovery: dBase });
  const current = mkRun({ report: r, findings: [nowF], flowDiscovery: dNow, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  const lowFinding = result.changes.find(change => change.category === "FINDING" && change.confidence === "LOW_CONFIDENCE");
  assert.ok(lowFinding, "unverified → confirmed is a potential regression with LOW_CONFIDENCE");
  assert.ok(!lowFinding!.confidenceReason.includes("%"), "confidence is an explicit reason, never a percentage");
});

test("O: insufficient evidence never becomes a regression", () => {
  const r = report({ elements: [element({ accessibleName: "Sync", text: "Sync" })] });
  const flowId = "FLOW-NAV";
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })],
    flows: [navFlowSpec(flowId)],
    executions: [exec({ flowId, status: "INFRASTRUCTURE_PROBLEM", failureCategory: "INFRASTRUCTURE", steps: [] })],
  });
  const f = finding({ id: "QA-F-U", code: "button-missing-name", verification: null, evidence: [{ type: "element", index: 0 }] });
  const baseline = baseRun({ report: r, findings: [f], flowDiscovery: d });
  const current = mkRun({ report: r, findings: [f], flowDiscovery: d, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.equal(count(result, "REGRESSION"), 0);
  assert.ok(count(result, "INSUFFICIENT_EVIDENCE" as ChangeClassification) >= 0);
  assert.ok(result.changes.some(change => change.confidence === "INSUFFICIENT_EVIDENCE"), "infra-to-infra is INSUFFICIENT_EVIDENCE, never a regression");
});

test("P: multiple occurrences pair by semantic target — the surviving one is UNCHANGED, the lost one FIXED", () => {
  const btnA = element({ accessibleName: "Subscribe A", text: "Subscribe A" });
  const btnB = element({ accessibleName: "Subscribe B", text: "Subscribe B" });
  const rBase = report({ elements: [btnA, btnB] });
  const rNow = report({ elements: [btnA] });
  const d = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [navFlowSpec("FLOW-NAV")], executions: [exec({ flowId: "FLOW-NAV", status: "PASS" })] });
  const fA = finding({ id: "QA-F-A", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const fB = finding({ id: "QA-F-B", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 1 }] });
  const fANow = finding({ id: "QA-F-A", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const baseline = baseRun({ report: rBase, findings: [fA, fB], flowDiscovery: d });
  const current = mkRun({ report: rNow, findings: [fANow], flowDiscovery: d, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  const unchanged = result.changes.filter(change => change.category === "FINDING" && change.classification === "UNCHANGED");
  const fixed = result.changes.filter(change => change.category === "FINDING" && change.classification === "FIXED");
  assert.equal(unchanged.length, 1, "the occurrence that survived is matched to its baseline twin");
  assert.equal(unchanged[0]!.currentReference, "QA-F-A");
  assert.equal(unchanged[0]!.baselineReference, "QA-F-A");
  assert.equal(fixed.length, 1, "the occurrence that vanished (verified) is FIXED");
  assert.equal(fixed[0]!.baselineReference, "QA-F-B");
});

test("Q: regenerated ids never change identity — findings/flows/coverage stay UNCHANGED", () => {
  const btn = element({ accessibleName: "Submit", text: "Submit" });
  const r = report({ elements: [btn] });
  const flowId = "FLOW-NAV";
  const D = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [flow({ flowId, category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:1" })], executions: [] });
  const cov1 = covMap([covItem({ coverageId: "COV-FLOW-001", name: "Signup flow", status: "NOT_TESTED", url: "https://qa.test/en" })], []);
  const cov2 = covMap([covItem({ coverageId: "COV-FLOW-042", name: "Signup flow", status: "NOT_TESTED", url: "https://qa.test/en" })], []);
  const baseF = finding({ id: "QA-F-001", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const nowF = finding({ id: "QA-F-099", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const baseline = baseRun({ report: r, findings: [baseF], flowDiscovery: D, coverage: cov1 });
  const current = mkRun({ report: r, findings: [nowF], flowDiscovery: D, coverage: cov2, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.equal(count(result, "UNCHANGED"), 2, "finding and coverage item pair despite regenerated ids");
  assert.equal(count(result, "NEW"), 0);
  assert.equal(count(result, "FIXED"), 0);
  assert.equal(count(result, "CHANGED"), 0);
  assert.equal(count(result, "UNCHANGED_FLOW"), 1);
});

test("AI regression notes are bounded: unknown change ids are dropped and classifications are never touched", () => {
  const r = report({ elements: [element({ accessibleName: "Go", text: "Go" })] });
  const f = finding({ id: "QA-F-C", code: "button-missing-name", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const UTF = { ...f } as QaFinding;
  const d = pageForFinding(element({ accessibleName: "Go", text: "Go" }), "FLOW-NAV");
  const baseline = baseRun({ report: r, findings: [f], flowDiscovery: d });
  const current = mkRun({ report: r, findings: [f], flowDiscovery: d, generatedAt: "2026-01-02T00:00:00.000Z" });
  const result = compareRuns(current, baseline);
  assert.ok(result.changes.length > 0);
  const firstId = result.changes[0]!.changeId;
  const enhanced = applyRegressionNotes(result, {
    headline: "Human rewrite of the deterministic headline.",
    notes: [{ changeId: firstId, note: "Look at this first." }, { changeId: "RG-9999", note: "must be dropped" }],
  }, "fixture-ai");
  assert.equal(enhanced.aiNotes?.provider, "fixture-ai");
  assert.equal(enhanced.aiNotes?.notes?.length, 1, "unknown change ids are dropped");
  const before = result.changes.map(change => `${change.changeId}:${change.classification}`).join(",");
  const after = enhanced.changes.map(change => `${change.changeId}:${change.classification}`).join(",");
  assert.equal(before, after, "classifications are never altered by the AI layer");
});

// ---------------------------------------------------------------------------
// E2E: two real runs against a choiceful fixture site — scan → analyze →
// execute flows → coverage → compare — then compare and render the report.
// ---------------------------------------------------------------------------
test("E2E: RUN1→RUN2 generic end-to-end regression comparison (search removed, nav link removed)", async () => {
  let secondRun = false;
  const server = createServer((request, response) => {
    const send = (body: string, status = 200) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    const head = (title: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>`;
    const url = request.url ?? "/";
    if (url === "/") {
      if (secondRun) {
        return send(`${head("Generic Home")}<form action="/login"><input type="text" name="username"><input type="password" name="password"><button type="submit">Sign in</button></form></body></html>`);
      }
      return send(`${head("Generic Home")}<form action="/search"><input type="search" placeholder="Search" name="q"><button type="submit">Search</button></form><a href="/about">About</a><form action="/login"><input type="text" name="username"><input type="password" name="password"><button type="submit">Sign in</button></form></body></html>`);
    }
    if (url === "/search") return send(`${head("Results")}<p>Some results for your query.</p></body></html>`);
    if (url === "/about") return send(`${head("About")}<p>About this site.</p></body></html>`);
    if (url.startsWith("/login")) return send(`${head("Sign in")}<form action="/login"><input type="text" name="username"><input type="password" name="password"><button type="submit">Sign in</button></form></body></html>`);
    return send(`<html><body>not found</body></html>`, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-reg-"));

  const executeFlows = async (analysis: QaAnalysis) => {
    const flowDiscovery = analysis.flowDiscovery!;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const executions = [];
      for (const flowEntry of flowDiscovery.flows) {
        if (!flowEntry.executable) continue;
        const result = flowEntry.flowId.includes("AUTH") || flowEntry.category === "AUTHENTICATION"
          ? await runFlow(page, flowEntry, { startTimeoutMs: 15000, elementTimeoutMs: 8000 })
          : await runFlow(page, flowEntry, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
        executions.push(result);
      }
      const executed = { ...flowDiscovery, executions, summary: summaryFor({ ...flowDiscovery, executions }) };
      const coverage = buildCoverage({ report: analysis.scan, flowDiscovery: executed, findings: analysis.findings, verifications: [] });
      return { ...analysis, flowDiscovery: executed, coverage, summary: { ...analysis.summary, coverageSummary: coverage.summary } };
    } finally {
      await browser.close();
    }
  };

  try {
    const scan1 = await scanWebsite({ url: base, headed: false, timeout: 15000, outputPath: join(folder, "report1.json"), concurrency: 1 });
    const run1 = await executeFlows(await analyzeScan(scan1.report, { flowLimits: limits({ maxPages: 4, maxFlows: 10 }) }));

    secondRun = true;
    const scan2 = await scanWebsite({ url: base, headed: false, timeout: 15000, outputPath: join(folder, "report2.json"), concurrency: 1 });
    const run2 = await executeFlows(await analyzeScan(scan2.report, { flowLimits: limits({ maxPages: 4, maxFlows: 10 }) }));

    assert.ok(run1.flowDiscovery!.executions.some(e => e.status === "PASS"), "run1 has successful executions");
    assert.ok(run2.flowDiscovery!.executions.length > 0, "run2 still executed the auth flow");

    const result = compareRuns(run2, run1, { baselinePath: join(folder, "run1.json") });
    assert.equal(result.summary.comparable, true, "same origin and same execution/crawl layers");
    assert.equal(result.baselinePath, join(folder, "run1.json"));

    assert.equal(count(result, "REGRESSION"), 0, "no infra is ever a regression in the e2e run");
    assert.ok(count(result, "REMOVED_FLOW") >= 1, "the search flow no longer exists in run2");
    assert.ok(count(result, "COVERAGE_CHANGED") >= 1, "search + navigation coverage is lost in run2");
    assert.ok(count(result, "UNCHANGED_FLOW") >= 1, "the auth flow stays blocked in both runs");

    const html = renderQaHtml({ ...run2, regression: result });
    assert.ok(html.includes("Regression Summary"), "HTML report renders the regression summary section");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});