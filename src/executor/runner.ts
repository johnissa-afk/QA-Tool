import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { QaExecution, VerificationResult } from "../ai/types.js";
import { loadVerificationResults } from "./parse.js";
import { VerificationTask } from "./tasks.js";
import { resetResultsDir } from "./run-dir.js";
import { VERIFICATION_DIR } from "./spec.js";

// ---------------------------------------------------------------------------
// Playwright runner.
// ---------------------------------------------------------------------------
type JsonLike = { [key: string]: unknown };

function collectTests(node: unknown, out: JsonLike[]): void {
  if (!node || typeof node !== "object") return;
  const current = node as JsonLike;
  if (Array.isArray(current.tests)) {
    for (const test of current.tests) if (test && typeof test === "object") out.push(test as JsonLike);
  }
  if (Array.isArray(current.suites)) for (const suite of current.suites) collectTests(suite, out);
}

export function summarizePlaywrightJson(raw: unknown): QaExecution {
  const root = (raw ?? {}) as JsonLike;
  const stats = (root.stats ?? {}) as JsonLike;
  const numberOr = (value: unknown, fallback: number | null): number | null => (typeof value === "number" ? value : fallback);

  const tests: JsonLike[] = [];
  collectTests(root, tests);
  const results = tests.map(item => ({ title: String(item.title ?? "unknown"), results: (item.results ?? []) as JsonLike[] }));

  const expected = numberOr(stats.expected, results.filter(item => item.results.some(result => result.status === "passed")).length);
  const unexpected = numberOr(stats.unexpected, results.filter(item => item.results.some(result => ["failed", "timedOut", "interrupted"].includes(String(result.status)))).length);
  const flaky = numberOr(stats.flaky, 0);
  const skipped = numberOr(stats.skipped, results.filter(item => item.results.some(result => result.status === "skipped")).length);
  const failed = unexpected;

  const failures = results
    .map(item => ({
      title: item.title,
      error: (item.results.find(result => result.error != null)?.error ?? null) as JsonLike | null,
    }))
    .filter(item => item.error)
    .map(item => ({ title: item.title, message: typeof item.error?.message === "string" ? item.error.message : String(item.error ?? "Unknown error") }));

  const total = numberOr(stats.expected, null) !== null
    ? (numberOr(stats.expected, 0) ?? 0) + (numberOr(stats.unexpected, 0) ?? 0) + (numberOr(stats.flaky, 0) ?? 0) + (numberOr(stats.skipped, 0) ?? 0)
    : results.length;

  const startedAt = typeof stats.startTime === "string" ? stats.startTime : null;
  const durationMs = numberOr(stats.duration, null);
  const status: QaExecution["status"] = (failed ?? 0) > 0 ? "failed" : total > 0 ? "passed" : "skipped";

  return {
    status,
    command: "playwright test (json reporter)",
    startedAt,
    durationMs,
    tests: total,
    passed: expected,
    failed,
    skipped,
    flaky,
    reproduced: null,
    notReproduced: null,
    review: null,
    infrastructureFailures: null,
    failures: failures.slice(0, 50),
  };
}

function runPlaywright(specPath: string): QaExecution {
  const cli = join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
  // The positional arg is matched as a regex against test file paths, so the
  // spec filter must use forward slashes and escape regex metacharacters.
  // A path relative to the project root is used (not the absolute path): an
  // absolute Windows path such as C:/Users/... may not match the path form
  // Playwright tests against, which silently yields "0 tests".
  const relative = resolve(specPath).replace(/\\/g, "/").replace(resolve(process.cwd()).replace(/\\/g, "/") + "/", "");
  const specFilter = relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const spawned = spawnSync(process.execPath, [cli, "test", specFilter, "--reporter=json"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  const durationMs = Date.now() - started;
  const stdout = spawned.stdout ?? "";
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  try {
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      const summary = summarizePlaywrightJson(parsed);
      const stderrText = (spawned.stderr ?? "").toString().trim();
      if (summary.tests === 0 && stderrText) summary.failures = [{ title: "runner", message: stderrText.slice(0, 1000) }];
      return { ...summary, command: `node ${cli} test ${specFilter} --reporter=json`, startedAt, durationMs };
    }
    throw new Error("No JSON report in Playwright output.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (spawned.stderr ?? "").toString();
    return {
      status: "error",
      command: `node ${cli} test ${specFilter} --reporter=json`,
      startedAt,
      durationMs,
      tests: null,
      passed: null,
      failed: null,
      skipped: null,
      flaky: null,
      reproduced: null,
      notReproduced: null,
      review: null,
      infrastructureFailures: null,
      failures: [{ title: "runner", message: `${message}${stderr ? `\n${stderr.slice(0, 1000)}` : ""}`.slice(0, 2000) }],
    };
  }
}

export type VerificationRun = { execution: QaExecution; results: VerificationResult[] };

export function runVerificationSpec(specPath: string, tasks: VerificationTask[]): VerificationRun {
  // Never let a previous run's outcome files (possibly from another site) be
  // mistaken for this run's: scenario IDs repeat across sites.
  resetResultsDir(VERIFICATION_DIR);
  let execution = runPlaywright(specPath);
  if (tasks.length > 0 && (execution.tests ?? 0) === 0 && execution.status !== "error") {
    // Tasks were scheduled but Playwright discovered/ran nothing. That is an
    // execution failure, not a clean "skipped" run.
    execution = {
      ...execution,
      status: "error",
      failures: [
        { title: "runner", message: `${tasks.length} verification task(s) were scheduled but Playwright ran 0 tests; no outcomes were produced.${execution.failures[0] ? `\n${execution.failures[0].message}` : ""}`.slice(0, 2000) },
      ],
    };
  }
  const results = loadVerificationResults(tasks);
  const reproduced = results.filter(result => result.status === "REPRODUCED").length;
  const notReproduced = results.filter(result => result.status === "NOT_REPRODUCED").length;
  const review = results.filter(result => result.status === "REVIEW").length;
  const infrastructureFailures = results.filter(result => result.category === "INFRASTRUCTURE").length;
  return { execution: { ...execution, reproduced, notReproduced, review, infrastructureFailures }, results };
}

export { runPlaywright };