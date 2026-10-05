import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Page } from "@playwright/test";
import type { QaFinding } from "../ai/types.js";
import type { Probe } from "../executor/verify.js";
import { buildRedactor, redactObject } from "../executor/redact.js";
import { buildVerificationTasks, isSafeLocator, uniqueReferenceLocator } from "../executor/tasks.js";
import { classifyError, locatorFromExpr, runVerification, triageOutcome } from "../executor/verify.js";
import { loadVerificationResults } from "../executor/parse.js";
import { summarizePlaywrightJson } from "../executor/runner.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const finding = (overrides: Partial<QaFinding> = {}): QaFinding => ({
  id: "QA-F-001",
  code: "button-missing-name",
  status: "WARNING",
  lifecycle: "ANALYZED",
  relatedScenarioIds: [],
  verification: null,
  domain: "accessibility",
  severity: "HIGH",
  confidence: "high",
  title: "Button without an accessible name",
  description: "x",
  recommendation: "r",
  userImpact: "u",
  rationale: "r",
  count: 1,
  evidence: [{ type: "element", index: 0, locator: "page.locator(\"#submit-btn\")", tag: "button" }],
  examples: [],
  ...overrides,
});

const baseReport = (overrides: Partial<Record<string, unknown>> = {}) => ({
  scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
  summary: { totalElements: 1, interactiveElements: 1, passes: 0, warnings: 1, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 1, groupedIssueCounts: { passes: 0, warnings: 1, failures: 0, infos: 0 } },
  page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements: [{ tag: "button", role: "button", text: "", ariaLabel: null, placeholder: null, name: null, id: "submit-btn", testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: null, recommendedLocator: "page.locator(\"#submit-btn\")", locatorQuality: "medium" }],
  issues: [{ status: "WARNING", code: "button-missing-name", message: "Button has no accessible name.", count: 1, examples: [] }],
  links: [],
  consoleErrors: [],
  consoleDiagnostics: [],
  pageErrors: [],
  ...overrides,
});

const fakeLocator = (probe: Probe | null) => ({
  count: async () => (probe ? probe.count : 0),
  first: () => ({ evaluate: async (): Promise<Probe> => ({ ...probe!, count: 0 }) }),
});

const locatorMethods = (probe: Probe | null) => ({
  getByRole: () => fakeLocator(probe),
  getByLabel: () => fakeLocator(probe),
  getByPlaceholder: () => fakeLocator(probe),
  getByText: () => fakeLocator(probe),
  getByTestId: () => fakeLocator(probe),
  locator: () => fakeLocator(probe),
});

const fakePage = (overrides: Partial<{ url: string; title: string; evaluateResult: unknown; probe: Probe | null; screenshot: Buffer }> = {}): Page => {
  return {
    goto: async () => undefined,
    url: () => overrides.url ?? "https://qa.test/en",
    title: async () => overrides.title ?? "QA target",
    evaluate: async () => overrides.evaluateResult ?? null,
    screenshot: async () => overrides.screenshot ?? Buffer.from("png"),
    ...locatorMethods(overrides.probe ?? null),
    locator: () => fakeLocator(overrides.probe ?? null),
  } as unknown as Page;
};

const probe = (overrides: Partial<Probe> = {}): Probe => ({
  count: 1,
  tag: "button",
  role: "button",
  accessibleName: "Save",
  text: "Save",
  href: null,
  id: null,
  visible: true,
  enabled: true,
  alt: null,
  attributes: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// Scheduling + guards
// ---------------------------------------------------------------------------
test("buildVerificationTasks schedules safe checks for supported codes", () => {
  const report = baseReport() as never;
  const { tasks, skipped } = buildVerificationTasks([finding()], report as never);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].strategy, "accessible-name");
  assert.equal(tasks[0].scenarioId, "SC-VER-001");
  assert.equal(skipped.length, 0);
});

test("unsupported finding codes never become tests", () => {
  const report = baseReport() as never;
  const { tasks, skipped } = buildVerificationTasks([finding({ code: "page-http-error", domain: "navigation" })], report as never);
  assert.equal(tasks.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].cause, "unsupported");
  assert.equal(skipped[0].disposition, "SKIPPED_UNSUPPORTED");
  assert.ok(skipped[0].reason.includes("page-http-error"), "human-readable skip reason is recorded");
});

