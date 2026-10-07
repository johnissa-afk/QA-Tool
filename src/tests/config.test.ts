// ---------------------------------------------------------------------------
// Phase 8E — QA configuration tests.
//
// Covers loading (none/valid/malformed), validation (values + unknown
// properties), defaults, precedence (defaults < config < CLI), CI integration
// with the existing Phase 8C policy, and the REAL effect of disabling an
// existing stage (coverage) — not merely that a value was parsed.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectIssues, groupIssues } from "../checks.js";
import { analyzeScan } from "../ai/index.js";
import { generateTestSuite } from "../test-generator.js";
import { DiscoveredElement, LinkResult, ScanReport } from "../types.js";
import { QA_CONFIG_DEFAULTS, loadQaConfig, resolveQaConfig } from "../qa/config.js";
import { parseBaselineMaxAge } from "../qa/baseline.js";
import { DEFAULT_VERIFICATION_SPEC, parseArgs } from "../qa-cli.js";

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const report = (elements: DiscoveredElement[], extra: Partial<ScanReport> = {}, links: LinkResult[] = []): ScanReport => {
  const issues = [...detectIssues(elements, { title: "QA target", lang: "en", viewport: "width=device-width" }), ...(extra.issues ?? [])];
  const grouped = groupIssues(issues);
  return {
    scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.filter(item => item.interactive).length, passes: 0, warnings: grouped.filter(issue => issue.status === "WARNING").length, failures: grouped.filter(issue => issue.status === "FAIL").length, infos: grouped.filter(issue => issue.status === "INFO").length, linksChecked: links.length, brokenLinks: links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length, consoleErrors: 0, pageErrors: 0, issueGroups: grouped.length, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements, issues: grouped, links, consoleErrors: [], consoleDiagnostics: [], pageErrors: [], ...extra,
  };
};

