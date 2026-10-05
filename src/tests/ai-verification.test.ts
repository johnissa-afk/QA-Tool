import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyVerification, analyzeScan, explainStatus, summarizeVerifications } from "../ai/index.js";
import { summarizeDispositions } from "../ai/lifecycle.js";
import { buildVerificationTasks } from "../executor/tasks.js";
import { renderQaHtml, writeQaReport } from "../ai/report.js";
import type { FailureCategory, QaExecution, TriageVerdict, VerificationResult, VerificationStatus } from "../ai/types.js";
import type { DiscoveredElement, Issue, ScanReport } from "../types.js";

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: "submit-btn", testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.locator(\"#submit-btn\")", locatorQuality: "medium", ...overrides,
});

const report = (elements: DiscoveredElement[], issues: Issue[]): ScanReport => ({
  scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
  summary: { totalElements: elements.length, interactiveElements: elements.length, passes: 0, warnings: issues.length, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: issues.length, groupedIssueCounts: { passes: 0, warnings: issues.length, failures: 0, infos: 0 } },
  page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: elements.length, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements,
  issues,
  links: [],
  consoleErrors: [],
  consoleDiagnostics: [],
  pageErrors: [],
});

// Mimics checks.ts: element-level issues always carry the scanner snapshot.
const elementIssue = (el: DiscoveredElement, code: string, message: string): Issue => ({
  status: "WARNING",
  code,
  message,
  count: 1,
  examples: [],
  element: el,
});

// ---------------------------------------------------------------------------
// Website-agnosticism regression: the full pipeline must work for an ARBITRARY
// non-NoorPlay website. No URL, element id, selector, flow, or assumption may
// be tied to NoorPlay; everything must be derived from the scanned facts.
// ---------------------------------------------------------------------------
test("the QA pipeline analyzes an arbitrary non-NoorPlay website fixture end-to-end", async () => {
  const genericSearch = element({
    tag: "input", role: "searchbox", type: "search", name: "q", text: "", placeholder: "Search products",
    accessibleName: null, id: "store-search", recommendedLocator: "page.getByPlaceholder(\"Search products\")", locatorQuality: "high",
  });
  const genericLink = element({
    tag: "a", role: "link", text: "Read more", accessibleName: "Read more", href: "https://shop.example.net/blog",
    id: "blog-link", recommendedLocator: "page.getByRole(\"link\", { name: \"Read more\" })", locatorQuality: "high",
  });
  const genericButton = element({
    tag: "button", role: "button", text: "Add to cart", accessibleName: "Add to cart",
    id: "cart-btn", recommendedLocator: "page.getByRole(\"button\", { name: \"Add to cart\" })", locatorQuality: "high",
  });
  const scan = report([genericSearch, genericLink, genericButton], [
    elementIssue(genericSearch, "input-missing-label", "Form control has no accessible label."),
  ]);
  const genericUrl = "https://shop.example.net/products";
  (scan.scan as { url: string; finalUrl: string; title: string }).url = genericUrl;
  (scan.scan as { url: string; finalUrl: string; title: string }).finalUrl = genericUrl;
  (scan.scan as { url: string; finalUrl: string; title: string }).title = "Generic Store";

  const { generateTestSuite } = await import("../test-generator.js");
  const analysis = await analyzeScan(scan, { suite: generateTestSuite(scan) });
  assert.equal(analysis.summary.sourceUrl, genericUrl);
  assert.ok(analysis.findings.length >= 1);
  const labelFinding = analysis.findings.find(finding => finding.code === "input-missing-label");
  assert.ok(labelFinding, "generic unlabeled search field surfaces as a finding");

  const layer = buildVerificationTasks(analysis.findings, scan);
  assert.ok(layer.tasks.some(task => task.locator === "page.getByPlaceholder(\"Search products\")"), "task locator comes from the scanned facts");

  const outcome: VerificationResult = result({
    findingId: labelFinding!.id,
    scenarioId: layer.tasks.find(task => task.findingId === labelFinding!.id)!.scenarioId,
    locator: "page.getByPlaceholder(\"Search products\")",
    status: "REPRODUCED",
    category: "WEBSITE",
    evidence: { ...result().evidence, locator: "page.getByPlaceholder(\"Search products\")", tag: "input", accessibleName: null, visible: true },
  });
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [outcome], execution: null });
  const verifiedFinding = applied.findings.find(finding => finding.id === labelFinding!.id);
  assert.equal(verifiedFinding?.lifecycle, "REPRODUCED");
  assert.equal(applied.summary.reproduced, 1);

  const html = renderQaHtml(applied);
  assert.ok(html.includes("shop.example.net"), "generic URL is honored by the report");
  for (const marker of ["noordev", "dotcomlb", "back_rel", "pin_code_password", "inputSearchTerm"]) {
    assert.ok(!html.includes(marker), `report must not contain the NoorPlay-only marker ${marker}`);
    assert.ok(!JSON.stringify(applied).includes(marker), `analysis JSON must not contain ${marker}`);
  }
});

