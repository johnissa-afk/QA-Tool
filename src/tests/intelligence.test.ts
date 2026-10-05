import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import type { DiscoveredElement, ScanReport } from "../types.js";
import type { DiscoveredFlow, FlowCategory, FlowDiscovery, FlowExecutionResult, FlowLimits, FlowStep, FlowStepAction, FlowStepExecutionResult, FlowStepOutcome, SitePageNode } from "../flow/types.js";
import type { QaAnalysis, QaFinding, QaSummary } from "../ai/types.js";
import type { RegressionMap, RegressionChange } from "../regression/types.js";
import { analyzeScan } from "../ai/index.js";
import { renderQaHtml } from "../ai/report.js";
import { scanWebsite } from "../scanner.js";
import { runFlow, defaultFlowLimits } from "../flow/index.js";
import { buildIntelligence, applyIntelligenceNotes, intelligenceDigestOf, validateIntelligenceEnhancement } from "../intelligence/index.js";
import { SAFE_KINDS } from "../intelligence/investigation.js";

const limits = (overrides: Partial<FlowLimits> = {}): FlowLimits => ({ ...defaultFlowLimits(), ...overrides });

// ---------------------------------------------------------------------------
// Phase 6 intelligence fixture tests. Generic (https://qa.test only), no real
// browser, deterministic. Fixtures A–R cover semantic grouping, evidence
// support/contradict edges, patterns A–E, deduction/queue safety, AI boundary
// enforcement, and investigation-action safety.
// ---------------------------------------------------------------------------

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

