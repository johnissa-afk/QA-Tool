import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectIssues, groupIssues } from "../checks.js";
import { parseArgs } from "../cli.js";
import { emitGithubAnnotations, printJsonSummary, writeJUnitReport } from "../reporter.js";
import { matchesAnyPattern, splitPatterns } from "../glob.js";
import { parsePerfBudgets, checkPerfBudgets, loadPerfBudgets } from "../perf-budgets.js";
import { buildLocator } from "../locators.js";
import { getAuthenticationConfig, scanWebsite } from "../scanner.js";
import { Issue, PerformanceMetrics, ScanReport } from "../types.js";
import { DiscoveredElement } from "../types.js";

const base = (overrides: Partial<Omit<DiscoveredElement, "recommendedLocator" | "locatorQuality">> = {}) => ({ tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", ...overrides });

test("CLI parses scanner options", () => {
  const result = parseArgs(["https://example.com", "--headed", "--timeout", "1000", "--output", "reports/custom.json"]);
  assert.equal(result?.headed, true);
  assert.equal(result?.timeout, 1000);
  assert.match(result?.outputPath ?? "", /reports[\\/]custom\.json$/);
  assert.equal(parseArgs(["--help"]), null);
});

test("CLI parses retry, wait-until, and throttle flags with defaults", () => {
  const result = parseArgs(["https://example.com"]);
  assert.equal(result?.retries, 0);
  assert.equal(result?.waitUntil, "domcontentloaded");
  assert.equal(result?.throttleKbps, 0);
});

test("CLI parses retry, wait-until, and throttle flags when provided", () => {
  const result = parseArgs(["https://example.com", "--retries", "3", "--wait-until", "networkidle", "--throttle", "500"]);
  assert.equal(result?.retries, 3);
  assert.equal(result?.waitUntil, "networkidle");
  assert.equal(result?.throttleKbps, 500);
});

test("CLI rejects invalid --retries", () => {
  assert.throws(() => parseArgs(["https://example.com", "--retries", "-1"]), /non-negative/);
  assert.throws(() => parseArgs(["https://example.com", "--retries", "abc"]), /non-negative/);
  assert.throws(() => parseArgs(["https://example.com", "--retries"]), /requires a value/);
});

test("CLI rejects invalid --wait-until values", () => {
  assert.throws(() => parseArgs(["https://example.com", "--wait-until", "now"]), /must be one of/);
  assert.throws(() => parseArgs(["https://example.com", "--wait-until"]), /requires a value/);
});

test("CLI rejects invalid --throttle values", () => {
  assert.throws(() => parseArgs(["https://example.com", "--throttle", "-5"]), /non-negative/);
  assert.throws(() => parseArgs(["https://example.com", "--throttle", "abc"]), /non-negative/);
  assert.throws(() => parseArgs(["https://example.com", "--throttle"]), /requires a value/);
});

test("CLI parses URL filtering flags with defaults", () => {
  const result = parseArgs(["https://example.com"]);
  assert.equal(result?.includePatterns, undefined);
  assert.equal(result?.excludePatterns, undefined);
  assert.equal(result?.followExternal, false);
  assert.equal(result?.allowPrivateNetwork, false);
});

test("CLI rejects private targets unless explicitly authorized", () => {
  assert.throws(() => parseArgs(["http://127.0.0.1:3000"]), /Refusing private-network target/);
  assert.equal(parseArgs(["http://127.0.0.1:3000", "--allow-private-network"])?.allowPrivateNetwork, true);
  assert.throws(() => parseArgs(["file:///C:/secret.html"]), /http:\/\/ or https:\/\//);
});

test("CLI parses URL filtering flags when provided", () => {
  const result = parseArgs(["https://example.com", "--include", "https://example.com/products/*,/pricing", "--exclude", "*/admin/*", "--follow-external"]);
  assert.equal(result?.includePatterns, "https://example.com/products/*,/pricing");
  assert.equal(result?.excludePatterns, "*/admin/*");
  assert.equal(result?.followExternal, true);
});

test("glob matches URLs with star, wildcard, and literal segments", () => {
  const patterns = splitPatterns("https://example.com/products/*,*/pricing");
  assert.equal(matchesAnyPattern("https://example.com/products/widget", patterns), true);
  assert.equal(matchesAnyPattern("https://example.com/pricing", patterns), true);
  assert.equal(matchesAnyPattern("https://example.com/about", patterns), false);
});

test("splitPatterns ignores whitespace and empty entries", () => {
  assert.deepEqual(splitPatterns("a, , b ,"), ["a", "b"]);
  assert.deepEqual(splitPatterns(""), []);
});

test("CLI parses reporter and github-annotations flags with defaults", () => {
  const result = parseArgs(["https://example.com"]);
  assert.equal(result?.reporter, "line");
  assert.equal(result?.githubAnnotations, false);
});

test("CLI parses reporter and github-annotations flags when provided", () => {
  const result = parseArgs(["https://example.com", "--reporter", "junit", "--github-annotations"]);
  assert.equal(result?.reporter, "junit");
  assert.equal(result?.githubAnnotations, true);
});

test("CLI rejects invalid --reporter values", () => {
  assert.throws(() => parseArgs(["https://example.com", "--reporter", "xml"]), /must be one of/);
  assert.throws(() => parseArgs(["https://example.com", "--reporter"]), /requires a value/);
});

const stubReport = (overrides: Partial<ScanReport> = {}): ScanReport => ({
  scan: { url: "https://example.com", finalUrl: "https://example.com", title: "Test", timestamp: "2026-01-01T00:00:00Z", durationMs: 1234, navigationStatus: 200, retryAttempts: 0, waitUntil: "domcontentloaded", throttleKbps: undefined, includePatterns: undefined, excludePatterns: undefined, followExternal: false },
  authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: null },
  summary: { totalElements: 3, interactiveElements: 1, passes: 1, warnings: 1, failures: 1, infos: 1, linksChecked: 2, brokenLinks: 1, consoleErrors: 1, pageErrors: 1, issueGroups: 3, groupedIssueCounts: { passes: 1, warnings: 1, failures: 1, infos: 1 } },
  page: { language: "en", viewport: "width=device-width", forms: 1, images: 1, links: 1, buttons: 1, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
  elements: [],
  issues: [
    { status: "FAIL", code: "image-missing-alt", message: "Image has no alt text." },
    { status: "WARNING", code: "button-missing-name", message: "Button has no accessible name." },
  ] as Issue[],
  links: [],
  consoleErrors: ["console error text"],
  consoleDiagnostics: [],
  pageErrors: ["page error text"],
  ...overrides,
});

test("writeJUnitReport produces valid XML with correct counts", () => {
  const folder = mkdtempSync(join(tmpdir(), "junit-"));
  try {
    const path = writeJUnitReport(stubReport(), folder);
    const xml = readFileSync(path, "utf8");
    assert.ok(xml.includes('<?xml version="1.0"'));
    assert.ok(xml.includes("<testsuites"));
    const testsMatch = xml.match(/tests="(\d+)"/);
    const failuresMatch = xml.match(/failures="(\d+)"/);
    const errorsMatch = xml.match(/errors="(\d+)"/);
    assert.ok(testsMatch, "has tests attribute");
    assert.equal(Number(testsMatch![1]), 4);
    assert.equal(Number(failuresMatch![1]), 1);
    assert.equal(Number(errorsMatch![1]), 2);
    assert.ok(xml.includes("image-missing-alt"));
    assert.ok(xml.includes("button-missing-name"));
    assert.ok(existsSync(path));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("printJsonSummary emits compact JSON with exit code", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    printJsonSummary(stubReport());
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.url, "https://example.com");
  assert.equal(parsed.failures, 1);
  assert.equal(parsed.warnings, 1);
  assert.equal(parsed.exitCode, 1);
  assert.equal(parsed.totalElements, 3);
});

test("emitGithubAnnotations emits error and warning workflow commands", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    emitGithubAnnotations(stubReport());
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some(l => l.startsWith("::error") && l.includes("image-missing-alt")));
  assert.ok(lines.some(l => l.startsWith("::error") && l.includes("page-error")));
  assert.ok(lines.some(l => l.startsWith("::error") && l.includes("console-error")));
  assert.ok(lines.some(l => l.startsWith("::warning") && l.includes("button-missing-name")));
});

test("locator generation prefers role and accessible name", () => {
  assert.deepEqual(buildLocator(base()), { recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high" });
  assert.equal(buildLocator(base({ role: null, accessibleName: null, placeholder: "Search" })).recommendedLocator, "page.getByPlaceholder(\"Search\")");
  assert.equal(buildLocator(base({ role: null, accessibleName: null, text: "", testId: "save-button" })).recommendedLocator, "page.getByTestId(\"save-button\")");
});

test("authentication configuration supports optional Basic Auth without exposing secrets", () => {
  const basic = getAuthenticationConfig({ QA_BASIC_AUTH_USER: "test-user", QA_BASIC_AUTH_PASSWORD: "test-password" });
  assert.deepEqual(basic.httpCredentials, { username: "test-user", password: "test-password" });
  assert.equal(basic.diagnostic.method, "basic");
  assert.equal(JSON.stringify(basic).includes("test-password"), false);
  assert.equal(getAuthenticationConfig({}).httpCredentials, undefined);
  assert.throws(() => getAuthenticationConfig({ QA_BASIC_AUTH_USER: "only-user" }), /requires both QA_BASIC_AUTH_USER and QA_BASIC_AUTH_PASSWORD/);
  assert.throws(() => getAuthenticationConfig({ QA_BASIC_AUTH_PASSWORD: "only-password" }), /requires both QA_BASIC_AUTH_USER and QA_BASIC_AUTH_PASSWORD/);
  assert.throws(() => getAuthenticationConfig({ QA_USERNAME: "only-user" }), /requires both QA_USERNAME and QA_PASSWORD/);
  assert.throws(() => getAuthenticationConfig({ QA_PASSWORD: "only-password" }), /requires both QA_USERNAME and QA_PASSWORD/);
  assert.equal(getAuthenticationConfig({ QA_AUTHORIZATION: "Bearer test" }).diagnostic.method, "authorization");
});

test("QA checks find high-value issues", () => {
  const image = { ...base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null }), ...buildLocator(base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null })) };
  const button = { ...base({ accessibleName: null, text: "" }), ...buildLocator(base({ accessibleName: null, text: "" })) };
  const issues = detectIssues([image, button], { title: "", lang: null, viewport: null });
  assert.ok(issues.some(issue => issue.code === "image-missing-alt"));
  assert.ok(issues.some(issue => issue.code === "button-missing-name"));
  assert.ok(issues.some(issue => issue.code === "missing-page-title"));
});