test("fragile and suspicious locators are guarded, not executed", () => {
  const report = baseReport() as never;
  const placeholder = finding({ id: "QA-F-002", evidence: [{ type: "element", index: null, locator: "page.getByRole(\"button\", { name: \"?\" })", tag: "button" }] });
  const { tasks } = buildVerificationTasks([placeholder], report as never);
  assert.equal(tasks.length, 0);
  assert.ok(!isSafeLocator("page.getByRole(\"button\", { name: \"?\" })"));
  assert.ok(!isSafeLocator("page.click(\"#x\")"));
  assert.ok(!isSafeLocator(null));
  assert.ok(isSafeLocator("page.locator(\"#submit-btn\")"));
  assert.ok(isSafeLocator("page.getByTestId(\"save\")"));
});

test("page-level strategies require no locator and pass the guard for valid DOM checks", () => {
  assert.ok(isSafeLocator("page.locator(\"img[alt=logo]\")"));
  const report = baseReport() as never;
  const titleFinding = finding({ id: "QA-F-003", code: "missing-page-title" });
  const langFinding = finding({ id: "QA-F-004", code: "missing-lang" });
  const viewportFinding = finding({ id: "QA-F-005", code: "missing-viewport" });
  const { tasks } = buildVerificationTasks([titleFinding, langFinding, viewportFinding], report as never);
  assert.equal(tasks.length, 3);
  for (const task of tasks) assert.equal(task.locator, null, "page-level tasks carry no locator");
});

// ---------------------------------------------------------------------------
// Locator expression parsing
// ---------------------------------------------------------------------------
test("locatorFromExpr parses every emitted locator shape", async () => {
  const page = fakePage();
  const expressions = [
    "page.getByRole(\"button\", { name: \"Save\" })",
    "page.getByLabel(\"Email\")",
    "page.getByPlaceholder(\"Search\")",
    "page.getByText(\"Home\", { exact: true })",
    "page.getByText(\"Show (2)\", { exact: true })",
    "page.getByTestId(\"nav-home\")",
    "page.locator(\"input[type=\\\"text\\\"]\")",
  ];
  for (const expression of expressions) {
    const locator = locatorFromExpr(page, expression);
    const count = await locator.count();
    assert.ok(count >= 0, `parse failed for ${expression}`);
  }
});

test("locatorFromExpr rejects unsupported expressions loudly", () => {
  assert.throws(() => locatorFromExpr(fakePage(), "page.$(\"#x\")"));
  assert.throws(() => locatorFromExpr(fakePage(), "page.locator(\"#a\"; )"));
});

// ---------------------------------------------------------------------------
// Strategy verdicts
// ---------------------------------------------------------------------------
test("accessible-name strategy passes when a live name now exists", async () => {
  const page = fakePage({ probe: probe({ accessibleName: "Save" }) });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(result.status, "PASS");
  assert.equal(result.category, "EXPECTATION");
});

test("missing accessible name on a visible element reproduces as WEBSITE", async () => {
  const page = fakePage({ probe: probe({ accessibleName: null }) });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(result.status, "REPRODUCED");
  assert.equal(result.category, "WEBSITE");
});

test("hidden missing-name instance is CONDITIONAL, never a confirmed defect", async () => {
  const page = fakePage({ probe: probe({ accessibleName: null, visible: false }) });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(result.status, "NOT_REPRODUCED");
  assert.equal(result.category, "CONDITIONAL");
});

