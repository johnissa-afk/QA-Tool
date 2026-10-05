// ---------------------------------------------------------------------------
// Phase 7B — historical intelligence & trends. Deterministic unit + E2E tests.
//
// Every scenario persists real Phase 7A snapshots through the shared history
// store (persistRun) and then runs historicalIntelligenceForRuns over the
// loaded run records — the same path the CLI uses. Fixtures are generic
// (QA.test host) and never depend on a specific site.
//
// Coverage areas:
//   A   1 ordered run                 -> INSUFFICIENT_HISTORY / INSUFFICIENT_EVIDENCE
//   B   persisting finding (2 runs)   -> PERSISTING
//   C   re-tested absence             -> DISAPPEARED
//   D   absent + NOT_OBSERVED + never reproduced -> REVIEW_REQUIRED
//   E   absent + NOT_OBSERVED + reproduced before -> DISAPPEARED (with note)
//   F   new finding                   -> NEW
//   G   reappearing (gap, 3 runs)     -> REAPPEARED
//   H   strictly alternating          -> INTERMITTENT
//   I   erratic reappearing           -> RECURRING
//   J   unchanged / details changed   -> UNCHANGED / CHANGED
//   K   contradiction                 -> REVIEW_REQUIRED + preserved contradictions
//   L   same-family swap              -> REVIEW_REQUIRED (ambiguous identity)
//   M   ordering + bounded loading    -> sorted runs, maxRuns honored
//   N   ordering-unusable runs        -> unorderedRuns counted + excluded from claims
//   O   flow stability                -> STABLE / UNSTABLE / VARIABLE / INSUFFICIENT_EVIDENCE
//   P   coverage trends               -> STABLE / LOSS / GAIN / UNTESTED / NEW / CHANGED
//   Q   recurring infrastructure      -> RECURRING_INFRASTRUCTURE (>= 2 runs)
//   R   investigation queue           -> evidence-backed kinds + P1/P2/P3 priorities
//   S   relationships                 -> typed relationships derived from classifications
//   T   five-run E2E                  -> full lifecycle map (recurring->reappeared,
//                                        flow UNSTABLE, new finding, infra isolated,
//                                        digest, ai notes merge)
//   U   Phase 6 integration           -> root cause candidates surface on findings
//                                        of the latest run (read-only correlation)
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredElement } from "../types.js";
import type { DiscoveredFlow, FlowCategory, FlowLimits, FlowStep, FlowStepAction, SiteGraph } from "../flow/types.js";
import type { CoverageItem } from "../coverage/types.js";
import type { QaAnalysis, QaFinding, QaSummary } from "../ai/types.js";
import { defaultFlowLimits } from "../flow/index.js";
import { emptyFlowSummary } from "../flow/analysis.js";
import type { ScanReport } from "../types.js";
import {
  atomicWriteJson,
  buildRunSnapshot,
  historySiteKeyOf,
  loadSiteHistory,
  persistRun,
  readRunSnapshot,
} from "../history/index.js";
import type { QaRunRecord } from "../history/index.js";
import {
  applyHistoricalIntelligenceNotes,
  buildHistoricalIntelligenceDigest,
  buildHistoricalFlows,
  buildHistoricalFindings,
  classifyCoverageTrend,
  classifyFlowStability,
  deriveConfidence,
  HISTORICAL_INTELLIGENCE_SCHEMA_VERSION,
  historicalIntelligenceForRuns,
  loadOrderedRuns,
  pageCoverageStatus,
  relationCoverageStatus,
} from "../history-intelligence/index.js";

const limits = (overrides: Partial<FlowLimits> = {}): FlowLimits => ({ ...defaultFlowLimits(), ...overrides });

const tempFolder = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-history-intel-"));

// ---------------------------------------------------------------------------
// Deterministic fixture builders (mirror the Phase 7A test conventions).
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

