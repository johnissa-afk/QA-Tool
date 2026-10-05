// ---------------------------------------------------------------------------
// Phase 7A history tests. Deterministic + generic (https://qa.test), one live
// multi-run E2E (local http server, real browser). Fixtures A–R cover:
//   A  site identity stability across runs
//   B  element semantic identity survives locator/DOM-id churn
//   C  different sites → different identity + isolated buckets
//   D  config digest change → different site identity
//   E  run ids unique, filename-safe, timestamp-ordered
//   F  finding semantic key is stable and NEVER the generated id
//   G  flow signature / family keys are stable
//   H  coverage semantic key is stable and NEVER the coverage id
//   I  secrets are redacted from persisted artifacts
//   J  identityDigest deterministic and content-sensitive
//   K  snapshots are bounded (clipped, no secrets, no raw selectors)
//   L  persist → load round-trip, sorted runs, latestRunId
//   M  duplicate run refusal + per-site isolation in the store
//   N  load statuses (EMPTY / UNAVAILABLE / INCOMPATIBLE)
//   O  corrupt artifacts are excluded with warnings, never trusted
//   P  reset removes only history files
//   Q  index stays valid under repeated atomic writes
//   R  live multi-run E2E + report integration
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DiscoveredElement, ScanReport } from "../types.js";
import type { CoverageItem } from "../coverage/types.js";
import type { DiscoveredFlow, FlowCategory, FlowLimits, FlowStep, FlowStepAction, SitePageNode } from "../flow/types.js";
import type { QaAnalysis, QaFinding, QaSummary } from "../ai/types.js";
import { analyzeScan } from "../ai/index.js";
import { renderQaHtml, writeQaReport } from "../ai/report.js";
import { scanWebsite } from "../scanner.js";
import { defaultFlowLimits } from "../flow/index.js";
import {
  HISTORY_SCHEMA_VERSION,
  atomicWriteJson,
  buildRunSnapshot,
  findingHistoryKey,
  historySiteIdentityOf,
  historySiteKeyId,
  historySiteKeyOf,
  listSiteRunIds,
  loadIndex,
  loadSiteHistory,
  newRunId,
  persistRun,
  qaRunRecordOf,
  readRunSnapshot,
  resetHistory,
  sortKeys,
  stableJson,
  validateRunSnapshot,
} from "../history/index.js";

const limits = (overrides: Partial<FlowLimits> = {}): FlowLimits => ({ ...defaultFlowLimits(), ...overrides });

const tempFolder = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-history-"));

// ---------------------------------------------------------------------------
// Fixture builders (deterministic, generic).
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

const report = (overrides: Partial<Record<string, unknown>> & { elements?: DiscoveredElement[]; url?: string } = {}): ScanReport => {
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

const pageNode = (id: string, url: string): SitePageNode => ({ id, url, title: null, depth: 0, sourceReportUrl: url, navigationStatus: 200, brokenLinks: 0, controls: [], edges: [] });

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

const mkRun = (overrides: { report: ScanReport; findings?: QaFinding[]; flowDiscovery?: QaAnalysis["flowDiscovery"]; coverage?: CoverageItem[]; mode?: string; execution?: QaAnalysis["execution"]; generatedAt?: string }): QaAnalysis => {
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
    summary: emptySummary(),
  };
};

const sameStart = { startPageId: "page-1", startUrl: "https://qa.test/en" };

// ===========================================================================
// A: site identity is stable across identical runs
// ===========================================================================
test("A: site identity is deterministic across runs that target the same site+config", () => {
  const el = element({ accessibleName: "Submit", text: "Submit" });
  const run1 = mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-1", evidence: [{ type: "element", index: 0 }] })] });
  const run2 = mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-2", evidence: [{ type: "element", index: 0 }] })] });
  assert.deepEqual(historySiteKeyOf(run1), historySiteKeyOf(run2), "site key equal across runs");
  assert.equal(historySiteIdentityOf(run1), historySiteIdentityOf(run2), "site identity string equal across runs");
  const id1 = historySiteKeyId(historySiteKeyOf(run1));
  assert.equal(id1.length, 40, "bucket id is a sha1 digest");
  const snapshot1 = buildRunSnapshot(run1, { runId: "r1", startedAt: run1.generatedAt });
  const snapshot2 = buildRunSnapshot(run2, { runId: "r2", startedAt: run2.generatedAt });
  assert.deepEqual(snapshot1.siteKey, snapshot2.siteKey, "snapshot site keys match");
  assert.equal(snapshot1.siteIdentity, snapshot2.siteIdentity, "snapshot site identities match");
});

