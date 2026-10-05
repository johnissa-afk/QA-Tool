import type { QaAnalysis } from "../ai/types.js";
import type { EvidenceRelationship, RootCauseCandidate, RootCauseConfidence } from "./types.js";
import type { ExecutionFact, FindingFact } from "./evidence.js";
import { buildInvestigationActions, resetActionCounter } from "./investigation.js";
import { elementSemanticKey } from "../regression/identity.js";
import { findingPage } from "./identity.js";
import type { ClusterSeed } from "./related.js";

// ---------------------------------------------------------------------------
// Root-cause candidate synthesis (patterns A–E).
//
//   A  VERIFIED_REGENERATION   a11y finding + flow stall on the same target
//   B  SHARED_SEMANTIC_TARGET  two+ flows stall at the same target
//   C  VERIFIED_REGRESSION     baseline passed → current failed, reproduced,
//                              same target (highest plausible confidence)
//   D  INFRASTRUCTURE          runner/network failures — never a website defect
//   E  DISCOVERY_VARIANCE      removed flow / coverage loss without evidence
//
// Confidence is derived from the number of independent evidence sources that
// agree. Any CONTRADICTS edge downgrades it and forces
// INVESTIGATION_REQUIRED / INSUFFICIENT_EVIDENCE. A candidate title always
// frames the output as a candidate — it is never a confirmed cause.
// ---------------------------------------------------------------------------

export type SynthesisInput = {
  analysis: QaAnalysis;
  findings: FindingFact[];
  executions: ExecutionFact[];
  clusters: ClusterSeed[];
  relationships: EvidenceRelationship[];
};

let candidateCounter = 0;

export const resetCandidateCounter = (): void => {
  candidateCounter = 0;
};

export const nextCandidateId = (): string => {
  candidateCounter += 1;
  return `RC-${String(candidateCounter).padStart(3, "0")}`;
};

const DOWNGRADE: Record<RootCauseConfidence, RootCauseConfidence> = {
  HIGH: "MEDIUM",
  MEDIUM: "LOW",
  LOW: "INSUFFICIENT",
  INSUFFICIENT: "INSUFFICIENT",
};