const report = (overrides: { elements?: DiscoveredElement[]; url?: string } = {}): ScanReport => {
  const elements = overrides.elements ?? [];
  return {
    scan: { url: overrides.url ?? "https://qa.test/en", finalUrl: overrides.url ?? "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.length, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements,
    issues: [],
    links: [],
    consoleErrors: [],
    consoleDiagnostics: [],
    pageErrors: [],
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

type FixtureFlowOptions = Partial<DiscoveredFlow> & { flowId: string; category: FlowCategory; startPageId: string; startUrl: string; dedupeKey: string };
const flow = (overrides: FixtureFlowOptions): DiscoveredFlow => {
  const steps = overrides.steps ?? [step({ action: "open", targetUrl: overrides.startUrl, expected: "page loads" })];
  return {
    flowId: overrides.flowId,
    category: overrides.category,
    title: overrides.title ?? `${overrides.flowId} title`,
    description: overrides.description ?? "discovered flow",
    startPageId: overrides.startPageId,
    startUrl: overrides.startUrl,
    steps,
    safety: overrides.safety ?? (steps.every(s => s.safety === "SAFE") ? "SAFE" : "REVIEW"),
    automation: overrides.automation ?? (steps.every(s => s.automation === "AUTOMATED") ? "AUTOMATED" : "MANUAL"),
    boundary: overrides.boundary ?? null,
    executable: overrides.executable ?? steps.every(s => s.safety === "SAFE" && s.automation === "AUTOMATED"),
    priority: overrides.priority ?? "P2",
    priorityReason: overrides.priorityReason ?? "deterministic fixture priority.",
    confidence: overrides.confidence ?? "high",
    occurrenceCount: overrides.occurrenceCount ?? 1,
    dedupeKey: overrides.dedupeKey,
    evidence: [],
  };
};

const ver = (o: { disposition: NonNullable<QaFinding["verification"]>["disposition"] }) => ({
  disposition: o.disposition,
  scenarioId: null,
  status: o.disposition === "REPRODUCED" ? "REPRODUCED" as const : "NOT_REPRODUCED" as const,
  category: null,
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

const coverageItem = (overrides: Partial<CoverageItem> & { coverageId: string }): CoverageItem => ({
  coverageId: overrides.coverageId,
  category: overrides.category ?? "PAGE",
  name: overrides.name ?? `${overrides.coverageId} item`,
  status: overrides.status ?? "NOT_TESTED",
  reason: overrides.reason ?? "fixture coverage",
  safety: overrides.safety ?? "SAFE",
  executionStatus: overrides.executionStatus ?? null,
  pageId: overrides.pageId ?? "page-1",
  url: overrides.url ?? (overrides.pageId ? "https://qa.test/en" : null),
  relatedFlows: overrides.relatedFlows ?? [],
  relatedScenarios: overrides.relatedScenarios ?? [],
  relatedFindings: overrides.relatedFindings ?? [],
  evidence: overrides.evidence ?? [],
});

const emptySummary = (overrides: Partial<QaSummary> = {}): QaSummary => ({
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
  ...overrides,
});

type MkRunOptions = {
  report: ScanReport;
  findings?: QaFinding[];
  flowDiscovery?: QaAnalysis["flowDiscovery"];
  coverage?: CoverageItem[];
  mode?: string;
  execution?: QaAnalysis["execution"];
  generatedAt?: string;
  summary?: QaSummary;
};
const mkRun = (overrides: MkRunOptions): QaAnalysis => {
  const coverage = overrides.coverage
    ? { generatedAt: overrides.generatedAt ?? new Date().toISOString(), items: overrides.coverage, summary: {} as never, testPlan: [], aiNotes: null }
    : null;
  return {
    schemaVersion: 1,
    generatedAt: overrides.generatedAt ?? new Date().toISOString(),
    mode: (overrides.mode ?? "deterministic") as QaAnalysis["mode"],
    aiProvider: "deterministic",
    scan: overrides.report,
    findings: overrides.findings ?? [],
    flows: [],
    scenarios: [],
    elementScenarios: [],
    verifications: [],
    flowDiscovery: overrides.flowDiscovery ?? null,
    coverage,
    regression: null,
    intelligence: null,
    execution: overrides.execution ?? null,
    summary: overrides.summary ?? emptySummary(),
  };
};

const sameStart = { startPageId: "page-1", startUrl: "https://qa.test/en" };

/** Persist a sequence of deterministic runs in the desired completedAt order
 *  and return the loaded site run records (what the CLI passes to 7B). */
type PersistedRuns = { runs: QaRunRecord[]; siteIdentity: string };

function persistRuns(folder: string, runs: { analysis: QaAnalysis; runId: string; completedAt: string }[]): PersistedRuns {
  const key = historySiteKeyOf(runs[0]!.analysis);
  for (const run of runs) {
    const result = persistRun(run.analysis, key, folder, { startedAt: run.completedAt, completedAt: run.completedAt, runId: run.runId });
    assert.equal(result.persisted, true, `run ${run.runId} persisted`);
  }
  const loaded = loadSiteHistory(key, folder);
  assert.equal(loaded.status, "AVAILABLE", "history loads after persisting");
  assert.ok(loaded.state?.runs.length, "run records loaded");
  return { runs: loaded.state!.runs, siteIdentity: loaded.state!.runs[0]!.siteIdentity };
}

/** Convenience: one analysis per run, all sharing the same base report. */
function runsAt(folder: string, analyses: QaAnalysis[], ids: string[]): PersistedRuns {
  return persistRuns(
    folder,
    analyses.map((analysis, index) => ({ analysis, runId: ids[index]!, completedAt: buildStamp(index) })),
  );
}

const buildStamp = (dayOffset: number, subOffset = 0): string => new Date(Date.UTC(2026, 8, 20 + dayOffset, 0, 0, 0) + subOffset * 1000).toISOString();

const findingByKey = (map: ReturnType<typeof historicalIntelligenceForRuns>, key: string) => map!.findings.find(f => f.key === key);
const anyFinding = (map: ReturnType<typeof historicalIntelligenceForRuns>) => map!.findings[0];

// ===========================================================================
// A: one run -> INSUFFICIENT_HISTORY, single finding -> INSUFFICIENT_EVIDENCE
// ===========================================================================
test("A: single run yields INSUFFICIENT_HISTORY and never over-claims", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const analysis = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }] })],
  });
  const state = runsAt(folder, [analysis], ["r1"]);
  const map = historicalIntelligenceForRuns({ runs: state.runs, historyDir: folder, siteIdentity: state.siteIdentity, currentRunId: "r1" });
  assert.ok(map, "map produced");
  assert.equal(map.status, "INSUFFICIENT_HISTORY");
  assert.equal(map.schemaVersion, HISTORICAL_INTELLIGENCE_SCHEMA_VERSION);
  const historic = anyFinding(map);
  assert.ok(historic, "the single finding is carried");
  assert.equal(historic.lifecycle, "INSUFFICIENT_EVIDENCE");
  assert.equal(historic.confidence, "INSUFFICIENT");
  assert.equal(historic.runsObserved, 1);
  assert.equal(map.investigationQueue.length, 0, "never queue on a single observation");
  assert.ok(map.limitations.length > 0, "limitations are always reported");
});