// ===========================================================================
// B: element semantic identity survives locator / DOM id churn
// ===========================================================================
test("B: same element semantic identity despite different DOM ids and locators", () => {
  const el1 = element({ id: "v1", testId: "legacy", accessibleName: "Confirm", text: "Confirm", recommendedLocator: "locator V1", href: null });
  const el2 = element({ id: "v2", testId: "new", accessibleName: "Confirm", text: "Confirm", recommendedLocator: "locator V2", href: null });
  const pageUrl = "https://qa.test/checkout";
  const run1 = mkRun({ report: report({ elements: [el1], url: pageUrl }), findings: [finding({ id: "QA-F-1", code: "button-unnamed", domain: "accessibility", evidence: [{ type: "element", index: 0, locator: "locator V1" }] })] });
  const run2 = mkRun({ report: report({ elements: [el2], url: pageUrl }), findings: [finding({ id: "QA-F-2", code: "button-unnamed", domain: "accessibility", evidence: [{ type: "element", index: 0, locator: "locator V2" }] })] });
  const sig1 = findingHistoryKey(run1, run1.findings[0]!);
  const sig2 = findingHistoryKey(run2, run2.findings[0]!);
  assert.equal(sig1.key, sig2.key, "semantic finding key survives locator/id churn");
  assert.equal(sig1.page, sig2.page, "page identity equal");
});