const joinNouns = (values: string[]): string => {
  if (values.length === 0) return "no members";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, values.length - 1).join(", ")}, and ${values[values.length - 1]}`;
};

const relatedTo = (relationships: EvidenceRelationship[], refId: string): EvidenceRelationship[] =>
  relationships.filter(relationship => relationship.from.refId === refId || relationship.to.refId === refId);

const dedupe = (list: EvidenceRelationship[]): EvidenceRelationship[] => {
  const seen = new Set<string>();
  return list.filter(item => {
    if (seen.has(item.relationshipId)) return false;
    seen.add(item.relationshipId);
    return true;
  });
};

export const synthesizeCandidates = (input: SynthesisInput): RootCauseCandidate[] => {
  const { analysis, clusters, relationships } = input;
  resetCandidateCounter();
  resetActionCounter();
  const candidates: RootCauseCandidate[] = [];

  for (const cluster of clusters) {
    if (cluster.kind === "TARGET") {
      const candidate = synthesizeTargetCandidate(input, cluster, relationships, analysis);
      if (candidate) candidates.push(candidate);
    } else if (cluster.kind === "INFRASTRUCTURE") {
      candidates.push(synthesizeInfrastructureCandidate(input, cluster, relationships));
    } else if (cluster.kind === "DISCOVERY_VARIANCE") {
      const candidate = synthesizeVarianceCandidate(input, cluster);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
};

const synthesizeTargetCandidate = (
  input: SynthesisInput,
  cluster: ClusterSeed,
  relationships: EvidenceRelationship[],
  analysis: QaAnalysis,
): RootCauseCandidate | null => {
  const { findings, executions } = input;
  const clusterFindings = findings.filter(fact => cluster.findingIds.includes(fact.findingId));
  const clusterExecutions = executions.filter(fact => cluster.flowIds.includes(fact.flowId) && fact.elementKey === cluster.elementKey && fact.page === cluster.page);
  const failedExecutions = clusterExecutions.filter(fact => fact.failedOnSite);
  const suppressed = clusterExecutions.filter(fact => !fact.failedOnSite);
  const reproducedFindings = clusterFindings.filter(fact => fact.reproduced);
  const cleanFindings = clusterFindings.filter(fact => fact.clean || fact.notReproduced);

  if (failedExecutions.length === 0) return null;

  const findingIds = clusterFindings.map(fact => fact.findingId);
  const flowIds = cluster.flowIds;
  const changeIds = cluster.changeIds;
  const regressionChanges = (analysis.regression?.changes ?? []).filter(change => changeIds.includes(change.changeId));
  const reproducibleRegression = regressionChanges.find(change => change.classification === "REGRESSION");
  const authBound = clusterExecutions.some(fact => fact.stoppedAtStep != null || fact.failureCategory === "AUTH");

  // ----- pattern classification --------------------------------------------
  let pattern: RootCauseCandidate["pattern"];
  if (reproducibleRegression && reproducedFindings.length > 0 && failedExecutions.length > 0) {
    pattern = "VERIFIED_REGRESSION";
  } else if (failedExecutions.length >= 2) {
    pattern = "SHARED_SEMANTIC_TARGET";
  } else if (reproducedFindings.length > 0) {
    pattern = "VERIFIED_REGENERATION";
  } else {
    pattern = "SINGLE_OBSERVATION";
  }

  // ----- supporting / contradicting evidence -------------------------------
  const memberRefs = new Set<string>([...findingIds, ...flowIds.map(id => `SC-${id}`), ...regressionChanges.map(change => change.changeId)]);
  const supporting: EvidenceRelationship[] = [];
  const contradicting: EvidenceRelationship[] = [];
  for (const refId of memberRefs) {
    for (const relationship of relatedTo(relationships, refId)) {
      const bothMembers = memberRefs.has(relationship.from.refId) && memberRefs.has(relationship.to.refId);
      const touchesRegression = relationship.from.kind === "REGRESSION" || relationship.to.kind === "REGRESSION";
      if (relationship.relation === "SUPPORTS" && (bothMembers || touchesRegression)) supporting.push(relationship);
      if (relationship.relation === "CONTRADICTS" && (touchesRegression || memberRefs.has(relationship.from.refId) || memberRefs.has(relationship.to.refId))) contradicting.push(relationship);
    }
  }

  for (const fact of cleanFindings) {
    if (fact.clean) {
      contradicting.push({
        relationshipId: `REL-${fact.findingId}`,
        relation: "CONTRADICTS",
        reason: "SAME_SEMANTIC_TARGET",
        description: `${fact.findingId} was verified clean (element present, expectation not met) at the same target — it does not corroborate a defect there.`,
        from: { kind: "FINDING", refId: fact.findingId, label: fact.findingId },
        to: { kind: "EXECUTION", refId: `SC-${flowIds[0] ?? ""}`, label: `flow ${flowIds.join(", ")}` },
      });
    }
  }
  if (authBound && findingIds.length > 0) {
    contradicting.push({
      relationshipId: "REL-AUTH",
      relation: "CONTRADICTS",
      reason: "SAME_EXECUTION_EVIDENCE",
      description: `Execution stopped at an authentication boundary${clusterExecutions[0]?.boundary ? ` (${clusterExecutions[0].boundary})` : ""}; the stall is explained by gating, not by the target element.`,
      from: { kind: "EXECUTION", refId: `SC-${flowIds.join("/") || "?"}`, label: `flows ${flowIds.join(", ")}` },
      to: { kind: "FINDING", refId: findingIds[0]!, label: findingIds[0]! },
    });
  }
  const locatorWhilePresent = failedExecutions.some(fact => fact.failureCategory === "LOCATOR") && targetPresentInScan(analysis, cluster.elementKey);
  if (locatorWhilePresent && findingIds.length > 0) {
    contradicting.push({
      relationshipId: "REL-LOCATOR-PRESENT",
      relation: "CONTRADICTS",
      reason: "SAME_EXECUTION_EVIDENCE",
      description: `The target is present in the scan snapshot but a flow could not locate it at runtime — an intermittent/conditional state, not a stable defect.`,
      from: { kind: "FINDING", refId: findingIds[0]!, label: findingIds[0]! },
      to: { kind: "EXECUTION", refId: `SC-${flowIds.join("/") || "?"}`, label: `flows ${flowIds.join(", ")}` },
    });
  }

  const supports = dedupe(supporting);
  const contradicts = dedupe(contradicting);
  const passesOnTarget = suppressed.filter(fact => fact.passed).length > 0;

  // ----- confidence + status ------------------------------------------------
  const reasonParts: string[] = [];
  let confidence: RootCauseConfidence;

  if (pattern === "VERIFIED_REGRESSION" && reproducibleRegression?.confidence === "HIGH_CONFIDENCE" && reproducedFindings.length > 0 && failedExecutions.length > 0) {
    confidence = "HIGH";
    reasonParts.push("independent signals agree: a HIGH_CONFIDENCE regression, a reproduced finding, and a flow stall on the same target");
  } else if (pattern === "VERIFIED_REGRESSION") {
    confidence = "MEDIUM";
    reasonParts.push("regression correlation exists but reproduction or execution evidence is incomplete");
  } else if (failedExecutions.length >= 2 && reproducedFindings.length > 0) {
    confidence = "MEDIUM";
    reasonParts.push("multiple flows stall at one target and the target finding is reproduced");
  } else if (failedExecutions.length >= 2) {
    confidence = "MEDIUM";
    reasonParts.push("multiple independent flows stall at the same semantic target");
  } else if (reproducedFindings.length > 0) {
    confidence = "MEDIUM";
    reasonParts.push("a reproduced finding correlates with one flow stalling on the same target");
  } else {
    confidence = "INSUFFICIENT";
    reasonParts.push("a single observation with no finding or baseline evidence to corroborate it — too weak to support a root cause");
  }

  if (contradicts.length > 0) {
    confidence = DOWNGRADE[confidence];
    reasonParts.push(`contradicting evidence (${contradicts.length} edge(s)) downgrades confidence`);
  }
  if (passesOnTarget) reasonParts.push("at least one flow passed through the same target");
  if (locatorWhilePresent) reasonParts.push("target present in the snapshot but missing at runtime — conditional state");

  let status: RootCauseCandidate["status"];
  if (contradicts.length > 0 && confidence === "INSUFFICIENT") {
    status = "INSUFFICIENT_EVIDENCE";
  } else if (contradicts.length > 0) {
    status = "INVESTIGATION_REQUIRED";
  } else if (confidence === "HIGH" || confidence === "MEDIUM") {
    status = "ACTIONABLE";
  } else if (confidence === "INSUFFICIENT") {
    status = "INSUFFICIENT_EVIDENCE";
  } else {
    status = "INVESTIGATION_REQUIRED";
  }

  const pages = [...new Set([cluster.page, ...clusterExecutions.map(fact => fact.page)])];
  const categories = [...new Set([
    ...clusterFindings.map(fact => fact.domain),
    ...failedExecutions.map(fact => `flow:${fact.flowId}`),
    ...regressionChanges.map(change => `regression:${change.changeId}`),
  ])];

  const regressionContext = regressionChanges.map(change => `${change.changeId} [${change.classification}] (${change.confidence}) ${change.summary}`);

  const actionTarget = cluster.elementKey ?? cluster.anchor;
  const investigationActions = buildInvestigationActions({
    analysis,
    pattern,
    targetLabel: actionTarget,
    flowIds,
    hasBaseline: analysis.regression?.summary.comparable ?? false,
    authContradiction: authBound || contradicts.length > 0,
  });

  const memberWording = [
    ...(findingIds.length ? [`findings ${joinNouns(findingIds)}`] : []),
    ...(flowIds.length ? [`flows ${flowIds.join(", ")}`] : []),
  ].join(" and ");

  const description = `Candidate root cause the evidence group relates to the semantic target "${cluster.anchor}" (${cluster.page}). ${memberWording ? `Covers ${memberWording}.` : ""} ${reasonParts.join("; ")}. This is a hypothesis derived from evidence, never a confirmed cause.`;

  return {
    candidateId: nextCandidateId(),
    title: patternTitle(pattern, cluster.anchor),
    description,
    pattern,
    confidence,
    confidenceReason: `${reasonParts.join("; ")}${reasonParts.length ? "." : ""}`,
    status,
    findingIds,
    scenarioIds: [],
    flowIds,
    affectedPages: pages,
    affectedCategories: categories,
    supportingEvidence: supports,
    contradictingEvidence: contradicts,
    investigationActions,
    coverageImpact: coverageImpactFor(analysis, findingIds, flowIds),
    regressionContext,
  };
};

const synthesizeInfrastructureCandidate = (
  input: SynthesisInput,
  cluster: ClusterSeed,
  relationships: EvidenceRelationship[],
): RootCauseCandidate => {
  const { analysis, executions } = input;
  const infraExecutions = executions.filter(fact => cluster.flowIds.includes(fact.flowId) && fact.infra);
  const supports = dedupe(
    cluster.flowIds.flatMap(id => relatedTo(relationships, `SC-${id}`)).filter(relationship => relationship.relation === "SUPPORTS"),
  );
  const confidence: RootCauseConfidence = infraExecutions.length >= 3 ? "MEDIUM" : "LOW";
  const investigationActions = buildInvestigationActions({
    analysis,
    pattern: "INFRASTRUCTURE",
    targetLabel: null,
    flowIds: cluster.flowIds,
    hasBaseline: analysis.regression?.summary.comparable ?? false,
    authContradiction: false,
  });
  return {
    candidateId: nextCandidateId(),
    title: "Runner or network failures interrupted flow verification",
    description: `${infraExecutions.length} execution(s) (${cluster.flowIds.join(", ")}) reported infrastructure problems (runner, browser, or network). These are never evidence about the website and are treated as informational.`,
    pattern: "INFRASTRUCTURE",
    confidence,
    confidenceReason: `${infraExecutions.length} infrastructure failure(s) observed${infraExecutions.length >= 3 ? "; a consistent pattern is more likely than isolated noise" : "; isolated failures are weak evidence"}.`,
    status: "INFORMATIONAL",
    findingIds: [],
    scenarioIds: [],
    flowIds: cluster.flowIds,
    affectedPages: [...new Set(infraExecutions.map(fact => fact.page).filter(Boolean))],
    affectedCategories: ["INFRASTRUCTURE"],
    supportingEvidence: supports,
    contradictingEvidence: [],
    investigationActions,
    coverageImpact: [],
    regressionContext: [],
  };
};

const synthesizeVarianceCandidate = (input: SynthesisInput, cluster: ClusterSeed): RootCauseCandidate | null => {
  const { analysis } = input;
  const changes = (analysis.regression?.changes ?? []).filter(change => cluster.changeIds.includes(change.changeId));
  if (changes.length === 0) return null;
  const investigationActions = buildInvestigationActions({
    analysis,
    pattern: "DISCOVERY_VARIANCE",
    targetLabel: null,
    flowIds: cluster.flowIds,
    hasBaseline: true,
    authContradiction: false,
  });
  return {
    candidateId: nextCandidateId(),
    title: "Disappeared flows match crawl variance, not a verified change",
    description: `${changes.length} change(s) (${joinNouns(changes.map(change => change.changeId))}) describe flows or coverage that disappeared without verification evidence. On a dynamic site this is usually discovery instability, not a regression, and requires evidence before it is treated as a real removal.`,
    pattern: "DISCOVERY_VARIANCE",
    confidence: "INSUFFICIENT",
    confidenceReason: "removed flows / coverage loss carry no verification evidence; discovery variance alone cannot support a website-change claim.",
    status: "INSUFFICIENT_EVIDENCE",
    findingIds: [],
    scenarioIds: [],
    flowIds: cluster.flowIds,
    affectedPages: [cluster.page],
    affectedCategories: ["DISCOVERY"],
    supportingEvidence: [],
    contradictingEvidence: [],
    investigationActions,
    coverageImpact: [],
    regressionContext: changes.map(change => `${change.changeId} [${change.classification}] (${change.confidence}) ${change.summary}`),
  };
};

const patternTitle = (pattern: RootCauseCandidate["pattern"], anchor: string): string => {
  switch (pattern) {
    case "VERIFIED_REGENERATION":
      return `Accessibility finding correlates with a flow stall at "${anchor}"`;
    case "SHARED_SEMANTIC_TARGET":
      return `Multiple flows stall at the same element "${anchor}"`;
    case "VERIFIED_REGRESSION":
      return `Previously verified condition regressed at "${anchor}"`;
    case "SINGLE_OBSERVATION":
      return `Single observation at "${anchor}" — insufficient evidence`;
    case "INFRASTRUCTURE":
      return "Runner or network failures interrupted flow verification";
    case "DISCOVERY_VARIANCE":
      return "Disappeared flows match crawl variance, not a verified change";
  }
};

const targetPresentInScan = (analysis: QaAnalysis, elementKey: string | null): boolean => {
  if (!elementKey) return false;
  return analysis.scan.elements.some(element => elementSemanticKey(element) === elementKey);
};

const coverageImpactFor = (analysis: QaAnalysis, findingIds: string[], flowIds: string[]): string[] => {
  const impacts: string[] = [];
  for (const item of analysis.coverage?.items ?? []) {
    const linked = item.relatedFindings.some(id => findingIds.includes(id)) || item.relatedFlows.some(id => flowIds.includes(id));
    if (linked) impacts.push(`${item.coverageId} ${item.status} — ${item.name}${item.reason ? ` (${item.reason})` : ""}`);
  }
  return impacts;
};

export { findingPage };