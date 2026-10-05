import type { QaAnalysis } from "../ai/types.js";
import type { InvestigationPriority, InvestigationQueueEntry, RootCauseCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Investigation queue.
//
// Priority is derived ONLY from explainable factors and is written down in the
// priorityReason. There is no global QA score: a candidate is simply P1/P2/P3
// depending on how many independent signals make it worth investigating first.
// INSUFFICIENT_EVIDENCE / INFORMATIONAL candidates are never queued.
// ---------------------------------------------------------------------------

let entryCounter = 0;

export const resetEntryCounter = (): void => {
  entryCounter = 0;
};

const nextEntryId = (): string => {
  entryCounter += 1;
  return `IQ-${String(entryCounter).padStart(3, "0")}`;
};

export type PriorityFactors = {
  reproduced: boolean;
  regression: boolean;
  highSeverity: boolean;
  criticalSeverity: boolean;
  multipleFlows: boolean;
  multiplePages: boolean;
  highConfidence: boolean;
  safeReproduction: boolean;
  coverageImpact: boolean;
  contradictions: boolean;
};

export const factorsFor = (analysis: QaAnalysis, candidate: RootCauseCandidate): PriorityFactors => {
  const reproduced = candidate.findingIds.some(id =>
    analysis.findings.some(finding => finding.id === id && finding.verification?.disposition === "REPRODUCED"),
  );
  const regression = candidate.regressionContext.length > 0;
  const severities = candidate.findingIds.map(id => analysis.findings.find(finding => finding.id === id)?.severity ?? null);
  const criticalSeverity = severities.includes("CRITICAL");
  const highSeverity = severities.includes("HIGH") || criticalSeverity;
  const multipleFlows = candidate.flowIds.length >= 2;
  const multiplePages = candidate.affectedPages.length >= 2;
  const highConfidence = candidate.confidence === "HIGH";
  const safeReproduction = candidate.flowIds.some(id => (analysis.flowDiscovery?.flows ?? []).some(flow => flow.flowId === id && flow.executable && flow.safety === "SAFE"));
  const coverageImpact = candidate.coverageImpact.length > 0;
  const contradictions = candidate.contradictingEvidence.length > 0;
  return { reproduced, regression, highSeverity, criticalSeverity, multipleFlows, multiplePages, highConfidence, safeReproduction, coverageImpact, contradictions };
};

export function buildInvestigationQueue(analysis: QaAnalysis, candidates: RootCauseCandidate[]): InvestigationQueueEntry[] {
  resetEntryCounter();
  const queue: InvestigationQueueEntry[] = [];

  for (const candidate of candidates) {
    if (candidate.status !== "ACTIONABLE" && candidate.status !== "INVESTIGATION_REQUIRED") continue;

    const factors = factorsFor(analysis, candidate);
    const satisfied: string[] = [];
    if (factors.reproduced) satisfied.push("finding is reproduced in verification");
    if (factors.regression) satisfied.push("regression comparison correlates changes");
    if (factors.highSeverity) satisfied.push(factors.criticalSeverity ? "critical/high severity findings involved" : "high severity findings involved");
    if (factors.multipleFlows) satisfied.push("multiple affected flows");
    if (factors.multiplePages) satisfied.push("multiple affected pages");
    if (factors.highConfidence) satisfied.push("high-confidence evidence");
    if (factors.coverageImpact) satisfied.push("coverage map shows affected items");
    if (factors.contradictions) satisfied.push("contradicting evidence must be reviewed before acting");

    // Deterministic priority: each strong signal raises urgency; contradictory
    // evidence never over-claims — it still needs the attention first.
    let score = 0;
    if (factors.regression) score += 2;
    if (factors.reproduced) score += 1;
    if (factors.highConfidence) score += 1;
    if (factors.criticalSeverity) score += 1;
    if (factors.multipleFlows) score += 1;
    if (factors.coverageImpact) score += 1;
    if (factors.contradictions && candidate.confidence === "INSUFFICIENT") score = 0;

    const priority: InvestigationPriority = score >= 4 ? "P1" : score >= 2 ? "P2" : "P3";
    const reasonParts = satisfied.length
      ? satisfied
      : [candidate.confidence === "LOW" ? "single weak signal needs confirmation" : "candidate merits a safe first look"];

    queue.push({
      entryId: nextEntryId(),
      candidateId: candidate.candidateId,
      priority,
      priorityReason: reasonParts.join("; ") + ".",
      title: candidate.title,
    });
  }

  return queue.sort((a, b) => {
    const rank = { P1: 0, P2: 1, P3: 2 } as const;
    const diff = rank[a.priority] - rank[b.priority];
    if (diff !== 0) return diff;
    return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  });
}