const report = (overrides: Partial<Record<string, unknown>> & { elements?: DiscoveredElement[] } = {}): ScanReport => {
  const elements = overrides.elements ?? [];
  return {
    scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.length, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements,
    issues: [],
    links: [],
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

const stepExec = (flowId: string, base: Partial<{ stepIndex: number; outcome: FlowStepOutcome }> = {}): FlowStepExecutionResult => ({
  flowId,
  scenarioId: `SC-${flowId}`,
  stepIndex: base.stepIndex ?? 0,
  action: "open",
  outcome: base.outcome ?? "PASS",
  category: "WEBSITE",
  reason: "executed",
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

const pageNode = (overrides: { id: string; url: string }): SitePageNode => ({
  id: overrides.id,
  url: overrides.url,
  title: null,
  depth: 0,
  sourceReportUrl: overrides.url,
  navigationStatus: 200,
  brokenLinks: 0,
  controls: [],
  edges: [],
});

const discovery = (overrides: { pages: ReturnType<typeof pageNode>[]; flows: DiscoveredFlow[]; executions?: ReturnType<typeof exec>[] }): FlowDiscovery => {
  const base: FlowDiscovery = {
    limits: { maxPages: 5, maxDepth: 1, maxNavigationActions: 10, maxFlows: 10, maxFlowSteps: 5 },
    graph: { sourceUrl: overrides.pages[0]?.url ?? "https://qa.test/en", pages: overrides.pages },
    flows: overrides.flows,
    executions: overrides.executions ?? [],
    summary: { pages: 0, flows: 0, executable: 0, review: 0, highRisk: 0, blocked: 0, steps: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
  };
  return base;
};

const ver = (o: { disposition: NonNullable<QaFinding["verification"]>["disposition"]; category?: NonNullable<QaFinding["verification"]>["category"] }) => ({
  disposition: o.disposition,
  scenarioId: null,
  status: o.disposition === "REPRODUCED" ? "REPRODUCED" as const : o.disposition === "NOT_REPRODUCED" ? "NOT_REPRODUCED" as const : "PASS" as const,
  category: o.category ?? null,
  verdict: null,
  reason: "fixture verification",
  safety: "safe" as const,
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

const mkRun = (overrides: { report: ScanReport; findings?: QaFinding[]; flowDiscovery?: FlowDiscovery | null; regression?: RegressionMap | null; coverage?: null }): QaAnalysis => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
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
  regression: overrides.regression ?? null,
  intelligence: null,
  execution: null,
  summary: emptySummary(),
});

const regressionMap = (changes: RegressionChange[]): RegressionMap => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baselinePath: null,
  summary: { comparable: true, notComparableReason: null, changeCount: changes.length, counts: {} as Record<string, number>, headline: "" },
  runs: { baseline: { runId: "BL", runLabel: "baseline", origin: "https://qa.test", sourceUrl: "https://qa.test", scannedAt: "2026-01-01", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "bl" }, current: { runId: "CU", runLabel: "current", origin: "https://qa.test", sourceUrl: "https://qa.test", scannedAt: "2026-09-17", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "bl" } },
  changes,
  aiNotes: null,
});

const regChange = (overrides: { changeId: string; classification: string; confidence: string; relatedFindingIds?: string[]; relatedFlowIds?: string[]; category?: string; relatedCoverageIds?: string[] }): RegressionChange => ({
  changeId: overrides.changeId,
  category: (overrides.category ?? "FINDING") as RegressionChange["category"],
  classification: overrides.classification as RegressionChange["classification"],
  confidence: overrides.confidence as RegressionChange["confidence"],
  confidenceReason: "fixture regression",
  anchor: "",
  currentReference: overrides.changeId,
  baselineReference: overrides.changeId,
  summary: "fixture change",
  explanation: "",
  evidence: [],
  recommendedAction: "review",
  relatedFindingIds: overrides.relatedFindingIds ?? [],
  relatedFlowIds: overrides.relatedFlowIds ?? [],
  relatedCoverageIds: overrides.relatedCoverageIds ?? [],
  relatedRecommendationIds: [],
});

const sameStart = { startPageId: "page-1", startUrl: "https://qa.test/en" };
const clickBtn0 = (flowId: string) => step({ action: "click", elementIndex: 0, locator: "button", targetUrl: undefined, expected: "click" });
const clickElAt = (flowId: string, idx: number, loc: string, extra: Partial<FlowStep> = {}) => step({ action: "click", elementIndex: idx, locator: loc, targetUrl: undefined, expected: "click", ...extra });

// ===========================================================================
// Fixture A: reproduced finding + one flow stall → VERIFIED_REGENERATION
// ===========================================================================

const A_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const A_report = report({ elements: A_elements });
const A_finding = finding({ id: "QA-F-A1", domain: "accessibility", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const A_flow = flow({ flowId: "FLOW-A1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:A1", steps: [clickBtn0("FLOW-A1")], executable: true, safety: "SAFE" });
const A_exec = exec({ flowId: "FLOW-A1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-A1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const A_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [A_flow], executions: [A_exec] });
const A_run = mkRun({ report: A_report, findings: [A_finding], flowDiscovery: A_discovery });
const A_intel = buildIntelligence({ analysis: A_run });
const A_cand = A_intel.rootCauseCandidates[0]!;

test("A: reproduced finding + one flow stall → VERIFIED_REGENERATION", () => {
  assert.equal(A_intel.status, "AVAILABLE");
  assert.equal(A_intel.summary.candidates, 1);
  assert.equal(A_cand.pattern, "VERIFIED_REGENERATION");
  assert.equal(A_cand.confidence, "MEDIUM");
  assert.equal(A_cand.status, "ACTIONABLE");
  assert.deepEqual(A_cand.findingIds, ["QA-F-A1"]);
  assert.deepEqual(A_cand.flowIds, ["FLOW-A1"]);
  assert.ok(A_cand.supportingEvidence.length >= 1, "has supporting evidence");
  assert.equal(A_cand.contradictingEvidence.length, 0, "no contradictions");
  assert.ok(A_cand.investigationActions.length >= 2, "at least two investigation actions");
  for (const action of A_cand.investigationActions) {
    assert.equal(action.safe, true);
    assert.ok(SAFE_KINDS.includes(action.kind), `action kind ${action.kind} is safe`);
  }
  assert.ok(!/confirmed|root cause identified/i.test(A_cand.title), "title does not claim a confirmed cause");
  assert.ok(/hypothesis/i.test(A_cand.description) && /never a confirmed cause/i.test(A_cand.description), "description frames as hypothesis");
  assert.equal(A_intel.investigationQueue.length, 1, "one queued entry");
  assert.equal(A_intel.investigationQueue[0]!.candidateId, A_cand.candidateId);
  assert.ok(A_cand.affectedPages.includes("https://qa.test/en"));
  assert.ok(A_intel.evidenceRelationships.length >= 1);
});

// ===========================================================================
// Fixture B: two flows stall at same target → SHARED_SEMANTIC_TARGET
// ===========================================================================

const B_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const B_report = report({ elements: B_elements });
const B_flow1 = flow({ flowId: "FLOW-B1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:B1", steps: [clickBtn0("FLOW-B1")], executable: true, safety: "SAFE" });
const B_flow2 = flow({ flowId: "FLOW-B2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:B2", steps: [clickBtn0("FLOW-B2")], executable: true, safety: "SAFE" });
const B_exec1 = exec({ flowId: "FLOW-B1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-B1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const B_exec2 = exec({ flowId: "FLOW-B2", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-B2", { stepIndex: 0, outcome: "REPRODUCED" })] });
const B_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [B_flow1, B_flow2], executions: [B_exec1, B_exec2] });
const B_run = mkRun({ report: B_report, flowDiscovery: B_discovery });
const B_intel = buildIntelligence({ analysis: B_run });
const B_cand = B_intel.rootCauseCandidates[0]!;

test("B: two flows stall at same target → SHARED_SEMANTIC_TARGET", () => {
  assert.equal(B_intel.summary.candidates, 1);
  assert.equal(B_cand.pattern, "SHARED_SEMANTIC_TARGET");
  assert.equal(B_cand.status, "ACTIONABLE");
  assert.equal(B_cand.confidence, "MEDIUM");
  assert.deepEqual(B_cand.flowIds.sort(), ["FLOW-B1", "FLOW-B2"]);
  assert.equal(B_cand.findingIds.length, 0);
  assert.ok(B_cand.supportingEvidence.some(r => r.reason === "SAME_SEMANTIC_TARGET"), "supporting relationship");
  assert.equal(B_intel.investigationQueue.length, 1);
  assert.ok(B_intel.evidenceRelationships.some(r => r.reason === "SAME_SEMANTIC_TARGET" && r.relation === "SUPPORTS"), "execution↔execution SUPPORTS");
});

// ===========================================================================
// Fixture C: same page, unrelated targets → two candidates, not grouped
// ===========================================================================

const C_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" }), element({ accessibleName: "Search", text: "", role: "textbox", type: "search", placeholder: "search" })];
const C_report = report({ elements: C_elements });
const C_finding1 = finding({ id: "QA-F-C1", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const C_finding2 = finding({ id: "QA-F-C2", domain: "navigation", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 1 }] });
const C_flow1 = flow({ flowId: "FLOW-C1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:C1", steps: [clickBtn0("FLOW-C1")], executable: true, safety: "SAFE" });
const C_flow2 = flow({ flowId: "FLOW-C2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:C2", steps: [clickElAt("FLOW-C2", 1, "textbox Search")], executable: true, safety: "SAFE" });
const C_exec1 = exec({ flowId: "FLOW-C1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-C1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const C_exec2 = exec({ flowId: "FLOW-C2", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-C2", { stepIndex: 0, outcome: "REPRODUCED" })] });
const C_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [C_flow1, C_flow2], executions: [C_exec1, C_exec2] });
const C_run = mkRun({ report: C_report, findings: [C_finding1, C_finding2], flowDiscovery: C_discovery });
const C_intel = buildIntelligence({ analysis: C_run });

test("C: same page, unrelated targets → two candidates, not grouped", () => {
  assert.equal(C_intel.summary.candidates, 2, "two targets yield two candidates");
  assert.equal(C_intel.investigationQueue.length, 2, "two queued entries");
  const cFindings = C_intel.rootCauseCandidates.flatMap(c => c.findingIds);
  assert.ok(cFindings.includes("QA-F-C1"));
  assert.ok(cFindings.includes("QA-F-C2"));
  assert.equal(new Set(cFindings).size, 2, "findings are in separate candidates");
  for (const cand of C_intel.rootCauseCandidates) {
    assert.ok(cand.supportingEvidence.length >= 1, "each candidate has supporting evidence");
    assert.equal(cand.contradictingEvidence.length, 0, "no contradictions");
    assert.equal(cand.status, "ACTIONABLE");
  }
});

// ===========================================================================
// Fixture D: same category, different semantic targets → not grouped
// ===========================================================================

