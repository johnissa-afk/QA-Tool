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
import type { QaFinding } from "../ai/types.js";
import { analyzeScan } from "../ai/index.js";
import { renderQaHtml } from "../ai/report.js";
import { scanWebsite } from "../scanner.js";
import { runFlow, defaultFlowLimits } from "../flow/index.js";
import { applyCoverageNotes, buildCoverage, coverageDigest, gapHeadlines } from "../coverage/index.js";
import type { CoverageMap } from "../coverage/index.js";

// ---------------------------------------------------------------------------
// Phase 4 fixture tests. Every fixture is generic: it uses the synthetic
// https://qa.test/en origin and never references a real website, locator, or
// expected string. buildCoverage is deterministic — statuses are derived from
// flows, executions, findings, and scanner evidence only.
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
  recommendedLocator: "page.getByText(\"x\")",
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
  const boundary = overrides.boundary ?? (steps.some(s => s.safety !== "SAFE") ? { stepIndex: steps.findIndex(s => s.safety !== "SAFE"), safety: steps.find(s => s.safety !== "SAFE")!.safety, automation: steps.find(s => s.safety !== "SAFE")!.automation, reason: "boundary step " + steps.findIndex(s => s.safety !== "SAFE") } : null);
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
    boundary,
    executable,
    priority: overrides.priority ?? "P2",
    priorityReason: overrides.priorityReason ?? `${overrides.priority ?? "P2"} — deterministic fixture priority.`,
    confidence: overrides.confidence ?? "high",
    occurrenceCount: overrides.occurrenceCount ?? 1,
    dedupeKey: overrides.dedupeKey,
    evidence: [],
  };
};

type StepExec = { stepIndex?: number; action?: FlowStepAction; outcome?: FlowStepOutcome; category?: FlowFailureCategory; reason?: string };

const stepExec = (flowId: string, base: StepExec = {}): FlowStepExecutionResult => ({
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

const edge = (overrides: Partial<NodeEdge> & { href: string }): NodeEdge => ({
  fromPageId: overrides.fromPageId ?? "page-1",
  toPageId: overrides.toPageId ?? null,
  origin: overrides.origin ?? "same",
  href: overrides.href,
  label: overrides.label ?? null,
  locator: overrides.locator ?? null,
  safe: overrides.safe ?? true,
  count: overrides.count ?? 1,
  broken: overrides.broken ?? false,
  evidence: [],
});

const control = (overrides: Partial<NodeControl> & { kind: NodeControl["kind"] }): NodeControl => ({
  kind: overrides.kind,
  locator: overrides.locator ?? null,
  text: overrides.text ?? null,
  accessibleName: overrides.accessibleName ?? null,
  role: overrides.role ?? null,
  tag: overrides.tag ?? "button",
  href: overrides.href ?? null,
  type: overrides.type ?? null,
  elementIndex: overrides.elementIndex ?? null,
  safe: overrides.safe ?? true,
  count: overrides.count ?? 1,
  evidence: [],
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
    summary: {
      pages: 0, flows: 0, executable: 0, review: 0, highRisk: 0, blocked: 0, steps: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0,
    },
  };
  base.summary = summaryFor(base);
  return base;
};

const build = (r: ScanReport, d: FlowDiscovery, findings: QaFinding[] = []): CoverageMap => buildCoverage({ report: r, flowDiscovery: d, findings, verifications: [] });

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

// ---------------------------------------------------------------------------
// A. Fully tested navigation
// ---------------------------------------------------------------------------
test("A: fully exercised navigation pages and links are TESTED; dedupe per destination", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/products\\\"]\")" }),
      element({ tag: "a", role: "link", text: "News", accessibleName: "News", href: "https://qa.test/en/news/1", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/news/1\\\"]\")" }),
    ],
    summary: { linksChecked: 2, brokenLinks: 0 },
  });
  const d = discovery({
    pages: [
      pageNode({ id: "page-1", url: "https://qa.test/en", title: "Home", edges: [edge({ href: "https://qa.test/en/products" }), edge({ href: "https://qa.test/en/news/1" })] }),
    ],
    flows: [
      flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/products", priority: "P2" }),
      flow({ flowId: "FLOW-CONTENT", category: "CONTENT_DISCOVERY", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "content:https://qa.test/en/news/1", priority: "P3" }),
    ],
    executions: [
      exec({ flowId: "FLOW-NAV", status: "PASS", steps: [stepExec("FLOW-NAV", { stepIndex: 0, action: "open", reason: "products page rendered" })] }),
      exec({ flowId: "FLOW-CONTENT", status: "PASS", steps: [stepExec("FLOW-CONTENT", { stepIndex: 0, action: "open", reason: "article rendered" })] }),
    ],
  });
  const coverage = build(r, d);

  const page = coverage.items.find(item => item.category === "PAGE");
  assert.equal(page?.status, "TESTED", "page with all flows executed cleanly is TESTED");

  const nav = coverage.items.filter(item => item.category === "NAVIGATION");
  assert.equal(nav.length, 1, "one item per unique destination edge");
  assert.equal(nav[0]?.status, "TESTED", "executed navigation is TESTED");

  const content = coverage.items.find(item => item.category === "CONTENT_DISCOVERY");
  assert.equal(content?.status, "TESTED", "executed content discovery is TESTED");

  const linksGroup = coverage.items.find(item => item.category === "INTERACTION" && item.name === "Links");
  assert.equal(linksGroup?.status, "TESTED", "all edges exercised by passing flows");

  const integrity = coverage.items.find(item => item.category === "ERROR_HANDLING" && item.name.startsWith("Link integrity"));
  assert.equal(integrity?.status, "TESTED", "live link run is execution evidence");

  assert.equal(coverage.summary.pages.tested, 1);
  assert.equal(coverage.summary.recommendations, coverage.testPlan.length);
});

