// ---------------------------------------------------------------------------
// Phase 11B — deterministic normalization (pure unit tests).
//
// Covers `src/qa/determinism.ts`: the normalizer is deterministic, side-effect
// free, non-mutating, idempotent, reuses the canonical key-stable serialization,
// masks ONLY the documented runtime-specific fields, and preserves every piece
// of meaningful report data.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import type { QaAnalysis } from "../ai/types.js";
import {
  MACHINE_PATH_STUB,
  RUNTIME_DURATION_MS_STUB,
  RUNTIME_RUN_ID_STUB,
  RUNTIME_TIMESTAMP_STUB,
  deterministicArtifactKey,
  normalizeArtifact,
  normalizedArtifactsEqual,
} from "../qa/determinism.js";

const sampleAnalysis = (): QaAnalysis =>
  ({
    schemaVersion: 1,
    generatedAt: "2026-09-22T12:00:00.000Z",
    mode: "deterministic",
    aiProvider: "deterministic",
    scan: {
      scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: "2026-09-22T12:00:05.000Z", durationMs: 4800, navigationStatus: 200 },
      authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
      summary: { totalElements: 3, interactiveElements: 1, passes: 0, warnings: 1, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 1, groupedIssueCounts: { passes: 0, warnings: 1, failures: 0, infos: 0 } },
      page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
      elements: [{ tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high" }],
      issues: [],
      links: [],
      consoleErrors: [],
      consoleDiagnostics: [],
      pageErrors: [],
    },
    findings: [
      {
        id: "QA-F-001", code: "BTN-001", status: "WARNING", lifecycle: "ANALYZED", relatedScenarioIds: ["SC-VER-001"],
        verification: { disposition: "REPRODUCED", scenarioId: "SC-VER-001", status: "REPRODUCED", category: "WEBSITE", verdict: "LIKELY_DEFECT", reason: "Live DOM matched the suspected condition.", safety: "safe", locator: "button[name='Save']", executedAt: "2026-09-22T12:00:10.000Z", durationMs: 120, error: null },
        domain: "accessibility", severity: "MEDIUM", confidence: "high", title: "Button is missing an accessible name", description: "A visible interactive button has no programmatic label.", recommendation: "Add an accessible name.", userImpact: "Assistive-technology users cannot identify the control.", rationale: "Deterministic scanner evidence.", count: 3, occurrences: 3, evidence: [{ type: "element", index: 0 }],
      },
    ],
    flows: [],
    scenarios: [],
    elementScenarios: [],
    verifications: [
      {
        findingId: "QA-F-001", scenarioId: "SC-VER-001", strategy: "accessible-name", locator: "button[name='Save']", status: "REPRODUCED", category: "WEBSITE", executedAt: "2026-09-22T12:00:10.000Z", durationMs: 120, expectation: "Control has a label.", evidence: { located: true, locator: "button[name='Save']", tag: "button", role: "button", accessibleName: null, text: "Save", visible: true, enabled: true, href: null, url: null, id: null, attributes: null, count: 1, screenshotPath: "C:\\repo\\reports\\screenshots\\sc-001.png" }, error: null, triage: { verdict: "LIKELY_DEFECT", reason: "DOM matched.", confidence: "high", provider: "deterministic" },
      },
    ],
    flowDiscovery: null,
    coverage: null,
    regression: {
      baselinePath: "C:\\repo\\reports\\qa-baseline.json",
      runs: {
        baseline: { runId: "2026-09-20T09-30-12-123Z-8f3a1c02", runLabel: "baseline", origin: "https://qa.test", sourceUrl: "https://qa.test/en", scannedAt: "2026-09-20T09:00:00.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" },
        current: { runId: "57396b0f0d0bdd21c6d0b48074fb01e0a8f4c91f", runLabel: "current", origin: "https://qa.test", sourceUrl: "https://qa.test/en", scannedAt: "2026-09-22T12:00:05.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" },
      },
      summary: { comparable: true, changeCount: 0, counts: { REGRESSION: 0, INFRASTRUCTURE_PROBLEM: 0, REVIEW_REQUIRED: 0, COVERAGE_CHANGED: 0, FIXED: 0, NEW: 0, REMOVED_FLOW: 0, CHANGED_FLOW: 0, NEW_FLOW: 0, CHANGED: 0, UNCHANGED_FLOW: 0, UNCHANGED: 0 }, headline: "No meaningful changes.", notComparableReason: null, aiNotes: null },
      changes: [],
    },
    intelligence: {
      generatedAt: "2026-09-22T12:00:12.000Z",
      summary: { candidates: 1, actionable: 1, investigationRequired: 0, insufficientEvidence: 0, informational: 0, highConfidence: 1, mediumConfidence: 0, lowConfidence: 0, insufficientConfidence: 0, relationships: 1, contradictions: 0, investigationQueue: [], limitations: [] },
      investigationQueue: [],
      rootCauseCandidates: [{ candidateId: "RC-001", pattern: "Unlabeled control", status: "ACTIONABLE", confidence: "HIGH", title: "Unlabeled button cluster", findingIds: ["QA-F-001"], flowIds: [], affectedPages: ["/en"], evidence: [], explanation: "", recommendedAction: "", investigationHint: "" }],
      relationships: [],
      limitations: [],
    },
    history: {
      status: "AVAILABLE", schemaVersion: 1, siteIdentity: "https://qa.test|https://qa.test/en|cfg", currentRunId: "2026-09-22T12-00-00-000Z-aa11bb22", runsAvailable: 3, historyDir: "C:\\repo\\reports\\history", note: "This run was persisted to the QA run history.",
    },
    historicalIntelligence: {
      status: "AVAILABLE", schemaVersion: 1, siteIdentity: "https://qa.test|https://qa.test/en|cfg", currentRunId: "2026-09-22T12-00-00-000Z-aa11bb22", runsAvailable: 3, historyDir: "C:\\repo\\reports\\history",
      summary: {
        orderedRuns: 3, unorderedRuns: 0, dateRange: { firstRunStartedAt: "2026-09-20T09:00:00.000Z", latestRunCompletedAt: "2026-09-22T12:00:12.000Z" },
        findings: { observed: 1, new: 0, persisting: 1, disappeared: 0, reappeared: 0, recurring: 0, intermittent: 0, changed: 0, unchanged: 1, reviewRequired: 0, insufficientEvidence: 0 },
        flows: { observed: 0, stable: 0, variable: 0, unstable: 0, recurringFailures: 0, insufficientEvidence: 0 },
        coverage: { trends: 0, newlyTested: 0, gained: 0, lost: 0, persistentlyUntested: 0, changed: 0, stable: 0 },
        infrastructure: { recurringCount: 0 }, relationships: 0, limitations: [],
      },
      findings: [{ key: "finding:key", family: "family", code: "BTN-001", severity: "MEDIUM", status: "UNCHANGED", confidence: "HIGH", firstSeenAt: "2026-09-20T09:00:00.000Z", lastSeenAt: "2026-09-22T12:00:12.000Z", runIds: ["2026-09-20T09-30-12-123Z-8f3a1c02", "2026-09-22T12-00-00-000Z-aa11bb22"] }],
      flows: [], investigationQueue: [], relationships: [], aiNotes: null,
    },
    configuration: {
      source: "qa.config.json", path: "C:\\repo\\qa.config.json",
      resolved: { crawlMaxPages: 8, execution: false, coverage: true, regression: true, rootCause: true, history: true, historicalIntelligence: true, ciFailOn: "failed", ciGateMinSeverity: "HIGH", baselineMaxAge: "30d", baselinePath: "C:\\repo\\reports\\qa-baseline.json" },
    },
    execution: { status: "passed", command: "node", startedAt: "2026-09-22T12:00:11.000Z", durationMs: 1515, tests: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, reproduced: 1, notReproduced: 0, review: 0, infrastructureFailures: 0, failures: [] },
    summary: {
      sourceUrl: "https://qa.test/en", scannedAt: "2026-09-22T12:00:05.000Z", mode: "deterministic", aiProvider: "deterministic", elementCount: 3, interactiveElements: 1, issueCount: 1, bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0, INFO: 0 }, byConfidence: { high: 1, medium: 0, low: 0 }, brokenLinks: 0, flowsDetected: 0, intentScenarios: 0, automatedScenarios: 0, manualScenarios: 0, reviewScenarios: 0, reviewTests: 0, excludedScenarios: 0, highRiskScenarios: 0, overallStatus: "PASS", headline: "QA (deterministic): no critical or high findings for https://qa.test/en", topRecommendations: [], verified: 1, reproduced: 1, notReproduced: 0, pass: 0, review: 0, infrastructureFailures: 0, unverified: 0, scheduled: 1, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0, infrastructureProblems: 0, flowSummary: null, coverageSummary: null,
    },
  }) as unknown as QaAnalysis;

