import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FLOWS_DIR } from "./spec.js";
import { DiscoveredFlow, FlowExecutionResult } from "./types.js";

// ---------------------------------------------------------------------------
// Flow result collector.
//
// Each flow spec test writes one JSON outcome file (reports/flows/sc-<flow>.json).
// This reader aggregates them and fabricates a REVIEW_REQUIRED / OUTCOME_MISSING
// result for any EXECUTABLE flow that did not produce a file, so a crashed
// runner never silently drops a discovered flow.
// ---------------------------------------------------------------------------

export function loadFlowResults(flows: DiscoveredFlow[], dir = FLOWS_DIR): FlowExecutionResult[] {
  const resultsDir = join(process.cwd(), dir);
  const executable = new Set(flows.filter(flow => flow.executable).map(flow => `SC-${flow.flowId}`));
  const results: FlowExecutionResult[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(resultsDir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const scenarioId = file.slice(0, -".json".length);
    try {
      const result = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as FlowExecutionResult;
      if (result && result.scenarioId) results.push(result);
    } catch {
      if (executable.has(scenarioId)) results.push(missingOutcome(scenarioId));
    }
  }
  for (const flow of flows) {
    const scenarioId = `SC-${flow.flowId}`;
    if (!flow.executable) continue;
    if (!results.some(result => result.scenarioId === scenarioId)) results.push(missingOutcome(scenarioId));
  }
  return results.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

function missingOutcome(scenarioId: string): FlowExecutionResult {
  return {
    scenarioId,
    flowId: scenarioId.replace(/^SC-/, ""),
    category: "NAVIGATION",
    title: "Missing flow outcome",
    executedAt: null,
    durationMs: null,
    status: "REVIEW_REQUIRED",
    failureCategory: "REVIEW",
    startedUrl: "",
    finalUrl: null,
    stoppedAtStep: null,
    boundary: null,
    steps: [],
    error: { type: "OUTCOME_MISSING", message: "The flow did not produce an outcome file." },
  };
}