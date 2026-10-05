import { resolve } from "node:path";
import { atomicWriteText } from "../atomic-write.js";
import { ScanReport } from "../types.js";
import { DiscoveredFlow, FlowLimits } from "./types.js";

// ---------------------------------------------------------------------------
// Flow spec renderer.
//
// Emits ONE Playwright spec file that runs every EXECUTABLE flow against the
// live site. The spec writes each deterministic FlowExecutionResult JSON into
// reports/flows/. Tests never assert a website failure: runFlow stops at any
// safety boundary and records what happened. Results are later collected and
// classified by flow/parse.ts.
// ---------------------------------------------------------------------------

export const FLOWS_DIR = "reports/flows";

export function renderFlowSpec(report: ScanReport, flows: DiscoveredFlow[], limits: FlowLimits, outputPath: string): string {
  const executable = flows.filter(flow => flow.executable);
  const spec = `import "dotenv/config";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { runFlow } from "../dist/flow/execute.js";
import type { DiscoveredFlow } from "../dist/flow/types.js";

// AUTO-GENERATED user-flow spec — Phase 3 autonomous flow discovery.
// Source: ${report.scan.url}
// Executable flows: ${executable.length} (SAFE + AUTOMATED steps only)

test.use({
  httpCredentials: (process.env.QA_BASIC_AUTH_USER || process.env.QA_USERNAME) && (process.env.QA_BASIC_AUTH_PASSWORD || process.env.QA_PASSWORD)
    ? { username: process.env.QA_BASIC_AUTH_USER || process.env.QA_USERNAME!, password: process.env.QA_BASIC_AUTH_PASSWORD || process.env.QA_PASSWORD! }
    : undefined,
  viewport: { width: 1280, height: 800 },
});

const FLOWS: DiscoveredFlow[] = ${JSON.stringify(executable, null, 2)};

const RESULTS_DIR = join(process.cwd(), ${JSON.stringify(FLOWS_DIR)});

for (const flow of FLOWS) {
  test(\`flow \${flow.flowId} \${flow.category} (\${flow.title})\`, async ({ page }) => {
    test.setTimeout(150000);
    const result = await runFlow(page, flow, { startTimeoutMs: 30000, elementTimeoutMs: 8000, limits: { maxExecutionMs: ${limits.maxExecutionMs ?? 120000} } });
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, \`\${result.scenarioId}.json\`), JSON.stringify(result));
  });
}
`;
  const target = resolve(outputPath);
  atomicWriteText(target, spec);
  return target;
}