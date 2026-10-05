import dotenv from "dotenv";
import { resolve } from "node:path";


import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import { applyVerification, analyzeScan, explainStatus } from "./ai/index.js";
import { createAIProvider } from "./ai/provider.js";
import { writeQaReport } from "./ai/report.js";
import { AIProvider, QaAnalysis, QaConfigurationSnapshot, VerificationResult } from "./ai/types.js";
import { applyCoverageNotes, buildCoverage, coverageDigest } from "./coverage/index.js";
import { applyRegressionNotes, compareRuns } from "./regression/index.js";
import { ChangeClassification, RegressionDigest, RegressionMap } from "./regression/index.js";
import { applyIntelligenceNotes, buildIntelligence, intelligenceDigestOf } from "./intelligence/index.js";
import type { IntelligenceMap } from "./intelligence/index.js";
import { applyHistoricalIntelligenceNotes, buildHistoricalIntelligenceDigest, historicalIntelligenceForRuns } from "./history-intelligence/index.js";
import type { HistoricalIntelligenceMap } from "./history-intelligence/index.js";
import { buildVerificationTasks, renderVerificationSpec, runPlaywright, runVerificationSpec } from "./executor/index.js";
import { refreshVerificationRedactor } from "./executor/verify.js";
import { TaskSkip } from "./executor/tasks.js";
import { attachFlowExecutions, crawlSite, loadFlowResults, renderFlowSpec } from "./flow/index.js";
import { refreshFlowRedactor } from "./flow/execute.js";
import { FlowLimits, SiteGraph } from "./flow/types.js";
import {
  DEFAULT_HISTORY_DIR,
  HISTORY_SCHEMA_VERSION,
  historySiteIdentityOf,
  historySiteKeyOf,
  loadSiteHistory,
  persistRun,
  resetHistory,
} from "./history/index.js";
import type { HistoryReportSection } from "./history/index.js";
import { generatePlaywrightSpec } from "./playwright-generator.js";
import { generateTestSuite } from "./test-generator.js";
import { scanWebsite } from "./scanner.js";
import { GeneratedTestSuite, ScanReport } from "./types.js";
import { buildQaResultBlock, qaResultInputOf } from "./qa/result.js";
import { CI_DEFAULT_FAIL_POLICY, CI_EXIT_INFRASTRUCTURE, CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS, CI_FAIL_POLICIES, CiFailPolicy, decideCiExit, formatCiExit, parseCiFailPolicy } from "./qa/ci-policy.js";
import { evaluateGate, formatGateVerdict, GateMinSeverity } from "./qa/gate.js";
import { CANONICAL_CI_COMMAND, CI_CONTRACT_SUMMARY } from "./qa/ci-contract.js";
import { classifyRunOutcome, classifyThrownError, formatFailureModeLine } from "./qa/failure-mode.js";
import { BASELINE_VERIFY_EXIT_FAILURE, BASELINE_VERIFY_EXIT_OK, baselineMaxAgeLabel, baselineMetaPathOf, baselineStalenessOf, formatBaselineAge, formatBaselineVerification, loadBaseline, parseBaselineMaxAge, verifyBaseline } from "./qa/baseline.js";
import { QA_CONFIG_FILENAME, QaConfig, loadQaConfig, resolveQaConfig } from "./qa/config.js";
import { buildArtifactInventory, renderArtifactInventory } from "./qa/artifacts.js";
import { createStageEventEmitter, QaStage, QaStageEmitter, STAGE_EVENT_FILENAME } from "./qa/stages.js";
import { atomicWriteText } from "./atomic-write.js";
import { DashboardOptions, serveUntilClosed } from "./dashboard/server.js";



export const DEFAULT_SPEC = "generated/generated-tests.spec.ts";
export const DEFAULT_VERIFICATION_SPEC = "generated/qa-verification.spec.ts";
export const DEFAULT_FLOW_SPEC = "generated/qa-flows.spec.ts";

// ---------------------------------------------------------------------------
// Structured stage events.
//
// The run reports its own progress: every real boundary in the pipeline below
// calls startStage()/completeStage(), which emit `started`/`completed` events on
// a sidecar channel (never stdout, so the human-readable output a developer
// sees in a terminal is completely unchanged).
//
// Stage windows are deliberately non-overlapping. That keeps `stageInProgress`
// accurate, which is what lets the top-level failure handler attribute an
// escaped error to the exact stage that was running and emit a redacted `failed`
// event for it — without every boundary needing its own try/catch and without
// changing how errors propagate, their text, or the process exit code.
// ---------------------------------------------------------------------------
let stageEvents: QaStageEmitter | null = null;
let stageInProgress: QaStage | null = null;

function startStage(stage: QaStage): void {
  stageInProgress = stage;
  stageEvents?.started(stage);
}

function completeStage(stage: QaStage): void {
  if (stageInProgress === stage) stageInProgress = null;
  stageEvents?.completed(stage);
}

/**
 * Closes out the stage that was in progress when an error escaped the pipeline.
 * Called only from the top-level failure handler; safe to call when no stage was
 * open (configuration and usage errors emit no stage events).
 */
function failInProgressStage(error: unknown): void {
  const stage = stageInProgress;
  if (!stage) return;
  stageInProgress = null;
  stageEvents?.failed(stage, error);
}

