import { createHash } from "node:crypto";
import type { QaAnalysis, QaFinding } from "../ai/types.js";
import type { CoverageItem, TestPlanRecommendation } from "../coverage/types.js";
import type { DiscoveredFlow, FlowStep } from "../flow/types.js";
import type { DiscoveredElement } from "../types.js";
import type { RegressionCompareOptions, RunIdentity } from "./types.js";

// ---------------------------------------------------------------------------
// Identity is SEMANTIC, never regenerated: finding ids (QA-F-*), flow ids
// (FLOW-*), coverage ids (COV-*), scenario ids (SC-*), page ids (PAGE-*), and
// element indices are run-local. Two runs are matched on code + normalized
// page identity + semantic target + normalized locator/evidence + occurrence
// identity. A locator/selector or element-id change alone is never a change.
// ---------------------------------------------------------------------------

const hash = (input: string): string => createHash("sha1").update(input).digest("hex");

export const normalizeText = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/["'`]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 160);

/** Normalized page identity. Strips the fragment, default ports and trailing
 *  slashes (never the host root), lowercases the host, and sorts query keys.
 *  Meaningful query parameters are PRESERVED; only explicitly proven-volatile
 *  keys (via `ignoreQueryKeys`) are dropped. */
export function normalizePageUrl(url: string, ignoreQueryKeys: string[] = []): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const ignored = new Set(ignoreQueryKeys);
    const sorted = [...parsed.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let query = "";
    for (const [key, value] of sorted) {
      if (ignored.has(key)) continue;
      query += (query ? "&" : "?") + `${key}=${value}`;
    }
    let path = parsed.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (path === "") path = "/";
    const port = parsed.port && !["80", "443"].includes(parsed.port) ? `:${parsed.port}` : "";
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}${query}`
      : url;
  } catch {
    return normalizeText(url);
  }
}

const opts = (options?: RegressionCompareOptions): string[] => options?.ignoreQueryKeys ?? [];

/** Stable semantic identity of an element. Excludes run-local element indices
 *  AND element id/test-id attributes: a regenerated DOM id is not evidence of
 *  a change. */
export function elementSemanticKey(element: DiscoveredElement): string {
  return [
    element.tag,
    element.role ?? "",
    element.type ?? "",
    element.href ?? "",
    element.accessibleName ?? "",
    element.name ?? "",
    element.placeholder ?? "",
    normalizeText(element.text).slice(0, 80),
  ]
    .map(part => normalizeText(part))
    .join("|");
}

/** Coarse family anchor (tag+role+href) used to detect AMBIGUOUS identity:
 *  a baseline finding that disappears while a same-page, same-code finding
 *  with the same family but different text/locator appears. */
export function elementFamilyKey(element: DiscoveredElement): string {
  return [element.tag, element.role ?? "", element.href ?? ""].map(part => normalizeText(part)).join("|");
}

export type FindingSignature = {
  page: string;
  key: string;
  family: string;
};

export function findingSignature(
  finding: QaFinding,
  pageUrl: string,
  elements: DiscoveredElement[],
  options?: RegressionCompareOptions,
): FindingSignature {
  const page = normalizePageUrl(pageUrl, opts(options));
  const ref = finding.evidence.find(item => item.type === "element");
  let elementKey = "";
  let family = "";
  if (ref && ref.index != null && ref.index >= 0 && elements[ref.index]) {
    elementKey = elementSemanticKey(elements[ref.index]!);
    family = elementFamilyKey(elements[ref.index]!);
  } else if (ref?.locator) {
    elementKey = `locator:${normalizeText(ref.locator)}`;
  } else {
    elementKey = `page:${normalizeText(finding.title)}|${normalizeText(finding.description).slice(0, 80)}`;
  }
  return { page, key: `${finding.code}|${page}|${elementKey}`, family };
}

const optionsOf = (options?: RegressionCompareOptions): string[] => opts(options);

/** Semantic step identity: action + meaningful target. Locator/safety/automation
 *  changes alone never change a flow. */
export function flowStepKey(step: FlowStep, options?: RegressionCompareOptions): string {
  let target = step.targetUrl ? normalizePageUrl(step.targetUrl, optionsOf(options)) : "";
  if (!target && step.action === "type") target = normalizeText(step.text ?? "");
  if (!target && step.action !== "open") target = normalizeText(step.expected ?? "");
  return `${step.action}:${target}`;
}

/** Flow semantic identity: category + normalized start page + the step
 *  sequence's meaningful targets. A regenerated flow id or a locator change is
 *  never a flow change. */
export function flowSignature(flow: DiscoveredFlow, options?: RegressionCompareOptions): string {
  const start = normalizePageUrl(flow.startUrl, optionsOf(options));
  const steps = flow.steps.map(step => flowStepKey(step, options)).join(">");
  return `${flow.category}|${start}|${steps}`;
}

/** Loose flow identity: category + normalized start page (steps may have
 *  changed). Used to pair a flow whose step sequence changed. */
export function flowFamilyKey(flow: DiscoveredFlow, options?: RegressionCompareOptions): string {
  return `${flow.category}|${normalizePageUrl(flow.startUrl, optionsOf(options))}`;
}

export function coverageItemSignature(item: CoverageItem, options?: RegressionCompareOptions): string {
  const location = item.url ? normalizePageUrl(item.url, optionsOf(options)) : item.pageId ?? "";
  return `${item.category}|${location}|${normalizeText(item.name)}`;
}

export function recommendationSignature(rec: TestPlanRecommendation): string {
  const targets = [...rec.coverageIds].sort().join(",");
  return `${rec.type}|${normalizeText(rec.title)}|${targets}`;
}

/** Comparison-relevant configuration digest: origin + mode + whether a
 *  verification/execution layer ran + whether the run had a coverage crawl.
 *  Runs with different digests are not comparably layered. */
export function configDigestOf(analysis: QaAnalysis): string {
  const origin = originOf(analysis.scan.scan.url);
  const executed =
    analysis.execution !== null ||
    (analysis.flowDiscovery?.executions.length ?? 0) > 0 ||
    analysis.verifications.length > 0;
  const crawled = analysis.coverage !== null;
  return hash(`${origin}|${analysis.mode}|${executed ? "execute" : "no-execute"}|${crawled ? "crawl" : "no-crawl"}`);
}

export const originOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return normalizeText(url);
  }
};

export function runIdentity(analysis: QaAnalysis, runLabel: "current" | "baseline"): RunIdentity {
  const origin = originOf(analysis.scan.scan.url);
  const digest = configDigestOf(analysis);
  return {
    runId: hash(`${origin}|${analysis.generatedAt}|${digest}`),
    runLabel,
    origin,
    sourceUrl: analysis.scan.scan.url,
    scannedAt: analysis.generatedAt,
    mode: analysis.mode,
    aiProvider: analysis.aiProvider,
    schemaVersion: analysis.schemaVersion,
    configDigest: digest,
  };
}

/** Whether two runs are layered the same way (same origin, same configuration
 *  digest, same schema) so their comparison is meaningful. */
export function comparableRunPair(current: QaAnalysis, baseline: QaAnalysis): { comparable: boolean; reason: string | null } {
  const c = configDigestOf(current);
  const b = configDigestOf(baseline);
  if (originOf(current.scan.scan.url) !== originOf(baseline.scan.scan.url)) {
    return { comparable: false, reason: "the two runs target different origins" };
  }
  if (c !== b) {
    return { comparable: false, reason: "the two runs used different configuration (execution layer or crawl coverage differ)" };
  }
  if (current.schemaVersion !== baseline.schemaVersion) {
    return { comparable: false, reason: `schema mismatch (current ${current.schemaVersion} vs baseline ${baseline.schemaVersion})` };
  }
  return { comparable: true, reason: null };
}