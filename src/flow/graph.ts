import { ScanReport } from "../types.js";
import { isSafeLocator } from "../executor/tasks.js";
import { FlowEvidenceRef, FlowLimits, NodeControl, NodeControlKind, NodeEdge, SiteGraph, SitePageNode } from "./types.js";
import { AUTH_TEXT, isAuthHref, isExternalHref, LANGUAGE_TEXT } from "./classify.js";

// ---------------------------------------------------------------------------
// Site graph construction. A graph node is derived strictly from one (or
// several merged) scan reports: pages, controls, and links are all facts the
// scanner observed — never guesses about a specific website.
// ---------------------------------------------------------------------------

const SEARCH_TEXT = /search|بحث/;
const LANGUAGE_HREF = /(\?|\&)(lang|locale|language|set.?lang|ChangeLanguageCultures?)=/i;
const MEDIA_TEXT = /(play|pause|mute|unmute|volume|full.?screen|captions|subtitles|watch trailer)/i;
const SIGNUP_TEXT = /(sign up|register|create account|create (a )?(free )?account|signup)/i;
const PROFILE_TEXT = /(my account|profile|account settings|my profile|dashboard)/i;
const HTTP_HREF = /^https?:\/\//i;

/** Normalized page identity: origin + pathname (query/hash ignored). */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    return url.href.replace(/\/$/, "") || url.origin;
  } catch {
    return raw;
  }
}

export function findPage(graph: SiteGraph, normalizedUrl: string): SitePageNode | null {
  return graph.pages.find(page => page.url === normalizedUrl) ?? null;
}

export function isRecognizedTextBox(tag: string, role: string | null): boolean {
  return tag === "input" && (role === "searchbox" || role === "textbox");
}

export function defaultFlowLimits(): FlowLimits {
  return {
    maxPages: 8,
    maxDepth: 3,
    maxNavigationActions: 60,
    maxFlows: 20,
    maxFlowSteps: 6,
    maxExecutionMs: 120000,
  };
}

type ControlContext = { searchboxIndexes: Set<number>; authFormIndexes: Set<number> };

function buildControlContext(report: ScanReport): ControlContext {
  const searchboxIndexes = new Set<number>();
  const authFormIndexes = new Set<number>();
  report.elements.forEach((element, index) => {
    const type = element.type?.toLowerCase() ?? "";
    const name = `${element.name ?? ""} ${element.ariaLabel ?? ""} ${element.placeholder ?? ""} ${element.accessibleName ?? ""} ${element.text ?? ""}`;
    if (element.tag === "input" && (type === "search" || element.role === "searchbox" || SEARCH_TEXT.test(name))) searchboxIndexes.add(index);
    if (element.tag === "input" && type === "password" && element.formIndex !== undefined && element.formIndex !== null) authFormIndexes.add(element.formIndex);
  });
  return { searchboxIndexes, authFormIndexes };
}

function safeLocator(report: ScanReport, index: number): string | null {
  const element = report.elements[index];
  if (!element) return null;
  if (element.locatorQuality === "low") return null;
  const locator = element.recommendedLocator;
  return isSafeLocator(locator) ? locator : null;
}

function control(
  kind: NodeControlKind,
  report: ScanReport,
  index: number,
  count: number,
  detail: string,
): NodeControl {
  const element = report.elements[index];
  return {
    kind,
    locator: safeLocator(report, index),
    text: element?.text ?? null,
    accessibleName: element?.accessibleName ?? null,
    role: element?.role ?? null,
    tag: element?.tag ?? "",
    href: element?.href ?? null,
    type: element?.type ?? null,
    elementIndex: index,
    safe: Boolean(safeLocator(report, index)),
    count,
    evidence: [{ pageId: null, elementIndex: index, detail }],
  };
}

