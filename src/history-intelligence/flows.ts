// ---------------------------------------------------------------------------
// Phase 7B — flow history and stability.
//
// A flow is identified across runs by its Phase 7A/5 family key (category +
// normalized start page); the full signature additionally pins its step
// sequence. Stability is about the flow's BEHAVIOR over ordered runs — it never
// scores the site. Outcomes come from the run's own FLOW coverage evidence
// (executionStatus), with the Phase 3 precedence
// INFRASTRUCTURE_PROBLEM > REPRODUCED > REVIEW_REQUIRED > NOT_REPRODUCED >
// BLOCKED > PASS. Safety stops (BLOCKED), review stops, and infrastructure
// failures are NEVER counted as product failures.
//
// Stability classification (documented): requires 3+ ordered runs.
//   - STABLE  — the same outcome in every available run (>= 2 runs carried it)
//               and the signature never changed.
//   - UNSTABLE — outcomes flip between success and failure at least twice.
//   - VARIABLE — outcomes differ but do not qualify as UNSTABLE (or the flow's
//               step sequence changed across runs).
//   - INSUFFICIENT_EVIDENCE — fewer than 3 runs or execution evidence missing.
// ---------------------------------------------------------------------------
import type { CoverageHistorySnapshot, FlowHistorySnapshot, HistoryRunSnapshot } from "../history/index.js";
import { deriveConfidence } from "./confidence.js";
import type { FlowHistoricalOutcome, FlowStability, FlowStabilityRecord } from "./types.js";
import { identityMapsOf, OrderedRun } from "./matching.js";

const OUTCOME_PRECEDENCE: Record<string, number> = {
  INFRASTRUCTURE_PROBLEM: 5,
  REPRODUCED: 4,
  REVIEW_REQUIRED: 3,
  NOT_REPRODUCED: 2,
  BLOCKED: 1,
  PASS: 0,
};

const FAILURE_OUTCOMES = new Set(["REPRODUCED", "REVIEW_REQUIRED"]);

function flowOutcomeOf(items: CoverageHistorySnapshot[]): string | null {
  const outcomes = items
    .map(item => (typeof item.executionStatus === "string" && item.executionStatus ? item.executionStatus : null))
    .filter((value): value is string => value !== null);
  if (!outcomes.length) return null;
  return [...outcomes].sort((a, b) => (OUTCOME_PRECEDENCE[b] ?? 0) - (OUTCOME_PRECEDENCE[a] ?? 0))[0]!;
}

export function classifyFlowStability(
  outcomes: FlowHistoricalOutcome[],
): { stability: FlowStability; reason: string; reviewNote: string | null } {
  const n = outcomes.length;
  if (n < 3) return { stability: "INSUFFICIENT_EVIDENCE", reason: "flow stability needs 3+ ordered runs", reviewNote: null };

  const signatures = new Set(outcomes.map(outcome => outcome.signature).filter(Boolean));
  const presentEverywhere = outcomes.every(outcome => outcome.present);
  const carriedOutcomes = outcomes.filter(outcome => outcome.executionOutcome !== null);
  const variants = new Set(carriedOutcomes.map(outcome => outcome.executionOutcome!));
  const signatureChanged = signatures.size > 1;

  if (variants.size === 0) {
    return {
      stability: "INSUFFICIENT_EVIDENCE",
      reason: "no flow execution evidence was carried across the runs",
      reviewNote: null,
    };
  }
  if (carriedOutcomes.length >= 2 && variants.size === 1 && !signatureChanged && presentEverywhere) {
    return { stability: "STABLE", reason: `the flow produced the same outcome (${[...variants][0]}) in every observed run and its step sequence never changed`, reviewNote: null };
  }

  const failures = carriedOutcomes.map(outcome => FAILURE_OUTCOMES.has(outcome.executionOutcome!));
  const failureTransitions = failures.slice(1).reduce<number>((count, flag, index) => (flag !== failures[index] ? count + 1 : count), 0);
  if (carriedOutcomes.length >= 3 && failureTransitions >= 2) {
    return {
      stability: "UNSTABLE",
      reason: "the flow's outcome flips between success and failure across runs",
      reviewNote: "alternating pass/fail outcomes — the flow behaves inconsistently across runs",
    };
  }
  if (variants.size > 1) {
    const detail = signatureChanged ? " and its step sequence changed across runs" : "";
    return { stability: "VARIABLE", reason: `the flow's outcomes differed across runs (${[...variants].sort().join(", ")})${detail}`, reviewNote: signatureChanged ? "the flow changed shape between runs" : null };
  }
  if (carriedOutcomes.length < 2) {
    return { stability: "INSUFFICIENT_EVIDENCE", reason: "too few runs carried executable outcomes for a stability claim", reviewNote: null };
  }
  return { stability: "VARIABLE", reason: "the flow's evidence varied across runs without forming an alternating pattern", reviewNote: null };
}

