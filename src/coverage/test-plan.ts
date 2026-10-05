import { QaFinding } from "../ai/types.js";
import { DiscoveredFlow, FlowPriority } from "../flow/types.js";
import { CoverageItem, CoverageStatus, TestPlanRecommendation, TestPlanRecommendationType } from "./types.js";

// ---------------------------------------------------------------------------
// Test-plan recommendations (Phase 4, section 13/16).
//
// Every recommendation traces to >= 1 coverage item. Nothing is generated for
// TESTED or NOT_APPLICABLE items. Priorities come from the existing flow
// priority model (P0–P4); the AI may reprioritize existing IDs but the list
// itself and the actions stay deterministic.
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<FlowPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

const DEFAULT_PRIORITY: Record<TestPlanRecommendationType, FlowPriority> = {
  TEST_PAGE: "P2",
  REVIEW_PAGE: "P2",
  TEST_NAVIGATION: "P2",
  REVIEW_NAVIGATION: "P2",
  INVESTIGATE_BROKEN_NAVIGATION: "P1",
  EXECUTE_FLOW: "P2",
  COMPLETE_FLOW: "P2",
  REVIEW_FLOW: "P2",
  REVIEW_BLOCKED_FLOW: "P1",
  TEST_SEARCH_FLOW: "P1",
  COMPLETE_SEARCH: "P2",
  REVIEW_LANGUAGE_SWITCH: "P2",
  REVIEW_MEDIA: "P3",
  REVIEW_AUTHENTICATION_BOUNDARY: "P1",
  INVESTIGATE_ERROR_HANDLING: "P1",
  TEST_CONTENT_DISCOVERY: "P3",
  INSPECT_UNTESTED_FORM: "P2",
  REVIEW_FORM: "P2",
  REVIEW_BLOCKED_FORM: "P1",
  VERIFY_ACCESSIBILITY: "P2",
  REVIEW_ACCESSIBILITY: "P2",
  RESPONSIVE_CHECK: "P3",
  TEST_INTERACTION_GROUP: "P3",
  REVIEW_INTERACTION_GROUP: "P2",
};

const WHY: Record<TestPlanRecommendationType, string> = {
  TEST_PAGE: "Pages matter when their flows execute — a scanned-but-untested page answers nothing about its behavior. Run with --execute.",
  REVIEW_PAGE: "This page can only be progressed by a human decision (blocked or review-required coverage).",
  TEST_NAVIGATION: "Navigation links underpin every other user journey; each destination either executes or stays unknown.",
  REVIEW_NAVIGATION: "No executable flow could be derived for this destination — the locator or structure needs review.",
  INVESTIGATE_BROKEN_NAVIGATION: "A destination is broken or the failure is live-confirmed — broken navigation is the highest-impact defect class.",
  EXECUTE_FLOW: "Executing the flow records real behavior (pass, reproduce, boundary stop) instead of a scan-time guess.",
  COMPLETE_FLOW: "This flow is only partially covered; completing its steps closes a real evidence gap.",
  REVIEW_FLOW: "The flow stops at a non-executable step; decide whether the step is safe to broaden before it can run.",
  REVIEW_BLOCKED_FLOW: "The flow is blocked at a safety boundary (e.g., authentication) — the boundary itself is the deliverable to review.",
  TEST_SEARCH_FLOW: "Search is a primary discovery path; running the safe search flow gives real results-state coverage.",
  COMPLETE_SEARCH: "Search coverage is incomplete — exercise the empty/no-result state or the un-run control.",
  REVIEW_LANGUAGE_SWITCH: "Language switching changes content reachability; each locale a switch opens is content that otherwise stays untested.",
  REVIEW_MEDIA: "Media playback/seek is review-only by design; confirm expected player behavior manually.",
  REVIEW_AUTHENTICATION_BOUNDARY: "Login is never automated; the observed safe boundary and the elements it stopped at need a human owner.",
  INVESTIGATE_ERROR_HANDLING: "Error states (broken links, uncaught errors, HTTP failures) block whole journeys and need investigation.",
  TEST_CONTENT_DISCOVERY: "Content detail pages are secondary journeys — exercising them closes low-cost coverage gaps.",
  INSPECT_UNTESTED_FORM: "Forms are never auto-submitted; validate labels, hints, and validation rules manually.",
  REVIEW_FORM: "Label or structure findings inside this form must be resolved before it can be exercised.",
  REVIEW_BLOCKED_FORM: "Destructive/payment/authentication form — the blocked controls themselves are the review object.",
  VERIFY_ACCESSIBILITY: "A safe verification probe exists for this accessibility signal; running it converts a scanner guess into evidence.",
  REVIEW_ACCESSIBILITY: "The accessibility signal could not be confirmed or ruled out automatically — review required.",
  RESPONSIVE_CHECK: "Responsive coverage needs tablet/mobile execution; the desktop scan alone cannot claim it.",
  TEST_INTERACTION_GROUP: "Interaction groups are only partially covered; exercise the shipped control family for real behavior.",
  REVIEW_INTERACTION_GROUP: "Interaction findings require a human decision (broken links, review-required groups).",
};