const result = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  findingId: "QA-F-001",
  scenarioId: "SC-VER-001",
  strategy: "accessible-name",
  locator: "page.locator(\"#submit-btn\")",
  status: "REPRODUCED",
  category: "WEBSITE",
  executedAt: new Date().toISOString(),
  durationMs: 10,
  expectation: "The element must expose an accessible name.",
  evidence: { located: true, locator: "page.locator(\"#submit-btn\")", tag: "button", role: "button", accessibleName: null, text: "", visible: true, enabled: true, href: null, url: "https://qa.test/en", id: "submit-btn", attributes: null, count: 1, screenshotPath: null },
  error: null,
  triage: { verdict: "LIKELY_DEFECT", reason: "The live DOM matches the suspected problem.", confidence: "high", provider: "deterministic" },
  ...overrides,
});

test("applyVerification advances the finding lifecycle through terminal outcomes", async () => {
  const flagged = element({ accessibleName: null });
  const scan = report([flagged], [elementIssue(flagged, "button-missing-name", "Button has no accessible name.")]);
  const analysis = await analyzeScan(scan, {});
  assert.equal(analysis.findings.length, 1);
  assert.equal(analysis.findings[0].lifecycle, "ANALYZED");
  const layer = buildVerificationTasks(analysis.findings, scan);
  assert.equal(layer.tasks.length, 1);
  assert.equal(layer.skipped.length, 0);

  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result()], execution: null });
  assert.equal(applied.findings[0].lifecycle, "REPRODUCED");
  assert.equal(applied.findings[0].verification?.scenarioId, "SC-VER-001");
  assert.ok(applied.findings[0].relatedScenarioIds.includes("SC-VER-001"), "finding links to its verification scenario");
  assert.ok(applied.findings[0].relatedScenarioIds.some(id => id.startsWith("SC-ACC")), "a11y finding links to the accessibility intent gate");
  assert.equal(applied.summary.verified, 1);
  assert.equal(applied.summary.reproduced, 1);
  assert.equal(applied.summary.unverified, 0);
  assert.equal(applied.verifications.length, 1);
});

test("scenario findingIds are back-linked onto element scenarios", async () => {
  const flagged = element({ accessibleName: null });
  const scan = report([flagged], [elementIssue(flagged, "button-missing-name", "Button has no accessible name.")]);
  const { generateTestSuite } = await import("../test-generator.js");
  const analysis = await analyzeScan(scan, { suite: generateTestSuite(scan) });
  const layer = buildVerificationTasks(analysis.findings, scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result()], execution: null });
  const scenario = applied.elementScenarios.find(item => item.locator === "page.locator(\"#submit-btn\")");
  assert.ok(scenario, "element scenario exists for the flagged button");
  assert.ok(scenario.findingIds?.includes("QA-F-001"), "element scenario carries its confirming finding id");
});

test("a task without an outcome stays unverified rather than claiming REVIEW", async () => {
  const flagged = element({ accessibleName: null });
  const scan = report([flagged], [elementIssue(flagged, "button-missing-name", "Button has no accessible name.")]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [], execution: null });
  assert.equal(applied.findings[0].lifecycle, "TEST_GENERATED");
  assert.equal(applied.findings[0].verification?.disposition, "SCHEDULED", "a scheduled-but-unexecuted finding keeps an explicit disposition");
  assert.equal(applied.findings[0].verification?.status, null);
  assert.equal(applied.summary.verified, 0);
  assert.equal(applied.summary.scheduled, 1);
  assert.equal(applied.summary.unverified, 1);
});

