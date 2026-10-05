import test from "node:test";
import assert from "node:assert/strict";
import { detectAccess } from "../qa/access.js";
import { analyzeScan, applyVerification, recomputeOverallStatus } from "../ai/index.js";
import { renderQaHtml } from "../ai/report.js";
import { ACCESS_PREREQUISITE_CODE } from "../ai/analysis.js";
import { buildVerificationTasks } from "../executor/tasks.js";
import { loadVerificationResults } from "../executor/parse.js";
import { printJsonSummary, writeReports } from "../reporter.js";
import type { QaExecution, VerificationResult } from "../ai/types.js";
import type { ScanReport, DiscoveredElement } from "../types.js";
import type { AccessDetection } from "../qa/access.js";
import type { VerificationTask } from "../executor/tasks.js";
import { rmSync, writeFileSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const makeResult = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  findingId: "QA-F-001",
  scenarioId: "SC-VER-001",
  strategy: "accessible-name",
  locator: "page.locator(\"#submit-btn\")",
  status: "REPRODUCED",
  category: "WEBSITE",
  executedAt: new Date().toISOString(),
  durationMs: 10,
  expectation: "The element must expose an accessible name.",
  evidence: { located: true, locator: "page.locator(\"#submit-btn\")", tag: "button", role: "button", accessibleName: null, text: null, visible: true, enabled: true, href: null, url: "https://qa.test", id: "submit-btn", attributes: null, count: 1, screenshotPath: null },
  error: null,
  triage: { verdict: "LIKELY_DEFECT", reason: "The live DOM matches the suspected problem.", confidence: "high", provider: "deterministic" },
  ...overrides,
});

const input = (overrides: Partial<Parameters<typeof detectAccess>[0]> = {}) => ({ url: "https://qa.test", finalUrl: "https://qa.test", httpStatus: 200, headers: {}, body: "<html><body>Public</body></html>", ...overrides });

test("access detection allows a normal public HTML page", () => {
  const result = detectAccess(input());
  assert.equal(result.accessStatus, "accessible");
  assert.equal(result.authenticationType, "none");
  assert.equal(result.continueScan, true);
  assert.equal(result.humanReview, false);
});

test("access detection classifies HTTP authentication challenges", () => {
  for (const [challenge, type] of [["Basic realm=\"test\"", "basic"], ["Digest realm=\"test\"", "digest"], ["Bearer realm=\"api\"", "bearer"], ["Negotiate", "negotiate"], ["NTLM", "ntlm"] as const]) {
    const result = detectAccess(input({ httpStatus: 401, headers: { "www-authenticate": challenge } }));
    assert.equal(result.accessStatus, "authentication-required");
    assert.equal(result.authenticationType, type);
    assert.equal(result.continueScan, false);
    assert.equal(result.humanReview, true);
  }
  assert.equal(detectAccess(input({ httpStatus: 401 })).authenticationType, "unknown");
});

test("access detection distinguishes application login redirects from ordinary redirects", () => {
  const login = detectAccess(input({ finalUrl: "https://qa.test/login", body: "<form><input type=password><button>Sign in</button></form>" }));
  assert.equal(login.accessStatus, "login-required");
  assert.equal(login.redirectDestination, "https://qa.test/login");
  assert.equal(detectAccess(input({ finalUrl: "https://qa.test/about", body: "<html><h1>About</h1></html>" })).accessStatus, "accessible");
});

test("access detection classifies generic blocks and bot challenges", () => {
  assert.equal(detectAccess(input({ httpStatus: 403, body: "<h1>Forbidden</h1>" })).accessStatus, "access-blocked");
  assert.equal(detectAccess(input({ httpStatus: 403, body: "<title>Cloudflare challenge</title>" })).accessStatus, "bot-protection");
  assert.equal(detectAccess(input({ httpStatus: 200, body: "<h1>Access Denied</h1>" })).accessStatus, "access-blocked");
});

