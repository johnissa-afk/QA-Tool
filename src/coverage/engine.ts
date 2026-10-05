import { ScanReport } from "../types.js";
import { QaFinding, VerificationResult } from "../ai/types.js";
import {
  DiscoveredFlow,
  FlowDiscovery,
  FlowEvidenceRef,
  FlowExecutionResult,
  FlowPriority,
  FlowStepOutcome,
  SitePageNode,
} from "../flow/types.js";
import { DESTRUCTIVE_TEXT } from "../flow/classify.js";
import { normalizeUrl } from "../flow/graph.js";
import {
  CoverageCategory,
  CoverageExecutionStatus,
  CoverageItem,
  CoverageMap,
  CoverageSafety,
  CoverageStatus,
  CoverageSummary,
  CoverageDigest,
  CoverageEnhancement,
} from "./types.js";
import { emptyCoverageSummary } from "./types.js";
import { buildTestPlan } from "./test-plan.js";

// ---------------------------------------------------------------------------
// Deterministic coverage engine (Phase 4).
//
// Coverage is evidence-based:
//   * scanning an element is a FACT, never a TEST
//   * TESTED requires execution evidence (a flow step, a verification probe,
//     or a live scanner read such as link-integrity / document language)
//   * statuses never contradict executions — REVIEW_REQUIRED is not hidden,
//     BLOCKED is not downgraded, NOT_REPRODUCED stays partial
//   * every item and recommendation traces to concrete evidence
// The engine is deterministic: AI can reword gap summaries and reprioritize
// existing recommendations, but it can never create coverage or flip statuses.
// ---------------------------------------------------------------------------

export type CoverageEngineInput = {
  report: ScanReport;
  flowDiscovery: FlowDiscovery;
  findings: QaFinding[];
  verifications: VerificationResult[];
};

const START_PAGE_LABEL_CODES = new Set(["input-missing-label", "password-missing-label"]);
const EMPTY_STATE_RE = /(no match|0 result|no results|nothing to show|not found)/i;
const TERMINAL_DISPOSITIONS = new Set(["REPRODUCED", "NOT_REPRODUCED", "PASSED", "REVIEW_REQUIRED"]);

const FLOW_STATUS: Record<string, CoverageStatus> = {
  PASS: "TESTED",
  REPRODUCED: "TESTED",
  NOT_REPRODUCED: "PARTIALLY_TESTED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  BLOCKED: "BLOCKED",
  INFRASTRUCTURE_PROBLEM: "PARTIALLY_TESTED",
};

const DISPOSITION_STATUS: Record<string, CoverageStatus> = {
  REPRODUCED: "TESTED",
  NOT_REPRODUCED: "TESTED",
  PASSED: "TESTED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  INFRASTRUCTURE_PROBLEM: "PARTIALLY_TESTED",
  SCHEDULED: "NOT_TESTED",
  SKIPPED_UNSUPPORTED: "PARTIALLY_TESTED",
  SKIPPED_LOCATOR_GUARD: "PARTIALLY_TESTED",
  SKIPPED_SAFETY: "PARTIALLY_TESTED",
};

function padId(n: number): string {
  return String(n).padStart(3, "0");
}

function statusCount(items: CoverageItem[], category: CoverageCategory | null, status: CoverageStatus): number {
  return items.filter(item => (category === null || item.category === category) && item.status === status).length;
}

function pageEvidence(node: SitePageNode | null | undefined): FlowEvidenceRef[] {
  if (!node) return [{ pageId: null, elementIndex: null, detail: "site graph root unavailable" }];
  const detail = node.title ? `${node.title} (${node.url})` : node.url;
  return [{ pageId: node.id, elementIndex: null, detail }];
}

function splitDedupeKey(key: string): [string, string] {
  const sep = key.indexOf(":");
  if (sep < 0) return [key, ""];
  return [key.slice(0, sep), key.slice(sep + 1)];
}

function flowReasonFromOutcome(outcome: FlowStepOutcome, subject: string): string {
  switch (outcome) {
    case "PASS":
      return `Live execution passed: ${subject}.`;
    case "REPRODUCED":
      return `Live execution reproduced the suspected problem on ${subject} — treat as an active defect until triaged.`;
    case "NOT_REPRODUCED":
      return `Live execution could not reproduce the suspected problem on ${subject}; the scanner signal did not hold.`;
    case "REVIEW_REQUIRED":
      return `Live execution stopped or could not decide on ${subject}; human review required.`;
    case "BLOCKED":
      return `Execution stopped at a safety/review boundary before reaching ${subject}.`;
    case "INFRASTRUCTURE_PROBLEM":
      return `Execution of ${subject} hit an infrastructure problem (network/runner/timeout) — not a site verdict.`;
    default:
      return `Execution of ${subject} is inconclusive.`;
  }
}

