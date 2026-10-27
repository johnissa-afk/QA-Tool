import { Browser, BrowserContext, chromium, Page, Response } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectIssues, groupIssues } from "./checks.js";
import { buildLocator } from "./locators.js";
import { matchesAnyPattern, splitPatterns } from "./glob.js";
import { writeReports } from "./reporter.js";
import { detectAccess } from "./qa/access.js";
import { AuthenticationDiagnostic, ConsoleDiagnostic, DiscoveredElement, Issue, LinkResult, PerformanceMetrics, ScanOptions, ScanReport, WaitUntil } from "./types.js";
import { checkPerfBudgets, loadPerfBudgets } from "./perf-budgets.js";
import { buildScreenshotDiffIssue, diffScreenshots, ScreenshotDiffResult } from "./screenshot-diff.js";
import { checkSecurityHeaders } from "./security-headers.js";

type RawElement = Omit<DiscoveredElement, "recommendedLocator" | "locatorQuality">;
export type AuthenticationConfig = { httpCredentials?: { username: string; password: string }; authorization?: string; diagnostic: Omit<AuthenticationDiagnostic, "accepted"> };

const basicAuthValues = (env: NodeJS.ProcessEnv): { username?: string; password?: string } => ({
  username: env.QA_BASIC_AUTH_USER || env.QA_USERNAME,
  password: env.QA_BASIC_AUTH_PASSWORD || env.QA_PASSWORD,
});

const authenticationConfigOf = (
  credentials: { username: string; password: string } | undefined,
  authorization: string | undefined,
  diagnostic: Omit<AuthenticationDiagnostic, "accepted">,
): AuthenticationConfig => {
  const config = { authorization, diagnostic } as AuthenticationConfig;
  Object.defineProperty(config, "httpCredentials", { value: credentials, enumerable: false });
  return config;
};

/** Builds Playwright context authentication without ever serializing secret values. */
export function getAuthenticationConfig(env: NodeJS.ProcessEnv = process.env): AuthenticationConfig {
  const hasNewUsername = Boolean(env.QA_BASIC_AUTH_USER);
  const hasNewPassword = Boolean(env.QA_BASIC_AUTH_PASSWORD);
  if (hasNewUsername !== hasNewPassword) throw new Error("Basic Auth configuration requires both QA_BASIC_AUTH_USER and QA_BASIC_AUTH_PASSWORD.");
  if (hasNewUsername && hasNewPassword) {
    const authorization = env.QA_AUTHORIZATION;
    const method = authorization ? "basic-and-authorization" : "basic";
    return authenticationConfigOf({ username: env.QA_BASIC_AUTH_USER!, password: env.QA_BASIC_AUTH_PASSWORD! }, authorization, { method, usernamePresent: true, passwordPresent: true, authorizationPresent: Boolean(authorization) });
  }
  const hasLegacyUsername = Boolean(env.QA_USERNAME);
  const hasLegacyPassword = Boolean(env.QA_PASSWORD);
  if (hasLegacyUsername !== hasLegacyPassword) throw new Error("Basic Auth configuration requires both QA_USERNAME and QA_PASSWORD.");
  const { username, password } = basicAuthValues(env);
  const authorization = env.QA_AUTHORIZATION;
  const basicConfigured = Boolean(username && password);
  const authorizationConfigured = Boolean(authorization);
  const method = basicConfigured && authorizationConfigured ? "basic-and-authorization" : basicConfigured ? "basic" : authorizationConfigured ? "authorization" : "none";
  return authenticationConfigOf(basicConfigured && username && password ? { username, password } : undefined, authorization, { method, usernamePresent: Boolean(username), passwordPresent: Boolean(password), authorizationPresent: authorizationConfigured });
}

function classifyConsoleDiagnostic(message: string, source: string | null, siteOrigin: string): ConsoleDiagnostic {
  let sourceOrigin: string | null = null;
  try { sourceOrigin = source ? new URL(source).origin : null; } catch { /* Non-URL source locations are valid. */ }
  const likelyThirdParty = Boolean(sourceOrigin && sourceOrigin !== siteOrigin) || /firebase|google[ -]?analytics|googletagmanager|doubleclick|sentry/i.test(`${source ?? ""} ${message}`);
  if (likelyThirdParty) return { message, source, category: "third-party", status: "INFO" };
  if (/net::ERR_|failed to (load resource|fetch)|networkerror|fetch failed/i.test(message)) return { message, source, category: "network", status: "WARNING" };
  return { message, source, category: "first-party", status: "WARNING" };
}

