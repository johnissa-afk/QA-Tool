// ---------------------------------------------------------------------------
// Phase 9 — baseline regression gate tests.
//
// Covers the pure gate module (severity parsing, the NEW/REGRESSION violation
// matrix, threshold behavior, non-finding isolation, inactive gate) and the
// CLI wiring (--write-baseline parsing, config gateMinSeverity, help text).
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeClassification, RegressionChange, RegressionMap } from "../regression/index.js";
import { GATE_DEFAULT_MIN_SEVERITY, evaluateGate, formatGateVerdict, parseGateMinSeverity } from "../qa/gate.js";
import { gateMinSeverityOf } from "../dashboard/evidence.js";
import type { Severity, QaAnalysis } from "../ai/types.js";
import { help, parseArgs } from "../qa-cli.js";

const change = (overrides: Partial<RegressionChange> = {}): RegressionChange => ({
  changeId: "R-1",
  category: "FINDING",
  classification: "NEW",
  confidence: "HIGH_CONFIDENCE",
  confidenceReason: "Present now, absent in the baseline.",
  anchor: "button-missing-name|/en",
  currentReference: "QA-F-001",
  baselineReference: "(none)",
  summary: "Finding button-missing-name newly observed on /en.",
  explanation: "The current run reports this finding where the baseline did not.",
  evidence: ["Verified REPRODUCED", "Absent from the baseline run."],
  recommendedAction: "Fix the root cause and add a verification probe.",
  relatedFindingIds: ["QA-F-001"],
  relatedFlowIds: [],
  relatedCoverageIds: [],
  relatedRecommendationIds: [],
  ...overrides,
});

const emptyCounts = (): Record<ChangeClassification, number> =>
  Object.fromEntries(
    ["NEW", "FIXED", "REGRESSION", "UNCHANGED", "CHANGED", "NEW_FLOW", "REMOVED_FLOW", "UNCHANGED_FLOW", "CHANGED_FLOW", "COVERAGE_CHANGED", "INFRASTRUCTURE_PROBLEM", "REVIEW_REQUIRED"].map((key) => [key, 0]),
  ) as Record<ChangeClassification, number>;

const runIdentity = { runId: "cur", runLabel: "current" as const, origin: "qa.test", sourceUrl: "https://qa.test/en", scannedAt: "2026-09-21T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" };

const mapOf = (changes: RegressionChange[]): RegressionMap => ({
  schemaVersion: 1,
  generatedAt: "2026-09-21T00:00:00.000Z",
  baselinePath: "reports/qa-baseline.json",
  summary: { comparable: true, notComparableReason: null, changeCount: changes.length, counts: emptyCounts(), headline: "compare" },
  runs: { baseline: { ...runIdentity, runId: "base", runLabel: "baseline" }, current: runIdentity },
  changes,
  aiNotes: null,
});

const findings = (pairs: [string, Severity][]): { id: string; severity: Severity }[] =>
  pairs.map(([id, severity]) => ({ id, severity }));

// --- severity parsing ---------------------------------------------------------

test("parseGateMinSeverity accepts the documented thresholds and is case/space-insensitive", () => {
  assert.equal(parseGateMinSeverity("HIGH"), "HIGH");
  assert.equal(parseGateMinSeverity("CRITICAL"), "CRITICAL");
  assert.equal(parseGateMinSeverity("critical"), "CRITICAL");
  assert.equal(parseGateMinSeverity("  High "), "HIGH");
});

test("parseGateMinSeverity rejects unknown thresholds and non-strings", () => {
  for (const invalid of ["low", "MEDIUM", "info", "severe", ""]) {
    assert.throws(() => parseGateMinSeverity(invalid), /Invalid gate severity/, `"${invalid}" must be rejected`);
  }
  assert.throws(() => parseGateMinSeverity(null), /Invalid gate severity/);
  assert.throws(() => parseGateMinSeverity(3), /Invalid gate severity/);
  assert.equal(GATE_DEFAULT_MIN_SEVERITY, "HIGH");
});

// --- inactive gate -------------------------------------------------------------