test("verification summary splits reproduced / pass / not-reproduced / review / infra", async () => {
  const unnamedButton = element({ accessibleName: null, id: "a", recommendedLocator: "page.locator(\"#a\")" });
  const unnamedLink = element({ tag: "a", role: "link", text: "", accessibleName: null, id: "b", recommendedLocator: "page.locator(\"#b\")" });
  const scan = report([unnamedButton, unnamedLink], [
    elementIssue(unnamedButton, "button-missing-name", "Button has no accessible name."),
    elementIssue(unnamedLink, "a-missing-name", "Link has no accessible name."),
  ]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  assert.equal(layer.tasks.length, 2, "both element findings are scheduled");
  const results: VerificationResult[] = [
    result({ findingId: analysis.findings[0].id, status: "REPRODUCED", category: "WEBSITE", triage: { verdict: "LIKELY_DEFECT", reason: "x", confidence: "high", provider: "deterministic" } }),
    result({ findingId: analysis.findings[1].id, scenarioId: "SC-VER-002", status: "PASS", category: "EXPECTATION", evidence: { ...result().evidence, accessibleName: "Home" }, triage: { verdict: "NOT_REPRODUCED", reason: "clean", confidence: "high", provider: "deterministic" } }),
  ];
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results, execution: null });
  assert.equal(applied.summary.reproduced, 1);
  assert.equal(applied.summary.pass, 1);
  assert.equal(applied.summary.notReproduced, 0);
  assert.equal(applied.summary.review, 0);
  assert.equal(applied.summary.verified, 2);
});

test("unverified findings (unsupported codes) persist visibly, never deleted", async () => {
  const scan = report([], [
    { status: "WARNING", code: "missing-page-title", message: "The document has no page title." },
    { status: "WARNING", code: "empty-link", message: "Link has no href.", count: 2, examples: [] },
  ]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [], execution: null });
  assert.equal(applied.findings.length, 2, "no finding is removed");
  const titleFinding = applied.findings.find(finding => finding.code === "missing-page-title");
  assert.equal(titleFinding?.lifecycle, "TEST_GENERATED");
  assert.equal(applied.findings.filter(finding => finding.lifecycle === "TEST_GENERATED").length, 1, "scheduled but not yet executed");
  assert.equal(applied.summary.verified, 0, "verified means an outcome was produced");
  assert.equal(applied.summary.unverified, 2, "both findings remain visible and unverified");
});

test("analyzeScan exposes an empty verification surface before any run", async () => {
  const scan = report([element({ accessibleName: null })], [{ status: "WARNING", code: "button-missing-name", message: "Button has no accessible name.", count: 1, examples: [] }]);
  const analysis = await analyzeScan(scan, {});
  assert.ok(Array.isArray(analysis.verifications));
  assert.equal(analysis.verifications.length, 0);
  assert.equal(analysis.summary.verified, 0);
  assert.equal(analysis.summary.unverified, 1);
});

test("applyVerification attaches the runner execution summary", async () => {
  const scan = report([element({ accessibleName: null })], [{ status: "WARNING", code: "button-missing-name", message: "Button has no accessible name.", count: 1, examples: [] }]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  const execution: QaExecution = { status: "passed", command: "node cli.js test ...", startedAt: new Date().toISOString(), durationMs: 100, tests: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, reproduced: 1, notReproduced: 0, review: 0, infrastructureFailures: 0, failures: [] };
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result()], execution });
  assert.equal(applied.execution?.status, "passed");
  assert.equal(applied.execution?.reproduced, 1);
});

test("HTML report renders Finding Status and Verification Results with cards", async () => {
  const scan = report([element({ accessibleName: null })], [{ status: "WARNING", code: "button-missing-name", message: "Button has no accessible name.", count: 1, examples: [] }]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result()], execution: null });
  const html = renderQaHtml(applied);
  assert.ok(html.includes("Finding Status"));
  assert.ok(html.includes("Verification Results"));
  assert.ok(html.includes("LIKELY_DEFECT"));
  assert.ok(html.includes("REPRODUCED"));
  assert.ok(html.includes("Verified"));
});