function descend(item: CoverageItem, flowsById: Map<string, DiscoveredFlow>, searchTestedPages: Set<string>): { type: TestPlanRecommendationType; flow: DiscoveredFlow | null } {
  const flow = item.relatedFlows.map(id => flowsById.get(id)).find(Boolean) ?? null;

  switch (item.category) {
    case "PAGE":
      if (item.status === "NOT_TESTED") return { type: "TEST_PAGE", flow };
      if (item.status === "REVIEW_REQUIRED") return { type: "REVIEW_PAGE", flow };
      if (item.status === "PARTIALLY_TESTED" && /blocked|review/i.test(item.reason)) return { type: "REVIEW_PAGE", flow };
      return { type: "TEST_PAGE", flow };
    case "NAVIGATION":
      if (item.status === "REVIEW_REQUIRED" && (item.executionStatus === "REPRODUCED" || /error|fail|broken/.test(item.reason))) return { type: "INVESTIGATE_BROKEN_NAVIGATION", flow };
      if (item.status === "REVIEW_REQUIRED") return { type: "REVIEW_NAVIGATION", flow };
      return { type: "TEST_NAVIGATION", flow };
    case "CONTENT_DISCOVERY":
      if (item.status === "REVIEW_REQUIRED") return { type: "REVIEW_NAVIGATION", flow };
      return { type: "TEST_CONTENT_DISCOVERY", flow };
    case "FLOW":
      if (item.status === "NOT_TESTED") return { type: "EXECUTE_FLOW", flow };
      if (item.status === "PARTIALLY_TESTED") return { type: "COMPLETE_FLOW", flow };
      if (item.status === "BLOCKED") return { type: "REVIEW_BLOCKED_FLOW", flow };
      return { type: "REVIEW_FLOW", flow };
    case "INTERACTION":
      if (item.status === "REVIEW_REQUIRED") return { type: "REVIEW_INTERACTION_GROUP", flow };
      return { type: "TEST_INTERACTION_GROUP", flow };
    case "FORM":
      if (item.status === "BLOCKED") return { type: "REVIEW_BLOCKED_FORM", flow };
      if (item.status === "REVIEW_REQUIRED") return { type: "REVIEW_FORM", flow };
      return { type: "INSPECT_UNTESTED_FORM", flow };
    case "SEARCH":
      if (item.status === "PARTIALLY_TESTED") return { type: "COMPLETE_SEARCH", flow };
      if (item.status === "NOT_TESTED" && item.pageId !== null && searchTestedPages.has(item.pageId))
        return { type: "COMPLETE_SEARCH", flow };
      return { type: "TEST_SEARCH_FLOW", flow };
    case "AUTHENTICATION_BOUNDARY":
      return { type: "REVIEW_AUTHENTICATION_BOUNDARY", flow };
    case "LANGUAGE":
      return { type: "REVIEW_LANGUAGE_SWITCH", flow };
    case "MEDIA":
      return { type: "REVIEW_MEDIA", flow };
    case "ERROR_HANDLING":
      if (item.status === "REVIEW_REQUIRED") return { type: "INVESTIGATE_ERROR_HANDLING", flow };
      return { type: "INVESTIGATE_ERROR_HANDLING", flow };
    case "ACCESSIBILITY_CHECK":
      if (item.status === "REVIEW_REQUIRED") return { type: "REVIEW_ACCESSIBILITY", flow };
      if (item.status === "PARTIALLY_TESTED") return { type: "REVIEW_ACCESSIBILITY", flow };
      return { type: "VERIFY_ACCESSIBILITY", flow };
    case "RESPONSIVE_CHECK":
      return { type: "RESPONSIVE_CHECK", flow };
  }
}