test("the gate is inactive without a regression comparison and never fails", () => {
  const verdict = evaluateGate({ regression: null, findings: findings([["QA-F-001", "HIGH"]]) });
  assert.equal(verdict.enabled, false);
  assert.equal(verdict.failed, false);
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.evaluated, 0);
});

// --- NEW threshold matrix --------------------------------------------------------

test("a NEW HIGH finding fails the gate at the default threshold", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change({ currentReference: "QA-F-001" })]), findings: findings([["QA-F-001", "HIGH"]]) },
  );
  assert.equal(verdict.failed, true);
  assert.equal(verdict.violations.length, 1);
  assert.equal(verdict.violations[0]!.classification, "NEW");
  assert.equal(verdict.violations[0]!.severity, "HIGH");
  assert.equal(verdict.violations[0]!.findingId, "QA-F-001");
  assert.ok(verdict.violations[0]!.summary.includes("newly observed"));
});

test("a NEW CRITICAL finding fails the gate", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change()]), findings: findings([["QA-F-001", "CRITICAL"]]) },
  );
  assert.equal(verdict.failed, true);
  assert.equal(verdict.violations[0]!.severity, "CRITICAL");
});

test("a NEW MEDIUM finding does NOT fail the gate at the default HIGH threshold", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change()]), findings: findings([["QA-F-001", "MEDIUM"]]) },
  );
  assert.equal(verdict.failed, false);
  assert.equal(verdict.violations.length, 0);
  assert.equal(verdict.newBelowThreshold, 1, "the skipped NEW is counted honestly");
});

test("a NEW LOW finding never fails, and the count is honest", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change()]), findings: findings([["QA-F-001", "LOW"]]) },
  );
  assert.equal(verdict.failed, false);
  assert.equal(verdict.newBelowThreshold, 1);
});

test("a NEW HIGH finding does NOT fail a CRITICAL-gated pipeline", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change()]), findings: findings([["QA-F-001", "HIGH"]]) },
    { minSeverity: "CRITICAL" },
  );
  assert.equal(verdict.failed, false);
  assert.equal(verdict.newBelowThreshold, 1);
});

test("a NEW finding whose severity cannot be resolved never fails the gate", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change({ currentReference: "QA-F-999" })]), findings: findings([["QA-F-001", "HIGH"]]) },
  );
  assert.equal(verdict.failed, false);
  assert.equal(verdict.newBelowThreshold, 1);
});

// --- REGRESSION matrix ----------------------------------------------------------

test("a verified finding REGRESSION fails the gate regardless of severity", () => {
  for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const) {
    const verdict = evaluateGate(
      { regression: mapOf([change({ classification: "REGRESSION", currentReference: "QA-F-002", relatedFindingIds: ["QA-F-BASE", "QA-F-002"] })]), findings: findings([["QA-F-002", severity]]) },
    );
    assert.equal(verdict.failed, true, `${severity} REGRESSION must fail`);
    assert.equal(verdict.violations[0]!.classification, "REGRESSION");
  }
});

test("a REGRESSION without resolvable severity still fails (the classification is the evidence)", () => {
  const verdict = evaluateGate(
    { regression: mapOf([change({ classification: "REGRESSION", currentReference: "QA-F-002" })]), findings: findings([]) },
  );
  assert.equal(verdict.failed, true);
  assert.equal(verdict.violations[0]!.severity, null);
});

// --- non-violations --------------------------------------------------------------

test("other FINDING classifications are never gate violations", () => {
  const classifications = ["FIXED", "UNCHANGED", "CHANGED", "REVIEW_REQUIRED"] as const;
  const verdict = evaluateGate(
    { regression: mapOf(classifications.map((classification, index) => change({ changeId: `R-C${index}`, classification, currentReference: `QA-F-0${index}` }))), findings: findings([["QA-F-00", "HIGH"], ["QA-F-01", "HIGH"], ["QA-F-02", "HIGH"], ["QA-F-03", "HIGH"]]) },
  );
  assert.equal(verdict.failed, false);
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.evaluated, 0, "non NEW/REGRESSION findings are not even evaluated");
});