// ===========================================================================
// B: persisting finding across 2 runs
// ===========================================================================
test("B: a finding present in both runs of a pair PERSISTS", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const build = () => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    coverage: [coverageItem({ coverageId: "c-en", url: "https://qa.test/en", status: "TESTED" })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const map = historicalIntelligenceForRuns({
    runs: runsAt(folder, [build(), build()], ["r1", "r2"]).runs,
    historyDir: folder,
    siteIdentity: "site-1",
    currentRunId: "r2",
  });
  assert.equal(map!.status, "AVAILABLE");
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "PERSISTING");
  assert.deepEqual(historic!.runIds, ["r1", "r2"]);
  assert.equal(historic!.runsObserved, 2);
  assert.equal(historic!.confidence, "MEDIUM", "HIGH requires 3+ ordered runs; two reproduced+covered runs are MEDIUM");
  assert.equal(historic!.confidenceReason.includes("directly reproduced/verified"), true);
  assert.deepEqual(historic!.reproducedRunIds, ["r1", "r2"]);
});

// ===========================================================================
// C: clean absence (re-tested) -> DISAPPEARED
// ===========================================================================
test("C: absence after a clean re-test is a DISAPPEARED finding", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run1 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const run2 = mkRun({
    report: report({ elements: [el] }),
    coverage: [coverageItem({ coverageId: "c-en", url: "https://qa.test/en", status: "TESTED" })],
    summary: emptySummary(),
  });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run1, run2], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "DISAPPEARED");
  assert.equal(historic!.latestDiscoveryVariance, "OBSERVED_AND_CLEAR");
  assert.notEqual(historic!.confidence, "INSUFFICIENT");
  assert.equal(historic!.runsAbsent, 1);
});

// ===========================================================================
// D: absent + NOT_OBSERVED + never reproduced -> REVIEW_REQUIRED
// ===========================================================================
test("D: an absent finding whose area was never re-tested is REVIEW_REQUIRED, not fixed", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run1 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "NOT_REPRODUCED" }) })],
    summary: emptySummary({ notReproduced: 1 }),
  });
  const run2 = mkRun({ report: report({ elements: [el] }), coverage: [coverageItem({ coverageId: "c-en", url: "https://qa.test/en", status: "NOT_TESTED" })] });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run1, run2], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "REVIEW_REQUIRED");
  assert.equal(historic!.latestDiscoveryVariance, "NOT_OBSERVED");
  assert.ok(historic!.reviewNote?.length, "absence needs a human note");
});

// ===========================================================================
// E: absent + NOT_OBSERVED but reproduced before -> DISAPPEARED with note
// ===========================================================================
test("E: an absent finding reproduced earlier is DISAPPEARED with an unresolved note", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run1 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const run2 = mkRun({ report: report({ elements: [el] }), coverage: [coverageItem({ coverageId: "c-en", url: "https://qa.test/en", status: "NOT_TESTED" })] });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run1, run2], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "DISAPPEARED");
  assert.equal(historic!.latestDiscoveryVariance, "NOT_OBSERVED");
  assert.ok(historic!.reviewNote?.length, "unresolved absence carries a review note");
});

// ===========================================================================
// F: new finding
// ===========================================================================
test("F: a finding that only appears in the latest run is NEW", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run1 = mkRun({ report: report({ elements: [] }) });
  const run2 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }] })],
  });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run1, run2], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "NEW");
  assert.equal(historic!.firstSeenRunId, "r2");
});

// ===========================================================================
// G: reappearing after a single absent run
// ===========================================================================
test("G: a finding that returns after one absent gap REAPPEARS", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const present = () => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const absent = () => mkRun({ report: report({ elements: [el] }), coverage: [coverageItem({ coverageId: "c-en", url: "https://qa.test/en", status: "TESTED" })] });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [present(), absent(), present()], ["r1", "r2", "r3"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r3" });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "REAPPEARED");
  assert.deepEqual(historic!.runIds, ["r1", "r2", "r3"]);
  assert.equal(historic!.runsObserved, 2);
  assert.equal(historic!.runsAbsent, 1);
});

// ===========================================================================
// H: strictly alternating -> INTERMITTENT
// ===========================================================================
test("H: a strictly alternating finding is INTERMITTENT", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const present = () => mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }] })] });
  const absent = () => mkRun({ report: report({ elements: [el] }) });
  const map = historicalIntelligenceForRuns({
    runs: runsAt(folder, [present(), absent(), present(), absent(), present()], ["r1", "r2", "r3", "r4", "r5"]).runs,
    historyDir: folder,
    siteIdentity: "site-1",
    currentRunId: "r5",
  });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "INTERMITTENT");
  assert.deepEqual(historic!.runIds, ["r1", "r2", "r3", "r4", "r5"]);
});