/** Loads a config from a temporary file (or discovers none when null). */
function loadFrom(content: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "qa-config-"));
  try {
    const path = join(dir, "qa.config.json");
    if (content !== null) writeFileSync(path, content, "utf8");
    return loadQaConfig({ path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Loading (spec §17) ------------------------------------------------------

test("no config file yields built-in defaults and is not an error", () => {
  const loaded = loadFrom(null);
  assert.equal(loaded.source, null);
  assert.equal(loaded.sourceLabel, "defaults");
  assert.deepEqual(loaded.config, {});
});

test("a valid config file is parsed and located", () => {
  const loaded = loadFrom(JSON.stringify({ crawl: { maxPages: 100 }, execution: { enabled: true }, ci: { failOn: "review" } }));
  assert.ok(loaded.source && loaded.source.endsWith("qa.config.json"));
  assert.equal(loaded.sourceLabel, "qa.config.json");
  assert.equal(loaded.config.crawl?.maxPages, 100);
  assert.equal(loaded.config.execution?.enabled, true);
  assert.equal(loaded.config.ci?.failOn, "review");
});

test("an empty object is valid and simply applies defaults", () => {
  const loaded = loadFrom("{}");
  assert.deepEqual(loaded.config, {});
  assert.deepEqual(resolveQaConfig(loaded.config), QA_CONFIG_DEFAULTS);
});

test("malformed JSON produces a clear configuration error before the pipeline starts", () => {
  assert.throws(() => loadFrom("{ \"crawl\": "), /Invalid qa\.config\.json:/);
  assert.throws(() => loadFrom("not json"), /Invalid qa\.config\.json:/);
});

test("a non-object configuration (array/primitive) is rejected", () => {
  assert.throws(() => loadFrom("[]"), /must be a JSON object/);
  assert.throws(() => loadFrom("\"nope\""), /must be a JSON object/);
});

// --- Validation (spec §9) ----------------------------------------------------

test("invalid values are rejected with the offending property named", () => {
  assert.throws(() => loadFrom(JSON.stringify({ crawl: { maxPages: -10 } })), /"crawl\.maxPages" must be an integer >= 1/);
  assert.throws(() => loadFrom(JSON.stringify({ crawl: { maxPages: 0 } })), /"crawl\.maxPages" must be an integer >= 1/);
  assert.throws(() => loadFrom(JSON.stringify({ crawl: { maxPages: 1.5 } })), /"crawl\.maxPages" must be an integer >= 1/);
  assert.throws(() => loadFrom(JSON.stringify({ crawl: { maxPages: "10" } })), /"crawl\.maxPages" must be an integer >= 1/);
  assert.throws(() => loadFrom(JSON.stringify({ execution: { enabled: "yes" } })), /"execution\.enabled" must be a boolean/);
  assert.throws(() => loadFrom(JSON.stringify({ ci: { failOn: "something" } })), /"ci\.failOn" must be one of review \| failed/);
  assert.throws(() => loadFrom(JSON.stringify({ ci: { failOn: "pass" } })), /"ci\.failOn" must be one of review \| failed/);
});

test("a section that is not an object is rejected", () => {
  assert.throws(() => loadFrom(JSON.stringify({ coverage: false })), /"coverage" must be an object/);
  assert.throws(() => loadFrom(JSON.stringify({ crawl: 5 })), /"crawl" must be an object/);
});

// --- Unknown properties (spec §10) ------------------------------------------

test("unknown properties are hard errors that name the property", () => {
  assert.throws(() => loadFrom(JSON.stringify({ covergae: { enabled: false } })), /unknown property "covergae"/);
  assert.throws(() => loadFrom(JSON.stringify({ crawl: { maxPage: 10 } })), /unknown property "crawl\.maxPage"/);
  assert.throws(() => loadFrom(JSON.stringify({ ci: { failon: "failed" } })), /unknown property "ci\.failon"/);
  assert.throws(() => loadFrom(JSON.stringify({ coverage: { disabled: true } })), /unknown property "coverage\.disabled"/);
});

// --- Defaults + precedence (spec §7) ----------------------------------------

test("missing properties receive the existing built-in defaults", () => {
  const resolved = resolveQaConfig({ coverage: { enabled: false } });
  assert.equal(resolved.coverage, false);
  assert.equal(resolved.maxPages, 8);
  assert.equal(resolved.execution, false);
  assert.equal(resolved.regression, true);
  assert.equal(resolved.rootCause, true);
  assert.equal(resolved.history, true);
  assert.equal(resolved.historicalIntelligence, true);
  assert.equal(resolved.failOn, null);
});

test("precedence: default < config < CLI for crawl.maxPages", () => {
  const config = { crawl: { maxPages: 100 } };
  assert.equal(parseArgs(["https://qa.test/en", "--crawl"], config)?.maxPages, 100, "config overrides the built-in default");
  assert.equal(parseArgs(["https://qa.test/en", "--crawl", "--max-pages", "20"], config)?.maxPages, 20, "CLI overrides config");
  assert.equal(parseArgs(["https://qa.test/en", "--crawl"])?.maxPages, QA_CONFIG_DEFAULTS.maxPages, "no config keeps the default");
});

test("precedence applies to execution: config can enable it, CLI --execute none wins", () => {
  assert.equal(parseArgs(["https://qa.test/en"])?.execute, null, "default is no execution");
  assert.equal(parseArgs(["https://qa.test/en"], { execution: { enabled: true } })?.execute, DEFAULT_VERIFICATION_SPEC, "config enables execution");
  assert.equal(parseArgs(["https://qa.test/en", "--execute", "none"], { execution: { enabled: true } })?.execute, null, "CLI wins over config");
});

// --- CI integration (spec §8) -----------------------------------------------

test("config ci.failOn is used in CI mode without re-implementing the policy", () => {
  const options = parseArgs(["https://qa.test/en", "--crawl", "--execute", "--ci"], { ci: { failOn: "review" } });
  assert.equal(options?.ci, true);
  assert.equal(options?.failOn, "review");
});

test("CLI --fail-on overrides config ci.failOn", () => {
  const options = parseArgs(["https://qa.test/en", "--ci", "--fail-on", "failed"], { ci: { failOn: "review" } });
  assert.equal(options?.failOn, "failed");
});

test("config ci.failOn never enables CI mode on its own", () => {
  const options = parseArgs(["https://qa.test/en", "--crawl"], { ci: { failOn: "review" } });
  assert.equal(options?.ci, false);
  assert.equal(options?.failOn, "review");
});

test("config ci.gateMinSeverity validates, defaults to HIGH, and is case-insensitive", () => {
  assert.equal(loadFrom(JSON.stringify({ ci: { gateMinSeverity: "HIGH" } })).config.ci?.gateMinSeverity, "HIGH");
  assert.equal(loadFrom(JSON.stringify({ ci: { gateMinSeverity: "critiCal" } })).config.ci?.gateMinSeverity, "CRITICAL");
  assert.equal(loadFrom(JSON.stringify({ ci: { gateMinSeverity: " CRITICAL " } })).config.ci?.gateMinSeverity, "CRITICAL");
  assert.throws(() => loadFrom(JSON.stringify({ ci: { gateMinSeverity: "low" } })), /"ci\.gateMinSeverity" must be one of HIGH \| CRITICAL/);
  assert.throws(() => loadFrom(JSON.stringify({ ci: { gateMinSeverity: "MEDIUM" } })), /"ci\.gateMinSeverity" must be one of HIGH \| CRITICAL/);
  assert.throws(() => loadFrom(JSON.stringify({ ci: { gateMinSeverity: 3 } })), /"ci\.gateMinSeverity" must be one of HIGH \| CRITICAL/);
  assert.throws(() => loadFrom(JSON.stringify({ ci: { gateMinSeverit: "HIGH" } })), /unknown property "ci\.gateMinSeverit"/);
  assert.equal(resolveQaConfig({}).gateMinSeverity, "HIGH", "default gate threshold is HIGH");
});

// --- Phase 10D: baseline rotation policy -------------------------------------

test("baseline.maxAge is accepted, normalized, and resolved into QaOptions", () => {
  assert.equal(loadFrom(JSON.stringify({ baseline: { maxAge: "30d" } })).config.baseline?.maxAge, "30d");
  assert.equal(loadFrom(JSON.stringify({ baseline: { maxAge: " 12H " } })).config.baseline?.maxAge, "12h", "units are case-insensitive and trimmed");
  assert.equal(resolveQaConfig({ baseline: { maxAge: "90m" } }).baselineMaxAge, "90m");
  assert.equal(resolveQaConfig({}).baselineMaxAge, null, "default is no rotation policy");
  assert.equal(parseArgs(["https://qa.test/en"], { baseline: { maxAge: "7d" } })?.baselineMaxAge, "7d");
  assert.equal(parseArgs(["https://qa.test/en"])?.baselineMaxAge, null);
});

test("an empty baseline section is valid and yields no policy", () => {
  const loaded = loadFrom(JSON.stringify({ baseline: {} }));
  assert.deepEqual(loaded.config.baseline, {});
  assert.equal(resolveQaConfig(loaded.config).baselineMaxAge, null);
});

test("CLI --baseline-max-age overrides baseline.maxAge config", () => {
  const withConfig = parseArgs(["https://qa.test/en", "--baseline-max-age", "2w"], { baseline: { maxAge: "90d" } });
  assert.equal(withConfig?.baselineMaxAge, "2w");
  assert.equal(withConfig?.baselineMaxAgeMs, parseBaselineMaxAge("2w"));
});

test("invalid baseline.maxAge values are hard errors that name the property", () => {
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { maxAge: "30" } })), /"baseline\.maxAge" must be <number>m\|h\|d\|w/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { maxAge: "30 days" } })), /"baseline\.maxAge" must be <number>m\|h\|d\|w/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { maxAge: 30 } })), /"baseline\.maxAge" must be a duration string/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { maxAge: "" } })), /"baseline\.maxAge" must be a duration string/);
});