// ---------------------------------------------------------------------------
// B. Partially exercised site
// ---------------------------------------------------------------------------
test("B: executed nav + unexecuted content discovery leaves honest PARTIALLY/ NOT_TESTED statuses", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/products\\\"]\")" }),
      element({ tag: "a", role: "link", text: "News", accessibleName: "News", href: "https://qa.test/en/news/1", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/news/1\\\"]\")" }),
    ],
    summary: { linksChecked: 2, brokenLinks: 0 },
  });
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", title: "Home", edges: [edge({ href: "https://qa.test/en/products" }), edge({ href: "https://qa.test/en/news/1" })] })],
    flows: [
      flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/products", priority: "P2" }),
      flow({ flowId: "FLOW-CONTENT", category: "CONTENT_DISCOVERY", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "content:https://qa.test/en/news/1", priority: "P3" }),
    ],
    executions: [exec({ flowId: "FLOW-NAV", status: "PASS", steps: [stepExec("FLOW-NAV", { action: "open", reason: "products page rendered" })] })],
  });
  const coverage = build(r, d);

  const page = coverage.items.find(item => item.category === "PAGE");
  assert.equal(page?.status, "PARTIALLY_TESTED", "one executable flow left unrun");

  assert.equal(coverage.items.find(item => item.category === "NAVIGATION")?.status, "TESTED");
  const content = coverage.items.find(item => item.category === "CONTENT_DISCOVERY");
  assert.equal(content?.status, "NOT_TESTED", "scanned but never exercised");

  const rec = coverage.testPlan.find(item => item.type === "TEST_CONTENT_DISCOVERY");
  assert.ok(rec, "recommendation for the untested content destination");
  assert.ok(rec?.coverageIds.includes(content!.coverageId), "recommendation traces to its coverage item");
});

// ---------------------------------------------------------------------------
// C. Untested page
// ---------------------------------------------------------------------------
test("C: a scanned-but-unexercised page reports NOT_TESTED and an EXECUTE_FLOW step", () => {
  const r = report({
    elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" })],
  });
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", title: "Home", edges: [edge({ href: "https://qa.test/en/about" })] })],
    flows: [flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/about", priority: "P2" })],
  });
  const coverage = build(r, d);

  assert.equal(coverage.items.find(item => item.category === "PAGE")?.status, "NOT_TESTED");
  assert.equal(coverage.items.find(item => item.category === "FLOW")?.status, "NOT_TESTED", "discovered but not executed");
  const rec = coverage.testPlan.find(item => item.type === "EXECUTE_FLOW");
  assert.ok(rec, "recommendation generated");
  assert.equal(rec?.priority, "P2", "flow priority carried through");
  assert.equal(coverage.summary.pages.untested, 1);
  assert.equal(coverage.summary.pages.tested, 0);
});