// ===========================================================================
// I: erratic reappearing with longer gaps -> RECURRING
// ===========================================================================
test("I: a finding that reappears with non-alternating gaps RECURS", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const present = () => mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }] })] });
  const absent = () => mkRun({ report: report({ elements: [el] }) });
  const map = historicalIntelligenceForRuns({
    runs: runsAt(folder, [present(), absent(), absent(), present(), absent(), present()], ["r1", "r2", "r3", "r4", "r5", "r6"]).runs,
    historyDir: folder,
    siteIdentity: "site-1",
    currentRunId: "r6",
  });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "RECURRING");
  assert.equal(historic!.runsObserved, 3);
});

// ===========================================================================
// J: unchanged vs details changed
// ===========================================================================
test("J: identical repeated findings stay UNCHANGED; a severity change CHANGES them", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const base = (severity: QaFinding["severity"], id: string) => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id, severity, title: `${id} title`, evidence: [{ type: "element", index: 0 }] })],
  });
  const unchanged = historicalIntelligenceForRuns({
    runs: runsAt(folder, [base("MEDIUM", "QA-F-1"), base("MEDIUM", "QA-F-1"), base("MEDIUM", "QA-F-1")], ["r1", "r2", "r3"]).runs,
    historyDir: folder,
    siteIdentity: "site-1",
    currentRunId: "r3",
  });
  assert.equal(anyFinding(unchanged)!.lifecycle, "UNCHANGED");

  const folder2 = tempFolder();
  const changed = historicalIntelligenceForRuns({
    runs: runsAt(folder2, [base("MEDIUM", "QA-F-1"), base("MEDIUM", "QA-F-1"), base("HIGH", "QA-F-1")], ["r1", "r2", "r3"]).runs,
    historyDir: folder2,
    siteIdentity: "site-1",
    currentRunId: "r3",
  });
  assert.equal(anyFinding(changed)!.lifecycle, "CHANGED");
});

// ===========================================================================
// K: contradiction -> REVIEW_REQUIRED, contradictions preserved
// ===========================================================================
test("K: a reproduced-then-clear finding is contradictory and REVIEW_REQUIRED", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run1 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const run2 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "NOT_REPRODUCED" }) })],
    summary: emptySummary({ notReproduced: 1 }),
  });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run1, run2], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  const historic = anyFinding(map);
  assert.equal(historic!.lifecycle, "REVIEW_REQUIRED");
  assert.equal(historic!.contradictions.length, 2, "both dispositions preserved");
  assert.equal(historic!.confidence, "LOW", "contradiction downgrades confidence");
});

// ===========================================================================
// L: same-family key swap -> ambiguous identity -> REVIEW_REQUIRED
// ===========================================================================
test("L: a same-family target swap is ambiguous identity, not a fix", () => {
  const folder = tempFolder();
  const alpha = element({ accessibleName: "Alpha", text: "Alpha" });
  const beta = element({ accessibleName: "Beta", text: "Beta" });
  const run1 = mkRun({ report: report({ elements: [alpha] }), findings: [finding({ id: "QA-F-A", evidence: [{ type: "element", index: 0 }] })] });
  const run2 = mkRun({ report: report({ elements: [beta] }), findings: [finding({ id: "QA-F-B", evidence: [{ type: "element", index: 0 }] })] });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run1, run2], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  const keyA = findingHistoryTestKey(run1);
  const historicA = findingByKey(map, keyA);
  assert.ok(historicA, "disappearing key still tracked");
  assert.equal(historicA!.lifecycle, "REVIEW_REQUIRED");
  assert.ok(historicA!.reviewNote?.includes("swapped"), "ambiguity is explained: family swapped targets");
});

/** Deterministic key of the first finding of a fixture analysis. */
function findingHistoryTestKey(analysis: QaAnalysis): string {
  const snapshot = buildRunSnapshot(analysis, { runId: "probe", startedAt: analysis.generatedAt });
  return snapshot.findings[0]!.semanticKey;
}

