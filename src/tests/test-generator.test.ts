import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTestSuite, writeGeneratedTests } from "../test-generator.js";
import { DiscoveredElement, LinkResult, ScanReport } from "../types.js";

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const report = (elements: DiscoveredElement[], links: LinkResult[] = []): ScanReport => ({
  scan: { url: "https://example.com/en", finalUrl: "https://example.com/en", title: "Example", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: null },
  summary: { totalElements: elements.length, interactiveElements: elements.filter(item => item.interactive).length, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: links.length, brokenLinks: links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
  page: { language: "en", viewport: null, forms: elements.filter(item => item.tag === "form").length, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements, issues: [], links, consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
});

test("link scenario generation covers visibility, name, and navigation", () => {
  const link = element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://example.com/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const suite = generateTestSuite(report([link]));
  const navigation = suite.scenarios.filter(scenario => scenario.category === "navigation" && scenario.locator === link.recommendedLocator);
  assert.equal(navigation.length, 3);
  const visible = navigation.find(scenario => scenario.title.includes("is visible"));
  const named = navigation.find(scenario => scenario.title.includes("accessible name"));
  const click = navigation.find(scenario => scenario.title.includes("navigates"));
  assert.equal(visible?.risk, "safe");
  assert.equal(named?.risk, "safe");
  assert.equal(click?.risk, "review");
  assert.equal(click?.scenarioType, "behavioral");
  assert.ok(click?.safetyNote?.length);
  assert.equal(click?.locator, link.recommendedLocator);
});

test("button scenario generation includes state and a reviewable click", () => {
  const button = element({ type: null });
  const suite = generateTestSuite(report([button]));
  const scenarios = suite.scenarios.filter(scenario => scenario.category === "button");
  assert.equal(scenarios.length, 4);
  assert.equal(scenarios.filter(scenario => scenario.title.includes("enabled")).length, 1);
  assert.equal(scenarios.find(scenario => scenario.title.includes("is enabled"))?.risk, "safe");
  assert.equal(scenarios.find(scenario => scenario.title.includes("safe to review"))?.risk, "review");
  assert.equal(scenarios.some(scenario => scenario.expected.some(item => item.includes("enabled and clickable"))), true);
});

test("submit buttons get a high-risk review scenario, never an automatic click", () => {
  const submit = element({ type: "submit", accessibleName: "Sign up" });
  const suite = generateTestSuite(report([submit]));
  const scenarios = suite.scenarios.filter(scenario => scenario.category === "button");
  const highRisk = scenarios.filter(scenario => scenario.risk === "high-risk");
  assert.equal(highRisk.length, 1);
  assert.match(highRisk[0]?.title, /form submission/i);
  assert.equal(scenarios.some(scenario => scenario.risk === "review"), false);
  assert.equal(scenarios.some(scenario => scenario.safetyNote?.includes("never click submit buttons")), true);
});

test("email input scenario generation includes label, placeholder, and valid-value validation", () => {
  const email = element({ tag: "input", role: "textbox", type: "email", name: "email", placeholder: "Email ID", accessibleName: null, interactive: true, recommendedLocator: "page.getByPlaceholder(\"Email ID\")" });
  const suite = generateTestSuite(report([email]));
  const input = suite.scenarios.filter(scenario => scenario.category === "input" && scenario.locator === email.recommendedLocator);
  const validation = suite.scenarios.filter(scenario => scenario.category === "validation" && scenario.locator === email.recommendedLocator);
  assert.ok(input.some(scenario => scenario.title.includes("is visible")));
  assert.ok(input.some(scenario => scenario.title.includes("accessible label")));
  assert.ok(input.some(scenario => scenario.title.includes("placeholder")));
  assert.equal(validation.filter(scenario => scenario.title.includes("empty value")).length, 1);
  const valid = validation.find(scenario => scenario.title.includes("valid email value"));
  assert.ok(valid);
  assert.ok(valid.steps.some(step => step.includes("qa.automation@example.com")));
  assert.equal(valid.risk, "review");
  assert.equal(valid.locator, email.recommendedLocator);
});

test("password fields are never filled with values", () => {
  const password = element({ tag: "input", role: "textbox", type: "password", name: "password_field", placeholder: "Password", accessibleName: null, interactive: true, recommendedLocator: "page.getByPlaceholder(\"Password\")" });
  const suite = generateTestSuite(report([password]));
  assert.ok(suite.scenarios.filter(scenario => scenario.locator === password.recommendedLocator && scenario.category === "input").some(scenario => scenario.title.includes("is visible")));
  assert.ok(suite.scenarios.some(scenario => scenario.category === "validation" && scenario.locator === password.recommendedLocator && scenario.title.includes("empty value")));
  assert.equal(suite.scenarios.some(scenario => scenario.locator === password.recommendedLocator && scenario.steps.some(step => step.includes("generic valid value"))), false);
});

test("checkbox and radio inputs get safe checks and a reviewable toggle", () => {
  const checkbox = element({ tag: "input", role: "checkbox", type: "checkbox", accessibleName: "Accept terms", recommendedLocator: "page.getByRole(\"checkbox\", { name: \"Accept terms\" })" });
  const suite = generateTestSuite(report([checkbox]));
  const scenarios = suite.scenarios.filter(scenario => scenario.locator === checkbox.recommendedLocator);
  assert.ok(scenarios.some(scenario => scenario.title.includes("is visible")));
  assert.ok(scenarios.some(scenario => scenario.title.includes("accessible label")));
  const toggle = scenarios.find(scenario => scenario.title.includes("Toggling"));
  assert.equal(toggle?.risk, "review");
  assert.equal(toggle?.scenarioType, "behavioral");
});

test("select controls generate combobox checks and an option-selection review", () => {
  const select = element({ tag: "select", role: "combobox", accessibleName: "Country", recommendedLocator: "page.getByRole(\"combobox\", { name: \"Country\" })" });
  const suite = generateTestSuite(report([select]));
  const scenarios = suite.scenarios.filter(scenario => scenario.locator === select.recommendedLocator);
  assert.equal(scenarios.length, 3);
  assert.ok(scenarios.some(scenario => scenario.title.includes("Selecting an option")));
  assert.equal(scenarios.find(scenario => scenario.title.includes("Selecting an option"))?.risk, "review");
});

test("form scenario generation identifies controls without submitting", () => {
  const form = element({ tag: "form", interactive: false, id: "login-form", accessibleName: null, recommendedLocator: "form#login-form" });
  const email = element({ tag: "input", role: "textbox", type: "email", name: "email", accessibleName: null, interactive: true, recommendedLocator: "page.getByLabel(\"Email\")", formIndex: 0 });
  const submit = element({ tag: "button", type: "submit", accessibleName: "Log in", interactive: true, recommendedLocator: "page.getByRole(\"button\", { name: \"Log in\" })", formIndex: 0 });
  const suite = generateTestSuite(report([form, email, submit]));
  const formScenarios = suite.scenarios.filter(scenario => scenario.category === "form");
  assert.equal(formScenarios.length, 1);
  const scenario = formScenarios[0];
  assert.equal(scenario?.risk, "high-risk");
  assert.equal(scenario?.scenarioType, "behavioral");
  assert.equal(scenario?.locator, "page.locator(\"#login-form\")");
  assert.ok(scenario?.preconditions.some(item => item.includes("2 interactive control(s)")));
  assert.ok(scenario?.steps.some(step => step.includes(email.recommendedLocator)));
  assert.ok(scenario?.steps.some(step => step.includes(submit.recommendedLocator)));
  assert.ok(scenario?.safetyNote?.toLowerCase().includes("never submit"));
  assert.ok(scenario?.steps.some(step => step.toLowerCase().includes("do not submit")));
});

test("locators are preserved from the scanner, never invented", () => {
  const link = element({ tag: "a", role: "link", accessibleName: "Movies", href: "https://example.com/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Movies\" })" });
  const input = element({ tag: "input", role: "textbox", type: "text", name: "search", accessibleName: null, recommendedLocator: "page.getByPlaceholder(\"Search\")" });
  const suite = generateTestSuite(report([link, input]));
  const locators = suite.scenarios.filter(scenario => scenario.id !== "SC-NAV-INTEGRITY").map(scenario => scenario.locator);
  assert.ok(locators.every(locator => locator === link.recommendedLocator || locator === input.recommendedLocator));
});

test("safety classification is always explicit", () => {
  const elements = [
    element({ tag: "a", role: "link", accessibleName: "Home", href: "https://example.com/" }),
    element({ tag: "button", type: "submit", accessibleName: "Save" }),
    element({ tag: "input", role: "textbox", type: "password", accessibleName: "PIN", recommendedLocator: "page.getByLabel(\"PIN\")" }),
    element({ tag: "form", interactive: false, accessibleName: null, id: "f" }),
  ];
  const suite = generateTestSuite(report(elements));
  for (const scenario of suite.scenarios) {
    assert.ok(["safe", "review", "high-risk"].includes(scenario.risk), scenario.risk);
    assert.ok(["structural", "behavioral"].includes(scenario.scenarioType), scenario.scenarioType);
  }
  assert.ok(suite.counts.safe + suite.counts.review + suite.counts.highRisk === suite.counts.total);
});

test("empty and invalid elements are ignored gracefully", () => {
  const noLocator = element({ tag: "button", recommendedLocator: "" });
  const nonInteractive = element({ tag: "img", interactive: false, accessibleName: null, recommendedLocator: "img" });
  const unknown = element({ tag: "marquee", interactive: true, recommendedLocator: "foo" });
  const suite = generateTestSuite(report([noLocator, nonInteractive, unknown]));
  assert.equal(suite.counts.button, 0);
  assert.equal(suite.scenarios.filter(scenario => scenario.locator === undefined || scenario.locator === "foo").length, 0);
  assert.ok(suite.counts.total >= 1);
});

test("empty report still yields a navigation integrity scenario", () => {
  const suite = generateTestSuite(report([]));
  const integrity = suite.scenarios.find(scenario => scenario.id === "SC-NAV-INTEGRITY");
  assert.ok(integrity);
  assert.equal(integrity?.risk, "safe");
  assert.equal(suite.scenarios.length, 1);
});

test("broken links surface in the navigation integrity scenario", () => {
  const broken: LinkResult = { url: "https://example.com/missing", status: 404, type: "BROKEN" };
  const suite = generateTestSuite(report([], [broken]));
  const integrity = suite.scenarios.find(scenario => scenario.id === "SC-NAV-INTEGRITY");
  assert.ok(integrity);
  assert.equal(integrity?.risk, "review");
  assert.ok(integrity?.expected.some(item => item.includes("1 link(s)")));
});

test("generated scenarios are written to JSON and HTML", () => {
  const link = element({ tag: "a", role: "link", accessibleName: "Home", href: "https://example.com/", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const suite = generateTestSuite(report([link]), { sourcePath: "reports/qa-report.json" });
  const folder = mkdtempSync(join(tmpdir(), "generated-tests-"));
  try {
    const output = join(folder, "generated-tests.json");
    const paths = writeGeneratedTests(suite, output);
    assert.ok(existsSync(paths.jsonPath));
    assert.ok(existsSync(paths.htmlPath));
    const parsed = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
    assert.equal(parsed.scenarios.length, suite.counts.total);
    assert.equal(parsed.sourceUrl, "https://example.com/en");
    const html = readFileSync(paths.htmlPath, "utf8");
    assert.match(html, /Generated QA tests/);
    assert.match(html, /page.getByRole/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});