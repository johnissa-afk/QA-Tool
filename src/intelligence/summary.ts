import type { EvidenceRelationship, IntelligenceSummary, InvestigationQueueEntry, RootCauseCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Intelligence summary — direct counts only. No percentage is ever derived;
// each number is a count of candidates, relationships, or queue entries.
// ---------------------------------------------------------------------------

export function buildIntelligenceSummary(
  candidates: RootCauseCandidate[],
  relationships: EvidenceRelationship[],
  queue: InvestigationQueueEntry[],
): IntelligenceSummary {
  const count = (predicate: (candidate: RootCauseCandidate) => boolean): number => candidates.filter(predicate).length;
  const contradictionIds = new Set<string>();
  for (const relationship of relationships) {
    if (relationship.relation === "CONTRADICTS") contradictionIds.add(relationship.relationshipId);
  }
  for (const candidate of candidates) {
    for (const relationship of candidate.contradictingEvidence) contradictionIds.add(relationship.relationshipId);
  }
  return {
    candidates: candidates.length,
    actionable: count(candidate => candidate.status === "ACTIONABLE"),
    investigationRequired: count(candidate => candidate.status === "INVESTIGATION_REQUIRED"),
    insufficientEvidence: count(candidate => candidate.status === "INSUFFICIENT_EVIDENCE"),
    informational: count(candidate => candidate.status === "INFORMATIONAL"),
    highConfidence: count(candidate => candidate.confidence === "HIGH"),
    mediumConfidence: count(candidate => candidate.confidence === "MEDIUM"),
    lowConfidence: count(candidate => candidate.confidence === "LOW"),
    insufficientConfidence: count(candidate => candidate.confidence === "INSUFFICIENT"),
    relationships: relationships.length,
    contradictions: contradictionIds.size,
    investigationQueue: queue.length,
  };
}

export function uncertaintyNotes(candidates: RootCauseCandidate[]): { candidateId: string; title: string; reason: string }[] {
  return candidates
    .filter(candidate => candidate.status === "INSUFFICIENT_EVIDENCE")
    .map(candidate => ({ candidateId: candidate.candidateId, title: candidate.title, reason: candidate.confidenceReason }));
}