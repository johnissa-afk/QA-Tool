// ---------------------------------------------------------------------------
// Phase 13 — performance budgets for the QA pipeline.
//
// The comparison itself already exists: `src/perf-budgets.ts` owns the parser
// (`parsePerfBudgets`) and the pure check (`checkPerfBudgets`), and the scanner
// uses both behind its own `--perf-budgets` flag. This module is the QA-side
// half, and it deliberately does three things only:
//
//   1. load a budget file LOUDLY — a missing, unreadable, malformed, or
//      unknown-key file is a configuration failure, never a silent pass (a QA
//      gate that quietly skips its own thresholds would be worse than no gate);
//   2. apply the comparison to the report the run is about to analyze, exactly
//      once, updating the report's issue list and summary counters the same way
//      the scanner would have written them;
//   3. do it for BOTH a fresh scan and a reused `--report` artifact, so an
//      existing report can be gated against budgets without re-scanning.
//
// No new severity, status, or exit code is invented here: a breach becomes an
// ordinary FAIL issue, and the existing finding pipeline (severity rubric →
// overall status → Phase 8C policy → Phase 11C failure mode) decides the rest.
// The evaluation is skipped when an access prerequisite stopped the scan,
// because an untested page has no performance to judge.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupIssues } from "../checks.js";
import { PERF_METRIC_LABELS, checkPerfBudgets, isPerfBudgetCode, parsePerfBudgets } from "../perf-budgets.js";
import type { Issue, PerfBudgets, PerformanceMetrics, ScanReport } from "../types.js";

/** Metrics placeholder for a report that carries no performance block. */
const NO_METRICS: PerformanceMetrics = { ttfb: null, fcp: null, lcp: null, cls: null, domContentLoaded: null, loadEvent: null };

/** Every error this loader can raise starts with this phrase so the failure
 *  classifier can recognize a budget-file problem as configuration. */
export const PERF_BUDGETS_ERROR_PREFIX = "Invalid performance budgets file";

/**
 * Loads and validates a performance budgets file. Throws a clear, stable error
 * naming the file for every failure mode: missing, unreadable, malformed JSON,
 * unknown metric, negative/NaN threshold. Never returns null — "no budgets"
 * is expressed by not calling this, not by silently accepting a broken file.
 */
export function loadQaPerfBudgets(path: string): PerfBudgets {
  const source = `${PERF_BUDGETS_ERROR_PREFIX} ${JSON.stringify(path)}`;
  if (!existsSync(path)) {
    throw new Error(`${source}: the file does not exist.`);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${source}: unable to read the file (${error instanceof Error ? error.message : String(error)}).`);
  }
  // Windows editors (PowerShell `Set-Content -Encoding utf8`, Notepad) write a
  // UTF-8 BOM. JSON.parse rejects it, and reporting a valid file as "malformed
  // JSON" would send the user hunting for a syntax error that is not there.
  text = text.replace(/^\uFEFF/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: malformed JSON (${error instanceof Error ? error.message : "parse error"}).`);
  }
  return parsePerfBudgets(raw, source);
}

/**
 * Applies the budgets to a report and returns the breaches that were added.
 *
 * The report is updated in the same shape the scanner writes: issues are
 * grouped, and `summary` counters (passes/warnings/failures/infos,
 * issueGroups, groupedIssueCounts) are recomputed from the grouped list, so the
 * artifact never claims 0 failures while carrying a FAIL issue.
 *
 * Idempotent: previously applied budget issues are dropped before re-checking,
 * so calling it twice leaves the report exactly as one call would.
 */
export function applyPerfBudgets(report: ScanReport, budgets: PerfBudgets): Issue[] {
  const added = checkPerfBudgets(report.performance ?? NO_METRICS, budgets);
  const kept = report.issues.filter(issue => !isPerfBudgetCode(issue.code));
  if (added.length === 0 && kept.length === report.issues.length) return added;
  const grouped = groupIssues([...kept, ...added]);
  const occurrenceCount = (status: Issue["status"]) => grouped.filter(issue => issue.status === status).reduce((total, issue) => total + (issue.count ?? 1), 0);
  const groupCount = (status: Issue["status"]) => grouped.filter(issue => issue.status === status).length;
  report.issues = grouped;
  report.summary.issueGroups = grouped.length;
  report.summary.passes = occurrenceCount("PASS");
  report.summary.warnings = occurrenceCount("WARNING");
  report.summary.failures = occurrenceCount("FAIL");
  report.summary.infos = occurrenceCount("INFO");
  report.summary.groupedIssueCounts = {
    passes: groupCount("PASS"),
    warnings: groupCount("WARNING"),
    failures: groupCount("FAIL"),
    infos: groupCount("INFO"),
  };
  return added;
}

/** Names every configured budget with its threshold, for CLI/report output. */
export function describePerfBudgets(budgets: PerfBudgets): string {
  return (Object.keys(PERF_METRIC_LABELS) as (keyof PerfBudgets)[])
    .filter(key => budgets[key] !== undefined)
    .map(key => {
      const value = budgets[key]!;
      return `${PERF_METRIC_LABELS[key]} ${value}${key === "cls" ? "" : "ms"}`;
    })
    .join(", ");
}