function titleFor(type: TestPlanRecommendationType, item: CoverageItem): string {
  const name = item.url ? `${item.name}` : item.name;
  switch (type) {
    case "TEST_PAGE":
      return `Test untested page — ${name}`;
    case "REVIEW_PAGE":
      return `Review page — ${name}`;
    case "TEST_NAVIGATION":
      return `Exercise destination — ${item.url ?? item.name}`;
    case "REVIEW_NAVIGATION":
      return `Review navigation to — ${item.url ?? item.name}`;
    case "INVESTIGATE_BROKEN_NAVIGATION":
      return `Investigate broken destination — ${item.url ?? item.name}`;
    case "EXECUTE_FLOW":
      return `Execute flow — ${item.name}`;
    case "COMPLETE_FLOW":
      return `Complete flow coverage — ${item.name}`;
    case "REVIEW_FLOW":
      return `Review flow — ${item.name}`;
    case "REVIEW_BLOCKED_FLOW":
      return `Review blocked flow — ${item.name}`;
    case "TEST_SEARCH_FLOW":
      return `Test — ${item.name}`;
    case "COMPLETE_SEARCH":
      return `Complete search coverage — ${item.name}`;
    case "REVIEW_LANGUAGE_SWITCH":
      return `Review language switch — ${item.name}`;
    case "REVIEW_MEDIA":
      return `Review media — ${item.name}`;
    case "REVIEW_AUTHENTICATION_BOUNDARY":
      return `Review authentication boundary — ${item.name}`;
    case "INVESTIGATE_ERROR_HANDLING":
      return `Investigate — ${name}`;
    case "TEST_CONTENT_DISCOVERY":
      return `Exercise content discovery — ${item.name}`;
    case "INSPECT_UNTESTED_FORM":
      return `Inspect — ${item.name}`;
    case "REVIEW_FORM":
      return `Review — ${item.name}`;
    case "REVIEW_BLOCKED_FORM":
      return `Review blocked form — ${item.name}`;
    case "VERIFY_ACCESSIBILITY":
      return `Verify — ${item.name}`;
    case "REVIEW_ACCESSIBILITY":
      return `Review — ${item.name}`;
    case "RESPONSIVE_CHECK":
      return `Run responsive checks (${item.name})`;
    case "TEST_INTERACTION_GROUP":
      return `Exercise — ${item.name}`;
    case "REVIEW_INTERACTION_GROUP":
      return `Review — ${item.name}`;
  }
}

export function buildTestPlan(items: CoverageItem[], flows: DiscoveredFlow[], findings: QaFinding[] = []): TestPlanRecommendation[] {
  const flowsById = new Map(flows.map(flow => [flow.flowId, flow]));
  const severityByFindingId = new Map(findings.map(finding => [finding.id, finding.severity]));

  const recs: TestPlanRecommendation[] = [];
  const seen = new Set<string>();
  const searchTestedPages = new Set(items.filter(item => item.category === "SEARCH" && item.status === "TESTED").map(item => item.pageId).filter((id): id is string => id !== null));

  for (const item of items) {
    if (item.status === "TESTED" || item.status === "NOT_APPLICABLE") continue;

    const { type, flow } = descend(item, flowsById, searchTestedPages);
    const dedupeKey = `${type}:${item.url ?? item.coverageId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let priority = DEFAULT_PRIORITY[type];
    let priorityReason = WHY[type];

    if ((type === "REVIEW_BLOCKED_FLOW" || type === "REVIEW_AUTHENTICATION_BOUNDARY" || type === "REVIEW_BLOCKED_FORM") && item.status === "BLOCKED") {
      priority = "P1";
      priorityReason = "P1 — a blocked boundary affects real user journeys; assign an owner before release.";
    }
    if (flow && (type === "EXECUTE_FLOW" || type === "COMPLETE_FLOW" || type === "REVIEW_FLOW")) {
      priority = flow.priority;
      priorityReason = flow.priorityReason || WHY[type];
    }
    if (type === "VERIFY_ACCESSIBILITY" || type === "REVIEW_ACCESSIBILITY") {
      const worst = item.relatedFindings.map(id => severityByFindingId.get(id) ?? null).filter(Boolean) as string[];
      if (worst.includes("CRITICAL") || worst.includes("HIGH")) {
        priority = "P1";
        priorityReason = "P1 — high/CRITICAL accessibility signals should be verified or reviewed first.";
      }
    }
    if ((type === "REVIEW_BLOCKED_FORM" || type === "REVIEW_PAGE") && item.safety === "BLOCKED") priority = "P1";

    const flowLabel = flow ? flow.flowId : type === "EXECUTE_FLOW" || type === "REVIEW_FLOW" || type === "REVIEW_BLOCKED_FLOW" || type === "COMPLETE_FLOW" ? item.relatedFlows.join(",") : null;
    const reason = [`Coverage: ${item.category} ${item.status}. ${item.reason}`];
    if (flowLabel) reason.push(`Flow: ${flowLabel}.`);
    if (item.relatedFindings.length) reason.push(`Findings: ${item.relatedFindings.join(", ")}.`);

    recs.push({
      recommendationId: "", // assigned after sort
      type,
      title: titleFor(type, item),
      reason: reason.join(" "),
      priority,
      priorityReason,
      coverageIds: [item.coverageId],
      relatedFindings: item.relatedFindings,
      evidence: item.evidence,
    });
  }

  recs.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  return recs.slice(0, 40).map((rec, index) => ({ ...rec, recommendationId: `REC-${String(index + 1).padStart(3, "0")}` }));
}

// Re-exported helper so callers can name statuses without importing the engine.
export type { CoverageStatus };