export const help = `Usage: npm run qa -- <url> [options]

Options:
  --report <path>     Reuse an existing scan report JSON instead of scanning
  --suite <path>      Load an existing generated-suite JSON instead of regenerating
  --output <path>     QA analysis JSON path (default: reports/qa-analysis.json)
  --execute [spec]    Run the EXECUTOR (finding verification spec) and attach results
                      (default: ${DEFAULT_VERIFICATION_SPEC}; pass an element-suite spec path
                      to run the element suite instead, or "none" to skip)
                      When the verification spec runs, executable user flows are also run.
                      NOTE: a user-supplied spec path runs through generic Playwright and is
                      NOT subject to the locator safety guard used by finding verification.
  --crawl             Phase 3: crawl same-origin pages (up to --max-pages) to discover
                      user flows across the site instead of only the start page
  --max-pages <n>     Crawl page budget (default: 8)
  --max-depth <n>     Crawl link depth (default: 3)
  --max-flows <n>     Max discovered flows (default: 20)
  --max-flow-steps <n> Max steps kept per flow (default: 6)
  --headed            Show the browser during the scan
  --timeout <ms>      Navigation timeout (default: 30000)
  --concurrency <n>   Concurrent link checks (default: 5)
  --baseline <path>   Phase 5: compare this run against a previous qa-analysis.json
                      (writes a regression summary + REGRESSION SUMMARY in the HTML report)
                      Phase 10: the artifact is verified on load — structural validation
                      always, plus sha256 integrity against <path>.meta.json when present.
                      Missing/malformed/invalid/digest-mismatched baselines are hard errors.
                      Defaults to baseline.path in ${QA_CONFIG_FILENAME} when the flag is
                      absent; the CLI flag always overrides the configuration.
  --write-baseline <path>
                      Phase 9: persist THIS run's full qa-analysis.json as a baseline
                      artifact (plus a <path>.meta.json with run id, timestamp and
                      digest). Refuses to overwrite an existing file. Later runs use it
                      via --baseline.
  --baseline-max-age <dur>
                      Phase 10D: baseline rotation policy (see "Baseline rotation"
                      below). Duration like 30d | 12h | 90m | 2w.
  --history-dir <path> Phase 7A: run history directory (default: ${DEFAULT_HISTORY_DIR})
  --reset-history     Phase 7A: delete ONLY the history directory, then resume this run
  --ci                Phase 8C: apply the CI exit policy. Exit codes:
                        ${CI_EXIT_SUCCESS} = acceptable result
                        ${CI_EXIT_POLICY_FAILURE} = QA result violates the configured failure policy
                        ${CI_EXIT_INFRASTRUCTURE} = infrastructure/runtime/tooling failure
                      Without --ci the exit code is non-zero only on errors
                      (infrastructure and usage failures keep exit 1, as before 8C).
  --fail-on <status>  Minimum QA status that fails CI: ${CI_FAIL_POLICIES.join(" | ")}
                      (default: ${CI_DEFAULT_FAIL_POLICY}). "review" → REVIEW and FAIL
                      fail CI; "failed" → only FAIL fails CI. Implies --ci.
  --help              Show this help

CI baseline gate (Phase 9):
  With BOTH --ci and --baseline <path>, CI additionally fails when the run
  INTRODUCED regressions against the baseline: NEW findings at or above the
  gate threshold, or a verified finding REGRESSION (never a NEW MEDIUM/LOW).
  Threshold: ci.gateMinSeverity in qa.config.json ("HIGH" default | "CRITICAL").
  Exit codes stay 0/1/2; the same result is printed either way.

Baseline rotation (Phase 10D):
  A baseline describes the site when it was written, so it decays. With
  --baseline-max-age <dur> (or baseline.maxAge in qa.config.json), the run
  prints the baseline age each time and --ci additionally fails (exit 1 —
  a QA policy failure) when the age exceeds the window, telling the team to
  re-publish with --write-baseline. Age is measured from writtenAt (sidecar)
  or the artifact's own generatedAt; legacy baselines with no usable timestamp
  are never failed (age "unknown" is not enforceable). The \`verify\` subcommand
  shows the age but takes no position — its 0/2 exit contract is unchanged.

${CI_CONTRACT_SUMMARY}

Canonical CI command:
  ${CANONICAL_CI_COMMAND}
  The baseline defaults to baseline.path in ${QA_CONFIG_FILENAME} when the
  --baseline flag is absent; the flag always overrides the configuration.

Configuration:
  ${QA_CONFIG_FILENAME} is optional (project root). CLI options override
  configuration-file values. Precedence: defaults < ${QA_CONFIG_FILENAME} < CLI.
  Supported settings: crawl.maxPages, execution.enabled, coverage.enabled,
  regression.enabled, rootCause.enabled, history.enabled,
  historicalIntelligence.enabled, ci.failOn, ci.gateMinSeverity,
  baseline.maxAge, baseline.path. Unknown properties, invalid values, and malformed JSON are
  hard errors (the QA pipeline does not start).

Subcommand:
  serve|dash [--dir <dir>] [--history-dir <path>] [--port <n>] [--host <host>]
             [--baseline-max-age <dur>]
                      Phase 8B: serve the local QA dashboard (reads the report +
                      history artifacts read-only; binds to 127.0.0.1 by default).
                      --baseline-max-age enables the Phase 10D rotation position
                      in the home-view baseline trust card.
  verify <path>       Phase 10: offline baseline verification. Loads a baseline
                      artifact exactly as --baseline does — structure validation
                      always, sha256 integrity against <path>.meta.json when the
                      sidecar exists, provenance, and the Phase 10D age — without
                      running a pipeline.
                      Exits 0 when the artifact is a valid baseline (verified or
                      legacy without a sidecar); exits 2 when it is missing,
                      malformed, structurally invalid, or failed digest
                      verification.

Verification also writes reports/qa-execution.json (execution + verdicts + evidence).
Flows also write reports/flows/sc-<flow>.json (safe step outcomes).`;

const verifyHelp = `Usage: npm run qa verify -- <path>

Phase 10 offline baseline verification. Loads a baseline artifact exactly the
way --baseline loads it, without a QA pipeline, browser, or network:

  - structure validation always (must be a comparable QaAnalysis baseline)
  - sha256 integrity against <path>.meta.json when the sidecar exists
  - provenance: run id / written-at / generated-at / source url
  - Phase 10D: the elapsed baseline age (writtenAt, else generatedAt)

Exit codes (0/1/2 model):
  0  the artifact is a valid baseline — verified, or a legacy artifact with no
     sidecar (structure validated; digest not verifiable), regardless of age.
  2  the artifact is missing, malformed, structurally invalid, or failed
     digest verification (a corrupt baseline is never silently acceptable)`;

export type QaOptions = {
  url: string | null;
  reportPath: string | null;
  suitePath: string | null;
  outputPath: string;
  execute: string | null;
  headed: boolean;
  timeout: number;
  concurrency: number;
  crawl: boolean;
  maxPages: number;
  maxDepth: number;
  maxFlows: number;
  maxFlowSteps: number;
  baselinePath: string | null;
  /** Phase 9: persist this run as a baseline artifact after the run finishes. */
  writeBaselinePath: string | null;
  /** Phase 10D: rotation policy duration string (e.g. "30d"), or null. */
  baselineMaxAge: string | null;
  /** Phase 10D: rotation policy in milliseconds (parse of baselineMaxAge). */
  baselineMaxAgeMs: number | null;
  historyDir: string;
  resetHistory: boolean;
  ci: boolean;
  failOn: CiFailPolicy | null;
  /** Phase 9: threshold for NEW findings that fail the baseline gate. */
  gateMinSeverity: GateMinSeverity;
  /** Phase 8E: existing stages that can be turned off by configuration. */
  coverage: boolean;
  regression: boolean;
  rootCause: boolean;
  history: boolean;
  historicalIntelligence: boolean;
};

const VALUE_OPTIONS = new Set(["--report", "--suite", "--output", "--timeout", "--concurrency", "--max-pages", "--max-depth", "--max-flows", "--max-flow-steps", "--baseline", "--write-baseline", "--baseline-max-age", "--history-dir"]);

