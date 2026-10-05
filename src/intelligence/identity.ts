import type { QaAnalysis, QaFinding } from "../ai/types.js";
import type { FlowExecutionResult, FlowStep } from "../flow/types.js";
import type { DiscoveredElement } from "../types.js";
import { elementSemanticKey, normalizePageUrl } from "../regression/identity.js";
import type { EvidenceSourceKind } from "./types.js";

// ---------------------------------------------------------------------------
// Semantic identity for the intelligence layer.
//
// Every relationship and grouping is keyed on NORMALIZED semantic identity
// (reusing the Phase 5 identity rules): a regenerated DOM id, locator text, or
// element index is never evidence. Findings resolve through their evidence refs
// into scan elements; flow steps resolve through their element index; execution
// failures resolve through the step index in their OWNING flow's step list.
// When neither resolves, identity degrades to a normalized locator/page text —
// still never raw, case-variant text.
// ---------------------------------------------------------------------------

export const scanElements = (analysis: QaAnalysis): DiscoveredElement[] => analysis.scan.elements;

export const findingPage = (analysis: QaAnalysis): string => normalizePageUrl(analysis.scan.scan.url);

export const flowStartPage = (flowUrl: string): string => normalizePageUrl(flowUrl);

const elementAt = (analysis: QaAnalysis, index: number | null | undefined): DiscoveredElement | null => {
  if (index == null || index < 0) return null;
  return scanElements(analysis)[index] ?? null;
};

export const elementKeyFor = (element: DiscoveredElement): string => elementSemanticKey(element);

/** Semantic key of the element a finding points at, or null when the finding
 *  carries no element identity (a page-level or console finding). */
export const findingElementKey = (analysis: QaAnalysis, finding: QaFinding): string | null => {
  const ref = finding.evidence.find(item => item.type === "element");
  const element = elementAt(analysis, ref?.index);
  if (element) return elementKeyFor(element);
  if (ref?.locator) return `locator:${ref.locator.toLowerCase().trim()}`;
  return null;
};

/** Semantic key of a discovered-flow step's target, or null when unknown. */
export const stepElementKey = (analysis: QaAnalysis, step: FlowStep): string | null => {
  const element = elementAt(analysis, step.elementIndex);
  if (element) return elementKeyFor(element);
  if (step.locator) return `locator:${step.locator.toLowerCase().trim()}`;
  if (step.targetUrl) return `page:${normalizePageUrl(step.targetUrl)}`;
  return null;
};

/** Semantic key of the element an execution failed at, resolved through its
 *  owning flow's step index (execution records carry only flowId/stepIndex).
 *  Falls back to the failed step's normalized locator when the flow step
 *  cannot be joined (crawl pages that never scanned into this report). */
export const executionElementKey = (analysis: QaAnalysis, execution: FlowExecutionResult): string | null => {
  const flow = analysis.flowDiscovery?.flows.find(item => item.flowId === execution.flowId);
  if (!flow) return null;
  const failed = execution.steps.find(item => item.outcome === "REPRODUCED" || item.outcome === "REVIEW_REQUIRED")
    ?? execution.steps[execution.steps.length - 1];
  const flowStep = failed ? flow.steps[failed.stepIndex] : flow.steps[execution.stoppedAtStep ?? 0];
  if (flowStep) {
    const key = stepElementKey(analysis, flowStep);
    if (key) return key;
  }
  if (failed?.locator) return `locator:${failed.locator.toLowerCase().trim()}`;
  return null;
};

export const executionPage = (execution: FlowExecutionResult): string => {
  const url = execution.finalUrl ?? execution.startedUrl;
  return url ? normalizePageUrl(url) : "";
};

export const endpoint = (kind: EvidenceSourceKind, refId: string, label: string) => ({ kind, refId, label });

export const SOURCE_LABELS: Record<EvidenceSourceKind, string> = {
  FINDING: "finding",
  EXECUTION: "execution",
  FLOW: "flow",
  SCENARIO: "scenario",
  REGRESSION: "regression change",
  COVERAGE: "coverage item",
};

export const findingLabel = (finding: QaFinding): string => `${finding.id} (${finding.code})`;

export const flowLabel = (id: string, category: string): string => `${id} (${category})`;