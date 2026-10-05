import { classifyStep, isExecutableStep, isWorseAutomation, isWorseSafety, priorityForFlow, flowBoundaryReason, StepControl } from "./classify.js";
import { findPage } from "./graph.js";
import {
  DiscoveredFlow,
  FlowBoundary,
  FlowCategory,
  FlowEvidenceRef,
  FlowLimits,
  FlowPriority,
  FlowSafety,
  FlowStep,
  FlowStepAction,
  FlowAutomation,
  SiteGraph,
} from "./types.js";

// ---------------------------------------------------------------------------
// Flow discovery.
//
// Candidates are derived from the site graph (observed facts) and deduplicated
// by a stable key so repeated occurrences collapse into one flow while their
// occurrence counts are preserved. Steps are then classified deterministically;
// only SAFE + AUTOMATED steps ever execute.
// ---------------------------------------------------------------------------

/** Synthetic search term: benign, obviously not user data. */
export const SAFE_SEARCH_TERM = "quality";

type RawStep = {
  action: FlowStepAction;
  targetUrl?: string;
  locator?: string | null;
  elementIndex?: number | null;
  text?: string | null;
  expected: string;
  evidence: FlowEvidenceRef[];
  control?: StepControl | null;
};

type Candidate = {
  category: FlowCategory;
  dedupeKey: string;
  title: string;
  description: string;
  startPageId: string;
  occurrenceCount: number;
  rawSteps: RawStep[];
  evidence: FlowEvidenceRef[];
};

const PRIORITY_RANK: Record<FlowPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

function observe(expected: string, evidence: FlowEvidenceRef[], locator?: string | null): RawStep {
  return { action: "observe", locator: locator ?? null, expected, evidence };
}

function buildStep(raw: RawStep): FlowStep {
  if (!raw.control) {
    return {
      action: raw.action,
      targetUrl: raw.targetUrl,
      locator: raw.locator ?? null,
      elementIndex: raw.elementIndex ?? null,
      text: raw.text ?? null,
      expected: raw.expected,
      safety: "SAFE",
      automation: "AUTOMATED",
      reason: "passive document read or benign navigation",
      evidence: raw.evidence,
    };
  }
  const classification = classifyStep(raw.control);
  return {
    action: raw.action,
    targetUrl: raw.targetUrl,
    locator: raw.locator ?? null,
    elementIndex: raw.elementIndex ?? null,
    text: raw.text ?? null,
    expected: raw.expected,
    safety: classification.safety,
    automation: classification.automation,
    reason: classification.reason,
    evidence: raw.evidence,
  };
}

function finalizeFlows(candidates: Candidate[], graph: SiteGraph, limits: FlowLimits): DiscoveredFlow[] {
  const flows: DiscoveredFlow[] = [];

  for (const candidate of candidates) {
    const rawSteps = candidate.rawSteps;
    if (rawSteps.length === 0) continue;
    const steps = rawSteps.slice(0, limits.maxFlowSteps).map(buildStep);

    let safety: FlowSafety = "SAFE";
    let automation: FlowAutomation = "AUTOMATED";
    let boundary: FlowBoundary | null = null;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (isWorseSafety(step.safety, safety)) safety = step.safety;
      if (isWorseAutomation(step.automation, automation)) automation = step.automation;
      if (!boundary && !isExecutableStep(step)) {
        boundary = { stepIndex: index, safety: step.safety, automation: step.automation, reason: flowBoundaryReason(step) };
      }
    }

    const { priority, reason } = priorityForFlow(candidate.category);
    const startPage = graph.pages.find(page => page.id === candidate.startPageId);
    const startUrl = startPage?.url ?? graph.sourceUrl;

    flows.push({
      flowId: "FLOW-PLACEHOLDER",
      category: candidate.category,
      title: candidate.title,
      description: candidate.description,
      startPageId: candidate.startPageId,
      startUrl,
      steps,
      safety,
      automation,
      boundary,
      executable: steps.some(isExecutableStep),
      priority,
      priorityReason: reason,
      confidence: candidate.occurrenceCount >= 2 ? ("high" as const) : candidate.rawSteps.length >= 2 ? ("medium" as const) : ("low" as const),
      occurrenceCount: candidate.occurrenceCount,
      dedupeKey: candidate.dedupeKey,
      evidence: candidate.evidence,
    });
  }

  flows.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.occurrenceCount - a.occurrenceCount);
  const selected = flows.slice(0, limits.maxFlows);

  return selected.map((flow, index) => ({ ...flow, flowId: `FLOW-${String(index + 1).padStart(3, "0")}` }));
}