async function checkLink(url: string): Promise<LinkResult> {
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if ([405, 501].includes(response.status)) response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const status = response.status;
    const type: LinkResult["type"] = status < 300 ? "OK" : status < 400 ? "REDIRECT" : [401, 403].includes(status) ? "RESTRICTED" : status >= 400 ? "BROKEN" : "ERROR";
    return { url, status, type };
  } catch (error) { return { url, status: null, type: "ERROR", error: error instanceof Error ? error.message : "Unknown error" }; }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, action: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (index < items.length) { const current = index++; results[current] = await action(items[current]); }
  }));
  return results;
}

async function collectElements(page: Page): Promise<RawElement[]> {
  return page.locator("button,a,input,textarea,select,img,form,nav,[role=dialog],video,audio").evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLElement;
    const input = node as HTMLInputElement;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const forms = Array.from(document.querySelectorAll("form"));
    const owningForm = tag !== "form" ? element.closest("form") : null;
    const formIndex = owningForm ? forms.indexOf(owningForm as HTMLFormElement) : tag === "form" ? forms.indexOf(element as HTMLFormElement) : null;
    const implicitRoles: Record<string, string> = { button: "button", a: "link", select: "combobox", textarea: "textbox", img: "img", nav: "navigation", form: "form", video: "video", audio: "audio" };
    const type = tag === "input" ? (input.type || "text") : null;
    const role = element.getAttribute("role") || (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", password: "textbox", search: "searchbox" }[type ?? ""] || "textbox") : implicitRoles[tag] || null);
    const labelId = element.getAttribute("aria-labelledby");
    const labelled = labelId ? labelId.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ") : "";
    const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() : "";
    const text = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
    const ariaLabel = element.getAttribute("aria-label");
    const accessibleName = ariaLabel || labelled || label || (tag === "img" ? (element as HTMLImageElement).alt : "") || text || element.getAttribute("title") || null;
    const interactive = ["button", "a", "input", "textarea", "select"].includes(tag) || ["button", "link", "checkbox", "radio", "textbox", "combobox", "searchbox"].includes(role ?? "");
    return { tag, role, text, ariaLabel, placeholder: input.placeholder || null, name: input.name || element.getAttribute("name"), id: element.id || null, testId: element.getAttribute("data-testid"), type, hasExplicitType: tag !== "input" || element.hasAttribute("type"), autocomplete: element.getAttribute("autocomplete"), href: tag === "a" ? (node as HTMLAnchorElement).href || null : null, alt: tag === "img" ? (node as HTMLImageElement).getAttribute("alt") : null, visible: style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0, enabled: !(input.disabled || element.getAttribute("aria-disabled") === "true"), boundingBox: box.width || box.height ? { x: box.x, y: box.y, width: box.width, height: box.height } : null, interactive, accessibleName, formIndex };
  }));
}

type NavigationResult = { response: Response | null; retryAttempts: number };

/** Applies network throttling via the Chrome DevTools Protocol (Chromium only). */
async function applyThrottle(page: Page, kbps: number): Promise<void> {
  if (kbps <= 0) return;
  const bytesPerSecond = Math.ceil((kbps * 1024) / 8);
  try {
    const client = await page.context().newCDPSession(page);
    await client.send("Network.enable");
    await client.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: bytesPerSecond, uploadThroughput: bytesPerSecond, latency: 0, connectionType: "other" });
  } catch { /* Throttling is best-effort; ignore if CDP is unavailable (e.g. non-Chromium). */ }
}

/** Navigates with retry: retries only on thrown navigation errors, not HTTP status codes. */
async function navigateWithRetry(page: Page, url: string, timeout: number, waitUntil: WaitUntil, retries: number): Promise<NavigationResult> {
  let response: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      response = await page.goto(url, { waitUntil, timeout });
      return { response, retryAttempts: attempt };
    } catch (error) {
      if (attempt === retries) throw error;
      await page.waitForTimeout(500);
    }
  }
  return { response: null, retryAttempts: retries };
}

