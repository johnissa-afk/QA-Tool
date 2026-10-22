import { test } from "node:test";
import assert from "node:assert/strict";
import type { QaAnalysis, QaSummary } from "../ai/types.js";
import { buildQaResultBlock, coverageStatusLabel, qaResultInputOf, queuePriorityCounts } from "../qa/result.js";

const minimalSummary = (overrides: Partial<QaSummary> = {}): QaSummary => ({
  sourceUrl: "https://qa.test/en",
  scannedAt: "2026-09-21T00:00:00.000Z",
  mode: "deterministic",
  aiProvider: "deterministic",
  elementCount: 0,
  interactiveElements: 0,
  issueCount: 12,
  bySeverity: { CRITICAL: 0, HIGH: 2, MEDIUM: 3, LOW: 4, INFO: 3 },
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
  overallStatus: "REVIEW",
  headline: "REVIEW",
  topRecommendations: [],
  verified: 5,
  reproduced: 3,
  notReproduced: 1,
  pass: 1,
  review: 0,
  infrastructureFailures: 0,
  unverified: 3,
  scheduled: 8,
  executed: 5,
  skippedUnsupported: 1,
  skippedLocatorGuard: 2,
  skippedSafety: 0,
  reviewRequired: 0,
  infrastructureProblems: 0,
  flowSummary: null,
  coverageSummary: null,
  ...overrides,
});

const minimalAnalysis = (overrides: Partial<QaAnalysis>): QaAnalysis => ({
  schemaVersion: 1,
  generatedAt: "2026-09-21T00:00:00.000Z",
  mode: "deterministic",
  aiProvider: "deterministic",
  scan: { scan: { url: "https://qa.test/en", title: "QA target" } } as never,
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
  summary: minimalSummary(),
  ...overrides,
});

const context = { url: "https://qa.test/en", runId: "run-2026-01", jsonPath: "reports/qa-analysis.json", htmlPath: "reports/qa-analysis.html", historyPath: "reports/history" };

test("coverageStatusLabel maps page counts deterministically", () => {
  assert.equal(coverageStatusLabel({ tested: 3, partial: 0 }), "TESTED");
  assert.equal(coverageStatusLabel({ tested: 1, partial: 2 }), "PARTIALLY_TESTED");
  assert.equal(coverageStatusLabel({ tested: 0, partial: 2 }), "PARTIALLY_TESTED");
  assert.equal(coverageStatusLabel({ tested: 0, partial: 0 }), "NOT_TESTED");
});

test("queuePriorityCounts counts P1/P2/P3 and ignores unknown priorities", () => {
  assert.deepEqual(queuePriorityCounts([{ priority: "P1" }, { priority: "P2" }, { priority: "P2" }, { priority: "P3" }, { priority: "P1" }]), { P1: 2, P2: 2, P3: 1 });
  assert.deepEqual(queuePriorityCounts([]), { P1: 0, P2: 0, P3: 0 });
});

test("buildQaResultBlock renders the product summary", () => {
  const input: Parameters<typeof buildQaResultBlock>[0] = {
    url: "https://qa.test/en",
    status: "REVIEW",
    runId: "run-2026-01",
    pagesDiscovered: 3,
    coverageLabel: "PARTIALLY_TESTED",
    findingsCount: 5,
    occurrenceCount: 12,
    verified: 5,
    reproduced: 3,
    regression: { comparable: true, changeCount: 2 },
    historicalStatus: "AVAILABLE",
    queue: [{ priority: "P1" }, { priority: "P2" }, { priority: "P3" }],
    runsStored: 3,
    jsonPath: "reports/qa-analysis.json",
    htmlPath: "reports/qa-analysis.html",
    historyPath: "reports/history",
  };
  const block = buildQaResultBlock(input);
  assert.ok(block.startsWith("QA RESULT"));
  assert.ok(block.includes("Status: REVIEW"));
  assert.ok(block.includes("Run:    run-2026-01"));
  assert.ok(block.includes("Pages: 3"));
  assert.ok(block.includes("Findings: 5 (12 occurrence(s))"));
  assert.ok(block.includes("Verified: 5 · Reproduced: 3"));
  assert.ok(block.includes("Coverage: PARTIALLY_TESTED"));
  assert.ok(block.includes("Regression: 2 change(s)"));
  assert.ok(block.includes("Historical: AVAILABLE (3 run(s))"));
  assert.ok(block.includes("P1: 1 · P2: 1 · P3: 1"));
  assert.ok(block.includes("reports/qa-analysis.json"));
  assert.ok(block.includes("reports/qa-analysis.html"));
  assert.ok(block.includes("reports/history"));
});

test("qaResultInputOf derives every number from the analysis", () => {
  const analysis = minimalAnalysis({
    findings: Array.from({ length: 5 }, (_, index) => ({ id: `QA-F-${index}` }) as never),
    coverage: { summary: { pages: { discovered: 3, tested: 1, partial: 2, untested: 0, blocked: 0, review: 0 }, flows: {}, interactions: {}, items: 0, testPlan: 0 } } as never,
    regression: { summary: { comparable: true, changeCount: 4 } } as never,
    historicalIntelligence: { status: "AVAILABLE", investigationQueue: [{ priority: "P1" }, { priority: "P3" }] } as never,
    intelligence: { investigationQueue: [{ priority: "P2" }] } as never,
    history: { runsAvailable: 3 } as never,
  });
  const input = qaResultInputOf(analysis, context);
  assert.equal(input.status, "REVIEW");
  assert.equal(input.runId, "run-2026-01");
  assert.equal(input.pagesDiscovered, 3);
  assert.equal(input.coverageLabel, "PARTIALLY_TESTED");
  assert.equal(input.findingsCount, 5);
  assert.equal(input.occurrenceCount, 12);
  assert.equal(input.verified, 5);
  assert.equal(input.reproduced, 3);
  assert.equal(input.regression!.changeCount, 4);
  assert.equal(input.historicalStatus, "AVAILABLE");
  assert.deepEqual(queuePriorityCounts(input.queue), { P1: 1, P2: 0, P3: 1 }, "historical queue takes precedence over intelligence queue");
  assert.equal(input.runsStored, 3);
});

test("qaResultInputOf falls back when regression and history are missing", () => {
  const input = qaResultInputOf(minimalAnalysis({}), context);
  assert.equal(input.regression, null);
  assert.equal(input.historicalStatus, null);
  assert.equal(input.coverageLabel, "N/A");
  assert.deepEqual(queuePriorityCounts(input.queue), { P1: 0, P2: 0, P3: 0 });
});

test("a blocked scan is rendered as NOT TESTED, never as a clean zero-finding result", () => {
  const block = buildQaResultBlock({
    url: "https://staging.example.test/",
    status: "REVIEW",
    runId: "run-1",
    pagesDiscovered: 1,
    coverageLabel: "N/A",
    findingsCount: 0,
    occurrenceCount: 0,
    verified: 0,
    reproduced: 0,
    regression: null,
    historicalStatus: null,
    queue: [],
    runsStored: 1,
    jsonPath: "reports/x.json",
    htmlPath: "reports/x.html",
    historyPath: "reports/history",
    accessPrerequisite: { type: "login-required", status: "REVIEW_REQUIRED", message: "The target redirected to a login page." },
  });
  assert.match(block, /SITE NOT TESTED/);
  assert.match(block, /login-required/);
  assert.match(block, /Findings: not assessed/);
  assert.match(block, /Coverage: NOT_TESTED/);
  assert.doesNotMatch(block, /Findings: 0 /);
});