test("grouping consolidates repeated issues and preserves examples", () => {
  const image = { ...base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null }), ...buildLocator(base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null })) };
  const hiddenButton = { ...base({ visible: false }), ...buildLocator(base({ visible: false })) };
  const issues = detectIssues([image, { ...image, id: "second-image" }, hiddenButton, { ...hiddenButton, id: "second-button" }], { title: "QA", lang: "en", viewport: "width=device-width" });
  const grouped = groupIssues(issues);
  const missingAlt = grouped.find(issue => issue.code === "image-missing-alt");
  const hidden = grouped.find(issue => issue.code === "hidden-interactive-element");
  assert.equal(missingAlt?.count, 2);
  assert.equal(missingAlt?.examples?.length, 2);
  assert.equal(hidden?.count, 2);
});

test("element-level issues carry identifying fields", () => {
  const input = { ...base({ tag: "input", role: "textbox", type: "email", name: "email", placeholder: "Email ID", accessibleName: null, interactive: true }), ...buildLocator(base({ tag: "input", role: "textbox", type: "email", name: "email", placeholder: "Email ID", accessibleName: null, interactive: true })) };
  const issues = detectIssues([input], { title: "QA", lang: "en", viewport: "width=device-width" });
  const labelIssue = issues.find(issue => issue.code === "input-missing-label");
  assert.equal(labelIssue?.element?.tag, "input");
  assert.equal(labelIssue?.element?.type, "email");
  assert.equal(labelIssue?.element?.name, "email");
  assert.equal(labelIssue?.element?.placeholder, "Email ID");
  assert.equal(labelIssue?.element?.locatorQuality, "high");
  assert.ok(labelIssue?.element?.recommendedLocator.includes("getByPlaceholder"));
});