/** Collects core Web Vitals + navigation timing via the browser's Performance API. */
async function collectMetrics(page: Page): Promise<PerformanceMetrics> {
  try {
    return await page.evaluate(() => new Promise<PerformanceMetrics>(resolve => {
      const navEntries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      const nav = navEntries[0];
      const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
      const clsEntries = performance.getEntriesByType("layout-shift");
      const paintEntries = performance.getEntriesByType("paint");
      const fcpEntry = paintEntries.find(e => e.name === "first-contentful-paint");
      let cls = 0;
      for (const entry of clsEntries as unknown as Array<{ value: number }>) {
        cls += entry.value;
      }
      const navStart = nav ? nav.startTime : 0;
      const snapshot = {
        ttfb: nav ? nav.responseStart - navStart : null,
        fcp: fcpEntry ? fcpEntry.startTime : null,
        lcp: lcpEntries.length > 0 ? (lcpEntries[lcpEntries.length - 1] as unknown as { startTime: number }).startTime : null,
        cls: cls > 0 ? cls : null,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd - navStart : null,
        loadEvent: nav ? nav.loadEventEnd - navStart : null,
      };
      if (snapshot.lcp !== null) return resolve(snapshot);

      // Chromium does not publish Largest Contentful Paint entries to the
      // passive timeline, so `getEntriesByType` above always returns [] and LCP
      // would be reported as null forever — which silently disables every LCP
      // performance budget. A buffered PerformanceObserver replays those
      // entries; if the page produced no LCP candidate the fallback timer keeps
      // the honest null.
      try {
        let observer: PerformanceObserver;
        observer = new PerformanceObserver(list => {
          const entries = list.getEntries() as unknown as Array<{ startTime: number }>;
          if (entries.length === 0) return;
          observer.disconnect();
          resolve({ ...snapshot, lcp: entries[entries.length - 1].startTime });
        });
        observer.observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => { observer.disconnect(); resolve(snapshot); }, 300);
      } catch {
        resolve(snapshot);
      }
    }));
  } catch {
    return { ttfb: null, fcp: null, lcp: null, cls: null, domContentLoaded: null, loadEvent: null };
  }
}

/**
 * Scans one URL in an EXISTING browser context. The caller owns the browser and
 * context lifecycle, so a crawl can reuse one browser across many pages instead
 * of paying a cold `chromium.launch()` per page. Each scan still gets its own
 * page and its own console/error listeners, so reports stay independent.
 */
