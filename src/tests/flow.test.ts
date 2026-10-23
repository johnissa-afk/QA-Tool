import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { chromium } from "playwright";
import type { DiscoveredElement, ScanReport } from "../types.js";
import { analyzeScan } from "../ai/index.js";
import { scanPageInContext, scanWebsite, withScanBrowser } from "../scanner.js";
import { classifyStep, classifyFlowFailure, isExecutableStep, priorityForFlow, StepControl, flowBoundaryReason } from "../flow/index.js";
import { buildSiteGraphFromReport, mergeGraphs, normalizeUrl } from "../flow/index.js";
import { discoverFlows } from "../flow/index.js";
import { crawlSite } from "../flow/index.js";
import { runFlow } from "../flow/index.js";
import { defaultFlowLimits, summarizeFlows } from "../flow/index.js";
import type { FlowExecutionResult } from "../flow/index.js";

// ---------------------------------------------------------------------------
// Phase 3 fixture tests (generic sites A–J). All fixtures use the synthetic
// https://qa.test/en origin. No fixture, locator, or expectation references a
// real website.
// ---------------------------------------------------------------------------

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button",
  role: "button",
  text: "",
  ariaLabel: null,
  placeholder: null,
  name: null,
  id: null,
  testId: null,
  type: null,
  hasExplicitType: true,
  autocomplete: null,
  href: null,
  alt: null,
  visible: true,
  enabled: true,
  boundingBox: null,
  interactive: true,
  accessibleName: null,
  recommendedLocator: "page.getByText(\"x\")",
  locatorQuality: "high",
  formIndex: null,
  ...overrides,
});

const report = (overrides: Partial<Record<string, unknown>> & { elements?: DiscoveredElement[]; links?: ScanReport["links"] } = {}): ScanReport => {
  const elements = overrides.elements ?? [];
  return {
    scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "QA target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.length, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: elements.filter(e => e.tag === "a").length, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements,
    issues: [],
    links: overrides.links ?? [],
    consoleErrors: [],
    consoleDiagnostics: [],
    pageErrors: [],
    ...overrides,
  } as unknown as ScanReport;
};

const sameOrigin = "page.locator(\"a[href=\\\"https://qa.test/en/products\\\"]\")";

const limits = (overrides: Partial<ReturnType<typeof defaultFlowLimits>> = {}) => ({ ...defaultFlowLimits(), ...overrides });

// ---------------------------------------------------------------------------
// A. Navigation
// ---------------------------------------------------------------------------
test("A: same-origin links become executable NAVIGATION flows; external links never auto-run", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: sameOrigin }),
      element({ tag: "a", role: "link", text: "Site", accessibleName: "Site", href: "https://other.example", recommendedLocator: "page.locator(\"a[href=\\\"https://other.example\\\"]\")" }),
    ],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const nav = flows.filter(flow => flow.category === "NAVIGATION");
  assert.equal(nav.length, 1, "only the same-origin link becomes a navigation flow");
  assert.equal(nav[0]?.steps[0]?.action, "click-link");
  assert.ok(nav[0]?.steps.every(isExecutableStep), "same-origin navigation is fully executable");
  const externalClicked = flows.some(flow => flow.steps.some(step => step.targetUrl === "https://other.example"));
  assert.equal(externalClicked, false, "external destinations are never opened");
});