// ---------------------------------------------------------------------------
// D. Auth boundary is BLOCKED, never TESTED, never bypassed.
// ---------------------------------------------------------------------------
test("D: authentication boundary stays BLOCKED and its form is never auto-submitted", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Log in", accessibleName: "Log in", href: "https://qa.test/en/login", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/login\\\"]\")" }),
      element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" }),
      element({ tag: "input", role: "textbox", type: "text", accessibleName: "Username", recommendedLocator: "page.getByRole(\"textbox\", { name: \"Username\" })", formIndex: 0 }),
      element({ tag: "input", role: "textbox", type: "password", accessibleName: "Password", recommendedLocator: "page.getByRole(\"textbox\", { name: \"Password\" })", formIndex: 0 }),
    ],
  });
  const authSteps = [
    step({ action: "open", targetUrl: "https://qa.test/en", expected: "home loads" }),
    step({ action: "click-link", locator: "page.locator(\"a[href=\\\"https://qa.test/en/login\\\"]\")", expected: "login page reached", safety: "SAFE", automation: "AUTOMATED" }),
    step({ action: "observe", expected: "credentials", safety: "BLOCKED", automation: "MANUAL", reason: "credential input (password) — never auto-filled" }),
  ];
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", title: "Home", edges: [edge({ href: "https://qa.test/en/login" }), edge({ href: "https://qa.test/en/about" })] })],
    flows: [
      flow({ flowId: "FLOW-AUTH", category: "AUTHENTICATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "auth", safety: "BLOCKED", boundary: { stepIndex: 2, safety: "BLOCKED", automation: "MANUAL", reason: "credential input (password) — never auto-filled" }, steps: authSteps, priority: "P1" }),
      flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/about", priority: "P2" }),
    ],
    executions: [
      exec({ flowId: "FLOW-AUTH", status: "BLOCKED", stoppedAtStep: 2, boundary: "stopped before credentials", steps: [
        stepExec("FLOW-AUTH", { stepIndex: 0, action: "open", reason: "home loaded" }),
        stepExec("FLOW-AUTH", { stepIndex: 1, action: "click-link", reason: "login page reached" }),
        stepExec("FLOW-AUTH", { stepIndex: 2, action: "observe", outcome: "BLOCKED", category: "SAFETY_BLOCK", reason: "credential input — never auto-filled" }),
      ] }),
      exec({ flowId: "FLOW-NAV", status: "PASS", steps: [stepExec("FLOW-NAV", { action: "open", reason: "about rendered" })] }),
    ],
  });
  const coverage = build(r, d);

  const auth = coverage.items.find(item => item.category === "AUTHENTICATION_BOUNDARY");
  assert.equal(auth?.status, "BLOCKED", "auth is never TESTED");
  assert.equal(auth?.safety, "BLOCKED");

  const page = coverage.items.find(item => item.category === "PAGE");
  assert.equal(page?.status, "PARTIALLY_TESTED", "nav passed but the auth execution stopped at its boundary");
  assert.equal(page?.safety, "BLOCKED");

  const form = coverage.items.find(item => item.category === "FORM");
  assert.equal(form?.status, "BLOCKED", "password form is blocked, never auto-submitted");

  const rec = coverage.testPlan.find(item => item.type === "REVIEW_AUTHENTICATION_BOUNDARY");
  assert.ok(rec, "review-the-boundary recommendation exists");
  assert.equal(rec?.priority, "P1");
  assert.ok(coverage.testPlan.some(item => item.type === "REVIEW_BLOCKED_FORM"), "blocked form is reviewed, not submitted");
});

