import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { getAuthenticationConfig, scanWebsite } from "./scanner.js";
import { emitGithubAnnotations, printJsonSummary, writeJUnitReport } from "./reporter.js";
import { ReporterFormat, ScanOptions, WaitUntil } from "./types.js";

// Load project-local secrets before the scanner reads its authentication variables.
// dotenv does not overwrite values already supplied by the calling environment.
dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

export const help = `Usage: npm run scan -- <url> [options]\n\nOptions:\n  --headed                 Show the browser\n  --timeout <milliseconds> Navigation timeout (default: 30000)\n  --output <path>          JSON report path (default: reports/qa-report.json)\n  --concurrency <number>   Concurrent link checks (default: 5)\n  --retries <number>       Retry navigation up to N times on failure (default: 0)\n  --wait-until <strategy>  Navigation wait strategy: load | domcontentloaded | networkidle (default: domcontentloaded)\n  --throttle <kbps>        Throttle browser download/upload throughput to N Kbps (default: 0 = no throttling)\n  --include <patterns>     Comma-separated URL globs; only matching links are checked (default: all)\n  --exclude <patterns>     Comma-separated URL globs; matching links are skipped (default: none)\n  --follow-external        Also health-check external (cross-origin) links (default: same-origin only)\n  --reporter <format>      Console output format: line | json | junit (default: line)\n  --github-annotations     Emit GitHub Actions workflow commands for inline annotations\n  --perf-budgets <path>     Path to a JSON file with performance budget thresholds (e.g. {"lcp": 2500})\n  --baseline-screenshot <path>  Path to a baseline screenshot for visual regression comparison\n  --screenshot-threshold <pct>  Max pixel diff percentage before reporting visual regression (default: 0.1)\n  --help                   Show this help`;

const WAIT_UNTIL_VALUES: readonly WaitUntil[] = ["load", "domcontentloaded", "networkidle"];

const parseRetry = (rest: string[]): number => {
  if (!rest.includes("--retries")) return 0;
  const index = rest.indexOf("--retries");
  const raw = rest[index + 1];
  if (!raw) throw new Error("--retries requires a value.");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error("--retries must be a non-negative integer.");
  return value;
};

const parseWaitUntil = (rest: string[]): WaitUntil => {
  if (!rest.includes("--wait-until")) return "domcontentloaded";
  const index = rest.indexOf("--wait-until");
  const raw = rest[index + 1];
  if (!raw) throw new Error("--wait-until requires a value.");
  if (!WAIT_UNTIL_VALUES.includes(raw as WaitUntil)) throw new Error(`--wait-until must be one of: ${WAIT_UNTIL_VALUES.join(", ")}.`);
  return raw as WaitUntil;
};

const parseThrottle = (rest: string[]): number => {
  if (!rest.includes("--throttle")) return 0;
  const index = rest.indexOf("--throttle");
  const raw = rest[index + 1];
  if (!raw) throw new Error("--throttle requires a value.");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error("--throttle must be a non-negative integer (Kbps).");
  return value;
};

const optionValue = (rest: string[], name: string): string | undefined => {
  if (!rest.includes(name)) return undefined;
  const raw = rest[rest.indexOf(name) + 1];
  if (!raw || raw.startsWith("-")) return undefined;
  return raw;
};

const parseInclude = (rest: string[]): string | undefined => optionValue(rest, "--include");
const parseExclude = (rest: string[]): string | undefined => optionValue(rest, "--exclude");

const REPORTER_FORMATS: readonly ReporterFormat[] = ["line", "json", "junit"];

const parseReporter = (rest: string[]): ReporterFormat => {
  const index = rest.indexOf("--reporter");
  if (index === -1) return "line";
  const raw = rest[index + 1];
  if (!raw) throw new Error("--reporter requires a value.");
  const lower = raw.toLowerCase() as ReporterFormat;
  if (!REPORTER_FORMATS.includes(lower)) throw new Error(`--reporter must be one of: ${REPORTER_FORMATS.join(", ")}.`);
  return lower;
};

