import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetResultsDir } from "../executor/run-dir.js";
import { loadVerificationResults } from "../executor/parse.js";
import { loadFlowResults } from "../flow/parse.js";
import type { VerificationTask } from "../executor/tasks.js";
import type { DiscoveredFlow } from "../flow/types.js";

// Regression: scenario IDs (SC-VER-001, SC-FLOW-001) repeat across sites, so a
// previous site's outcome files must never surface in a later run's report.
function inTempCwd(fn: () => void): void {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "qa-stale-"));
  process.chdir(dir);
  try { fn(); } finally { process.chdir(previous); }
}

test("resetResultsDir removes a previous site's verification outcomes", () => {
  inTempCwd(() => {
    mkdirSync("reports/verification", { recursive: true });
    writeFileSync("reports/verification/SC-VER-001.json", JSON.stringify({ scenarioId: "SC-VER-001", status: "REPRODUCED", locator: 'page.getByPlaceholder("Search")' }));
    resetResultsDir("reports/verification");
    assert.equal(existsSync("reports/verification/SC-VER-001.json"), false);

    const task = { scenarioId: "SC-VER-001", findingId: "QA-F-001", strategy: "visibility", locator: "page.locator('a')", expectation: "x" } as unknown as VerificationTask;
    const [result] = loadVerificationResults([task]);
    assert.equal(result!.status, "REVIEW");
    assert.equal(result!.error?.type, "OUTCOME_MISSING");
  });
});

test("loadFlowResults ignores outcome files for flows not in this run", () => {
  inTempCwd(() => {
    mkdirSync("reports/flows", { recursive: true });
    writeFileSync("reports/flows/SC-FLOW-007.json", JSON.stringify({ scenarioId: "SC-FLOW-007", flowId: "FLOW-007", status: "REPRODUCED" }));
    const flows = [{ flowId: "FLOW-001", executable: true }] as unknown as DiscoveredFlow[];
    const results = loadFlowResults(flows);
    assert.deepEqual(results.map(item => item.scenarioId), ["SC-FLOW-001"]);
    assert.equal(results[0]!.error?.type, "OUTCOME_MISSING");
  });
});
