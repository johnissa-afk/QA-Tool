import type { QaAnalysis } from "../ai/types.js";
import type { CandidatePattern } from "./types.js";
import type { InvestigationAction, InvestigationActionKind } from "./types.js";

// ---------------------------------------------------------------------------
// Investigation actions.
//
// Only SAFE, READ-ONLY actions are ever generated: inspect accessible
// name/role, diff baseline attributes, re-run a safe flow, verify the target in
// a second flow, re-check outside an auth boundary, or re-crawl for variance.
// There is no action kind that mutates state — the whitelist is the safety
// boundary, and every emitted action carries `safe: true`.
// ---------------------------------------------------------------------------

const SAFE_KINDS: InvestigationActionKind[] = [
  "INSPECT_ELEMENT",
  "COMPARE_BASELINE_ATTRIBUTES",
  "RE_RUN_SAFE_NAV_FLOW",
  "VERIFY_SECOND_FLOW_TARGET",
  "CHECK_OUTSIDE_AUTH_BOUNDARY",
  "CHECK_CRAWL_VARIANCE",
];

let actionCounter = 0;

export type InvestigationContext = {
  analysis: QaAnalysis;
  pattern: CandidatePattern;
  targetLabel: string | null;
  flowIds: string[];
  hasBaseline: boolean;
  authContradiction: boolean;
};

export const nextActionId = (): string => {
  actionCounter += 1;
  return `IA-${String(actionCounter).padStart(3, "0")}`;
};

export const resetActionCounter = (): void => {
  actionCounter = 0;
};

const action = (kind: InvestigationActionKind, title: string, detail: string, target: string | null): InvestigationAction => ({
  actionId: nextActionId(),
  kind,
  title,
  detail,
  safe: true,
  target,
});

export function buildInvestigationActions(ctx: InvestigationContext): InvestigationAction[] {
  const { analysis, pattern, targetLabel, flowIds, hasBaseline, authContradiction } = ctx;
  const actions: InvestigationAction[] = [];

  const tooltip = targetLabel ? ` (${targetLabel})` : "";

  if (targetLabel && couldInspect(analysis)) {
    actions.push(action(
      "INSPECT_ELEMENT",
      `Inspect the live element${tooltip}`,
      `Read the accessible name, role, type, href, and visible/enabled state of the target element with a read-only probe. Never modifies state.`,
      targetLabel,
    ));
  }

  if (hasBaseline) {
    actions.push(action(
      "COMPARE_BASELINE_ATTRIBUTES",
      "Compare attributes against baseline evidence",
      `Compare the current element's live attributes with the baseline run's evidence for the same semantic target and note differences (id/name/label changes are not necessarily root causes).`,
      targetLabel ?? null,
    ));
  }

  const safeFlow = flowIds.find(id => (analysis.flowDiscovery?.flows ?? []).some(flow => flow.flowId === id && flow.executable && flow.safety === "SAFE"));
  if (safeFlow) {
    actions.push(action(
      "RE_RUN_SAFE_NAV_FLOW",
      `Re-run the safe flow ${safeFlow}`,
      `Re-run flow ${safeFlow} (SAFE/AUTOMATED steps only), which stops before any review/high-risk/boundary step, and observe whether the same target resolves consistently.`,
      safeFlow,
    ));
  }

  if (flowIds.length >= 2) {
    actions.push(action(
      "VERIFY_SECOND_FLOW_TARGET",
      "Verify the same target in a second flow",
      `Navigate one of the other affected flows (${flowIds.sort().join(", ")}) to the same normalized page and observe whether the identical semantic target stalls it too — confirming a shared cause rather than a one-off.`,
      targetLabel ?? null,
    ));
  }

  if (authContradiction) {
    actions.push(action(
      "CHECK_OUTSIDE_AUTH_BOUNDARY",
      "Re-check the target outside the authentication boundary",
      `The failure occurred behind an auth boundary. Re-observe the same semantic target on the pre-auth surface (or with a fresh session) to separate gating from a genuine target problem.`,
      targetLabel ?? null,
    ));
  }

  if (pattern === "DISCOVERY_VARIANCE" || pattern === "INFRASTRUCTURE") {
    actions.push(action(
      "CHECK_CRAWL_VARIANCE",
      "Re-crawl and compare discovery stability",
      `Re-run the same bounded crawl and compare discovered flows and coverage against this run to separate crawl/runner instability from a real site change.`,
      null,
    ));
  }

  // Default to the safest possible action when nothing above matched.
  if (actions.length === 0) {
    actions.push(action(
      "INSPECT_ELEMENT",
      targetLabel ? `Inspect the live element${tooltip}` : "Inspect the affected area from the report",
      `Read the live page region referenced by this candidate with a read-only probe and confirm the observed state. Never modifies state.`,
      targetLabel ?? null,
    ));
  }

  return actions;
}

/** Only suggest element inspection when this scan report actually has elements
 *  the probe could address — page-identity candidates get the generic action. */
const couldInspect = (analysis: QaAnalysis): boolean =>
  analysis.scan.elements.length > 0 || (analysis.flowDiscovery?.graph.pages.length ?? 0) > 0;

export { SAFE_KINDS };