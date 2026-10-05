import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePlaywrightSpec, locatorExpression, assertionsFor } from "../playwright-generator.js";
import { generateTestSuite, writeGeneratedTests } from "../test-generator.js";
import { DiscoveredElement, GeneratedScenario, GeneratedTestSuite, LinkResult, ScanReport } from "../types.js";

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const report = (elements: DiscoveredElement[], links: LinkResult[] = []): ScanReport => ({
  scan: { url: "https://example.com/en", finalUrl: "https://example.com/en", title: "Example", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: null },
  summary: { totalElements: elements.length, interactiveElements: elements.filter(item => item.interactive).length, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: links.length, brokenLinks: links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
  page: { language: "en", viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements, issues: [], links, consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
});

test("locatorExpression normalizes scanner locators into valid expressions", () => {
  const base: GeneratedScenario = {
    id: "SC-001", category: "navigation", title: "x", description: "d", preconditions: [], steps: [], expected: [], locator: "page.locator(\"a\")", risk: "safe", riskReason: "r", scenarioType: "structural", automated: true,
    sourceElement: { tag: "a", role: "link", id: null, name: null, text: "Home", type: null, href: null, placeholder: null, accessibleName: "Home", locatorQuality: "high", visible: true, occurrences: 1 },
  };
  assert.equal(locatorExpression({ ...base, locator: "page.getByRole(\"link\", { name: \"Home\" })" }), "page.getByRole(\"link\", { name: \"Home\" })");
  assert.equal(locatorExpression({ ...base, locator: "locator(\"#foo\")" }), "page.locator(\"#foo\")");
  assert.equal(locatorExpression({ ...base, locator: "form#login-form" }), "page.locator(\"form#login-form\")");
  assert.equal(locatorExpression({ ...base, locator: "[data-testid=\"x\"]" }), "page.locator(\"[data-testid=\\\"x\\\"]\")");
  assert.equal(locatorExpression({ ...base, locator: null }), null);
});

test("assertionsFor derives deterministic Playwright assertions", () => {
  const make = (title: string, extra: Partial<GeneratedScenario> = {}): GeneratedScenario => ({ id: "SC-001", category: "navigation", title, description: "d", preconditions: [], steps: [], expected: [], locator: "page.getByRole(\"link\", { name: \"Home\" })", risk: "safe", riskReason: "r", scenarioType: "structural", automated: true, sourceElement: { tag: "a", role: "link", id: null, name: null, text: "Home", type: null, href: null, placeholder: "Search", accessibleName: "Home", locatorQuality: "high", visible: true, occurrences: 1 }, ...extra });
  assert.deepEqual(assertionsFor(make(`Link "Home" is visible`), "page.loc")[0], "await expect(page.loc).toBeVisible();");
  assert.deepEqual(assertionsFor(make(`Link "Home" has an accessible name`), "page.loc")[0], "await expect(page.loc).toHaveAccessibleName(/Home/i);");
  assert.deepEqual(assertionsFor(make(`Field "x" has an accessible label`), "page.loc")[0], "await expect(page.loc).toHaveAccessibleName(/Home/i);");
  assert.deepEqual(assertionsFor(make(`Button "x" is enabled`), "page.loc")[0], "await expect(page.loc).toBeEnabled();");
  assert.deepEqual(assertionsFor(make(`Button "x" is disabled`), "page.loc")[0], "await expect(page.loc).toBeDisabled();");
  assert.deepEqual(assertionsFor(make(`Field "x" shows placeholder "Search"`), "page.loc")[0], "await expect(page.loc).toHaveAttribute(\"placeholder\", \"Search\");");
  const integrity = make("nav", { id: "SC-NAV-INTEGRITY", locator: null });
  assert.deepEqual(assertionsFor(integrity, null)[1], "expect(response?.status() ?? 0).toBeLessThan(400);");
});

test("every generated scenario carries description, riskReason, automation, and source element", () => {
  const elements = [
    element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://example.com/" }),
    element({ tag: "button", type: "submit", accessibleName: "Sign up" }),
    element({ tag: "input", role: "textbox", type: "password", accessibleName: null, recommendedLocator: "page.getByLabel(\"PIN\")" }),
  ];
  const suite = generateTestSuite(report(elements));
  for (const scenario of suite.scenarios) {
    assert.ok(scenario.description.length > 0, scenario.id);
    assert.ok(scenario.riskReason.length > 0, scenario.id);
    assert.equal(typeof scenario.automated, "boolean", scenario.id);
    assert.ok(scenario.sourceElement.tag.length > 0, scenario.id);
  }
});

test("low-quality tag-only locators are marked manual and excluded from automation", () => {
  const link = element({ tag: "a", role: "link", text: "naked", accessibleName: "naked", href: "https://example.com/", recommendedLocator: "page.locator(\"a\")", locatorQuality: "low" });
  const suite = generateTestSuite(report([link]));
  const scenarios = suite.scenarios.filter(scenario => scenario.locator === "page.locator(\"a\")");
  assert.ok(scenarios.length > 0);
  assert.equal(scenarios.every(scenario => scenario.automated === false), true);
});

test("playwright spec generation separates safe, review, and excluded high-risk scenarios", () => {
  const elements = [
    element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://example.com/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" }),
    element({ tag: "button", type: "submit", accessibleName: "Sign up", recommendedLocator: "page.getByRole(\"button\", { name: \"Sign up\" })" }),
    element({ tag: "button", accessibleName: "Toggle modal", recommendedLocator: "page.getByRole(\"button\", { name: \"Toggle modal\" })" }),
  ];
  const suite = generateTestSuite(report(elements));
  const folder = mkdtempSync(join(tmpdir(), "pw-gen-"));
  try {
    const output = join(folder, "generated-tests.spec.ts");
    const written = generatePlaywrightSpec(suite, output);
    assert.equal(written, output);
    assert.ok(existsSync(output));
    const source = readFileSync(output, "utf8");
    assert.match(source, /import \{ test, expect \} from "@playwright\/test"/);
    assert.match(source, /const TARGET_URL = "https:\/\/example\.com\/en";/);
    assert.match(source, /test\.fixme\(/);
    assert.match(source, /toBeVisible\(\)/);
    assert.ok(!source.includes("form submission requires manual review"), "high-risk submit scenarios must not appear in the spec file");
    assert.match(source, /automated \(SAFE\) scenario/);
    assert.ok(!/QA_USERNAME[=:]/i.test(source.replace(/process\.env\.QA_USERNAME/g, "")));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("generated spec compiles and runs under the Playwright runner", async () => {
  const link = element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://example.com/", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const suite: GeneratedTestSuite = generateTestSuite(report([link], []));
  const folder = mkdtempSync(join(tmpdir(), "pw-run-"));
  try {
    const output = join(folder, "runs.spec.ts");
    generatePlaywrightSpec(suite, output);
    const source = readFileSync(output, "utf8");
    assert.ok(source.includes("test.describe(\"navigation\", () => {"));
    assert.ok(source.includes("SC-001:"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("hidden conditional controls deduplicate into one review scenario with occurrence counts", () => {
  const hidden = () => element({ tag: "a", role: "link", text: "close player", accessibleName: "close player", href: "https://example.com/en#", visible: false, boundingBox: null, recommendedLocator: "page.getByRole(\"link\", { name: \"close player\" })" });
  const suite = generateTestSuite(report(Array.from({ length: 22 }, hidden)));
  const scenarios = suite.scenarios.filter(scenario => scenario.locator === "page.getByRole(\"link\", { name: \"close player\" })");
  assert.equal(scenarios.length, 1, "identical hidden controls must collapse into one scenario");
  assert.match(scenarios[0]!.title, /hidden at scan time/);
  assert.equal(scenarios[0]?.automated, false);
  assert.equal(scenarios[0]?.risk, "review");
  assert.equal(scenarios[0]?.requiresSetup, true);
  assert.equal(scenarios[0]?.sourceElement.visible, false);
  assert.equal(scenarios[0]?.sourceElement.occurrences, 22);
  assert.equal(suite.counts.conditional, 1);
  assert.equal(suite.counts.total, suite.counts.conditional + 1, "integrity summary included");
});

test("visible stable navigation links still generate automated visibility scenarios", () => {
  const link = element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://example.com/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const suite = generateTestSuite(report([link]));
  const visible = suite.scenarios.find(scenario => scenario.title.includes("is visible"));
  assert.ok(visible);
  assert.equal(visible?.automated, true);
  assert.equal(visible?.sourceElement.visible, true);
  const folder = mkdtempSync(join(tmpdir(), "pw-stable-"));
  try {
    const specPath = join(folder, "generated-tests.spec.ts");
    generatePlaywrightSpec(suite, specPath);
    const spec = readFileSync(specPath, "utf8");
    assert.ok(spec.includes("Home"), "visible nav link must be active in the spec");
    assert.ok(spec.includes("toBeVisible"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("distinct same-name controls with different hrefs are not merged", () => {
  const make = (href: string) => element({ tag: "a", role: "link", text: "Read more", accessibleName: "Read more", href, recommendedLocator: "page.getByRole(\"link\", { name: \"Read more\" })" });
  const suite = generateTestSuite(report([make("https://example.com/a"), make("https://example.com/b")]));
  const visible = suite.scenarios.filter(scenario => scenario.title.includes("is visible") && scenario.locator === "page.getByRole(\"link\", { name: \"Read more\" })");
  assert.equal(visible.length, 2);
  assert.equal(suite.scenarios.some(scenario => scenario.sourceElement.occurrences === 2 && scenario.automated), false);
});

test("ambiguous locators are not auto-executed when a name collision exists", () => {
  const episode2 = element({ tag: "a", role: "link", text: "Episode 2", accessibleName: "Episode 2", href: "https://example.com/video/2", recommendedLocator: "page.getByRole(\"link\", { name: \"Episode 2\" })" });
  const episode20 = element({ tag: "a", role: "link", text: "Episode 20", accessibleName: "Episode 20", href: "https://example.com/video/20", recommendedLocator: "page.getByRole(\"link\", { name: \"Episode 20\" })" });
  const episode21 = element({ tag: "a", role: "link", text: "Episode 21", accessibleName: "Episode 21", href: "https://example.com/video/21", recommendedLocator: "page.getByRole(\"link\", { name: \"Episode 21\" })" });
  const suite = generateTestSuite(report([episode2, episode20, episode21]));
  const ep2 = suite.scenarios.filter(scenario => scenario.locator === "page.getByRole(\"link\", { name: \"Episode 2\" })");
  assert.ok(ep2.length > 0);
  assert.equal(ep2.every(scenario => scenario.automated === false), true, "Episode 2 locator matches Episode 20/21 too, so it must not be automated");
  assert.ok(ep2.some(scenario => /ambiguous/i.test(scenario.riskReason)));
  const ep20 = suite.scenarios.filter(scenario => scenario.locator === "page.getByRole(\"link\", { name: \"Episode 20\" })");
  assert.ok(ep20.some(scenario => scenario.automated === true), "Episode 20 is unique and must stay automated");
});

test("non-ASCII Arabic names are preserved in scenarios, JSON, and HTML", () => {
  const link = element({ tag: "a", role: "link", text: "عربي", accessibleName: "عربي", href: "https://example.com/ar/set-lang", visible: false, boundingBox: null, recommendedLocator: "page.getByRole(\"link\", { name: \"عربي\" })" });
  const suite = generateTestSuite(report([link]));
  const scenario = suite.scenarios.find(scenario => scenario.locator === "page.getByRole(\"link\", { name: \"عربي\" })");
  assert.ok(scenario);
  assert.ok(scenario?.title.includes("عربي"));
  assert.equal(scenario?.sourceElement.accessibleName, "عربي");
  assert.equal(scenario?.sourceElement.visible, false);
  const folder = mkdtempSync(join(tmpdir(), "pw-ar-"));
  try {
    const output = join(folder, "generated-tests.json");
    const paths = writeGeneratedTests(suite, output);
    const parsed = JSON.parse(readFileSync(paths.jsonPath, "utf8")) as GeneratedTestSuite;
    assert.ok(parsed.scenarios.some(scenario => scenario.title.includes("عربي")));
    assert.ok(parsed.scenarios.some(scenario => scenario.sourceElement.accessibleName === "عربي"));
    const html = readFileSync(paths.htmlPath, "utf8");
    assert.ok(html.includes("عربي"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("hidden conditional scenarios stay in the report but are excluded from the executable spec", () => {
  const hidden = element({ tag: "a", role: "link", text: "close player", accessibleName: "close player", href: "https://example.com/en#", visible: false, boundingBox: null, recommendedLocator: "page.getByRole(\"link\", { name: \"close player\" })" });
  const visibleLink = element({ tag: "a", role: "link", text: "Home", accessibleName: "Home", href: "https://example.com/movies", recommendedLocator: "page.getByRole(\"link\", { name: \"Home\" })" });
  const suite = generateTestSuite(report([hidden, visibleLink]));
  const folder = mkdtempSync(join(tmpdir(), "pw-cond-"));
  try {
    const specPath = join(folder, "generated-tests.spec.ts");
    generatePlaywrightSpec(suite, specPath);
    const spec = readFileSync(specPath, "utf8");
    assert.ok(!spec.includes("close player"), "hidden control must not appear in the executable spec");
    assert.ok(spec.includes("Home"));
    const jsonPath = join(folder, "generated-tests.json");
    writeGeneratedTests(suite, jsonPath);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as GeneratedTestSuite;
    assert.ok(parsed.scenarios.some(scenario => scenario.requiresSetup === true));
    assert.equal(parsed.counts.conditional, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("records setup/action requirements and visible versus hidden source state", () => {
  const hiddenLink = element({ tag: "a", role: "link", text: "player volume", accessibleName: "player volume", href: "javascript:void(0);", visible: false, boundingBox: null, recommendedLocator: "page.getByRole(\"link\", { name: \"player volume\" })" });
  const suite = generateTestSuite(report([hiddenLink]));
  const scenario = suite.scenarios.find(scenario => scenario.locator === "page.getByRole(\"link\", { name: \"player volume\" })");
  assert.ok(scenario);
  assert.equal(scenario?.requiresSetup, true);
  assert.ok(scenario?.setupNote?.length);
  assert.equal(scenario?.sourceElement.visible, false);
  assert.match(scenario?.riskReason ?? "", /not visible/i);
});