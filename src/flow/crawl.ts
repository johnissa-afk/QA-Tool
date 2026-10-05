import type { BrowserContext } from "playwright";
import { join } from "node:path";
import { scanPageInContext, withScanBrowser } from "../scanner.js";
import { buildSiteGraphFromReport, mergeGraphs, normalizeUrl } from "./graph.js";
import { FlowLimits, SiteGraph } from "./types.js";

// ---------------------------------------------------------------------------
// Bounded site crawl.
//
// Crawls same-origin pages up to the configurable limits (maxPages, maxDepth,
// maxNavigationActions) by re-using the scanner's full scan on every page, then
// merges the per-page graphs into one site graph. The crawl only ever follows
// same-origin, non-broken anchors — external and broken destinations are
// recorded as edges but never opened for discovery.
//
// One browser is launched for the whole crawl and every page is scanned in a
// fresh page within that shared context. Previously each page paid a cold
// `chromium.launch()`; a crawl of N pages now costs one launch, not N. Page
// order stays deterministic (breadth-first, sequential) so the merged graph is
// identical run to run.
// ---------------------------------------------------------------------------

export type CrawlResult = {
  graph: SiteGraph;
  pages: { url: string; title: string | null; brokenLinks: number }[];
};

export async function crawlSite(options: { url: string; headed: boolean; timeout: number; concurrency: number; limits: FlowLimits }): Promise<CrawlResult> {
  const queue: { url: string; depth: number }[] = [{ url: options.url, depth: 0 }];
  const visited = new Set<string>();
  const graphs: SiteGraph[] = [];
  let navigationActions = 0;
  let pageNumber = 0;

  const scan = async (context: BrowserContext, url: string, index: number, depth: number): Promise<SiteGraph | null> => {
    try {
      const { report } = await scanPageInContext(context, {
        url,
        headed: options.headed,
        timeout: options.timeout,
        outputPath: join("reports", "crawl", `page-${index}.json`),
        concurrency: options.concurrency,
      });
      const node = buildSiteGraphFromReport(`page-${index}`, report);
      if (node.pages[0]) node.pages[0].depth = depth;
      return node;
    } catch (error) {
      // A single unreachable or crashing page must not abort the whole crawl;
      // it is recorded as an INFRASTRUCTURE-style graph node with no edges.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Crawl: skipping ${url} — ${message}`);
      return buildSiteGraphFromReport(`page-${index}`, {
        scan: { url, finalUrl: url, title: null, timestamp: new Date().toISOString(), durationMs: 0, navigationStatus: null },
        authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: null },
        access: { accessStatus: "unknown", continueScan: false, reason: message, httpStatus: null, challenge: null },
        summary: { totalElements: 0, interactiveElements: 0, passes: 0, warnings: 0, failures: 0, infos: 0, linksChecked: 0, brokenLinks: 0, consoleErrors: 0, pageErrors: 0, issueGroups: 0, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
        page: { language: null, viewport: null, forms: 0, images: 0, links: 0, buttons: 0, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
        elements: [], issues: [], links: [], consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
      } as never);
    }
  };

  return withScanBrowser(options.headed, async context => {
    while (queue.length > 0 && pageNumber < options.limits.maxPages) {
      const entry = queue.shift()!;
      const key = normalizeUrl(entry.url);
      if (visited.has(key)) continue;
      visited.add(key);
      pageNumber += 1;

      const node = await scan(context, entry.url, pageNumber, entry.depth);
      if (!node) continue;
      graphs.push(node);

      if (entry.depth >= options.limits.maxDepth) continue;
      for (const edge of node.pages[0]?.edges ?? []) {
        if (edge.origin !== "same" || edge.broken) continue;
        if (navigationActions >= options.limits.maxNavigationActions) break;
        const target = normalizeUrl(edge.href);
        if (visited.has(target)) continue;
        navigationActions += 1;
        queue.push({ url: edge.href, depth: entry.depth + 1 });
      }
    }

    const graph = mergeGraphs(graphs, options.limits);
    return {
      graph,
      pages: graphs.map(node => ({ url: node.pages[0]?.url ?? "", title: node.pages[0]?.title ?? null, brokenLinks: node.pages[0]?.brokenLinks ?? 0 })),
    };
  });
}