test("decorative and presentation images are excluded from image-missing-alt", () => {
  const missingAlt = { ...base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null }), ...buildLocator(base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: null })) };
  const emptyAlt = { ...base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: "" }), ...buildLocator(base({ tag: "img", role: "img", interactive: false, accessibleName: null, alt: "" })) };
  const presentational = { ...base({ tag: "img", role: "presentation", interactive: false, accessibleName: null, alt: null }), ...buildLocator(base({ tag: "img", role: "presentation", interactive: false, accessibleName: null, alt: null })) };
  const issues = detectIssues([missingAlt, emptyAlt, presentational], { title: "QA", lang: "en", viewport: "width=device-width" });
  const altIssues = issues.filter(issue => issue.code === "image-missing-alt");
  assert.equal(altIssues.length, 1);
  assert.equal(altIssues[0]?.element?.alt, null);
});

test("duplicate-id is reported once with occurrences and every affected element", () => {
  const first = { ...base({ id: "dup-id", name: "first" }), ...buildLocator(base({ id: "dup-id", name: "first" })) };
  const second = { ...base({ id: "dup-id", name: "second" }), ...buildLocator(base({ id: "dup-id", name: "second" })) };
  const grouped = groupIssues(detectIssues([first, second], { title: "QA", lang: "en", viewport: "width=device-width" }));
  const duplicates = grouped.filter(issue => issue.code === "duplicate-id");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.status, "FAIL");
  assert.equal(duplicates[0]?.occurrences, 2);
  assert.equal(duplicates[0]?.count, 1);
  assert.equal(duplicates[0]?.examples?.length, 2);
  assert.match(duplicates[0]?.message ?? "", /"dup-id" appears 2 times/);
});