test("baseline section errors are enforced (unknown property, wrong shape)", () => {
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { maxAges: "30d" } })), /unknown property "baseline\.maxAges"/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: "30d" })), /"baseline" must be an object/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { maxAge: "30d" }, baselines: {} })), /unknown property "baselines"/);
});

// --- Phase 11: config-pinned baseline (baseline.path) ------------------------

test("baseline.path is accepted, trimmed, and resolved into QaOptions", () => {
  const loaded = loadFrom(JSON.stringify({ baseline: { path: "  reports/qa-baseline.json  " } }));
  assert.equal(loaded.config.baseline?.path, "reports/qa-baseline.json", "path is trimmed");
  assert.equal(resolveQaConfig({ baseline: { path: "reports/qa-baseline.json" } }).baselinePath, "reports/qa-baseline.json");
  assert.equal(resolveQaConfig({}).baselinePath, null, "default is no pinned baseline");
  assert.equal(parseArgs(["https://qa.test/en"], { baseline: { path: "reports/qa-baseline.json" } })?.baselinePath, "reports/qa-baseline.json");
  assert.equal(parseArgs(["https://qa.test/en"])?.baselinePath, null);
});

test("baseline.maxAge and baseline.path combine without interfering", () => {
  const loaded = loadFrom(JSON.stringify({ baseline: { maxAge: "30d", path: "reports/qa-baseline.json" } }));
  assert.equal(loaded.config.baseline?.maxAge, "30d");
  assert.equal(loaded.config.baseline?.path, "reports/qa-baseline.json");
  const options = parseArgs(["https://qa.test/en"], { baseline: { maxAge: "30d", path: "reports/qa-baseline.json" } });
  assert.equal(options?.baselineMaxAge, "30d");
  assert.equal(options?.baselinePath, "reports/qa-baseline.json");
});

test("CLI --baseline overrides baseline.path config", () => {
  const options = parseArgs(["https://qa.test/en", "--baseline", "reports/other.json"], { baseline: { path: "reports/qa-baseline.json" } });
  assert.equal(options?.baselinePath, "reports/other.json");
});

