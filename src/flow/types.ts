import type { Confidence } from "../ai/types.js";

// ---------------------------------------------------------------------------
// Phase 3: autonomous user-flow discovery + safe execution.
//
// The pipeline is SCAN FACT -> SITE GRAPH -> FLOW DISCOVERY -> FLOW SPEC ->
// SAFE EXECUTION -> VERDICT. Every flow is website-agnostic: nothing below is
// derived from a hardcoded URL, selector, route name, or site name. Steps are
// classified deterministically and only SAFE + AUTOMATED steps ever execute.
// ---------------------------------------------------------------------------

export type FlowCategory =
  | "NAVIGATION"
  | "SEARCH"
  | "CONTENT_DISCOVERY"
  | "LANGUAGE_SWITCH"
  | "AUTHENTICATION"
  | "SIGNUP"
  | "FORM_INTERACTION"
  | "MEDIA"
  | "PROFILE"
  | "ERROR_HANDLING";

export type FlowPriority = "P0" | "P1" | "P2" | "P3" | "P4";

/** A step is executed only when safety === "SAFE" AND automation === "AUTOMATED".
 *  Anything REVIEW / HIGH_RISK / BLOCKED is a boundary: discovery records it,
 *  the executor stops before it, and the report flags it for human review. */
export type FlowSafety = "SAFE" | "REVIEW" | "HIGH_RISK" | "BLOCKED";
export type FlowAutomation = "AUTOMATED" | "REVIEW" | "MANUAL";

export type FlowStepAction =
  | "open"        // navigate to a URL
  | "click-link"  // click an anchor
  | "click"       // click a generic control
  | "type"        // type text into a field
  | "submit"      // submit the site search / a benign form
  | "observe"     // read something on the page (title, element presence)
  | "wait";       // wait for an element to exist

export type FlowEvidenceRef = {
  /** Page node id from the site graph, when the evidence lives on a page. */
  pageId: string | null;
  /** Element index into that page's scan report, when known. */
  elementIndex: number | null;
  detail: string;
};

export type FlowStep = {
  action: FlowStepAction;
  /** For `open` steps: the destination URL. */
  targetUrl?: string;
  /** Playwright locator expression emitted by the safe locator builder. */
  locator?: string | null;
  elementIndex?: number | null;
  /** For `type` steps: the text to enter (a synthetic, benign value). */
  text?: string | null;
  expected: string;
  safety: FlowSafety;
  automation: FlowAutomation;
  reason: string;
  evidence: FlowEvidenceRef[];
};

export type FlowBoundary = {
  stepIndex: number;
  safety: FlowSafety;
  automation: FlowAutomation;
  reason: string;
};

export type DiscoveredFlow = {
  flowId: string;
  category: FlowCategory;
  title: string;
  description: string;
  startPageId: string;
  /** URL the executor opens before the first step (the flow's start page). */
  startUrl: string;
  steps: FlowStep[];
  /** Most restrictive safety across steps (SAFE < REVIEW < HIGH_RISK < BLOCKED). */
  safety: FlowSafety;
  /** Most restrictive automation across steps. */
  automation: FlowAutomation;
  /** First step the executor must stop before, if any. */
  boundary: FlowBoundary | null;
  /** true when at least one step is SAFE + AUTOMATED and therefore executable. */
  executable: boolean;
  priority: FlowPriority;
  priorityReason: string;
  confidence: Confidence;
  occurrenceCount: number;
  dedupeKey: string;
  evidence: FlowEvidenceRef[];
};

// ---------------------------------------------------------------------------
// Site graph. Discovered from scan reports; never hand-authored.
// ---------------------------------------------------------------------------

export type NodeControlKind =
  | "search"
  | "language"
  | "media"
  | "auth"
  | "signup"
  | "profile"
  | "form";

export type NodeControl = {
  kind: NodeControlKind;
  locator: string | null;
  text: string | null;
  accessibleName: string | null;
  role: string | null;
  tag: string;
  href: string | null;
  type: string | null;
  elementIndex: number | null;
  /** Locator came from the safe builder and is unambiguous. */
  safe: boolean;
  count: number;
  evidence: FlowEvidenceRef[];
};

