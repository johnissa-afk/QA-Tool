import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../dashboard/server.js";
import { findingSignature } from "../regression/identity.js";
import type { QaFinding } from "../ai/types.js";
import type { DiscoveredElement } from "../types.js";



const tempDir = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-explorer-"));

const URL = "https://qa.test/en";
const SITE_IDENTITY = "https://qa.test|https://qa.test/en|cfg";
const DIGEST = "0123456789abcdef0123456789abcdef01234567";

const elements: DiscoveredElement[] = [
  {
    tag: "img", role: null, text: "", ariaLabel: null, placeholder: null, name: null, id: null, testId: null,
    type: null, hasExplicitType: false, autocomplete: null, href: null, alt: null, visible: true, enabled: true,
    boundingBox: null, interactive: false, accessibleName: null, recommendedLocator: "img[alt='']", locatorQuality: "medium",
  },
  {
    tag: "button", role: "button", text: "Submit order", ariaLabel: null, placeholder: null, name: null, id: null,
    testId: null, type: "submit", hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true,
    enabled: true, boundingBox: null, interactive: true, accessibleName: "Submit order",
    recommendedLocator: "button[name='Submit order']", locatorQuality: "high",
  },
];

const findings: QaFinding[] = [
  {
    id: "QA-F-001", code: "IMG-001", status: "FAIL", lifecycle: "REPRODUCED", domain: "accessibility", severity: "HIGH",
    confidence: "high", relatedScenarioIds: ["SC-VER-001"],
    verification: { disposition: "REPRODUCED", scenarioId: "SC-VER-001", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", reason: "Live DOM matched the suspected condition.", safety: "safe", locator: "img[alt='']", executedAt: "2026-09-21T00:00:02.000Z", durationMs: 120, error: null },
    title: "Image is missing descriptive alt text", description: "The logo image ships with an empty alt attribute.",
    recommendation: "Provide descriptive alt text for the image.", userImpact: "Screen reader users cannot interpret the image.",
    rationale: "The image is informative and has no textual equivalent.", count: 1, occurrences: 1,
    evidence: [{ type: "element", index: 0 }],
  },
  {
    id: "QA-F-002", code: "LNK-001", status: "WARNING", lifecycle: "NOT_REPRODUCED", domain: "navigation", severity: "MEDIUM",
    confidence: "medium", relatedScenarioIds: [],
    verification: { disposition: "NOT_REPRODUCED", scenarioId: "SC-VER-002", status: "NOT_REPRODUCED", category: "EXPECTATION", verdict: "NOT_REPRODUCED", reason: "The link resolves correctly on retry.", safety: "safe", locator: "a[href='/broken']", executedAt: null, durationMs: null, error: null },
    title: "Broken internal link", description: "A link resolves to a 404 response.",
    recommendation: "Point the link at an existing page.", userImpact: "Users hitting the link land on an error page.",
    rationale: "The crawl recorded a 404 for this destination.", count: 1, occurrences: 1,
    evidence: [{ type: "link", index: 0 }],
  },
  {
    id: "QA-F-003", code: "CNS-001", status: "INFO", lifecycle: "ANALYZED", domain: "console", severity: "LOW",
    confidence: "low", relatedScenarioIds: [], verification: null,
    title: "Console network error", description: "The page logs a failed resource load.",
    recommendation: "Investigate the failing network request.", userImpact: "Possible degraded resource loading.",
    rationale: "A first-party network diagnostic was recorded.", count: 1, occurrences: 1,
    evidence: [{ type: "console", index: 0 }],
  },
  {
    id: "QA-F-004", code: "PG-001", status: "FAIL", lifecycle: "TEST_GENERATED", domain: "robustness", severity: "MEDIUM",
    confidence: "high", relatedScenarioIds: [], verification: null,
    title: "Uncaught page error", description: "A runtime error surfaces on the page.",
    recommendation: "Fix the JavaScript exception recorded during the scan.", userImpact: "Page features may fail at runtime.",
    rationale: "A page-level exception was observed.", count: 2, occurrences: 2,
    evidence: [{ type: "page", index: 0 }, { type: "authentication", index: null }],
  },
  {
    id: "QA-F-005", code: "BTN-001", status: "FAIL", lifecycle: "DISCOVERED", domain: "navigation", severity: "HIGH",
    confidence: "medium", relatedScenarioIds: ["SC-VER-003"],
    verification: { disposition: "SCHEDULED", scenarioId: "SC-VER-003", status: null, category: null, verdict: null, reason: "Awaiting a safe execution slot.", safety: "safe", locator: "button[name='Submit order']", executedAt: null, durationMs: null, error: null },
    title: "Submit button must have a clearer label", description: "The primary action depends on heading text.",
    recommendation: "Give the button an explicit accessible name.", userImpact: "Assistive technology users may mislabel the action.",
    rationale: "The element's accessible name relies on surrounding text.", count: 1, occurrences: 1,
    evidence: [{ type: "element", index: null, locator: "button[name='Submit order']", accessibleName: "Submit order", tag: "button" }],
  },
  {
    id: "QA-F-006", code: "RGB-001", status: "WARNING", lifecycle: "ANALYZED", domain: "accessibility", severity: "MEDIUM",
    confidence: "low", relatedScenarioIds: [], verification: null,
    title: "Grouped image concern", description: "A repeated image concern without a resolvable element.",
    recommendation: "Locate the image and add alt text.", userImpact: "Repetitive missing descriptions.",
    rationale: "The reference points past the recorded element set.", count: 3, occurrences: 1,
    evidence: [{ type: "element", index: 99 }],
  },
];

const qaF001 = findings[0] as unknown as QaFinding;
const sigF001 = findingSignature(qaF001, URL, elements);

const historyFinding = {
  key: sigF001.key, family: sigF001.family, page: sigF001.page, code: "IMG-001", domain: "accessibility",
  severity: "HIGH", title: "Image is missing descriptive alt text", lifecycle: "PERSISTING", confidence: "HIGH",
  confidenceReason: "Observed with matching semantic identity across 2 runs.", runIds: ["r1", "r0"],
  runsObserved: 2, runsAbsent: 0, firstSeenRunId: "r0", lastSeenRunId: "r1",
  firstSeenAt: "2026-09-20T00:00:00.000Z", lastSeenAt: "2026-09-21T00:00:00.000Z",
  latestDisposition: "REPRODUCED", latestVerdict: "LIKELY_DEFECT", latestDiscoveryVariance: null,
  reproducedRunIds: ["r1"], clearedRunIds: [], absentRunIds: [], contradictions: [], relatedCandidates: [],
  evidence: [{ runId: "r1", page: "/en", status: "PRESENT", findingId: "QA-F-001", code: "IMG-001", severity: "HIGH", title: "Image is missing descriptive alt text", disposition: "REPRODUCED", verdict: "LIKELY_DEFECT", relationCoverage: null, discoveryVariance: null, verifiedClear: false }],
  reviewNote: null,
};

const reportFixture = (overrides: object = {}) => ({
  schemaVersion: 1,
  generatedAt: "2026-09-21T00:00:00.000Z",
  mode: "deterministic",
  aiProvider: "deterministic",
  scan: {
    scan: { url: URL, finalUrl: URL, title: "QA target", timestamp: "2026-09-21T00:00:00.000Z", durationMs: 500 },
    authentication: { method: "basic", usernamePresent: true, passwordPresent: true, authorizationPresent: false, accepted: null },
    summary: {
      totalElements: 2, interactiveElements: 1, passes: 0, warnings: 2, failures: 4, infos: 0, linksChecked: 1,
      brokenLinks: 1, consoleErrors: 1, pageErrors: 1, issueGroups: 6,
      groupedIssueCounts: { passes: 0, warnings: 2, failures: 4, infos: 0 },
    },
    page: { language: "en", viewport: null, forms: 0, images: 1, links: 1, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements,
    issues: [],
    links: [{ url: "https://qa.test/en/broken", status: 404, type: "BROKEN", error: "404 Not Found" }],
    consoleErrors: [],
    consoleDiagnostics: [{ message: "Failed to load resource: the server responded with a status of 404", source: "https://qa.test/en/broken", category: "network", status: "WARNING" }],
    pageErrors: ["TypeError: Cannot read properties of undefined (reading 'map') at https://qa.test/en/app.js:42"],
  },
  findings,
  flows: [],
  scenarios: [],
  elementScenarios: [],
  verifications: [{
    findingId: "QA-F-001", scenarioId: "SC-VER-001", strategy: "image-alt", locator: "img[alt='']",
    status: "REPRODUCED", category: "WEBSITE", executedAt: "2026-09-21T00:00:02.000Z", durationMs: 120,
    expectation: "The image must carry a non-empty alt", 
    evidence: {
      located: true, locator: "img[alt='']", tag: "img", role: null, accessibleName: null, text: "",
      visible: true, enabled: true, href: null, url: null, id: null, attributes: { src: "/logo.png" }, count: 1,
      screenshotPath: "C:\\screens\\qa-f-001.png",
    },
    error: null,
    triage: { verdict: "LIKELY_DEFECT", reason: "The live DOM matched the suspected condition.", confidence: "high", provider: "deterministic" },
  }],
  flowDiscovery: null,
  coverage: null,
  regression: null,
  intelligence: {
    status: "AVAILABLE", schemaVersion: 1, generatedAt: "2026-09-21T00:00:00.000Z",
    summary: { candidates: 1, actionable: 1, investigationRequired: 0, insufficientEvidence: 0, informational: 0, highConfidence: 1, mediumConfidence: 0, lowConfidence: 0, insufficientConfidence: 0, relationships: 0, contradictions: 0, investigationQueue: 1 },
    rootCauseCandidates: [{
      candidateId: "RC-001", title: "Shared broken image target", description: "Multiple findings resolve to the same image.",
      pattern: "VERIFIED_REGRESSION", confidence: "HIGH", confidenceReason: "Multiple independent evidence sources agree.",
      status: "ACTIONABLE", findingIds: ["QA-F-001", "QA-F-005"], scenarioIds: [], flowIds: [],
      affectedPages: ["/en"], affectedCategories: [], supportingEvidence: [], contradictingEvidence: [],
      investigationActions: [], coverageImpact: [], regressionContext: [],
    }],
    evidenceRelationships: [],
    investigationQueue: [{ entryId: "Q-001", candidateId: "RC-001", priority: "P1", priorityReason: "High-severity defect reproduced with supporting evidence.", title: "Shared broken image target" }],
    aiNotes: null,
  },
  historicalIntelligence: {
    status: "AVAILABLE", schemaVersion: 1, generatedAt: "2026-09-21T00:00:00.000Z", siteIdentity: SITE_IDENTITY,
    historyDir: "history", currentRunId: "r1",
    summary: { runsAnalyzed: 2, orderedRuns: 2, unorderedRuns: 0, dateRange: { firstRunStartedAt: "2026-09-20T00:00:00.000Z", latestRunCompletedAt: "2026-09-21T00:00:00.000Z" }, findings: { observed: 1, new: 0, persisting: 1, disappeared: 0, reappeared: 0, recurring: 0, intermittent: 0, changed: 0, unchanged: 0, reviewRequired: 0, insufficientEvidence: 0 }, flows: { observed: 0, stable: 0, variable: 0, unstable: 0, insufficientEvidence: 0, recurringFailures: 0 }, coverage: { trends: 0, newlyTested: 0, persistentlyUntested: 0, gained: 0, lost: 0, changed: 0, stable: 0, insufficientEvidence: 0 }, infrastructure: { recurringCount: 0 }, relationships: 0, investigationQueue: 1 },
    findings: [historyFinding],
    flows: [], coverage: [], infrastructure: [], relationships: [],
    investigationQueue: [{ entryId: "HQ-001", kind: "PERSISTENT_HIGH_SEVERITY", priority: "P1", priorityReason: "High severity present across runs.", title: "Image is missing descriptive alt text", identifier: historyFinding.key, runIds: ["r1", "r0"], confidence: "HIGH" }],
    limitations: [], aiNotes: null,
  },
  history: { status: "AVAILABLE", schemaVersion: 1, siteIdentity: SITE_IDENTITY, currentRunId: "r1", runsAvailable: 2, historyDir: "history", note: "" },
  execution: null,
  summary: {
    sourceUrl: URL, scannedAt: "2026-09-21T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic",
    elementCount: 2, interactiveElements: 1, issueCount: 6,
    bySeverity: { CRITICAL: 0, HIGH: 2, MEDIUM: 3, LOW: 1, INFO: 0 },
    byConfidence: { high: 3, medium: 2, low: 1 }, brokenLinks: 1, flowsDetected: 0, intentScenarios: 0,
    automatedScenarios: 0, manualScenarios: 0, reviewScenarios: 0, reviewTests: 0, excludedScenarios: 0,
    highRiskScenarios: 0, overallStatus: "REVIEW", headline: "Review required", topRecommendations: [],
    verified: 2, reproduced: 1, notReproduced: 1, pass: 0, review: 0, infrastructureFailures: 0, unverified: 4,
    scheduled: 1, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0,
    infrastructureProblems: 0, flowSummary: null, coverageSummary: null,
  },
  ...overrides,
});

const gateRegressionMap = () => ({
  schemaVersion: 1,
  generatedAt: "2026-09-21T00:00:00.000Z",
  baselinePath: "reports/qa-baseline.json",
  summary: { comparable: true, notComparableReason: null, changeCount: 1, counts: {}, headline: "1 change" },
  runs: {
    baseline: { runId: "base", runLabel: "baseline", origin: "qa.test", sourceUrl: URL, scannedAt: "2026-09-20T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" },
    current: { runId: "r1", runLabel: "current", origin: "qa.test", sourceUrl: URL, scannedAt: "2026-09-21T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" },
  },
  changes: [{
    changeId: "R-1", category: "FINDING", classification: "NEW", confidence: "HIGH_CONFIDENCE",
    confidenceReason: "Present now, absent in the baseline.", anchor: sigF001.key,
    currentReference: "QA-F-001", baselineReference: "(none)",
    summary: "Finding IMG-001 newly observed on /en.", explanation: "The current run reports this finding where the baseline did not.",
    evidence: ["Verified REPRODUCED", "Absent from the baseline run."], recommendedAction: "Fix the root cause and add a verification probe.",
    relatedFindingIds: ["QA-F-001"], relatedFlowIds: [], relatedCoverageIds: [], relatedRecommendationIds: [],
  }],
  aiNotes: null,
});

const snapshot = (runId: string, findingsList: unknown[], intelligence: unknown): unknown => ({
  schemaVersion: 1,
  runId,
  siteKey: { origin: "https://qa.test", normalizedStartPage: "/en", configDigest: "cccccccc" },
  siteIdentity: SITE_IDENTITY,
  entryUrl: URL,
  startedAt: runId === "r2" ? "2026-09-20T00:00:00.000Z" : "2026-09-19T00:00:00.000Z",
  completedAt: runId === "r2" ? "2026-09-20T00:01:00.000Z" : "2026-09-19T00:01:00.000Z",
  mode: "deterministic", aiProvider: "deterministic", scannedOriginUrl: "https://qa.test", environment: null, browser: null,
  summary: { headline: "Snapshot run", findingCount: findingsList.length, flowCount: 0, coverageCount: 0, executionPlanned: 0, executionReproduced: 0, executionNotReproduced: 0, executionInfraProblems: 0 },
  findings: findingsList,
  verifications: runId === "r2"
    ? [{ scenarioId: "SC-VER-010", findingId: "QA-F-010", strategy: "image-alt", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", confidence: "high", executedAt: "2026-09-20T00:00:01.000Z", durationMs: 90, locator: "img[alt='x']" }]
    : [],
  flows: [], coverage: [], regression: null,
  intelligence,
  identityDigest: runId === "r2" ? DIGEST : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

const r2SnapshotFindings = [{
  findingId: "QA-F-010", page: "/en", semanticKey: "IMG-010|/en|element:img:alt", family: "element:img:alt",
  code: "IMG-010", domain: "accessibility", severity: "HIGH", status: "FAIL", lifecycle: "REPRODUCED",
  title: "Snapshot alt issue", description: "Archived evidence for an image alt problem.",
  verification: { disposition: "REPRODUCED", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", reason: "Live DOM matched.", safety: "safe", executedAt: "2026-09-20T00:00:01.000Z", durationMs: 90 },
  evidence: [{ type: "element", index: 5, locator: "img[alt='x']", accessibleName: null, tag: "img" }],
}];

const r2Intelligence = {
  generatedAt: "2026-09-20T00:00:00.000Z", candidates: 1, actionable: 1, investigationRequired: 0,
  insufficientEvidence: 0, informational: 0, highConfidence: 1, mediumConfidence: 0, lowConfidence: 0,
  insufficientConfidence: 0, relationships: 0, contradictions: 0, investigationQueue: 1,
  rootCauseCandidates: [{ candidateId: "RC-200", pattern: "VERIFIED_REGRESSION", status: "ACTIONABLE", confidence: "HIGH", title: "Snapshot run candidate", findingIds: ["QA-F-010"], flowIds: [], affectedPages: ["/en"] }],
};

const writeFixture = (dir: string, reportOverrides: object = {}): void => {
  mkdirSync(join(dir, "history", "runs"), { recursive: true });
  writeFileSync(join(dir, "qa-analysis.json"), JSON.stringify(reportFixture(reportOverrides)));
  writeFileSync(join(dir, "qa-analysis.html"), "<html><body>fixture-report</body></html>");
  writeFileSync(join(dir, "history", "index.json"), JSON.stringify({
    schemaVersion: 1,
    sites: [{
      siteKeyId: "abc123",
      siteIdentity: SITE_IDENTITY,
      runs: [
        { runId: "r1", completedAt: "2026-09-21T00:01:00.000Z", findingCount: 6, executionReproduced: 1, executionInfraProblems: 0, identityDigest: DIGEST },
        { runId: "r2", completedAt: "2026-09-20T00:01:00.000Z", findingCount: 1, executionReproduced: 1, executionInfraProblems: 0, identityDigest: DIGEST },
        { runId: "r3", completedAt: "2026-09-19T00:01:00.000Z", findingCount: 0, executionReproduced: 0, executionInfraProblems: 0, identityDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      ],
    }],
  }));
  writeFileSync(join(dir, "history", "runs", "r1.json"), JSON.stringify(snapshot("r1", [], null)));
  writeFileSync(join(dir, "history", "runs", "r2.json"), JSON.stringify(snapshot("r2", r2SnapshotFindings, r2Intelligence)));
  writeFileSync(join(dir, "history", "runs", "r3.json"), JSON.stringify(snapshot("r3", [], null)));
};

const writeLeanFixture = (dir: string): void => {
  mkdirSync(join(dir, "history", "runs"), { recursive: true });
  writeFileSync(join(dir, "qa-analysis.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-21T00:00:00.000Z",
    mode: "deterministic",
    aiProvider: "deterministic",
    scan: {
      scan: { url: URL, finalUrl: URL, title: "Lean target", timestamp: "2026-09-21T00:00:00.000Z", durationMs: 500 },
      authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: null },
      summary: { totalElements: 1, interactiveElements: 0, passes: 0, warnings: 0, failures: 1, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 1, groupedIssueCounts: { passes: 0, warnings: 0, failures: 1, infos: 0 } },
      page: { language: "en", viewport: null, forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
      elements: [{ ...elements[1] }],
      issues: [], links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
    },
    findings: [{
      id: "QA-F-900", code: "BTN-900", status: "FAIL", lifecycle: "TEST_GENERATED", domain: "navigation",
      severity: "MEDIUM", confidence: "medium", relatedScenarioIds: [], verification: null,
      title: "Lean run finding", description: "A finding from a minimal report.",
      recommendation: "Review the control.", userImpact: "Low", rationale: "Fixture.", count: 1, occurrences: 1,
      evidence: [{ type: "element", index: 0 }],
    }],
    flows: [], scenarios: [], elementScenarios: [], verifications: [], flowDiscovery: null, coverage: null,
    regression: null, intelligence: null, execution: null,
    history: { status: "AVAILABLE", schemaVersion: 1, siteIdentity: SITE_IDENTITY, currentRunId: "r9", runsAvailable: 0, historyDir: "history", note: "" },
    summary: {
      sourceUrl: URL, scannedAt: "2026-09-21T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic",
      elementCount: 1, interactiveElements: 0, issueCount: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0, INFO: 0 },
      byConfidence: { high: 0, medium: 1, low: 0 }, brokenLinks: 0, flowsDetected: 0, intentScenarios: 0,
      automatedScenarios: 0, manualScenarios: 0, reviewScenarios: 0, reviewTests: 0, excludedScenarios: 0,
      highRiskScenarios: 0, overallStatus: "REVIEW", headline: "Review", topRecommendations: [],
      verified: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0, infrastructureFailures: 0, unverified: 1,
      scheduled: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0,
      infrastructureProblems: 0, flowSummary: null, coverageSummary: null,
    },
  }));
  writeFileSync(join(dir, "history", "index.json"), JSON.stringify({ schemaVersion: 1, sites: [] }));
};

const start = (dir: string) => startDashboard({ reportDir: dir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0, pagePath: join(process.cwd(), "src", "dashboard", "index.html") });

const stop = async (dash: Awaited<ReturnType<typeof startDashboard>>): Promise<void> => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

const get = async (url: string): Promise<{ status: number; body: string; json: unknown }> => {
  const res = await fetch(url);
  const status = res.status;
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }
  return { status, body, json };
};

const asPayload = (json: unknown): { ok: boolean; error?: string; run?: { runId: string; source: string }; total?: number; findings?: Record<string, unknown>[]; finding?: Record<string, unknown>; verification?: unknown; occurrences?: Record<string, unknown>[]; rootCause?: Record<string, unknown>[]; history?: Record<string, unknown> | null; gate?: unknown; notes?: string[] } =>
  json as { ok: boolean; error?: string; run?: { runId: string; source: string }; total?: number; findings?: Record<string, unknown>[]; finding?: Record<string, unknown>; verification?: unknown; occurrences?: Record<string, unknown>[]; rootCause?: Record<string, unknown>[]; history?: Record<string, unknown> | null; gate?: unknown; notes?: string[] };

test("evidence explorer lists a run's findings from the current report, bounded and filterable", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const list = asPayload((await get(`${base}/api/runs/r1/findings`)).json);
    assert.equal(list.run?.source, "report");
    assert.equal(list.run?.runId, "r1");
    assert.equal(list.total, 6);
    assert.equal((list.findings ?? [])[0]?.id, "QA-F-001");
    assert.equal((list.findings ?? [])[0]?.rootCause, 1, "root-cause count joins candidates");
    const entry = (list.findings ?? [])[0]!;
    assert.ok(!("description" in entry), "list entries are bounded and omit descriptions");
    assert.ok(!("evidence" in entry), "list entries do not ship full evidence");
    const bodyText = JSON.stringify((await get(`${base}/api/runs/r1/findings`)).json);
    assert.ok(!bodyText.includes('"scan"'), "findings list never ships the scan section");

    const sev = asPayload((await get(`${base}/api/runs/r1/findings?severity=HIGH`)).json);
    assert.equal(sev.total, 2);
    assert.deepEqual((sev.findings ?? []).map((f) => f.id).sort(), ["QA-F-001", "QA-F-005"]);

    const qBroken = asPayload((await get(`${base}/api/runs/r1/findings?q=broken`)).json);
    assert.equal(qBroken.total, 1);
    assert.equal((qBroken.findings ?? [])[0]?.id, "QA-F-002");

    const qConsole = asPayload((await get(`${base}/api/runs/r1/findings?q=console`)).json);
    assert.equal((qConsole.findings ?? [])[0]?.id, "QA-F-003");

    const statusFail = asPayload((await get(`${base}/api/runs/r1/findings?status=FAIL`)).json);
    assert.equal(statusFail.total, 3);

    const combined = asPayload((await get(`${base}/api/runs/r1/findings?severity=HIGH&status=INFO`)).json);
    assert.equal(combined.total, 0);
    assert.deepEqual(combined.findings, []);
  } finally {
    await stop(dash);
  }
});

test("evidence explorer details an element occurrence with verification, root cause and history", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const detail = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-001`)).json);
    assert.equal(detail.ok, true);
    assert.equal(detail.finding?.id, "QA-F-001");
    assert.equal(detail.finding?.count, 1);
    assert.equal(detail.finding?.page, sigF001.page, "normalized page identity matches the semantic signature page");
    assert.equal((detail.finding?.relatedScenarioIds as string[] | undefined)?.[0], "SC-VER-001");

    const occs = detail.occurrences ?? [];
    assert.equal(occs.length, 1);
    const occ = occs[0]!;
    assert.equal(occ.id, "element-0");
    assert.equal(occ.kind, "element");
    assert.equal(occ.selector, "img[alt='']");
    assert.equal(occ.tag, "img");
    assert.ok((occ.detail as { label: string; value: string }[]).some((row) => row.label === "Locator quality" && row.value === "medium"));

    const verify = detail.verification as Record<string, unknown> & { evidence: { label: string; value: string }[] };
    assert.equal(verify.disposition, "REPRODUCED");
    assert.equal(verify.verdict, "LIKELY_DEFECT");
    assert.equal(verify.confidence, "high");
    assert.ok(verify.evidence.some((row) => row.label === "Screenshot path" && row.value.includes("qa-f-001.png")));
    assert.ok(verify.evidence.some((row) => row.label === "src" && row.value === "/logo.png"));

    assert.equal(detail.rootCause?.length, 1);
    const rc = detail.rootCause![0]!;
    assert.equal(rc.candidateId, "RC-001");
    assert.equal(rc.pattern, "VERIFIED_REGRESSION");
    assert.equal(rc.priority, "P1");
    assert.ok(String(rc.priorityReason).length > 0);

    assert.equal(detail.history?.available, true);
    assert.equal(detail.history?.lifecycle, "PERSISTING");
    assert.equal(detail.history?.key, sigF001.key);
    assert.equal(detail.history?.runsObserved, 2);

    assert.deepEqual(detail.notes, [], "no fabricated absence notes when everything is present");
  } finally {
    await stop(dash);
  }
});

test("evidence explorer resolves link, console, page, authentication and snapshot-locator occurrences", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const link = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-002`)).json);
    const linkOcc = (link.occurrences ?? [])[0]!;
    assert.equal(linkOcc.kind, "link");
    assert.equal(linkOcc.url, "https://qa.test/en/broken");
    assert.ok((linkOcc.detail as { label: string; value: string }[]).some((row) => row.label === "Type" && row.value === "BROKEN"));

    const console = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-003`)).json);
    const consoleOcc = (console.occurrences ?? [])[0]!;
    assert.equal(consoleOcc.kind, "console");
    assert.ok((consoleOcc.detail as { label: string; value: string }[]).some((row) => row.label === "Message" && row.value.includes("404")));

    const page = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-004`)).json);
    const pageOccs = page.occurrences ?? [];
    assert.equal(pageOccs.length, 2, "page + authentication refs");
    assert.ok((pageOccs[0]?.detail as { label: string; value: string }[]).some((row) => row.label === "Error" && row.value.includes("TypeError")));
    assert.equal(pageOccs[1]?.kind, "authentication");
    assert.ok((pageOccs[1]?.detail as { label: string; value: string }[]).some((row) => row.label === "Method" && row.value === "basic"));

    const snapshotLocator = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-005`)).json);
    const poc = (snapshotLocator.occurrences ?? [])[0]!;
    assert.equal(poc.kind, "element");
    assert.equal(poc.selector, "button[name='Submit order']");
    assert.equal(poc.accessibleName, "Submit order");
    assert.equal(poc.tag, "button");
    assert.equal(snapshotLocator.history?.available, false, "no historical record matches this finding's semantic key");

    const outOfRange = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-006`)).json);
    const oor = (outOfRange.occurrences ?? [])[0]!;
    assert.ok(String(oor.note).includes("outside the recorded scan.elements"));
  } finally {
    await stop(dash);
  }
});