test("invalid baseline.path values are hard errors that name the property", () => {
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { path: "" } })), /"baseline\.path" must be a non-empty file path/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { path: "   " } })), /"baseline\.path" must be a non-empty file path/);
  assert.throws(() => loadFrom(JSON.stringify({ baseline: { path: 42 } })), /"baseline\.path" must be a non-empty file path/);
});

test("an empty baseline section still yields no policy and no pinned path", () => {
  const loaded = loadFrom(JSON.stringify({ baseline: {} }));
  assert.deepEqual(loaded.config.baseline, {});
  assert.equal(resolveQaConfig(loaded.config).baselineMaxAge, null);
  assert.equal(resolveQaConfig(loaded.config).baselinePath, null);
});

// --- Phase 13: config-pinned performance budgets (perf.budgets) ---------------

test("perf.budgets is accepted, trimmed, and resolved into QaOptions", () => {
  const loaded = loadFrom(JSON.stringify({ perf: { budgets: "  perf.budgets.json  " } }));
  assert.equal(loaded.config.perf?.budgets, "perf.budgets.json", "path is trimmed");
  assert.equal(resolveQaConfig({ perf: { budgets: "perf.budgets.json" } }).perfBudgetsPath, "perf.budgets.json");
  assert.equal(resolveQaConfig({}).perfBudgetsPath, null, "default is no budgets file");
  assert.equal(parseArgs(["https://qa.test/en"], { perf: { budgets: "perf.budgets.json" } })?.perfBudgetsPath, "perf.budgets.json");
  assert.equal(parseArgs(["https://qa.test/en"])?.perfBudgetsPath, null);
});

test("CLI --perf-budgets overrides perf.budgets config", () => {
  const options = parseArgs(["https://qa.test/en", "--perf-budgets", "other.budgets.json"], { perf: { budgets: "perf.budgets.json" } });
  assert.equal(options?.perfBudgetsPath, "other.budgets.json");
  // The flag never needs the file at parse time: it is validated before the
  // pipeline runs, so argument parsing stays pure.
  assert.equal(parseArgs(["https://qa.test/en", "--perf-budgets", "does-not-exist.json"])?.perfBudgetsPath, "does-not-exist.json");
});

test("invalid perf.budgets values are hard errors that name the property", () => {
  assert.throws(() => loadFrom(JSON.stringify({ perf: { budgets: "" } })), /"perf\.budgets" must be a non-empty file path/);
  assert.throws(() => loadFrom(JSON.stringify({ perf: { budgets: "   " } })), /"perf\.budgets" must be a non-empty file path/);
  assert.throws(() => loadFrom(JSON.stringify({ perf: { budgets: 7 } })), /"perf\.budgets" must be a non-empty file path/);
  assert.throws(() => loadFrom(JSON.stringify({ perf: { budget: "x.json" } })), /unknown property "perf\.budget"/);
  assert.throws(() => loadFrom(JSON.stringify({ perf: true })), /"perf" must be an object/);
});

test("an empty perf section yields no budgets path", () => {
  const loaded = loadFrom(JSON.stringify({ perf: {} }));
  assert.deepEqual(loaded.config.perf, {});
  assert.equal(resolveQaConfig(loaded.config).perfBudgetsPath, null);
});

// --- Stage enablement: resolved + REAL effect (spec §17) --------------------

test("stage toggles resolve into QaOptions (and default to on)", () => {
  const off = parseArgs(["https://qa.test/en"], {
    coverage: { enabled: false },
    regression: { enabled: false },
    rootCause: { enabled: false },
    history: { enabled: false },
    historicalIntelligence: { enabled: false },
  });
  assert.equal(off?.coverage, false);
  assert.equal(off?.regression, false);
  assert.equal(off?.rootCause, false);
  assert.equal(off?.history, false);
  assert.equal(off?.historicalIntelligence, false);

  const on = parseArgs(["https://qa.test/en"]);
  assert.equal(on?.coverage, true);
  assert.equal(on?.regression, true);
  assert.equal(on?.rootCause, true);
  assert.equal(on?.history, true);
  assert.equal(on?.historicalIntelligence, true);
});

test("coverage.enabled=false really skips the coverage stage (null map + null summary)", async () => {
  const page = report([element()]);
  const suite = generateTestSuite(page);

  const enabled = await analyzeScan(page, { suite });
  assert.ok(enabled.coverage, "coverage is built by default");
  assert.ok(enabled.summary.coverageSummary, "coverage summary is attached by default");

  const disabled = await analyzeScan(page, { suite, coverage: false });
  assert.equal(disabled.coverage, null, "the coverage map is not produced when disabled");
  assert.equal(disabled.summary.coverageSummary, null, "the coverage summary is not attached when disabled");
  // The rest of the pipeline is unaffected — it is still one pipeline.
  assert.ok(disabled.findings.length >= 0);
  assert.ok(disabled.flowDiscovery);
});