// ---------------------------------------------------------------------------
// B. Search
// ---------------------------------------------------------------------------
test("B: a search box + submit yields a fully executable SEARCH flow using a benign term", () => {
  const r = report({
    elements: [
      element({ tag: "input", role: "searchbox", type: "search", placeholder: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })", formIndex: 0 }),
      element({ tag: "button", role: "button", text: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })", formIndex: 0 }),
    ],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const search = flows.find(flow => flow.category === "SEARCH");
  assert.ok(search, "SEARCH flow discovered");
  assert.equal(search?.steps[1]?.action, "type");
  assert.equal(search?.steps[1]?.text, "quality");
  assert.ok(search?.steps.every(isExecutableStep), "search flow runs automatically");
  assert.ok(search?.title.includes("search"), "title names the search flow");
});

// ---------------------------------------------------------------------------
// C. Language switch
// ---------------------------------------------------------------------------
test("C: a language control becomes an executable LANGUAGE_SWITCH flow", () => {
  const r = report({
    elements: [element({ tag: "button", role: "button", text: "العربية", accessibleName: "العربية", href: "/?lang=ar", recommendedLocator: "page.getByRole(\"button\", { name: \"العربية\" })" })],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const lang = flows.find(flow => flow.category === "LANGUAGE_SWITCH");
  assert.ok(lang, "LANGUAGE_SWITCH flow discovered");
  assert.ok(lang?.steps.every(isExecutableStep), "language switch runs safely");
});

// ---------------------------------------------------------------------------
// D. Content discovery
// ---------------------------------------------------------------------------
test("D: a read-more/content link becomes a CONTENT_DISCOVERY flow", () => {
  const r = report({
    elements: [element({ tag: "a", role: "link", text: "Read more", accessibleName: "Read more", href: "https://qa.test/en/news/1", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/news/1\\\"]\")" })],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const content = flows.find(flow => flow.category === "CONTENT_DISCOVERY");
  assert.ok(content, "CONTENT_DISCOVERY flow discovered");
  assert.ok(content?.steps.every(isExecutableStep));
});

// ---------------------------------------------------------------------------
// E. Authentication boundary
// ---------------------------------------------------------------------------
test("E: the login flow is observed but stops before credentials — never completed", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Log in", accessibleName: "Log in", href: "https://qa.test/en/login", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/login\\\"]\")" }),
      element({ tag: "input", role: "textbox", type: "text", name: "username", placeholder: "Username", accessibleName: "Username", recommendedLocator: "page.getByPlaceholder(\"Username\")", formIndex: 0 }),
      element({ tag: "input", role: "textbox", type: "password", placeholder: "Password", recommendedLocator: "page.getByPlaceholder(\"Password\")", formIndex: 0 }),
    ],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const auth = flows.find(flow => flow.category === "AUTHENTICATION");
  assert.ok(auth, "AUTHENTICATION flow discovered (boundary only)");
  assert.ok(auth?.boundary, "the flow records a boundary");
  assert.equal(auth?.safety, "BLOCKED");
  assert.equal(auth?.automation, "MANUAL");
  const credentialSteps = auth?.steps.filter(step => !isExecutableStep(step)) ?? [];
  assert.ok(credentialSteps.length >= 2, "identifier entry and credential submit are both non-executable");
  assert.ok(!auth?.steps.some(step => step.action === "type" && isExecutableStep(step)), "no executable typing step");
  assert.ok(auth?.executable, "the safe observation prefix is still runnable");
});

// ---------------------------------------------------------------------------
// F. Destructive controls
// ---------------------------------------------------------------------------
test("F: destructive links are HIGH_RISK and never executed", () => {
  const control: StepControl = { tag: "a", role: "link", accessibleName: "Delete account", text: "Delete account", href: "https://qa.test/en/account/delete", type: null, inAuthForm: false, isSearch: false, visible: true, safeLocator: true, isExternal: false };
  const classified = classifyStep(control);
  assert.equal(classified.safety, "HIGH_RISK");
  assert.equal(classified.automation, "MANUAL");
  assert.equal(classifyStep({ ...control, href: "https://qa.test/en/logout" }).safety, "HIGH_RISK");
});

// ---------------------------------------------------------------------------
// G. Broken navigation
// ---------------------------------------------------------------------------
test("G: broken destinations surface as P0 ERROR_HANDLING flows and never as NAVIGATION", () => {
  const r = report({
    elements: [element({ tag: "a", role: "link", text: "Downloads", accessibleName: "Downloads", href: "https://qa.test/en/downloads", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/downloads\\\"]\")" })],
    links: [{ url: "https://qa.test/en/downloads", status: 404, type: "BROKEN" }],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const error = flows.find(flow => flow.category === "ERROR_HANDLING");
  assert.ok(error, "ERROR_HANDLING flow discovered for the broken destination");
  assert.equal(error?.priority, "P0");
  assert.equal(error?.steps[0]?.action, "open");
  assert.equal(error?.steps[0]?.targetUrl, "https://qa.test/en/downloads");
  assert.equal(flows.some(flow => flow.category === "NAVIGATION"), false, "the broken link is not a plain navigation flow");
});

// ---------------------------------------------------------------------------
// H. Ambiguous control classification
// ---------------------------------------------------------------------------
test("H: ambiguous locators classify REVIEW/MANUAL and stay unelected", () => {
  const ambiguous: StepControl = { tag: "span", role: "button", accessibleName: "?", text: "?", href: null, type: null, inAuthForm: false, isSearch: false, visible: true, safeLocator: false, isExternal: false };
  const classified = classifyStep(ambiguous);
  assert.equal(classified.safety, "REVIEW");
  assert.equal(classified.automation, "MANUAL");
  assert.equal(classified.stepKind, "unknown");
  assert.ok(!isExecutableStep(classified), "not executable");
});

// ---------------------------------------------------------------------------
// I. Deduplication preserves occurrence counts
// ---------------------------------------------------------------------------
test("I: repeated links collapse into one flow with occurrenceCount preserved", () => {
  const r = report({
    elements: [
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: sameOrigin }),
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: sameOrigin }),
      element({ tag: "a", role: "link", text: "Products", accessibleName: "Products", href: "https://qa.test/en/products", recommendedLocator: sameOrigin }),
    ],
  });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits());
  const nav = flows.filter(flow => flow.category === "NAVIGATION");
  assert.equal(nav.length, 1, "three copies dedupe into a single flow");
  assert.equal(nav[0]?.occurrenceCount, 3, "occurrence count is preserved");
});

// ---------------------------------------------------------------------------
// J. Limits
// ---------------------------------------------------------------------------
test("J: maxFlows and maxFlowSteps cap the discovery output", () => {
  const elements = [
    ...["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"].map((path, index) =>
      element({ tag: "a", role: "link", text: `Link ${index}`, accessibleName: `Link ${index}`, href: `https://qa.test/en${path}`, recommendedLocator: `page.locator(\"a[href=\\\"https://qa.test/en${path}\\\"]\")` }),
    ),
  ];
  const r = report({ elements });
  const graph = buildSiteGraphFromReport("page-1", r);
  const flows = discoverFlows(graph, limits({ maxFlows: 2, maxFlowSteps: 2 }));
  assert.ok(flows.length <= 2, "maxFlows caps discovered flows");
  assert.ok(flows.every(flow => flow.steps.length <= 2), "maxFlowSteps caps per-flow steps");
});

// ---------------------------------------------------------------------------
// Classification + failure mapping + graph wiring
// ---------------------------------------------------------------------------
test("password and arbitrary form submission are never executable", () => {
  const password: StepControl = { tag: "input", role: "textbox", accessibleName: null, text: null, href: null, type: "password", inAuthForm: false, isSearch: false, visible: true, safeLocator: true, isExternal: false };
  assert.ok(!isExecutableStep(classifyStep(password)));
  const arbitrary: StepControl = { tag: "button", role: "button", accessibleName: "Save", text: "Save", href: null, type: "submit", inAuthForm: false, isSearch: false, visible: true, safeLocator: true, isExternal: false };
  assert.equal(classifyStep(arbitrary).safety, "HIGH_RISK");
  const authSubmit: StepControl = { ...arbitrary, inAuthForm: true };
  assert.equal(classifyStep(authSubmit).safety, "BLOCKED");
});

test("classifyFlowFailure maps auth, network, locator errors to honest outcomes", () => {
  assert.equal(classifyFlowFailure(new Error("net::ERR_CONNECTION_REFUSED")).category, "INFRASTRUCTURE");
  assert.equal(classifyFlowFailure(new Error("HTTP 403 Forbidden — unauthorized")).category, "AUTH");
  assert.equal(classifyFlowFailure(new Error("waiting for selector .x — did not find element")).category, "LOCATOR");
  assert.equal(classifyFlowFailure(new Error("strict mode violation: resolved to 3 elements")).category, "LOCATOR");
  assert.equal(classifyFlowFailure(new Error("mystery")).category, "REVIEW");
});

test("priorityForFlow bans navigation breakdowns last and satisfies P0-P4", () => {
  assert.equal(priorityForFlow("ERROR_HANDLING").priority, "P0");
  assert.equal(priorityForFlow("SEARCH").priority, "P1");
  assert.equal(priorityForFlow("NAVIGATION").priority, "P2");
  assert.equal(priorityForFlow("PROFILE").priority, "P3");
});

test("normalizeUrl and mergeGraphs treat pathname as page identity and wire edges", () => {
  assert.equal(normalizeUrl("https://qa.test/en?tab=1#x"), "https://qa.test/en");
  const first = report({ scan: { url: "https://qa.test/en", finalUrl: "https://qa.test/en", title: "Home", timestamp: "", durationMs: 1, navigationStatus: 200 }, elements: [element({ tag: "a", role: "link", text: "About", accessibleName: "About", href: "https://qa.test/en/about", recommendedLocator: "page.locator(\"a[href=\\\"https://qa.test/en/about\\\"]\")" })] });
  const second = report({ scan: { url: "https://qa.test/en/about", finalUrl: "https://qa.test/en/about", title: "About", timestamp: "", durationMs: 1, navigationStatus: 200 } });
  const merged = mergeGraphs([buildSiteGraphFromReport("page-1", first), buildSiteGraphFromReport("page-2", second)], limits());
  assert.equal(merged.pages.length, 2);
  const home = merged.pages.find(page => page.id === "page-1");
  const target = merged.pages.find(page => page.url === "https://qa.test/en/about");
  assert.equal(home?.edges[0]?.toPageId, target?.id, "same-origin edge wires to its discovered node");
});

test("analyzeScan attaches a deterministic flowDiscovery with summary counts", async () => {
  const r = report({
    elements: [
      element({ tag: "input", role: "searchbox", type: "search", placeholder: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"searchbox\", { name: \"Search\" })", formIndex: 0 }),
      element({ tag: "button", role: "button", text: "Search", accessibleName: "Search", recommendedLocator: "page.getByRole(\"button\", { name: \"Search\" })", formIndex: 0 }),
    ],
  });
  const analysis = await analyzeScan(r, { flowLimits: limits({ maxFlows: 5 }) });
  assert.ok(analysis.flowDiscovery, "flowDiscovery present");
  assert.ok((analysis?.flowDiscovery?.summary.flows ?? 0) >= 1);
  assert.equal(analysis.summary.flowSummary?.flows, analysis.flowDiscovery?.summary.flows);
  assert.ok(analysis.findings.every(finding => !finding.id.startsWith("FLOW-")), "flow discovery never fabricates findings");
});

// ---------------------------------------------------------------------------
// Real-browser pipeline: hermetic generic site, full DISCOVER -> EXECUTE path.
// ---------------------------------------------------------------------------
test("real chromium: discovered search flow executes PASS and auth flow stops at its boundary", async () => {
  const server = createServer((request, response) => {
    const send = (body: string, status = 200) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    const head = (title: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>`;
    const url = request.url ?? "/";
    if (url === "/") return send(`${head("Generic Home")}<form action="/search"><input type="search" placeholder="Search" name="q"><button type="submit">Search</button></form><a href="/about">About</a><a href="/login">Log in</a><button>العربية</button><a href="/news/1">Read more</a></body></html>`);
    if (url === "/search") return send(`${head("Results")}<p>No matches for your query.</p></body></html>`);
    if (url === "/about") return send(`${head("About")}<p>About this site.</p></body></html>`);
    if (url.startsWith("/login")) return send(`${head("Sign in")}<form action="/login"><input type="text" name="username" placeholder="Username"><input type="password" name="password" placeholder="Password"><button type="submit">Sign in</button></form></body></html>`);
    if (url.startsWith("/news/")) return send(`${head("News")}<p>Article body.</p></body></html>`);
    return send(`<html><body>not found</body></html>`, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-flow-"));

  try {
    // DISCOVER (scan) + flow discovery on the generic fixture.
    const { report: r } = await scanWebsite({ url: base, headed: false, timeout: 15000, outputPath: join(folder, "report.json"), concurrency: 1 });
    const analysis = await analyzeScan(r, { flowLimits: limits({ maxPages: 2, maxFlows: 10 }) });
    const flows = analysis.flowDiscovery?.flows ?? [];
    const searchFlow = flows.find(flow => flow.category === "SEARCH");
    const authFlow = flows.find(flow => flow.category === "AUTHENTICATION");
    assert.ok(searchFlow, "search flow discovered from the live page");
    assert.ok(authFlow, "auth flow discovered from the live page");

    // EXECUTE with a real chromium page.
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const searchRun = await runFlow(page, searchFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
      assert.equal(searchRun.status, "PASS", `search flow should pass: ${JSON.stringify(searchRun.steps.slice(0, 3).map(s => s.outcome))}`);
      const authRun = await runFlow(page, authFlow!, { startTimeoutMs: 15000, elementTimeoutMs: 8000 });
      assert.equal(authRun.status, "BLOCKED", "auth flow stops at the credential boundary");
      assert.ok(authRun.boundary, "boundary reason recorded");
      const typed = authRun.steps.find(step => step.action === "type");
      assert.equal(typed?.outcome, "BLOCKED", "no credential entry executes");
      assert.equal(typed?.category, "SAFETY_BLOCK");
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("crawlSite merges a bounded two-page site graph", async () => {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url === "/a") { response.end('<!doctype html><html lang="en"><head><title>Page A</title></head><body><a href="/b">Go B</a></body></html>'); return; }
    if (url === "/b") { response.end('<!doctype html><html lang="en"><head><title>Page B</title></head><body><p>content</p></body></html>'); return; }
    response.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><a href="/a">A</a></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-crawl-"));
  try {
    const result = await crawlSite({ url: `http://127.0.0.1:${address.port}`, headed: false, timeout: 15000, concurrency: 1, limits: limits({ maxPages: 3, maxDepth: 2 }) });
    assert.ok(result.pages.length >= 2, `crawl should reach at least two pages (got ${result.pages.length})`);
    assert.equal(result.graph.pages.length, result.pages.length);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
    rmSync("reports/crawl", { recursive: true, force: true });
  }
});

test("crawlSite launches one browser for the whole crawl, not one per page", async () => {
  const pages = ["/", "/a", "/b", "/c"];
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url === "/a") { response.end('<!doctype html><html lang="en"><head><title>A</title></head><body><a href="/b">B</a></body></html>'); return; }
    if (url === "/b") { response.end('<!doctype html><html lang="en"><head><title>B</title></head><body><a href="/c">C</a></body></html>'); return; }
    if (url === "/c") { response.end('<!doctype html><html lang="en"><head><title>C</title></head><body><p>end</p></body></html>'); return; }
    response.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><a href="/a">A</a></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const launches: string[] = [];
  const realLaunch = chromium.launch.bind(chromium);
  (chromium as unknown as { launch: typeof chromium.launch }).launch = (async (...args: Parameters<typeof chromium.launch>) => {
    launches.push("launch");
    return realLaunch(...args);
  }) as typeof chromium.launch;

  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-crawl-launch-"));
  try {
    const result = await crawlSite({ url: `http://127.0.0.1:${address.port}`, headed: false, timeout: 15000, concurrency: 1, limits: limits({ maxPages: pages.length, maxDepth: 3 }) });
    assert.ok(result.pages.length >= 4, `crawl should reach all four pages (got ${result.pages.length})`);
    assert.equal(launches.length, 1, `a ${result.pages.length}-page crawl must launch exactly one browser, not one per page`);
  } finally {
    (chromium as unknown as { launch: typeof chromium.launch }).launch = realLaunch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
    rmSync("reports/crawl", { recursive: true, force: true });
  }
});

test("scanPageInContext reuses one context across scans and keeps reports independent", async () => {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url === "/one") { response.end('<!doctype html><html lang="en"><head><title>One</title></head><body><button>One</button></body></html>'); return; }
    if (url === "/two") { response.end('<!doctype html><html lang="en"><head><title>Two</title></head><body><a href="/one">One</a></body></html>'); return; }
    response.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><p>home</p></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-reuse-"));
  try {
    const results = await withScanBrowser(false, async context => {
      const one = await scanPageInContext(context, { url: `http://127.0.0.1:${address.port}/one`, headed: false, timeout: 15000, outputPath: join(folder, "one.json"), concurrency: 1 });
      const two = await scanPageInContext(context, { url: `http://127.0.0.1:${address.port}/two`, headed: false, timeout: 15000, outputPath: join(folder, "two.json"), concurrency: 1 });
      return { one: one.report, two: two.report };
    });
    assert.equal(results.one.scan.title, "One");
    assert.equal(results.two.scan.title, "Two", "the second scan is not polluted by the first page");
    assert.equal(results.one.page.buttons, 1, "the first scan sees its own button");
    assert.equal(results.two.page.buttons, 0, "the second scan does not inherit the first page's elements");
    assert.equal(results.one.scan.url, `http://127.0.0.1:${address.port}/one`);
    assert.equal(results.two.scan.finalUrl, `http://127.0.0.1:${address.port}/two`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a page that crashes mid-scan does not abort the whole crawl", async () => {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (url === "/bad") {
      // Terminate the connection without a response so the navigation fails.
      request.socket.destroy();
      return;
    }
    if (url === "/good") { response.end('<!doctype html><html lang="en"><head><title>Good</title></head><body><p>fine</p></body></html>'); return; }
    response.end('<!doctype html><html lang="en"><head><title>Home</title></head><body><a href="/good">Good</a></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const folder = mkdtempSync(join(tmpdir(), "ai-website-qa-crawl-resilient-"));
  try {
    // /bad is a same-origin link, so the crawl attempts it; the run must still
    // complete and return a graph rather than throwing.
    const result = await crawlSite({ url: `http://127.0.0.1:${address.port}/bad`, headed: false, timeout: 5000, concurrency: 1, limits: limits({ maxPages: 3, maxDepth: 1 }) });
    assert.ok(Array.isArray(result.pages), "a failing page still yields a crawl result");
    assert.ok(result.graph.pages.length >= 1, "the graph records the attempted page");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
    rmSync("reports/crawl", { recursive: true, force: true });
  }
});

test("flowBoundaryReason explains why a step is not executed", () => {
  const reason = flowBoundaryReason({ safety: "HIGH_RISK", automation: "MANUAL", reason: "credential input (password) — never auto-filled" });
  assert.ok(reason.startsWith("Not executable"), reason);
  assert.ok(reason.includes("credential input"), reason);
});

test("summarizeFlows accounts for every execution status", () => {
  const executions = [
    { status: "PASS" },
    { status: "REPRODUCED" },
    { status: "NOT_REPRODUCED" },
    { status: "REVIEW_REQUIRED" },
    { status: "BLOCKED" },
    { status: "BLOCKED" },
    { status: "INFRASTRUCTURE_PROBLEM" },
  ] as FlowExecutionResult[];
  const summary = summarizeFlows([], executions, 1);
  assert.equal(summary.executed, executions.length);
  assert.equal(
    summary.passed + summary.reproduced + summary.notReproduced + summary.reviewRequired + (summary.boundaryBlocked ?? 0) + summary.infrastructure,
    summary.executed,
  );
  assert.equal(summary.boundaryBlocked, 2);
});
