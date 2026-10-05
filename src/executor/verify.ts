import { Locator, Page } from "@playwright/test";
import {
  FailureCategory,
  TriageResult,
  VerificationEvidence,
  VerificationError,
  VerificationResult,
  VerificationStatus,
  VerificationStrategy,
} from "../ai/types.js";
import { buildRedactor } from "./redact.js";
import { isPageLevelStrategy, VerificationTask } from "./tasks.js";

// ---------------------------------------------------------------------------
// Safe verification executor.
//
// Every strategy re-checks a suspected problem on the live page WITHOUT
// clicking, typing, paying, or navigating beyond the initial page load. The
// evidence and the verdict are deterministic, and every outcome is written to a
// serializable VerificationResult (values redacted; no input values, cookies,
// or tokens are ever captured).
// ---------------------------------------------------------------------------
export type VerifyOptions = {
  targetUrl: string;
  /** Directory where REPRODUCED / REVIEW screenshots are stored. */
  screenshotDir?: string;
  gotoTimeoutMs?: number;
  elementTimeoutMs?: number;
};

export type Probe = {
  count: number;
  tag: string | null;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  href: string | null;
  id: string | null;
  visible: boolean | null;
  enabled: boolean | null;
  alt: string | null;
  attributes: Record<string, string> | null;
};

let redact = buildRedactor(process.env);
export function refreshVerificationRedactor(env: NodeJS.ProcessEnv = process.env): void {
  redact = buildRedactor(env);
}

const SENSITIVE_ATTRIBUTES = new Set(["value", "autocomplete", "password", "token", "api_key", "apikey", "authorization", "cookie", "set-cookie", "datasecret"]);

// Defense-in-depth: even if a probe slips a sensitive attribute through, it is
// stripped and redacted again at evidence-assembly time.
function safeAttributes(attributes: Record<string, string> | null): Record<string, string> | null {
  if (!attributes) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SENSITIVE_ATTRIBUTES.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith("data-token")) continue;
    out[key] = redact(value);
  }
  return out;
}

const PROBE_SOURCE = `(el) => {
  const trim = (v) => ((v || "") + "").trim().replace(/\\s+/g, " ");
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const ariaLabel = el.getAttribute("aria-label");
  let accessibleName = null;
  if (ariaLabel && trim(ariaLabel)) accessibleName = ariaLabel;
  else {
    let found = "";
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      found = labelledBy.split(/\\s+/).map((id) => { const n = el.ownerDocument.getElementById(id); return n ? trim(n.textContent) : ""; }).filter(Boolean).join(" ");
    }
    if (!trim(found) && el.id) {
      const labeled = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (labeled) found = trim(labeled.textContent);
    }
    if (!trim(found)) {
      const wrapping = el.closest("label");
      if (wrapping) found = trim(wrapping.textContent);
    }
    if (!trim(found) && el.tagName === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt && trim(alt)) found = alt;
    }
    if (!trim(found)) found = trim(el.textContent);
    if (!trim(found)) {
      const title = el.getAttribute("title");
      if (title) found = title;
    }
    accessibleName = trim(found) || null;
  }
  return {
    count: 0,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
    accessibleName,
    text: trim(el.textContent).slice(0, 200) || null,
    href: el instanceof HTMLAnchorElement ? (el.href || null) : null,
    id: el.id || null,
    enabled: !(el instanceof HTMLInputElement && el.disabled) && el.getAttribute("aria-disabled") !== "true",
    alt: el instanceof HTMLImageElement ? el.getAttribute("alt") : null,
    attributes: Array.from(el.attributes).reduce((out, attr) => {
      if (attr.name === "value" || attr.name === "autocomplete") return out;
      out[attr.name] = attr.value;
      return out;
    }, {}),
  };
}`;

const probeFunction = new Function(`return (${PROBE_SOURCE});`)() as (element: never) => Probe;

export function locatorFromExpr(page: Page, expr: string): Locator {
  const match = expr.match(/^page\.(getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|locator)\((.*)\)$/);
  if (!match) throw new Error(`Unsupported locator expression: ${expr}`);
  const method = match[1];
  // buildLocator emits option objects with unquoted keys ({ name: ... }), so
  // quote them before wrapping the argument list as JSON.
  const normalized = match[2]
    .replace(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, (_, key) => `{"${key}":`)
    .replace(/,\s*(\})\s*$/, "$1");
  const args = JSON.parse(`[${normalized}]`) as unknown[];
  switch (method) {
    case "getByRole": {
      const role = String(args[0]);
      const options = (args[1] ?? {}) as { name?: string };
      return page.getByRole(role as Parameters<Page["getByRole"]>[0], { name: options.name ?? "" });
    }
    case "getByLabel":
      return page.getByLabel(String(args[0]));
    case "getByPlaceholder":
      return page.getByPlaceholder(String(args[0]));
    case "getByText": {
      const options = (args[1] ?? {}) as { exact?: boolean };
      return page.getByText(String(args[0]), { exact: options.exact === true });
    }
    case "getByTestId":
      return page.getByTestId(String(args[0]));
    case "locator":
      return page.locator(String(args[0]));
    default:
      throw new Error(`Unsupported locator method: ${method}`);
  }
}