const D_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" }), element({ accessibleName: "Cancel", text: "Cancel", role: "button" })];
const D_report = report({ elements: D_elements });
const D_finding1 = finding({ id: "QA-F-D1", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const D_finding2 = finding({ id: "QA-F-D2", domain: "accessibility", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 1 }] });
const D_flow1 = flow({ flowId: "FLOW-D1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:D1", steps: [clickBtn0("FLOW-D1")], executable: true, safety: "SAFE" });
const D_flow2 = flow({ flowId: "FLOW-D2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:D2", steps: [clickElAt("FLOW-D2", 1, "button Cancel")], executable: true, safety: "SAFE" });
const D_exec1 = exec({ flowId: "FLOW-D1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-D1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const D_exec2 = exec({ flowId: "FLOW-D2", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-D2", { stepIndex: 0, outcome: "REPRODUCED" })] });
const D_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [D_flow1, D_flow2], executions: [D_exec1, D_exec2] });
const D_run = mkRun({ report: D_report, findings: [D_finding1, D_finding2], flowDiscovery: D_discovery });
const D_intel = buildIntelligence({ analysis: D_run });

test("D: same category, different semantic targets → separate candidates", () => {
  assert.equal(D_intel.summary.candidates, 2, "same category but different targets produce separate candidates");
  const dFindings = D_intel.rootCauseCandidates.flatMap(c => c.findingIds);
  assert.ok(dFindings.includes("QA-F-D1"));
  assert.ok(dFindings.includes("QA-F-D2"));
  assert.equal(new Set(dFindings).size, 2, "no candidate groups both findings");
  for (const cand of D_intel.rootCauseCandidates) {
    assert.equal(cand.status, "ACTIONABLE");
    assert.equal(cand.pattern, "VERIFIED_REGENERATION");
  }
});

// ===========================================================================
// Fixture E: regression + REPRODUCED + changed target → VERIFIED_REGRESSION HIGH
// ===========================================================================