test("normalizeArtifact does not mutate the original object", () => {
  const original = sampleAnalysis();
  const snapshot = JSON.stringify(original);
  normalizeArtifact(original);
  assert.equal(JSON.stringify(original), snapshot, "the input is byte-identical after normalization");
});

test("normalizeArtifact is idempotent", () => {
  const a = normalizeArtifact(sampleAnalysis());
  const b = normalizeArtifact(a);
  assert.equal(deterministicArtifactKey(b), deterministicArtifactKey(a));
  assert.deepEqual(b, a);
});

test("canonical key is insensitive to object key insertion order", () => {
  const a = sampleAnalysis();
  const b = sampleAnalysis() as unknown as Record<string, unknown>;
  const keys = Object.keys(b);
  // rebuild `b` with reversed top-level key order, identical values
  const reversed: Record<string, unknown> = {};
  for (let i = keys.length - 1; i >= 0; i--) reversed[keys[i]!] = b[keys[i]!];
  assert.equal(deterministicArtifactKey(a), deterministicArtifactKey(reversed), "reversed insertion order yields the same canonical key");
});

test("runtime-specific timestamps, durations, run ids, and absolute paths are masked", () => {
  const normalized = normalizeArtifact(sampleAnalysis()) as unknown as {
    generatedAt: string;
    scan: { scan: { timestamp: string; durationMs: number | string } };
    summary: { scannedAt: string };
    regression: { baselinePath: string | null; runs: { baseline: { runId: string; scannedAt: string }; current: { runId: string; scannedAt: string } } };
    history: { historyDir: string; currentRunId: string };
    configuration: { path: string | null; resolved: { baselinePath: string | null } };
    verifications: Array<{ executedAt: string; durationMs: number | string; evidence: { screenshotPath: string | null } }>;
    findings: Array<{ verification: { executedAt: string; durationMs: number | string } }>;
    execution: { startedAt: string; durationMs: number | string };
    intelligence: { generatedAt: string };
    historicalIntelligence: { summary: { dateRange: { firstRunStartedAt: string } }; findings: Array<{ runIds: string[] }> };
  };

  // timestamps
  assert.equal(normalized.generatedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.scan.scan.timestamp, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.summary.scannedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.regression.runs.baseline.scannedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.regression.runs.current.scannedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.verifications[0]!.executedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.findings[0]!.verification.executedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.execution.startedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.intelligence.generatedAt, RUNTIME_TIMESTAMP_STUB);
  assert.equal(normalized.historicalIntelligence.summary.dateRange.firstRunStartedAt, RUNTIME_TIMESTAMP_STUB);

  // durations
  assert.equal(normalized.scan.scan.durationMs, RUNTIME_DURATION_MS_STUB);
  assert.equal(normalized.execution.durationMs, RUNTIME_DURATION_MS_STUB);
  assert.equal(normalized.verifications[0]!.durationMs, RUNTIME_DURATION_MS_STUB);
  assert.equal(normalized.findings[0]!.verification.durationMs, RUNTIME_DURATION_MS_STUB);

  // run ids (decoy-shaped baseline run id, hashed current run id, history
  // currentRunId, and the history runIds array)
  assert.equal(normalized.regression.runs.baseline.runId, RUNTIME_RUN_ID_STUB);
  assert.equal(normalized.regression.runs.current.runId, RUNTIME_RUN_ID_STUB);
  assert.equal(normalized.history.currentRunId, RUNTIME_RUN_ID_STUB);
  assert.equal(normalized.historicalIntelligence.findings[0]!.runIds[0], RUNTIME_RUN_ID_STUB);
  assert.equal(normalized.historicalIntelligence.findings[0]!.runIds[1], RUNTIME_RUN_ID_STUB);

  // absolute / machine-specific paths
  assert.equal(normalized.regression.baselinePath, MACHINE_PATH_STUB);
  assert.equal(normalized.history.historyDir, MACHINE_PATH_STUB);
  assert.equal(normalized.configuration.path, MACHINE_PATH_STUB);
  assert.equal(normalized.configuration.resolved.baselinePath, MACHINE_PATH_STUB);
  assert.equal(normalized.verifications[0]!.evidence.screenshotPath, MACHINE_PATH_STUB);
});