// ---------------------------------------------------------------------------
// PAGE coverage.
// ---------------------------------------------------------------------------
function buildPageItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>, executableFlowIds: Set<string>): CoverageItem[] {
  const { flowDiscovery, report } = ctx;
  const pages = flowDiscovery.graph.pages;
  const flows = flowDiscovery.flows;
  const items: CoverageItem[] = [];

  pages.forEach((page, pageIx) => {
    const fromFlows = flows.filter(flow => flow.startPageId === page.id);
    const intoFlows = flows.filter(flow => {
      const [prefix, href] = splitDedupeKey(flow.dedupeKey);
      if (prefix !== "nav" && prefix !== "content" && prefix !== "error") return false;
      return normalizeUrl(href) === page.url;
    });
    const pageFlows = [...new Map([...fromFlows, ...intoFlows].map(flow => [flow.flowId, flow])).values()];
    const execs = pageFlows.map(flow => byScenario.get(`SC-${flow.flowId}`)).filter((e): e is FlowExecutionResult => Boolean(e));
    const executable = pageFlows.filter(flow => executableFlowIds.has(flow.flowId)).length;
    const executedExecutable = execs.filter(execution => executableFlowIds.has(execution.flowId)).length;
    const passCount = execs.filter(e => e.status === "PASS").length;
    const reproducedCount = execs.filter(e => e.status === "REPRODUCED").length;
    const notReproducedCount = execs.filter(e => e.status === "NOT_REPRODUCED").length;
    const reviewCount = execs.filter(e => e.status === "REVIEW_REQUIRED" || e.status === "INFRASTRUCTURE_PROBLEM").length;
    const blockedCount = execs.filter(e => e.status === "BLOCKED").length;

    let status: CoverageStatus;
    let reason: string;
    let safety: CoverageSafety = "SAFE";

    if (page.navigationStatus !== null && page.navigationStatus >= 400) {
      status = "REVIEW_REQUIRED";
      safety = "REVIEW";
      reason = `The page returned HTTP ${page.navigationStatus} on load. Coverage requires a reachable page — confirm the URL or the network path.`;
    } else if (pageFlows.length === 0) {
      status = "NOT_TESTED";
      reason = `Discovered and scanned (${page.controls.length} control(s), ${page.edges.length} link(s)) but no flow or executed check is attached to this page. Run with --execute.`;
    } else if (execs.length === 0 && executable === 0) {
      const boundaryFlows = pageFlows.filter(flow => flow.category === "AUTHENTICATION" || flow.category === "SIGNUP" || flow.safety === "BLOCKED");
      if (boundaryFlows.length > 0) {
        status = "BLOCKED";
        safety = "BLOCKED";
        reason = `Every flow here stops at a safety boundary (${boundaryFlows.map(f => f.flowId).join(", ")}). Coverage requires human review of this page.`;
      } else {
        status = "REVIEW_REQUIRED";
        safety = "REVIEW";
        reason = `Every flow on this page needs human review before it can execute safely (${pageFlows.map(f => f.flowId).join(", ")}). Run with --execute to record their boundaries.`;
      }
    } else if (execs.length === 0) {
      status = "NOT_TESTED";
      reason = `${pageFlows.length} flow(s) discovered (${executable} executable) but none executed on this page yet. Run with --execute.`;
    } else {
      const allExecutableExecuted = executable === 0 || executedExecutable === executable;
      const allClean = execs.length === passCount + reproducedCount;
      const segments: string[] = [`${execs.length} flow(s) executed on this page`];
      if (passCount > 0) segments.push(`${passCount} passed`);
      if (reproducedCount > 0) segments.push(`${reproducedCount} reproduced a live problem`);
      if (notReproducedCount > 0) segments.push(`${notReproducedCount} did not reproduce`);
      if (reviewCount > 0) segments.push(`${reviewCount} need human review/infrastructure`);
      if (blockedCount > 0) segments.push(`${blockedCount} blocked at safety boundaries`);
      if (executable > 0 && !allExecutableExecuted) segments.push(`${executable - executedExecutable} executable flow(s) not yet run`);
      if (allExecutableExecuted && allClean && reviewCount === 0) {
        status = blockedCount > 0 ? "PARTIALLY_TESTED" : "TESTED";
        if (blockedCount > 0) safety = "BLOCKED";
      } else {
        status = "PARTIALLY_TESTED";
        if (blockedCount > 0) safety = "BLOCKED";
        else if (reviewCount > 0) safety = "REVIEW";
      }
      reason = segments.join("; ") + ".";
    }

    items.push({
      coverageId: `COV-PAGE-${padId(pageIx + 1)}`,
      category: "PAGE",
      name: pageIx === 0 ? `Page coverage — ${page.title ?? report.scan.url}` : `Page coverage — ${page.title ?? page.url}`,
      status,
      reason,
      safety,
      executionStatus: execs.length ? execs[execs.length - 1]!.status : null,
      pageId: page.id,
      url: page.url,
      relatedFlows: pageFlows.map(f => f.flowId),
      relatedScenarios: execs.map(e => e.scenarioId),
      relatedFindings: [],
      evidence: pageEvidence(page),
    });
  });

  return items;
}