const parsePerfBudgetsPath = (rest: string[]): string | undefined => {
  if (!rest.includes("--perf-budgets")) return undefined;
  const raw = rest[rest.indexOf("--perf-budgets") + 1];
  if (!raw || raw.startsWith("-")) throw new Error("--perf-budgets requires a value.");
  return raw;
};

export function parseArgs(args: string[]): ScanOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  const [url, ...rest] = args;
  if (!url || url.startsWith("-")) throw new Error(help);
  new URL(url);
  for (const name of ["--output", "--timeout", "--concurrency", "--perf-budgets", "--baseline-screenshot"]) {
    const index = rest.indexOf(name);
    if (index >= 0 && (rest[index + 1] === undefined || rest[index + 1].startsWith("-"))) {
      throw new Error(`${name} requires a value.`);
    }
  }
  const option = (name: string, fallback: string) => rest.includes(name) ? (rest[rest.indexOf(name) + 1] ?? "") : fallback;
  const positive = (name: string, fallback: number) => { const value = Number(option(name, String(fallback))); if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive number.`); return value; };
  return { url: new URL(url).href, headed: rest.includes("--headed"), timeout: positive("--timeout", 30_000), outputPath: resolve(option("--output", "reports/qa-report.json")), concurrency: Math.floor(positive("--concurrency", 5)), retries: parseRetry(rest), waitUntil: parseWaitUntil(rest), throttleKbps: parseThrottle(rest), includePatterns: parseInclude(rest), excludePatterns: parseExclude(rest), followExternal: rest.includes("--follow-external"), reporter: parseReporter(rest), githubAnnotations: rest.includes("--github-annotations"), perfBudgetsPath: parsePerfBudgetsPath(rest) };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) { console.log(help); return; }
  const authentication = getAuthenticationConfig();
  if (options.reporter !== "json") {
    console.log(`Basic Auth: ${authentication.diagnostic.method === "basic" || authentication.diagnostic.method === "basic-and-authorization" ? "configured" : "not configured"}`);
    console.log(`QA_AUTHORIZATION present: ${authentication.diagnostic.authorizationPresent}`);
    console.log(`Authentication method: ${authentication.diagnostic.method}`);
  }
  const { report, jsonPath, htmlPath } = await scanWebsite(options);
  if (options.githubAnnotations) emitGithubAnnotations(report);
  if (options.reporter === "json") { printJsonSummary(report); return; }
  console.log(`HTTP response status: ${report.scan.navigationStatus ?? "unknown"}`);
  if (report.access) {
    console.log(`Access: ${report.access.accessStatus} · authentication ${report.access.authenticationType} · continue scan ${report.access.continueScan} · human review ${report.access.humanReview}.`);
  }
  const ap = report.accessPrerequisite;
  if (ap) {
    // The prerequisite is reported as its own fact. It is never folded into the
    // issue-group or severity totals, which stay at zero.
    console.log(`Normal QA scan: not run — access prerequisite (${ap.type}) requires human review.`);
    console.log("Access prerequisite:");
    console.log(`  type: ${ap.type}`);
    console.log(`  status: ${ap.status}`);
    console.log(`  message: ${ap.message}`);
    console.log(`Website findings: ${report.summary.issueGroups} issue groups.`);
    console.log(`Coverage: BLOCKED/REVIEW — inaccessible content was not counted as tested.`);
    console.log(`QA status: ${ap.status === "BLOCKED" ? "BLOCKED" : "REVIEW"}`);
  } else {
    console.log(`QA scan complete: ${report.summary.totalElements} elements, ${report.summary.failures} failures, ${report.summary.warnings} warnings.`);
  }
  if (report.scan.retryAttempts && report.scan.retryAttempts > 0) console.log(`Navigation retries attempted: ${report.scan.retryAttempts}`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`HTML report: ${htmlPath}`);
  if (report.scan.screenshotPath) console.log(`Screenshot: ${report.scan.screenshotPath}`);
  if (options.reporter === "junit") {
    const junitPath = writeJUnitReport(report, dirname(resolve(options.outputPath)));
    console.log(`JUnit report: ${junitPath}`);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`Scan failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
}
