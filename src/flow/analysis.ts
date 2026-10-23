import { ScanReport } from "../types.js";
import { discoverFlows } from "./discover.js";
import { buildSiteGraphFromReport } from "./graph.js";
import { FlowAnalysisEnhancement, DiscoveredFlow, FlowDiscovery, FlowExecutionResult, FlowLimits, FlowPriority, FlowSummary, SiteGraph } from "./types.js";

// ---------------------------------------------------------------------------
// Flow discovery orchestration: builds the FlowDiscovery document attached to
// the QA analysis, summarizes counts, and applies bounded AI refinement.
// ---------------------------------------------------------------------------

export function emptyFlowSummary(): FlowSummary {
  return { pages: 0, flows: 0, executable: 0, review: 0, highRisk: 0, blocked: 0, steps: 0, executed: 0, passed: 0, reproduced: 0, notReproduced: 0, reviewRequired: 0, boundaryBlocked: 0, infrastructure: 0 };
}

export function summarizeFlows(flows: DiscoveredFlow[], executions: FlowExecutionResult[], pages: number): FlowSummary {
  const summary = emptyFlowSummary();
  summary.pages = pages;
  summary.flows = flows.length;
  summary.executable = flows.filter(flow => flow.executable).length;
  summary.review = flows.filter(flow => flow.boundary !== null && flow.safety === "REVIEW").length;
  summary.highRisk = flows.filter(flow => flow.safety === "HIGH_RISK").length;
  summary.blocked = flows.filter(flow => flow.safety === "BLOCKED").length;
  summary.steps = flows.reduce((total, flow) => total + flow.steps.length, 0);
  summary.executed = executions.length;
  summary.passed = executions.filter(result => result.status === "PASS").length;
  summary.reproduced = executions.filter(result => result.status === "REPRODUCED").length;
  summary.notReproduced = executions.filter(result => result.status === "NOT_REPRODUCED").length;
  summary.reviewRequired = executions.filter(result => result.status === "REVIEW_REQUIRED").length;
  summary.boundaryBlocked = executions.filter(result => result.status === "BLOCKED").length;
  summary.infrastructure = executions.filter(result => result.status === "INFRASTRUCTURE_PROBLEM").length;
  return summary;
}

const PRIORITIES: FlowPriority[] = ["P0", "P1", "P2", "P3", "P4"];

/** Applies bounded AI refinement to a discovered flow. Only names/descriptions/
 *  priorities may change; evidence, steps, safety, automation, and categories
 *  remain deterministic. */
export function applyFlowAnalysis(flow: DiscoveredFlow, enhancement: FlowAnalysisEnhancement | null): DiscoveredFlow {
  if (!enhancement) return flow;
  const title = typeof enhancement.title === "string" && enhancement.title.trim() ? enhancement.title.trim().slice(0, 120) : flow.title;
  const description = typeof enhancement.description === "string" && enhancement.description.trim() ? enhancement.description.trim().slice(0, 300) : flow.description;
  const priority = PRIORITIES.includes(enhancement.priority as FlowPriority) ? (enhancement.priority as FlowPriority) : flow.priority;
  return { ...flow, title: title === flow.title ? flow.title : title, description: description === flow.description ? flow.description : description, priority };
}

export function buildFlowDiscovery(report: ScanReport, limits: FlowLimits, executions: FlowExecutionResult[] = [], graphOverride?: SiteGraph): FlowDiscovery {
  const graph = graphOverride ?? buildSiteGraphFromReport("page-1", report);
  const flows = discoverFlows(graph, limits);
  const summary = summarizeFlows(flows, executions, graph.pages.length);
  return { limits, graph, flows, executions, summary };
}

export function attachFlowExecutions(discovery: FlowDiscovery, executions: FlowExecutionResult[]): FlowDiscovery {
  return { ...discovery, executions, summary: summarizeFlows(discovery.flows, executions, discovery.graph.pages.length) };
}