test("access detection fails safely for unknown responses and never stores credentials", () => {
  const result = detectAccess(input({ httpStatus: 0, headers: { "x-debug": "secret" }, body: "unexpected" }));
  assert.equal(result.accessStatus, "unknown");
  assert.equal(result.continueScan, false);
  assert.equal(JSON.stringify(result).includes("password"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("authentication-required is a hard analysis boundary", async () => {
  const access = detectAccess(input({ httpStatus: 401, headers: { "www-authenticate": "Basic realm=\"test\"" } }));
  const report: ScanReport = {
    scan: { url: "https://qa.test", finalUrl: "https://qa.test", title: "", timestamp: "2026-09-22T00:00:00.000Z", durationMs: 1, navigationStatus: 401 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: false },
    access,
    accessPrerequisite: { type: "authentication-required", status: "REVIEW_REQUIRED", message: "Access prerequisite: authentication required." },
    summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: null, viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements: [],
    issues: [],
    links: [],
    consoleErrors: [],
    consoleDiagnostics: [],
    pageErrors: [],
  };
  const analysis = await analyzeScan(report, { coverage: true });
  assert.equal(analysis.summary.overallStatus, "REVIEW");
  assert.equal(analysis.findings.length, 0);
  assert.equal(analysis.accessPrerequisite?.type, "authentication-required");
  assert.equal(analysis.accessPrerequisite?.status, "REVIEW_REQUIRED");
  assert.equal(analysis.flows.length, 0);
  assert.equal(analysis.flowDiscovery, null);
  assert.equal(analysis.elementScenarios.length, 0);
  assert.equal(analysis.verifications.length, 0);
   assert.equal(analysis.coverage, null);
});

// ---------------------------------------------------------------------------
// Access-prerequisite regression tests (bot-protection, access-blocked, etc.)
// ---------------------------------------------------------------------------

const baseScanReport = (access: AccessDetection, overrides: Partial<ScanReport> = {}): ScanReport => ({
  scan: { url: "https://qa.test", finalUrl: "https://qa.test", title: "", timestamp: "2026-09-22T00:00:00.000Z", durationMs: 1, navigationStatus: access.httpStatus ?? 403 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: false },
  access,
  accessPrerequisite: {
    type: access.accessStatus,
    status: access.accessStatus === "access-blocked" ? "BLOCKED" : "REVIEW_REQUIRED",
    message: access.reason,
    httpStatus: access.httpStatus,
    challenge: access.challenge,
  },
  summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
  page: { language: null, viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements: [],
  issues: [],
  links: [],
  consoleErrors: [],
  consoleDiagnostics: [],
  pageErrors: [],
  ...overrides,
});

const accessibleReport = (overrides: Partial<ScanReport> = {}): ScanReport => ({
  scan: { url: "https://qa.test", finalUrl: "https://qa.test", title: "Public Site", timestamp: "2026-09-22T00:00:00.000Z", durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
  summary: { totalElements: 1, interactiveElements: 1, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
  page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements: [],
  issues: [],
  links: [],
  consoleErrors: [],
  consoleDiagnostics: [],
  pageErrors: [],
  ...overrides,
});

test("bot-protection → normal scan does not run, website findings = 0, final status = REVIEW", async () => {
  const access = detectAccess(input({ httpStatus: 403, body: "<title>Cloudflare challenge</title> <div class=\"challenge\">Please verify you are human</div>" }));
  assert.equal(access.accessStatus, "bot-protection");
  assert.equal(access.continueScan, false);
  const report = baseScanReport(access);
  const analysis = await analyzeScan(report, { coverage: true });
  assert.equal(analysis.findings.length, 0, "bot protection must not produce website findings");
  assert.equal(analysis.accessPrerequisite?.type, "bot-protection");
  assert.equal(analysis.accessPrerequisite?.status, "REVIEW_REQUIRED");
  assert.equal(analysis.summary.overallStatus, "REVIEW");
  assert.equal(analysis.flows.length, 0);
  assert.equal(analysis.flowDiscovery, null);
  assert.equal(analysis.coverage, null);
  assert.equal(analysis.execution, null);
});

test("access-blocked → normal scan does not run, website findings = 0, final status = BLOCKED", async () => {
  const access = detectAccess(input({ httpStatus: 403, body: "<h1>Forbidden</h1>" }));
  assert.equal(access.accessStatus, "access-blocked");
  assert.equal(access.continueScan, false);
  const report = baseScanReport(access);
  const analysis = await analyzeScan(report, { coverage: true });
  assert.equal(analysis.findings.length, 0, "access blocked must not produce website findings");
  assert.equal(analysis.accessPrerequisite?.type, "access-blocked");
  assert.equal(analysis.accessPrerequisite?.status, "BLOCKED");
  assert.equal(analysis.summary.overallStatus, "BLOCKED");
  assert.equal(analysis.flows.length, 0);
  assert.equal(analysis.coverage, null);
  assert.equal(analysis.execution, null);
});

test("accessible page with zero executable tests → final status = NOT_TESTED, never PASS", async () => {
  const report = accessibleReport();
  const analysis = await analyzeScan(report, { coverage: true });
  assert.equal(analysis.accessPrerequisite, undefined, "no access prerequisite for an accessible page");
  assert.equal(analysis.findings.length, 0, "no findings on a clean page");
  assert.equal(analysis.summary.scheduled, 0);
  assert.equal(analysis.summary.verified, 0);
  assert.equal(analysis.summary.overallStatus, "NOT_TESTED", "zero tests executed must never yield PASS");
});

test("an execution record reporting zero tests is NOT evidence of testing", async () => {
  const report = accessibleReport();
  const analysis = await analyzeScan(report, {});
  assert.equal(analysis.findings.length, 0);
  const emptyExecution: QaExecution = { status: "passed", command: "node cli.js", startedAt: new Date().toISOString(), durationMs: 100, tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, reproduced: 0, notReproduced: 0, review: 0, infrastructureFailures: 0, failures: [] };
  const applied = applyVerification(analysis, { tasks: [], skipped: [], results: [], execution: emptyExecution });
  assert.equal(applied.summary.scheduled, 0, "zero tasks scheduled");
  assert.equal(applied.summary.verified, 0, "zero tasks executed");
  const recomputed = recomputeOverallStatus(applied);
  assert.equal(recomputed, "NOT_TESTED", "a run that executed zero tests is NOT_TESTED, not PASS");
  assert.equal(applied.summary.overallStatus, "NOT_TESTED");
});

test("accessible page with a qualifying CRITICAL finding and verified reproduction → FAIL", async () => {
  const report = accessibleReport({ issues: [{ status: "FAIL", code: "page-http-error", message: "Page returned HTTP 500.", count: 1, examples: [] }] });
  const analysis = await analyzeScan(report, {});
  assert.ok(analysis.findings.some(finding => finding.code === "page-http-error"));
  const layer = buildVerificationTasks(analysis.findings, report as never);
  assert.equal(layer.tasks.length, 0, "page-http-error is not verifiable");
  const status = recomputeOverallStatus({ ...analysis, summary: { ...analysis.summary, scheduled: 0, verified: 0 } });
  assert.equal(status, "FAIL", "a CRITICAL finding must yield FAIL");
});

test("access prerequisite must never increase finding count, occurrence count, severity counts, or verified count", async () => {
  for (const [label, accessStatus, detectOverrides] of [
    ["bot-protection", "bot-protection", { httpStatus: 403, body: "<title>Cloudflare challenge</title>" } as const],
    ["authentication-required", "authentication-required", { httpStatus: 401, headers: { "www-authenticate": "Basic" } } as const],
    ["access-blocked", "access-blocked", { httpStatus: 403, body: "<h1>Forbidden</h1>" } as const],
    ["login-required", "login-required", { finalUrl: "https://qa.test/login", body: "<form><input type=password></form>" } as const],
    ["unknown", "unknown", { httpStatus: 0, body: "unexpected" } as const],
  ] as const) {
    const access = detectAccess(input(detectOverrides));
    const report = baseScanReport(access);
    const analysis = await analyzeScan(report, { coverage: true });
    assert.equal(analysis.findings.length, 0, `${label}: no findings`);
    assert.equal(analysis.summary.issueCount, 0, `${label}: no occurrences`);
    assert.equal(analysis.summary.bySeverity.CRITICAL, 0, `${label}: no CRITICAL`);
    assert.equal(analysis.summary.bySeverity.HIGH, 0, `${label}: no HIGH`);
    assert.equal(analysis.summary.bySeverity.MEDIUM, 0, `${label}: no MEDIUM`);
    assert.equal(analysis.summary.bySeverity.LOW, 0, `${label}: no LOW`);
    assert.equal(analysis.summary.bySeverity.INFO, 0, `${label}: no INFO`);
    assert.equal(analysis.summary.verified, 0, `${label}: no verified`);
    assert.equal(analysis.summary.reproduced, 0, `${label}: no reproduced`);
    assert.ok(analysis.summary.overallStatus === "REVIEW" || analysis.summary.overallStatus === "BLOCKED", `${label}: status is REVIEW or BLOCKED, got ${analysis.summary.overallStatus}`);
  }
});

test("HTML report renders an Access Prerequisite section when present and omits it when absent", async () => {
  const access = detectAccess(input({ httpStatus: 403, body: "<title>Cloudflare challenge</title>" }));
  const report = baseScanReport(access);
  const analysis = await analyzeScan(report, {});
  const html = renderQaHtml(analysis);
  assert.ok(html.includes("Access Prerequisite"), "access prerequisite section appears in HTML");
  assert.ok(html.includes("bot-protection"), "access type is rendered");
  assert.ok(html.includes("REVIEW_REQUIRED"), "access status is rendered");
  assert.ok(html.includes("Website findings: 0"), "findings count is 0 for blocked sites");

  const accessibleAnalysis = await analyzeScan(accessibleReport(), {});
  const accessibleHtml = renderQaHtml(accessibleAnalysis);
  assert.ok(!accessibleHtml.includes("Access Prerequisite"), "no access prerequisite section for accessible sites");
});

test("accessible page with actual successful testing and no findings → PASS", async () => {
  const report = accessibleReport();
  const analysis = await analyzeScan(report, {});
  assert.equal(analysis.findings.length, 0);
  // Five Playwright tests really ran and all passed. Zero findings is only a
  // PASS when testing actually happened.
  const passingExecution: QaExecution = { status: "passed", command: "node cli.js", startedAt: new Date().toISOString(), durationMs: 100, tests: 5, passed: 5, failed: 0, skipped: 0, flaky: 0, reproduced: 0, notReproduced: 0, review: 0, infrastructureFailures: 0, failures: [] };
  const applied = applyVerification(analysis, { tasks: [], skipped: [], results: [], execution: passingExecution });
  assert.equal(applied.execution?.tests, 5, "the run really executed five tests");
  assert.equal(applied.summary.overallStatus, "PASS", "actual testing with no qualifying findings → PASS");
  assert.equal(recomputeOverallStatus(applied), "PASS", "the CLI finalization agrees with the shipped summary");
});

test("an executed flow with no findings → PASS, and the report and CLI agree", async () => {
  // Regression: the status rule used to be implemented twice and the copies had
  // drifted. applyVerification ignored flow execution while
  // recomputeOverallStatus counted it, so the JSON report said NOT_TESTED while
  // the CLI printed PASS for the very same run.
  const report = accessibleReport();
  const analysis = await analyzeScan(report, {});
  const withExecutedFlow = {
    ...analysis,
    summary: {
      ...analysis.summary,
      flowSummary: { pages: 1, flows: 1, executable: 1, review: 0, highRisk: 0, blocked: 0, steps: 2, executed: 1, passed: 1, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
    },
  };
  const applied = applyVerification(withExecutedFlow, { tasks: [], skipped: [], results: [], execution: null });
  assert.equal(applied.summary.overallStatus, "PASS", "an executed flow is actual testing");
  assert.equal(recomputeOverallStatus(applied), applied.summary.overallStatus, "the shipped summary and the CLI finalization must not disagree");
});

test("the access-prerequisite issue code never becomes a website finding", async () => {
  // Even if some code path emits an `access-prerequisite` issue, it is an access
  // condition and must not inflate the finding/occurrence/severity counts.
  const report = accessibleReport({
    issues: [
      { status: "INFO", code: ACCESS_PREREQUISITE_CODE, message: "Access is protected by bot protection and requires human review.", count: 1, examples: [] },
      { status: "WARNING", code: "button-missing-name", message: "Button has no accessible name.", count: 1, examples: [] },
    ],
  });
  const analysis = await analyzeScan(report, {});
  assert.equal(analysis.findings.length, 1, "only the real website defect becomes a finding");
  assert.equal(analysis.findings[0].code, "button-missing-name");
  assert.ok(!analysis.findings.some(finding => finding.code === ACCESS_PREREQUISITE_CODE), "the access prerequisite is not a finding");
  assert.equal(analysis.summary.bySeverity.INFO, 0, "the prerequisite adds no INFO severity");
  assert.equal(analysis.summary.issueCount, 1, "only the real defect contributes an occurrence");
});

test("the scan-level report separates the access prerequisite from website findings", () => {
  const access = detectAccess(input({ httpStatus: 403, body: "<title>Cloudflare challenge</title> <div>Please verify you are human</div>" }));
  const report = baseScanReport(access);
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-scan-report-"));
  try {
    const { htmlPath } = writeReports(report, join(dir, "scan.json"));
    const html = readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("Access Prerequisite"), "the scan report has its own access prerequisite section");
    assert.ok(html.includes("bot-protection"), "the access type is rendered");
    assert.ok(html.includes("REVIEW_REQUIRED"), "the access status is rendered");
    assert.ok(html.includes("Website findings:</strong> 0"), "website findings are reported separately and are 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scan-level JSON summary reports the access prerequisite separately and never exits 0", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  try {
    const access = detectAccess(input({ httpStatus: 403, body: "<h1>Forbidden</h1>" }));
    printJsonSummary(baseScanReport(access));
  } finally {
    console.log = original;
  }
  const parsed = JSON.parse(lines[0]) as { accessPrerequisite: { type: string; status: string } | null; normalScanRun: boolean; exitCode: number; failures: number };
  assert.equal(parsed.accessPrerequisite?.type, "access-blocked");
  assert.equal(parsed.accessPrerequisite?.status, "BLOCKED");
  assert.equal(parsed.normalScanRun, false, "the summary says the normal scan did not run");
  assert.equal(parsed.exitCode, 2, "a run that performed no QA must not report a clean exit code");
  assert.equal(parsed.failures, 0, "the prerequisite is not counted as a failure");
});

test("an accessible scan summary still exits 0 and reports no prerequisite", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  try {
    printJsonSummary(accessibleReport());
  } finally {
    console.log = original;
  }
  const parsed = JSON.parse(lines[0]) as { accessPrerequisite: unknown; normalScanRun: boolean; exitCode: number };
  assert.equal(parsed.accessPrerequisite, null);
  assert.equal(parsed.normalScanRun, true);
  assert.equal(parsed.exitCode, 0);
});

// ---------------------------------------------------------------------------
// Stale-artifact regression tests: old results cannot contaminate a new run
// ---------------------------------------------------------------------------

const makeTask = (scenarioId: string, findingId: string): VerificationTask => ({
  scenarioId,
  findingId,
  strategy: "accessible-name" as const,
  code: "button-missing-name",
  title: "x",
  locator: "page.locator(\"#btn\")",
  elementIndex: 0,
  expectation: "x",
});

const staleResult = (scenarioId: string, findingId: string): VerificationResult => ({
  findingId,
  scenarioId,
  strategy: "accessible-name",
  locator: "page.locator(\"#btn\")",
  status: "REPRODUCED",
  category: "WEBSITE",
  executedAt: new Date().toISOString(),
  durationMs: 10,
  expectation: "x",
  evidence: { located: true, locator: "page.locator(\"#btn\")", tag: "button", role: "button", accessibleName: null, text: null, visible: true, enabled: true, href: null, url: "https://qa.test", id: "btn", attributes: null, count: 1, screenshotPath: null },
  error: null,
  triage: { verdict: "LIKELY_DEFECT", reason: "stale artifact", confidence: "high", provider: "deterministic" },
});

test("old execution artifact cannot contaminate a new run — stale results are filtered out", () => {
  const dir = join(process.cwd(), "reports", "verification-stale-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Write a stale result file for a scenario that is NOT in the current task set
  writeFileSync(join(dir, "SC-VER-999.json"), JSON.stringify(staleResult("SC-VER-999", "QA-F-999")));
  // Write a current result file for a scenario that IS in the current task set
  writeFileSync(join(dir, "SC-VER-001.json"), JSON.stringify(staleResult("SC-VER-001", "QA-F-001")));
  const tasks = [makeTask("SC-VER-001", "QA-F-001")];
  const results = loadVerificationResults(tasks, "reports/verification-stale-test");
  assert.equal(results.length, 1, "only the current task's result is loaded");
  assert.equal(results[0].scenarioId, "SC-VER-001", "stale SC-VER-999 is excluded");
  rmSync(dir, { recursive: true, force: true });
});

test("zero scheduled → zero reproduced; zero executed → zero reproduced", async () => {
  const report = accessibleReport();
  const analysis = await analyzeScan(report, {});
  assert.equal(analysis.summary.scheduled, 0);
  assert.equal(analysis.summary.reproduced, 0);
  assert.equal(analysis.summary.verified, 0);
  assert.equal(analysis.summary.overallStatus, "NOT_TESTED");
  const layer = buildVerificationTasks(analysis.findings, report as never);
  assert.equal(layer.tasks.length, 0);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [], execution: null });
  assert.equal(applied.summary.scheduled, 0);
  assert.equal(applied.summary.reproduced, 0);
  assert.equal(applied.summary.verified, 0);
});

test("scheduled but skipped → not reproduced; reproduction requires execution", async () => {
  const report = accessibleReport();
  const analysis = await analyzeScan(report, {});
  const layer = buildVerificationTasks(analysis.findings, report as never);
  const applied = applyVerification(analysis, {
    tasks: layer.tasks,
    skipped: layer.skipped,
    results: [],
    execution: null,
  });
  assert.equal(applied.summary.scheduled, 0, "zero tasks when no findings");
  assert.equal(applied.summary.reproduced, 0, "no reproduction without execution");
  assert.equal(applied.summary.pass, 0);
  assert.equal(applied.summary.review, 0);
});

test("scheduled and executed → reproduction is allowed and reflected", async () => {
  const flagged: DiscoveredElement = { tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: "submit-btn", testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: null, recommendedLocator: "page.locator(\"#submit-btn\")", locatorQuality: "medium" };
  const report: ScanReport = {
    scan: { url: "https://qa.test", finalUrl: "https://qa.test", title: "QA", timestamp: "2026-09-22T00:00:00.000Z", durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: 1, interactiveElements: 1, passes: 0, warnings: 1, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 1, groupedIssueCounts: { passes: 0, warnings: 1, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements: [flagged],
    issues: [{ status: "WARNING", code: "button-missing-name", message: "Button has no accessible name.", count: 1, examples: [], element: { tag: "button", role: "button", text: "Save", ariaLabel: null, id: "submit-btn", testId: null, type: null, name: null, placeholder: null, accessibleName: null, href: null, alt: null, visible: true, enabled: true, recommendedLocator: "page.locator(\"#submit-btn\")", locatorQuality: "medium" } }],
    links: [],
    consoleErrors: [],
    consoleDiagnostics: [],
    pageErrors: [],
  };
   const analysis = await analyzeScan(report, {});
   const layer = buildVerificationTasks(analysis.findings, report as never);
   assert.equal(layer.tasks.length, 1, "finding with a safe locator is scheduled");
  const results: VerificationResult[] = [
    makeResult({ findingId: analysis.findings[0].id, scenarioId: layer.tasks[0]!.scenarioId }),
  ];
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results, execution: null });
  assert.equal(applied.summary.scheduled, 1, "scheduled = the finding received a verification task (it keeps that count after execution)");
  assert.equal(applied.summary.executed, 1, "executed = the verification test actually ran and produced an outcome");
  assert.equal(applied.findings[0].verification?.disposition, "REPRODUCED", "an executed finding is no longer SCHEDULED — that disposition means 'task exists, not yet run'");
  assert.equal(applied.summary.reproduced, 1, "confirmed reproduction is reflected");
  assert.equal(applied.summary.verified, 1);
  const finalStatus = recomputeOverallStatus(applied);
  assert.equal(finalStatus, "REVIEW", "HIGH finding reproduced → REVIEW (not FAIL/PASS)");
});