const optionValue = (args: string[], name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const intOption = (args: string[], name: string, fallback: number): number => {
  const value = Number(optionValue(args, name, String(fallback)));
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive number.`);
  return Math.floor(value);
};

export function parseArgs(args: string[], config: QaConfig = {}): QaOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  // Phase 8E: precedence is defaults < qa.config.json < CLI. The resolved
  // config supplies the fallback for every config-controllable value below;
  // an explicit CLI argument always wins.
  const resolved = resolveQaConfig(config);
  // A positional URL is a non-dash argument that is not the value of a value-taking
  // option (--report/--suite/--baseline/…). Without this, a report path would be
  // mistaken for a start URL and defeat the "--reset-history requires a start URL" guard.
  const valueOptions: ReadonlyArray<[string, boolean]> = [
    ["--report", true], ["--suite", true], ["--output", true], ["--baseline", true],
    ["--write-baseline", true], ["--baseline-max-age", true], ["--history-dir", true], ["--timeout", true], ["--concurrency", true],
    ["--max-pages", true], ["--max-depth", true], ["--max-flows", true], ["--max-flow-steps", true], ["--execute", false],
    ["--fail-on", true],
  ];
  const consumed = new Set<number>();
  for (const [name, always] of valueOptions) {
    const index = args.indexOf(name);
    if (index >= 0 && (always || (args[index + 1] !== undefined && !args[index + 1].startsWith("-")))) consumed.add(index + 1);
  }
  const url = args.find((value, index) => !value.startsWith("-") && !consumed.has(index)) ?? null;
  const reportPath = optionValue(args, "--report", "") || null;
  const suitePath = optionValue(args, "--suite", "") || null;
  const outputPath = resolve(optionValue(args, "--output", "reports/qa-analysis.json"));
  const headed = args.includes("--headed");
  const timeout = Number(optionValue(args, "--timeout", "30000"));
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error("--timeout must be a positive number.");
  const concurrency = Math.floor(Number(optionValue(args, "--concurrency", "5")));
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive number.");
  const crawl = args.includes("--crawl");
  const maxPages = intOption(args, "--max-pages", resolved.maxPages);
  const maxDepth = intOption(args, "--max-depth", 3);
  const maxFlows = intOption(args, "--max-flows", 20);
  const maxFlowSteps = intOption(args, "--max-flow-steps", 6);

  let execute: string | null = null;
  const executeIndex = args.indexOf("--execute");
  if (executeIndex >= 0) {
    const candidate = args[executeIndex + 1];
    if (candidate && !candidate.startsWith("-") && !VALUE_OPTIONS.has(candidate)) execute = candidate;
    else execute = DEFAULT_VERIFICATION_SPEC;
    if (execute === "none") execute = null;
  } else if (resolved.execution) {
    // Phase 8E: configuration enables the executor by default. An explicit
    // `--execute none` (handled above) still wins.
    execute = DEFAULT_VERIFICATION_SPEC;
  }

  if (!url && !reportPath) throw new Error(`A URL or --report path is required.\n\n${help}`);
  const baselinePath = optionValue(args, "--baseline", "") || resolved.baselinePath || null;
  const historyDir = resolve(optionValue(args, "--history-dir", DEFAULT_HISTORY_DIR));
  const resetHistoryFlag = args.includes("--reset-history");
  const failOnIndex = args.indexOf("--fail-on");
  let failOn: CiFailPolicy | null = null;
  let cliFailOn = false;
  if (failOnIndex >= 0) {
    const candidate = args[failOnIndex + 1];
    if (candidate === undefined || candidate.startsWith("-")) throw new Error(`--fail-on requires a value: ${CI_FAIL_POLICIES.join(" | ")}.`);
    failOn = parseCiFailPolicy(candidate);
    cliFailOn = true;
  } else {
    // Phase 8E: the config supplies the default policy; it only takes effect
    // in CI mode (`--ci`). Configuration never enables CI on its own.
    failOn = resolved.failOn;
  }
  const ci = args.includes("--ci") || cliFailOn;
  const writeBaselinePath = optionValue(args, "--write-baseline", "") || null;
  // Phase 10D: rotation policy. CLI flag wins; otherwise the config value
  // (validated at config load). Parsed eagerly so an invalid duration is a
  // hard usage error before any pipeline work.
  const baselineMaxAge = optionValue(args, "--baseline-max-age", "") || resolved.baselineMaxAge || null;
  const baselineMaxAgeMs = baselineMaxAge != null ? parseBaselineMaxAge(baselineMaxAge) : null;

  // Phase 11B — artifact-boundary guards. These are PURE usage validation:
  // they never write a file, and they make it impossible for a run to:
  //   1. parse a dash token as a value-option path (the old bare
  //      `--write-baseline --execute …` form silently created `<cwd>\--execute`),
  //   2. write its report over the baseline it loads (`--output` == `--baseline`),
  //   3. write its report over the baseline it publishes (`--output` ==
  //      `--write-baseline`, or over the sidecar path),
  //   4. publish a baseline over the very artifact it compares against.
  for (const name of ["--report", "--suite", "--output", "--baseline", "--write-baseline", "--baseline-max-age", "--history-dir"]) {
    const index = args.indexOf(name);
    if (index >= 0 && (args[index + 1] === undefined || args[index + 1].startsWith("-"))) {
      throw new Error(`${name} requires a value (a file path or argument), got ${args[index + 1] === undefined ? "(missing)" : args[index + 1]}.`);
    }
  }
  const outputIs = (value: string | null, what: string): void => {
    if (value == null) return;
    if (resolve(value) === outputPath) {
      throw new Error(`--output <path> must not be ${what} (${outputPath}) — the report write would overwrite it.`);
    }
  };
  outputIs(baselinePath, "the loaded --baseline artifact");
  outputIs(writeBaselinePath, "the --write-baseline target");
  if (writeBaselinePath) {
    const sidecar = `${resolve(writeBaselinePath)}.meta.json`;
    outputIs(sidecar, `the --write-baseline sidecar (${sidecar})`);
    if (baselinePath && resolve(baselinePath) === resolve(writeBaselinePath)) {
      throw new Error(`--write-baseline <path> must not be the --baseline artifact (${resolve(writeBaselinePath)}) — publishing would replace the baseline being compared against.`);
    }
  }

  return {
    url, reportPath, suitePath, outputPath, execute, headed, timeout, concurrency, crawl, maxPages, maxDepth, maxFlows, maxFlowSteps, baselinePath, writeBaselinePath, baselineMaxAge, baselineMaxAgeMs, historyDir, resetHistory: resetHistoryFlag, ci, failOn,
    gateMinSeverity: resolved.gateMinSeverity,
    coverage: resolved.coverage,
    regression: resolved.regression,
    rootCause: resolved.rootCause,
    history: resolved.history,
    historicalIntelligence: resolved.historicalIntelligence,
  };
}

async function attachCoverage(analysis: QaAnalysis, provider: AIProvider): Promise<QaAnalysis> {
  const discovery = analysis.flowDiscovery;
  if (!discovery) return analysis;
  const coverage = buildCoverage({
    report: analysis.scan,
    flowDiscovery: discovery,
    findings: analysis.findings,
    verifications: analysis.verifications,
  });
  let finalCoverage = coverage;
  if (provider.mode === "ai-enhanced" && typeof provider.analyzeCoverage === "function") {
    try {
      const digest = coverageDigest({ url: analysis.scan.scan.url, title: analysis.scan.scan.title }, coverage.items, coverage.testPlan);
      const enhancement = await provider.analyzeCoverage(digest, { url: analysis.scan.scan.url, title: analysis.scan.scan.title });
      finalCoverage = applyCoverageNotes(coverage, enhancement, enhancement ? provider.name : null);
      if (enhancement?.prioritization?.length) console.log(`AI coverage: ${enhancement.prioritization.length} recommendation(s) reprioritized via ${provider.name} (deterministic fallback applied otherwise).`);
    } catch { finalCoverage = applyCoverageNotes(coverage, null, null); }
  } else {
    finalCoverage = applyCoverageNotes(coverage, null, null);
  }
  return { ...analysis, coverage: finalCoverage, summary: { ...analysis.summary, coverageSummary: finalCoverage.summary } };
}

const regressionPrintOrder: ChangeClassification[] = [
  "REGRESSION",
  "INFRASTRUCTURE_PROBLEM",
  "REVIEW_REQUIRED",
  "COVERAGE_CHANGED",
  "FIXED",
  "NEW",
  "REMOVED_FLOW",
  "CHANGED_FLOW",
  "NEW_FLOW",
  "CHANGED",
];

function printRegression(map: RegressionMap): void {
  const { summary } = map;
  if (!summary.comparable) {
    console.log(`Regression comparison: not comparable — ${summary.notComparableReason ?? "unknown reason"}.`);
    return;
  }
  console.log("Regression comparison:");
  console.log(`  ${summary.headline}`);
  for (const key of regressionPrintOrder) {
    const count = summary.counts[key];
    if (count > 0) console.log(`  ${key}: ${count}`);
  }
  console.log(`  baseline: ${map.runs.baseline.runId} (${map.runs.baseline.scannedAt}${map.baselinePath ? `, ${map.baselinePath}` : ""}) · current: ${map.runs.current.runId} (${map.runs.current.scannedAt})`);
  const meaningful = map.changes.filter(change => change.classification !== "UNCHANGED" && change.classification !== "UNCHANGED_FLOW");
  for (const change of meaningful.slice(0, 20)) {
    console.log(`  ${change.changeId} [${change.classification}] (${change.confidence}) ${change.summary}`);
  }
  if (meaningful.length > 20) console.log(`  … and ${meaningful.length - 20} more (full list in the HTML report).`);
}

function regressionDigestOf(map: RegressionMap, analysis: QaAnalysis): RegressionDigest {
  return {
    url: analysis.scan.scan.url,
    title: analysis.scan.scan.title,
    comparable: map.summary.comparable,
    counts: map.summary.counts,
    changes: map.changes.map(change => ({
      changeId: change.changeId,
      category: change.category,
      classification: change.classification,
      confidence: change.confidence,
      summary: change.summary,
    })),
  };
}

function printIntelligence(map: IntelligenceMap): void {
  const { summary, investigationQueue } = map;
  console.log("QA Intelligence:");
  console.log(`  root-cause candidates: ${summary.candidates} (actionable ${summary.actionable}, investigation required ${summary.investigationRequired}, insufficient evidence ${summary.insufficientEvidence}, informational ${summary.informational})`);
  console.log(`  high confidence: ${summary.highConfidence} · evidence relationships: ${summary.relationships} · contradictions found: ${summary.contradictions}`);
  if (summary.candidates === 0) {
    console.log("  None — the evidence does not support clustering any signals yet.");
  }
  for (const entry of investigationQueue.slice(0, 8)) {
    console.log(`  ${entry.entryId} [${entry.priority}] ${entry.title} — ${entry.priorityReason}`);
  }
  if (investigationQueue.length > 8) console.log(`  … and ${investigationQueue.length - 8} more (full list in the HTML report).`);
}

function printHistoricalIntelligence(map: HistoricalIntelligenceMap): void {
  const { summary } = map;
  console.log("Historical intelligence:");
  console.log(`  status ${map.status} — ${summary.orderedRuns} ordered run(s) analyzed${summary.unorderedRuns ? `, ${summary.unorderedRuns} run(s) excluded from patterns` : ""}.`);
  if (summary.dateRange.firstRunStartedAt) {
    console.log(`  window: ${summary.dateRange.firstRunStartedAt} → ${summary.dateRange.latestRunCompletedAt ?? "still running"}.`);
  }
  const findings = summary.findings;
  console.log(`  findings: ${findings.observed} tracked — new ${findings.new}, persisting ${findings.persisting}, disappeared ${findings.disappeared}, reappeared ${findings.reappeared}, recurring ${findings.recurring}, intermittent ${findings.intermittent}, changed ${findings.changed}, unchanged ${findings.unchanged}, review required ${findings.reviewRequired}, insufficient evidence ${findings.insufficientEvidence}.`);
  if (summary.flows.observed > 0) {
    const flows = summary.flows;
    console.log(`  flows: ${flows.observed} tracked — stable ${flows.stable}, variable ${flows.variable}, unstable ${flows.unstable}, recurring failures ${flows.recurringFailures}${flows.insufficientEvidence ? `, insufficient evidence ${flows.insufficientEvidence}` : ""}.`);
  }
  if (summary.coverage.trends > 0) {
    const coverage = summary.coverage;
    console.log(`  coverage: ${coverage.trends} trends — newly tested ${coverage.newlyTested}, gained ${coverage.gained}, lost ${coverage.lost}, persistently untested ${coverage.persistentlyUntested}, changed ${coverage.changed}, stable ${coverage.stable}.`);
  }
  if (summary.infrastructure.recurringCount > 0) console.log(`  recurring infrastructure: ${summary.infrastructure.recurringCount} signal(s).`);
  if (summary.relationships > 0) console.log(`  relationships: ${summary.relationships} typed relation(s).`);
  if (map.investigationQueue.length > 0) {
    console.log(`  investigation queue: ${map.investigationQueue.length} entry(ies).`);
    for (const entry of map.investigationQueue.slice(0, 8)) {
      console.log(`    ${entry.entryId} [${entry.priority}] ${entry.title} — ${entry.priorityReason}`);
    }
    if (map.investigationQueue.length > 8) console.log(`    … and ${map.investigationQueue.length - 8} more (full list in the HTML report).`);
  }
  for (const limitation of map.limitations.slice(0, 4)) console.log(`  limitation: ${limitation}`);
  if (map.aiNotes?.headline) console.log(`  AI headline: ${map.aiNotes.headline}`);
}

function printCoverage(analysis: QaAnalysis): void {
  const coverage = analysis.coverage;
  if (!coverage) return;
  const { summary } = coverage;
  console.log("Coverage:");
  console.log(`  pages: ${summary.pages.tested}/${summary.pages.discovered} tested (${summary.pages.partial} partial, ${summary.pages.untested} untested, ${summary.pages.blocked} blocked, ${summary.pages.review} review)`);
  console.log(`  flows: ${summary.flows.executed}/${summary.flows.discovered} executed (${summary.flows.passed} passed, ${summary.flows.reproduced} reproduced, ${summary.flows.notReproduced} not reproduced, ${summary.flows.review} review, ${summary.flows.blocked} blocked)`);
  console.log(`  findings: ${summary.findings.verified}/${summary.findings.analyzed} verified (${summary.findings.reproduced} reproduced, ${summary.findings.notReproduced} not reproduced, ${summary.findings.unverified} unverified)`);
  console.log(`  interactions: ${summary.interactions.tested} tested / ${summary.interactions.partial} partial / ${summary.interactions.untested} untested / ${summary.interactions.review} review / ${summary.interactions.notApplicable} n/a`);
  console.log(`Test plan — ${coverage.testPlan.length} recommendation(s):`);
  for (const rec of coverage.testPlan.slice(0, 12)) {
    console.log(`  ${rec.recommendationId} [${rec.priority}] ${rec.title}`);
  }
  if (coverage.testPlan.length > 12) console.log(`  … and ${coverage.testPlan.length - 12} more (full list in the HTML report).`);
  if (coverage.aiNotes?.gaps.length) {
    console.log("Coverage gaps:");
    for (const gap of coverage.aiNotes.gaps) console.log(`  - ${gap}`);
  }
}

function writeExecutionArtifact(analysis: QaAnalysis, skipped: TaskSkip[], results: VerificationResult[], outputPath: string): string {
  const filePath = join(dirname(outputPath), "qa-execution.json");
  atomicWriteText(filePath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: analysis.generatedAt,
    url: analysis.scan.scan.url,
    title: analysis.scan.scan.title,
    mode: analysis.mode,
    aiProvider: analysis.aiProvider,
    execution: analysis.execution,
    scheduled: results.length + skipped.length,
    skipped,
    verifications: results,
    dispositions: Object.fromEntries(
      analysis.findings.map(finding => [finding.id, finding.verification]),
    ),
    summary: {
      verified: analysis.summary.verified,
      reproduced: analysis.summary.reproduced,
      notReproduced: analysis.summary.notReproduced,
      pass: analysis.summary.pass,
      reviewRequired: analysis.summary.reviewRequired,
      infrastructureProblems: analysis.summary.infrastructureProblems,
      scheduled: analysis.summary.scheduled,
      executed: analysis.summary.executed,
      skippedUnsupported: analysis.summary.skippedUnsupported,
      skippedLocatorGuard: analysis.summary.skippedLocatorGuard,
      skippedSafety: analysis.summary.skippedSafety,
      unverified: analysis.summary.unverified,
    },
  }, null, 2));
  return filePath;
}

export async function main(): Promise<void> {
  // The executor/flow modules capture process.env at import time to build their
  // redactors. dotenv already ran at the top of this module, but re-seeding here
  // guarantees the redactor reflects the final environment even if an import
  // order changes later.
  refreshVerificationRedactor(process.env);
  refreshFlowRedactor(process.env);

  const args = process.argv.slice(2);
  if (args[0] === "verify" || args[0] === "verify-baseline") {
    // Phase 10: offline baseline verification. Fully self-contained so the
    // 0/1/2 model holds — a pipeline-free tool never leaks into the generic
    // (non-CI) exit-1 error path below.
    const target = args[1];
    const wantsHelp = args.includes("--help") || args.includes("-h");
    if (wantsHelp || !target) {
      console.log(verifyHelp);
      process.exitCode = !wantsHelp ? BASELINE_VERIFY_EXIT_FAILURE : BASELINE_VERIFY_EXIT_OK;
      return;
    }
    const verification = verifyBaseline(target);
    console.log(formatBaselineVerification(verification));
    process.exitCode = verification.ok ? BASELINE_VERIFY_EXIT_OK : BASELINE_VERIFY_EXIT_FAILURE;
    return;
  }
  if (args[0] === "serve" || args[0] === "dash") {
    const index = args.indexOf("--dir");
    const reportDir = index >= 0 && args[index + 1] ? args[index + 1] : "reports";
    const historyIndex = args.indexOf("--history-dir");
    const historyDir = historyIndex >= 0 && args[historyIndex + 1] ? args[historyIndex + 1] : DEFAULT_HISTORY_DIR;
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 && args[portIndex + 1] ? Number(args[portIndex + 1]) : 4173;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535.");
    const hostIndex = args.indexOf("--host");
    const maxAgeIndex = args.indexOf("--baseline-max-age");
    const baselineMaxAge = maxAgeIndex >= 0 && args[maxAgeIndex + 1] ? args[maxAgeIndex + 1] : null;
    if (baselineMaxAge != null) parseBaselineMaxAge(baselineMaxAge);
    const dashboardOptions: DashboardOptions = {
      reportDir,
      historyDir,
      host: hostIndex >= 0 && args[hostIndex + 1] ? args[hostIndex + 1] : "127.0.0.1",
      port,
      baselineMaxAge,
    };
    serveUntilClosed(dashboardOptions).catch(error => { console.error(`Dashboard failed to start: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
    return;
  }

  if (args.includes("--help") || args.includes("-h")) { console.log(help); return; }

  // Phase 8E: load the optional qa.config.json (validated) BEFORE any pipeline
  // work, then let CLI arguments override it.
  const loaded = loadQaConfig({ cwd: process.cwd() });
  const options = parseArgs(args, loaded.config);
  if (!options) { console.log(help); return; }

  // Structured stage events travel on a sidecar file next to the report
  // artifacts, mirroring how the execution artifact is derived. Human stdout is
  // untouched.
  stageEvents = createStageEventEmitter(join(dirname(options.outputPath), STAGE_EVENT_FILENAME));

  console.log("");
  console.log(`QA RUN — ${options.url ?? options.reportPath ?? "report"}`);
  console.log("─".repeat(Math.max(12, (options.url ?? options.reportPath ?? "report").length)));
  console.log(`Configuration: ${loaded.source ? loaded.sourceLabel : "defaults"}`);

  if (options.resetHistory) {
    if (!options.url) throw new Error("--reset-history requires a start URL — run history is per-site and needs a site to resume.");
    const reset = resetHistory(options.historyDir);
    console.log(`History reset: ${reset.removed.length} file(s) removed from ${reset.historyDir}.`);
  }

  let report: ScanReport;
  let reportPathForSuite: string;
  let executionArtifactPath: string | null = null;
  if (options.reportPath) {
    report = JSON.parse(readFileSync(options.reportPath, "utf8")) as ScanReport;
    reportPathForSuite = options.reportPath;
    console.log(`Loaded scan report: ${options.reportPath}`);
  } else {
    if (!options.url) throw new Error("A URL is required.");
    startStage("scan");
    const scanned = await scanWebsite({ url: options.url, headed: options.headed, timeout: options.timeout, outputPath: "reports/qa-report.json", concurrency: options.concurrency });
    report = scanned.report;
    reportPathForSuite = scanned.jsonPath;
    completeStage("scan");
    console.log(`Scan complete: ${report.summary.totalElements} elements, ${report.summary.interactiveElements} interactive, HTTP ${report.scan.navigationStatus ?? "unknown"} (${report.summary.failures} failures, ${report.summary.warnings} warnings).`);
    if (report.access) console.log(`Access: ${report.access.accessStatus} · authentication ${report.access.authenticationType} · continue scan ${report.access.continueScan} · human review ${report.access.humanReview}.`);
  }

  // The scanner reports the access prerequisite alongside the scan itself, so
  // the access decision is settled here rather than inside the scan window.
  startStage("access");
  const accessBlocked = report.access != null && !report.access.continueScan;
  completeStage("access");
  let suite: GeneratedTestSuite | null;
  if (accessBlocked) {
    suite = null;
    console.log(`Normal QA scan: not run — access prerequisite (${report.access?.accessStatus}) requires human review.`);
    const ap = report.accessPrerequisite ?? {
      type: report.access?.accessStatus ?? "unknown",
      status: report.access?.accessStatus === "access-blocked" ? "BLOCKED" : "REVIEW_REQUIRED",
      message: report.access?.reason ?? "Access prerequisite requires human review.",
      httpStatus: report.access?.httpStatus ?? null,
      challenge: report.access?.challenge ?? null,
    };
    console.log("Access prerequisite:");
    console.log(`  type: ${ap.type}`);
    console.log(`  status: ${ap.status}`);
    console.log(`  message: ${ap.message}`);
  } else if (options.suitePath) {
    suite = JSON.parse(readFileSync(options.suitePath, "utf8")) as GeneratedTestSuite;
    console.log(`Loaded generated suite: ${options.suitePath}`);
  } else {
    startStage("generate");
    suite = generateTestSuite(report, { sourcePath: reportPathForSuite });
    completeStage("generate");
    console.log(`Generated suite: ${suite.counts.total} scenarios (${suite.counts.automated} automated, ${suite.counts.review} review, ${suite.counts.highRisk} high-risk, ${suite.counts.conditional} conditional).`);
  }

  const provider = createAIProvider();
  console.log(`AI provider: ${provider.name} (${provider.mode}${provider.apiKeyPresent ? "" : ", no AI_API_KEY configured"})`);

  const flowLimits: FlowLimits = {
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    maxNavigationActions: Math.max(60, options.maxPages * 6),
    maxFlows: options.maxFlows,
    maxFlowSteps: options.maxFlowSteps,
    maxExecutionMs: 120000,
  };
  let siteGraph: SiteGraph | null = null;
  if (options.crawl && !accessBlocked) {
    if (!options.url) throw new Error("--crawl requires a start URL (not just --report).");
    // Site discovery feeds the analyzer, so the crawl belongs to the analyze
    // stage rather than a stage of its own.
    startStage("analyze");
    const crawl = await crawlSite({ url: options.url, headed: options.headed, timeout: options.timeout, concurrency: options.concurrency, limits: flowLimits });
    siteGraph = crawl.graph;
    completeStage("analyze");
    console.log(`Crawl complete: ${crawl.pages.length} page(s) discovered (limits: ${flowLimits.maxPages} pages, depth ${flowLimits.maxDepth}, actions ${flowLimits.maxNavigationActions}).`);
    for (const page of crawl.pages) {
      console.log(`  ${page.url} ("${page.title ?? "no title"}", ${page.brokenLinks} broken links)`);
    }
  }

  startStage("analyze");
  let analysis = await analyzeScan(report, { suite, provider, flowLimits, siteGraph: siteGraph ?? undefined, coverage: options.coverage });
  completeStage("analyze");
  const flowSummary = analysis.flowDiscovery?.summary;
  if (flowSummary) {
    console.log(`Flows: ${flowSummary.flows} discovered (${flowSummary.executable} executable, ${flowSummary.review} review, ${flowSummary.highRisk} high-risk, ${flowSummary.blocked} blocked) on ${flowSummary.pages} page(s).`);
  }

  if (options.execute && !accessBlocked) {
        const isVerificationRun = resolve(options.execute) === resolve(DEFAULT_VERIFICATION_SPEC);
    if (!isVerificationRun && suite) {
      // Element-suite path: executes the generated spec through generic Playwright.
      // This path is NOT guarded by the locator safety layer (buildVerificationTasks /
      // isSafeLocator / SKIPPED_* dispositions) — only the verification path is.
      console.log(`Generating element suite spec: ${options.execute}`);
      startStage("generate");
      generatePlaywrightSpec(suite, options.execute);
      completeStage("generate");
      console.log(`Executing spec: ${options.execute}`);
      startStage("execute");
      analysis.execution = runPlaywright(options.execute);
      completeStage("execute");
    } else {
      const distEntry = resolve(process.cwd(), "dist", "executor", "verify.js");
      if (!existsSync(distEntry)) {
        throw new Error(`The EXECUTOR build is missing (${distEntry}). Run "npm run build" before --execute.`);
      }
      // Building the task layer, rendering the spec and running it are all the
      // execution stage; the verdicts applied to the analysis below are verify.
      startStage("execute");
      const layer = buildVerificationTasks(analysis.findings, report);
      const tasks = layer.tasks;
      console.log(`Verification: ${tasks.length} finding(s) scheduled, ${layer.skipped.length} skipped.`);
      for (const skip of layer.skipped) {
        console.log(`  SKIPPED ${skip.findingId} (${skip.code}) — ${skip.cause}: ${skip.reason}`);
      }
      renderVerificationSpec(report, tasks, DEFAULT_VERIFICATION_SPEC);
      console.log(`Executing verification spec: ${DEFAULT_VERIFICATION_SPEC}`);
      const run = runVerificationSpec(DEFAULT_VERIFICATION_SPEC, tasks);
      let results = run.results;
      if (results.length && typeof provider.triageVerifications === "function") {
        try {
          const triaged = await provider.triageVerifications(results, { url: report.scan.url, title: report.scan.title });
          if (triaged) {
            const refined = triaged.filter(item => item.triage?.provider !== "deterministic").length;
            results = triaged;
            if (refined > 0) console.log(`AI triage: ${refined} verdict(s) refined via ${provider.name} (fallback remains deterministic).`);
          }
        } catch { /* keep the deterministic verdicts */ }
      }
      completeStage("execute");

      startStage("verify");
      analysis = applyVerification(analysis, {
        tasks,
        skipped: layer.skipped,
        results,
        execution: run.execution,
      });
      const executionPath = writeExecutionArtifact(analysis, layer.skipped, results, options.outputPath);
      executionArtifactPath = executionPath;
      console.log(`Execution report: ${executionPath}`);
      const { summary } = analysis;
      console.log(`Verification disposition:`);
      console.log(`  scheduled: ${summary.scheduled}`);
      console.log(`  executed: ${summary.executed}`);
      console.log(`  reproduced: ${summary.reproduced}`);
      console.log(`  not reproduced: ${summary.notReproduced}`);
      console.log(`  passed: ${summary.pass}`);
      console.log(`  review required: ${summary.reviewRequired}`);
      console.log(`  skipped unsupported: ${summary.skippedUnsupported}`);
      console.log(`  skipped locator guard: ${summary.skippedLocatorGuard}`);
      console.log(`  skipped safety: ${summary.skippedSafety}`);
      console.log(`  infrastructure problems: ${summary.infrastructureProblems}`);
      for (const result of results) {
        if (result.status === "REPRODUCED" || result.status === "REVIEW") {
          const detail = result.category ? ` [${result.category}]` : "";
          const detail2 = result.triage ? ` — ${result.triage.reason}` : "";
          console.log(`  ${result.scenarioId} ${result.status}${detail}: ${result.findingId} (${result.strategy})${detail2}`);
        }
      }

      // Phase 3: run executable user flows and attach their safe outcome files.
      const flowDiscovery = analysis.flowDiscovery;
      if (flowDiscovery && flowDiscovery.flows.some(flow => flow.executable)) {
        renderFlowSpec(report, flowDiscovery.flows, flowDiscovery.limits, DEFAULT_FLOW_SPEC);
        runPlaywright(DEFAULT_FLOW_SPEC);
        const flowResults = loadFlowResults(flowDiscovery.flows);
        const refinedDiscovery = attachFlowExecutions(flowDiscovery, flowResults);
        analysis = { ...analysis, flowDiscovery: refinedDiscovery, summary: { ...analysis.summary, flowSummary: refinedDiscovery.summary } };
        const fs = refinedDiscovery.summary;
        console.log(`Flow execution: ${fs.executed} flow(s) run — ${fs.passed} passed, ${fs.reproduced} reproduced, ${fs.notReproduced} not reproduced, ${fs.reviewRequired} review required, ${fs.infrastructure} infrastructure.`);
        if (!analysis.accessPrerequisite) analysis = { ...analysis, summary: { ...analysis.summary, ...explainStatus(analysis) } };
      } else if (analysis.flowDiscovery) {
        console.log("Flow execution: no executable flows — every discovered step is REVIEW/HIGH_RISK/BLOCKED.");
      }
      completeStage("verify");
    }
  }

  startStage("coverage");
  if (accessBlocked) {
    console.log("Coverage: blocked/review — inaccessible content was not counted as tested.");
  } else if (options.coverage) {
    analysis = await attachCoverage(analysis, provider);
    printCoverage(analysis);
  } else {
    console.log("Coverage: skipped — disabled by configuration (coverage.enabled = false).");
  }
  completeStage("coverage");

  // Phase 10D: rotation verdict, set when a baseline + policy are both present.
  let rotationFailed = false;
  let rotationMessage: string | null = null;

  if (options.baselinePath && options.regression && !accessBlocked) {
    const baseline = loadBaseline(options.baselinePath);
    console.log(`Regression baseline: ${baseline.path}`);
    console.log(
      `  provenance: run ${baseline.provenance.runId ?? "(none)"} · generated ${baseline.provenance.generatedAt}${baseline.provenance.sourceUrl ? ` · source ${baseline.provenance.sourceUrl}` : ""}`,
    );
    console.log(
      baseline.integrity === "VERIFIED"
        ? `  integrity: verified — sha256 ${baseline.meta?.digest?.slice(0, 12)}…`
        : `  integrity: legacy artifact — no ${basename(baselineMetaPathOf(baseline.path))} sidecar (structure validated; digest not verifiable)`,
    );
    console.log(`  age: ${formatBaselineAge(baseline.age)}`);
    if (options.baselineMaxAgeMs != null) {
      const staleness = baselineStalenessOf(baseline.age, options.baselineMaxAgeMs);
      if (staleness === "STALE") {
        rotationFailed = true;
        rotationMessage = `CI rotation: FAIL — baseline ${basename(baseline.path)} is stale (${formatBaselineAge(baseline.age)}) vs the ${options.baselineMaxAge} rotation policy. Re-publish it with --write-baseline.`;
        console.log(`  rotation: STALE — baseline exceeds the ${options.baselineMaxAge} rotation policy; re-publish with --write-baseline.`);
      } else if (staleness === "FRESH") {
        console.log(`  rotation: fresh — within the ${options.baselineMaxAge} rotation policy.`);
      } else {
        console.log(`  rotation: unknown — no usable timestamp in the baseline; the ${options.baselineMaxAge} rotation policy cannot be evaluated.`);
      }
    }
    let regression = compareRuns(analysis, baseline.analysis, { baselinePath: options.baselinePath });
    if (provider.mode === "ai-enhanced" && typeof provider.analyzeRegression === "function") {
      try {
        const enhancement = await provider.analyzeRegression(regressionDigestOf(regression, analysis), { url: report.scan.url, title: report.scan.title });
        regression = applyRegressionNotes(regression, enhancement, enhancement ? provider.name : null);
        if (regression.aiNotes && (regression.aiNotes.headline || regression.aiNotes.notes?.length)) {
          console.log(`AI regression: comparison preserved; headline/notes refined via ${provider.name}.`);
        }
      } catch {
        regression = applyRegressionNotes(regression, null, null);
      }
    }
    analysis = { ...analysis, regression };
    printRegression(regression);
  } else if (options.baselinePath && !options.regression && !accessBlocked) {
    console.log("Regression comparison: skipped — disabled by configuration (regression.enabled = false).");
  } else {
    console.log("Regression comparison: not available — no baseline supplied.");
  }

  if (options.rootCause) {
    let intelligence = buildIntelligence({ analysis });
    if (provider.mode === "ai-enhanced" && typeof provider.analyzeIntelligence === "function") {
      try {
        const enhancement = await provider.analyzeIntelligence(intelligenceDigestOf(intelligence, analysis), { url: report.scan.url, title: report.scan.title });
        intelligence = applyIntelligenceNotes(intelligence, enhancement, enhancement ? provider.name : null);
        if (intelligence.aiNotes?.wording?.length) {
          console.log(`AI intelligence: candidate wording refined via ${provider.name} (evidence, confidence, statuses, and actions unchanged).`);
        }
      } catch {
        intelligence = applyIntelligenceNotes(intelligence, null, null);
      }
    }
    analysis = { ...analysis, intelligence };
    printIntelligence(intelligence);
  } else {
    console.log("QA Intelligence: skipped — disabled by configuration (rootCause.enabled = false).");
  }

  // Phase 7A: persist this run and attach the additive history section.
  startStage("history");
  const siteKey = historySiteKeyOf(analysis);
  const siteIdentity = historySiteIdentityOf(analysis);
  let persisted: ReturnType<typeof persistRun> | null = null;
  let historySection: HistoryReportSection;
  if (options.history) {
    persisted = persistRun(analysis, siteKey, options.historyDir, { startedAt: analysis.generatedAt, completedAt: new Date().toISOString() });
    if (persisted.persisted) {
      const siteHistory = loadSiteHistory(siteKey, options.historyDir);
      const runsAvailable = siteHistory.status === "AVAILABLE" ? siteHistory.state!.runs.length : persisted.runsAvailable;
      historySection = {
        status: "AVAILABLE",
        schemaVersion: HISTORY_SCHEMA_VERSION,
        siteIdentity,
        currentRunId: persisted.runId,
        runsAvailable,
        historyDir: persisted.historyDir,
        note: "This run was persisted to the QA run history.",
      };
      console.log(`History: run ${persisted.runId} persisted to ${persisted.historyDir} (${runsAvailable} run(s) for this site).`);
    } else {
      historySection = {
        status: persisted.status,
        schemaVersion: HISTORY_SCHEMA_VERSION,
        siteIdentity,
        currentRunId: null,
        runsAvailable: 0,
        historyDir: persisted.historyDir,
        note: persisted.reason ?? "Run history is unavailable.",
      };
      console.log(`History: not persisted — ${persisted.reason}`);
    }
  } else {
    historySection = {
      status: "UNAVAILABLE",
      schemaVersion: HISTORY_SCHEMA_VERSION,
      siteIdentity,
      currentRunId: null,
      runsAvailable: 0,
      historyDir: options.historyDir,
      note: "Run history is disabled by configuration (history.enabled = false); this run was not persisted.",
    };
    console.log("History: skipped — disabled by configuration (history.enabled = false); this run was not persisted.");
  }
  analysis = { ...analysis, history: historySection };

  // Phase 7B: deterministic historical intelligence over the persisted runs.
  let historicalIntelligence: HistoricalIntelligenceMap | null = null;
  if (options.historicalIntelligence && historySection.status === "AVAILABLE") {
    const loadedForTrends = loadSiteHistory(siteKey, options.historyDir);
    if (loadedForTrends.status === "AVAILABLE" && loadedForTrends.state) {
      historicalIntelligence = historicalIntelligenceForRuns({
        runs: loadedForTrends.state.runs,
        historyDir: options.historyDir,
        siteIdentity,
        currentRunId: persisted?.runId ?? null,
      });
      if (historicalIntelligence && provider.mode === "ai-enhanced" && typeof provider.analyzeHistoricalIntelligence === "function") {
        try {
          const enhancement = await provider.analyzeHistoricalIntelligence(
            buildHistoricalIntelligenceDigest(historicalIntelligence),
            { url: report.scan.url, title: report.scan.title },
          );
          historicalIntelligence = applyHistoricalIntelligenceNotes(historicalIntelligence, enhancement ?? {}, enhancement ? provider.name : null);
          if (historicalIntelligence.aiNotes?.headline) {
            console.log(`AI historical intelligence: headline refined via ${provider.name} (classifications, confidence, and queue unchanged).`);
          }
        } catch { /* deterministic historical intelligence remains authoritative */ }
      }
      if (historicalIntelligence) printHistoricalIntelligence(historicalIntelligence);
    }
  } else if (!options.historicalIntelligence) {
    console.log("Historical intelligence: skipped — disabled by configuration (historicalIntelligence.enabled = false).");
  }
  analysis = { ...analysis, historicalIntelligence: historicalIntelligence ?? undefined };

  // Phase 8E: record the resolved configuration with the run artifact (spec §15).
  const configuration: QaConfigurationSnapshot = {
    source: loaded.source ? loaded.sourceLabel : "defaults",
    path: loaded.source,
    resolved: {
      crawlMaxPages: options.maxPages,
      execution: options.execute !== null,
      coverage: options.coverage,
      regression: options.regression,
      rootCause: options.rootCause,
      history: options.history,
      historicalIntelligence: options.historicalIntelligence,
      ciFailOn: options.failOn,
      ciGateMinSeverity: options.gateMinSeverity,
      baselineMaxAge: options.baselineMaxAge,
      baselinePath: options.baselinePath,
    },
  };
  analysis = { ...analysis, configuration };
  completeStage("history");

  // Final status recomputation: a run that executed flows but scheduled no
  // verification tasks is PASS (or FAIL/REVIEW by finding severity), never
  // NOT_TESTED. Access-prerequisite runs keep their status. explainStatus also
  // refreshes the headline so it always describes what actually executed.
  if (!analysis.accessPrerequisite) {
    analysis = { ...analysis, summary: { ...analysis.summary, ...explainStatus(analysis) } };
  }

  // Surface degraded AI stages instead of silently emitting deterministic-only
  // output. A broken or expired key used to look identical to a clean run.
  const degraded = (provider as Partial<{ failedStages: () => string[] }>).failedStages;
  if (typeof degraded === "function") {
    const failed = degraded.call(provider);
    if (failed.length) {
      console.warn(`AI provider: ${failed.length} stage(s) returned no enhancement (${failed.join(", ")}). Results are deterministic-only; check AI_API_KEY/AI_API_URL/AI_MODEL and network access.`);
    }
  }

  const paths = writeQaReport(analysis, options.outputPath);
  // The run has produced every artifact it is going to produce.
  startStage("complete");
  completeStage("complete");

  // Phase 9B: adopt this run as a baseline artifact (sidecar meta, no overwrite).
  if (options.writeBaselinePath) {
    const target = resolve(options.writeBaselinePath);
    if (existsSync(target)) {
      throw new Error(`--write-baseline refuses to overwrite an existing baseline: ${target} (remove the file to replace it).`);
    }
    mkdirSync(dirname(target), { recursive: true });
    const text = JSON.stringify(analysis, null, 2);
    const digest = createHash("sha256").update(text).digest("hex");
    const writtenAt = new Date().toISOString();
    const meta = {
      schemaVersion: 1,
      baselinePath: target,
      writtenAt,
      runId: analysis.history?.currentRunId ?? null,
      sourceUrl: analysis.scan?.scan?.url ?? null,
      generatedAt: analysis.generatedAt,
      digest,
      note: "Baseline artifact: a QaAnalysis JSON that later `--baseline` runs compare against.",
    };
    atomicWriteText(target, text);
    atomicWriteText(`${target}.meta.json`, JSON.stringify(meta, null, 2));
    console.log(`Baseline written: ${target}`);
    console.log(`  run ${meta.runId ?? "(none)"} · generatedAt: ${meta.generatedAt} · digest: ${digest.slice(0, 12)}…`);
  }
  const { summary } = analysis;
  console.log(`QA status: ${summary.overallStatus} — ${summary.headline}`);
  if (analysis.accessPrerequisite) {
    const ap = analysis.accessPrerequisite;
    console.log("Access prerequisite:");
    console.log(`  type: ${ap.type}`);
    console.log(`  status: ${ap.status}`);
    console.log(`  message: ${ap.message}`);
    console.log(`Website findings: ${analysis.findings.length} issue groups.`);
  } else {
    console.log(`Findings: ${analysis.findings.length} issue groups (${summary.issueCount} occurrences); severity ${summary.bySeverity.CRITICAL}/C ${summary.bySeverity.HIGH}/H ${summary.bySeverity.MEDIUM}/M ${summary.bySeverity.LOW}/L ${summary.bySeverity.INFO}/I.`);
  }
  console.log(`Flows: ${summary.flowsDetected} manual; flow discovery: ${summary.flowSummary?.flows ?? 0} discovered, ${summary.flowSummary?.executed ?? 0} executed. Intent scenarios: ${summary.intentScenarios}; element scenarios: ${analysis.elementScenarios.length}.`);
  console.log(`JSON report: ${paths.jsonPath}`);
  console.log(`HTML report: ${paths.htmlPath}`);
  console.log(`History: ${options.historyDir} — ${analysis.history?.runsAvailable ?? 0} run(s) stored for this site.`);

  // Phase 11B — deterministic artifact inventory (relative paths only). The
  // run lists what it produced; the inventory renderer is a pure, stable
  // diagnostic block suitable for CI logs.
  const historyArtifacts: string[] = [];
  if (options.history) {
    if (existsSync(join(options.historyDir, "index.json"))) historyArtifacts.push(join(options.historyDir, "index.json"));
    const runsDir = join(options.historyDir, "runs");
    if (existsSync(runsDir)) {
      for (const name of readdirSync(runsDir)) if (name.endsWith(".json")) historyArtifacts.push(join(runsDir, name));
    }
  }
  console.log("");
  console.log(renderArtifactInventory(buildArtifactInventory({
    baseDir: process.cwd(),
    report: [paths.jsonPath, paths.htmlPath],
    execution: executionArtifactPath ? [executionArtifactPath] : [],
    baseline: options.writeBaselinePath ? [resolve(options.writeBaselinePath), `${resolve(options.writeBaselinePath)}.meta.json`] : [],
    history: historyArtifacts,
  })));
  if (analysis.execution) {
    const execution = analysis.execution;
    console.log(`Execution: ${execution.status} — ${execution.tests} tests, ${execution.passed} passed, ${execution.failed} failed, ${execution.skipped} skipped${execution.failures.length ? ` (${execution.failures.length} failure(s))` : ""}.`);
  }

  console.log("");
  console.log(buildQaResultBlock(qaResultInputOf(analysis, {
    url: report.scan.url,
    runId: persisted?.runId ?? null,
    jsonPath: paths.jsonPath,
    htmlPath: paths.htmlPath,
    historyPath: options.historyDir,
  })));

  // Phase 8C + 9: CI exit policy, then the Phase 9 baseline regression gate.
  // Both consume the same finished result and print their verdicts; the exit
  // code stays in the documented 0/1/2 model (a gate violation is a QA policy
  // failure, exit 1). The gate is inactive without a baseline comparison.
  if (options.ci) {
    const decision = decideCiExit(summary.overallStatus, options.failOn ?? CI_DEFAULT_FAIL_POLICY);
    const gate = evaluateGate({ regression: analysis.regression, findings: analysis.findings }, { minSeverity: options.gateMinSeverity });
    // Phase 11A: the canonical CI contract. A completed run maps to exit 0/1;
    // a baseline verification failure never reaches here (the phase 10 loader
    // throws and the top-level handler returns exit 2 in CI mode).
    // Phase 11C: the one failure-mode classifier owns the verdict — the exit
    // code and the machine-readable `Failure mode:` line always agree.
    const outcome = classifyRunOutcome({ decision, gate, rotationFailed });
    const exitCode = outcome.exitCode;
    console.log("");
    console.log(formatCiExit(decision));
    console.log("");
    console.log(formatGateVerdict(gate));
    if (rotationMessage) {
      console.log("");
      console.log(rotationMessage);
    }
    console.log("");
    console.log(exitCode === CI_EXIT_POLICY_FAILURE ? `CI: policy or gate violation → exit ${CI_EXIT_POLICY_FAILURE} (QA policy failure).` : `CI: acceptable → exit ${CI_EXIT_SUCCESS}.`);
    console.log(formatFailureModeLine(outcome.category, exitCode));
    process.exitCode = exitCode;
  }
}