test("evidence explorer serves archived run artifacts from the reduced snapshot", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const list = asPayload((await get(`${base}/api/runs/r2/findings?q=Snapshot`)).json);
    assert.equal(list.run?.source, "snapshot");
    assert.equal(list.total, 1);
    assert.equal((list.findings ?? [])[0]?.id, "QA-F-010");
    assert.equal((list.findings ?? [])[0]?.occurrenceCount, 1);

    const detail = asPayload((await get(`${base}/api/runs/r2/findings/QA-F-010`)).json);
    assert.equal(detail.ok, true);
    const occ = (detail.occurrences ?? [])[0]!;
    assert.equal(occ.selector, "img[alt='x']");
    assert.ok((occ.detail as { label: string; value: string }[]).some((row) => row.label === "Index" && row.value === "5"));

    const verify = detail.verification as Record<string, unknown>;
    assert.equal(verify.status, "REPRODUCED");
    assert.equal(verify.category, "WEBSITE");
    assert.equal(verify.locator, "img[alt='x']");

    assert.equal(detail.rootCause?.length, 1);
    const rc = detail.rootCause![0]!;
    assert.equal(rc.title, "Snapshot run candidate");
    assert.ok(!("priority" in rc), "archived snapshots do not invent a queue priority");
    assert.equal(detail.gate, null, "archived snapshots carry no regression map, so no gate verdict exists");

    assert.equal(detail.history?.available, false);
    assert.ok(String(detail.history?.note).includes("archived run artifacts"));
    assert.ok(!(detail.notes ?? []).some((n) => n.includes("not cited")), "no fabricated root-cause note when candidates exist");
  } finally {
    await stop(dash);
  }
});