// ---------------------------------------------------------------------------
// NAVIGATION / CONTENT_DISCOVERY coverage (one item per unique edge).
// ---------------------------------------------------------------------------
function buildLinkItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>, category: "NAVIGATION" | "CONTENT_DISCOVERY", prefix: "nav" | "content"): CoverageItem[] {
  const { flowDiscovery } = ctx;
  const { graph, flows } = flowDiscovery;
  const items: CoverageItem[] = [];

  const edgeMap = new Map<string, { href: string; nodes: SitePageNode[]; count: number }>();
  for (const page of graph.pages) {
    for (const edge of page.edges) {
      if (edge.origin !== "same" || edge.broken) continue;
      const href = normalizeUrl(edge.href);
      const existing = edgeMap.get(href) ?? { href, nodes: [] as SitePageNode[], count: 0 };
      existing.count += edge.count;
      if (!existing.nodes.some(node => node.id === page.id)) existing.nodes.push(page);
      edgeMap.set(href, existing);
    }
  }

  let seq = 0;
  for (const [href, entry] of edgeMap) {
    const related = flows
      .filter(flow => {
        if (!flow.dedupeKey.startsWith(`${prefix}:`)) return false;
        const [, suffix] = splitDedupeKey(flow.dedupeKey);
        return normalizeUrl(suffix) === href;
      })
      .sort((a, b) => a.occurrenceCount - b.occurrenceCount);
    const flow = related[0] ?? null;
    const execution = flow ? byScenario.get(`SC-${flow.flowId}`) : null;

    // A category item is only emitted for edges that actually carry a flow of
    // this prefix: an edge owned by a CONTENT_DISCOVERY flow never spawns a
    // NAVIGATION item (and vice versa), so no edge is counted twice.
    if (related.length === 0) continue;

    let status: CoverageStatus;
    let reason: string;
    let safety: CoverageSafety = "SAFE";
    if (!execution) {
      if (flow) {
        if (flow.executable) {
          status = "NOT_TESTED";
          reason = "Destination discovered but its navigation flow has not run yet. Run with --execute.";
        } else {
          status = "REVIEW_REQUIRED";
          safety = "REVIEW";
          reason = `No executable flow could be generated for this destination (${flow.flowId}) — requires human review.`;
        }
      } else {
        status = "NOT_TESTED";
        reason = "Destination discovered but no navigation flow was generated. Run with --execute to exercise it.";
      }
    } else {
      status = FLOW_STATUS[execution.status] ?? "PARTIALLY_TESTED";
      safety = execution.status === "BLOCKED" ? "REVIEW" : safety;
      reason = flowReasonFromOutcome(execution.status, `navigation flow ${flow?.flowId ?? "?"} to ${href}`);
    }

    seq += 1;
    items.push({
      coverageId: category === "NAVIGATION" ? `COV-NAV-${padId(seq)}` : `COV-CONTENT-${padId(seq)}`,
      category,
      name: flow?.title ?? `${category === "NAVIGATION" ? "Navigate to" : "Open content at"} ${href}`,
      status,
      reason,
      safety,
      executionStatus: execution?.status ?? null,
      pageId: entry.nodes[0]?.id ?? null,
      url: href,
      relatedFlows: flow ? [flow.flowId] : [],
      relatedScenarios: execution ? [execution.scenarioId] : [],
      relatedFindings: [],
      evidence: flow && flow.evidence.length ? flow.evidence : entry.nodes.flatMap(node => pageEvidence(node)),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// FLOW coverage (per discovered flow) + AUTHENTICATION_BOUNDARY coverage.
// ---------------------------------------------------------------------------
function buildFlowItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>): CoverageItem[] {
  const { flowDiscovery } = ctx;
  const items: CoverageItem[] = [];

  flowDiscovery.flows.forEach((flow, index) => {
    const execution = byScenario.get(`SC-${flow.flowId}`);
    let status: CoverageStatus;
    let reason: string;
    let safety: CoverageSafety = flow.safety;
    if (!execution) {
      if (flow.executable) {
        status = "NOT_TESTED";
        reason = "Flow discovered and executable (SAFE + AUTOMATED steps) but not yet executed. Run with --execute.";
      } else {
        status = "REVIEW_REQUIRED";
        reason = `Flow is not fully executable (boundary: ${flow.boundary?.reason ?? "review/high-risk step"}). Run with --execute to record its boundary.`;
      }
    } else {
      status = FLOW_STATUS[execution.status] ?? "PARTIALLY_TESTED";
      safety = execution.status === "BLOCKED" ? "BLOCKED" : safety;
      const boundary = execution.boundary ? ` (stopped before step ${execution.stoppedAtStep ?? "?"}: ${execution.boundary})` : "";
      reason = `Executed ${flow.executable ? "to the end" : "to its safe boundary"}${boundary}; final outcome ${execution.status}:${execution.error?.message ? ` ${execution.error.message}` : ""}`.trim();
    }

    items.push({
      coverageId: `COV-FLOW-${padId(index + 1)}`,
      category: "FLOW",
      name: flow.title,
      status,
      reason,
      safety,
      executionStatus: execution?.status ?? null,
      pageId: flow.startPageId,
      url: flow.startUrl,
      relatedFlows: [flow.flowId],
      relatedScenarios: execution ? [execution.scenarioId] : [],
      relatedFindings: [],
      evidence: flow.evidence,
    });
  });

  let authSeq = 0;
  for (const flow of flowDiscovery.flows) {
    if (flow.category !== "AUTHENTICATION" && flow.category !== "SIGNUP") continue;
    const execution = byScenario.get(`SC-${flow.flowId}`);
    authSeq += 1;
    items.push({
      coverageId: `COV-AUTH-${padId(authSeq)}`,
      category: "AUTHENTICATION_BOUNDARY",
      name: flow.title,
      status: "BLOCKED",
      reason: execution
        ? `Authentication boundary observed: execution reached step ${execution.stoppedAtStep ?? "?"} then stopped before credentials. Login is never completed automatically.`
        : "Authentication boundary discovered. Credentials are never automated. Run with --execute to record the safe stop.",
      safety: "BLOCKED",
      executionStatus: execution?.status ?? null,
      pageId: flow.startPageId,
      url: flow.startUrl,
      relatedFlows: [flow.flowId],
      relatedScenarios: execution ? [execution.scenarioId] : [],
      relatedFindings: [],
      evidence: flow.evidence,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// INTERACTION coverage (grouped by control family).
// ---------------------------------------------------------------------------
function buildInteractionItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>): CoverageItem[] {
  const { report, flowDiscovery } = ctx;
  const { graph, flows, executions } = flowDiscovery;
  const elements = report.elements;
  const startPage = graph.pages[0];

  const linkFlows = new Set(flows.filter(f => f.category === "NAVIGATION" || f.category === "CONTENT_DISCOVERY").map(f => f.flowId));
  const searchFlows = new Set(flows.filter(f => f.category === "SEARCH").map(f => f.flowId));
  const languageFlows = new Set(flows.filter(f => f.category === "LANGUAGE_SWITCH").map(f => f.flowId));
  const mediaFlows = new Set(flows.filter(f => f.category === "MEDIA").map(f => f.flowId));
  const passOf = (ids: Set<string>, action: string): number =>
    executions.filter(e => e.status === "PASS" && ids.has(e.flowId) && e.steps.some(step => step.action === action && step.outcome === "PASS")).length;

  const navEdges = new Map<string, number>();
  for (const page of graph.pages) {
    for (const edge of page.edges) {
      if (edge.origin !== "same" || edge.broken) continue;
      navEdges.set(normalizeUrl(edge.href), (navEdges.get(normalizeUrl(edge.href)) ?? 0) + edge.count);
    }
  }
  const edgeTotal = navEdges.size;
  const linkPass = passOf(linkFlows, "open");

  const controlsByKind = (kind: "media" | "language"): number =>
    new Set(graph.pages.flatMap(page => page.controls.filter(control => control.kind === kind).map(control => control.elementIndex ?? control.locator))).size;

  const mediaCount = controlsByKind("media");
  const languageCount = controlsByKind("language");

  const linkCount = elements.filter(el => el.tag === "a" && Boolean(el.href)).length;
  const buttonCount = elements.filter(el => el.tag === "button" || el.role === "button" || el.type === "button" || el.type === "submit").length;
  const inputCount = elements.filter(el => el.tag === "input" || el.tag === "textarea").length;
  const checkboxCount = elements.filter(el => el.tag === "input" && el.type === "checkbox").length;
  const radioCount = elements.filter(el => el.tag === "input" && el.type === "radio").length;
  const selectCount = elements.filter(el => el.tag === "select").length;

  type GroupVerdict = { status: CoverageStatus; reason: string; executionStatus: CoverageExecutionStatus; safety: CoverageSafety };
  const group = (key: string, label: string, count: number, verdict: () => GroupVerdict): CoverageItem => {
    const { status, reason, executionStatus, safety } = verdict();
    return {
      coverageId: `COV-INTERACTION-${key.toUpperCase()}`,
      category: "INTERACTION",
      name: label,
      status,
      reason,
      safety,
      executionStatus,
      pageId: startPage?.id ?? null,
      url: startPage?.url ?? null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: [{ pageId: startPage?.id ?? null, elementIndex: null, detail: `${label}: ${count} element(s) on the scanned page.` }],
    };
  };

  const notApplicable = (label: string): GroupVerdict => ({
    status: "NOT_APPLICABLE",
    reason: `No ${label.toLowerCase()} on the scanned page.`,
    executionStatus: null,
    safety: "NOT_APPLICABLE",
  });

  const items: CoverageItem[] = [];
  items.push(
    group("LINKS", "Links", linkCount, () => {
      if (linkCount === 0) return notApplicable("links");
      if (report.summary.brokenLinks > 0)
        return { status: "REVIEW_REQUIRED", reason: `${report.summary.brokenLinks}/${report.summary.linksChecked} scanned destination(s) failed. Investigate each broken destination.`, executionStatus: null, safety: "REVIEW" };
      if (linkPass >= edgeTotal) return { status: "TESTED", reason: `All ${edgeTotal} site navigation edge(s) exercised by passing flows.`, executionStatus: "PASS", safety: "SAFE" };
      if (linkPass > 0) return { status: "PARTIALLY_TESTED", reason: `${linkPass} of ${edgeTotal} navigation edge(s) exercised; the rest are untested.`, executionStatus: "PASS", safety: "SAFE" };
      return { status: "NOT_TESTED", reason: `${linkCount} link(s) discovered but none exercised by a flow yet. Run with --execute.`, executionStatus: null, safety: "SAFE" };
    }),
    group("BUTTONS", "Buttons", buttonCount, () => {
      if (buttonCount === 0) return notApplicable("buttons");
      const exercised = passOf(searchFlows, "submit") + passOf(languageFlows, "click");
      if (exercised > 0) return { status: "PARTIALLY_TESTED", reason: `${buttonCount} button(s) present; ${exercised} exercised through search/language flows. Arbitrary button presses are never automated.`, executionStatus: "PASS", safety: "SAFE" };
      return { status: "NOT_TESTED", reason: `${buttonCount} button(s) present but none exercised. Search or language flows can safely exercise a subset.`, executionStatus: null, safety: "SAFE" };
    }),
    group("INPUTS", "Inputs", inputCount, () => {
      if (inputCount === 0) return notApplicable("inputs");
      const exercised = passOf(searchFlows, "type");
      if (exercised > 0) return { status: "PARTIALLY_TESTED", reason: `${inputCount} input(s) present; site search exercised one. Other inputs are structural observations only (never auto-filled).`, executionStatus: "PASS", safety: "SAFE" };
      return { status: "NOT_TESTED", reason: `${inputCount} input(s) present but none safely exercised.`, executionStatus: null, safety: "SAFE" };
    }),
    group("CHECKBOXES", "Checkboxes", checkboxCount, () =>
      checkboxCount === 0
        ? notApplicable("checkboxes")
        : { status: "PARTIALLY_TESTED", reason: `${checkboxCount} checkbox(es) present; checked states are never automated — manual review required.`, executionStatus: null, safety: "SAFE" }),
    group("RADIOS", "Radio buttons", radioCount, () =>
      radioCount === 0
        ? notApplicable("radio buttons")
        : { status: "PARTIALLY_TESTED", reason: `${radioCount} radio button(s) present; selection is never automated — manual review required.`, executionStatus: null, safety: "SAFE" }),
    group("SELECTS", "Selects", selectCount, () =>
      selectCount === 0
        ? notApplicable("selects")
        : { status: "PARTIALLY_TESTED", reason: `${selectCount} select(s) present; option selection is never automated — manual review required.`, executionStatus: null, safety: "SAFE" }),
    group("MEDIA", "Media controls", mediaCount, () => {
      if (mediaCount === 0) return notApplicable("media controls");
      const execution = [...mediaFlows].map(id => byScenario.get(`SC-${id}`)).find(Boolean);
      if (execution) return { status: "PARTIALLY_TESTED", reason: `${mediaCount} media control(s); playback/seek is never auto-started. Flow ${execution.flowId} outcome: ${execution.status}.`, executionStatus: execution.status, safety: "REVIEW" };
      return { status: "NOT_TESTED", reason: `${mediaCount} media control(s) discovered; media playback requires review. Run with --execute to record the boundary.`, executionStatus: null, safety: "REVIEW" };
    }),
    group("LANGUAGE", "Language controls", languageCount, () => {
      if (languageCount === 0) return notApplicable("language controls");
      const execution = [...languageFlows].map(id => byScenario.get(`SC-${id}`)).find(Boolean);
      if (execution?.status === "PASS") return { status: "TESTED", reason: `Language switch executed (${languageCount} control(s)).`, executionStatus: "PASS", safety: "SAFE" };
      if (execution) return { status: "PARTIALLY_TESTED", reason: `Language switch attempted but ended ${execution.status}.`, executionStatus: execution.status, safety: "SAFE" };
      return { status: "NOT_TESTED", reason: `${languageCount} language control(s) discovered; none executed yet. Run with --execute.`, executionStatus: null, safety: "SAFE" };
    }),
    group("NAVIGATION", "Navigation controls", edgeTotal, () => {
      if (edgeTotal === 0) return notApplicable("navigation controls");
      if (report.summary.brokenLinks > 0) return { status: "REVIEW_REQUIRED", reason: `${report.summary.brokenLinks} broken destination(s) block full navigation coverage.`, executionStatus: null, safety: "REVIEW" };
      if (linkPass >= edgeTotal) return { status: "TESTED", reason: `All ${edgeTotal} navigation edge(s) exercised by passing flows.`, executionStatus: "PASS", safety: "SAFE" };
      if (linkPass > 0) return { status: "PARTIALLY_TESTED", reason: `${linkPass} of ${edgeTotal} navigation edge(s) exercised.`, executionStatus: "PASS", safety: "SAFE" };
      return { status: "NOT_TESTED", reason: `${edgeTotal} navigation edge(s) discovered; none exercised yet. Run with --execute.`, executionStatus: null, safety: "SAFE" };
    }),
  );

  return items;
}

// ---------------------------------------------------------------------------
// FORM coverage.
// ---------------------------------------------------------------------------
function buildFormItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>): CoverageItem[] {
  const { report, flowDiscovery, findings } = ctx;
  const { graph, flows } = flowDiscovery;
  const startPage = graph.pages[0];
  const items: CoverageItem[] = [];
  let seq = 0;

  const searchFlow = flows.find(candidate => candidate.dedupeKey === `search:${startPage?.id}`) ?? null;
  const searchExecution = searchFlow ? byScenario.get(`SC-${searchFlow.flowId}`) : null;
  const searchExecuted = searchExecution?.status === "PASS";

  const labelFindingsFor = (indexes: number[]): QaFinding[] =>
    findings.filter(finding => START_PAGE_LABEL_CODES.has(finding.code) && finding.evidence.some(ref => ref.type === "element" && ref.index !== null && indexes.includes(ref.index)));

  const formGroups = new Map<number, number[]>();
  report.elements.forEach((element, index) => {
    if (element.formIndex !== null && element.formIndex !== undefined) {
      const group = formGroups.get(element.formIndex) ?? [];
      group.push(index);
      formGroups.set(element.formIndex, group);
    }
  });

  let index = 0;
  for (const [formIndex, indexes] of formGroups) {
    index += 1;
    seq += 1;
    const controls = indexes.map(i => report.elements[i]).filter((el): el is NonNullable<typeof el> => Boolean(el));
    const hasPassword = controls.some(el => el.type === "password");
    const destructive = controls.some(el => DESTRUCTIVE_TEXT.test(`${el.accessibleName ?? ""} ${el.text}`));
    const labelIssues = labelFindingsFor(indexes);
    const isSearchOnly = !controls.some(el => (el.tag === "input" || el.tag === "textarea") && el.type !== "search" && el.role !== "searchbox");

    let status: CoverageStatus;
    let reason: string;
    let safety: CoverageSafety;
    if (hasPassword) {
      status = "BLOCKED";
      safety = "BLOCKED";
      reason = "Authentication/password form — submission is BLOCKED for safety. Controls are never auto-filled and login is never completed.";
    } else if (destructive) {
      status = "BLOCKED";
      safety = "HIGH_RISK";
      reason = "Form contains destructive or payment-affecting controls — submission is never automated. Human review required.";
    } else if (labelIssues.length > 0) {
      status = "REVIEW_REQUIRED";
      safety = "REVIEW";
      reason = `${controls.length} control(s) in this form; ${labelIssues.length} label finding(s) (${labelIssues.map(f => f.code).join(", ")}) need review before this form can be exercised.`;
    } else if (isSearchOnly) {
      status = searchExecuted ? "TESTED" : "NOT_TESTED";
      safety = "SAFE";
      reason = searchExecuted
        ? "Search form exercised end-to-end by the passing search flow (benign term, no submitted data)."
        : "Search form controls are present but the search flow has not been executed yet.";
    } else {
      status = "NOT_TESTED";
      safety = "REVIEW";
      reason = `Non-search form with ${controls.length} control(s). Forms are never auto-submitted — fill/validation/submission require manual QA.`;
    }

    items.push({
      coverageId: `COV-FORM-${padId(seq)}`,
      category: "FORM",
      name: `Form ${index} — ${hasPassword ? "authentication" : destructive ? "destructive/payment" : isSearchOnly ? "search" : "standard"} (${controls.length} control(s))`,
      status,
      reason,
      safety,
      executionStatus: isSearchOnly ? (searchExecuted ? (searchExecution?.status ?? null) : null) : null,
      pageId: startPage?.id ?? null,
      url: startPage?.url ?? null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: labelIssues.map(f => f.id),
      evidence: indexes.map(i => ({ pageId: startPage?.id ?? null, elementIndex: i, detail: `form#${formIndex} element ${i}` })),
    });
  }

  for (const page of graph.pages) {
    if (page.id === startPage?.id) continue;
    const formControls = page.controls.filter(control => control.kind === "form");
    if (formControls.length === 0) continue;
    seq += 1;
    items.push({
      coverageId: `COV-FORM-${padId(seq)}`,
      category: "FORM",
      name: `Non-search form controls (${page.title ?? page.url})`,
      status: "NOT_TESTED",
      reason: `${formControls.length} non-search form control(s) on this page. Forms are never auto-submitted — manual QA required.`,
      safety: "REVIEW",
      executionStatus: null,
      pageId: page.id,
      url: page.url,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: formControls.flatMap(control => control.evidence),
    });
  }

  if (items.length === 0) {
    items.push({
      coverageId: "COV-FORM-000",
      category: "FORM",
      name: "Forms",
      status: "NOT_APPLICABLE",
      reason: "No forms were discovered on the scanned pages.",
      safety: "NOT_APPLICABLE",
      executionStatus: null,
      pageId: startPage?.id ?? null,
      url: startPage?.url ?? null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: pageEvidence(startPage),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// SEARCH / LANGUAGE / MEDIA coverage (per page with the controls).
// ---------------------------------------------------------------------------
function buildSearchLanguageMediaItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>): CoverageItem[] {
  const { report, flowDiscovery } = ctx;
  const { graph, flows } = flowDiscovery;
  const startPage = graph.pages[0];
  const items: CoverageItem[] = [];

  const searchPages = graph.pages.filter(page => page.controls.some(control => control.kind === "search"));
  const languagePages = graph.pages.filter(page => page.controls.some(control => control.kind === "language"));
  const mediaPages = graph.pages.filter(page => page.controls.some(control => control.kind === "media"));

  if (searchPages.length === 0) {
    items.push({
      coverageId: "COV-SEARCH-000",
      category: "SEARCH",
      name: "Site search",
      status: "NOT_APPLICABLE",
      reason: "No search control discovered on the scanned pages.",
      safety: "NOT_APPLICABLE",
      executionStatus: null,
      pageId: null,
      url: null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: graph.pages.flatMap(page => pageEvidence(page)),
    });
  }
  searchPages.forEach((page, index) => {
    const flow = flows.find(candidate => candidate.dedupeKey === `search:${page.id}`) ?? null;
    const execution = flow ? byScenario.get(`SC-${flow.flowId}`) : null;
    const control = page.controls.find(control => control.kind === "search");

    const typePassed = execution?.steps.some(step => step.action === "type" && step.outcome === "PASS") ?? false;
    const observes = (execution?.steps ?? []).filter(step => step.action === "observe");
    const lastObserve = observes.length > 0 ? observes[observes.length - 1]! : null;
    const emptyObserved = Boolean(lastObserve && lastObserve.outcome === "PASS" && EMPTY_STATE_RE.test(lastObserve.reason));

    const seq = index + 1;
    items.push(
      {
        coverageId: `COV-SEARCH-${padId(seq)}-CTRL`,
        category: "SEARCH",
        name: `Search control (${page.title ?? page.url})`,
        status: typePassed ? "TESTED" : execution ? "PARTIALLY_TESTED" : "NOT_TESTED",
        reason: typePassed
          ? "Search box was typed into with a synthetic benign term and the step passed."
          : execution
            ? `Search attempted but the typing step ended ${execution.status}.`
            : "Search control discovered but never exercised. Run with --execute.",
        safety: "SAFE",
        executionStatus: execution?.status ?? null,
        pageId: page.id,
        url: page.url,
        relatedFlows: flow ? [flow.flowId] : [],
        relatedScenarios: execution ? [execution.scenarioId] : [],
        relatedFindings: [],
        evidence: control?.evidence ?? pageEvidence(page),
      },
      {
        coverageId: `COV-SEARCH-${padId(seq)}-RESULTS`,
        category: "SEARCH",
        name: `Search results state (${page.title ?? page.url})`,
        status: execution?.status === "PASS" ? "TESTED" : execution ? "PARTIALLY_TESTED" : "NOT_TESTED",
        reason: execution?.status === "PASS"
          ? "Executed search returned a results state that was observed live."
          : execution
            ? `Results state not confirmed — search ended ${execution.status}.`
            : "Results behaviour untested. Run with --execute.",
        safety: "SAFE",
        executionStatus: execution?.status ?? null,
        pageId: page.id,
        url: page.url,
        relatedFlows: flow ? [flow.flowId] : [],
        relatedScenarios: execution ? [execution.scenarioId] : [],
        relatedFindings: [],
        evidence: flow?.evidence ?? pageEvidence(page),
      },
      {
        coverageId: `COV-SEARCH-${padId(seq)}-EMPTY`,
        category: "SEARCH",
        name: `Empty / no-result state (${page.title ?? page.url})`,
        status: emptyObserved ? "TESTED" : "NOT_TESTED",
        reason: emptyObserved
          ? "A no-result query outcome was observed live."
          : "Empty/no-result state needs a benign no-match term — the safe path exists but is not yet executed.",
        safety: "SAFE",
        executionStatus: execution?.status ?? null,
        pageId: page.id,
        url: page.url,
        relatedFlows: flow ? [flow.flowId] : [],
        relatedScenarios: execution ? [execution.scenarioId] : [],
        relatedFindings: [],
        evidence: flow?.evidence ?? pageEvidence(page),
      },
    );
  });

  if (languagePages.length === 0) {
    items.push({
      coverageId: "COV-LANG-000",
      category: "LANGUAGE",
      name: "Language switching",
      status: "NOT_APPLICABLE",
      reason: "No language-switch control discovered on the scanned pages.",
      safety: "NOT_APPLICABLE",
      executionStatus: null,
      pageId: null,
      url: null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: graph.pages.flatMap(page => pageEvidence(page)),
    });
  }
  languagePages.forEach((page, index) => {
    const flow = flows.find(candidate => candidate.dedupeKey.startsWith(`lang:`) && candidate.dedupeKey.split(":")[1] === page.id) ?? null;
    const execution = flow ? byScenario.get(`SC-${flow.flowId}`) : null;
    const controls = page.controls.filter(control => control.kind === "language");
    const languages = [...new Set(controls.map(control => control.text ?? control.accessibleName ?? null).filter((name): name is string => Boolean(name)))].join(", ");
    const docLang = page.id === startPage?.id ? report.page.language : null;

    const status: CoverageStatus = execution?.status === "PASS" ? "TESTED" : execution ? "PARTIALLY_TESTED" : "NOT_TESTED";
    items.push({
      coverageId: `COV-LANG-${padId(index + 1)}`,
      category: "LANGUAGE",
      name: `Language switching (${page.title ?? page.url})`,
      status,
      reason:
        execution?.status === "PASS"
          ? `Language switch executed on a live page${docLang ? `; document language is "${docLang}".` : " (document language not recorded for this page)."}`
          : execution
            ? `Language switch attempted but ended ${execution.status}.`
            : `${controls.length} language control(s)${languages ? ` (${languages})` : ""} discovered but not executed. Run with --execute.`,
      safety: "SAFE",
      executionStatus: execution?.status ?? null,
      pageId: page.id,
      url: page.url,
      relatedFlows: flow ? [flow.flowId] : [],
      relatedScenarios: execution ? [execution.scenarioId] : [],
      relatedFindings: [],
      evidence: controls.flatMap(control => control.evidence),
    });
  });

  if (mediaPages.length === 0) {
    items.push({
      coverageId: "COV-MEDIA-000",
      category: "MEDIA",
      name: "Media playback",
      status: "NOT_APPLICABLE",
      reason: "No media controls discovered on the scanned pages.",
      safety: "NOT_APPLICABLE",
      executionStatus: null,
      pageId: null,
      url: null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: graph.pages.flatMap(page => pageEvidence(page)),
    });
  }
  mediaPages.forEach((page, index) => {
    const flow = flows.find(candidate => candidate.dedupeKey === `media:${page.id}`) ?? null;
    const execution = flow ? byScenario.get(`SC-${flow.flowId}`) : null;
    const controls = page.controls.filter(control => control.kind === "media");
    items.push({
      coverageId: `COV-MEDIA-${padId(index + 1)}`,
      category: "MEDIA",
      name: `Media playback (${page.title ?? page.url})`,
      status: execution ? "PARTIALLY_TESTED" : "NOT_TESTED",
      reason: execution
        ? `${controls.length} media control(s); playback/seek is never auto-started. Flow ${execution.flowId} ended ${execution.status}.`
        : `${controls.length} media control(s); playback requires review. Run with --execute to record the boundary.`,
      safety: "REVIEW",
      executionStatus: execution?.status ?? null,
      pageId: page.id,
      url: page.url,
      relatedFlows: flow ? [flow.flowId] : [],
      relatedScenarios: execution ? [execution.scenarioId] : [],
      relatedFindings: [],
      evidence: controls.flatMap(control => control.evidence),
    });
  });

  return items;
}

// ---------------------------------------------------------------------------
// ERROR_HANDLING coverage.
// ---------------------------------------------------------------------------
function buildErrorItems(ctx: CoverageEngineInput, byScenario: Map<string, FlowExecutionResult>): CoverageItem[] {
  const { report, flowDiscovery } = ctx;
  const { graph, flows } = flowDiscovery;
  const startPage = graph.pages[0];
  const items: CoverageItem[] = [];
  let seq = 0;

  // 1. Link integrity (site-wide). Scanner link runs ARE live-browser execution.
  const linked = report.summary.linksChecked;
  const broken = report.summary.brokenLinks;
  seq += 1;
  items.push({
    coverageId: `COV-ERROR-${padId(seq)}`,
    category: "ERROR_HANDLING",
    name: linked > 0 ? "Link integrity (start page)" : "Link integrity",
    status: linked > 0 && broken === 0 ? "TESTED" : linked > 0 ? "PARTIALLY_TESTED" : "NOT_TESTED",
    reason: linked > 0 && broken === 0
      ? `${linked} scanned destination(s) resolved successfully in the live browser — no broken links.`
      : linked > 0
        ? `${broken} of ${linked} scanned destination(s) failed in the live browser — broken-destination coverage below per URL.`
        : "No link-integrity run recorded for this report.",
    safety: linked > 0 && broken === 0 ? "SAFE" : "REVIEW",
    executionStatus: linked > 0 && broken === 0 ? "PASS" : null,
    pageId: startPage?.id ?? null,
    url: startPage?.url ?? null,
    relatedFlows: [],
    relatedScenarios: [],
    relatedFindings: [],
    evidence: pageEvidence(startPage),
  });

  // 2. Per broken destination (error flows performed REAL navigation to it).
  const brokenHrefs = new Set<string>();
  for (const page of graph.pages) {
    for (const edge of page.edges) {
      if (edge.broken) brokenHrefs.add(edge.href);
    }
  }
  const reportBroken = new Set(report.links.filter(link => link.type === "BROKEN").map(link => link.url));
  for (const href of brokenHrefs) {
    seq += 1;
    const flow = flows.filter(candidate => candidate.dedupeKey === `error:${href}`).sort((a, b) => a.occurrenceCount - b.occurrenceCount)[0] ?? null;
    const execution = flow ? byScenario.get(`SC-${flow.flowId}`) : null;
    const knownBroken = reportBroken.has(href) || brokenHrefs.has(href);
    let status: CoverageStatus;
    let reason: string;
    if (execution?.status === "REPRODUCED") {
      status = "TESTED";
      reason = "Live navigation reproduced the failed destination (HTTP >=400) — defect recorded with execution evidence.";
    } else if (execution?.status === "PASS") {
      status = "TESTED";
      reason = "Live navigation reached the destination successfully — the earlier broken-destination signal did not reproduce.";
    } else if (execution) {
      status = "PARTIALLY_TESTED";
      reason = `Live navigation ended ${execution.status}; confirming this destination needs review.`;
    } else {
      status = knownBroken ? "REVIEW_REQUIRED" : "NOT_TESTED";
      reason = knownBroken ? "Scanner flagged this destination as broken; confirm the failure live before reclassifying." : "Destination flagged by graph; no error-navigation flow run.";
    }
    items.push({
      coverageId: `COV-ERROR-${padId(seq)}`,
      category: "ERROR_HANDLING",
      name: `Broken destination ${href}`,
      status,
      reason,
      safety: status === "TESTED" ? "SAFE" : "REVIEW",
      executionStatus: execution?.status ?? null,
      pageId: null,
      url: href,
      relatedFlows: flow ? [flow.flowId] : [],
      relatedScenarios: execution ? [execution.scenarioId] : [],
      relatedFindings: [],
      evidence: flow?.evidence ?? [{ pageId: null, elementIndex: null, detail: `broken destination ${href}` }],
    });
  }

  // 3. Uncaught page errors + first-party console errors.
  seq += 1;
  const pageErrors = report.summary.pageErrors ?? 0;
  const firstParty = report.consoleDiagnostics.filter(diagnostic => diagnostic.category === "first-party" && diagnostic.status === "WARNING").length;
  const consoleIssue = pageErrors > 0 || firstParty > 0;
  items.push({
    coverageId: `COV-ERROR-${padId(seq)}`,
    category: "ERROR_HANDLING",
    name: "Uncaught page / console errors",
    status: consoleIssue ? "REVIEW_REQUIRED" : "TESTED",
    reason: consoleIssue
      ? `${pageErrors} uncaught page error(s) and ${firstParty} first-party console error(s) observed during the scan — human investigation required.`
      : "No uncaught page errors or first-party console errors observed during the scan.",
    safety: consoleIssue ? "REVIEW" : "SAFE",
    executionStatus: null,
    pageId: startPage?.id ?? null,
    url: startPage?.url ?? null,
    relatedFlows: [],
    relatedScenarios: [],
    relatedFindings: [],
    evidence: pageEvidence(startPage),
  });

  // 4. Start page navigation status.
  seq += 1;
  const navStatus = report.scan.navigationStatus ?? null;
  items.push({
    coverageId: `COV-ERROR-${padId(seq)}`,
    category: "ERROR_HANDLING",
    name: "Start page navigation",
    status: navStatus !== null && navStatus >= 400 ? "REVIEW_REQUIRED" : "TESTED",
    reason: navStatus !== null && navStatus >= 400
      ? `Start page navigation returned HTTP ${navStatus} — the page may be blocked or missing.`
      : `Start page loaded with HTTP ${navStatus ?? "unknown"} — live scanner evidence.`,
    safety: navStatus !== null && navStatus >= 400 ? "REVIEW" : "SAFE",
    executionStatus: null,
    pageId: startPage?.id ?? null,
    url: startPage?.url ?? null,
    relatedFlows: [],
    relatedScenarios: [],
    relatedFindings: [],
    evidence: pageEvidence(startPage),
  });

  // 5. Per page-error finding traceability.
  for (const finding of ctx.findings) {
    if (finding.code !== "page-error") continue;
    seq += 1;
    const disposition = finding.verification?.disposition ?? null;
    items.push({
      coverageId: `COV-ERROR-${padId(seq)}`,
      category: "ERROR_HANDLING",
      name: finding.title,
      status: disposition ? DISPOSITION_STATUS[disposition] ?? "NOT_TESTED" : "REVIEW_REQUIRED",
      reason: disposition ? `Page-error verification disposition: ${disposition}.` : "Uncaught page error observed — human investigation required.",
      safety: disposition && disposition === "PASSED" ? "SAFE" : "REVIEW",
      executionStatus: finding.verification?.status ?? null,
      pageId: startPage?.id ?? null,
      url: report.scan.url,
      relatedFlows: [],
      relatedScenarios: finding.relatedScenarioIds,
      relatedFindings: [finding.id],
      evidence: finding.evidence.map(ref => ({ pageId: startPage?.id ?? null, elementIndex: null, detail: `${ref.type}${ref.index !== null ? ` (#${ref.index})` : ""}` })),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// ACCESSIBILITY_CHECK coverage (one item per accessibility-domain finding).
// ---------------------------------------------------------------------------
function buildAccessibilityItems(ctx: CoverageEngineInput): CoverageItem[] {
  const { report, findings } = ctx;
  const startPageId = ctx.flowDiscovery.graph.pages[0]?.id ?? null;

  return findings
    .filter(finding => finding.domain === "accessibility")
    .map((finding, index) => {
      const disposition = finding.verification?.disposition ?? null;
      const status: CoverageStatus = disposition ? DISPOSITION_STATUS[disposition] ?? "NOT_TESTED" : "NOT_TESTED";
      return {
        coverageId: `COV-ACC-${padId(index + 1)}`,
        category: "ACCESSIBILITY_CHECK" as const,
        name: finding.title,
        status,
        reason: disposition
          ? `Verification disposition: ${disposition}${finding.verification?.reason ? ` — ${finding.verification.reason}` : ""}`
          : "This accessibility signal is a scanner observation only; a safe verification check exists but has not run yet.",
        safety: status === "REVIEW_REQUIRED" ? "REVIEW" : "SAFE",
        executionStatus: finding.verification?.status ?? null,
        pageId: startPageId,
        url: report.scan.url,
        relatedFlows: [],
        relatedScenarios: finding.relatedScenarioIds,
        relatedFindings: [finding.id],
        evidence: finding.evidence.map(ref => ({
          pageId: ref.type === "element" || ref.type === "link" || ref.type === "page" ? startPageId : null,
          elementIndex: ref.type === "element" ? ref.index : null,
          detail: `${ref.type}${ref.locator ? `: ${ref.locator}` : ""}${ref.index !== null ? ` (#${ref.index})` : ""}`,
        })),
      } satisfies CoverageItem;
    });
}

// ---------------------------------------------------------------------------
// RESPONSIVE_CHECK coverage. A desktop-only scan NEVER claims responsive
// coverage: the item always asks for tablet/mobile execution.
// ---------------------------------------------------------------------------
function buildResponsiveItems(ctx: CoverageEngineInput): CoverageItem[] {
  const startPage = ctx.flowDiscovery.graph.pages[0];
  const viewport = ctx.report.page.viewport;
  return [
    {
      coverageId: "COV-RESPONSIVE-001",
      category: "RESPONSIVE_CHECK",
      name: "Responsive layout",
      status: "NOT_TESTED",
      reason:
        "Responsive coverage requires executing tablet and mobile viewports. This phase scans the desktop viewport only" +
        (viewport ? " — the declared viewport meta is meta-data, not responsive evidence." : " and no viewport meta was declared."),
      safety: "SAFE",
      executionStatus: null,
      pageId: startPage?.id ?? null,
      url: startPage?.url ?? null,
      relatedFlows: [],
      relatedScenarios: [],
      relatedFindings: [],
      evidence: pageEvidence(startPage),
    },
  ];
}

// ---------------------------------------------------------------------------
// Summary + deterministic gap headlines.
// ---------------------------------------------------------------------------
function buildSummaryData(ctx: CoverageEngineInput, items: CoverageItem[], testPlanLength: number): CoverageSummary {
  const summary = emptyCoverageSummary();

  const pages = items.filter(item => item.category === "PAGE");
  summary.pages.discovered = pages.length;
  summary.pages.tested = statusCount(pages, "PAGE", "TESTED");
  summary.pages.partial = statusCount(pages, "PAGE", "PARTIALLY_TESTED");
  summary.pages.untested = statusCount(pages, "PAGE", "NOT_TESTED");
  summary.pages.blocked = statusCount(pages, "PAGE", "BLOCKED");
  summary.pages.review = statusCount(pages, "PAGE", "REVIEW_REQUIRED");

  summary.flows.discovered = ctx.flowDiscovery.flows.length;
  summary.flows.executed = ctx.flowDiscovery.executions.length;
  summary.flows.passed = ctx.flowDiscovery.executions.filter(e => e.status === "PASS").length;
  summary.flows.reproduced = ctx.flowDiscovery.executions.filter(e => e.status === "REPRODUCED").length;
  summary.flows.notReproduced = ctx.flowDiscovery.executions.filter(e => e.status === "NOT_REPRODUCED").length;
  summary.flows.review = ctx.flowDiscovery.executions.filter(e => e.status === "REVIEW_REQUIRED").length;
  summary.flows.blocked = ctx.flowDiscovery.executions.filter(e => e.status === "BLOCKED").length;

  const interactions = items.filter(item => item.category === "INTERACTION");
  summary.interactions.tested = statusCount(interactions, "INTERACTION", "TESTED");
  summary.interactions.partial = statusCount(interactions, "INTERACTION", "PARTIALLY_TESTED");
  summary.interactions.untested = statusCount(interactions, "INTERACTION", "NOT_TESTED");
  summary.interactions.review = statusCount(interactions, "INTERACTION", "REVIEW_REQUIRED");
  summary.interactions.notApplicable = statusCount(interactions, "INTERACTION", "NOT_APPLICABLE");

  const dispositions = ctx.findings.map(finding => finding.verification?.disposition ?? null);
  summary.findings.analyzed = ctx.findings.length;
  summary.findings.verified = dispositions.filter(d => d !== null && TERMINAL_DISPOSITIONS.has(d)).length;
  summary.findings.reproduced = dispositions.filter(d => d === "REPRODUCED").length;
  summary.findings.notReproduced = dispositions.filter(d => d === "NOT_REPRODUCED").length;
  summary.findings.unverified = summary.findings.analyzed - summary.findings.verified;

  summary.recommendations = testPlanLength;
  return summary;
}

export function gapHeadlines(items: CoverageItem[]): string[] {
  const lines: string[] = [];

  if (items.some(item => item.category === "AUTHENTICATION_BOUNDARY" && item.status === "BLOCKED"))
    lines.push("Authentication boundary requires human review — login is never completed automatically.");

  const broken = items.filter(item => item.category === "ERROR_HANDLING" && item.status === "REVIEW_REQUIRED" && item.name.startsWith("Broken destination"));
  if (broken.length) lines.push(`${broken.length} broken or unconfirmed destination(s) must be investigated.`);

  const flowsNotExecuted = items.filter(item => item.category === "FLOW" && item.status === "NOT_TESTED");
  if (flowsNotExecuted.length) lines.push(`${flowsNotExecuted.length} flow(s) are not yet executed — run with --execute for real coverage.`);

  const flowReview = items.filter(item => item.category === "FLOW" && item.status === "REVIEW_REQUIRED");
  if (flowReview.length) lines.push(`${flowReview.length} flow(s) need human review before they can execute.`);

  if (items.some(item => item.category === "RESPONSIVE_CHECK" && item.status === "NOT_TESTED"))
    lines.push("Responsive behaviour is NOT_TESTED — current scan is desktop-viewport only.");

  const accNotVerified = items.filter(item => item.category === "ACCESSIBILITY_CHECK" && item.status === "NOT_TESTED");
  if (accNotVerified.length) lines.push(`${accNotVerified.length} accessibility check(s) are not yet verified by a live probe.`);

  const searchUntested = items.filter(item => item.category === "SEARCH" && item.status === "NOT_TESTED");
  if (searchUntested.length) lines.push(`${searchUntested.length} search coverage item(s) are untested (control, results, or empty-state).`);

  const errorReview = items.filter(item => item.category === "ERROR_HANDLING" && item.status === "REVIEW_REQUIRED" && item.name !== "Start page navigation" && !item.name.startsWith("Broken destination"));
  if (errorReview.length) lines.push(`${errorReview.length} error-handling item(s) require a human decision.`);

  return [...new Set(lines)].slice(0, 8);
}

export function coverageDigest(ctx: { url: string; title: string }, items: CoverageItem[], testPlan: CoverageMap["testPlan"]): CoverageDigest {
  const statuses: CoverageStatus[] = ["TESTED", "PARTIALLY_TESTED", "NOT_TESTED", "BLOCKED", "REVIEW_REQUIRED", "NOT_APPLICABLE"];
  const statusTotals = Object.fromEntries(statuses.map(status => [status, statusCount(items, null, status)])) as Record<CoverageStatus, number>;
  return {
    url: ctx.url,
    title: ctx.title,
    pagesTotal: statusCount(items, "PAGE", "TESTED") + statusCount(items, "PAGE", "PARTIALLY_TESTED") + statusCount(items, "PAGE", "NOT_TESTED") + statusCount(items, "PAGE", "BLOCKED") + statusCount(items, "PAGE", "REVIEW_REQUIRED"),
    statusTotals,
    gaps: gapHeadlines(items),
    recommendations: testPlan.map(rec => ({ recommendationId: rec.recommendationId, type: rec.type, title: rec.title, priority: rec.priority })),
  };
}

// ---------------------------------------------------------------------------
// Bounded AI notes application. Gaps are always deterministic; AI may reword
// them and reprioritize existing recommendations only.
// ---------------------------------------------------------------------------
export function applyCoverageNotes(coverage: CoverageMap, enhancement: CoverageEnhancement | null, providerName: string | null): CoverageMap {
  if (!enhancement || !providerName) {
    return { ...coverage, aiNotes: { gaps: gapHeadlines(coverage.items), prioritization: [], provider: null } };
  }

  const existing = new Map(coverage.testPlan.map(rec => [rec.recommendationId, rec]));
  const validPriorities = new Set<FlowPriority>(["P0", "P1", "P2", "P3", "P4"]);
  const prioritization = (enhancement.prioritization ?? [])
    .filter(item => existing.has(item.recommendationId) && validPriorities.has(item.priority))
    .slice(0, 40)
    .map(item => ({
      recommendationId: item.recommendationId,
      priority: item.priority,
      reason: (item.reason ?? "").slice(0, 280) || existing.get(item.recommendationId)!.priorityReason,
    }));

  for (const entry of prioritization) {
    const rec = coverage.testPlan.find(candidate => candidate.recommendationId === entry.recommendationId);
    if (rec) rec.priority = entry.priority;
  }

  return {
    ...coverage,
    aiNotes: {
      gaps: [...new Set((enhancement.gaps ?? []).map(line => line.slice(0, 300)).filter(Boolean))].slice(0, 8),
      prioritization,
      provider: providerName,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
export function buildCoverage(ctx: CoverageEngineInput): CoverageMap {
  const byScenario = new Map(ctx.flowDiscovery.executions.map(execution => [execution.scenarioId, execution]));
  const executableFlowIds = new Set(ctx.flowDiscovery.flows.filter(flow => flow.executable).map(flow => flow.flowId));

  const items: CoverageItem[] = [
    ...buildPageItems(ctx, byScenario, executableFlowIds),
    ...buildLinkItems(ctx, byScenario, "NAVIGATION", "nav"),
    ...buildLinkItems(ctx, byScenario, "CONTENT_DISCOVERY", "content"),
    ...buildFlowItems(ctx, byScenario),
    ...buildInteractionItems(ctx, byScenario),
    ...buildFormItems(ctx, byScenario),
    ...buildSearchLanguageMediaItems(ctx, byScenario),
    ...buildErrorItems(ctx, byScenario),
    ...buildAccessibilityItems(ctx),
    ...buildResponsiveItems(ctx),
  ];

  const testPlan = buildTestPlan(items, ctx.flowDiscovery.flows, ctx.findings);
  const summary = buildSummaryData(ctx, items, testPlan.length);

  return {
    generatedAt: new Date().toISOString(),
    items,
    summary,
    testPlan,
    aiNotes: { gaps: gapHeadlines(items), prioritization: [], provider: null },
  };
}