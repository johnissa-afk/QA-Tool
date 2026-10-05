import type { QaAnalysis, QaFinding, Severity } from "../ai/types.js";
import type { FlowExecutionResult, FlowFailureCategory, FlowStepOutcome, DiscoveredFlow } from "../flow/types.js";
import type { CoverageItem } from "../coverage/types.js";
import {
  endpoint,
  executionElementKey,
  executionPage,
  findingElementKey,
  findingLabel,
  findingPage,
  flowLabel,
  scanElements,
} from "./identity.js";
import type { EvidenceRelation, EvidenceRelationReason, EvidenceRelationship, EvidenceSourceKind } from "./types.js";

// ---------------------------------------------------------------------------
// Fact extraction + evidence relationship building.
//
// Relationships are the ONLY connective tissue the intelligence layer may use.
// They are built deterministically on normalized semantic identity with an
// explicit reason, and contradiction edges are PROACTIVELY derived — a clean
// verification, a passing execution through the same target, or an auth
// boundary that explains a failure all become CONTRADICTS edges. The engine
// never invents a website-agnostic-cause claim without one of these edges.
// ---------------------------------------------------------------------------

export type FindingFact = {
  findingId: string;
  index: number;
  elementKey: string | null;
  page: string;
  domain: string;
  severity: Severity;
  /** Verification outcome signals. `reproduced` is the strongest single signal;
   *  `clean`/`notReproduced` actively contradict a defect claim. */
  reproduced: boolean;
  clean: boolean;
  notReproduced: boolean;
  unverified: boolean;
  authBound: boolean;
};

export type ExecutionFact = {
  index: number;
  flowId: string;
  stepIndex: number | null;
  elementKey: string | null;
  page: string;
  status: FlowStepOutcome;
  failureCategory: FlowFailureCategory | null;
  stoppedAtStep: number | null;
  boundary: string | null;
  infra: boolean;
  failedOnSite: boolean;
  passed: boolean;
};

export const findingFacts = (analysis: QaAnalysis): FindingFact[] =>
  analysis.findings.map((finding, index) => {
    const verification = finding.verification;
    const disposition = verification?.disposition ?? null;
    return {
      findingId: finding.id,
      index,
      elementKey: findingElementKey(analysis, finding),
      page: findingPage(analysis),
      domain: finding.domain,
      severity: finding.severity,
      reproduced: disposition === "REPRODUCED",
      clean: disposition === "PASSED" || (disposition === "NOT_REPRODUCED" && verification?.category === "EXPECTATION"),
      notReproduced: disposition === "NOT_REPRODUCED",
      unverified: !disposition || disposition === "SCHEDULED" || disposition === "SKIPPED_UNSUPPORTED" || disposition === "SKIPPED_LOCATOR_GUARD" || disposition === "SKIPPED_SAFETY",
      authBound: verification?.category === "AUTHENTICATION" || verification?.category === "REVIEW",
    };
  });

export const executionFacts = (analysis: QaAnalysis): ExecutionFact[] =>
  (analysis.flowDiscovery?.executions ?? []).map((execution, index) => {
    const failedOnSite = execution.status === "REPRODUCED" || execution.status === "REVIEW_REQUIRED" || execution.status === "NOT_REPRODUCED";
    return {
      index,
      flowId: execution.flowId,
      stepIndex: execution.stoppedAtStep,
      elementKey: executionElementKey(analysis, execution),
      page: executionPage(execution),
      status: execution.status,
      failureCategory: execution.failureCategory,
      stoppedAtStep: execution.stoppedAtStep,
      boundary: execution.boundary,
      infra: execution.status === "INFRASTRUCTURE_PROBLEM" || execution.failureCategory === "INFRASTRUCTURE",
      failedOnSite,
      passed: execution.status === "PASS",
    };
  });

type EndpointSeed = { kind: EvidenceSourceKind; refId: string; label: string; key: string; page: string; index: number };

const executionOf = (analysis: QaAnalysis) => analysis.flowDiscovery?.executions ?? [];

export type RelationshipBuildInput = {
  analysis: QaAnalysis;
  findings: FindingFact[];
  executions: ExecutionFact[];
};

let relationshipCounter = 0;