test("summarizeVerifications rolls verdicts up deterministically", async () => {
  const summary = summarizeVerifications([
    result(),
    result({ status: "PASS", category: "EXPECTATION", triage: { verdict: "NOT_REPRODUCED", reason: "x", confidence: "high", provider: "deterministic" } }),
    result({ status: "REVIEW", category: "INFRASTRUCTURE", error: { type: "NETWORK", message: "econn" }, triage: { verdict: "INFRASTRUCTURE_PROBLEM", reason: "x", confidence: "high", provider: "deterministic" } }),
    result({ status: "NOT_REPRODUCED", category: "LOCATOR", triage: { verdict: "NOT_REPRODUCED", reason: "x", confidence: "medium", provider: "deterministic" } }),
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.byVerdict.LIKELY_DEFECT, 1);
  assert.equal(summary.byVerdict.NOT_REPRODUCED, 2);
  assert.equal(summary.byVerdict.INFRASTRUCTURE_PROBLEM, 1);
  assert.equal(summary.byCategory.WEBSITE, 1);
  assert.equal(summary.byCategory.INFRASTRUCTURE, 1);
});

// ---------------------------------------------------------------------------
// PHASE 2 VERIFICATION HARDENING — fixture-based dispositions (generic, no
// NoorPlay references). Every finding must keep an explicit disposition.
// ---------------------------------------------------------------------------
type Matrix = { name: string; status: VerificationStatus; category: FailureCategory | null; disposition: string; verdict: TriageVerdict; summaryKey: "reproduced" | "notReproduced" | "infrastructureProblems" };

test("A+B+E+F: reproduced, absent, conditional, and infrastructure outcomes map to explicit dispositions", async () => {
  const matrix: Matrix[] = [
    { name: "reproduced", status: "REPRODUCED", category: "WEBSITE", disposition: "REPRODUCED", verdict: "LIKELY_DEFECT", summaryKey: "reproduced" },
    { name: "absent", status: "NOT_REPRODUCED", category: "LOCATOR", disposition: "NOT_REPRODUCED", verdict: "NOT_REPRODUCED", summaryKey: "notReproduced" },
    { name: "conditional", status: "NOT_REPRODUCED", category: "CONDITIONAL", disposition: "NOT_REPRODUCED", verdict: "CONDITIONAL", summaryKey: "notReproduced" },
    { name: "infrastructure", status: "REVIEW", category: "INFRASTRUCTURE", disposition: "INFRASTRUCTURE_PROBLEM", verdict: "INFRASTRUCTURE_PROBLEM", summaryKey: "infrastructureProblems" },
  ];
  for (const scenario of matrix) {
    const flagged = element({ accessibleName: null, id: "save-btn" });
    const scan = report([flagged], [elementIssue(flagged, "button-missing-name", "Button has no accessible name.")]);
    const analysis = await analyzeScan(scan, {});
    const layer = buildVerificationTasks(analysis.findings, scan);
    assert.equal(layer.tasks.length, 1, `${scenario.name}: the generic finding is scheduled`);
    const applied = applyVerification(analysis, {
      tasks: layer.tasks,
      skipped: layer.skipped,
      results: [result({
        findingId: analysis.findings[0].id,
        status: scenario.status,
        category: scenario.category,
        error: scenario.category === "INFRASTRUCTURE" ? { type: "NETWORK", message: "econn" } : null,
        triage: { verdict: scenario.verdict, reason: "deterministic probe verdict", confidence: "high", provider: "deterministic" },
      })],
      execution: null,
    });
    const pointer = applied.findings[0].verification;
    assert.equal(pointer?.disposition, scenario.disposition, `${scenario.name}: disposition`);
    assert.equal(pointer?.verdict, scenario.verdict, `${scenario.name}: verdict`);
    assert.ok(pointer?.reason, `${scenario.name}: reason is recorded`);
    assert.ok(pointer?.executedAt, `${scenario.name}: timestamp is recorded`);
    assert.equal(pointer?.safety, "safe", `${scenario.name}: safety classification`);
    assert.equal(applied.summary[scenario.summaryKey], 1, `${scenario.name}: summary count from the model`);
  }
});

test("C: unsupported finding codes stay visible as SKIPPED_UNSUPPORTED", async () => {
  const scan = report([], [{ status: "INFO", code: "fragile-locator", message: "A stable locator could not be inferred.", count: 3, examples: [] }]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  assert.equal(layer.tasks.length, 0);
  assert.equal(layer.skipped.length, 1);
  assert.equal(layer.skipped[0].disposition, "SKIPPED_UNSUPPORTED");
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [], execution: null });
  assert.equal(applied.findings.length, 1, "the finding is never deleted");
  assert.equal(applied.findings[0].verification?.disposition, "SKIPPED_UNSUPPORTED");
  assert.ok(applied.findings[0].verification?.reason.includes("fragile-locator"), "the skip reason names the code");
  assert.equal(applied.summary.skippedUnsupported, 1);
  assert.equal(applied.summary.unverified, 1);
});