export async function probeElements(page: Page, locatorExpr: string, timeoutMs?: number): Promise<Probe[]> {
  const locator = locatorFromExpr(page, locatorExpr);
  const count = await locator.count();
  if (count === 0) return [];
  const first = await locator.first().evaluate(probeFunction, undefined, { timeout: timeoutMs ?? 5000 });
  return [{ ...first, count }];
}

export function classifyError(error: unknown): { status: VerificationStatus; category: FailureCategory; error: VerificationError } {
  const message = String(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();
  const redactedMessage = redact(message).slice(0, 1000);

  if (/(?:^|\D)4\d\d(?:$|\D)/.test(message) && /http status|net::|response|status/i.test(lower)) {
    return { status: "REVIEW", category: "AUTHENTICATION", error: { type: "AUTH_FAILED", message: redactedMessage } };
  }
  if (/net::|timeout|timed out|dns|getaddrinfo|certificate|ssl|tunnel|connection refus|econn|related document|navigation aborted/i.test(lower) || /target closed|browser has disconnected|execution context was destroyed|page crashed/i.test(lower)) {
    return { status: "REVIEW", category: "INFRASTRUCTURE", error: { type: "NETWORK", message: redactedMessage } };
  }
  if (/strict mode violation|resolved to \d+ elements/i.test(lower)) {
    return { status: "REVIEW", category: "LOCATOR", error: { type: "AMBIGUOUS_LOCATOR", message: redactedMessage } };
  }
  if (/not found|waiting for|did not find|no element/i.test(lower)) {
    return { status: "NOT_REPRODUCED", category: "LOCATOR", error: { type: "ELEMENT_NOT_FOUND", message: redactedMessage } };
  }
  return { status: "REVIEW", category: "REVIEW", error: { type: "UNKNOWN", message: redactedMessage } };
}

function strategyVerdict(strategy: VerificationStrategy, probe: Probe | null): { status: VerificationStatus; category: FailureCategory | null } {
  if (probe === null) return { status: "NOT_REPRODUCED", category: "LOCATOR" };
  const hidden = probe.visible === false;

  switch (strategy) {
    case "accessible-name":
      if (probe.accessibleName) return { status: "PASS", category: "EXPECTATION" };
      if (hidden) return { status: "NOT_REPRODUCED", category: "CONDITIONAL" };
      return { status: "REPRODUCED", category: "WEBSITE" };
    case "image-alt": {
      const decorative = probe.role === "presentation" || probe.role === "none" || (probe.alt !== null && probe.alt.trim() === "");
      if (probe.alt !== null && probe.alt.trim() !== "") return { status: "PASS", category: "EXPECTATION" };
      if (decorative) return { status: "PASS", category: "EXPECTATION" };
      if (hidden) return { status: "NOT_REPRODUCED", category: "CONDITIONAL" };
      return { status: "REPRODUCED", category: "WEBSITE" };
    }
    case "duplicate-id":
      if ((probe.count ?? 0) > 1) return { status: "REPRODUCED", category: "WEBSITE" };
      return { status: "PASS", category: "EXPECTATION" };
    case "empty-link":
      // Scanner resolves href via the DOM property, so href="#"/"" resolves to
      // the current URL and is NOT an empty link; only a truly missing href is.
      if (probe.href) return { status: "PASS", category: "EXPECTATION" };
      if (hidden) return { status: "NOT_REPRODUCED", category: "CONDITIONAL" };
      return { status: "REPRODUCED", category: "WEBSITE" };
    case "input-type":
      if (probe.attributes?.type) return { status: "PASS", category: "EXPECTATION" };
      if (hidden) return { status: "NOT_REPRODUCED", category: "CONDITIONAL" };
      return { status: "REPRODUCED", category: "WEBSITE" };
    case "visibility":
      // A hidden interactive control is a conditional pattern (responsive/menu
      // clones), never a confirmed defect; a now-visible element means the
      // scanner's "hidden" signal did not reproduce.
      if (hidden) return { status: "NOT_REPRODUCED", category: "CONDITIONAL" };
      if (probe.visible === true) return { status: "PASS", category: "EXPECTATION" };
      return { status: "REVIEW", category: "REVIEW" };
    default:
      return { status: "REVIEW", category: "REVIEW" };
  }
}

export function triageOutcome(result: {
  status: VerificationStatus;
  category: FailureCategory | null;
  strategy: VerificationStrategy;
  locator: string | null;
  evidence: VerificationEvidence;
  error: VerificationError | null;
}): TriageResult {
  const { status, category, strategy, locator, evidence, error } = result;
  if (category === "INFRASTRUCTURE") {
    return { verdict: "INFRASTRUCTURE_PROBLEM", reason: `The check could not reach or render the page reliably (${error?.message ?? "unknown runner failure"}). This is not evidence about the website.`, confidence: "high", provider: "deterministic" };
  }
  if (category === "AUTHENTICATION") {
    return { verdict: "REVIEW_REQUIRED", reason: "The page rejected the verification session (authentication required). The finding could not be confirmed or ruled out.", confidence: "high", provider: "deterministic" };
  }
  if (status === "REPRODUCED") {
    return { verdict: "LIKELY_DEFECT", reason: `The live DOM matches the suspected ${strategy} problem${locator ? ` at ${locator}` : ""}, so the scanner's signal reproduces on the running page.`, confidence: evidence.visible ? "high" : "medium", provider: "deterministic" };
  }
  if (category === "LOCATOR") {
    return { verdict: "NOT_REPRODUCED", reason: "The exact element the scanner flagged could not be located on the live page (it may be conditional, renamed, or already fixed).", confidence: "medium", provider: "deterministic" };
  }
  if (category === "CONDITIONAL") {
    return { verdict: "CONDITIONAL", reason: "Only a hidden or state-dependent instance of the element is present, so the suspected problem does not affect the rendered page.", confidence: "medium", provider: "deterministic" };
  }
  if (status === "PASS") {
    return { verdict: "NOT_REPRODUCED", reason: "The element is present on the live page but does not exhibit the suspected problem — the scanner's signal did not reproduce.", confidence: "high", provider: "deterministic" };
  }
  return { verdict: "REVIEW_REQUIRED", reason: "The outcome needs human review before it is treated as a defect.", confidence: "medium", provider: "deterministic" };
}

export async function runVerification(page: Page, task: VerificationTask, options: VerifyOptions): Promise<VerificationResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const evidence: VerificationEvidence = {
    located: false,
    locator: task.locator,
    tag: null,
    role: null,
    accessibleName: null,
    text: null,
    visible: null,
    enabled: null,
    href: null,
    url: null,
    id: null,
    attributes: null,
    count: null,
    screenshotPath: null,
  };

  let status: VerificationStatus = "REVIEW";
  let category: FailureCategory | null = null;
  let error: VerificationError | null = null;

  try {
    await page.goto(options.targetUrl, { waitUntil: "domcontentloaded", timeout: options.gotoTimeoutMs ?? 30000 });
    evidence.url = page.url();

    if (isPageLevelStrategy(task.strategy)) {
      if (task.strategy === "document-title") {
        const title = await page.title();
        if (title.trim()) {
          status = "PASS"; category = "EXPECTATION";
        } else {
          status = "REPRODUCED"; category = "WEBSITE";
        }
      } else if (task.strategy === "language") {
        const lang = await page.evaluate(() => (document.documentElement.getAttribute("lang") ?? "").trim());
        if (lang) { status = "PASS"; category = "EXPECTATION"; }
        else { status = "REPRODUCED"; category = "WEBSITE"; }
      } else if (task.strategy === "viewport") {
        const meta = await page.evaluate(() => {
          const found = document.querySelector('meta[name="viewport"]');
          return found ? (found.getAttribute("content") ?? "").trim() : "";
        });
        if (meta) { status = "PASS"; category = "EXPECTATION"; }
        else { status = "REPRODUCED"; category = "WEBSITE"; }
      }
    } else {
      const probes = task.locator ? await probeElements(page, task.locator, options.elementTimeoutMs) : [];
      const probe = probes[0] ?? null;
      if (probe) {
        evidence.located = true;
        evidence.count = probe.count;
        evidence.tag = probe.tag;
        evidence.role = probe.role;
        evidence.accessibleName = probe.accessibleName;
        evidence.text = redact(probe.text ?? "");
        evidence.visible = probe.visible;
        evidence.enabled = probe.enabled;
        evidence.href = redact(probe.href ?? "");
        evidence.id = probe.id;
        evidence.attributes = safeAttributes(probe.attributes);
      }
      const verdict = strategyVerdict(task.strategy, probe);
      status = verdict.status;
      category = verdict.category;
    }

    if (status === "REPRODUCED" || status === "REVIEW") {
      const screenshotPath = await captureScreenshot(page, options.screenshotDir, task.scenarioId);
      if (screenshotPath) evidence.screenshotPath = screenshotPath;
    }
  } catch (caught) {
    const classified = classifyError(caught);
    status = classified.status;
    category = classified.category;
    error = classified.error;
  }

  const result: VerificationResult = {
    findingId: task.findingId,
    scenarioId: task.scenarioId,
    strategy: task.strategy,
    locator: task.locator,
    status,
    category,
    executedAt: startedAt,
    durationMs: Date.now() - started,
    expectation: task.expectation,
    evidence,
    error,
    triage: triageOutcome({
      status,
      category,
      strategy: task.strategy,
      locator: task.locator,
      evidence,
      error,
    }),
  };
  return result;
}

async function captureScreenshot(page: Page, screenshotDir: string | undefined, scenarioId: string): Promise<string | null> {
  if (!screenshotDir) return null;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), screenshotDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenarioId}.png`);
  try {
    const buffer = await page.screenshot({ type: "png" });
    writeFileSync(file, buffer);
    return file;
  } catch {
    return null;
  }
}