test("non-finding categories (flows, coverage) are never gate violations", () => {
  const verdict = evaluateGate(
    {
      regression: mapOf([
        change({ category: "FLOW", classification: "REGRESSION", currentReference: "FLOW-NAV", relatedFindingIds: [] }),
        change({ category: "COVERAGE", classification: "COVERAGE_CHANGED", currentReference: "COV-1", relatedFindingIds: [] }),
        change({ category: "RECOMMENDATION", classification: "NEW", currentReference: "REC-1", relatedFindingIds: [] }),
      ]),
      findings: findings([]),
    },
  );
  assert.equal(verdict.failed, false);
  assert.equal(verdict.evaluated, 0);
});

test("an empty change list passes", () => {
  const verdict = evaluateGate({ regression: mapOf([]), findings: findings([]) });
  assert.equal(verdict.failed, false);
  assert.equal(verdict.evaluated, 0);
});

test("evaluated counts only FINDING NEW/REGRESSION changes, mixed maps are exact", () => {
  const verdict = evaluateGate({
    regression: mapOf([
      change({ changeId: "R1", currentReference: "QA-F-001" }),
      change({ changeId: "R2", classification: "REGRESSION", currentReference: "QA-F-002" }),
      change({ changeId: "R3", classification: "FIXED", currentReference: "QA-F-003" }),
      change({ changeId: "R4", category: "FLOW", classification: "REGRESSION" }),
    ]),
    findings: findings([["QA-F-001", "CRITICAL"], ["QA-F-002", "MEDIUM"]]),
  });
  assert.equal(verdict.evaluated, 2);
  assert.equal(verdict.violations.length, 2);
  assert.equal(verdict.violations[0]!.changeId, "R1");
  assert.equal(verdict.violations[1]!.changeId, "R2");
});

// --- formatting ------------------------------------------------------------------

test("formatGateVerdict prints a deterministic block for active and inactive gates", () => {
  const failing = formatGateVerdict(evaluateGate({ regression: mapOf([change()]), findings: findings([["QA-F-001", "HIGH"]]) }));
  assert.ok(failing.startsWith("GATE (fail on new findings ≥ HIGH"));
  assert.ok(failing.includes("Result: FAIL"));
  assert.ok(failing.includes("- NEW (HIGH) · QA-F-001"));
  const inactive = formatGateVerdict(evaluateGate({ regression: null, findings: [] }));
  assert.ok(inactive.includes("inactive"));
});

// --- CLI + config wiring ----------------------------------------------------------

test("--write-baseline parses and is never mistaken for a URL", () => {
  const options = parseArgs(["https://qa.test/en", "--crawl", "--write-baseline", "baseline/x.json"]);
  assert.equal(options?.writeBaselinePath, "baseline/x.json");
  assert.equal(options?.url, "https://qa.test/en");
});

test("gateMinSeverity defaults to HIGH and is overridable via configuration", () => {
  assert.equal(parseArgs(["https://qa.test/en", "--ci", "--baseline", "reports/qa-baseline.json"])?.gateMinSeverity, "HIGH");
  const strict = parseArgs(["https://qa.test/en", "--ci"], { ci: { gateMinSeverity: "CRITICAL" } });
  assert.equal(strict?.gateMinSeverity, "CRITICAL");
});

test("help documents --write-baseline, the gate, and the gate threshold", () => {
  assert.ok(help.includes("--write-baseline"));
  assert.ok(help.includes("CI baseline gate"));
  assert.ok(help.includes("ci.gateMinSeverity"));
  assert.ok(help.includes("NEW"));
  assert.ok(help.includes("REGRESSION"));
});

test("a gated run is a complete QaAnalysis fixture the evaluator can consume", () => {
  // Guards the structural contract used by qa-cli and the dashboard.
  const analysis = { regression: mapOf([change()]), findings: [{ id: "QA-F-001", severity: "HIGH" }] } as unknown as QaAnalysis;
  const verdict = evaluateGate(
    { regression: analysis.regression, findings: analysis.findings },
    { minSeverity: gateMinSeverityOf(analysis) },
  );
  assert.equal(verdict.failed, true);
});