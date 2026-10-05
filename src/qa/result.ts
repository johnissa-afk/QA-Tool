// ---------------------------------------------------------------------------
// Phase 8A — unified QA RESULT block.
//
// Pure, deterministic, and UI-agnostic: builds the one product-facing summary
// of a QA run (status, run id, pages, findings, verification, coverage,
// regression, historical status, investigation queue, report artifacts). The
// CLI renders it; the CI policy (8C) and dashboards may reuse the same
// derivations. No QA logic is duplicated here — every number comes straight
// off the analysis.
// ---------------------------------------------------------------------------
import type { QaAnalysis } from "../ai/types.js";

export type QaResultInput = {
  url: string;
  status: "PASS" | "REVIEW" | "FAIL" | "NOT_TESTED" | "BLOCKED";
  runId: string | null;
  pagesDiscovered: number;
  coverageLabel: string;
  findingsCount: number;
  occurrenceCount: number;
  verified: number;
  reproduced: number;
  regression: { comparable: boolean; changeCount: number } | null;
  historicalStatus: string | null;
  queue: ReadonlyArray<{ priority: string }>;
  runsStored: number;
  jsonPath: string;
  htmlPath: string;
  historyPath: string;
};

export type QaResultContext = {
  url: string;
  runId: string | null;
  jsonPath: string;
  htmlPath: string;
  historyPath: string;
};

/** Deterministic page-coverage label from the coverage summary page counts. */
export function coverageStatusLabel(pages: { tested: number; partial: number }): string {
  const tested = pages.tested;
  const partial = pages.partial;
  if (tested > 0 && partial === 0) return "TESTED";
  if (tested > 0 || partial > 0) return "PARTIALLY_TESTED";
  return "NOT_TESTED";
}

/** Counts queue entries by priority (P1/P2/P3). Unknown priorities are ignored. */
export function queuePriorityCounts(queue: ReadonlyArray<{ priority: string }>): { P1: number; P2: number; P3: number } {
  const counts: { P1: number; P2: number; P3: number } = { P1: 0, P2: 0, P3: 0 };
  for (const entry of queue) {
    if (entry.priority === "P1" || entry.priority === "P2" || entry.priority === "P3") counts[entry.priority] += 1;
  }
  return counts;
}

/** Derives the result input from the analysis (one mapping, no invented numbers). */
export function qaResultInputOf(analysis: QaAnalysis, context: QaResultContext): QaResultInput {
  const coverage = analysis.coverage?.summary.pages;
  const historicalQueue = analysis.historicalIntelligence?.investigationQueue ?? [];
  const intelligenceQueue = analysis.intelligence?.investigationQueue ?? [];
  const regression = analysis.regression
    ? { comparable: analysis.regression.summary.comparable, changeCount: analysis.regression.summary.changeCount }
    : null;
  return {
    url: context.url,
    status: analysis.summary.overallStatus,
    runId: context.runId,
    pagesDiscovered: coverage?.discovered ?? 1,
    coverageLabel: coverage ? coverageStatusLabel(coverage) : "N/A",
    findingsCount: analysis.findings.length,
    occurrenceCount: analysis.summary.issueCount,
    verified: analysis.summary.verified,
    reproduced: analysis.summary.reproduced,
    regression,
    historicalStatus: analysis.historicalIntelligence?.status ?? null,
    queue: historicalQueue.length > 0 ? historicalQueue : intelligenceQueue,
    runsStored: analysis.history?.runsAvailable ?? 0,
    jsonPath: context.jsonPath,
    htmlPath: context.htmlPath,
    historyPath: context.historyPath,
  };
}

/** Renders the QA RESULT block. Deterministic and ASCII-safe. */
export function buildQaResultBlock(input: QaResultInput): string {
  const lines: string[] = [];
  const push = (text = ""): void => { lines.push(text); };
  const divider = (count: number): string => "─".repeat(Math.max(4, count));

  push("QA RESULT");
  push(divider(21));
  push(`From:   ${input.url}`);
  push(`Status: ${input.status}`);
  if (input.runId) push(`Run:    ${input.runId}`);
  push("");
  push(`Pages: ${input.pagesDiscovered} · Findings: ${input.findingsCount} (${input.occurrenceCount} occurrence(s)) · Verified: ${input.verified} · Reproduced: ${input.reproduced}`);
  push("");
  const regressionText = input.regression
    ? input.regression.comparable
      ? `${input.regression.changeCount} change(s)`
      : "not comparable"
    : "not run (add --baseline)";
  push(`Coverage: ${input.coverageLabel} · Regression: ${regressionText} · Historical: ${input.historicalStatus ?? "n/a"}${input.runsStored ? ` (${input.runsStored} run(s))` : ""}`);
  push("");
  const queue = queuePriorityCounts(input.queue);
  push(`Investigation queue — P1: ${queue.P1} · P2: ${queue.P2} · P3: ${queue.P3}`);
  push("");
  push("Reports:");
  push(`  ✓ JSON:    ${input.jsonPath}`);
  push(`  ✓ HTML:    ${input.htmlPath}`);
  push(`  ✓ History: ${input.historyPath} (${input.runsStored} run(s))`);
  return lines.join("\n");
}