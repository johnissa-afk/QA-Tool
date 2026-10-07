// ---------------------------------------------------------------------------
// Phase 13 — performance budgets.
//
// Two layers are covered here, both deterministic:
//
//   1. the QA-side budget module (loud loading, applying to a report, honest
//      summary counters, idempotence) and the classification of a breach
//      (CRITICAL severity, "performance" domain, real finding title);
//   2. the BUILT CLI end to end — spawned exactly as CI runs it — so the exit
//      codes are asserted against real user-facing behavior rather than against
//      a unit that only claims it would fail.
//
// The CLI cases reuse `--report` fixtures, so no browser or network is needed
// and the results are reproducible. Baselines and email artifacts are never
// touched: every fixture lives in a per-test temp directory.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectIssues, groupIssues } from "../checks.js";
import { domainFor, labelFor } from "../ai/analysis.js";
import { classifyIssue } from "../ai/severity.js";
import { renderQaHtml } from "../ai/report.js";
import { analyzeScan } from "../ai/index.js";
import { PERF_METRIC_LABELS, PERF_BUDGET_CODE_PREFIX, isPerfBudgetCode, perfBudgetMetricOf, parsePerfBudgets, checkPerfBudgets } from "../perf-budgets.js";
import { applyPerfBudgets, describePerfBudgets, loadQaPerfBudgets } from "../qa/perf.js";
import { CI_EXIT_INFRASTRUCTURE, CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS } from "../qa/ci-policy.js";
import type { DiscoveredElement, Issue, PerformanceMetrics, PerfBudgets, ScanReport } from "../types.js";

// Deterministic mode for every child run.
process.env.AI_API_KEY = "";

const CLI_PATH = join(process.cwd(), "dist", "qa-cli.js");
assert.ok(existsSync(CLI_PATH), `the built CLI is required for performance-budget tests: ${CLI_PATH}`);

const sanitizedEnv = (): Record<string, string | undefined> => ({ ...process.env, AI_API_KEY: "", QA_USERNAME: "", QA_PASSWORD: "", QA_AUTHORIZATION: "" });

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, encoding: "utf8", timeout: 120000, env: sanitizedEnv() });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "qa-perf-budgets-"));

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const METRICS: PerformanceMetrics = { ttfb: 120, fcp: 900, lcp: 4200, cls: 0.21, domContentLoaded: 800, loadEvent: 5000 };

/** A clean scan report that carries measured performance metrics. */
const perfReport = (performance: PerformanceMetrics | undefined = METRICS): ScanReport => {
  const elements = [element()];
  const issues = groupIssues(detectIssues(elements, { title: "QA performance target", lang: "en", viewport: "width=device-width" }));
  const report: ScanReport = {
    scan: { url: "https://perf.qa.test/en", finalUrl: "https://perf.qa.test/en", title: "QA performance target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: 1, passes: issues.filter(issue => issue.status === "PASS").reduce((t, issue) => t + (issue.count ?? 1), 0), warnings: 0, failures: issues.filter(issue => issue.status === "FAIL").reduce((t, issue) => t + (issue.count ?? 1), 0), infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: issues.length, groupedIssueCounts: { passes: issues.filter(issue => issue.status === "PASS").length, warnings: 0, failures: issues.filter(issue => issue.status === "FAIL").length, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements, issues, links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
  };
  if (performance) report.performance = performance;
  return report;
};

/** The same report behind an access prerequisite: the normal scan never ran. */
const accessBlockedReport = (): ScanReport => ({
  ...perfReport(undefined),
  access: { url: "https://perf.qa.test/en", finalUrl: "https://perf.qa.test/en", httpStatus: 403, accessStatus: "access-blocked", authenticationType: "none", challenge: null, redirectDestination: null, reason: "Access denied.", continueScan: false, humanReview: true },
  accessPrerequisite: { type: "access-blocked", status: "BLOCKED", message: "Access denied.", httpStatus: 403, challenge: null },
  issues: [],
});

const budgetsFile = (dir: string, budgets: PerfBudgets, name = "perf.budgets.json"): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(budgets, null, 2), "utf8");
  return path;
};

const reportFile = (dir: string, report: ScanReport, name = "scan-report.json"): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
};

const issueContext = { navigationStatus: 200, authenticationAccepted: true, interactiveElementCount: 1, brokenLinkCount: 0 };

// --- loud loading ------------------------------------------------------------