export type NodeEdge = {
  fromPageId: string;
  /** Set when the destination was discovered as its own page node. */
  toPageId: string | null;
  origin: "same" | "external";
  href: string;
  label: string | null;
  locator: string | null;
  safe: boolean;
  count: number;
  broken: boolean;
  evidence: FlowEvidenceRef[];
};

export type SitePageNode = {
  id: string;
  url: string;
  title: string | null;
  depth: number;
  sourceReportUrl: string;
  navigationStatus: number | null;
  brokenLinks: number;
  controls: NodeControl[];
  edges: NodeEdge[];
};

export type SiteGraph = {
  sourceUrl: string;
  pages: SitePageNode[];
};

export type FlowLimits = {
  /** Maximum site pages discovered (crawl node budget). */
  maxPages: number;
  /** Maximum link depth from the start page during a crawl. */
  maxDepth: number;
  /** Global budget of link-following actions during crawl discovery. */
  maxNavigationActions: number;
  /** Maximum discovered flows reported. */
  maxFlows: number;
  /** Maximum steps kept per flow. */
  maxFlowSteps: number;
  /** Optional per-flow execution timeout budget. */
  maxExecutionMs?: number;
};

// ---------------------------------------------------------------------------
// Flow execution + verdicts.
// ---------------------------------------------------------------------------

export type FlowStepOutcome =
  | "PASS"
  | "REPRODUCED"
  | "NOT_REPRODUCED"
  | "REVIEW_REQUIRED"
  | "BLOCKED"
  | "INFRASTRUCTURE_PROBLEM";

export type FlowFailureCategory =
  | "WEBSITE"        // live behavior matches the suspected problem
  | "LOCATOR"        // expected element could not be located
  | "INFRASTRUCTURE" // runner/network/timeout — not a site verdict
  | "AUTH"           // session/auth gating prevented the step
  | "CONDITIONAL"    // state-dependent UI
  | "SAFETY_BLOCK"   // execution stopped before an unsafe step
  | "REVIEW";        // cannot decide automatically

export type FlowStepExecutionResult = {
  flowId: string;
  scenarioId: string;
  stepIndex: number;
  action: FlowStepAction;
  outcome: FlowStepOutcome;
  category: FlowFailureCategory;
  reason: string;
  locator: string | null;
  url: string | null;
  durationMs: number;
  error: { type: string; message: string } | null;
};

export type FlowExecutionResult = {
  scenarioId: string;
  flowId: string;
  category: FlowCategory;
  title: string;
  executedAt: string | null;
  durationMs: number | null;
  status: FlowStepOutcome;
  failureCategory: FlowFailureCategory | null;
  startedUrl: string;
  finalUrl: string | null;
  /** Index of the first step execution stopped before (safety boundary). */
  stoppedAtStep: number | null;
  boundary: string | null;
  steps: FlowStepExecutionResult[];
  error: { type: string; message: string } | null;
};

export type FlowSummary = {
  pages: number;
  flows: number;
  executable: number;
  review: number;
  highRisk: number;
  blocked: number;
  steps: number;
  executed: number;
  passed: number;
  reproduced: number;
  notReproduced: number;
  reviewRequired: number;
  /** Executions stopped at a safety boundary (status BLOCKED). */
  boundaryBlocked?: number;
  infrastructure: number;
};

export type FlowDiscovery = {
  limits: FlowLimits;
  graph: SiteGraph;
  flows: DiscoveredFlow[];
  executions: FlowExecutionResult[];
  summary: FlowSummary;
};

/** Bound of what an AI provider may refine on discovered flows. Evidence,
 *  steps, safety, automation, and categories are never AI-authored. */
export type FlowAnalysisEnhancement = {
  flowId: string;
  title?: string;
  description?: string;
  priority?: FlowPriority;
};

/** Compact flow view sent to an AI provider for bounded refinement. */
export type FlowDigest = {
  flowId: string;
  category: FlowCategory;
  title: string;
  safety: FlowSafety;
  automation: FlowAutomation;
  priority: FlowPriority;
  startUrl: string;
};