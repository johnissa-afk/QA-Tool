import { resolve } from "node:path";
import { atomicWriteText } from "../atomic-write.js";
import { ScanReport } from "../types.js";
import { VerificationTask } from "./tasks.js";

// ---------------------------------------------------------------------------
// Verification spec renderer.
//
// Emits ONE Playwright spec file that confirms every scheduled finding on the
// live page. Tests never assert a failure of the underlying check; they run the
// safe `runVerification` executor and store the deterministic outcome JSON in
// reports/verification/<scenarioId>.json. The runner collects those files and
// classifies INFRASTRUCTURE / AUTHENTICATION outcomes as REVIEW, never as
// confirmed defects.
// ---------------------------------------------------------------------------
export const VERIFICATION_DIR = "reports/verification";

export function renderVerificationSpec(report: ScanReport, tasks: VerificationTask[], outputPath: string): string {
  const spec = `import "dotenv/config";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { runVerification } from "../dist/executor/verify.js";
import type { VerificationTask } from "../dist/executor/tasks.js";

// AUTO-GENERATED finding-verification spec — EXECUTOR layer of the QA platform.
// Source: ${report.scan.url}
// Scheduled tasks: ${tasks.length}

test.use({
  httpCredentials: (process.env.QA_BASIC_AUTH_USER || process.env.QA_USERNAME) && (process.env.QA_BASIC_AUTH_PASSWORD || process.env.QA_PASSWORD)
    ? { username: process.env.QA_BASIC_AUTH_USER || process.env.QA_USERNAME!, password: process.env.QA_BASIC_AUTH_PASSWORD || process.env.QA_PASSWORD! }
    : undefined,
  viewport: { width: 1280, height: 800 },
});

const TARGET_URL = ${JSON.stringify(report.scan.url)};

const TASKS: VerificationTask[] = ${JSON.stringify(tasks, null, 2)};

const RESULTS_DIR = join(process.cwd(), ${JSON.stringify(VERIFICATION_DIR)});

for (const task of TASKS) {
  test(\`verify \${task.scenarioId} \${task.code}\`, async ({ page }) => {
    test.setTimeout(60000);
    const result = await runVerification(page, task, { targetUrl: TARGET_URL, screenshotDir: ${JSON.stringify(VERIFICATION_DIR)} });
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, \`\${task.scenarioId}.json\`), JSON.stringify(result));
  });
}
`;
  const target = resolve(outputPath);
  atomicWriteText(target, spec);
  return target;
}