test("scanner generates JSON and HTML from a local page", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/missing") { response.writeHead(404); response.end("missing"); return; }
    if (request.url === "/duplicates") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html lang="en"><head><title>Dupes</title></head><body><input id="dupe" placeholder="one"><input id="dupe" placeholder="two"></body></html>'); return; }
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/no-optional") {
      response.end("<!doctype html><html><head></head><body><p>Minimal page</p></body></html>");
      return;
    }
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Local QA</title></head><body><form><button>Save</button></form><img src="/image.png"><a href="/missing">Broken</a></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-"));
  try {
    const result = await scanWebsite({ url: `http://127.0.0.1:${address.port}`, headed: false, timeout: 10_000, outputPath: join(folder, "report.json"), concurrency: 1 });
    assert.equal(result.report.scan.title, "Local QA");
    assert.equal(result.report.page.language, "en");
    assert.equal(result.report.page.viewport, "width=device-width");
    assert.equal(result.report.page.forms, 1);
    assert.equal(result.report.page.images, 1);
    assert.equal(result.report.page.links, 1);
    assert.ok(result.report.elements.some(element => element.recommendedLocator.includes("getByRole")));
    assert.ok(result.report.issues.some(issue => issue.code === "image-missing-alt"));
    assert.equal(result.report.summary.brokenLinks, 1);
    assert.ok(existsSync(result.jsonPath));
    assert.ok(existsSync(result.htmlPath));
    assert.match(readFileSync(result.htmlPath, "utf8"), /Scan Overview[\s\S]*Interactive Elements[\s\S]*Screenshot/);
    const minimal = await scanWebsite({ url: `http://127.0.0.1:${address.port}/no-optional`, headed: false, timeout: 10_000, outputPath: join(folder, "minimal.json"), concurrency: 1 });
    assert.equal(minimal.report.scan.title, "");
    assert.equal(minimal.report.page.language, null);
    assert.equal(minimal.report.page.viewport, null);
    assert.equal(minimal.report.page.forms, 0);
    assert.equal(minimal.report.page.images, 0);
    assert.equal(minimal.report.page.links, 0);
    assert.ok(minimal.report.issues.some(issue => issue.code === "missing-viewport"));
    assert.ok(existsSync(minimal.jsonPath));
    assert.ok(existsSync(minimal.htmlPath));
    const duplicates = await scanWebsite({ url: `http://127.0.0.1:${address.port}/duplicates`, headed: false, timeout: 10_000, outputPath: join(folder, "duplicates.json"), concurrency: 1 });
    const duplicateIssue = duplicates.report.issues.find(issue => issue.code === "duplicate-id");
    assert.equal(duplicateIssue?.status, "FAIL");
    assert.equal(duplicateIssue?.occurrences, 2);
    assert.equal(duplicateIssue?.examples?.length, 2);
    assert.equal((duplicateIssue?.examples ?? []).every(example => example.element?.placeholder), true);
    const duplicateJson = JSON.parse(readFileSync(duplicates.jsonPath, "utf8"));
    const jsonDuplicate = duplicateJson.issues.find((issue: { code: string }) => issue.code === "duplicate-id");
    assert.equal(jsonDuplicate.occurrences, 2);
    assert.equal(jsonDuplicate.examples[0].element.tag, "input");
    assert.equal(jsonDuplicate.examples[0].element.placeholder, "one");
    assert.equal(jsonDuplicate.examples[0].element.recommendedLocator, "page.getByPlaceholder(\"one\")");
    const duplicateHtml = readFileSync(duplicates.htmlPath, "utf8");
    assert.match(duplicateHtml, /Occurrences: 2/);
    assert.match(duplicateHtml, /Placeholder/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("scanner authenticates a protected page with QA_BASIC_AUTH_* without persisting credentials", async () => {
  const expected = `Basic ${Buffer.from("basic-user:basic-password").toString("base64")}`;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      response.end("unauthorized");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Protected QA</title></head><body><button>Authenticated</button></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-basic-auth-"));
  const previousUser = process.env.QA_BASIC_AUTH_USER;
  const previousPassword = process.env.QA_BASIC_AUTH_PASSWORD;
  try {
    process.env.QA_BASIC_AUTH_USER = "basic-user";
    process.env.QA_BASIC_AUTH_PASSWORD = "basic-password";
    const result = await scanWebsite({ url: `http://127.0.0.1:${address.port}`, headed: false, timeout: 10_000, outputPath: join(folder, "protected.json"), concurrency: 1 });
    assert.equal(result.report.scan.navigationStatus, 200);
    assert.equal(result.report.authentication.method, "basic");
    assert.equal(result.report.authentication.accepted, true);
    assert.ok(result.report.elements.some(element => element.text.includes("Authenticated")));
    const serialized = readFileSync(result.jsonPath, "utf8");
    assert.equal(serialized.includes("basic-password"), false);
    assert.equal(serialized.includes("QA_BASIC_AUTH_PASSWORD"), false);
  } finally {
    if (previousUser === undefined) delete process.env.QA_BASIC_AUTH_USER; else process.env.QA_BASIC_AUTH_USER = previousUser;
    if (previousPassword === undefined) delete process.env.QA_BASIC_AUTH_PASSWORD; else process.env.QA_BASIC_AUTH_PASSWORD = previousPassword;
    rmSync(folder, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("CLI parses --perf-budgets flag", () => {
  const result = parseArgs(["https://example.com", "--perf-budgets", "perf-budgets.json"]);
  assert.equal(result?.perfBudgetsPath, "perf-budgets.json");
});

test("CLI omits --perf-budgets when not provided", () => {
  const result = parseArgs(["https://example.com"]);
  assert.equal(result?.perfBudgetsPath, undefined);
});

test("CLI rejects --perf-budgets without a value", () => {
  assert.throws(() => parseArgs(["https://example.com", "--perf-budgets"]), /requires a value/);
});

test("parsePerfBudgets accepts valid numeric thresholds", () => {
  const budgets = parsePerfBudgets({ ttfb: 600, lcp: 2500, cls: 0.1 }, "test.json");
  assert.equal(budgets.ttfb, 600);
  assert.equal(budgets.lcp, 2500);
  assert.equal(budgets.cls, 0.1);
});

test("parsePerfBudgets rejects negative values", () => {
  assert.throws(() => parsePerfBudgets({ ttfb: -1 }, "test.json"), /non-negative/);
});

test("parsePerfBudgets rejects unknown properties", () => {
  assert.throws(() => parsePerfBudgets({ fps: 60 }, "test.json"), /unknown property/);
});

test("parsePerfBudgets rejects non-object input", () => {
  assert.throws(() => parsePerfBudgets("not-an-object", "test.json"), /must contain a JSON object/);
  assert.throws(() => parsePerfBudgets([1, 2, 3], "test.json"), /must contain a JSON object/);
});

test("checkPerfBudgets flags exceeded thresholds", () => {
  const metrics: PerformanceMetrics = { ttfb: 800, fcp: 3000, lcp: 4000, cls: 0.25, domContentLoaded: 5000, loadEvent: 8000 };
  const budgets = { ttfb: 600, lcp: 2500, cls: 0.1 };
  const issues = checkPerfBudgets(metrics, budgets);
  assert.equal(issues.length, 3);
  assert.ok(issues.some(i => i.code === "perf-budget-ttfb" && i.status === "FAIL"));
  assert.ok(issues.some(i => i.code === "perf-budget-lcp" && i.status === "FAIL"));
  assert.ok(issues.some(i => i.code === "perf-budget-cls" && i.status === "FAIL"));
  assert.ok(!issues.some(i => i.code === "perf-budget-domContentLoaded"));
});

test("checkPerfBudgets passes when metrics are within budget", () => {
  const metrics: PerformanceMetrics = { ttfb: 300, fcp: 1000, lcp: 1500, cls: 0.05, domContentLoaded: 1200, loadEvent: 2000 };
  const budgets = { ttfb: 600, lcp: 2500, cls: 0.1 };
  const issues = checkPerfBudgets(metrics, budgets);
  assert.equal(issues.length, 0);
});

test("checkPerfBudgets skips null metrics", () => {
  const metrics: PerformanceMetrics = { ttfb: null, fcp: null, lcp: null, cls: null, domContentLoaded: null, loadEvent: null };
  const issues = checkPerfBudgets(metrics, { ttfb: 600, lcp: 2500 });
  assert.equal(issues.length, 0);
});

test("loadPerfBudgets returns null for missing file", () => {
  assert.equal(loadPerfBudgets("/nonexistent/budgets.json"), null);
});

test("loadPerfBudgets loads and validates a valid file", () => {
  const folder = mkdtempSync(join(tmpdir(), "perf-budgets-"));
  try {
    const path = join(folder, "budgets.json");
    writeFileSync(path, JSON.stringify({ lcp: 2500, cls: 0.1 }), "utf8");
    const budgets = loadPerfBudgets(path);
    assert.equal(budgets?.lcp, 2500);
    assert.equal(budgets?.cls, 0.1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("loadPerfBudgets rejects malformed JSON", () => {
  const folder = mkdtempSync(join(tmpdir(), "perf-budgets-"));
  try {
    const path = join(folder, "bad.json");
    writeFileSync(path, "{not valid json", "utf8");
    assert.throws(() => loadPerfBudgets(path), /malformed JSON/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("scanner collects performance metrics with a perf-budgets file", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Metrics QA</title></head><body><h1>Hello</h1></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-"));
  const budgetsPath = join(folder, "budgets.json");
  writeFileSync(budgetsPath, JSON.stringify({ lcp: 1, cls: 0.001 }), "utf8");
  try {
    const result = await scanWebsite({ url: `http://127.0.0.1:${address.port}`, headed: false, timeout: 10_000, outputPath: join(folder, "report.json"), concurrency: 1, perfBudgetsPath: budgetsPath });
    assert.ok(result.report.performance, "performance metrics should be present");
    const budgetIssues = result.report.issues.filter(i => i.code.startsWith("perf-budget-"));
    assert.ok(typeof result.report.performance !== "undefined", "performance field should exist in report");
    // Phase 13 guard: Chromium keeps LCP out of the passive timeline, so a
    // budgets file could only ever have "passed" against a null measurement.
    assert.equal(typeof result.report.performance.lcp, "number", "LCP is actually measured, not silently null");
    assert.ok(budgetIssues.some(issue => issue.code === "perf-budget-lcp" && issue.status === "FAIL"), "the LCP budget is enforced against the measured value");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