export async function scanPageInContext(context: BrowserContext, options: ScanOptions): Promise<{ report: ScanReport; jsonPath: string; htmlPath: string }> {
  const started = Date.now();
  const authentication = getAuthenticationConfig();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const consoleDiagnostics: ConsoleDiagnostic[] = [];
  const pageErrors: string[] = [];
    const siteOrigin = new URL(options.url).origin;
    const followExternal = options.followExternal ?? false;
    const includeGlobs = options.includePatterns ? splitPatterns(options.includePatterns) : undefined;
    const excludeGlobs = options.excludePatterns ? splitPatterns(options.excludePatterns) : undefined;
  page.on("console", message => {
    if (message.type() !== "error") return;
    const source = message.location().url || null;
    const text = message.text();
    consoleErrors.push(`${text} (${source || "unknown source"})`);
    consoleDiagnostics.push(classifyConsoleDiagnostic(text, source, siteOrigin));
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    const waitUntil: WaitUntil = options.waitUntil ?? "domcontentloaded";
    const retries = options.retries ?? 0;
    const throttleKbps = options.throttleKbps ?? 0;
    await applyThrottle(page, throttleKbps);
    const { response, retryAttempts } = await navigateWithRetry(page, options.url, options.timeout, waitUntil, retries);
    await page.waitForTimeout(500);
    const metrics = await collectMetrics(page);
    // Captured once, before the page is closed in the `finally` below.
    const finalUrl = page.url();
    const access = detectAccess({ url: options.url, finalUrl, httpStatus: response?.status() ?? null, headers: response?.headers() ?? {}, body: await page.content().catch(() => "") });
    const accessPrerequisite = !access.continueScan
      ? {
          type: access.accessStatus,
          status: (access.accessStatus === "access-blocked" ? "BLOCKED" : "REVIEW_REQUIRED") as "BLOCKED" | "REVIEW_REQUIRED",
          message: access.reason,
          httpStatus: access.httpStatus,
          challenge: access.challenge,
        }
      : undefined;

    if (!access.continueScan) {
      const report: ScanReport = {
        scan: { url: options.url, finalUrl, title: "", timestamp: new Date().toISOString(), durationMs: Date.now() - started, navigationStatus: response?.status(), retryAttempts, waitUntil, throttleKbps: throttleKbps > 0 ? throttleKbps : undefined, includePatterns: options.includePatterns, excludePatterns: options.excludePatterns, followExternal },
        authentication: { ...authentication.diagnostic, accepted: false },
        access,
        accessPrerequisite,
        summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
        page: { language: null, viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
        performance: metrics,
        elements: [], issues: [], links: [], consoleErrors, consoleDiagnostics, pageErrors,
      };
      const paths = writeReports(report, options.outputPath);
      return { report, ...paths };
    }
    const rawElements = await collectElements(page);
    const elements = rawElements.map(element => ({ ...element, ...buildLocator(element) }));
    // Read optional document metadata directly. Locator getters wait for a matching
    // element, which is undesirable for valid pages that omit a viewport tag.
    const [title, metadata] = await Promise.all([
      page.title(),
      page.evaluate(() => ({
        language: document.documentElement?.getAttribute("lang") ?? null,
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
        headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(node => ({
          level: Number(node.tagName.substring(1)),
          text: ((node as HTMLElement).textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
        })),
      })),
    ]);
    const { language, viewport, headings } = metadata;
    const issues = detectIssues(elements, { title, lang: language, viewport, headings });
    const navigationStatus = response?.status();
    if (navigationStatus === 401) issues.push({ status: "FAIL", code: "authentication-failed", message: "Navigation returned HTTP 401. HTTP Basic Authentication was not accepted or is not configured." });
    else if (navigationStatus && navigationStatus >= 400) issues.push({ status: "FAIL", code: "page-http-error", message: `Page navigation returned HTTP ${navigationStatus}.` });
    else issues.push({ status: "PASS", code: "page-scanned", message: "Page loaded and element discovery completed." });
    if (response && navigationStatus && navigationStatus < 400) {
      issues.push(...checkSecurityHeaders(response.headers(), finalUrl));
    }
    const allLinks = [...new Set(elements.map(element => element.href).filter((href): href is string => Boolean(href && href.startsWith("http"))))];
    const filteredLinks = allLinks.filter(link => {
      const linkOrigin = new URL(link).origin;
      if (!followExternal && linkOrigin !== siteOrigin) return false;
      if (includeGlobs && !matchesAnyPattern(link, includeGlobs)) return false;
      if (excludeGlobs && matchesAnyPattern(link, excludeGlobs)) return false;
      return true;
    });
    const linkResults = await mapConcurrent(filteredLinks, options.concurrency, checkLink);
    for (const link of linkResults.filter(link => link.type === "BROKEN" || link.type === "ERROR")) issues.push({ status: link.type === "BROKEN" ? "FAIL" : "WARNING", code: "unhealthy-link", message: `${link.url} returned ${link.status ?? link.error ?? "an error"}.` });
    for (const diagnostic of consoleDiagnostics) {
      const message = diagnostic.category === "third-party" ? "Third-party console or resource error observed." : diagnostic.category === "network" ? "Network or resource error observed." : "First-party console error detected.";
      issues.push({ status: diagnostic.status, code: `console-${diagnostic.category}-error`, message, examples: [{ detail: `${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source})` : ""}` }] });
    }
    for (const error of pageErrors) issues.push({ status: "WARNING", code: "page-error", message: "Uncaught page error detected.", examples: [{ detail: error }] });
    if (options.perfBudgetsPath) {
      const budgets = loadPerfBudgets(resolve(options.perfBudgetsPath));
      if (budgets) issues.push(...checkPerfBudgets(metrics, budgets));
    }
    let screenshotPath: string | undefined;
    let screenshotDiff: { diffPixels: number; totalPixels: number; diffPercentage: number; threshold: number } | undefined;
    try {
      const directory = join(dirname(resolve(options.outputPath)), "screenshots");
      mkdirSync(directory, { recursive: true });
      screenshotPath = join(directory, `scan-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      writeFileSync(screenshotPath, screenshotBuffer);
    } catch (error) { issues.push({ status: "INFO", code: "screenshot-unavailable", message: `Screenshot could not be captured: ${error instanceof Error ? error.message : "unknown error"}` }); }
    if (options.baselineScreenshotPath && screenshotPath) {
      try {
        const baselineBuffer = readFileSync(resolve(options.baselineScreenshotPath));
        const result: ScreenshotDiffResult = await diffScreenshots(page, readFileSync(screenshotPath), baselineBuffer);
        screenshotDiff = { ...result, threshold: options.screenshotThreshold ?? 0.1 };
        const diffIssue = buildScreenshotDiffIssue(result, options.screenshotThreshold ?? 0.1);
        if (diffIssue) issues.push(diffIssue);
      } catch (error) { issues.push({ status: "WARNING", code: "screenshot-diff-error", message: `Screenshot diff could not be performed: ${error instanceof Error ? error.message : "unknown error"}` }); }
    }
    const groupedIssues = groupIssues(issues);
    const count = (tag: string) => elements.filter(element => element.tag === tag).length;
    const occurrenceCount = (status: "PASS" | "WARNING" | "FAIL" | "INFO") => groupedIssues.filter(issue => issue.status === status).reduce((total, issue) => total + (issue.count ?? 1), 0);
    const groupCount = (status: "PASS" | "WARNING" | "FAIL" | "INFO") => groupedIssues.filter(issue => issue.status === status).length;
    const report: ScanReport = { scan: { url: options.url, finalUrl: finalUrl, title, timestamp: new Date().toISOString(), durationMs: Date.now() - started, screenshotPath, navigationStatus, retryAttempts, waitUntil, throttleKbps: throttleKbps > 0 ? throttleKbps : undefined, includePatterns: options.includePatterns, excludePatterns: options.excludePatterns, followExternal, baselineScreenshot: screenshotDiff }, authentication: { ...authentication.diagnostic, accepted: navigationStatus ? navigationStatus < 400 : null }, access, summary: { totalElements: elements.length, interactiveElements: elements.filter(element => element.interactive).length, passes: occurrenceCount("PASS"), warnings: occurrenceCount("WARNING"), failures: occurrenceCount("FAIL"), infos: occurrenceCount("INFO"), linksChecked: linkResults.length, brokenLinks: linkResults.filter(link => link.type === "BROKEN").length, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, issueGroups: groupedIssues.length, groupedIssueCounts: { passes: groupCount("PASS"), warnings: groupCount("WARNING"), failures: groupCount("FAIL"), infos: groupCount("INFO") } }, page: { language, viewport, forms: count("form"), images: count("img"), links: count("a"), buttons: count("button"), inputs: count("input"), textareas: count("textarea"), selects: count("select"), dialogs: elements.filter(element => element.role === "dialog").length, media: count("video") + count("audio") }, performance: metrics, elements, issues: groupedIssues, links: linkResults, consoleErrors, consoleDiagnostics, pageErrors };
    const paths = writeReports(report, options.outputPath);
    return { report, ...paths };
  } finally { await page.close().catch(() => undefined); }
}

/**
 * Single-page scan: launches a browser, scans, and tears everything down.
 * Prefer `withScanBrowser` when scanning more than one page.
 */
export async function scanWebsite(options: ScanOptions): Promise<{ report: ScanReport; jsonPath: string; htmlPath: string }> {
  return withScanBrowser(options.headed, async context => scanPageInContext(context, options));
}

/**
 * Runs `work` against a freshly launched browser context, then always closes
 * both. One browser launch is shared by every scan in `work`, so a crawl of N
 * pages costs one cold start instead of N.
 */
export async function withScanBrowser<T>(headed: boolean, work: (context: BrowserContext) => Promise<T>): Promise<T> {
  const authentication = getAuthenticationConfig();
  const browser: Browser = await chromium.launch({ headless: !headed });
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ httpCredentials: authentication.httpCredentials, extraHTTPHeaders: authentication.authorization ? { Authorization: authentication.authorization } : undefined });
    return await work(context);
  } finally {
    if (context) await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