test("D: findings with no safe/unique locator stay visible as SKIPPED_LOCATOR_GUARD", async () => {
  const scan = report([], [{ status: "WARNING", code: "a-missing-name", message: "Link has no accessible name.", count: 3, examples: [] }]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  assert.equal(layer.tasks.length, 0);
  assert.equal(layer.skipped[0]?.disposition, "SKIPPED_LOCATOR_GUARD");
  assert.ok(layer.skipped[0]?.reason.length > 40, "guarded findings keep a human-readable reason");
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [], execution: null });
  assert.equal(applied.findings.length, 1, "the ambiguous-locator finding is never deleted");
  assert.equal(applied.findings[0].verification?.disposition, "SKIPPED_LOCATOR_GUARD");
  assert.equal(applied.summary.skippedLocatorGuard, 1);
});

test("G: multiple occurrences group into ONE finding and ONE verification task", async () => {
  const flagged = element({ accessibleName: null, id: "save-btn" });
  const scan = report([flagged], [{ status: "WARNING", code: "button-missing-name", message: "Buttons have no accessible name.", count: 8, occurrences: 8, element: flagged }]);
  const analysis = await analyzeScan(scan, {});
  assert.equal(analysis.findings.length, 1);
  assert.equal(analysis.findings[0].count, 8, "the grouped occurrence count survives");
  const layer = buildVerificationTasks(analysis.findings, scan);
  assert.equal(layer.tasks.length, 1, "one group produces one task");
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result({ findingId: analysis.findings[0].id })], execution: null });
  assert.equal(applied.findings[0].verification?.disposition, "REPRODUCED");
  assert.equal(applied.summary.reproduced, 1);
});

test("the HTML report shows a Verification Disposition table with reasons", async () => {
  const flagged = element({ accessibleName: null, id: "save-btn" });
  const scan = report([flagged], [elementIssue(flagged, "button-missing-name", "Button has no accessible name.")]);
  const analysis = await analyzeScan(scan, {});
  const layer = buildVerificationTasks(analysis.findings, scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result({ findingId: analysis.findings[0].id, category: "WEBSITE" })], execution: null });
  const html = renderQaHtml(applied);
  assert.ok(html.includes("Verification Disposition"));
  assert.ok(html.includes("REPRODUCED"), "disposition badge renders");
  assert.ok(html.includes("The live DOM matches"), "triage reason renders");
  assert.ok(html.includes("Disposition counts:"), "disposition summary renders");
});

// ---------------------------------------------------------------------------
// VERIFICATION STATUS REPORTING — one authoritative distinction between
// discovered / scheduled / executed / reproduced / not-reproduced findings,
// with general Playwright flow + scenario execution kept separate. The final
// status explanation must always describe what actually executed.
// ---------------------------------------------------------------------------

const quietExecution = (overrides: Partial<QaExecution> = {}): QaExecution => ({ status: "passed", command: "node cli.js", startedAt: new Date().toISOString(), durationMs: 100, tests: 1, passed: 1, failed: 0, skipped: 0, flaky: 0, reproduced: 0, notReproduced: 1, review: 0, infrastructureFailures: 0, failures: [], ...overrides });

/** Builds an analyzed fixture run with exactly one finding, forced to MEDIUM
 *  severity so the status rule lands on the PASS branch (no CRITICAL/HIGH). */
async function mediumFindingRun(): Promise<ReturnType<typeof analyzeScan>> {
  const flagged = element({ accessibleName: null, id: "save-btn" });
  const scan = report([flagged], [elementIssue(flagged, "button-missing-name", "Button has no accessible name.")]);
  const analysis = await analyzeScan(scan, {});
  return { ...analysis, findings: analysis.findings.map(finding => ({ ...finding, severity: "MEDIUM" as const })) };
}