/** Latest-record metadata captured while scanning ordered runs (last writer
 *  wins, so the final value is the most recent discovery). */
type FlowMeta = {
  category: string;
  startPage: string;
  title: string;
  signature: string | null;
};

export function buildHistoricalFlows(ordered: OrderedRun[]): FlowStabilityRecord[] {
  const contexts = ordered.map(item => ({ ordered: item, maps: identityMapsOf(item.snapshot) }));
  const allFamilies = new Set<string>();
  for (const { maps } of contexts) for (const family of maps.flowsByFamily.keys()) allFamilies.add(family);

  const byFamily = new Map<string, FlowHistoricalOutcome[]>();
  const meta = new Map<string, FlowMeta>();

  for (const familyKey of allFamilies) {
    const outcomes: FlowHistoricalOutcome[] = [];
    for (const { ordered, maps } of contexts) {
      const record = maps.flowsByFamily.get(familyKey) ?? null;
      const items = record ? maps.coverageByFlow.get(record.flowId) ?? [] : [];
      const outcome = flowOutcomeOf(items);
      outcomes.push({
        runId: ordered.record.runId,
        present: record !== null,
        signature: record?.signature ?? null,
        title: record?.title ?? null,
        executionOutcome: outcome,
        coverageStatus: outcome ? items.find(item => item.executionStatus === outcome)?.status ?? null : null,
      });
      if (record) {
        meta.set(familyKey, { category: record.category, startPage: record.startPage, title: record.title, signature: record.signature });
      }
    }
    byFamily.set(familyKey, outcomes);
  }

  const records: FlowStabilityRecord[] = [];
  for (const familyKey of allFamilies) {
    const outcomes = byFamily.get(familyKey)!;
    const latest = meta.get(familyKey) ?? null;
    const classification = classifyFlowStability(outcomes);
    const failureRunIds = outcomes.filter(outcome => FAILURE_OUTCOMES.has(outcome.executionOutcome ?? "")).map(outcome => outcome.runId);
    const infrastructureRunIds = outcomes.filter(outcome => outcome.executionOutcome === "INFRASTRUCTURE_PROBLEM").map(outcome => outcome.runId);

    const confidence = deriveConfidence({
      orderedRunCount: ordered.length,
      observedRunCount: outcomes.filter(outcome => outcome.executionOutcome !== null).length,
      contradictions: 0,
      verified: outcomes.some(outcome => outcome.executionOutcome !== null),
      covered: outcomes.some(outcome => outcome.coverageStatus !== null),
      gapDependent: classification.stability === "INSUFFICIENT_EVIDENCE",
    });

    records.push({
      familyKey,
      signature: latest?.signature ?? null,
      category: latest?.category ?? "",
      title: latest?.title ?? "",
      startPage: latest?.startPage ?? canonicalStartPage(outcomes),
      stability: classification.stability,
      confidence: classification.stability === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT" : confidence.confidence,
      confidenceReason: `${classification.reason}. ${confidence.reason}`.trim(),
      runIds: outcomes.map(outcome => outcome.runId),
      runCount: outcomes.length,
      outcomes,
      failureRunIds,
      infrastructureRunIds,
      reviewNote: classification.reviewNote,
    });
  }
  return records;
}

function canonicalStartPage(outcomes: FlowHistoricalOutcome[]): string {
  return outcomes.map(outcome => outcome.signature?.split("|")[1] ?? "").find(Boolean) ?? "";
}

export type { FlowHistorySnapshot, HistoryRunSnapshot };