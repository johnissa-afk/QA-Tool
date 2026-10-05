import type { QaAnalysis } from "../ai/types.js";
import { findingFacts, executionFacts, buildRelationships } from "./evidence.js";
import { buildClusters } from "./related.js";
import { synthesizeCandidates } from "./root-cause.js";
import { buildInvestigationQueue } from "./priority.js";
import { buildIntelligenceSummary } from "./summary.js";
import type {
  IntelligenceAiNotes,
  IntelligenceDigest,
  IntelligenceEnhancement,
  IntelligenceMap,
  IntelligenceSummary,
} from "./types.js";

// ---------------------------------------------------------------------------
// Phase 6 QA Intelligence — deterministic, evidence-first root-cause analysis.
//
// The pipeline is:
//   find facts -> derive evidence relationships (support + contradiction) ->
//   group by semantic identity -> synthesize root-cause CANDIDATES (patterns
//   A-E) -> safe investigation actions -> investigation queue -> summary.
//
// buildIntelligence is fully deterministic and website-agnostic. The bounded
// AI layer (analyzeIntelligence) may only reword existing candidate titles and
// descriptions — it can never add candidates, change evidence, confidence,
// status, safety, or coverage status. JSON schema stays version 1 (additive).
// ---------------------------------------------------------------------------

export type IntelligenceInput = {
  analysis: QaAnalysis;
  generatedAt?: string;
};

export function buildIntelligence(input: IntelligenceInput): IntelligenceMap {
  const { analysis } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const findings = findingFacts(analysis);
  const executions = executionFacts(analysis);
  const clusters = buildClusters({ analysis, findings, executions });
  const relationships = buildRelationships({ analysis, findings, executions });
  const rootCauseCandidates = synthesizeCandidates({ analysis, findings, executions, clusters, relationships });
  const investigationQueue = buildInvestigationQueue(analysis, rootCauseCandidates);
  const summary = buildIntelligenceSummary(rootCauseCandidates, relationships, investigationQueue);

  return {
    status: "AVAILABLE",
    schemaVersion: 1,
    generatedAt,
    summary,
    rootCauseCandidates,
    evidenceRelationships: relationships,
    investigationQueue,
    aiNotes: null,
  };
}

export function intelligenceDigestOf(map: IntelligenceMap, analysis: QaAnalysis): IntelligenceDigest {
  return {
    url: analysis.scan.scan.url,
    title: analysis.scan.scan.title,
    candidates: map.rootCauseCandidates.map(candidate => ({
      candidateId: candidate.candidateId,
      status: candidate.status,
      confidence: candidate.confidence,
      pattern: candidate.pattern,
      title: candidate.title,
      findingIds: candidate.findingIds,
      flowIds: candidate.flowIds,
      affectedPages: candidate.affectedPages,
    })),
  };
}

export function applyIntelligenceNotes(
  map: IntelligenceMap,
  enhancement: IntelligenceEnhancement | null,
  provider: string | null,
): IntelligenceMap {
  if (!enhancement?.wording?.length) {
    return { ...map, aiNotes: null };
  }
  const byId = new Map(enhancement.wording.map(item => [item.candidateId, item]));
  const rootCauseCandidates = map.rootCauseCandidates.map(candidate => {
    const notes = byId.get(candidate.candidateId);
    if (!notes) return candidate;
    return {
      ...candidate,
      ...(notes.title && notes.title.trim() ? { title: notes.title.trim().slice(0, 140) } : {}),
      ...(notes.description && notes.description.trim() ? { description: notes.description.trim().slice(0, 1200) } : {}),
    };
  });
  const notes: IntelligenceAiNotes = {
    wording: enhancement.wording
      .filter(item => map.rootCauseCandidates.some(candidate => candidate.candidateId === item.candidateId))
      .map(item => ({ candidateId: item.candidateId, title: item.title, description: item.description })),
    provider,
  };
  return {
    ...map,
    rootCauseCandidates,
    aiNotes: notes,
  };
}

export function validateIntelligenceEnhancement(raw: unknown): IntelligenceEnhancement | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const wording: NonNullable<IntelligenceEnhancement["wording"]> = [];
  if (Array.isArray(value.wording)) {
    for (const item of value.wording.slice(0, 40)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const candidateId = typeof entry.candidateId === "string" && entry.candidateId.trim() ? entry.candidateId.trim().slice(0, 40) : null;
      const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 140) : "";
      const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 1200) : "";
      if (candidateId && (title || description)) wording.push({ candidateId, ...(title ? { title } : {}), ...(description ? { description } : {}) });
    }
  }
  return wording.length ? { wording } : null;
}

export function emptyIntelligenceSummary(): IntelligenceSummary {
  return {
    candidates: 0,
    actionable: 0,
    investigationRequired: 0,
    insufficientEvidence: 0,
    informational: 0,
    highConfidence: 0,
    mediumConfidence: 0,
    lowConfidence: 0,
    insufficientConfidence: 0,
    relationships: 0,
    contradictions: 0,
    investigationQueue: 0,
  };
}

export type {
  CandidatePattern,
  EvidenceRelation,
  EvidenceRelationReason,
  EvidenceRelationship,
  EvidenceSourceKind,
  IntelligenceAiNotes,
  IntelligenceDigest,
  IntelligenceEnhancement,
  IntelligenceMap,
  IntelligenceStatus,
  IntelligenceSummary,
  InvestigationAction,
  InvestigationActionKind,
  InvestigationPriority,
  InvestigationQueueEntry,
  RelationshipEndpoint,
  RootCauseCandidate,
  RootCauseConfidence,
} from "./types.js";