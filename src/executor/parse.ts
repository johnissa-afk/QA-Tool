import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VerificationResult } from "../ai/types.js";
import { VerificationTask } from "./tasks.js";
import { VERIFICATION_DIR } from "./spec.js";

// ---------------------------------------------------------------------------
// Verification result collector.
//
// Each spec test writes one JSON outcome file. This reader aggregates them and
// fabricates a REVIEW / OUTCOME_MISSING result for any scheduled task that did
// not produce a file, so a crashed runner never silently drops a finding.
// ---------------------------------------------------------------------------
export function loadVerificationResults(tasks: VerificationTask[], dir = VERIFICATION_DIR): VerificationResult[] {
  const resultsDir = join(process.cwd(), dir);
  const byScenario = new Map(tasks.map(task => [task.scenarioId, task]));
  const taskScenarioIds = new Set(tasks.map(task => task.scenarioId));
  const results: VerificationResult[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(resultsDir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const scenarioId = file.slice(0, -".json".length);
    if (!taskScenarioIds.has(scenarioId)) continue;
    try {
      const result = JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as VerificationResult;
      if (result && result.scenarioId) results.push(result);
    } catch {
      const task = byScenario.get(scenarioId);
      if (task) results.push(missingOutcome(task));
    }
  }
  for (const task of tasks) {
    if (!results.some(result => result.scenarioId === task.scenarioId)) results.push(missingOutcome(task));
  }
  return results.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

function missingOutcome(task: VerificationTask): VerificationResult {
  return {
    findingId: task.findingId,
    scenarioId: task.scenarioId,
    strategy: task.strategy,
    locator: task.locator,
    status: "REVIEW",
    category: "REVIEW",
    executedAt: null,
    durationMs: null,
    expectation: task.expectation,
    evidence: {
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
    },
    error: { type: "OUTCOME_MISSING", message: "The verification task did not produce an outcome file." },
    triage: {
      verdict: "REVIEW_REQUIRED",
      reason: "No outcome file was produced, so the finding cannot be confirmed or ruled out automatically.",
      confidence: "medium",
      provider: "deterministic",
    },
  };
}