test("a missing performance budgets file is a loud error, never a silent pass", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => loadQaPerfBudgets(join(dir, "nope.json")),
      /Invalid performance budgets file .*nope\.json.* does not exist/,
      "an absent budget file must not be treated as 'no budgets'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed JSON and unknown metrics are rejected with the file named", () => {
  const dir = tempDir();
  try {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    assert.throws(() => loadQaPerfBudgets(broken), /Invalid performance budgets file .*malformed JSON/);

    const unknown = join(dir, "unknown.json");
    writeFileSync(unknown, JSON.stringify({ lcp: 2500, lcp2: 1 }), "utf8");
    assert.throws(() => loadQaPerfBudgets(unknown), /Invalid performance budgets file .*unknown property "lcp2"/);

    const negative = join(dir, "negative.json");
    writeFileSync(negative, JSON.stringify({ ttfb: -1 }), "utf8");
    assert.throws(() => loadQaPerfBudgets(negative), /ttfb.*non-negative number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid budgets file is read back with exactly the declared thresholds", () => {
  const dir = tempDir();
  try {
    const path = budgetsFile(dir, { lcp: 2500, cls: 0.1 });
    assert.deepEqual(loadQaPerfBudgets(path), { lcp: 2500, cls: 0.1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a UTF-8 BOM written by Windows tooling is tolerated, not reported as broken JSON", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "bom.budgets.json");
    // Exactly what `Set-Content -Encoding utf8` produces on Windows PowerShell.
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ lcp: 2500 }), "utf8")]));
    assert.deepEqual(loadQaPerfBudgets(path), { lcp: 2500 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- applying to a report ----------------------------------------------------

test("applying budgets adds one FAIL issue per breached metric and keeps summary counters honest", () => {
  const report = perfReport();
  const before = report.summary.failures;
  const added = applyPerfBudgets(report, { lcp: 2500, cls: 0.1, ttfb: 100 });

  assert.equal(added.length, 3, "lcp, cls and ttfb all breach; fcp/domContentLoaded/loadEvent have no budget");
  assert.deepEqual(added.map(issue => issue.code).sort(), ["perf-budget-cls", "perf-budget-lcp", "perf-budget-ttfb"]);
  assert.ok(added.every(issue => issue.status === "FAIL"), "a breach is a FAIL issue");

  // The artifact can never claim 0 failures while carrying a FAIL issue.
  const failures = report.summary.failures;
  assert.equal(failures, before + 3, "summary.failures counts the new breaches");
  assert.equal(report.summary.issueGroups, report.issues.length, "issueGroups matches the grouped list");
  assert.equal(report.summary.groupedIssueCounts.failures, report.issues.filter(issue => issue.status === "FAIL").length);

  const message = added.find(issue => issue.code === "perf-budget-lcp")!.message;
  assert.match(message, /LCP exceeded budget: 4200 ms > 2500 ms/);
});

test("applying budgets is idempotent and leaves a report without breaches untouched", () => {
  const report = perfReport();
  const first = applyPerfBudgets(report, { lcp: 2500 });
  const snapshot = JSON.stringify(report);

  const second = applyPerfBudgets(report, { lcp: 2500 });
  assert.equal(second.length, first.length, "the same breach is re-detected on a re-apply");
  assert.equal(JSON.stringify(report), snapshot, "a second application must not double-count anything");

  const clean = perfReport();
  const issuesBefore = JSON.stringify(clean.issues);
  const summaryBefore = JSON.stringify(clean.summary);
  assert.deepEqual(applyPerfBudgets(clean, { lcp: 99999 }), []);
  assert.equal(JSON.stringify(clean.issues), issuesBefore, "a passing budget changes no issue");
  assert.equal(JSON.stringify(clean.summary), summaryBefore, "a passing budget changes no summary counter");
});

test("metrics that were not measured are never judged", () => {
  assert.deepEqual(checkPerfBudgets({ ...METRICS, lcp: null }, { lcp: 2500 }), [], "an unavailable metric cannot breach a budget");
  const report = perfReport({ ...METRICS, lcp: null, cls: null, ttfb: null });
  assert.deepEqual(applyPerfBudgets(report, { lcp: 2500, cls: 0.1, ttfb: 800 }), []);
});

test("describePerfBudgets names every configured threshold with its unit", () => {
  const budgets = parsePerfBudgets({ lcp: 2500, cls: 0.1 }, "inline");
  assert.equal(describePerfBudgets(budgets), "LCP 2500ms, CLS 0.1");
  assert.equal(describePerfBudgets({}), "");
});

// --- classification ----------------------------------------------------------

test("every perf-budget code maps to its metric, the performance domain, and a real title", () => {
  for (const key of Object.keys(PERF_METRIC_LABELS) as (keyof PerfBudgets)[]) {
    const code = `${PERF_BUDGET_CODE_PREFIX}${key}`;
    assert.ok(isPerfBudgetCode(code), `${code} is a budget code`);
    assert.equal(perfBudgetMetricOf(code), key);
    assert.equal(domainFor(code), "performance", `${code} belongs to the performance domain`);
    assert.ok(labelFor(code).startsWith("Performance budget exceeded:"), `${code} has a readable title`);
  }
  assert.equal(perfBudgetMetricOf("perf-budget-nope"), null, "an unknown metric is not claimed");
  assert.equal(isPerfBudgetCode("unhealthy-link"), false);
  assert.equal(domainFor("unhealthy-link"), "navigation", "existing domains are unchanged");
});

test("a budget breach is classified CRITICAL so the default CI policy actually fails", () => {
  const issue: Issue = { status: "FAIL", code: "perf-budget-lcp", message: "LCP exceeded budget: 4200 ms > 2500 ms", examples: [{ detail: "LCP: 4200 ms" }] };
  const verdict = classifyIssue(issue, issueContext);
  assert.equal(verdict.severity, "CRITICAL");
  assert.equal(verdict.confidence, "high");
  assert.match(verdict.rationale, /LCP exceeded budget: 4200 ms > 2500 ms/);
  assert.match(verdict.rationale, /declared for this QA target/);
  assert.ok(verdict.recommendation.length > 0 && verdict.userImpact.length > 0);

  // Every metric produces the same verdict shape — one rule, no special cases.
  for (const key of Object.keys(PERF_METRIC_LABELS) as (keyof PerfBudgets)[]) {
    const other = classifyIssue({ ...issue, code: `${PERF_BUDGET_CODE_PREFIX}${key}` }, issueContext);
    assert.equal(other.severity, "CRITICAL", `${key} breach is release-blocking`);
  }
});

// --- report rendering --------------------------------------------------------

test("the QA HTML report renders a Performance section with measured metrics and the breach", async () => {
  const report = perfReport();
  applyPerfBudgets(report, { lcp: 2500 });
  const analysis = await analyzeScan(report);
  const html = renderQaHtml(analysis);

  assert.ok(html.includes("<h2>Performance</h2>"), "the report has a Performance section");
  assert.ok(html.includes("<th>LCP</th>"), "measured metrics are rendered");
  assert.ok(html.includes("4200 ms"), "the measured value is shown");
  assert.ok(html.includes("Declared budgets exceeded"), "the breach is called out");
  assert.ok(html.includes("perf-budget-lcp"), "the breach traces to its finding code");
});

// --- real CLI behavior -------------------------------------------------------

const cliArgs = (dir: string, reportPath: string, output: string, extra: string[] = []): string[] => [
  "--report", reportPath,
  "--output", join(dir, output),
  "--history-dir", join(dir, "history"),
  "--execute", "none",
  ...extra,
];

test("CLI: a breached budget fails CI with exit 1 and the Phase 11C policy line", () => {
  const dir = tempDir();
  try {
    const reportPath = reportFile(dir, perfReport());
    const budgetPath = budgetsFile(dir, { lcp: 2500 });

    const run = runCli(cliArgs(dir, reportPath, "qa-analysis.json", ["--perf-budgets", budgetPath, "--ci"]), dir);
    assert.equal(run.status, CI_EXIT_POLICY_FAILURE, `breaching a declared budget must fail CI\n${run.stdout}\n${run.stderr}`);
    assert.ok(run.stdout.includes("Performance budgets:"), run.stdout);
    assert.ok(run.stdout.includes("BREACH perf-budget-lcp"), run.stdout);
    assert.ok(run.stdout.includes("1 of 1 breached"), run.stdout);
    assert.ok(run.stdout.includes("QA status: FAIL"), `the breach surfaces as a FAIL status\n${run.stdout}`);
    assert.ok(run.stdout.includes("Failure mode: policy → exit 1."), "the printed classification matches the exit code");

    const analysisPath = join(dir, "qa-analysis.json");
    assert.ok(existsSync(analysisPath), "the run still wrote its artifact");
    const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
    const finding = analysis.findings.find((item: { code: string }) => item.code === "perf-budget-lcp");
    assert.ok(finding, "the breach is a first-class finding in the report artifact");
    assert.equal(finding.severity, "CRITICAL");
    assert.equal(finding.domain, "performance");
    assert.equal(analysis.summary.overallStatus, "FAIL");
    assert.ok(renderQaHtml(analysis).includes("<h2>Performance</h2>"), "the written HTML report carries the Performance section");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: budgets that are satisfied leave CI at exit 0", () => {
  const dir = tempDir();
  try {
    const reportPath = reportFile(dir, perfReport());
    const budgetPath = budgetsFile(dir, { lcp: 99999, cls: 1 });

    const run = runCli(cliArgs(dir, reportPath, "qa-analysis.json", ["--perf-budgets", budgetPath, "--ci"]), dir);
    assert.equal(run.status, CI_EXIT_SUCCESS, `a passing budget must not fail CI\n${run.stdout}\n${run.stderr}`);
    assert.ok(run.stdout.includes("0 of 2 breached"), run.stdout);
    assert.ok(!run.stdout.includes("BREACH"), run.stdout);
    assert.ok(run.stdout.includes("CI: acceptable → exit 0."), run.stdout);
    assert.ok(run.stdout.includes("Failure mode: success → exit 0."), run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: without --ci a breached budget is reported but the local run still exits 0", () => {
  const dir = tempDir();
  try {
    const reportPath = reportFile(dir, perfReport());
    const budgetPath = budgetsFile(dir, { lcp: 2500 });

    const run = runCli(cliArgs(dir, reportPath, "qa-analysis.json", ["--perf-budgets", budgetPath]), dir);
    assert.equal(run.status, CI_EXIT_SUCCESS, `local (non-CI) behavior is unchanged by Phase 13\n${run.stdout}\n${run.stderr}`);
    assert.ok(run.stdout.includes("BREACH perf-budget-lcp"), "the breach is still reported locally");
    assert.ok(!run.stdout.includes("Failure mode:"), "no failure-mode line is printed outside --ci");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: without any budget file the run behaves exactly as before Phase 13", () => {
  const dir = tempDir();
  try {
    const reportPath = reportFile(dir, perfReport());
    const run = runCli(cliArgs(dir, reportPath, "qa-analysis.json", ["--ci"]), dir);
    assert.equal(run.status, CI_EXIT_SUCCESS, `an unconfigured feature cannot change an existing run\n${run.stdout}\n${run.stderr}`);
    assert.ok(!run.stdout.includes("Performance budgets:"), run.stdout);

    const analysis = JSON.parse(readFileSync(join(dir, "qa-analysis.json"), "utf8"));
    assert.equal(analysis.findings.filter((item: { code: string }) => item.code.startsWith("perf-budget-")).length, 0);
    assert.equal(analysis.summary.overallStatus, "NOT_TESTED", "the existing NOT_TESTED verdict is preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a missing budgets file is a configuration failure (2 with --ci, 1 without)", () => {
  const dir = tempDir();
  try {
    const reportPath = reportFile(dir, perfReport());

    const ci = runCli(cliArgs(dir, reportPath, "ci.json", ["--perf-budgets", join(dir, "missing.json"), "--ci"]), dir);
    assert.equal(ci.status, CI_EXIT_INFRASTRUCTURE, `configuration failures keep the CI exit-2 contract\n${ci.stdout}\n${ci.stderr}`);
    assert.ok(ci.stderr.includes("Invalid performance budgets file"), ci.stderr);
    assert.ok(ci.stderr.includes("Failure mode: configuration → exit 2."), ci.stderr);

    const local = runCli(cliArgs(dir, reportPath, "local.json", ["--perf-budgets", join(dir, "missing.json")]), dir);
    assert.equal(local.status, CI_EXIT_POLICY_FAILURE, `configuration failures keep the local exit-1 contract\n${local.stdout}\n${local.stderr}`);
    // A thrown error is reported on stderr in both modes; only the exit code
    // differs between local and --ci.
    assert.ok(local.stderr.includes("Failure mode: configuration → exit 1."), local.stderr);
    assert.ok(local.stderr.includes("Invalid performance budgets file"), local.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: budgets are not evaluated when an access prerequisite stopped the scan", () => {
  const dir = tempDir();
  try {
    const reportPath = reportFile(dir, accessBlockedReport());
    const budgetPath = budgetsFile(dir, { lcp: 2500 });

    const run = runCli(cliArgs(dir, reportPath, "qa-analysis.json", ["--perf-budgets", budgetPath, "--ci"]), dir);
    assert.equal(run.status, CI_EXIT_POLICY_FAILURE, "an untested target still fails CI under the access rule");
    assert.ok(run.stdout.includes("Performance budgets: not evaluated"), run.stdout);
    assert.ok(!run.stdout.includes("BREACH"), "no finding is invented from an untested target");
    assert.ok(run.stdout.includes("status: BLOCKED"), run.stdout);
    assert.ok(run.stdout.includes("Failure mode: policy → exit 1."), run.stdout);

    const analysis = JSON.parse(readFileSync(join(dir, "qa-analysis.json"), "utf8"));
    assert.equal(analysis.findings.length, 0, "the access prerequisite keeps findings at zero");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