// ===========================================================================
// M: ordering + bounded loading
// ===========================================================================
test("M: runs are ordered by completedAt and maxRuns bounds the analyzed window", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  const analyses = Array.from({ length: 5 }, (_, index) =>
    mkRun({
      report: report({ elements: [el] }),
      findings: [finding({ id: `QA-F-${index}`, title: `finding ${ids[index]}`, evidence: [{ type: "element", index: 0 }] })],
    }),
  );
  // Persist intentionally out of completion order (r4, r1, r5, r3, r2).
  persistRuns(folder, [
    { analysis: analyses[3]!, runId: "r4", completedAt: buildStamp(3) },
    { analysis: analyses[0]!, runId: "r1", completedAt: buildStamp(0) },
    { analysis: analyses[4]!, runId: "r5", completedAt: buildStamp(4) },
    { analysis: analyses[2]!, runId: "r3", completedAt: buildStamp(2) },
    { analysis: analyses[1]!, runId: "r2", completedAt: buildStamp(1) },
  ]);
  const loaded = loadSiteHistory(historySiteKeyOf(analyses[0]!), folder);
  assert.ok(loaded.state, "history state loaded");
  const stateRuns = loaded.state!.runs;
  const siteIdentity = stateRuns[0]!.siteIdentity;
  const full = historicalIntelligenceForRuns({ runs: stateRuns, historyDir: folder, siteIdentity, currentRunId: "r5" });
  assert.deepEqual(full!.summary.orderedRuns, 5);
  assert.deepEqual(full!.findings.map(f => f.runIds).flat(), ["r1", "r2", "r3", "r4", "r5"], "ordered by completedAt regardless of insertion");

  const bounded = historicalIntelligenceForRuns({ runs: stateRuns, historyDir: folder, siteIdentity, currentRunId: "r5", maxRuns: 3 });
  assert.equal(bounded!.summary.orderedRuns, 3);
  const boundedRunIds = [...new Set(bounded!.findings.flatMap(f => f.runIds))];
  assert.deepEqual(boundedRunIds.sort(), ["r3", "r4", "r5"], "only the 3 most recent ordered runs are analyzed");
});

// ===========================================================================
// N: ordering-unusable runs are counted but never used for claims
// ===========================================================================
test("N: runs without a usable completedAt are excluded from pattern claims", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run = () => mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }] })] });
  const state = runsAt(folder, [run(), run(), run()], ["r1", "r2", "r3"]);
  const unorderedRuns = state.runs.map(record => ({ ...record, completedAt: null }));
  const map = historicalIntelligenceForRuns({ runs: unorderedRuns, historyDir: folder, siteIdentity: state.siteIdentity, currentRunId: "r3" });
  assert.equal(map!.summary.unorderedRuns, 3);
  assert.equal(map!.summary.orderedRuns, 0);
  assert.equal(map!.findings.length, 0, "no usable ordering -> no lifecycle timelines at all");
  assert.ok(map!.limitations.some(line => line.includes("were counted but never used for pattern claims")), "limitations name the unusable runs");
});

/** A deterministic (flowDiscovery) document using a single-page graph. */
const flowDiscoveryOf = (discoveredFlows: DiscoveredFlow[]): QaAnalysis["flowDiscovery"] => ({
  limits: limits(),
  graph: { sourceUrl: "https://qa.test/en", pages: [], edges: [] } as unknown as SiteGraph,
  flows: discoveredFlows,
  executions: [],
  summary: emptyFlowSummary(),
});