test("run 1: finding scheduled + verification executed + not reproduced — consistent counts and honest headline", async () => {
  const analysis = await mediumFindingRun();
  assert.equal(analysis.findings.length, 1);
  const layer = buildVerificationTasks(analysis.findings, analysis.scan);
  assert.equal(layer.tasks.length, 1, "one finding scheduled for verification");
  const notReproduced: VerificationResult = result({ findingId: analysis.findings[0].id, status: "NOT_REPRODUCED", category: "LOCATOR", evidence: { ...result().evidence, located: false, accessibleName: null }, triage: { verdict: "NOT_REPRODUCED", reason: "Element no longer present.", confidence: "high", provider: "deterministic" } });
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [notReproduced], execution: quietExecution() });

  assert.equal(applied.summary.scheduled, 1, "the finding was scheduled for verification");
  assert.equal(applied.summary.executed, 1, "one verification test actually executed");
  assert.equal(applied.summary.reproduced, 0);
  assert.equal(applied.summary.notReproduced, 1);
  assert.equal(applied.summary.verified, 1, "verified = reproduced + not reproduced + passed");
  assert.equal(applied.summary.overallStatus, "PASS");

  assert.ok(!applied.summary.headline.includes("no verification run performed"), "verification DID execute — the stale phrase MUST NOT appear");
  assert.ok(applied.summary.headline.includes("verification completed"), "the headline describes the executed verification");
  assert.ok(applied.summary.headline.includes("1 finding(s) verified, 0 reproduced, 1 not reproduced"), `headline uses the actual numbers: ${applied.summary.headline}`);
});

test("run 2: finding scheduled + verification executed + reproduced — headline reflects reproduction", async () => {
  const analysis = await mediumFindingRun();
  const layer = buildVerificationTasks(analysis.findings, analysis.scan);
  const reproduced: VerificationResult = result({ findingId: analysis.findings[0].id, status: "REPRODUCED", category: "WEBSITE", triage: { verdict: "LIKELY_DEFECT", reason: "Live DOM matches the suspected problem.", confidence: "high", provider: "deterministic" } });
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [reproduced], execution: quietExecution({ reproduced: 1, notReproduced: 0 }) });

  assert.equal(applied.summary.scheduled, 1);
  assert.equal(applied.summary.executed, 1);
  assert.equal(applied.summary.reproduced, 1);
  assert.equal(applied.summary.notReproduced, 0);
  assert.ok(!applied.summary.headline.includes("no verification run performed"));
  assert.ok(applied.summary.headline.includes("verification completed; 1 finding(s) verified, 1 reproduced, 0 not reproduced"), `headline: ${applied.summary.headline}`);
});

test("run 3: finding scheduled but verification skipped — executed is 0 and nothing claims otherwise", async () => {
  const analysis = await mediumFindingRun();
  const layer = buildVerificationTasks(analysis.findings, analysis.scan);
  const skippedExecution: QaExecution = { status: "skipped", command: "node cli.js", startedAt: new Date().toISOString(), durationMs: 0, tests: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, reproduced: 0, notReproduced: 0, review: 0, infrastructureFailures: 0, failures: [] };
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [], execution: skippedExecution });

  assert.equal(applied.summary.scheduled, 1, "still scheduled");
  assert.equal(applied.summary.executed, 0, "no verification test ran");
  assert.equal(applied.summary.verified, 0);
  assert.equal(applied.summary.overallStatus, "NOT_TESTED", "nothing executed → NOT_TESTED, never PASS");
  assert.ok(applied.summary.headline.includes("no verification run performed"), "accurate here: the run never executed a verification test");
  assert.ok(!applied.summary.headline.includes("verification completed"), "must not claim verification execution");
});

test("run 4: zero findings + flow execution — flow counts are never reported as finding verification", async () => {
  const analysis = await mediumFindingRun();
  const noFindings = {
    ...analysis,
    findings: [],
    summary: { ...analysis.summary, ...summarizeDispositions([]), flowSummary: { flows: 20, executable: 20, review: 0, highRisk: 0, blocked: 0, pages: 1, steps: 20, executed: 20, passed: 1, reproduced: 0, notReproduced: 0, reviewRequired: 12, infrastructure: 6, blockedSteps: [] } as never },
  };
  const explained = explainStatus(noFindings);
  assert.equal(noFindings.summary.executed, 0, "flow execution must never populate the verification executed counter");
  assert.equal(noFindings.summary.scheduled, 0, "no findings → nothing scheduled");
  assert.equal(explained.overallStatus, "PASS", "flow execution IS actual testing");
  assert.ok(explained.headline.includes("20 flow(s) executed"), `flows appear as flow execution, not verification: ${explained.headline}`);
  assert.ok(!explained.headline.includes("verification completed"), "flow execution is not finding verification");
});