test("image-alt: alt text or decorative role passes; null alt reproduces", async () => {
  const base = { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "image-alt" as const, code: "image-missing-alt", title: "x", locator: "page.locator(\"#logo\")", elementIndex: 0, expectation: "x" };
  const withAlt = await runVerification(fakePage({ probe: probe({ tag: "img", alt: "Logo", role: "img" }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(withAlt.status, "PASS");
  const decorative = await runVerification(fakePage({ probe: probe({ tag: "img", alt: "", role: "presentation" }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(decorative.status, "PASS");
  const missing = await runVerification(fakePage({ probe: probe({ tag: "img", alt: null, role: "img" }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(missing.status, "REPRODUCED");
  assert.equal(missing.category, "WEBSITE");
});

test("duplicate-id reproduces while ids collide and passes once unique", async () => {
  const base = { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "duplicate-id" as const, code: "duplicate-id", title: "x", locator: "page.locator(\"#dup\")", elementIndex: 0, expectation: "x" };
  const collision = await runVerification(fakePage({ probe: probe({ count: 3, id: "dup" }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(collision.status, "REPRODUCED");
  const unique = await runVerification(fakePage({ probe: probe({ count: 1, id: "dup" }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(unique.status, "PASS");
});

test("empty-link follows resolved href semantics", async () => {
  const base = { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "empty-link" as const, code: "empty-link", title: "x", locator: "page.locator(\"#menu\")", elementIndex: 0, expectation: "x" };
  const withHref = await runVerification(fakePage({ probe: probe({ tag: "a", role: "link", href: "https://qa.test/en#" }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(withHref.status, "PASS");
  const missing = await runVerification(fakePage({ probe: probe({ tag: "a", role: "link", href: null }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(missing.status, "REPRODUCED");
});

test("input-type strategy checks the explicit type attribute", async () => {
  const base = { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "input-type" as const, code: "input-missing-type", title: "x", locator: "page.locator(\"#q\")", elementIndex: 0, expectation: "x" };
  const declared = await runVerification(fakePage({ probe: probe({ tag: "input", role: "textbox", attributes: { type: "search" } }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(declared.status, "PASS");
  const implicit = await runVerification(fakePage({ probe: probe({ tag: "input", role: "textbox", attributes: {} }) }), base, { targetUrl: "https://qa.test/en" });
  assert.equal(implicit.status, "REPRODUCED");
});

test("absent element is NOT_REPRODUCED/LOCATOR, not a defect", async () => {
  const page = fakePage({ probe: null });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(result.status, "NOT_REPRODUCED");
  assert.equal(result.category, "LOCATOR");
});

// ---------------------------------------------------------------------------
// Error classification + triage
// ---------------------------------------------------------------------------
test("classifyError maps auth, infrastructure, locator, and unknown failures", () => {
  const auth = classifyError(new Error("net::ERR_HTTP_RESPONSE_CODE_FAILURE 401"));
  assert.equal(auth.category, "AUTHENTICATION");
  const infra = classifyError(new Error("Timeout 30000ms exceeded. net::ERR_CONNECTION_REFUSED"));
  assert.equal(infra.category, "INFRASTRUCTURE");
  const locator = classifyError(new Error("waiting for locator('#x')... did not find"));
  assert.equal(locator.category, "LOCATOR");
  assert.equal(locator.status, "NOT_REPRODUCED");
  const unknown = classifyError(new Error("something else happened"));
  assert.equal(unknown.category, "REVIEW");
});

test("triageOutcome explains every verdict deterministically", () => {
  const reproduced = triageOutcome({ status: "REPRODUCED", category: "WEBSITE", strategy: "accessible-name", locator: "x", evidence: { located: true, visible: true } as never, error: null });
  assert.equal(reproduced.verdict, "LIKELY_DEFECT");
  assert.ok(reproduced.reason.includes("reproduces"));
  const infra = triageOutcome({ status: "REVIEW", category: "INFRASTRUCTURE", strategy: "accessible-name", locator: null, evidence: null as never, error: { type: "NETWORK", message: "econn" } });
  assert.equal(infra.verdict, "INFRASTRUCTURE_PROBLEM");
  const notFound = triageOutcome({ status: "NOT_REPRODUCED", category: "LOCATOR", strategy: "accessible-name", locator: null, evidence: null as never, error: null });
  assert.equal(notFound.verdict, "NOT_REPRODUCED");
  const pass = triageOutcome({ status: "PASS", category: "EXPECTATION", strategy: "accessible-name", locator: null, evidence: null as never, error: null });
  assert.equal(pass.verdict, "NOT_REPRODUCED");
});

// ---------------------------------------------------------------------------
// runVerification page-level + evidence hygiene
// ---------------------------------------------------------------------------
test("document-title strategy reproduces when the live title is empty", async () => {
  const blank = await runVerification(fakePage({ title: "  " }), { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "document-title", code: "missing-page-title", title: "x", locator: null, elementIndex: null, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(blank.status, "REPRODUCED");
  const present = await runVerification(fakePage({ title: "QA target" }), { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "document-title", code: "missing-page-title", title: "x", locator: null, elementIndex: null, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(present.status, "PASS");
});

test("language and viewport page-level strategies evaluate the live document", async () => {
  const withLang = await runVerification(fakePage({ evaluateResult: "en" }), { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "language", code: "missing-lang", title: "x", locator: null, elementIndex: null, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(withLang.status, "PASS");
  const withViewport = await runVerification(fakePage({ evaluateResult: "width=device-width" }), { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "viewport", code: "missing-viewport", title: "x", locator: null, elementIndex: null, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(withViewport.status, "PASS");
});

test("evidence never captures input values or query tokens", async () => {
  const page = fakePage({ probe: probe({ accessibleName: null, attributes: { value: "super-secret", name: "q", "data-token": "Bearer abc" } }) });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.ok(!JSON.stringify(result.evidence.attributes).includes("super-secret"));
  assert.ok(!JSON.stringify(result.evidence.attributes).includes("Bearer abc"));
});

test("redactObject scrubs secret values recursively", () => {
  const redact = buildRedactor({ QA_PASSWORD: "hunter2", QA_AUTHORIZATION: "Bearer tok123" } as NodeJS.ProcessEnv);
  const redacted = redactObject({ outer: { password: "password=hunter2", token: "Bearer tok123", keep: "visible" } }, redact);
  assert.ok(!JSON.stringify(redacted).includes("hunter2"));
  assert.ok(!JSON.stringify(redacted).includes("tok123"));
  assert.ok(JSON.stringify(redacted).includes("visible"));
});

test("REPRODUCED outcomes may capture a screenshot file path only", async () => {
  const dir = join(process.cwd(), "reports", "verification-test");
  rmSync(join(process.cwd(), "reports", "verification-test"), { recursive: true, force: true });
  const page = fakePage({ probe: probe({ accessibleName: null }) });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en", screenshotDir: "reports/verification-test" });
  assert.ok(result.evidence.screenshotPath);
  assert.ok(existsSync(result.evidence.screenshotPath), "screenshot must be written as a file path");
  assert.ok(!result.evidence.screenshotPath.includes("data:image"));
});

// ---------------------------------------------------------------------------
// Result collection + runner summary
// ---------------------------------------------------------------------------
test("loadVerificationResults aggregates outcome files and fabricates missing ones", () => {
  const dir = join(process.cwd(), "reports", "verification-test");
  const file = join(dir, "SC-VER-001.json");
  writeFileSync(file, JSON.stringify({ scenarioId: "SC-VER-001", findingId: "QA-F-001", status: "REPRODUCED", category: "WEBSITE", evidence: {}, triage: { verdict: "LIKELY_DEFECT" } }));
  const tasks = [{ scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { scenarioId: "SC-VER-002", findingId: "QA-F-002", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#other\")", elementIndex: 0, expectation: "x" }];
  const results = loadVerificationResults(tasks as never, "reports/verification-test");
  assert.equal(results.length, 2);
  const missing = results.find(result => result.scenarioId === "SC-VER-002");
  assert.equal(missing?.status, "REVIEW");
  assert.equal(missing?.error?.type, "OUTCOME_MISSING");
  rmSync(dir, { recursive: true, force: true });
});

test("summarizePlaywrightJson counts executions and keeps verification fields", () => {
  const raw = { stats: { expected: 10, unexpected: 2, flaky: 0, skipped: 3, startTime: "t", duration: 100 }, suites: [{ tests: [{ title: "t1", results: [{ status: "passed" }] }, { title: "t2", results: [{ status: "failed", error: { message: "boom" } }] }] }] };
  const summary = summarizePlaywrightJson(raw);
  assert.equal(summary.tests, 15);
  assert.equal(summary.passed, 10);
  assert.equal(summary.failed, 2);
  assert.equal(summary.reproduced, null);
  assert.equal(summary.failures[0].message, "boom");
});

test("verification results serialize without leaking runtime lease fields", async () => {
  const page = fakePage({ probe: probe({ accessibleName: null }) });
  const result = await runVerification(page, { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "accessible-name", code: "button-missing-name", title: "x", locator: "page.locator(\"#submit-btn\")", elementIndex: 0, expectation: "x" }, { targetUrl: "https://qa.test/en" });
  assert.equal(result.status, "REPRODUCED");
  assert.ok(result.triage && result.triage.verdict === "LIKELY_DEFECT");
});

// ---------------------------------------------------------------------------
// Phase 2: reference-backed locators (honest, generic — no site-specific names)
// ---------------------------------------------------------------------------
const anchor = (index: number, href: string | null, tag: string = "a", override: Record<string, unknown> = {}) => ({
  tag: tag as "a",
  role: tag === "img" ? "img" : "link",
  text: "",
  ariaLabel: null,
  placeholder: null,
  name: null,
  id: null,
  testId: null,
  type: null,
  hasExplicitType: true,
  autocomplete: null,
  href,
  alt: null,
  visible: true,
  enabled: true,
  boundingBox: null,
  interactive: true,
  accessibleName: null,
  recommendedLocator: `page.locator("${tag}")`,
  locatorQuality: "low" as const,
  ...override,
});

const anchorEvidence = (index: number) => [{ type: "element", index, locator: `page.locator("a")`, tag: "a" }] as QaFinding["evidence"];
const anchorExamples = (href: string) => [{ element: { tag: "a" as const, href, id: null, recommendedLocator: "page.locator(\"a\")", locatorQuality: "low" as const } }] as QaFinding["examples"];
const uniqueAnchorLocator = (anchorFinding: QaFinding, report: never) => uniqueReferenceLocator(anchorFinding, report);

test("uniqueReferenceLocator derives an unambiguous attribute locator, never a guess", () => {
  const report = baseReport({ elements: [anchor(0, "https://qa.test/collections"), anchor(1, "https://qa.test/collections"), anchor(2, "https://qa.test/terms")] }) as never;
  const unique = uniqueAnchorLocator;
  const uniqueCase = finding({ code: "a-missing-name", evidence: anchorEvidence(0), examples: anchorExamples("https://qa.test/terms") });
  const derived = unique(uniqueCase, report);
  assert.ok(derived, "a unique href must produce a reference locator");
  assert.equal(derived!.locator, "page.locator(\"a[href=\\\"https://qa.test/terms\\\"]\")");
  assert.equal(derived!.elementIndex, 2);
  const duplicate = finding({ code: "a-missing-name", evidence: anchorEvidence(0), examples: anchorExamples("https://qa.test/collections") });
  assert.equal(unique(duplicate, report), null, "a duplicated href must NOT be guessed");
  assert.equal(uniqueReferenceLocator(finding({ code: "a-missing-name", evidence: anchorEvidence(0), examples: [] }), report as never), null, "no evidence edge means no reference");
});

test("buildVerificationTasks schedules reference-backed anchors and guards ambiguous ones", () => {
  const report = baseReport({ elements: [anchor(0, "https://qa.test/collections"), anchor(1, "https://qa.test/collections"), anchor(2, "https://qa.test/terms")] }) as never;
  const { tasks, skipped } = buildVerificationTasks([
    finding({ id: "QA-F-001", code: "a-missing-name", evidence: anchorEvidence(0), examples: anchorExamples("https://qa.test/terms") }),
    finding({ id: "QA-F-002", code: "a-missing-name", evidence: anchorEvidence(0), examples: anchorExamples("https://qa.test/collections") }),
  ], report as never);
  assert.equal(tasks.length, 1, "only the unambiguous anchor becomes an executable task");
  assert.ok(tasks[0]?.locator?.includes("a[href="), "the scheduled task uses the derived href reference");
  assert.equal(tasks[0]?.elementIndex, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].findingId, "QA-F-002");
  assert.equal(skipped[0].disposition, "SKIPPED_LOCATOR_GUARD");
});

test("image-missing-alt is honestly guarded when no stable reference exists", () => {
  const report = baseReport({ elements: [anchor(0, null, "img")] }) as never;
  const { tasks, skipped } = buildVerificationTasks([finding({ code: "image-missing-alt", evidence: [{ type: "element", index: 0, locator: "page.locator(\"img\")", tag: "img" }] })], report as never);
  assert.equal(tasks.length, 0, "a brittle img locator with no id/src/href edge must not execute");
  assert.equal(skipped[0]?.cause, "fragile-locator");
  assert.equal(skipped[0]?.disposition, "SKIPPED_LOCATOR_GUARD");
  assert.ok(!skipped[0].reason.includes("REVIEW"), "the reason must not confuse a guard with an infrastructure problem");
});

test("hidden-interactive-element schedules a visibility check that never claims a defect", async () => {
  const report = baseReport({ elements: [anchor(0, null, "a", { tag: "a", role: "link", recommendedLocator: "page.getByRole(\"link\", { name: \"Login\" })", locatorQuality: "high" })] }) as never;
  const { tasks, skipped } = buildVerificationTasks([finding({ code: "hidden-interactive-element", evidence: [{ type: "element", index: 0, locator: "page.getByRole(\"link\", { name: \"Login\" })", tag: "a" }] })], report as never);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].strategy, "visibility");
  const baseTask = { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "visibility" as const, code: "hidden-interactive-element", title: "x", locator: "page.getByRole(\"link\", { name: \"Login\" })", elementIndex: 0, expectation: "x" };
  const hidden = await runVerification(fakePage({ probe: probe({ tag: "a", role: "link", visible: false }) }), baseTask, { targetUrl: "https://qa.test/en" });
  assert.equal(hidden.status, "NOT_REPRODUCED");
  assert.equal(hidden.category, "CONDITIONAL");
  const shown = await runVerification(fakePage({ probe: probe({ tag: "a", role: "link", visible: true }) }), baseTask, { targetUrl: "https://qa.test/en" });
  assert.equal(shown.status, "PASS");
  assert.equal(shown.category, "EXPECTATION");
});