// ===========================================================================
// C: different sites → different identity and isolated buckets
// ===========================================================================
test("C: different origins produce different site identity and isolated store buckets", () => {
  const run1 = mkRun({ report: report({ url: "https://qa.test/en", elements: [] }) });
  const run2 = mkRun({ report: report({ url: "https://qa2.test/en", elements: [] }) });
  assert.notEqual(historySiteIdentityOf(run1), historySiteIdentityOf(run2), "different sites must never collide");
  const folder = tempFolder();
  try {
    const persisted1 = persistRun(run1, historySiteKeyOf(run1), folder, { startedAt: "2026-09-17T00:00:00.000Z" });
    const persisted2 = persistRun(run2, historySiteKeyOf(run2), folder, { startedAt: "2026-09-18T00:00:00.000Z" });
    assert.ok(persisted1.persisted && persisted2.persisted);
    const loaded1 = loadSiteHistory(historySiteKeyOf(run1), folder);
    assert.equal(loaded1.status, "AVAILABLE");
    assert.equal(loaded1.state!.runs.length, 1, "site 1 sees only its own run");
    assert.equal(listSiteRunIds(historySiteKeyOf(run1), folder).length, 1);
    assert.equal(listSiteRunIds(historySiteKeyOf(run2), folder).length, 1);
    assert.equal(loadSiteHistory(historySiteKeyOf(run2), folder).state!.runs.length, 1, "site 2 sees only its own run");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// D: config digest change → different site identity (execution layer differs)
// ===========================================================================
test("D: configuration change (execution layer) yields a different site identity", () => {
  const only = mkRun({ report: report({ elements: [] }), execution: { status: "passed", command: "", startedAt: null, durationMs: null, tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, reproduced: 0, notReproduced: 0, review: 0, infrastructureFailures: 0, failures: [] } });
  const plain = mkRun({ report: report({ elements: [] }), execution: null });
  assert.notEqual(historySiteKeyOf(only).configDigest, historySiteKeyOf(plain).configDigest, "execution layer changes the config digest");
  const folder = tempFolder();
  try {
    persistRun(only, historySiteKeyOf(only), folder, { startedAt: "2026-09-17T00:00:00.000Z" });
    const loaded = loadSiteHistory(historySiteKeyOf(plain), folder);
    assert.equal(loaded.status, "EMPTY", "history is isolated per configuration, not per domain alone");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// E: run ids unique, filename-safe, timestamp-ordered
// ===========================================================================
test("E: newRunId is unique, filename-safe and embeds an ordered timestamp", () => {
  const key = historySiteKeyOf(mkRun({ report: report({ elements: [] }) }));
  const id1 = newRunId(key, "2026-09-18T09:30:12.123Z");
  const id2 = newRunId(key, "2026-09-18T10:00:00.000Z");
  assert.match(id1, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/, "run id matches the documented format");
  assert.ok(!/[\\/:*?"<>|]/.test(id1), "run id is safe as a filename");
  assert.notEqual(id1, id2, "two distinct runs never share an id");
  assert.ok(id1.localeCompare(id2) < 0, "sorted ids order by startedAt");
  assert.equal(id1.slice(0, 10), "2026-09-18", "timestamp embedded in id");
});

// ===========================================================================
// F: finding semantic key is stable AND never the generated id
// ===========================================================================
test("F: snapshot finding identity is the semantic key, never QA-F-*", () => {
  const el = element({ accessibleName: "Proceed", text: "Proceed" });
  const run = mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-X1", code: "button-unnamed", domain: "accessibility", severity: "HIGH", evidence: [{ type: "element", index: 0 }] })] });
  const snapshot = buildRunSnapshot(run, { runId: "f-run", startedAt: run.generatedAt });
  assert.equal(snapshot.findings.length, 1);
  const record = snapshot.findings[0]!;
  assert.notEqual(record.semanticKey, "QA-F-X1", "semantic identity is not the regenerated id");
  assert.equal(record.findingId, "QA-F-X1", "findingId is kept only as a run-local reference");
  const sig = findingHistoryKey(run, run.findings[0]!);
  assert.equal(record.semanticKey, sig.key, "snapshot key equals the facade key");
  assert.equal(record.page, sig.page);
});

// ===========================================================================
// G: flow signature / family keys are stable
// ===========================================================================
test("G: flow signatures and families snapshot deterministically", () => {
  const flowA = flow({ flowId: "FLOW-G1", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:G1", steps: [step({ action: "open", targetUrl: "https://qa.test/en", expected: "loads" }), step({ action: "click", elementIndex: 0, locator: "btn", expected: "navigates" })] });
  const flowB = flow({ flowId: "FLOW-G2", category: "NAVIGATION", ...sameStart, dedupeKey: "nav:G2", steps: [step({ action: "open", targetUrl: "https://qa.test/en", expected: "loads" }), step({ action: "click", elementIndex: 0, locator: "different btn", expected: "navigates" })] });
  const discovery1 = { limits: limits({ maxPages: 2 }), graph: { sourceUrl: "https://qa.test/en", pages: [pageNode("page-1", "https://qa.test/en")] }, flows: [flowA], executions: [], summary: {} as never };
  const snapshot = buildRunSnapshot(mkRun({ report: report({ elements: [] }), flowDiscovery: discovery1 as never }), { runId: "g-run", startedAt: "2026-09-17T00:00:00.000Z" });
  assert.equal(snapshot.flows.length, 1);
  const record = snapshot.flows[0]!;
  assert.equal(record.familyKey, "NAVIGATION|https://qa.test/en", "family is category + normalized start page");
  assert.ok(record.signature.startsWith("NAVIGATION|https://qa.test/en|"), "signature pins the step sequence");
  assert.equal(record.steps.length, 2);
  assert.equal(record.steps[0]!.action, "open");
  assert.ok(record.signature.includes("open:https://qa.test/en"), "step targets feed the signature");
  assert.equal(record.flowId, "FLOW-G1", "flowId kept as run-local reference only");
});

// ===========================================================================
// H: coverage semantic key is stable AND never the coverage id
// ===========================================================================
test("H: coverage snapshot identity is the semantic key, never COV-*", () => {
  const item = coverageItem({ coverageId: "COV-PAGE-001", category: "PAGE", name: " Home Page Reachable ", url: "https://qa.test/en", pageId: "page-1" });
  const snap = buildRunSnapshot(mkRun({ report: report({ elements: [] }), coverage: [item] }), { runId: "h-run", startedAt: "2026-09-17T00:00:00.000Z" });
  assert.equal(snap.coverage.length, 1);
  const record = snap.coverage[0]!;
  assert.notEqual(record.semanticKey, "COV-PAGE-001", "semantic identity is not the regenerated id");
  assert.equal(record.coverageId, "COV-PAGE-001", "coverageId kept as run-local reference");
  assert.ok(record.semanticKey.startsWith("PAGE|https://qa.test/en|"), "key embeds category + location + name");
  assert.equal(snap.summary.coverageCount, 1);
});

// ===========================================================================
// I: secrets are redacted from persisted artifacts
// ===========================================================================
test("I: secrets in locators and text are redacted from snapshots", () => {
  const secret = "sup3r-S3cret-Passw0rd!";
  const prior = process.env.QA_PASSWORD;
  process.env.QA_PASSWORD = secret;
  try {
    const el = element({ accessibleName: "Submit", text: "Submit" });
    const run = mkRun({ report: report({ elements: [el] }), findings: [
      finding({ id: "QA-F-I1", code: "button-unnamed", evidence: [{ type: "element", index: 0, locator: `page.getByText(${JSON.stringify(secret)})` }] }),
      finding({
        id: "QA-F-I2",
        code: "text-broken",
        evidence: [],
        title: `auth to ${secret}`,
        verification: ver({ disposition: "REPRODUCED" }),
        description: `secret in description: ${secret}`,
      }),
    ] });
    const snapshot = buildRunSnapshot(run, { runId: "i-run", startedAt: run.generatedAt });
    const raw = JSON.stringify(snapshot);
    assert.ok(!raw.includes(secret), "the secret never reaches the persisted snapshot");
    const rawSnap = buildRunSnapshot(run, { runId: "i-run-raw", startedAt: run.generatedAt, redact: value => value });
    assert.ok(JSON.stringify(rawSnap).includes(secret), "the secret WAS present before redaction (sanity check)");
  } finally {
    if (prior === undefined) delete process.env.QA_PASSWORD;
    else process.env.QA_PASSWORD = prior;
  }
});

// ===========================================================================
// I2: identity contract survives redaction (siteKey/siteIdentity/runId/digest)
// ===========================================================================
test("I2: identity fields are never redacted while content is masked", () => {
  const redact = (value: string): string => value.replace(/qa\.test/g, "***.test");
  const run = mkRun({
    report: report({ elements: [element({ accessibleName: "Submit", text: "Submit" })] }),
    findings: [finding({ id: "QA-F-I2", code: "button-unnamed", evidence: [{ type: "element", index: 0 }], title: `login at https://qa.test/en` })],
  });
  const snap = buildRunSnapshot(run, { runId: "i2-run", startedAt: run.generatedAt, redact });
  assert.equal(snap.runId, "i2-run", "runId is identity, never redacted");
  assert.ok(snap.siteKey.origin.includes("qa.test"), "site origin is identity, never redacted");
  assert.ok(!snap.siteKey.origin.includes("***"), "site origin stays intact");
  assert.ok(snap.siteIdentity.includes("qa.test"), "site identity is identity, never redacted");
  assert.ok(!snap.siteIdentity.includes("***"), "site identity stays intact");
  assert.match(snap.identityDigest, /^[0-9a-f]{40}$/, "identityDigest preserved");
  assert.ok(snap.entryUrl.includes("***.test"), "content URL IS redacted");
  assert.ok(!snap.entryUrl.includes("qa.test"), "content URL no longer carries the masked token");
  assert.ok(!snap.findings[0]!.title.includes("qa.test"), "content text IS redacted");
});

// ===========================================================================
// J: identityDigest deterministic and content-sensitive
// ===========================================================================
test("J: identityDigest is stable for identical content and changes when content changes", () => {
  const el = element({ accessibleName: "Sign up", text: "Sign up" });
  const base = () => mkRun({ report: report({ elements: [el] }), findings: [finding({ id: "QA-F-J1", code: "button-unnamed", evidence: [{ type: "element", index: 0 }] })] });
  const run1 = base();
  const run2 = base();
  const snap1 = buildRunSnapshot(run1, { runId: "j1", startedAt: run1.generatedAt });
  const snap2 = buildRunSnapshot(run2, { runId: "j2", startedAt: run2.generatedAt });
  assert.equal(snap1.identityDigest, snap2.identityDigest, "identical semantics → identical digest");
  const changed = mkRun({ report: report({ elements: [element({ accessibleName: "Log in", text: "Log in" })] }), findings: [finding({ id: "QA-F-J3", code: "button-unnamed", evidence: [{ type: "element", index: 0 }] })] });
  const snap3 = buildRunSnapshot(changed, { runId: "j3", startedAt: changed.generatedAt });
  assert.notEqual(snap1.identityDigest, snap3.identityDigest, "different semantics → different digest");
});

// ===========================================================================
// K: snapshots are bounded (long text clipped, no raw volume)
// ===========================================================================
test("K: snapshot fields are clipped and bounded", () => {
  const long = "x".repeat(5000);
  const run = mkRun({ report: report({ elements: [] }), findings: [finding({ id: "QA-F-K1", code: "button-unnamed", title: long, description: long })] });
  const snapshot = buildRunSnapshot(run, { runId: "k-run", startedAt: run.generatedAt });
  assert.ok(snapshot.findings[0]!.title.length <= 201, "title is clipped");
  assert.ok(snapshot.findings[0]!.description.length <= 401, "description is clipped");
  assert.ok(JSON.stringify(snapshot).length < 20000, "snapshot stays small");
  assert.equal(snapshot.summary.findingCount, 1);
});

// ===========================================================================
// L: persist → load round-trip, sorted runs, latestRunId
// ===========================================================================
test("L: persistRun/loadSiteHistory round-trip keeps metadata and order", () => {
  const root = historySiteKeyOf(mkRun({ report: report({ elements: [] }) }));
  const folder = tempFolder();
  try {
    const run1 = mkRun({ report: report({ elements: [] }), generatedAt: "2026-09-17T00:00:00.000Z", findings: [finding({ id: "QA-F-L1", code: "button-unnamed", evidence: [{ type: "element", index: 0 }] })] });
    const run2 = mkRun({ report: report({ elements: [] }), generatedAt: "2026-09-18T00:00:00.000Z", findings: [finding({ id: "QA-F-L2", code: "button-unnamed", evidence: [{ type: "element", index: 0 }] })] });
    const p1 = persistRun(run1, historySiteKeyOf(run1), folder, { startedAt: run1.generatedAt });
    const p2 = persistRun(run2, historySiteKeyOf(run2), folder, { startedAt: run2.generatedAt });
    assert.ok(p1.persisted && p2.persisted);
    assert.ok(p1.runId && p2.runId);
    assert.ok(existsSync(join(p1.historyDir, "index.json")), "index written");
    assert.ok(existsSync(join(p1.historyDir, "runs", `${p1.runId}.json`)), "artifact written");

    const loaded = loadSiteHistory(root, folder);
    assert.equal(loaded.status, "AVAILABLE");
    assert.equal(loaded.state!.runs.length, 2);
    assert.equal(loaded.state!.latestRunId, p2.runId, "latestRunId is the newest run");
    const ids = loaded.state!.runs.map(r => r.runId);
    assert.deepEqual(ids, [...ids].sort(), "runs sorted by startedAt");
    assert.equal(loaded.state!.runs[0]!.findingCount, 1);

    const artifact = readRunSnapshot(folder, p1.runId!);
    assert.ok(artifact, "artifact is readable back");
    assert.equal(artifact!.runId, p1.runId);
    assert.equal(artifact!.schemaVersion, HISTORY_SCHEMA_VERSION);
    assert.equal(stableJson(JSON.parse(stableJson(artifact))), stableJson(artifact), "artifact round-trips through stable serialization");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// M: duplicate run ids are refused; runs never overwrite
// ===========================================================================
test("M: persisting an existing run id is refused, never overwritten", () => {
  const folder = tempFolder();
  try {
    const run = mkRun({ report: report({ elements: [] }), generatedAt: "2026-09-17T00:00:00.000Z" });
    const key = historySiteKeyOf(run);
    const first = persistRun(run, key, folder, { startedAt: run.generatedAt });
    assert.ok(first.persisted);
    const second = persistRun(run, key, folder, { startedAt: run.generatedAt, runId: first.runId! });
    assert.equal(second.persisted, false, "duplicate run id refuses to persist");
    assert.equal(second.duplicateRunId, true);
    const loaded = loadSiteHistory(key, folder);
    assert.equal(loaded.state!.runs.length, 1, "no duplicate record appears");
    assert.equal(loaded.warnings.length, 0, "no corruption warnings from a clean duplicate refusal");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// N: load statuses — EMPTY / UNAVAILABLE / INCOMPATIBLE
// ===========================================================================
test("N: load history reports EMPTY / UNAVAILABLE / INCOMPATIBLE correctly", () => {
  const key = historySiteKeyOf(mkRun({ report: report({ elements: [] }) }));
  const folder = tempFolder();
  try {
    assert.equal(loadSiteHistory(key, folder).status, "EMPTY", "missing directory → EMPTY");
    assert.equal(loadSiteHistory(key, folder).state, null, "no state for EMPTY");

    // artifacts exist but no index → UNAVAILABLE
    const dirWithArtifacts = join(folder, "artifacts-only");
    const artifactFile = join(dirWithArtifacts, "runs", "2026-09-17T00-00-00-000Z-aabbccdd.json");
    mkdirSync(join(dirWithArtifacts, "runs"), { recursive: true });
    writeFileSync(artifactFile, "{}", "utf8");
    assert.equal(loadSiteHistory(key, dirWithArtifacts).status, "UNAVAILABLE", "artifacts without index cannot be trusted");

    // malformed index → UNAVAILABLE
    const bad = join(folder, "bad-index");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "index.json"), "{ not json", "utf8");
    assert.equal(loadIndex(bad).status, "UNAVAILABLE");
    assert.equal(loadSiteHistory(key, bad).status, "UNAVAILABLE");

    // schema version too new → INCOMPATIBLE, and persist refuses
    const future = join(folder, "future");
    mkdirSync(future, { recursive: true });
    writeFileSync(join(future, "index.json"), JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION + 1, sites: [] }), "utf8");
    assert.equal(loadIndex(future).status, "INCOMPATIBLE");
    const refused = persistRun(mkRun({ report: report({ elements: [] }) }), key, future, { startedAt: "2026-09-17T00:00:00.000Z" });
    assert.equal(refused.persisted, false, "persist never overwrites incompatible history");
    assert.equal(refused.status, "INCOMPATIBLE");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// O: corrupt artifacts are excluded with warnings, never trusted
// ===========================================================================
test("O: corrupt run artifacts are excluded with warnings", () => {
  const key = historySiteKeyOf(mkRun({ report: report({ elements: [] }) }));
  const folder = tempFolder();
  try {
    const run = mkRun({ report: report({ elements: [] }), generatedAt: "2026-09-17T00:00:00.000Z" });
    const p = persistRun(run, key, folder, { startedAt: run.generatedAt });
    assert.ok(p.persisted);
    const artifactPath = join(p.historyDir, "runs", `${p.runId}.json`);
    const good = readFileSync(artifactPath, "utf8");
    writeFileSync(artifactPath, "{ broken json", "utf8");

    const loaded = loadSiteHistory(key, folder);
    assert.equal(loaded.status, "UNAVAILABLE", "all-corrupt artifacts → UNAVAILABLE");
    assert.ok(loaded.warnings.length === 1, "warning records the corruption");
    assert.match(loaded.reason ?? "", /invalid|excluded/i);

    // restore the good artifact → AVAILABLE again
    writeFileSync(artifactPath, good, "utf8");
    assert.equal(loadSiteHistory(key, folder).status, "AVAILABLE");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("O2: an artifact whose siteKey belongs to a different site is excluded", () => {
  const folder = tempFolder();
  try {
    const run = mkRun({ report: report({ url: "https://qa.test/en", elements: [] }), generatedAt: "2026-09-17T00:00:00.000Z" });
    const key = historySiteKeyOf(run);
    const p = persistRun(run, key, folder, { startedAt: run.generatedAt });
    const artifactPath = join(p.historyDir, "runs", `${p.runId}.json`);
    const raw = JSON.parse(readFileSync(artifactPath, "utf8"));
    raw.siteKey.origin = "https://evil.test";
    raw.siteIdentity = "https://evil.test|https://evil.test/en|abcdef1234567890abcdef1234567890abcdef12";
    writeFileSync(artifactPath, JSON.stringify(raw), "utf8");
    const loaded = loadSiteHistory(key, folder);
    assert.equal(loaded.status, "UNAVAILABLE", "wrong-site artifact is not trusted for this site");
    assert.ok(loaded.warnings.some(w => /different site/i.test(w)), "warning explains site isolation");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// P: reset removes only history files
// ===========================================================================
test("P: resetHistory removes only the history files and nothing else", () => {
  const folder = tempFolder();
  try {
    const key = historySiteKeyOf(mkRun({ report: report({ elements: [] }) }));
    persistRun(mkRun({ report: report({ elements: [] }) }), key, folder, { startedAt: "2026-09-17T00:00:00.000Z" });
    const sentinel = join(folder, "unrelated.txt");
    writeFileSync(sentinel, "keep me", "utf8");
    const reset = resetHistory(folder);
    assert.equal(reset.reset, true);
    assert.ok(reset.removed.some(p => p.endsWith("index.json")), "index removed");
    assert.ok(reset.removed.length >= 2, "index + run artifact removed");
    assert.ok(existsSync(sentinel), "unrelated file untouched");
    assert.equal(loadSiteHistory(key, folder).status, "EMPTY", "post-reset history is empty again");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// Q: index stays valid under repeated atomic writes + stable serialization
// ===========================================================================
test("Q: repeated persists keep the index valid and stableJson deterministic", () => {
  const folder = tempFolder();
  try {
    const key = historySiteKeyOf(mkRun({ report: report({ elements: [] }) }));
    for (let i = 1; i <= 5; i++) {
      const run = mkRun({ report: report({ elements: [] }), generatedAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` });
      const result = persistRun(run, key, folder, { startedAt: run.generatedAt });
      assert.ok(result.persisted, `persist ${i} succeeded`);
      const index = JSON.parse(readFileSync(join(folder, "index.json"), "utf8"));
      assert.equal(index.schemaVersion, HISTORY_SCHEMA_VERSION);
      assert.ok(Array.isArray(index.sites), "index remains a valid shape");
    }
    const loaded = loadSiteHistory(key, folder);
    assert.equal(loaded.status, "AVAILABLE");
    assert.equal(loaded.state!.runs.length, 5);

    const obj = { z: 1, a: { y: 2, b: 3 }, list: [{ id: "Q-F-2", code: "b" }, { id: "Q-F-1", code: "a" }] };
    assert.equal(stableJson(obj), stableJson(obj), "stable serialization deterministic");
    assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }), "keys sorted");
    const target = join(folder, "tmp.json");
    atomicWriteJson(target, { x: 1 });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { x: 1 }, "atomic write produces parseable JSON");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ===========================================================================
// validation unit checks
// ===========================================================================
const DIGEST = "abcdef1234567890abcdef1234567890abcdef12";
test("validateRunSnapshot rejects malformed artifacts", () => {
  const ok = { origin: "https://qa.test", normalizedStartPage: "https://qa.test/en", configDigest: DIGEST };
  assert.equal(validateRunSnapshot(null).ok, false);
  assert.equal(validateRunSnapshot("string").ok, false);
  assert.equal(validateRunSnapshot({ schemaVersion: HISTORY_SCHEMA_VERSION, runId: "", startedAt: "t", siteKey: ok, siteIdentity: "s", findings: [], flows: [], coverage: [], verifications: [] }).ok, false, "empty runId rejected");
  assert.equal(validateRunSnapshot({ schemaVersion: 999, runId: "r", startedAt: "t", siteKey: ok, siteIdentity: "s", findings: [], flows: [], coverage: [], verifications: [] }).ok, false, "unsupported schema rejected");
  assert.equal(validateRunSnapshot({ schemaVersion: HISTORY_SCHEMA_VERSION, runId: "a/b", startedAt: "t", siteKey: ok, siteIdentity: "s", findings: [], flows: [], coverage: [], verifications: [] }).ok, false, "path-unsafe runId rejected");
  const badSite = validateRunSnapshot({ schemaVersion: HISTORY_SCHEMA_VERSION, runId: "r", startedAt: "t", siteKey: { origin: "", normalizedStartPage: "y", configDigest: "zzzz" }, siteIdentity: "s", findings: [], flows: [], coverage: [], verifications: [] });
  assert.equal(badSite.ok, false, "empty origin rejected");
});

test("qaRunRecordOf mirrors the snapshot metadata", () => {
  const run = mkRun({ report: report({ elements: [] }), generatedAt: "2026-09-17T00:00:00.000Z", findings: [finding({ id: "QA-F-QA1", code: "button-unnamed", evidence: [{ type: "element", index: 0 }] })] });
  const snapshot = buildRunSnapshot(run, { runId: "rec-run", startedAt: run.generatedAt });
  const record = qaRunRecordOf(snapshot, { artifactPath: "reports/history/runs/rec-run.json" });
  assert.equal(record.runId, "rec-run");
  assert.equal(record.findingCount, 1);
  assert.equal(record.identityDigest, snapshot.identityDigest);
  assert.equal(record.artifactPath, "reports/history/runs/rec-run.json");
  assert.deepEqual(record.siteKey, snapshot.siteKey);
});

// ===========================================================================
// R: live multi-run E2E — two real runs persisted to the same history,
//    identical semantics → same site identity + identityDigest; report renders.
// ===========================================================================
test("R: live multi-run E2E persists both runs and renders the history section", async () => {
  const server = createServer((request, response) => {
    const send = (body: string, status = 200) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    const head = (title: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>`;
    const url = request.url ?? "/";
    if (url === "/") return send(`${head("History Home")}<a href="/about">About us</a><form action="/search"><input type="search" name="q" placeholder="Find"><button type="submit">Go</button></form><p>Welcome to the permanent fixture.</p></body></html>`);
    if (url === "/about") return send(`${head("About")}<p>About.</p></body></html>`);
    return send(`<html><body>not found</body></html>`, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const folder = tempFolder();
  try {
    const results: QaAnalysis[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { report: r } = await scanWebsite({ url: base, headed: false, timeout: 15000, outputPath: join(folder, `report${attempt}.json`), concurrency: 1 });
      const analysis = await analyzeScan(r, { flowLimits: limits({ maxPages: 3, maxFlows: 10 }) });
      assert.ok(analysis.findings.length >= 0);
      results.push(analysis);
    }
    const run1 = results[0]!;
    const run2 = results[1]!;

    assert.deepEqual(historySiteKeyOf(run1), historySiteKeyOf(run2), "both real runs share the same site identity");
    assert.equal(historySiteIdentityOf(run1), historySiteIdentityOf(run2));

    const snap1 = buildRunSnapshot(run1, { runId: "r1", startedAt: run1.generatedAt });
    const snap2 = buildRunSnapshot(run2, { runId: "r2", startedAt: run2.generatedAt });
    assert.equal(snap1.identityDigest, snap2.identityDigest, "identical live content → identical identity digest");
    assert.equal(snap1.summary.findingCount, snap2.summary.findingCount, "same finding surface in both runs");

    const key = historySiteKeyOf(run1);
    const p1 = persistRun(run1, key, folder, { startedAt: run1.generatedAt });
    const p2 = persistRun(run2, key, folder, { startedAt: run2.generatedAt });
    assert.ok(p1.persisted && p2.persisted, "both live runs persisted");
    assert.notEqual(p1.runId, p2.runId, "distinct run ids");

    const loaded = loadSiteHistory(key, folder);
    assert.equal(loaded.status, "AVAILABLE");
    assert.equal(loaded.state!.runs.length, 2, "two stored runs for the site");
    assert.equal(loaded.state!.latestRunId, p2.runId);

    const section = {
      status: "AVAILABLE" as const,
      schemaVersion: HISTORY_SCHEMA_VERSION,
      siteIdentity: historySiteIdentityOf(run2),
      currentRunId: p2.runId,
      runsAvailable: 2,
      historyDir: folder,
      note: "persisted",
    };
    const html = renderQaHtml({ ...run2, history: section });
    assert.ok(html.includes("QA History"), "HTML renders the QA History section");
    assert.ok(html.includes(p2.runId!), "HTML names the current run id");

    const writeFolder = join(folder, "report");
    const paths = writeQaReport({ ...run2, history: section }, join(writeFolder, "qa-analysis.json"));
    const reportJson = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    assert.equal(reportJson.history.runsAvailable, 2, "JSON carries the additive history section");

    // Reading back the persisted artifact from the actual store.
    const stored = readRunSnapshot(folder, p2.runId!);
    assert.ok(stored, "second run artifact readable from the store");
    assert.equal(stored!.siteIdentity, historySiteIdentityOf(run2), "artifact identity matches the live run");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});