test("evidence explorer handles empty runs and absent intelligence/history honestly", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const empty = asPayload((await get(`${base}/api/runs/r3/findings`)).json);
    assert.equal(empty.run?.source, "snapshot");
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.findings, []);
  } finally {
    await stop(dash);
  }

  const leanDir = tempDir();
  writeLeanFixture(leanDir);
  const lean = await start(leanDir);
  const leanBase = `http://127.0.0.1:${lean.port}`;
  try {
    const list = asPayload((await get(`${leanBase}/api/runs/r9/findings`)).json);
    assert.equal(list.total, 1);
    const detail = asPayload((await get(`${leanBase}/api/runs/r9/findings/QA-F-900`)).json);
    assert.equal(detail.ok, true);
    assert.equal(detail.verification, null);
    assert.deepEqual(detail.rootCause, []);
    assert.equal(detail.history?.available, false);
    assert.ok((detail.notes ?? []).some((n) => n.includes("No historical")));
    assert.ok((detail.notes ?? []).some((n) => n.includes("root-cause candidate")));
  } finally {
    await stop(lean);
  }
});

test("evidence explorer reveals the CI gate verdict for gated report findings", async () => {
  const dir = tempDir();
  writeFixture(dir, { regression: gateRegressionMap() });
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const detail = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-001`)).json);
    assert.equal(detail.ok, true);
    const gate = detail.gate as Record<string, unknown> | null;
    assert.equal(gate?.active, true);
    assert.equal(gate?.minSeverity, "HIGH");
    const violation = gate?.violation as Record<string, unknown> | null;
    assert.equal(violation?.classification, "NEW");
    assert.equal(violation?.severity, "HIGH");
    assert.equal(violation?.findingId, "QA-F-001");
    assert.ok(Array.isArray(violation?.evidence), "gate violations surface their evidence");
    assert.ok(String(violation?.summary).length > 0);

    const untouched = asPayload((await get(`${base}/api/runs/r1/findings/QA-F-002`)).json);
    const untouchedGate = untouched.gate as Record<string, unknown> | null;
    assert.equal(untouchedGate?.active, true);
    assert.equal(untouchedGate?.violation, null, "a MEDIUM finding below the HIGH threshold is not a violation");
  } finally {
    await stop(dash);
  }
});

test("evidence explorer rejects traversal, invalid ids, unknown runs and unknown findings", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const traversal = await get(`${base}/api/runs/..%2F..%2Fqa-analysis.json/findings`);
    assert.equal(traversal.status, 400, "traversal run ids are rejected");
    const backslash = await get(`${base}/api/runs/..%5C..%5Cpackage.json/findings`);
    assert.equal(backslash.status, 400, "backslash traversal is rejected");
    const badFindingId = await get(`${base}/api/runs/r1/findings/..%2F..`);
    assert.equal(badFindingId.status, 400, "invalid finding ids are rejected");
    const unknownRun = await get(`${base}/api/runs/does-not-exist/findings`);
    assert.equal(unknownRun.status, 404);
    const unknownFinding = await get(`${base}/api/runs/r1/findings/QA-F-999`);
    assert.equal(unknownFinding.status, 404);
    assert.ok(String((unknownFinding.json as { error?: string }).error).includes("not found"));
    const rawStillWorks = await get(`${base}/api/runs/r2`);
    assert.equal(rawStillWorks.status, 200);
    assert.equal((rawStillWorks.json as { runId: string }).runId, "r2");
    const bogus = await get(`${base}/api/runs/r1/findings/QA-F-001/extra`);
    assert.equal(bogus.status, 400, "paths with extra segments are rejected");
  } finally {
    await stop(dash);
  }
});

test("evidence explorer treats a malformed archived snapshot as an unknown run (404), never a 500", async () => {
  const dir = tempDir();
  writeFixture(dir);
  writeFileSync(join(dir, "history", "runs", "badblob.json"), "{ not valid json", "utf8");
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const list = await get(`${base}/api/runs/badblob/findings`);
    assert.equal(list.status, 404, "malformed snapshot resolves like an unknown run");
    const detail = await get(`${base}/api/runs/badblob/findings/QA-F-001`);
    assert.equal(detail.status, 404);
  } finally {
    await stop(dash);
  }
});