test("normalizeArtifact preserves meaningful report data", () => {
  const raw = sampleAnalysis();
  const normalized = normalizeArtifact(raw) as QaAnalysis;
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.mode, "deterministic");
  assert.equal(normalized.summary.overallStatus, "PASS");
  assert.equal(normalized.summary.bySeverity.MEDIUM, 1);
  assert.equal(normalized.findings[0]!.title, "Button is missing an accessible name");
  assert.equal(normalized.findings[0]!.severity, "MEDIUM");
  assert.equal(normalized.findings[0]!.count, 3);
  assert.equal(normalized.verifications[0]!.expectation, "Control has a label.");
  assert.equal(normalized.verifications[0]!.evidence.text, "Save");
  assert.equal(normalized.scan.scan.url, "https://qa.test/en");
  assert.equal(normalized.history?.runsAvailable, 3);
  assert.equal(normalized.historicalIntelligence?.summary.findings.observed, 1);
  assert.equal(normalized.configuration?.resolved.ciFailOn, "failed");
});

test("normalized equivalence: runtime-only differences are equal; content differences are not", () => {
  const a = sampleAnalysis();
  const b = sampleAnalysis();
  b.generatedAt = "2026-09-23T08:00:00.000Z";
  b.scan.scan.timestamp = "2026-09-23T08:00:05.000Z";
  b.history!.currentRunId = "2026-09-23T08-00-00-000Z-cc33dd44";
  b.regression!.runs.current.runId = "99".repeat(20);
  b.configuration!.path = "D:\\other\\qa.config.json";
  b.regression!.baselinePath = "D:\\other\\baseline.json";
  assert.equal(normalizedArtifactsEqual(a, b), true, "runtime-specific differences are ignored");

  const c = sampleAnalysis();
  c.findings[0]!.title = "Button is missing its name (edited)";
  assert.equal(normalizedArtifactsEqual(a, c), false, "a content difference is never normalized away");
});

test("bare run-id-shaped strings are normalized; prose that embeds one is preserved", () => {
  const normalized = normalizeArtifact({
    provenance: "inspected during run 2026-09-22T09-30-12-123Z-8f3a1c02",
    extra: { anything: "2026-09-18T01-02-03-004Z-deadbeef" },
  }) as unknown as { provenance: string; extra: { anything: string } };
  assert.equal(normalized.extra.anything, RUNTIME_RUN_ID_STUB, "a bare run-id value is masked even under a non-runId key");
  assert.equal(normalized.provenance, "inspected during run 2026-09-22T09-30-12-123Z-8f3a1c02", "run ids embedded inside prose are preserved as evidence");
});