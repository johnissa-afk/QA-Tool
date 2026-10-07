import { existsSync, readFileSync } from "node:fs";
import { Issue, PerfBudgets, PerformanceMetrics } from "./types.js";

export const PERF_METRIC_LABELS: Record<keyof PerfBudgets, string> = {
  ttfb: "TTFB",
  fcp: "FCP",
  lcp: "LCP",
  cls: "CLS",
  domContentLoaded: "DOM Content Loaded",
  loadEvent: "Load Event",
};

/**
 * Issue-code prefix for a performance-budget breach. Shared by the scanner
 * (which emits the issue), the QA pipeline (which may apply a budget file to a
 * report), the severity rubric, and the HTML report — so the four can never
 * disagree about what a budget breach is.
 */
export const PERF_BUDGET_CODE_PREFIX = "perf-budget-";

/** True when an issue code is a performance-budget breach. */
export const isPerfBudgetCode = (code: string): boolean => code.startsWith(PERF_BUDGET_CODE_PREFIX);

/** The metric key behind a `perf-budget-<metric>` issue code, or null. */
export function perfBudgetMetricOf(code: string): keyof PerfBudgets | null {
  if (!isPerfBudgetCode(code)) return null;
  const key = code.slice(PERF_BUDGET_CODE_PREFIX.length);
  return key in PERF_METRIC_LABELS ? (key as keyof PerfBudgets) : null;
}

function parseNumber(value: unknown, key: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${source}: "${key}" must be a non-negative number (received ${JSON.stringify(value)}).`);
  }
  return value;
}

export function parsePerfBudgets(raw: unknown, source: string): PerfBudgets {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid ${source}: the performance budgets file must contain a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = Object.keys(PERF_METRIC_LABELS);
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`Invalid ${source}: unknown property "${key}" — supported: ${allowed.join(", ")}.`);
    }
  }
  const budgets: PerfBudgets = {};
  for (const key of allowed) {
    if (obj[key] !== undefined) {
      (budgets as Record<string, unknown>)[key] = parseNumber(obj[key], key, source);
    }
  }
  return budgets;
}

export function loadPerfBudgets(path: string): PerfBudgets | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${path}: malformed JSON (${error instanceof Error ? error.message : "parse error"}).`);
  }
  return parsePerfBudgets(raw, path);
}

export function checkPerfBudgets(metrics: PerformanceMetrics, budgets: PerfBudgets): Issue[] {
  const issues: Issue[] = [];
  for (const [key, budget] of Object.entries(budgets)) {
    const label = PERF_METRIC_LABELS[key as keyof PerfBudgets];
    const value = metrics[key as keyof PerformanceMetrics];
    if (value === null) continue;
    if (value > budget) {
      const unit = key === "cls" ? "" : "ms";
      issues.push({
        status: "FAIL",
        code: `perf-budget-${key}`,
        message: `${label} exceeded budget: ${value.toFixed(key === "cls" ? 3 : 0)} ${unit} > ${budget.toFixed(key === "cls" ? 3 : 0)} ${unit}`,
        examples: [{ detail: `${label}: ${value.toFixed(key === "cls" ? 3 : 0)} ${unit}` }],
      });
    }
  }
  return issues;
}
