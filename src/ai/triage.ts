import { TriageVerdict, VerificationResult } from "./types.js";

// ---------------------------------------------------------------------------
// Analysis-layer triage summary.
//
// The per-result verdicts are produced deterministically inside the executor
// (see triageOutcome). This module aggregates those explainable verdicts for
// the QA summary and HTML report, and exposes the verdict rules so the report
// can show WHY a finding was classified the way it was.
// ---------------------------------------------------------------------------
export function summarizeVerifications(results: VerificationResult[]): {
  byVerdict: Record<TriageVerdict, number>;
  byStatus: Record<VerificationResult["status"], number>;
  byCategory: Record<string, number>;
  total: number;
} {
  const verdicts: TriageVerdict[] = ["LIKELY_DEFECT", "NOT_REPRODUCED", "CONDITIONAL", "INFRASTRUCTURE_PROBLEM", "REVIEW_REQUIRED"];
  const statuses: VerificationResult["status"][] = ["REPRODUCED", "NOT_REPRODUCED", "PASS", "REVIEW"];
  const byVerdict = Object.fromEntries(verdicts.map(verdict => [verdict, 0])) as Record<TriageVerdict, number>;
  const byStatus = Object.fromEntries(statuses.map(status => [status, 0])) as Record<VerificationResult["status"], number>;
  const byCategory = new Map<string, number>();

  for (const result of results) {
    const verdict = result.triage?.verdict ?? "REVIEW_REQUIRED";
    byVerdict[verdict] += 1;
    byStatus[result.status] += 1;
    const category = result.category ?? "REVIEW";
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  }

  return {
    byVerdict,
    byStatus,
    byCategory: Object.fromEntries(byCategory),
    total: results.length,
  };
}