/** Builds a one-page site graph from a single scan report. */
export function buildSiteGraphFromReport(pageId: string, report: ScanReport): SiteGraph {
  const { searchboxIndexes, authFormIndexes } = buildControlContext(report);
  const searchSubmits = new Set<number>();

  report.elements.forEach((element, index) => {
    if (element.formIndex === undefined || element.formIndex === null) return;
    const formHasSearch = report.elements.some((other, otherIndex) => other.formIndex === element.formIndex && searchboxIndexes.has(otherIndex));
    if (formHasSearch && (element.tag === "button" || element.tag === "a")) searchSubmits.add(index);
  });

  const controls: NodeControl[] = [];
  report.elements.forEach((element, index) => {
    const type = element.type?.toLowerCase() ?? "";
    const name = `${element.name ?? ""} ${element.ariaLabel ?? ""} ${element.placeholder ?? ""} ${element.accessibleName ?? ""} ${element.text ?? ""}`;
    const role = element.role ?? "";
    const inAuthForm = element.formIndex !== undefined && element.formIndex !== null && authFormIndexes.has(element.formIndex);
    if (!element.interactive) return;

    if (searchboxIndexes.has(index)) {
      controls.push(control("search", report, index, searchboxIndexes.size, "site search box"));
    } else if (searchSubmits.has(index)) {
      controls.push(control("search", report, index, searchboxIndexes.size, "site search submit"));
    } else if (LANGUAGE_TEXT.test((element.accessibleName ?? element.text ?? "").trim()) || (element.href && LANGUAGE_HREF.test(element.href))) {
      controls.push(control("language", report, index, 1, "language switch control"));
    } else if (element.tag === "video" || element.tag === "audio" || (MEDIA_TEXT.test(name) && role === "button")) {
      controls.push(control("media", report, index, 1, "media control"));
    } else if ((element.tag === "input" && type === "password") || AUTH_TEXT.test(name) || isAuthHref(element.href) || (inAuthForm && element.tag === "input")) {
      controls.push(control("auth", report, index, 1, "authentication affordance"));
    } else if (SIGNUP_TEXT.test(name)) {
      controls.push(control("signup", report, index, 1, "signup affordance"));
    } else if (PROFILE_TEXT.test(name)) {
      controls.push(control("profile", report, index, 1, "profile affordance"));
    } else if (element.formIndex !== undefined && element.formIndex !== null && !inAuthForm && element.tag !== "form") {
      controls.push(control("form", report, index, 1, "non-search form control"));
    }
  });

  // A broken destination is a genuine failure (BROKEN/ERROR per scanner
  // semantics). RESTRICTED (HTTP 401/403) is site gating, not a broken link —
  // it must never mark the page's own links as broken or stop the crawl.
  const brokenByUrl = new Map(
    report.links
      .filter(link => link.type === "BROKEN" || link.type === "ERROR")
      .map(link => [link.url, true]),
  );

  const edgeByHref = new Map<string, NodeEdge>();
  report.elements.forEach((element, index) => {
    if (element.tag !== "a" || !element.href || !HTTP_HREF.test(element.href)) return;
    const normalized = normalizeUrl(element.href);
    const existing = edgeByHref.get(normalized);
    if (existing) {
      existing.count += 1;
      existing.safe = existing.safe && Boolean(safeLocator(report, index));
      existing.evidence.push({ pageId, elementIndex: index, detail: "another page link to the same destination" });
      return;
    }
    edgeByHref.set(normalized, {
      fromPageId: pageId,
      toPageId: null,
      origin: isExternalHref(element.href, report.scan.finalUrl || report.scan.url) ? "external" : "same",
      href: element.href,
      label: element.accessibleName ?? element.text ?? null,
      locator: safeLocator(report, index),
      safe: Boolean(safeLocator(report, index)),
      count: 1,
      broken: brokenByUrl.has(element.href),
      evidence: [{ pageId, elementIndex: index, detail: "link observed on the scanned page" }],
    });
  });

  const brokenLinks = report.summary.brokenLinks;
  const node: SitePageNode = {
    id: pageId,
    url: normalizeUrl(report.scan.finalUrl || report.scan.url),
    title: report.scan.title || null,
    depth: 0,
    sourceReportUrl: report.scan.url,
    navigationStatus: report.scan.navigationStatus ?? null,
    brokenLinks,
    controls,
    edges: [...edgeByHref.values()],
  };

  return { sourceUrl: report.scan.url, pages: [node] };
}

/** Merges several per-page graphs into one site graph, deduping by normalized
 *  URL and wiring same-origin edges to their destination nodes when present. */
export function mergeGraphs(graphs: SiteGraph[], limits: FlowLimits): SiteGraph {
  const pages = new Map<string, SitePageNode>();
  for (const graph of graphs) {
    for (const page of graph.pages) {
      const existing = pages.get(page.url);
      if (existing) {
        for (const edge of page.edges) if (!existing.edges.some(e => e.href === edge.href && e.fromPageId === edge.fromPageId)) existing.edges.push(edge);
        for (const controlNode of page.controls) if (!existing.controls.some(c => c.elementIndex === controlNode.elementIndex && c.kind === controlNode.kind)) existing.controls.push(controlNode);
        continue;
      }
      pages.set(page.url, { ...page });
    }
  }

  const allPages = [...pages.values()].slice(0, limits.maxPages);
  const byUrl = new Map(allPages.map(page => [page.url, page]));
  for (const page of allPages) {
    for (const edge of page.edges) {
      if (edge.origin !== "same") continue;
      const target = byUrl.get(normalizeUrl(edge.href));
      if (target) edge.toPageId = target.id;
    }
  }

  return { sourceUrl: graphs[0]?.sourceUrl ?? "", pages: allPages };
}