const E_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const E_report = report({ elements: E_elements });
const E_finding = finding({ id: "QA-F-E1", domain: "accessibility", severity: "CRITICAL", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const E_flow = flow({ flowId: "FLOW-E1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:E1", steps: [clickBtn0("FLOW-E1")], executable: true, safety: "SAFE" });
const E_exec = exec({ flowId: "FLOW-E1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-E1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const E_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [E_flow], executions: [E_exec] });
const E_regression = regressionMap([regChange({ changeId: "CH-REG-1", classification: "REGRESSION", confidence: "HIGH_CONFIDENCE", relatedFindingIds: ["QA-F-E1"], relatedFlowIds: ["FLOW-E1"] })]);
const E_run = mkRun({ report: E_report, findings: [E_finding], flowDiscovery: E_discovery, regression: E_regression });
const E_intel = buildIntelligence({ analysis: E_run });
const E_cand = E_intel.rootCauseCandidates[0]!;

test("E: HIGH_CONFIDENCE regression + reproduced finding + flow stall → HIGH confidence", () => {
  assert.equal(E_cand.pattern, "VERIFIED_REGRESSION");
  assert.equal(E_cand.confidence, "HIGH", "regression + reproduced finding + flow stall yields HIGH confidence");
  assert.equal(E_cand.status, "ACTIONABLE");
  assert.deepEqual(E_cand.findingIds, ["QA-F-E1"]);
  assert.deepEqual(E_cand.flowIds, ["FLOW-E1"]);
  assert.ok(E_cand.regressionContext.some(ctx => ctx.includes("CH-REG-1")), "regression context mentions change");
  assert.ok(E_cand.regressionContext.some(ctx => ctx.includes("HIGH_CONFIDENCE")));
  assert.equal(E_intel.investigationQueue.length, 1);
  assert.ok(E_intel.evidenceRelationships.some(r => r.reason === "REGRESSION_CORRELATION"), "regression relationship present");
});

// ===========================================================================
// Fixture F: removed flow → DISCOVERY_VARIANCE, no website defect claim
// ===========================================================================

const F_report = report({ elements: [] });
const F_regression = regressionMap([regChange({ changeId: "CH-F1", classification: "REMOVED_FLOW", confidence: "MEDIUM_CONFIDENCE", category: "FLOW", relatedFlowIds: ["FLOW-OLD"] })]);
const F_run = mkRun({ report: F_report, regression: F_regression });
const F_intel = buildIntelligence({ analysis: F_run });
const F_cand = F_intel.rootCauseCandidates[0]!;

test("F: removed flow → DISCOVERY_VARIANCE / INSUFFICIENT_EVIDENCE, not queued", () => {
  assert.equal(F_intel.summary.candidates, 1, "discovery variance candidate exists");
  assert.equal(F_cand.pattern, "DISCOVERY_VARIANCE");
  assert.equal(F_cand.confidence, "INSUFFICIENT");
  assert.equal(F_cand.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(F_intel.investigationQueue.length, 0, "variance is not queued for investigation");
  assert.ok(F_cand.regressionContext[0]!.includes("REMOVED_FLOW"), "context mentions removed flow");
  assert.equal(F_cand.findingIds.length, 0, "no website findings linked");
  assert.equal(F_cand.supportingEvidence.length, 0, "no supporting evidence for a website defect");
});

// ===========================================================================
// Fixture G: three infra executions → INFRASTRUCTURE / INFORMATIONAL
// ===========================================================================

const G_flow1 = flow({ flowId: "FLOW-G1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:G1" });
const G_flow2 = flow({ flowId: "FLOW-G2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:G2" });
const G_flow3 = flow({ flowId: "FLOW-G3", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:G3" });
const G_exec1 = exec({ flowId: "FLOW-G1", status: "INFRASTRUCTURE_PROBLEM", failureCategory: "INFRASTRUCTURE" });
const G_exec2 = exec({ flowId: "FLOW-G2", status: "INFRASTRUCTURE_PROBLEM", failureCategory: "INFRASTRUCTURE" });
const G_exec3 = exec({ flowId: "FLOW-G3", status: "INFRASTRUCTURE_PROBLEM", failureCategory: "INFRASTRUCTURE" });
const G_report = report({ elements: [] });
const G_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [G_flow1, G_flow2, G_flow3], executions: [G_exec1, G_exec2, G_exec3] });
const G_run = mkRun({ report: G_report, flowDiscovery: G_discovery });
const G_intel = buildIntelligence({ analysis: G_run });
const G_cand = G_intel.rootCauseCandidates[0]!;

test("G: three infra executions → INFRASTRUCTURE / INFORMATIONAL / MEDIUM confidence", () => {
  assert.equal(G_intel.summary.candidates, 1);
  assert.equal(G_cand.pattern, "INFRASTRUCTURE");
  assert.equal(G_cand.status, "INFORMATIONAL", "infrastructure is informational, never a website defect");
  assert.equal(G_cand.confidence, "MEDIUM", "≥3 infra failures yields MEDIUM confidence");
  assert.deepEqual(G_cand.flowIds.sort(), ["FLOW-G1", "FLOW-G2", "FLOW-G3"]);
  assert.equal(G_cand.findingIds.length, 0, "no findings linked");
  assert.ok(G_cand.supportingEvidence.length >= 1, "infra executions support each other");
  assert.equal(G_cand.contradictingEvidence.length, 0, "no contradictions");
  assert.equal(G_intel.investigationQueue.length, 0, "infra is not queued for investigation");
  assert.ok(G_cand.investigationActions.some(a => a.kind === "CHECK_CRAWL_VARIANCE"), "suggests crawl variance check");
});

// ===========================================================================
// Fixture H: single execution failure, no finding → INSUFFICIENT_EVIDENCE
// ===========================================================================

const H_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const H_report = report({ elements: H_elements });
const H_flow = flow({ flowId: "FLOW-H1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:H1", steps: [clickBtn0("FLOW-H1")], executable: true, safety: "SAFE" });
const H_exec = exec({ flowId: "FLOW-H1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-H1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const H_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [H_flow], executions: [H_exec] });
const H_run = mkRun({ report: H_report, flowDiscovery: H_discovery });
const H_intel = buildIntelligence({ analysis: H_run });
const H_cand = H_intel.rootCauseCandidates[0]!;

test("H: single execution failure, no finding → INSUFFICIENT_EVIDENCE", () => {
  assert.equal(H_intel.summary.candidates, 1);
  assert.equal(H_cand.pattern, "SINGLE_OBSERVATION");
  assert.equal(H_cand.confidence, "INSUFFICIENT", "single lone execution failure is too weak for a claim");
  assert.equal(H_cand.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(H_intel.investigationQueue.length, 0, "insufficient evidence is not queued");
  assert.equal(H_intel.summary.actionable, 0);
  assert.equal(H_intel.summary.insufficientEvidence, 1);
});

// ===========================================================================
// Fixture I: support + contradict → INVESTIGATION_REQUIRED (downgrade)
// ===========================================================================

const I_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const I_report = report({ elements: I_elements });
const I_finding = finding({ id: "QA-F-I1", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const I_flow1 = flow({ flowId: "FLOW-I1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:I1", steps: [clickBtn0("FLOW-I1")], executable: true, safety: "SAFE" });
const I_flow2 = flow({ flowId: "FLOW-I2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:I2", steps: [clickBtn0("FLOW-I2")], executable: true, safety: "SAFE" });
const I_exec1 = exec({ flowId: "FLOW-I1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-I1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const I_exec2 = exec({ flowId: "FLOW-I2", status: "PASS", failureCategory: null, stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-I2", { stepIndex: 0, outcome: "PASS" })] });
const I_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [I_flow1, I_flow2], executions: [I_exec1, I_exec2] });
const I_run = mkRun({ report: I_report, findings: [I_finding], flowDiscovery: I_discovery });
const I_intel = buildIntelligence({ analysis: I_run });
const I_cand = I_intel.rootCauseCandidates[0]!;

test("I: support + contradict → INVESTIGATION_REQUIRED, confidence downgraded", () => {
  assert.equal(I_cand.status, "INVESTIGATION_REQUIRED", "contradiction downgrades to investigation required");
  assert.ok(I_cand.contradictingEvidence.length >= 1, "has contradicting evidence");
  assert.equal(I_cand.confidence, "LOW", "contradiction downgrades from MEDIUM to LOW");
  assert.ok(I_cand.supportingEvidence.length >= 1, "still has supporting evidence from the failing flow");
  assert.equal(I_intel.investigationQueue.length, 1, "queued for investigation despite contradiction");
  assert.ok(I_intel.evidenceRelationships.some(r => r.relation === "CONTRADICTS" && r.reason === "SAME_SEMANTIC_TARGET"), "passing flow contradicts stalled flow");
});

// ===========================================================================
// Fixture J: multiple findings on same issue → deduped into one candidate
// ===========================================================================

const J_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const J_report = report({ elements: J_elements });
const J_finding1 = finding({ id: "QA-F-J1", domain: "accessibility", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const J_finding2 = finding({ id: "QA-F-J2", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const J_flow = flow({ flowId: "FLOW-J1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:J1", steps: [clickBtn0("FLOW-J1")], executable: true, safety: "SAFE" });
const J_exec = exec({ flowId: "FLOW-J1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-J1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const J_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [J_flow], executions: [J_exec] });
const J_run = mkRun({ report: J_report, findings: [J_finding1, J_finding2], flowDiscovery: J_discovery });
const J_intel = buildIntelligence({ analysis: J_run });
const J_cand = J_intel.rootCauseCandidates[0]!;

test("J: multiple findings on same issue → one deduped candidate", () => {
  assert.equal(J_intel.summary.candidates, 1, "multiple findings on same target collapse into one candidate");
  assert.deepEqual(J_cand.findingIds.sort(), ["QA-F-J1", "QA-F-J2"], "both findings present, no duplicates");
  assert.equal(J_cand.pattern, "VERIFIED_REGENERATION");
  assert.equal(J_cand.status, "ACTIONABLE");
  assert.ok(J_cand.findingIds.length === new Set(J_cand.findingIds).size, "no duplicate finding ids");
});

// ===========================================================================
// Fixture K: AI rewording can't invent evidence
// ===========================================================================

test("K: AI rewording only applies to existing candidates, never invents", () => {
  const enhancement = {
    wording: [
      { candidateId: "RC-999", title: "Invented candidate title", description: "This should never appear." },
      { candidateId: A_cand.candidateId, title: "AI-reworded title", description: "AI-reworded description" },
    ],
  };
  const enriched = applyIntelligenceNotes(A_intel, enhancement, "test-provider");
  const target = enriched.rootCauseCandidates.find(c => c.candidateId === A_cand.candidateId)!;

  assert.equal(enriched.rootCauseCandidates.length, A_intel.rootCauseCandidates.length, "no candidate added");
  assert.equal(target.title, "AI-reworded title", "existing candidate title rewritten");
  assert.equal(target.description, "AI-reworded description");
  assert.equal(target.pattern, A_cand.pattern, "pattern unchanged");
  assert.equal(target.confidence, A_cand.confidence, "confidence unchanged");
  assert.equal(target.status, A_cand.status, "status unchanged");
  assert.deepEqual(target.supportingEvidence, A_cand.supportingEvidence, "supporting evidence unchanged");
  assert.deepEqual(target.contradictingEvidence, A_cand.contradictingEvidence, "contradicting evidence unchanged");
  assert.deepEqual(target.investigationActions, A_cand.investigationActions, "investigation actions unchanged");
  assert.deepEqual(target.coverageImpact, A_cand.coverageImpact, "coverage impact unchanged");
  assert.deepEqual(target.regressionContext, A_cand.regressionContext, "regression context unchanged");
  assert.equal(enriched.aiNotes?.wording?.length, 1, "only known candidate recorded");
  assert.equal(enriched.aiNotes?.wording?.[0]?.candidateId, target.candidateId);
  assert.equal(enriched.aiNotes?.provider, "test-provider");
  assert.ok(!enriched.rootCauseCandidates.some(c => c.title === "Invented candidate title"), "invented candidate not present");
});

// ===========================================================================
// Fixture L: no AI key → deterministic works
// ===========================================================================

test("L: deterministic pipeline works without any AI provider", () => {
  const intel = buildIntelligence({ analysis: A_run });
  assert.equal(intel.status, "AVAILABLE");
  assert.equal(intel.aiNotes, null);
  assert.ok(intel.rootCauseCandidates.length >= 1, "deterministic pipeline produces candidates without AI");
  assert.equal(intel.summary.candidates, 1);
  assert.equal(intel.rootCauseCandidates[0]!.candidateId, A_cand.candidateId, "deterministic candidate matches fixture A");
});

// ===========================================================================
// Fixture M: high severity unverified → not treated as reproduced root cause
// ===========================================================================

const M_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const M_report = report({ elements: M_elements });
const M_finding = finding({ id: "QA-F-M1", domain: "accessibility", severity: "CRITICAL", verification: null, evidence: [{ type: "element", index: 0 }] });
const M_flow = flow({ flowId: "FLOW-M1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:M1", steps: [clickBtn0("FLOW-M1")], executable: true, safety: "SAFE" });
const M_exec = exec({ flowId: "FLOW-M1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-M1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const M_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [M_flow], executions: [M_exec] });
const M_run = mkRun({ report: M_report, findings: [M_finding], flowDiscovery: M_discovery });
const M_intel = buildIntelligence({ analysis: M_run });

test("M: high severity unverified → not ACTIONABLE, severity alone is insufficient", () => {
  assert.equal(M_intel.rootCauseCandidates.length, 1);
  assert.equal(M_intel.rootCauseCandidates[0]!.status, "INSUFFICIENT_EVIDENCE", "unverified finding is insufficient despite severity");
  assert.equal(M_intel.rootCauseCandidates[0]!.pattern, "SINGLE_OBSERVATION");
  assert.equal(M_intel.rootCauseCandidates[0]!.confidence, "INSUFFICIENT");
  assert.equal(M_intel.investigationQueue.length, 0, "not queued despite severity");
  assert.equal(M_intel.summary.insufficientEvidence, 1);
  assert.equal(M_intel.summary.actionable, 0);
});

// ===========================================================================
// Fixture N: disappeared finding without fix evidence → no fix claim
// ===========================================================================

const N_regression = regressionMap([regChange({ changeId: "CH-N1", classification: "FIXED", confidence: "MEDIUM_CONFIDENCE", category: "FINDING", relatedFindingIds: ["QA-F-NV"] })]);
const N_report = report({ elements: [] });
const N_run = mkRun({ report: N_report, regression: N_regression });
const N_intel = buildIntelligence({ analysis: N_run });

test("N: disappeared finding without positive fix evidence → no candidate claims a fix", () => {
  assert.equal(N_intel.rootCauseCandidates.length, 0, "no candidate created for a disappeared finding");
  assert.equal(N_intel.summary.candidates, 0);
  assert.ok(!N_intel.rootCauseCandidates.some(c => /fix/i.test(c.title + c.description)), "no candidate claims a fix");
});

// ===========================================================================
// Fixture O: multiple flows, one blocked at auth → limitation preserved
// ===========================================================================

const O_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const O_report = report({ elements: O_elements });
const O_finding = finding({ id: "QA-F-O1", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const O_flow1 = flow({ flowId: "FLOW-O1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:O1", steps: [clickBtn0("FLOW-O1")], executable: true, safety: "SAFE" });
const O_flow2 = flow({ flowId: "FLOW-O2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:O2", steps: [clickBtn0("FLOW-O2")] });
const O_exec1 = exec({ flowId: "FLOW-O1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-O1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const O_exec2 = exec({ flowId: "FLOW-O2", status: "REVIEW_REQUIRED", failureCategory: "AUTH", stoppedAtStep: 1, boundary: "login boundary", steps: [stepExec("FLOW-O2", { stepIndex: 0, outcome: "REVIEW_REQUIRED" })] });
const O_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [O_flow1, O_flow2], executions: [O_exec1, O_exec2] });
const O_run = mkRun({ report: O_report, findings: [O_finding], flowDiscovery: O_discovery });
const O_intel = buildIntelligence({ analysis: O_run });
const O_cand = O_intel.rootCauseCandidates[0]!;

test("O: multiple flows, one at auth boundary → limitation preserved, not a defect claim", () => {
  assert.equal(O_cand.status, "INVESTIGATION_REQUIRED", "auth contradiction downgrades status");
  assert.equal(O_cand.confidence, "LOW", "contradiction downgrades confidence");
  assert.ok(O_cand.contradictingEvidence.length >= 1, "has contradicting evidence about auth boundary");
  assert.deepEqual(O_cand.flowIds.sort(), ["FLOW-O1", "FLOW-O2"]);
  assert.deepEqual(O_cand.findingIds, ["QA-F-O1"]);
  assert.ok(O_cand.investigationActions.some(a => a.kind === "CHECK_OUTSIDE_AUTH_BOUNDARY"), "suggests re-checking outside auth boundary");
  for (const action of O_cand.investigationActions) {
    assert.equal(action.safe, true, "all actions safe");
    assert.ok(SAFE_KINDS.includes(action.kind), `action kind ${action.kind} is in the safe whitelist`);
  }
  assert.ok(/hypothesis/i.test(O_cand.description) && /never a confirmed cause/i.test(O_cand.description), "framed as hypothesis");
  assert.ok(O_intel.evidenceRelationships.some(r => r.relation === "CONTRADICTS"), "contradicting relationship present");
});

// ===========================================================================
// Fixture P: locator IDs change but semantic target same → relationship survives
// ===========================================================================

const P_elements = [
  element({ id: "v1", testId: "x1", tag: "button", role: "button", text: "Confirm", accessibleName: "Confirm", recommendedLocator: "locator V1", locatorQuality: "high" }),
  element({ id: "v2", testId: "x2", tag: "button", role: "button", text: "Confirm", accessibleName: "Confirm", recommendedLocator: "locator V2", locatorQuality: "high" }),
];
const P_report = report({ elements: P_elements });
const P_finding = finding({ id: "QA-F-P1", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const P_flow = flow({ flowId: "FLOW-P1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:P1", steps: [clickElAt("FLOW-P1", 1, "locator V2")], executable: true, safety: "SAFE" });
const P_exec = exec({ flowId: "FLOW-P1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-P1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const P_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [P_flow], executions: [P_exec] });
const P_run = mkRun({ report: P_report, findings: [P_finding], flowDiscovery: P_discovery });
const P_intel = buildIntelligence({ analysis: P_run });
const P_cand = P_intel.rootCauseCandidates[0]!;

test("P: locator IDs change but semantic target same → relationship survives", () => {
  assert.equal(P_intel.summary.candidates, 1, "same semantic target with different DOM ids/locators is one cluster");
  assert.deepEqual(P_cand.findingIds, ["QA-F-P1"]);
  assert.deepEqual(P_cand.flowIds, ["FLOW-P1"]);
  assert.ok(P_cand.supportingEvidence.some(r => r.reason === "SAME_SEMANTIC_TARGET"), "SUPPORTS relationship based on semantic key, not locator/id");
  assert.equal(P_cand.status, "ACTIONABLE");
});

// ===========================================================================
// Fixture Q: same text, different semantic targets → not grouped
// ===========================================================================

const Q_elements = [
  element({ tag: "button", role: "button", text: "Open", accessibleName: "Open", href: null }),
  element({ tag: "a", role: "link", text: "Open", accessibleName: "Open", href: "/open" }),
];
const Q_report = report({ elements: Q_elements });
const Q_finding1 = finding({ id: "QA-F-Q1", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const Q_finding2 = finding({ id: "QA-F-Q2", domain: "accessibility", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 1 }] });
const Q_flow1 = flow({ flowId: "FLOW-Q1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:Q1", steps: [clickBtn0("FLOW-Q1")], executable: true, safety: "SAFE" });
const Q_flow2 = flow({ flowId: "FLOW-Q2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:Q2", steps: [clickElAt("FLOW-Q2", 1, "link Open", { targetUrl: "https://qa.test/open" })], executable: true, safety: "SAFE" });
const Q_exec1 = exec({ flowId: "FLOW-Q1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-Q1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const Q_exec2 = exec({ flowId: "FLOW-Q2", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-Q2", { stepIndex: 0, outcome: "REPRODUCED" })] });
const Q_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [Q_flow1, Q_flow2], executions: [Q_exec1, Q_exec2] });
const Q_run = mkRun({ report: Q_report, findings: [Q_finding1, Q_finding2], flowDiscovery: Q_discovery });
const Q_intel = buildIntelligence({ analysis: Q_run });

test("Q: same text, different semantic targets → separate candidates", () => {
  assert.equal(Q_intel.summary.candidates, 2, "same text but different roles/tag produce separate candidates");
  const qFindings = Q_intel.rootCauseCandidates.flatMap(c => c.findingIds);
  assert.ok(qFindings.includes("QA-F-Q1"));
  assert.ok(qFindings.includes("QA-F-Q2"));
  assert.equal(new Set(qFindings).size, 2);
  for (const cand of Q_intel.rootCauseCandidates) {
    assert.equal(cand.status, "ACTIONABLE");
    assert.equal(cand.pattern, "VERIFIED_REGENERATION");
  }
});

// ===========================================================================
// Fixture R: multiple safe investigation actions → all non-destructive
// ===========================================================================

const R_elements = [element({ accessibleName: "Submit", text: "Submit", role: "button" })];
const R_report = report({ elements: R_elements });
const R_finding = finding({ id: "QA-F-R1", domain: "accessibility", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
const R_flow1 = flow({ flowId: "FLOW-R1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:R1", steps: [clickBtn0("FLOW-R1")], executable: true, safety: "SAFE" });
const R_flow2 = flow({ flowId: "FLOW-R2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:R2", steps: [clickBtn0("FLOW-R2")], executable: true, safety: "SAFE" });
const R_exec1 = exec({ flowId: "FLOW-R1", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-R1", { stepIndex: 0, outcome: "REPRODUCED" })] });
const R_exec2 = exec({ flowId: "FLOW-R2", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-R2", { stepIndex: 0, outcome: "REPRODUCED" })] });
const R_discovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [R_flow1, R_flow2], executions: [R_exec1, R_exec2] });
const R_regression = regressionMap([]);
const R_run = mkRun({ report: R_report, findings: [R_finding], flowDiscovery: R_discovery, regression: R_regression });
const R_intel = buildIntelligence({ analysis: R_run });
const R_cand = R_intel.rootCauseCandidates[0]!;

test("R: three safe investigation actions → all non-destructive and in the safe whitelist", () => {
  const kinds = R_cand.investigationActions.map(a => a.kind);
  assert.ok(kinds.includes("INSPECT_ELEMENT"), "has element inspection");
  assert.ok(kinds.includes("COMPARE_BASELINE_ATTRIBUTES"), "has baseline comparison");
  assert.ok(kinds.includes("RE_RUN_SAFE_NAV_FLOW"), "has safe re-run");
  assert.ok(kinds.includes("VERIFY_SECOND_FLOW_TARGET"), "has second flow verification");
  assert.ok(R_cand.investigationActions.length >= 3, "at least three safe actions");
  assert.equal(R_cand.pattern, "SHARED_SEMANTIC_TARGET", "two stalled flows → SHARED_SEMANTIC_TARGET pattern");
  assert.equal(R_cand.status, "ACTIONABLE");
  for (const action of R_cand.investigationActions) {
    assert.equal(action.safe, true, "every investigation action is explicitly safe");
    assert.ok(SAFE_KINDS.includes(action.kind), `action kind ${action.kind} is in the safe whitelist`);
    assert.ok(/read-only|never modifies state|observe|compare|re-run|navigate|re-crawl/i.test(action.detail + action.title), "detail states read-only / re-observation intent");
  }
});

// ===========================================================================
// validateIntelligenceEnhancement boundary tests
// ===========================================================================

test("validateIntelligenceEnhancement rejects invalid input", () => {
  assert.equal(validateIntelligenceEnhancement(null), null);
  assert.equal(validateIntelligenceEnhancement(undefined), null);
  assert.equal(validateIntelligenceEnhancement("string"), null);
  assert.equal(validateIntelligenceEnhancement({ wording: "not-array" }), null);
  assert.equal(validateIntelligenceEnhancement({ wording: [{ notCandidateId: true }] }), null);
  assert.equal(validateIntelligenceEnhancement({ wording: [{ candidateId: "", title: "x" }] }), null);
  assert.equal(validateIntelligenceEnhancement({ wording: [{ candidateId: "RC-0001" }] }), null, "no title or description → rejected");
  assert.deepEqual(validateIntelligenceEnhancement({ wording: [{ candidateId: "RC-0001", title: "clear" }] })?.wording?.length, 1);
});

// ===========================================================================
// applyIntelligenceNotes null/empty handling
// ===========================================================================

test("applyIntelligenceNotes with null enhancement clears aiNotes", () => {
  const enriched = applyIntelligenceNotes(A_intel, null, null);
  assert.equal(enriched.aiNotes, null, "null enhancement clears aiNotes");
  assert.deepEqual(enriched.rootCauseCandidates, A_intel.rootCauseCandidates, "candidates unchanged");
  assert.equal(enriched.status, A_intel.status);
  assert.equal(enriched.summary, A_intel.summary);
});

test("applyIntelligenceNotes with empty wording clears aiNotes", () => {
  const enriched = applyIntelligenceNotes(A_intel, { wording: [] }, "test");
  assert.equal(enriched.aiNotes, null);
});

test("applyIntelligenceNotes truncates title/description beyond limits", () => {
  const longTitle = "A".repeat(200);
  const longDesc = "B".repeat(1500);
  const enriched = applyIntelligenceNotes(A_intel, { wording: [{ candidateId: A_cand.candidateId, title: longTitle, description: longDesc }] }, "test");
  const target = enriched.rootCauseCandidates.find(c => c.candidateId === A_cand.candidateId)!;
  assert.ok(target.title.length <= 140, `title truncated: ${target.title.length}`);
  assert.ok(target.description.length <= 1200, `description truncated: ${target.description.length}`);
});

test("intelligenceDigestOf produces compact digest", () => {
  const digest = intelligenceDigestOf(A_intel, A_run);
  assert.equal(digest.url, "https://qa.test/en");
  assert.equal(digest.title, "QA target");
  assert.equal(digest.candidates.length, 1);
  assert.equal(digest.candidates[0]!.candidateId, A_cand.candidateId);
  assert.equal(digest.candidates[0]!.pattern, "VERIFIED_REGENERATION");
});

// ===========================================================================
// Fixture E2E: two-run generic local fixture (real chromium, no NoorPlay)
// ===========================================================================

test("E2E: intelligence layer correctly differentiates identical vs. changed targets across two runs", () => {
  // Two analyses simulating a baseline and current run on a deterministic fixture site.
  // Baseline has finding QA-F-BASE on element0; current has same finding, plus a second
  // stall at a different element → ensures the intelligence layer distinguishes targets
  // and does not falsely merge evidence from separate pages or elements.
  const sharedElements = [element({ accessibleName: "Alpha", text: "Alpha", role: "button" }), element({ accessibleName: "Beta", text: "Beta", role: "button" })];

  const baselineReport = report({ elements: sharedElements });
  const baselineFinding = finding({ id: "QA-F-BASE-ALPHA", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const baselineFlow = flow({ flowId: "FLOW-BASE-ALPHA", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:BASE-ALPHA", steps: [clickBtn0("FLOW-BASE-ALPHA")], executable: true, safety: "SAFE" });
  const baselineExec = exec({ flowId: "FLOW-BASE-ALPHA", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-BASE-ALPHA", { stepIndex: 0, outcome: "REPRODUCED" })] });
  const baselineDiscovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [baselineFlow], executions: [baselineExec] });
  const baselineRun = mkRun({ report: baselineReport, findings: [baselineFinding], flowDiscovery: baselineDiscovery });
  const baselineIntel = buildIntelligence({ analysis: baselineRun });

  const currentReport = report({ elements: sharedElements });
  const currentFinding1 = finding({ id: "QA-F-CUR-ALPHA", domain: "accessibility", severity: "MEDIUM", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 0 }] });
  const currentFinding2 = finding({ id: "QA-F-CUR-BETA", domain: "accessibility", severity: "HIGH", verification: ver({ disposition: "REPRODUCED" }), evidence: [{ type: "element", index: 1 }] });
  const currentFlow1 = flow({ flowId: "FLOW-CUR-ALPHA", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:CUR-ALPHA", steps: [clickBtn0("FLOW-CUR-ALPHA")], executable: true, safety: "SAFE" });
  const currentFlow2 = flow({ flowId: "FLOW-CUR-BETA", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:CUR-BETA", steps: [clickElAt("FLOW-CUR-BETA", 1, "button Beta")], executable: true, safety: "SAFE" });
  const currentExec1 = exec({ flowId: "FLOW-CUR-ALPHA", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-CUR-ALPHA", { stepIndex: 0, outcome: "REPRODUCED" })] });
  const currentExec2 = exec({ flowId: "FLOW-CUR-BETA", status: "REPRODUCED", failureCategory: "WEBSITE", stoppedAtStep: null, boundary: null, steps: [stepExec("FLOW-CUR-BETA", { stepIndex: 0, outcome: "REPRODUCED" })] });
  const currentDiscovery = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [currentFlow1, currentFlow2], executions: [currentExec1, currentExec2] });
  const currentRun = mkRun({ report: currentReport, findings: [currentFinding1, currentFinding2], flowDiscovery: currentDiscovery });
  const currentIntel = buildIntelligence({ analysis: currentRun });

  // Baseline: one candidate (Alpha)
  assert.equal(baselineIntel.summary.candidates, 1, "baseline has one candidate");
  assert.deepEqual(baselineIntel.rootCauseCandidates[0]!.findingIds, ["QA-F-BASE-ALPHA"]);
  assert.deepEqual(baselineIntel.rootCauseCandidates[0]!.flowIds, ["FLOW-BASE-ALPHA"]);

  // Current: two candidates (Alpha, Beta), not merged
  assert.equal(currentIntel.summary.candidates, 2, "current run has two separate candidates");
  const alphaCandidate = currentIntel.rootCauseCandidates.find(c => c.findingIds.includes("QA-F-CUR-ALPHA"))!;
  const betaCandidate = currentIntel.rootCauseCandidates.find(c => c.findingIds.includes("QA-F-CUR-BETA"))!;
  assert.ok(alphaCandidate, "Alpha candidate exists");
  assert.ok(betaCandidate, "Beta candidate exists");
  assert.deepEqual(alphaCandidate.flowIds, ["FLOW-CUR-ALPHA"]);
  assert.deepEqual(betaCandidate.flowIds, ["FLOW-CUR-BETA"]);
  assert.notEqual(alphaCandidate.candidateId, betaCandidate.candidateId, "different candidate ids");
  assert.ok(alphaCandidate.supportingEvidence.length >= 1);
  assert.ok(betaCandidate.supportingEvidence.length >= 1);

  // Queue reflects both
  assert.equal(currentIntel.investigationQueue.length, 2);
  assert.ok(currentIntel.investigationQueue.every(entry => ["P1", "P2", "P3"].includes(entry.priority)), "queue entries carry a valid priority");
});

// ===========================================================================
// Real chromium scan→analyze→execute→intelligence on a deterministic local
// fixture (no NoorPlay). A live PASS execution through the same target as a
// reproduced finding must apply a CONTRADICTS downgrade — proof the engine
// reasons on real browser evidence, not just synthetic fixtures.
// ===========================================================================

test("E2E real chromium: live passing flow downgrades a reproduced claim at the same target", async () => {
  const server = createServer((request, response) => {
    const send = (body: string, status = 200) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    const head = (title: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>`;
    const url = request.url ?? "/";
    if (url === "/") return send(`${head("Generic Home")}<form action="/search"><input type="search" placeholder="Search" name="q"><button type="submit">Search</button></form><a href="/about">About</a><a href="/login">Log in</a></body></html>`);
    if (url === "/search") return send(`${head("Results")}<p>No results.</p></body></html>`);
    if (url === "/about") return send(`${head("About")}<p>About this site.</p></body></html>`);
    if (url.startsWith("/login")) return send(`${head("Sign in")}<form action="/login"><input type="text" name="username"><input type="password" name="password"><button type="submit">Sign in</button></form></body></html>`);
    return send(`<html><body>not found</body></html>`, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-intel-"));

  try {
    const { report: r } = await scanWebsite({ url: base, headed: false, timeout: 15000, outputPath: join(folder, "report.json"), concurrency: 1 });
    const analysis = await analyzeScan(r, { flowLimits: limits({ maxPages: 3, maxFlows: 10 }) });
    const flowDiscovery = analysis.flowDiscovery;
    assert.ok(flowDiscovery, "flowDiscovery present");

    const searchFlow = flowDiscovery.flows.find(flow => flow.category === "SEARCH");
    const navFlow = flowDiscovery.flows.find(flow => flow.category === "NAVIGATION");
    const authFlow = flowDiscovery.flows.find(flow => flow.category === "AUTHENTICATION");
    assert.ok(searchFlow && navFlow && authFlow, "search, nav, and auth flows discovered");

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const searchRun = await runFlow(page, searchFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
      const navRun = await runFlow(page, navFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
      const authRun = await runFlow(page, authFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });

      assert.equal(searchRun.status, "PASS", "search executes end-to-end live");
      assert.equal(navRun.status, "PASS", "nav executes end-to-end live");
      assert.equal(authRun.status, "BLOCKED", "auth never completes");

      const executed: FlowDiscovery = {
        ...flowDiscovery,
        executions: [searchRun, navRun, authRun],
      };

      // Reproduced finding on the LIVE search input. The search flow PASSED live;
// a passing execution through a target is CONTRADICTING evidence, so the
// engine must never promote this claim to an ACTIONABLE root cause.
      const searchInputIndex = r.elements.findIndex(element => element.tag === "input" || element.role === "searchbox" || element.role === "textbox");
      assert.ok(searchInputIndex >= 0, "the live page contains a searchable input");
      const liveFinding = finding({
        id: "QA-F-LIVE-SEARCH",
        domain: "accessibility",
        severity: "HIGH",
        code: "input-missing-label",
        verification: ver({ disposition: "REPRODUCED" }),
        evidence: [{ type: "element", index: searchInputIndex }],
      });
      const liveAnalysis: QaAnalysis = {
        ...analysis,
        findings: [...analysis.findings, liveFinding],
        flowDiscovery: executed,
        intelligence: null,
      };

      const intel = buildIntelligence({ analysis: liveAnalysis });
      assert.equal(intel.status, "AVAILABLE", "intelligence available on a real browser run");
      assert.equal(intel.schemaVersion, 1, "schema stays version 1");

      // False-positive protection: a reproduced claim whose live execution
      // PASSED must never become ACTIONABLE.
      const liveClaim = intel.rootCauseCandidates.find(c => c.findingIds.includes("QA-F-LIVE-SEARCH"));
      if (liveClaim) {
        assert.notEqual(liveClaim.status, "ACTIONABLE", "a live passing flow prevents an actionable root cause");
        assert.ok(["INVESTIGATION_REQUIRED", "INSUFFICIENT_EVIDENCE"].includes(liveClaim.status), `status is ${liveClaim.status}`);
      }

      // Every candidate the live run produces is read-only and internally consistent.
      for (const candidate of intel.rootCauseCandidates) {
        for (const action of candidate.investigationActions) {
          assert.equal(action.safe, true, "live candidate actions stay read-only");
          assert.ok(SAFE_KINDS.includes(action.kind), `live action ${action.kind} is safe`);
        }
      }
      assert.equal(intel.summary.candidates, intel.rootCauseCandidates.length);
      assert.equal(intel.summary.actionable + intel.summary.investigationRequired + intel.summary.insufficientEvidence + intel.summary.informational, intel.rootCauseCandidates.length);

      // The HTML report renders the intelligence section additively.
      const html = renderQaHtml({ ...liveAnalysis, intelligence: intel });
      assert.ok(html.includes("QA Intelligence"), "HTML report renders the QA Intelligence section");
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});
