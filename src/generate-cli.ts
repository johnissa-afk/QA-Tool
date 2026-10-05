import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePlaywrightSpec } from "./playwright-generator.js";
import { generateTestSuite, writeGeneratedTests } from "./test-generator.js";
import { ScanReport } from "./types.js";

const DEFAULT_REPORT = "reports/qa-report.json";
const DEFAULT_OUTPUT = "reports/generated-tests.json";
const DEFAULT_SPEC = "generated/generated-tests.spec.ts";

export const help = `Usage: npm run generate-tests -- <url>
       npm run generate-tests -- [--report <scan-report-json>] [--output <path>] [--spec <path>]

Options:
  --report <path>  Scan report to use (default: reports/qa-report.json)
  --output <path>  Generated tests output path (default: reports/generated-tests.json)
  --spec <path>    Generated Playwright spec file (default: generated/generated-tests.spec.ts)
                   Pass --spec none to skip writing a spec file.`;

type Options = { reportPath: string; url?: string; outputPath: string; specPath: string | null };

export function parseGenerateArgs(args: string[]): Options | null | { error: string } {
  if (args.includes("--help") || args.includes("-h")) return null;
  let reportFromOption: string | null = null;
  let outputFromOption: string | null = null;
  let specFromOption: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--report") { reportFromOption = args[i + 1]; if (!reportFromOption || reportFromOption.startsWith("-")) return { error: "--report requires a file path." }; i++; }
    else if (arg === "--output") { outputFromOption = args[i + 1]; if (!outputFromOption || outputFromOption.startsWith("-")) return { error: "--output requires a file path." }; i++; }
    else if (arg === "--spec") { specFromOption = args[i + 1]; if (!specFromOption || specFromOption.startsWith("-")) return { error: "--spec requires a file path." }; i++; }
    else if (arg.startsWith("-")) return { error: `Unknown option: ${arg}` };
    else positional.push(arg);
  }
  const url = (!reportFromOption && positional[0]) || undefined;
  if (!reportFromOption && positional.length > 1) return { error: `Unexpected argument: ${positional[1]}` };
  const reportPath = reportFromOption ?? (url ? DEFAULT_REPORT : DEFAULT_REPORT);
  if (url) { try { new URL(url); } catch { return { error: `Invalid URL: ${url}` }; } }
  const specPath = specFromOption === "none" ? null : resolve(specFromOption ?? DEFAULT_SPEC);
  return { reportPath, url, outputPath: resolve(outputFromOption ?? DEFAULT_OUTPUT), specPath };
}

function loadReport(reportPath: string): ScanReport {
  const report: unknown = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  if (!report || typeof report !== "object" || !Array.isArray((report as ScanReport).elements) || typeof (report as ScanReport).scan?.url !== "string") throw new Error(`Not a valid scan report: ${reportPath}`);
  return report as ScanReport;
}

async function main(): Promise<void> {
  const parsed = parseGenerateArgs(process.argv.slice(2));
  if (parsed === null) { console.log(help); return; }
  if ("error" in parsed) { console.error(`Error: ${parsed.error}`); console.log(help); process.exitCode = 1; return; }
  const report = loadReport(parsed.reportPath);
  if (parsed.url && report.scan.url !== new URL(parsed.url).href) {
    console.error(`Error: ${parsed.reportPath} was scanned for ${report.scan.url}, which does not match ${new URL(parsed.url).href}.`);
    console.error("Run the scanner for that URL first, or pass --report <path> for the correct scan report.");
    process.exitCode = 1;
    return;
  }
  const suite = generateTestSuite(report, { sourcePath: parsed.reportPath });
  const { jsonPath, htmlPath } = writeGeneratedTests(suite, parsed.outputPath);
  const specPath = parsed.specPath ? generatePlaywrightSpec(suite, parsed.specPath) : null;
  const counts = suite.counts;
  console.log("Generation complete");
  console.log(`  Source report: ${parsed.reportPath}`);
  console.log(`  Source URL:    ${suite.sourceUrl}`);
  console.log(`  Scenarios generated: ${counts.total}`);
  console.log(`    navigation: ${counts.navigation}`);
  console.log(`    button:     ${counts.button}`);
  console.log(`    input:      ${counts.input}`);
  console.log(`    form:       ${counts.form}`);
  console.log(`    validation: ${counts.validation}`);
  console.log(`    safe:       ${counts.safe}`);
  console.log(`    review:     ${counts.review}`);
  console.log(`    high-risk:  ${counts.highRisk}`);
console.log(`    automated:  ${counts.automated}`);
    console.log(`    manual:     ${counts.manual}`);
    console.log(`    conditional:${counts.conditional}`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`HTML report: ${htmlPath}`);
  if (specPath) {
    console.log(`Playwright spec: ${specPath}`);
    console.log(`  Run with: npm run test:generated`);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`Generation failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
}