// ---------------------------------------------------------------------------
// E. Search coverage (control, results, empty state).
// ---------------------------------------------------------------------------
test("E: executed search yields TESTED control + results, and empty-state needs the safe no-match run", () => {
  const r = report({
    elements: [
      element({ tag: "input", role: "searchbox", type: "search", placeholder: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })", formIndex: 0 }),
      element({ tag: "button", role: "button", text: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })", formIndex: 0 }),
    ],
  });
  const flowSteps = [
    step({ action: "open", targetUrl: "https://qa.test/en", expected: "home loads" }),
    step({ action: "type", locator: "page.getByRole(\"searchbox\", { name: \"Search\" })", text: "quality", expected: "term entered" }),
    step({ action: "submit", locator: "page.getByRole(\"button\", { name: \"Search\" })", expected: "results page" }),
    step({ action: "observe", expected: "results state", reason: "results read" }),
  ];
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", title: "Home", controls: [control({ kind: "search", type: "search" })] })],
    flows: [flow({ flowId: "FLOW-SEARCH", category: "SEARCH", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "search:page-1", steps: flowSteps, priority: "P1" })],
    executions: [exec({ flowId: "FLOW-SEARCH", status: "PASS", failureCategory: null, steps: [
      stepExec("FLOW-SEARCH", { stepIndex: 0, action: "open" }),
      stepExec("FLOW-SEARCH", { stepIndex: 1, action: "type" }),
      stepExec("FLOW-SEARCH", { stepIndex: 2, action: "submit" }),
      stepExec("FLOW-SEARCH", { stepIndex: 3, action: "observe", reason: "Results page loaded with 1 result" }),
    ] })],
  });
  const coverage = build(r, d);

  const searchControlItem = coverage.items.find(item => item.coverageId === "COV-SEARCH-001-CTRL");
  assert.equal(searchControlItem?.status, "TESTED", "typing into the box is execution evidence");
  const results = coverage.items.find(item => item.coverageId === "COV-SEARCH-001-RESULTS");
  assert.equal(results?.status, "TESTED");
  const empty = coverage.items.find(item => item.coverageId === "COV-SEARCH-001-EMPTY");
  assert.equal(empty?.status, "NOT_TESTED", "empty state not yet probed");
  assert.ok(coverage.testPlan.some(item => item.type === "COMPLETE_SEARCH" && item.coverageIds.includes(empty!.coverageId)));

  const form = coverage.items.find(item => item.category === "FORM");
  assert.equal(form?.status, "TESTED", "search-only form exercised by the passing search flow");
  assert.equal(coverage.items.find(item => item.category === "INTERACTION" && item.name === "Inputs")?.status, "PARTIALLY_TESTED");
});

test("E2: empty/no-result state is TESTED once the last observe step reports a no-match outcome", () => {
  const r = report({
    elements: [
      element({ tag: "input", role: "searchbox", type: "search", placeholder: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })", formIndex: 0 }),
      element({ tag: "button", role: "button", text: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })", formIndex: 0 }),
    ],
  });
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", controls: [control({ kind: "search", type: "search" })] })],
    flows: [flow({ flowId: "FLOW-SEARCH", category: "SEARCH", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "search:page-1", title: "Search the site" })],
    executions: [exec({ flowId: "FLOW-SEARCH", status: "PASS", steps: [
      stepExec("FLOW-SEARCH", { stepIndex: 0, action: "open" }),
      stepExec("FLOW-SEARCH", { stepIndex: 1, action: "type" }),
      stepExec("FLOW-SEARCH", { stepIndex: 2, action: "submit" }),
      stepExec("FLOW-SEARCH", { stepIndex: 3, action: "observe", reason: "No matches were found for your query" }),
    ] })],
  });
  const coverage = build(r, d);
  assert.equal(coverage.items.find(item => item.coverageId === "COV-SEARCH-001-EMPTY")?.status, "TESTED");
});

// ---------------------------------------------------------------------------
// F. Language switching (executed / not executed / N/A).
// ---------------------------------------------------------------------------
test("F: language switch is TESTED only with execution evidence, otherwise NOT_TESTED or NOT_APPLICABLE", () => {
  const r = report({ elements: [element({ tag: "button", role: "button", text: "العربية", accessibleName: "العربية", href: "/?lang=ar", recommendedLocator: "page.getByRole(\"button\", { name: \"العربية\" })" })] });

  const untested = build(r, discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", controls: [control({ kind: "language", text: "العربية" })] })],
    flows: [flow({ flowId: "FLOW-LANG", category: "LANGUAGE_SWITCH", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "lang:page-1:ar" })],
  }));
  assert.equal(untested.items.find(item => item.category === "LANGUAGE")?.status, "NOT_TESTED", "discovered but not executed");

  const executed = build(r, discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", controls: [control({ kind: "language", text: "العربية" })] })],
    flows: [flow({ flowId: "FLOW-LANG", category: "LANGUAGE_SWITCH", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "lang:page-1:ar" })],
    executions: [exec({ flowId: "FLOW-LANG", status: "PASS", steps: [stepExec("FLOW-LANG", { action: "click", reason: "switch clicked" })] })],
  }));
  const lang = executed.items.find(item => item.category === "LANGUAGE");
  assert.equal(lang?.status, "TESTED", "executed language switch is TESTED");
  assert.match(lang!.reason, /document language is "en"/, "doc language cited if recorded");

  const noLang = build(report(), discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [] }));
  assert.equal(noLang.items.find(item => item.category === "LANGUAGE")?.status, "NOT_APPLICABLE");
});