if (require.main === module) {
  // Phase 8C + 11A: in CI mode a thrown pipeline/usage/environment error —
  // including every baseline verification/integrity failure from the Phase 10
  // loader (missing, malformed, invalid structure, digest mismatch) — is exit 2
  // (CI_EXIT_INFRASTRUCTURE), never the exit-1 "completed but violating" verdict.
  // Normal local runs keep their pre-8C behavior (exit 1) so existing scripts
  // are unaffected.
  const ciMode = process.argv.slice(2).some(arg => arg === "--ci" || arg === "--fail-on");
  main().catch(error => {
    // Attribute the failure to the stage that was actually running, so a
    // consumer sees which boundary broke. The error still propagates exactly
    // as before — same text, same classification, same exit code.
    failInProgressStage(error);
    // Phase 11C: classify the thrown error into the stable category and print
    // the same machine-readable `Failure mode:` line the completed-run CI block
    // prints. The exit code is unchanged — the hard-failure path keeps its
    // existing behavior exactly (2 in CI mode, 1 in a normal local run).
    const category = classifyThrownError(error);
    console.error(`QA failed: ${error instanceof Error ? error.message : error}`);
    console.error(formatFailureModeLine(category, ciMode ? CI_EXIT_INFRASTRUCTURE : CI_EXIT_POLICY_FAILURE));
    process.exitCode = ciMode ? CI_EXIT_INFRASTRUCTURE : CI_EXIT_POLICY_FAILURE;
  });
}