// ===========================================================================
// O: flow stability
// ===========================================================================
test("O: flow stability is STABLE / UNSTABLE / INSUFFICIENT_EVIDENCE with real outcomes", () => {
  const flowRun = (flowId: string, executionStatus: "PASS" | "REPRODUCED"): QaAnalysis =>
    mkRun({
      report: report({ elements: [] }),
      flowDiscovery: flowDiscoveryOf([flow({ flowId, category: "NAVIGATION", ...sameStart, dedupeKey: "flow-1" })]),
      coverage: [
        coverageItem({
          coverageId: `c-${flowId}`,
          category: "FLOW",
          name: `flow ${flowId}`,
          status: "TESTED",
          executionStatus,
          relatedFlows: [flowId],
        }),
      ],
      summary: emptySummary({ flowsDetected: 1 }),
    });

  // STABLE — three passes, identical signature.
  {
    const folder = tempFolder();
    const runs = [flowRun("f-1", "PASS"), flowRun("f-2", "PASS"), flowRun("f-3", "PASS")];
    const map = historicalIntelligenceForRuns({ runs: runsAt(folder, runs, ["r1", "r2", "r3"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r3" });
    const record = map!.flows[0]!;
    assert.equal(record.stability, "STABLE");
    assert.equal(record.confidence, "HIGH");
    assert.deepEqual(record.failureRunIds, []);
  }

  // UNSTABLE — flips between pass and fail.
  {
    const folder = tempFolder();
    const runs = [flowRun("f-1", "PASS"), flowRun("f-2", "REPRODUCED"), flowRun("f-3", "PASS")];
    const map = historicalIntelligenceForRuns({ runs: runsAt(folder, runs, ["r1", "r2", "r3"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r3" });
    const record = map!.flows[0]!;
    assert.equal(record.stability, "UNSTABLE");
    assert.deepEqual(record.failureRunIds, ["r2"]);
  }

  // INSUFFICIENT_EVIDENCE — one outcome only.
  {
    const folder = tempFolder();
    const runs = [flowRun("f-1", "PASS")];
    const map = historicalIntelligenceForRuns({ runs: runsAt(folder, runs, ["r1"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r1" });
    const record = map!.flows[0]!;
    assert.equal(record.stability, "INSUFFICIENT_EVIDENCE");
  }
});

// ===========================================================================
// P: coverage trends
// ===========================================================================
test("P: coverage trends report gain, loss, gaps, and stability without loss-by-absence", () => {
  const folder = tempFolder();
  const rundef = (coverage: CoverageItem[]): QaAnalysis => mkRun({
    report: report({ elements: [] }),
    coverage,
    summary: emptySummary(),
  });
  const item = (id: string, url: string | null, status: string): CoverageItem =>
    coverageItem({ coverageId: id, name: id, status: status as CoverageItem["status"], url: url ?? undefined, pageId: url ? "page-1" : undefined });

  // en: tested every run -> STABLE. checkout: tested then untested -> LOSS.
  // about: never tested -> PERSISTENTLY_UNTESTED. gains: untested then tested -> GAIN.
  // changing: exercised/blocked/exercised -> CHANGED. cart: only last run -> NEWLY_TESTED.
  const r1 = rundef([
    item("c-en", "https://qa.test/en", "TESTED"),
    item("c-checkout", "https://qa.test/checkout", "TESTED"),
    item("c-about", "https://qa.test/about", "NOT_TESTED"),
    item("c-gains", "https://qa.test/gains", "NOT_TESTED"),
    item("c-changing", "https://qa.test/changing", "TESTED"),
  ]);
  const r2 = rundef([
    item("c-en", "https://qa.test/en", "TESTED"),
    item("c-checkout", "https://qa.test/checkout", "TESTED"),
    item("c-about", "https://qa.test/about", "NOT_TESTED"),
    item("c-gains", "https://qa.test/gains", "NOT_TESTED"),
    item("c-changing", "https://qa.test/changing", "BLOCKED"),
  ]);
  const r3 = rundef([
    item("c-en", "https://qa.test/en", "TESTED"),
    item("c-checkout", "https://qa.test/checkout", "NOT_TESTED"),
    item("c-about", "https://qa.test/about", "NOT_TESTED"),
    item("c-gains", "https://qa.test/gains", "TESTED"),
    item("c-changing", "https://qa.test/changing", "TESTED"),
  ]);
  const r4 = rundef([
    item("c-en", "https://qa.test/en", "TESTED"),
    item("c-cart", "https://qa.test/cart", "TESTED"),
    item("c-about", "https://qa.test/about", "NOT_TESTED"),
    item("c-gains", "https://qa.test/gains", "TESTED"),
    item("c-changing", "https://qa.test/changing", "PARTIALLY_TESTED"),
  ]);
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [r1, r2, r3, r4], ["r1", "r2", "r3", "r4"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r4" });

  // Look up trend records by their stable fixture `name` (== coverageId).
  const trendOf = (id: string) => map!.coverage.find(c => c.name === id)?.trend;
  assert.equal(trendOf("c-en"), "COVERAGE_STABLE");
  assert.equal(trendOf("c-checkout"), "COVERAGE_LOSS");
  assert.equal(trendOf("c-about"), "PERSISTENTLY_UNTESTED");
  assert.equal(trendOf("c-gains"), "COVERAGE_GAIN");
  assert.equal(trendOf("c-changing"), "COVERAGE_CHANGED");
  assert.equal(trendOf("c-cart"), "NEWLY_TESTED");

  // Single run -> INSUFFICIENT_EVIDENCE (unit level, documented separately too).
  const single = classifyCoverageTrend(["TESTED"], [true]);
  assert.equal(single.trend, "INSUFFICIENT_EVIDENCE");
});

// ===========================================================================
// Q: recurring infrastructure (>= 2 runs) — isolated from product claims
// ===========================================================================
test("Q: infrastructure problems recur independently of product behavior", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run = (infra: number) => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1, infrastructureProblems: infra }),
  });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [run(1), run(2)], ["r1", "r2"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r2" });
  assert.equal(map!.infrastructure.length, 1);
  const infra = map!.infrastructure[0]!;
  assert.equal(infra.infrastructureId, "INFRASTRUCTURE");
  assert.deepEqual(infra.runIds, ["r1", "r2"]);
  assert.equal(infra.count, 2);
  assert.equal(map!.flows.length, 0, "infrastructure never manufactures flow/product claims");
});

// ===========================================================================
// R: investigation queue — evidence-backed kinds, P1/P2/P3
// ===========================================================================
test("R: the investigation queue ranks evidence-backed signals and never queues speculation", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  // Finding A appears in runs 2-3 only (PERSISTING), HIGH severity, reproduced.
  const first = () => mkRun({
    report: report({ elements: [el] }),
    coverage: [
      coverageItem({ coverageId: "c-about", url: "https://qa.test/about", status: "NOT_TESTED" }),
    ],
    summary: emptySummary(),
  });
  const later = (infra: number) => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    coverage: [
      coverageItem({ coverageId: "c-about", url: "https://qa.test/about", status: "NOT_TESTED" }),
    ],
    summary: emptySummary({ reproduced: 1, infrastructureProblems: infra }),
  });
  const map = historicalIntelligenceForRuns({ runs: runsAt(folder, [first(), later(1), later(2)], ["r1", "r2", "r3"]).runs, historyDir: folder, siteIdentity: "site-1", currentRunId: "r3" });

  const queue = map!.investigationQueue;
  assert.ok(queue.length >= 3, "finding + gap + infrastructure are queued");
  const firstEntry = queue[0]!;
  assert.equal(firstEntry.kind, "PERSISTENT_HIGH_SEVERITY");
  assert.equal(firstEntry.priority, "P1");
  assert.equal(firstEntry.entryId, "HIQ-001");
  assert.equal(firstEntry.priorityReason, "Priority P1: high severity, reproduced in multiple runs, recurring across runs.");

  const gapEntry = queue.find(entry => entry.kind === "PERSISTENT_COVERAGE_GAP");
  assert.ok(gapEntry, "a persisting un-tested area is queued");
  assert.equal(gapEntry!.priority, "P2");
  const infraEntry = queue.find(entry => entry.kind === "RECURRING_INFRASTRUCTURE");
  assert.ok(infraEntry, "recurring infrastructure is queued");
  assert.equal(infraEntry!.priority, "P3", "two-run infra (not yet recurring, not product severity) is a P3");
  assert.ok(queue.every(entry => entry.kind && entry.runIds.length >= 1), "entries always carry evidence");

  // A genuinely never-observed finding is never queued.
  const folder2 = tempFolder();
  const alone = mkRun({ report: report({ elements: [] }), findings: [] });
  const single = historicalIntelligenceForRuns({ runs: runsAt(folder2, [alone], ["r1"]).runs, historyDir: folder2, siteIdentity: "site-1", currentRunId: "r1" });
  assert.equal(single!.investigationQueue.length, 0);
});

// ===========================================================================
// S: typed historical relationships
// ===========================================================================
test("S: relationships are typed, evidence-derived, and confidence-aware", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const present = () => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-1", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const map = historicalIntelligenceForRuns({
    runs: runsAt(folder, [present(), present(), present()], ["r1", "r2", "r3"]).runs,
    historyDir: folder,
    siteIdentity: "site-1",
    currentRunId: "r3",
  });
  const kinds = map!.relationships.map(r => r.kind);
  assert.ok(kinds.includes("PERSISTS_ACROSS_RUNS"), "persisting relationship derived");
  assert.ok(kinds.includes("SUPPORTED_BY_RUN"), "reproduced support derived");
  assert.ok(map!.relationships.every(r => r.confidence !== "INSUFFICIENT"), "relationships never carry INSUFFICIENT confidence");
  assert.ok(map!.relationships.every(r => /^REL-\d{3}$/.test(r.relationshipId)), "relationships are deterministically identified");
});

// ===========================================================================
// T: five-run end-to-end lifecycle map
// ===========================================================================
test("T: five-run E2E — recurring finding, unstable flow, new finding, isolated infra, digest", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const el2 = element({ accessibleName: "Search", text: "Search" });
  const flowRun = (flowId: string, executionStatus: "PASS" | "REPRODUCED"): QaAnalysis["flowDiscovery"] =>
    flowDiscoveryOf([flow({ flowId, category: "NAVIGATION", ...sameStart, dedupeKey: "flow-1" })]);
  const flowCoverage = (flowId: string, executionStatus: "PASS" | "REPRODUCED"): CoverageItem =>
    coverageItem({ coverageId: `c-${flowId}`, category: "FLOW", name: `flow ${flowId}`, status: "TESTED", executionStatus, relatedFlows: [flowId] });

  const run1 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-A", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    flowDiscovery: flowRun("fa-1", "PASS"),
    coverage: [flowCoverage("fa-1", "PASS")],
    summary: emptySummary({ reproduced: 1, flowsDetected: 1 }),
  });
  const run2 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-A", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    flowDiscovery: flowRun("fa-2", "PASS"),
    coverage: [flowCoverage("fa-2", "PASS")],
    summary: emptySummary({ reproduced: 1, flowsDetected: 1 }),
  });
  // Run 3: finding A ABSENT (area exists but wasn't exercised), flow A FAILS.
  const run3 = mkRun({
    report: report({ elements: [el] }),
    flowDiscovery: flowRun("fa-3", "REPRODUCED"),
    coverage: [flowCoverage("fa-3", "REPRODUCED"), coverageItem({ coverageId: "c-en", url: "https://qa.test/en", status: "NOT_TESTED" })],
    summary: emptySummary({ flowsDetected: 1 }),
  });
  // Run 4: finding A back (reproduced), flow A passes.
  const run4 = mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id: "QA-F-A", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    flowDiscovery: flowRun("fa-4", "PASS"),
    coverage: [flowCoverage("fa-4", "PASS")],
    summary: emptySummary({ reproduced: 1, flowsDetected: 1 }),
  });
  // Run 5: A persists (reproduced), B appears, ONE infra problem (isolated).
  const run5 = mkRun({
    report: report({ elements: [el, el2] }),
    findings: [
      finding({ id: "QA-F-A", severity: "HIGH", evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) }),
      finding({ id: "QA-F-B", severity: "MEDIUM", code: "button-missing-name", evidence: [{ type: "element", index: 1 }] }),
    ],
    flowDiscovery: flowRun("fa-5", "PASS"),
    coverage: [flowCoverage("fa-5", "PASS")],
    summary: emptySummary({ reproduced: 1, flowsDetected: 1, infrastructureProblems: 1 }),
  });

  const state = runsAt(folder, [run1, run2, run3, run4, run5], ["r1", "r2", "r3", "r4", "r5"]);
  const map = historicalIntelligenceForRuns({ runs: state.runs, historyDir: folder, siteIdentity: state.siteIdentity, currentRunId: "r5" });

  assert.equal(map!.status, "AVAILABLE");
  assert.equal(map!.summary.orderedRuns, 5);

  const a = findingByKey(map, findingHistoryTestKey(run1))!;
  assert.equal(a.lifecycle, "REAPPEARED", "presence [T,T,F,T,T] with one gap -> REAPPEARED");
  assert.deepEqual(a.runIds, ["r1", "r2", "r3", "r4", "r5"]);
  assert.equal(a.reproducedRunIds.length, 4);
  assert.equal(a.contradictions.length, 0, "no contradiction in this timeline");

  const b = findingByKey(map, secondFindingKey(run5))!;
  assert.ok(b, "finding B is tracked");
  assert.equal(b.lifecycle, "NEW");
  assert.equal(b.firstSeenRunId, "r5");

  const flowRecord = map!.flows[0]!;
  assert.equal(flowRecord.stability, "UNSTABLE", "single flip between pass and fail across 5 runs");
  assert.deepEqual(flowRecord.failureRunIds, ["r3"]);

  assert.equal(map!.infrastructure.length, 0, "a single infra occurrence is not a recurring signal");
  assert.ok(map!.investigationQueue.some(entry => entry.kind === "REAPPEARED_HIGH_SEVERITY"), "reappeared high-severity finding is queued");

  // Digest + AI notes.
  const digest = buildHistoricalIntelligenceDigest(map!);
  assert.equal(digest.runsAnalyzed, 5);
  assert.equal(digest.summary.reappeared, 1);
  assert.equal(digest.queue[0]!.priority, "P1");
  const enhanced = applyHistoricalIntelligenceNotes(map!, { headline: "Repeated search flows flaked once and recovered." }, "openai");
  assert.equal(enhanced.aiNotes!.headline, "Repeated search flows flaked once and recovered.");
  assert.equal(enhanced.aiNotes!.provider, "openai");
});