// ---------------------------------------------------------------------------
// G. Forms: safely inspectable, review-only, blocked.
// ---------------------------------------------------------------------------
test("G: a clean non-search form stays NOT_TESTED (never auto-submitted) with an inspect recommendation", () => {
  const r = report({
    elements: [
      element({ tag: "input", role: "textbox", type: "text", accessibleName: "Name", recommendedLocator: "page.getByRole(\"textbox\", { name: \"Name\" })", formIndex: 0 }),
      element({ tag: "button", role: "button", text: "Save", accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", formIndex: 0 }),
    ],
  });
  const d = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [] });
  const coverage = build(r, d);
  const form = coverage.items.find(item => item.category === "FORM");
  assert.equal(form?.status, "NOT_TESTED");
  assert.ok(coverage.testPlan.some(item => item.type === "INSPECT_UNTESTED_FORM" && item.coverageIds.includes(form!.coverageId)));
});

test("G2: a label finding inside a form makes it REVIEW_REQUIRED, not silently testable", () => {
  const r = report({
    elements: [
      element({ tag: "input", role: "textbox", type: "text", accessibleName: null, recommendedLocator: "page.getByRole(\"textbox\")", formIndex: 0 }),
      element({ tag: "button", role: "button", text: "Go", accessibleName: "Go", recommendedLocator: "page.getByRole(\"button\", { name: \"Go\" })", formIndex: 0 }),
    ],
  });
  const f = finding({ id: "QA-F-01", code: "input-missing-label", severity: "HIGH", evidence: [{ type: "element", index: 0 }] });
  const d = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [] });
  const coverage = build(r, d, [f]);
  const form = coverage.items.find(item => item.category === "FORM");
  assert.equal(form?.status, "REVIEW_REQUIRED");
  assert.deepEqual([...form!.relatedFindings], [f.id]);
  const rec = coverage.testPlan.find(item => item.type === "REVIEW_FORM" && item.coverageIds.includes(form!.coverageId));
  assert.ok(rec, "review-before-exercise recommendation");
});