test("run 5: review/high-risk flows only — no verification execution is claimed", async () => {
  const analysis = await mediumFindingRun();
  const reviewOnly = {
    ...analysis,
    summary: { ...analysis.summary, ...summarizeDispositions([]), flowSummary: { flows: 20, executable: 0, review: 12, highRisk: 8, blocked: 1, pages: 1, steps: 20, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 12, infrastructure: 0, blockedSteps: [] } as never },
  };
  const explained = explainStatus(reviewOnly);
  assert.equal(reviewOnly.summary.executed, 0, "review-flow counts are NOT verification execution");
  assert.equal(explained.overallStatus, "NOT_TESTED", "nothing actually executed");
  assert.ok(explained.headline.includes("no verification run performed"), "accurately reports that nothing ran");
  assert.ok(!explained.headline.includes("verification completed"));
});

test("run 6: the JSON report ships the same verification numbers the CLI reads", async () => {
  const analysis = await mediumFindingRun();
  const layer = buildVerificationTasks(analysis.findings, analysis.scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result({ findingId: analysis.findings[0].id, status: "NOT_REPRODUCED", category: "LOCATOR" })], execution: quietExecution() });
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-verification-json-"));
  try {
    const { jsonPath } = writeQaReport(applied, join(dir, "qa-analysis.json"));
    const loaded = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(loaded.summary.scheduled, applied.summary.scheduled);
    assert.equal(loaded.summary.executed, applied.summary.executed);
    assert.equal(loaded.summary.verified, applied.summary.verified);
    assert.equal(loaded.summary.reproduced, applied.summary.reproduced);
    assert.equal(loaded.summary.notReproduced, applied.summary.notReproduced);
    assert.equal(loaded.summary.overallStatus, applied.summary.overallStatus);
    assert.equal(loaded.summary.headline, applied.summary.headline);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run 7: the HTML report uses the same verification numbers", async () => {
  const analysis = await mediumFindingRun();
  const layer = buildVerificationTasks(analysis.findings, analysis.scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result({ findingId: analysis.findings[0].id, status: "NOT_REPRODUCED", category: "LOCATOR" })], execution: quietExecution() });
  const html = renderQaHtml(applied);
  assert.ok(html.includes(`<strong>${applied.summary.scheduled}</strong>Scheduled`), "Scheduled card shows the CLI number");
  assert.ok(html.includes(`<strong>${applied.summary.executed}</strong>Executed`), "Executed card shows the CLI number");
  assert.ok(html.includes(`<strong>${applied.summary.verified}</strong>Verified`), "Verified card matches the QA RESULT meaning");
  assert.ok(html.includes(`Disposition counts: ${applied.summary.scheduled} scheduled, ${applied.summary.executed} executed`), "disposition line matches the CLI");
  assert.ok(html.includes(applyEscape(applied.summary.headline)), "the headline rendered is the honest explanation");
});

test("run 8: Verified in the QA RESULT block has the same meaning as the summary counter", async () => {
  const analysis = await mediumFindingRun();
  const layer = buildVerificationTasks(analysis.findings, analysis.scan);
  const applied = applyVerification(analysis, { tasks: layer.tasks, skipped: layer.skipped, results: [result({ findingId: analysis.findings[0].id, status: "NOT_REPRODUCED", category: "LOCATOR" })], execution: quietExecution() });
  const { qaResultInputOf } = await import("../qa/result.js");
  const input = qaResultInputOf(applied, { url: analysis.scan.scan.url, runId: null, jsonPath: "reports/qa-analysis.json", htmlPath: "reports/qa-analysis.html", historyPath: "reports/history" });
  assert.equal(input.verified, applied.summary.verified, "QA RESULT Verified === summary.verified");
  assert.equal(input.reproduced, applied.summary.reproduced);
  assert.equal(applied.summary.verified, applied.summary.reproduced + applied.summary.notReproduced + applied.summary.pass, "the verified definition is reproduced + not reproduced + passed everywhere");
});

function applyEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}