export const buildRelationships = (input: RelationshipBuildInput): EvidenceRelationship[] => {
  const { analysis, findings, executions } = input;
  const relationships: EvidenceRelationship[] = [];
  const seen = new Set<string>();
  relationshipCounter = 0;

  const add = (relation: EvidenceRelation, reason: EvidenceRelationReason, description: string, from: EndpointSeed, to: EndpointSeed) => {
    const key = `${from.refId}->${to.refId}:${reason}:${relation}`;
    const reverseKey = `${to.refId}->${from.refId}:${reason}:${relation}`;
    if (seen.has(key) || seen.has(reverseKey)) return;
    seen.add(key);
    relationshipCounter += 1;
    relationships.push({
      relationshipId: `REL-${String(relationshipCounter).padStart(3, "0")}`,
      relation,
      reason,
      description,
      from: endpoint(from.kind, from.refId, from.label),
      to: endpoint(to.kind, to.refId, to.label),
    });
  };

  const findingById = new Map(findings.map(finding => [finding.findingId, finding]));
  const findingEndpoint = (fact: FindingFact): EndpointSeed =>
    ({ kind: "FINDING", refId: fact.findingId, label: fact.findingId, key: fact.elementKey ?? "", page: fact.page, index: fact.index });
  const executionEndpoint = (fact: ExecutionFact): EndpointSeed =>
    ({ kind: "EXECUTION", refId: `SC-${fact.flowId}`, label: `execution SC-${fact.flowId}`, key: fact.elementKey ?? "", page: fact.page, index: fact.index });

  // 1. Finding ↔ Finding.
  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      const a = findings[i]!;
      const b = findings[j]!;
      if (a.elementKey && a.elementKey === b.elementKey && a.page === b.page) {
        add("SUPPORTS", "SAME_SEMANTIC_TARGET", `Both ${a.findingId} and ${b.findingId} point at the same semantic target on ${a.page}.`, findingEndpoint(a), findingEndpoint(b));
      } else if (a.domain === b.domain && a.page === b.page) {
        add("RELATED", "SAME_CATEGORY", `${a.findingId} and ${b.findingId} are in the same domain (${a.domain}) on the same page but target different elements — context only, never identity.`, findingEndpoint(a), findingEndpoint(b));
      }
    }
  }

  // 2. Finding ↔ Execution (accessibility→execution identity, pattern A).
  for (const fact of findings) {
    if (!fact.elementKey) continue;
    for (const execFact of executions) {
      if (!execFact.elementKey || execFact.elementKey !== fact.elementKey || execFact.page !== fact.page) continue;
      const findingEp = findingEndpoint(fact);
      const execEp = executionEndpoint(execFact);
      if (execFact.infra) {
        add("RELATED", "SAME_NORMALIZED_PAGE", `${execFact.flowId} could not be verified (infrastructure), not an observation about ${fact.findingId}'s target.`, findingEp, execEp);
      } else if (execFact.passed) {
        add("CONTRADICTS", "SAME_SEMANTIC_TARGET", `${execFact.flowId} PASSED through the same semantic target as ${fact.findingId} — the target is reachable, which weakens a "blocked by this element" claim.`, findingEp, execEp);
      } else if (execFact.stoppedAtStep != null || execFact.failureCategory === "AUTH") {
        add("CONTRADICTS", "SAME_SEMANTIC_TARGET", `Flow ${execFact.flowId} stopped at an auth boundary${execFact.boundary ? ` (${execFact.boundary})` : ""}; the failure is explained by gating, not by ${fact.findingId}'s element.`, findingEp, execEp);
      } else if (execFact.failedOnSite) {
        add("SUPPORTS", "SAME_SEMANTIC_TARGET", `Flow ${execFact.flowId} stalled (${execFact.status}) at the same semantic target flagged by ${fact.findingId}.`, findingEp, execEp);
      }
    }
  }

  // 3. Execution ↔ Execution.
  for (let i = 0; i < executions.length; i += 1) {
    for (let j = i + 1; j < executions.length; j += 1) {
      const a = executions[i]!;
      const b = executions[j]!;
      if (a.infra && b.infra) {
        add("SUPPORTS", "SAME_EXECUTION_EVIDENCE", `${a.flowId} and ${b.flowId} both report infrastructure problems (${a.failureCategory ?? "runner"}) — runner/network evidence, never a website verdict.`, executionEndpoint(a), executionEndpoint(b));
        continue;
      }
      if (!a.elementKey || !b.elementKey || a.elementKey !== b.elementKey || a.page !== b.page) continue;
      if (a.failedOnSite && b.failedOnSite) {
        add("SUPPORTS", "SAME_SEMANTIC_TARGET", `${a.flowId} and ${b.flowId} both stalled at the same semantic target on ${a.page}.`, executionEndpoint(a), executionEndpoint(b));
      } else if (a.passed && b.failedOnSite) {
        add("CONTRADICTS", "SAME_SEMANTIC_TARGET", `${a.flowId} PASSED at the same target where ${b.flowId} stalled — the target is reachable in at least one flow.`, executionEndpoint(a), executionEndpoint(b));
      } else if (b.passed && a.failedOnSite) {
        add("CONTRADICTS", "SAME_SEMANTIC_TARGET", `${b.flowId} PASSED at the same target where ${a.flowId} stalled — the target is reachable in at least one flow.`, executionEndpoint(a), executionEndpoint(b));
      }
    }
  }

  // 4. Execution ↔ owning flow (structural identity).
  for (const fact of executions) {
    const flow = analysis.flowDiscovery?.flows.find(item => item.flowId === fact.flowId);
    if (flow) {
      add(
        "RELATED",
        "SAME_FLOW",
        `Execution for ${fact.flowId} belongs to discovered flow ${flowLabel(flow.flowId, flow.category)}.`,
        executionEndpoint(fact),
        { kind: "FLOW", refId: flow.flowId, label: flowLabel(flow.flowId, flow.category), key: "", page: flowStartPageOf(flow), index: 0 },
      );
    }
  }

  // 5. Finding ↔ scenario ids it links to.
  for (const finding of analysis.findings) {
    const fact = findingById.get(finding.id);
    if (!fact) continue;
    for (const scenarioId of finding.relatedScenarioIds) {
      add(
        "RELATED",
        "SAME_FLOW",
        `${finding.id} can be confirmed by scenario ${scenarioId}.`,
        findingEndpoint(fact),
        { kind: "SCENARIO", refId: scenarioId, label: scenarioId, key: "", page: findingPage(analysis), index: 0 },
      );
    }
  }

  // 6. Regression changes ↔ current-run findings/flows/coverage.
  const flows = analysis.flowDiscovery?.flows ?? [];
  const flowById = new Map(flows.map(flow => [flow.flowId, flow]));
  for (const change of analysis.regression?.changes ?? []) {
    if (change.classification === "UNCHANGED" || change.classification === "UNCHANGED_FLOW") continue;
    const changeEp = { kind: "REGRESSION" as const, refId: change.changeId, label: change.changeId, key: "", page: findingPage(analysis), index: 0 };
    for (const findingId of change.relatedFindingIds) {
      const fact = findingById.get(findingId);
      if (!fact) continue;
      add("SUPPORTS", "REGRESSION_CORRELATION", `${change.changeId} (${change.classification}) is correlated with ${findingId}.`, changeEp, findingEndpoint(fact));
    }
    for (const flowId of change.relatedFlowIds) {
      const flowEntry = flowById.get(flowId);
      if (!flowEntry) continue;
      add("SUPPORTS", "REGRESSION_CORRELATION", `${change.changeId} (${change.classification}) is correlated with flow ${flowLabel(flowId, flowEntry.category)}.`, changeEp, { kind: "FLOW", refId: flowId, label: flowLabel(flowId, flowEntry.category), key: "", page: flowStartPageOf(flowEntry), index: 0 });
    }
    for (const coverageId of change.relatedCoverageIds) {
      const item = analysis.coverage?.items.find(entry => entry.coverageId === coverageId);
      if (!item) continue;
      add("SUPPORTS", "REGRESSION_CORRELATION", `${change.changeId} (${change.classification}) touches coverage item ${coverageId}.`, changeEp, coverageEndpoint(item));
    }
  }

  // 7. Coverage items ↔ findings/flows they explicitly cover.
  for (const item of analysis.coverage?.items ?? []) {
    const itemEp = coverageEndpoint(item);
    for (const findingId of item.relatedFindings) {
      const fact = findingById.get(findingId);
      if (!fact) continue;
      add("RELATED", "SAME_CATEGORY", `Coverage item ${item.coverageId} (${item.category}, ${item.status}) explicitly covers ${findingId}.`, itemEp, findingEndpoint(fact));
    }
    for (const flowId of item.relatedFlows) {
      const flowEntry = flowById.get(flowId);
      if (!flowEntry) continue;
      add("RELATED", "SAME_FLOW", `Coverage item ${item.coverageId} (${item.category}, ${item.status}) covers flow ${flowLabel(flowId, flowEntry.category)}.`, itemEp, { kind: "FLOW", refId: flowId, label: flowLabel(flowId, flowEntry.category), key: "", page: flowStartPageOf(flowEntry), index: 0 });
    }
  }

  return relationships;
};

const coverageEndpoint = (item: CoverageItem) => ({
  kind: "COVERAGE" as const,
  refId: item.coverageId,
  label: `${item.coverageId} (${item.category})`,
  key: "",
  page: item.url ?? item.pageId ?? "",
  index: 0,
});

const flowStartPageOf = (flow: DiscoveredFlow): string => flow.startUrl;

/** Groups of relationships by participant refId, so candidate assembly can
 *  attach supporting vs contradicting evidence without re-scanning lists. */
export const indexRelationships = (relationships: EvidenceRelationship[]) => {
  const byRef = new Map<string, EvidenceRelationship[]>();
  for (const relationship of relationships) {
    for (const ref of [relationship.from.refId, relationship.to.refId]) {
      const bucket = byRef.get(ref) ?? [];
      bucket.push(relationship);
      byRef.set(ref, bucket);
    }
  }
  return byRef;
};

export { scanElements };