// ---------------------------------------------------------------------------
// H/I/J. Accessibility evidence.
// ---------------------------------------------------------------------------
test("H: accessibility REPRODUCED by a live probe → TESTED; I: unverified stays NOT_TESTED and escalates severity", () => {
  const r = report({ elements: [element({ tag: "button", role: "button", text: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })" })] });
  const page = pageNode({ id: "page-1", url: "https://qa.test/en" });

  const reproduced = build(r, discovery({ pages: [page], flows: [] }), [
    finding({ id: "QA-F-ACC", code: "button-missing-name", severity: "HIGH", verification: ver({ disposition: "REPRODUCED", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", reason: "live DOM has a nameless button" }) }),
  ]);
  const acc = reproduced.items.find(item => item.category === "ACCESSIBILITY_CHECK");
  assert.equal(acc?.status, "TESTED", "live probe reproducing the problem is evidence");
  assert.equal(acc?.executionStatus, "REPRODUCED");
  assert.equal(reproduced.summary.findings.reproduced, 1);
  assert.equal(reproduced.summary.findings.verified, 1);
  assert.ok(!reproduced.testPlan.some(item => item.type === "VERIFY_ACCESSIBILITY" || item.type === "REVIEW_ACCESSIBILITY"), "tested accessibility needs no recommendation");

  const unverified = build(r, discovery({ pages: [page], flows: [] }), [
    finding({ id: "QA-F-ACC", code: "button-missing-name", severity: "HIGH" }),
  ]);
  const unv = unverified.items.find(item => item.category === "ACCESSIBILITY_CHECK");
  assert.equal(unv?.status, "NOT_TESTED", "scanner observation is not a test");
  const rec = unverified.testPlan.find(item => item.type === "VERIFY_ACCESSIBILITY" && item.coverageIds.includes(unv!.coverageId));
  assert.ok(rec, "verification probe recommended");
  assert.equal(rec?.priority, "P1", "HIGH severity pushes accessibility verification to P1");
});

test("J: accessibility NOT_REPRODUCED by the live probe is accredited as TESTED with an honest disposition", () => {
  const r = report({ elements: [element({ tag: "button", role: "button", text: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })" })] });
  const d = discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [] });
  const coverage = build(r, d, [
    finding({ id: "QA-F-ACC", code: "button-missing-name", severity: "MEDIUM", verification: ver({ disposition: "NOT_REPRODUCED", status: "NOT_REPRODUCED", category: "EXPECTATION", verdict: "NOT_REPRODUCED", reason: "live probe found a labelled button" }) }),
  ]);
  const acc = coverage.items.find(item => item.category === "ACCESSIBILITY_CHECK");
  assert.equal(acc?.status, "TESTED", "probe ran and the signal did not hold");
  assert.equal(acc?.executionStatus, "NOT_REPRODUCED");
  assert.equal(coverage.summary.findings.notReproduced, 1);
  assert.equal(coverage.summary.findings.verified, 1);
});

// ---------------------------------------------------------------------------
// K. Media is REVIEW-only; never auto-played, still traced.
// ---------------------------------------------------------------------------
test("K: media playback stays NOT_TESTED/PARTIALLY_TESTED and is never auto-started", () => {
  const r = report({ elements: [element({ tag: "video", role: "generic", text: "", recommendedLocator: "page.locator(\"video\")" })] });
  const page = pageNode({ id: "page-1", url: "https://qa.test/en", controls: [control({ kind: "media", tag: "video" })] });

  const notRun = build(r, discovery({
    pages: [page],
    flows: [flow({ flowId: "FLOW-MEDIA", category: "MEDIA", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "media:page-1", safety: "REVIEW", boundary: { stepIndex: 1, safety: "REVIEW", automation: "MANUAL", reason: "playback is manual" } })],
  }));
  const media = notRun.items.find(item => item.category === "MEDIA");
  assert.equal(media?.status, "NOT_TESTED");
  assert.ok(notRun.testPlan.some(item => item.type === "REVIEW_MEDIA" && item.coverageIds.includes(media!.coverageId)));

  const ran = build(r, discovery({
    pages: [page],
    flows: [flow({ flowId: "FLOW-MEDIA", category: "MEDIA", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "media:page-1", safety: "REVIEW", boundary: { stepIndex: 1, safety: "REVIEW", automation: "MANUAL", reason: "playback is manual" } })],
    executions: [exec({ flowId: "FLOW-MEDIA", status: "REPRODUCED", stoppedAtStep: 1, boundary: "playback is manual", steps: [stepExec("FLOW-MEDIA", { action: "open" })] })],
  }));
  assert.equal(ran.items.find(item => item.category === "MEDIA")?.status, "PARTIALLY_TESTED");

  const noMedia = build(report(), discovery({ pages: [pageNode({ id: "page-1", url: "https://qa.test/en" })], flows: [] }));
  assert.equal(noMedia.items.find(item => item.category === "MEDIA")?.status, "NOT_APPLICABLE");
});

// ---------------------------------------------------------------------------
// L. Responsive is never claimed from a desktop scan.
// ---------------------------------------------------------------------------
test("L: responsive coverage is always NOT_TESTED on a desktop scan and surfaces as a gap", () => {
  const r = report({ elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" })] });
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", edges: [edge({ href: "https://qa.test/en/about" })] })],
    flows: [flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/about" })],
    executions: [exec({ flowId: "FLOW-NAV", status: "PASS", steps: [stepExec("FLOW-NAV", { action: "open", reason: "about rendered" })] })],
  });
  const coverage = build(r, d);
  const responsive = coverage.items.find(item => item.category === "RESPONSIVE_CHECK");
  assert.equal(responsive?.status, "NOT_TESTED");
  assert.ok(gapHeadlines(coverage.items).some(line => /responsive/i.test(line)), "gap headline names responsive");
  const digest = coverageDigest({ url: "https://qa.test/en", title: "QA target" }, coverage.items, coverage.testPlan);
  assert.ok(digest.gaps.some(line => line.includes("desktop-viewport")), "digest gap explains the desktop-only scan");
});

// ---------------------------------------------------------------------------
// M. Traceability, dedupe, deterministic gaps, AI bounds.
// ---------------------------------------------------------------------------
test("M: every recommendation traces to an existing coverage item and summary counts are exact", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/products\\\"]\")" }),
      element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" }),
      element({ tag: "a", role: "link", text: "Contact", accessibleName: "Contact", href: "https://qa.test/en/contact", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/contact\\\"]\")" }),
    ],
    summary: { linksChecked: 3, brokenLinks: 0 },
  });
  const d = discovery({
    pages: [
      pageNode({ id: "page-1", url: "https://qa.test/en", title: "Home", edges: [edge({ href: "https://qa.test/en/products" }), edge({ href: "https://qa.test/en/about" }), edge({ href: "https://qa.test/en/contact" })] }),
    ],
    flows: [
      flow({ flowId: "FLOW-1", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/products", priority: "P2" }),
      flow({ flowId: "FLOW-2", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/about", priority: "P2" }),
      flow({ flowId: "FLOW-3", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/contact", priority: "P2" }),
    ],
    executions: [exec({ flowId: "FLOW-1", status: "PASS", steps: [stepExec("FLOW-1", { action: "open", reason: "products rendered" })] })],
  });
  const coverage = build(r, d);

  const ids = new Set(coverage.items.map(item => item.coverageId));
  for (const rec of coverage.testPlan) {
    assert.ok(rec.coverageIds.length > 0, `recommendation ${rec.recommendationId} has a target`);
    for (const id of rec.coverageIds) assert.ok(ids.has(id), `${rec.recommendationId} references existing item ${id}`);
  }

  assert.equal(coverage.summary.recommendations, coverage.testPlan.length);
  assert.equal(coverage.summary.pages.partial, 1, "one-of-three flows executed leaves the page partially covered");
  assert.equal(coverage.summary.pages.untested, 0);
});

test("M2: repeated edges across pages are counted once (dedupe)", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/products\\\"]\")" }),
      element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" }),
    ],
  });
  const d = discovery({
    pages: [
      pageNode({ id: "page-1", url: "https://qa.test/en", edges: [edge({ href: "https://qa.test/en/products" }), edge({ href: "https://qa.test/en/about" })] }),
      pageNode({ id: "page-2", url: "https://qa.test/en/about", edges: [edge({ fromPageId: "page-2", href: "https://qa.test/en/products" })] }),
    ],
    flows: [
      flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/products", priority: "P2" }),
      flow({ flowId: "FLOW-NAV2", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/about", priority: "P2" }),
    ],
    executions: [
      exec({ flowId: "FLOW-NAV", status: "PASS", steps: [stepExec("FLOW-NAV", { action: "open" })] }),
      exec({ flowId: "FLOW-NAV2", status: "PASS", steps: [stepExec("FLOW-NAV2", { action: "open" })] }),
    ],
  });
  const coverage = build(r, d);
  const nav = coverage.items.filter(item => item.category === "NAVIGATION");
  assert.equal(nav.length, 2, "two unique destinations, not three");
  assert.equal(nav.every(item => item.status === "TESTED"), true);
  assert.equal(coverage.summary.pages.tested, 2, "both pages fully executed");
});

test("M3: applyCoverageNotes only reprioritizes existing recommendations with P0-P4", () => {
  const r = report({
    elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" })],
  });
  const d = discovery({
    pages: [pageNode({ id: "page-1", url: "https://qa.test/en", edges: [edge({ href: "https://qa.test/en/about" })] })],
    flows: [flow({ flowId: "FLOW-NAV", category: "NAVIGATION", startPageId: "page-1", startUrl: "https://qa.test/en", dedupeKey: "nav:https://qa.test/en/about", priority: "P2" })],
  });
  const coverage = build(r, d);
  const recId = coverage.testPlan[0]!.recommendationId;

  const enhanced = applyCoverageNotes(coverage, {
    gaps: ["Human owner needed for the uncovered flow."],
    prioritization: [
      { recommendationId: recId, priority: "P0", reason: "do this first" },
      { recommendationId: "REC-999", priority: "P1", reason: "does not exist" },
      { recommendationId: recId, priority: "Q9" as FlowPriority, reason: "invalid priority" },
    ],
  }, "fixture-provider");

  assert.equal(enhanced.aiNotes?.provider, "fixture-provider");
  assert.deepEqual(enhanced.aiNotes?.gaps, ["Human owner needed for the uncovered flow."]);
  assert.equal(enhanced.testPlan.find(item => item.recommendationId === recId)?.priority, "P0", "existing rec reprioritized");
  assert.equal(enhanced.testPlan.find(item => item.recommendationId === "REC-999"), undefined, "unknown id never injected");
  assert.equal(enhanced.items.length, coverage.items.length, "items are never created or destroyed");
  assert.equal(enhanced.testPlan.length, coverage.testPlan.length);
});

// ---------------------------------------------------------------------------
// N. Hermetic real-browser pipeline: scan → analyze → execute search + nav →
//    coverage reflects the live outcome end-to-end.
// ---------------------------------------------------------------------------
test("N: real chromium scan→analyze→execute feeds the coverage map and the report", async () => {
  const server = createServer((request, response) => {
    const send = (body: string, status = 200) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    const head = (title: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>`;
    const url = request.url ?? "/";
    if (url === "/") return send(`${head("Generic Home")}<form action="/search"><input type="search" placeholder="Search" name="q"><button type="submit">Search</button></form><a href="/about">About</a><a href="/login">Log in</a></body></html>`);
    if (url === "/search") return send(`${head("Results")}<p>Some results for your query.</p></body></html>`);
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
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-cov-"));

  try {
    const { report: r } = await scanWebsite({ url: base, headed: false, timeout: 15000, outputPath: join(folder, "report.json"), concurrency: 1 });
    const analysis = await analyzeScan(r, { flowLimits: limits({ maxPages: 3, maxFlows: 10 }) });
    const flowDiscovery = analysis.flowDiscovery;
    assert.ok(flowDiscovery, "flowDiscovery present");
    assert.ok(analysis.coverage, "analyzeScan attaches deterministic coverage");
    assert.equal(analysis.summary.coverageSummary?.recommendations, analysis.coverage.testPlan.length);

    const flows = flowDiscovery.flows;
    const searchFlow = flows.find(flow => flow.category === "SEARCH");
    const navFlow = flows.find(flow => flow.category === "NAVIGATION");
    const authFlow = flows.find(flow => flow.category === "AUTHENTICATION");
    assert.ok(searchFlow && navFlow && authFlow, "search, nav, and auth flows discovered by the analyzer");

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const searchRun = await runFlow(page, searchFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
      const navRun = await runFlow(page, navFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
      const authRun = await runFlow(page, authFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });

      assert.equal(searchRun.status, "PASS", "search executes end-to-end");
      assert.equal(navRun.status, "PASS", "same-origin nav executes");
      assert.equal(authRun.status, "BLOCKED", "auth never completes");

      const executed: FlowDiscovery = {
        ...flowDiscovery,
        executions: [searchRun, navRun, authRun],
        summary: summaryFor({ ...flowDiscovery, executions: [searchRun, navRun, authRun] }),
      };

      const coverage = buildCoverage({ report: r, flowDiscovery: executed, findings: analysis.findings, verifications: [] });

      const startPage = coverage.items.find(item => item.coverageId === "COV-PAGE-001");
      assert.equal(startPage?.status, "PARTIALLY_TESTED", "all pre-auth flows green; auth stopped at boundary");

      const nav = coverage.items.find(item => item.category === "NAVIGATION");
      assert.equal(nav?.status, "TESTED", "the about navigation executed live");
      const searchCtrl = coverage.items.find(item => item.coverageId === "COV-SEARCH-001-CTRL");
      assert.equal(searchCtrl?.status, "TESTED");
      const auth = coverage.items.find(item => item.category === "AUTHENTICATION_BOUNDARY");
      assert.equal(auth?.status, "BLOCKED");

      assert.equal(new Set(coverage.items.map(item => item.coverageId)).size, coverage.items.length, "coverage ids are unique");

      const html = renderQaHtml({ ...analysis, coverage, summary: { ...analysis.summary, coverageSummary: coverage.summary } });
      assert.ok(html.includes("Coverage Overview"), "HTML report renders the coverage section");
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});