// ---------------------------------------------------------------------------
// Category candidates.
// ---------------------------------------------------------------------------

const CONTENT_LABEL = /(learn more|read more|see more|read it|view details|view all|full story|browse|explore|more about|review|guide|details)/i;

function navigationCandidates(graph: SiteGraph): Candidate[] {
  const byDestination = new Map<string, { edges: typeof graph.pages[0]["edges"]; count: number; evidence: FlowEvidenceRef[] }>();
  for (const page of graph.pages) {
    for (const edge of page.edges) {
      if (edge.origin !== "same") continue;
      if (edge.broken) continue;
      const key = edge.href;
      const group = byDestination.get(key);
      if (group) {
        group.count += edge.count;
        group.evidence.push(...edge.evidence);
      } else {
        byDestination.set(key, { edges: [edge], count: edge.count, evidence: [...edge.evidence] });
      }
    }
  }
  const candidates: Candidate[] = [];
  for (const [href, group] of byDestination) {
    const edge = group.edges[0];
    if (!edge) continue;
    const label = edge.label ?? "linked page";
    candidates.push({
      category: "NAVIGATION",
      dedupeKey: `nav:${href}`,
      title: `Navigate to ${label}`,
      description: `Follow the site's own link to "${label}" and confirm the destination page loads.`,
      startPageId: edge.fromPageId,
      occurrenceCount: group.count,
      rawSteps: [
        { action: "click-link", locator: edge.locator, control: toEdgeControl(edge), expected: "The site's own navigation link opens successfully.", evidence: [edge.evidence[0] ?? { pageId: edge.fromPageId, elementIndex: null, detail: "same-origin navigation link" }] },
        observe("The destination page loads with content (a non-empty title).", []),
      ],
      evidence: group.evidence,
    });
  }
  return candidates;
}

function contentCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    for (const edge of page.edges) {
      if (edge.origin !== "same" || edge.broken) continue;
      const label = edge.label ?? "";
      if (!CONTENT_LABEL.test(label)) continue;
      candidates.push({
        category: "CONTENT_DISCOVERY",
        dedupeKey: `content:${edge.href}`,
        title: `Open content detail: ${label.slice(0, 60)}`,
        description: `Follow a content/read-more link ("${label}") and confirm the detail page renders.`,
        startPageId: edge.fromPageId,
        occurrenceCount: edge.count,
        rawSteps: [
          { action: "click-link", locator: edge.locator, control: toEdgeControl(edge), expected: "The content link opens its detail page.", evidence: [edge.evidence[0] ?? { pageId: page.id, elementIndex: null, detail: "content link" }] },
          observe("The detail page loads with content (a non-empty title).", []),
        ],
        evidence: edge.evidence,
      });
    }
  }
  return candidates;
}

function searchCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    const searchboxes = page.controls.filter(controlNode => controlNode.kind === "search" && controlNode.tag === "input");
    const submits = page.controls.filter(controlNode => controlNode.kind === "search" && controlNode.tag !== "input");
    if (searchboxes.length === 0) continue;
    const box = searchboxes[0]!;
    const submit = submits.find(c => c.safe ?? false) ?? submits[0];
    const pageEvidence: FlowEvidenceRef[] = [{ pageId: page.id, elementIndex: box.elementIndex ?? null, detail: "site search box" }];
    candidates.push({
      category: "SEARCH",
      dedupeKey: `search:${page.id}`,
      title: "Site search with a benign term",
      description: "Type a synthetic term into the site's own search box and submit — never user data or credentials.",
      startPageId: page.id,
      occurrenceCount: box.count,
      rawSteps: [
        observe("The site search box is present.", [{ pageId: page.id, elementIndex: box.elementIndex ?? null, detail: "search box presence" }], box.locator),
        { action: "type", locator: box.locator, text: SAFE_SEARCH_TERM, expected: "The search box accepts the synthetic term.", evidence: pageEvidence },
        submit
          ? { action: "submit", locator: submit.locator, expected: "The site search submits without error.", evidence: [{ pageId: page.id, elementIndex: submit.elementIndex ?? null, detail: "search submit" }] }
          : { action: "submit", locator: null, expected: "The site search submits without error.", evidence: pageEvidence },
        observe("The search results render or the site reports no matches.", [], null),
      ],
      evidence: pageEvidence,
    });
  }
  return candidates;
}

function languageCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    const controls = page.controls.filter(controlNode => controlNode.kind === "language");
    const seen = new Set<string>();
    for (const controlNode of controls) {
      const key = controlNode.href ?? controlNode.text ?? controlNode.accessibleName ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      const label = controlNode.accessibleName ?? controlNode.text ?? "the alternate language";
      candidates.push({
        category: "LANGUAGE_SWITCH",
        dedupeKey: `lang:${page.id}:${key}`,
        title: `Switch language to ${label.slice(0, 40)}`,
        description: `Activate the site's own language control ("${label}") and confirm the page language changes.`,
        startPageId: page.id,
        occurrenceCount: controlNode.count,
        rawSteps: [
          { action: "click", locator: controlNode.locator, expected: "The language control activates.", evidence: [{ pageId: page.id, elementIndex: controlNode.elementIndex ?? null, detail: "language control" }], control: toStepControl(controlNode) },
          observe("The page switches to the selected language.", []),
        ],
        evidence: [{ pageId: page.id, elementIndex: controlNode.elementIndex ?? null, detail: "language control" }],
      });
    }
  }
  return candidates;
}

function mediaCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    const controls = page.controls.filter(controlNode => controlNode.kind === "media");
    if (controls.length === 0) continue;
    const controlNode = controls[0]!;
    candidates.push({
      category: "MEDIA",
      dedupeKey: `media:${page.id}`,
      title: "Media presence on the page",
      description: "Confirm the page contains media controls; playback itself is never auto-started.",
      startPageId: page.id,
      occurrenceCount: controls.length,
      rawSteps: [
        { action: "observe", locator: controlNode.locator, expected: "The media control is present.", evidence: [], control: toStepControl(controlNode) },
        observe("The media element exists on the page.", []),
      ],
      evidence: [{ pageId: page.id, elementIndex: controlNode.elementIndex ?? null, detail: "media control" }],
    });
  }
  return candidates;
}

function authCandidates(graph: SiteGraph): Candidate[] {
  const pagesWithAuth = graph.pages.filter(page => page.controls.some(controlNode => controlNode.kind === "auth"));
  if (pagesWithAuth.length === 0) return [];
  const page = pagesWithAuth[0]!;
  const authControls = page.controls.filter(controlNode => controlNode.kind === "auth");
  const loginLink = authControls.find(controlNode => controlNode.tag === "a");
  const identifier = authControls.find(controlNode => controlNode.tag === "input" && controlNode.type !== "password" && controlNode.type !== "submit");
  const password = authControls.find(controlNode => controlNode.tag === "input" && controlNode.type === "password");
  const steps: RawStep[] = [
    observe("The site exposes a login/authentication affordance.", [{ pageId: page.id, elementIndex: null, detail: "auth affordance present" }]),
  ];
  if (loginLink?.safe) {
    steps.push({ action: "click-link", locator: loginLink.locator, expected: "The login page opens without submitting credentials.", evidence: [{ pageId: page.id, elementIndex: loginLink.elementIndex ?? null, detail: "login link" }] });
  }
  if (identifier) {
    steps.push(observe("The identifier (non-credential) field is present on the login form.", [{ pageId: page.id, elementIndex: identifier.elementIndex ?? null, detail: "identifier field" }], identifier.locator));
  }
  steps.push({
    action: "type",
    locator: null,
    expected: "Never: identifier entry is not automated.",
    evidence: [],
    control: { tag: "input", role: "textbox", accessibleName: null, text: null, href: null, type: "text", inAuthForm: true, isSearch: false, visible: true, safeLocator: false, isExternal: false },
  });
  steps.push({
    action: "submit",
    locator: null,
    expected: "Never: credentials are BLOCKED from automated submission.",
    evidence: [{ pageId: page.id, elementIndex: password?.elementIndex ?? null, detail: "credential submission" }],
    control: { tag: "button", role: "button", accessibleName: null, text: null, href: null, type: "submit", inAuthForm: true, isSearch: false, visible: true, safeLocator: false, isExternal: false },
  });
  return [{
    category: "AUTHENTICATION",
    dedupeKey: "auth",
    title: "Authentication boundary",
    description: "Observe the login path (open page → identify the field) and STOP at the credential boundary — login is never completed.",
    startPageId: page.id,
    occurrenceCount: authControls.length,
    rawSteps: steps,
    evidence: [{ pageId: page.id, elementIndex: null, detail: "login formula observed safely; credentials never submitted" }],
  }];
}

function signupCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    const signup = page.controls.find(controlNode => controlNode.kind === "signup");
    if (!signup) continue;
    const steps: RawStep[] = [
      observe("The site exposes a signup/registration affordance.", [{ pageId: page.id, elementIndex: signup.elementIndex ?? null, detail: "signup affordance present" }]),
    ];
    if (signup.tag === "a" && signup.safe) {
      steps.push({ action: "click-link", locator: signup.locator, expected: "The registration page opens.", evidence: [{ pageId: page.id, elementIndex: signup.elementIndex ?? null, detail: "signup link" }] });
    }
    steps.push(
      observe("The registration form fields are present.", [], null),
      { action: "type", locator: null, expected: "Never: registration data is not automated.", evidence: [], control: { tag: "input", role: "textbox", accessibleName: null, text: null, href: null, type: "text", inAuthForm: false, isSearch: false, visible: true, safeLocator: false, isExternal: false } },
      { action: "submit", locator: null, expected: "Never: completing registration is BLOCKED.", evidence: [], control: { tag: "button", role: "button", accessibleName: null, text: null, href: null, type: "submit", inAuthForm: true, isSearch: false, visible: true, safeLocator: false, isExternal: false } },
    );
    candidates.push({
      category: "SIGNUP",
      dedupeKey: "signup",
      title: "Sign-up boundary",
      description: "Observe the registration path and STOP before entering or submitting any data.",
      startPageId: page.id,
      occurrenceCount: 1,
      rawSteps: steps,
      evidence: [{ pageId: page.id, elementIndex: signup.elementIndex ?? null, detail: "signup flow observed safely; never completed" }],
    });
  }
  return candidates;
}

function formCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    const formControls = page.controls.filter(controlNode => controlNode.kind === "form");
    for (const controlNode of formControls.slice(0, 3)) {
      candidates.push({
        category: "FORM_INTERACTION",
        dedupeKey: `form:${page.id}:${controlNode.elementIndex ?? controlNode.tag}`,
        title: "Non-search form (observe only)",
        description: `A non-search form is present ("${controlNode.accessibleName ?? controlNode.text ?? "form control"}"). Its fields are never filled and it is never submitted automatically.`,
        startPageId: page.id,
        occurrenceCount: 1,
        rawSteps: [
          observe("The form control is present.", [{ pageId: page.id, elementIndex: controlNode.elementIndex ?? null, detail: "form control" }], controlNode.locator),
          { action: "type", locator: null, expected: "Never: form fields are not auto-filled.", evidence: [], control: { tag: "input", role: "textbox", accessibleName: null, text: null, href: null, type: "text", inAuthForm: false, isSearch: false, visible: true, safeLocator: false, isExternal: false } },
          { action: "submit", locator: null, expected: "Never: arbitrary form submission is HIGH_RISK.", evidence: [], control: { tag: "button", role: "button", accessibleName: null, text: null, href: null, type: "submit", inAuthForm: false, isSearch: false, visible: true, safeLocator: false, isExternal: false } },
        ],
        evidence: [{ pageId: page.id, elementIndex: controlNode.elementIndex ?? null, detail: "non-search form" }],
      });
    }
  }
  return candidates;
}

function profileCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  for (const page of graph.pages) {
    const profile = page.controls.find(controlNode => controlNode.kind === "profile");
    if (!profile) continue;
    const steps: RawStep[] = [observe("The profile/account affordance is present.", [{ pageId: page.id, elementIndex: profile.elementIndex ?? null, detail: "profile affordance" }])];
    if (profile.tag === "a" && profile.safe) {
      steps.push({ action: "click-link", locator: profile.locator, expected: "The profile page opens (or an auth redirect is observed).", evidence: [{ pageId: page.id, elementIndex: profile.elementIndex ?? null, detail: "profile link" }] });
    }
    steps.push(observe("Profile content renders, or the session redirect is noted for review.", [], null));
    candidates.push({
      category: "PROFILE",
      dedupeKey: "profile",
      title: "Profile page (review)",
      description: "Profile pages may require a session; observed but reviewed manually.",
      startPageId: page.id,
      occurrenceCount: 1,
      rawSteps: steps,
      evidence: [{ pageId: page.id, elementIndex: profile.elementIndex ?? null, detail: "profile flow" }],
    });
  }
  return candidates;
}

function errorCandidates(graph: SiteGraph): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const page of graph.pages) {
    for (const edge of page.edges) {
      if (!edge.broken) continue;
      if (seen.has(edge.href)) continue;
      seen.add(edge.href);
      candidates.push({
        category: "ERROR_HANDLING",
        dedupeKey: `error:${edge.href}`,
        title: `Broken destination: ${(edge.label ?? edge.href).slice(0, 60)}`,
        description: "Open the destination the site links to and record its HTTP status — reproduced errors are genuine site defects.",
        startPageId: edge.fromPageId,
        occurrenceCount: edge.count,
        rawSteps: [
          { action: "open", targetUrl: edge.href, expected: "Navigation status is recorded for the site's broken destination (Reproduced this time means the destination is genuinely failing).", evidence: [edge.evidence[0] ?? { pageId: page.id, elementIndex: null, detail: "broken destination" }] },
          observe("The HTTP error status is observed.", []),
        ],
        evidence: edge.evidence,
      });
    }
  }
  return candidates;
}

function toStepControl(controlNode: NonNullable<SiteGraph["pages"][number]["controls"][0]>): StepControl {
  return {
    tag: controlNode.tag,
    role: controlNode.role,
    accessibleName: controlNode.accessibleName,
    text: controlNode.text,
    href: controlNode.href,
    type: controlNode.type,
    inAuthForm: false,
    isSearch: controlNode.kind === "search",
    visible: true,
    safeLocator: controlNode.safe,
    isExternal: false,
  };
}

/** Anchor step control derived from a site-graph edge so classification can
 *  downgrade fragile or cross-origin links at discovery time. */
function toEdgeControl(edge: NonNullable<SiteGraph["pages"][number]["edges"][0]>): StepControl {
  return {
    tag: "a",
    role: "link",
    accessibleName: edge.label,
    text: edge.label,
    href: edge.href,
    type: null,
    inAuthForm: false,
    isSearch: false,
    visible: true,
    safeLocator: edge.safe && Boolean(edge.locator),
    isExternal: edge.origin === "external",
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export function discoverFlows(graph: SiteGraph, limits: FlowLimits): DiscoveredFlow[] {
  const candidates: Candidate[] = [
    ...errorCandidates(graph),
    ...authCandidates(graph),
    ...searchCandidates(graph),
    ...languageCandidates(graph),
    ...navigationCandidates(graph),
    ...contentCandidates(graph),
    ...signupCandidates(graph),
    ...formCandidates(graph),
    ...mediaCandidates(graph),
    ...profileCandidates(graph),
  ];
  return finalizeFlows(candidates, graph, limits);
}