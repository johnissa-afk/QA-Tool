import { createHash } from "node:crypto";
import type { QaAnalysis } from "../ai/types.js";
import type { ExecutionFact, FindingFact } from "./evidence.js";
import { findingPage } from "./identity.js";

// ---------------------------------------------------------------------------
// Deterministic grouping.
//
// A cluster is a connected body of evidence that MAY share a root cause.
// Grouping keys on normalized SEMANTIC identity only: same element key + same
// normalized page. Severity, code, category, URL text, and shared words never
// group anything. Clusters then feed candidate synthesis in root-cause.ts,
// which decides whether the cluster can support a claim at all.
// ---------------------------------------------------------------------------

export type ClusterKind = "TARGET" | "INFRASTRUCTURE" | "DISCOVERY_VARIANCE";

export type ClusterSeed = {
  id: string;
  kind: ClusterKind;
  anchor: string;
  page: string;
  elementKey: string | null;
  findingIds: string[];
  flowIds: string[];
  changeIds: string[];
  /** Distinct finding domains + flow categories inside the cluster. */
  categories: string[];
  /** Exactly one by construction: the responsibility boundary for infra. */
};

export type ClusterBuildInput = {
  analysis: QaAnalysis;
  findings: FindingFact[];
  executions: ExecutionFact[];
};

const hash = (input: string): string => createHash("sha1").update(input).digest("hex").slice(0, 8);

const cleanKey = (elementKey: string): string => {
  const compact = elementKey.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}…` : compact;
};

export const buildClusters = (input: ClusterBuildInput): ClusterSeed[] => {
  const { analysis, findings, executions } = input;
  const clusters: ClusterSeed[] = [];
  const clustersByKey = new Map<string, ClusterSeed>();

  const seedFor = (key: string, kind: ClusterKind, anchor: string, page: string, elementKey: string | null): ClusterSeed => {
    const existing = clustersByKey.get(key);
    if (existing) return existing;
    const seed: ClusterSeed = {
      id: hash(key),
      kind,
      anchor,
      page,
      elementKey,
      findingIds: [],
      flowIds: [],
      changeIds: [],
      categories: [],
    };
    clustersByKey.set(key, seed);
    clusters.push(seed);
    return seed;
  };

  const page = findingPage(analysis);

  // 1. Findings join target clusters ONLY through a semantic element key.
  for (const finding of findings) {
    if (!finding.elementKey) continue;
    const cluster = seedFor(`TARGET|${finding.page}|${finding.elementKey}`, "TARGET", cleanKey(finding.elementKey), finding.page, finding.elementKey);
    cluster.findingIds.push(finding.findingId);
    cluster.categories.push(finding.domain);
  }

  // 2. Failed executions join target clusters through their own semantic key.
  //    Infrastructure executions join the single infrastructure cluster.
  for (const execution of executions) {
    if (execution.infra) {
      const infra = seedFor("INFRASTRUCTURE|origin", "INFRASTRUCTURE", "Infrastructure / runner failures", execution.page || page, null);
      infra.flowIds.push(execution.flowId);
      infra.categories.push("INFRASTRUCTURE");
      continue;
    }
    if (!execution.failedOnSite || !execution.elementKey) continue;
    const cluster = seedFor(`TARGET|${execution.page}|${execution.elementKey}`, "TARGET", cleanKey(execution.elementKey), execution.page, execution.elementKey);
    cluster.flowIds.push(execution.flowId);
    cluster.categories.push(`flow:${execution.flowId}`);
  }

  // 3. Discovery variance: removed flows and coverage loss WITHOUT verification
  //    evidence are aggregated into one honest crawl-variance cluster. They
  //    never become website-defect claims.
  const regression = analysis.regression;
  if (regression?.summary.comparable) {
    const currentFlows = new Set((analysis.flowDiscovery?.flows ?? []).map(flow => flow.flowId));
    const varianceChanges = regression.changes.filter(
      change => change.classification === "REMOVED_FLOW" || change.classification === "COVERAGE_CHANGED",
    );
    for (const change of varianceChanges) {
      const cluster = seedFor("DISCOVERY_VARIANCE|run", "DISCOVERY_VARIANCE", "Crawl / discovery variance", page, null);
      cluster.changeIds.push(change.changeId);
      for (const flowId of change.relatedFlowIds) {
        if (currentFlows.has(flowId)) {
          cluster.flowIds.push(flowId);
          cluster.categories.push(`flow:${flowId}`);
        }
      }
    }
  }

  // 4. Regression-correlated flows join their cluster context (new flows that
  //    stalled are already present; regression flows add classification info).
  if (regression?.summary.comparable) {
    const targetClusters = clusters.filter(cluster => cluster.kind === "TARGET");
    for (const cluster of targetClusters) {
      for (const change of regression.changes) {
        if (change.classification !== "REGRESSION") continue;
        const linked = change.relatedFindingIds.some(id => cluster.findingIds.includes(id));
        if (linked) {
          cluster.changeIds.push(change.changeId);
          cluster.categories.push(`regression:${change.changeId}`);
        }
      }
    }
  }

  // Deduplicate within each cluster (targets reached by several findings).
  for (const cluster of clusters) {
    cluster.findingIds = [...new Set(cluster.findingIds)];
    cluster.flowIds = [...new Set(cluster.flowIds)];
    cluster.changeIds = [...new Set(cluster.changeIds)];
    cluster.categories = [...new Set(cluster.categories)];
  }

  return clusters;
};