/** Internal helper to derive a second finding's semantic key from the map. */
function secondFindingKey(analysis: QaAnalysis): string {
  const snapshot = buildRunSnapshot(analysis, { runId: "probe2", startedAt: analysis.generatedAt });
  return snapshot.findings.find(f => f.findingId === "QA-F-B")!.semanticKey;
}

// ---------------------------------------------------------------------------
// U: Phase 6 integration — root-cause candidates are read-only added to the
//    historical timeline of the latest run's findings.
// ---------------------------------------------------------------------------
test("U: root cause candidates from the latest run surface on historical findings", () => {
  const folder = tempFolder();
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run = (id: string) => mkRun({
    report: report({ elements: [el] }),
    findings: [finding({ id, evidence: [{ type: "element", index: 0 }], verification: ver({ disposition: "REPRODUCED" }) })],
    summary: emptySummary({ reproduced: 1 }),
  });
  const state = runsAt(folder, [run("QA-F-1"), run("QA-F-1")], ["r1", "r2"]);

  // Attach a Phase 6 root-cause candidate to the latest run's persisted artifact.
  const latestPath = join(folder, "runs", "r2.json");
  const snapshot = readRunSnapshot(folder, "r2")!;
  const patched = {
    ...snapshot,
    intelligence: {
      generatedAt: snapshot.completedAt,
      candidates: 1,
      actionable: 1,
      investigationRequired: 0,
      insufficientEvidence: 0,
      informational: 0,
      highConfidence: 1,
      mediumConfidence: 0,
      lowConfidence: 0,
      insufficientConfidence: 0,
      relationships: 0,
      contradictions: 0,
      investigationQueue: 1,
      rootCauseCandidates: [
        {
          candidateId: "RC-0001",
          pattern: "MISSING_NAME_ON_SEARCHABLE_BUTTON",
          status: "ACTIONABLE",
          confidence: "HIGH",
          title: "Search button lacks an accessible name",
          findingIds: ["QA-F-1"],
          flowIds: [],
          affectedPages: ["https://qa.test/en"],
        },
      ],
    },
  };
  atomicWriteJson(latestPath, patched);

  const map = historicalIntelligenceForRuns({ runs: state.runs, historyDir: folder, siteIdentity: state.siteIdentity, currentRunId: "r2" });
  const key = findingHistoryTestKey(run("QA-F-1"));
  const historic = findingByKey(map, key)!;
  assert.equal(historic.relatedCandidates.length, 1, "candidate correlated to the finding of the latest run");
  assert.equal(historic.relatedCandidates[0]!.candidateId, "RC-0001");
  assert.equal(historic.relatedCandidates[0]!.pattern, "MISSING_NAME_ON_SEARCHABLE_BUTTON");
});

// ---------------------------------------------------------------------------
// Sanity: primitives exported for consumers stay deterministic and generic.
// ---------------------------------------------------------------------------
test("confirm export surface exposes deterministic primitives", () => {
  assert.equal(typeof loadOrderedRuns, "function");
  assert.equal(typeof relationCoverageStatus, "function");
  assert.equal(typeof pageCoverageStatus, "function");
  assert.equal(typeof buildHistoricalFindings, "function");
  assert.equal(typeof buildHistoricalFlows, "function");
  assert.equal(typeof classifyFlowStability, "function");
  assert.equal(typeof classifyCoverageTrend, "function");
  assert.equal(typeof deriveConfidence, "function");
  const flowResult = classifyFlowStability([]);
  assert.equal(flowResult.stability, "INSUFFICIENT_EVIDENCE");
});