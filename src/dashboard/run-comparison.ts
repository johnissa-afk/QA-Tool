// ---------------------------------------------------------------------------
// Run-to-run change intelligence.
//
// WHAT THIS IS
// A deterministic, evidence-based description of what differs between two real
// QA run artifacts. It answers "what changed between these two runs?" and
// nothing else: there is no score, no ranking, no health number, and no verdict
// about whether the website got better or worse.
//
// WHAT THIS IS NOT
// It is NOT a second finding identity system and NOT a second regression engine.
//   * Finding changes are READ from the project finding lifecycle
//     (project-findings.ts) — the existing ledger and its recorded snapshot.
//     Identity here is `projectFindingIdOf`; nothing is recomputed.
//   * Flow identity is the Phase 5 `flowSignature` / `flowFamilyKey`.
//   * Element identity is the Phase 5 `elementSemanticKey`.
//   * Page identity is `normalizePageUrl` (Phase 5), with a strict parse first.
//   * Run comparability is the Phase 5 `comparableRunPair` via
//     `compareRunAnalyses`, plus the recorded access/evidence state.
//
// DETERMINISM
// Pure functions of two report artifacts. Every list is deduplicated and sorted,
// so array order in the input can never change the output. No clock, no
// randomness, no AI provider: whether a technical object changed is decided by
// set membership and recorded evidence only.
//
// UNCERTAINTY IS EXPLICIT
// Absence is never a fix. When the previous run could not inspect the site
// (authentication, bot protection, blocked) or the current run could not, the
// affected dimensions are reported as unavailable or partial with a machine
// readable reason — they are never turned into a clean "resolved" story.
// ---------------------------------------------------------------------------
import type { QaAnalysis } from "../ai/types.js";
import type { DiscoveredElement } from "../types.js";
import type { DiscoveredFlow, FlowStepOutcome } from "../flow/types.js";
import { elementSemanticKey, normalizePageUrl, normalizeText } from "../regression/identity.js";
import type { RegressionCompareOptions } from "../regression/types.js";
import { flowFamilyKey, flowSignature, recommendationSignature } from "../regression/identity.js";
import { assessRunEvidence, compareRunAnalyses, type FindingCounts, type ProjectFindingStatus, type ProjectRunFindingsSnapshot } from "./project-findings.js";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Machine-readable reason a comparison cannot be presented. */
export type ComparisonUnavailableReason =
  | "NO_PREVIOUS_RUN"
  | "PREVIOUS_RUN_INCOMPLETE"
  | "CURRENT_RUN_INCOMPLETE"
  | "ACCESS_BOUNDARY"
  | "INSUFFICIENT_EVIDENCE";

/**
 * AVAILABLE   both runs exercised the site and the same target/config
 * PARTIAL     the access state itself changed, so only that transition is claimed
 * UNAVAILABLE no honest comparison exists; the reason says why
 */
export type ComparisonAvailability = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";

export type ComparisonAvailabilityBlock = {
  availability: ComparisonAvailability;
  comparisonAvailable: boolean;
  reason: ComparisonUnavailableReason | null;
  reasonDetail: string | null;
};

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

/** A count that is null when the run did not measure it at all. */
export type Measured = number | null;

export type MeasurementPair = {
  current: Measured;
  previous: Measured;
  delta: Measured;
  /** False when either run did not record this dimension. */
  available: boolean;
};

const measurement = (current: Measured, previous: Measured): MeasurementPair => ({
  current,
  previous,
  delta: current !== null && previous !== null ? current - previous : null,
  available: current !== null && previous !== null,
});

/** Deduplicated, sorted string list: the ordering of a run's own array can
 *  never change the output. */
const sortedUnique = (values: (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Descriptive access label, built from the existing access model. */
export type AccessStateLabel =
  | "ACCESSIBLE"
  | "AUTHENTICATION_REQUIRED"
  | "LOGIN_REQUIRED"
  | "ACCESS_BLOCKED"
  | "BOT_PROTECTION"
  | "UNKNOWN";

/**
 * The descriptive access state of a run, from the existing access model.
 *
 * The recorded `type` is the most precise signal and wins when present. Reports
 * that record only a status are read from that: a PASS status means the run
 * reached the site, and a REVIEW_REQUIRED status means the run needed a human
 * decision without saying why. A report that records neither is not treated as
 * a mysterious third state: reachability is then read from the positive evidence
 * in the same report. With no such evidence either, the state stays UNKNOWN
 * rather than being guessed.
 */
export function accessStateOf(analysis: QaAnalysis): AccessStateLabel {
  const access = analysis.accessPrerequisite ?? analysis.scan?.accessPrerequisite ?? null;
  if (access) {
    switch (access.type) {
      case "accessible": return "ACCESSIBLE";
      case "authentication-required": return "AUTHENTICATION_REQUIRED";
      case "login-required": return "LOGIN_REQUIRED";
      case "access-blocked": return "ACCESS_BLOCKED";
      case "bot-protection": return "BOT_PROTECTION";
      case "unknown": break;
      default: break;
    }
    switch (access.status) {
      case "PASS": return "ACCESSIBLE";
      case "BLOCKED": return "ACCESS_BLOCKED";
      default: return "UNKNOWN";
    }
  }
  const reached =
    typeof analysis.scan?.scan?.finalUrl === "string" &&
    (analysis.coverage?.summary?.pages?.discovered ?? 0) + (analysis.flowDiscovery?.executions?.length ?? 0) > 0;
  return reached ? "ACCESSIBLE" : "UNKNOWN";
}

const accessLabel = accessStateOf;

export type AccessChange = {
  previous: AccessStateLabel;
  current: AccessStateLabel;
  changed: boolean;
  /** e.g. "AUTHENTICATION_REQUIRED -> ACCESSIBLE". Descriptive, never a verdict. */
  transition: string | null;
  previousStatus: string | null;
  currentStatus: string | null;
  /** Plain-language note explaining why this is a state change, not a defect. */
  note: string;
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Strict page identity. A URL that cannot be parsed as http(s) is excluded
 *  from change claims rather than guessed at. */
export function pageIdentity(url: string | null | undefined, options?: RegressionCompareOptions): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return normalizePageUrl(url, options?.ignoreQueryKeys ?? []);
}

export type PageChangeItem = {
  /** Normalized page identity. */
  id: string;
  url: string;
  title: string | null;
  depth: number | null;
};

export type PageChanges = {
  added: PageChangeItem[];
  removed: PageChangeItem[];
  unchanged: PageChangeItem[];
  /** Pages present in the previous run that the current run could not confirm. */
  notComparable: PageChangeItem[];
  available: boolean;
  reason: ComparisonUnavailableReason | null;
  note: string | null;
};

/** The pages a run actually discovered, from its own site graph. */
export function pagesOf(analysis: QaAnalysis, options?: RegressionCompareOptions): PageChangeItem[] {
  const nodes = analysis.flowDiscovery?.graph?.pages ?? [];
  const byId = new Map<string, PageChangeItem>();
  for (const node of nodes) {
    const id = pageIdentity(node.url, options);
    if (!id) continue;
    if (byId.has(id)) continue;
    byId.set(id, { id, url: node.url, title: node.title ?? null, depth: typeof node.depth === "number" ? node.depth : null });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export type ElementChange = {
  /** Semantic element identity from the existing scanner fingerprint. */
  id: string;
  page: string;
  tag: string;
  role: string | null;
  interactive: boolean;
  accessibleName: string | null;
  text: string;
};

export type ElementChanges = {
  added: ElementChange[];
  removed: ElementChange[];
  /**
   * Elements that cannot be paired 1:1 between the runs (the same semantic key
   * appears more than once in either run). Claiming "added"/"removed" here would
   * be a guess, so they are reported as unmatched instead.
   */
  unmatched: ElementChange[];
  interactiveAdded: number;
  interactiveRemoved: number;
  interactiveUnmatched: number;
  available: boolean;
  reason: ComparisonUnavailableReason | null;
  note: string | null;
};

/** The scanned element inventory of a run, grouped by semantic fingerprint. */
function elementInventory(analysis: QaAnalysis): Map<string, ElementChange[]> {
  const page = pageIdentity(analysis.scan?.scan?.url) ?? "unknown-page";
  const byId = new Map<string, ElementChange[]>();
  for (const element of analysis.scan?.elements ?? []) {
    // The existing semantic fingerprint: tag/role/type/href/name/text. A
    // regenerated DOM id or a moved array index is deliberately NOT identity.
    const id = `${page}|${elementSemanticKey(element)}`;
    const list = byId.get(id) ?? [];
    list.push({
      id,
      page,
      tag: element.tag,
      role: element.role ?? null,
      interactive: element.interactive === true,
      accessibleName: element.accessibleName ?? null,
      // The text as a reader saw it. Normalization belongs to identity only.
      text: (element.text ?? "").trim().slice(0, 80),
    });
    byId.set(id, list);
  }
  return byId;
}

const elementChangesOf = (
  current: QaAnalysis,
  previous: QaAnalysis,
  available: boolean,
  reason: ComparisonUnavailableReason | null,
): ElementChanges => {
  const empty: ElementChanges = {
    added: [], removed: [], unmatched: [], interactiveAdded: 0, interactiveRemoved: 0, interactiveUnmatched: 0,
    available, reason,
    note: available ? null : "element inventories are not compared for this pair of runs",
  };
  if (!available) return empty;

  const now = elementInventory(current);
  const before = elementInventory(previous);
  const ids = sortedUnique([...now.keys(), ...before.keys()]);

  const added: ElementChange[] = [];
  const removed: ElementChange[] = [];
  const unmatched: ElementChange[] = [];

  for (const id of ids) {
    const nowItems = now.get(id) ?? [];
    const beforeItems = before.get(id) ?? [];
    // A fingerprint only one run has is genuinely new or genuinely gone.
    if (!beforeItems.length) { added.push(...nowItems); continue; }
    if (!nowItems.length) { removed.push(...beforeItems); continue; }
    // Present on both sides. Equal counts pair up cleanly, so nothing is
    // claimed. When the counts differ the extra copies cannot be attributed to
    // a specific element, so they are reported as unmatched rather than as an
    // addition and a removal that may never have happened.
    if (nowItems.length === beforeItems.length) continue;
    const surplus = Math.abs(nowItems.length - beforeItems.length);
    const source = nowItems.length > beforeItems.length ? nowItems : beforeItems;
    for (let index = 0; index < surplus; index += 1) unmatched.push(source[index]!);
  }

  return {
    added: added.sort(byElementId),
    removed: removed.sort(byElementId),
    unmatched: unmatched.sort(byElementId),
    interactiveAdded: added.filter(item => item.interactive).length,
    interactiveRemoved: removed.filter(item => item.interactive).length,
    interactiveUnmatched: unmatched.filter(item => item.interactive).length,
    available: true,
    reason: null,
    note: unmatched.length
      ? `${unmatched.length} element(s) share a semantic fingerprint with another element, so they cannot be paired one-to-one and are reported as unmatched rather than added or removed`
      : null,
  };
};

const byElementId = (a: ElementChange, b: ElementChange): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * The deterministic status of a discovered flow, from recorded evidence only:
 * the execution outcome when the flow was executed, otherwise its recorded plan
 * state. Values are descriptive states, never judgements.
 */
export type FlowChangeStatus = FlowStepOutcome | "EXECUTABLE" | "NOT_EXECUTED";

export function flowStatusOf(analysis: QaAnalysis, flow: DiscoveredFlow): FlowChangeStatus {
  const execution = (analysis.flowDiscovery?.executions ?? []).find(item => item.flowId === flow.flowId);
  if (execution) return execution.status;
  if (flow.safety === "BLOCKED") return "BLOCKED";
  if (flow.executable) return "EXECUTABLE";
  if (flow.automation === "AUTOMATED") return "EXECUTABLE";
  return "REVIEW_REQUIRED";
}

/**
 * A run's flows grouped by their Phase 5 signature.
 *
 * Grouping is not cosmetic. A real crawl can contain many flows that share one
 * signature — the same category, start page and step sequence. Pairing those
 * flows one-to-one would be arbitrary, and an arbitrary pairing produces
 * transitions that never happened. So comparison happens between groups, and a
 * group's status is the sorted set of its flows' recorded statuses. Equal sets
 * mean nothing changed; unequal sets are reported with counts.
 */
type FlowGroup = {
  id: string;
  familyKey: string;
  title: string | null;
  category: string | null;
  startPage: string;
  /** How many flows in this run share this signature. */
  count: number;
  /** Sorted recorded statuses of those flows. */
  statuses: FlowChangeStatus[];
  /** True when every flow in the group has a recorded execution. */
  allExecuted: boolean;
};

const flowGroupsOf = (analysis: QaAnalysis, options?: RegressionCompareOptions): Map<string, FlowGroup> => {
  const groups = new Map<string, FlowGroup>();
  for (const flow of analysis.flowDiscovery?.flows ?? []) {
    const id = flowSignature(flow, options);
    const existing = groups.get(id);
    const status = flowStatusOf(analysis, flow);
    if (!existing) {
      groups.set(id, {
        id,
        familyKey: flowFamilyKey(flow, options),
        // With many flows sharing a signature, the first title in sorted flow-id
        // order is a stable label — never a claim about which flow it is.
        title: flow.title || null,
        category: flow.category || null,
        startPage: normalizePageUrl(flow.startUrl, options?.ignoreQueryKeys ?? []),
        count: 1,
        statuses: [status],
        allExecuted: hasExecution(analysis, flow.flowId),
      });
      continue;
    }
    existing.count += 1;
    existing.statuses.push(status);
    existing.allExecuted = existing.allExecuted && hasExecution(analysis, flow.flowId);
  }
  for (const group of groups.values()) group.statuses.sort();
  return groups;
};

export type FlowChangeItem = {
  /** Phase 5 full flow signature. */
  id: string;
  /** Phase 5 loose flow family identity. */
  familyKey: string;
  title: string | null;
  category: string | null;
  startPage: string;
  /** How many flows in this run share this signature. */
  count: number;
};

export type FlowStatusChange = {
  id: string;
  familyKey: string;
  title: string | null;
  category: string | null;
  startPage: string;
  from: FlowChangeStatus;
  to: FlowChangeStatus;
  /** How many flows in the group made this transition. */
  count: number;
  /** Descriptive transition label, e.g. "EXECUTABLE -> BLOCKED". */
  transition: string;
  /** STATUS_CHANGE: same signature, different recorded status.
   *  STEPS_CHANGED: same family, a different step sequence. */
  reason: "STATUS_CHANGE" | "STEPS_CHANGED";
  /** True only when BOTH sides are recorded execution outcomes. */
  evidenceBacked: boolean;
  note: string;
};

export type FlowChanges = {
  added: FlowChangeItem[];
  removed: FlowChangeItem[];
  unchanged: FlowChangeItem[];
  statusChanged: FlowStatusChange[];
  /** Groups whose step sequence changed but whose family matched. */
  stepsChanged: number;
  available: boolean;
  reason: ComparisonUnavailableReason | null;
  note: string | null;
};

const sameStatusSet = (a: FlowChangeStatus[], b: FlowChangeStatus[]): boolean =>
  a.length === b.length && a.every((status, index) => status === b[index]);

const flowChangesOf = (
  current: QaAnalysis,
  previous: QaAnalysis,
  available: boolean,
  reason: ComparisonUnavailableReason | null,
  options?: RegressionCompareOptions,
): FlowChanges => {
  const empty: FlowChanges = {
    added: [], removed: [], unchanged: [], statusChanged: [], stepsChanged: 0,
    available, reason,
    note: available ? null : "discovered flows are not compared for this pair of runs",
  };
  if (!available) return empty;

  const now = flowGroupsOf(current, options);
  const before = flowGroupsOf(previous, options);

  const added: FlowChangeItem[] = [];
  const removed: FlowChangeItem[] = [];
  const unchanged: FlowChangeItem[] = [];
  const statusChanged: FlowStatusChange[] = [];
  let stepsChanged = 0;

  const itemOf = (group: FlowGroup): FlowChangeItem => ({
    id: group.id,
    familyKey: group.familyKey,
    title: group.title,
    category: group.category,
    startPage: group.startPage,
    count: group.count,
  });

  // Families present in both runs, used only to recognise a changed step
  // sequence. A family is only usable when it maps to exactly one group on each
  // side; with several candidate groups, pairing would be a guess.
  const familiesOf = (groups: Map<string, FlowGroup>): Map<string, string[]> => {
    const byFamily = new Map<string, string[]>();
    for (const group of groups.values()) {
      const list = byFamily.get(group.familyKey) ?? [];
      list.push(group.id);
      byFamily.set(group.familyKey, list);
    }
    return byFamily;
  };
  const beforeFamilies = familiesOf(before);

  const matchedNow = new Set<string>();
  const matchedBefore = new Set<string>();

  // 1. Exact signature match: the flow itself is the same flow.
  for (const [id, group] of now) {
    const counterpart = before.get(id);
    if (!counterpart) continue;
    matchedNow.add(id);
    matchedBefore.add(id);
    if (sameStatusSet(group.statuses, counterpart.statuses)) {
      unchanged.push(itemOf(group));
      continue;
    }
    statusChanged.push(...transitionsOf(group, counterpart, "STATUS_CHANGE"));
  }

  // 2. A signature on one side only: the same flow family with changed steps.
  for (const [id, group] of now) {
    if (matchedNow.has(id)) continue;
    const candidates = (beforeFamilies.get(group.familyKey) ?? []).filter(other => !matchedBefore.has(other));
    if (candidates.length !== 1) continue;
    const counterpart = before.get(candidates[0]);
    if (!counterpart) continue;
    matchedNow.add(id);
    matchedBefore.add(counterpart.id);
    stepsChanged += 1;
    statusChanged.push(...transitionsOf(group, counterpart, "STEPS_CHANGED"));
  }

  // 3. Whatever is left genuinely appeared or disappeared.
  for (const [id, group] of now) if (!matchedNow.has(id)) added.push(itemOf(group));
  for (const [id, group] of before) if (!matchedBefore.has(id)) removed.push(itemOf(group));

  const byId = (a: FlowChangeItem, b: FlowChangeItem): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byTransition = (a: FlowStatusChange, b: FlowStatusChange): number => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.transition !== b.transition) return a.transition < b.transition ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  };
  return {
    added: added.sort(byId),
    removed: removed.sort(byId),
    unchanged: unchanged.sort(byId),
    statusChanged: statusChanged.sort(byTransition),
    stepsChanged,
    available: true,
    reason: null,
    note: null,
  };
};

/**
 * The transitions between two groups' sorted status lists.
 *
 * The lists are paired positionally, which is a pure function of the two reports
 * because both are sorted. Identical transitions are then collapsed into one
 * counted entry, so sixteen flows that all stopped the same way are one line
 * saying sixteen, not sixteen lines saying one each.
 */
const transitionsOf = (
  group: FlowGroup,
  counterpart: FlowGroup,
  why: "STATUS_CHANGE" | "STEPS_CHANGED",
): FlowStatusChange[] => {
  const counts = new Map<string, { from: FlowChangeStatus | null; to: FlowChangeStatus | null; count: number }>();
  const width = Math.max(group.statuses.length, counterpart.statuses.length);
  for (let index = 0; index < width; index += 1) {
    const from = counterpart.statuses[index] ?? null;
    const to = group.statuses[index] ?? null;
    if (from === to) continue;
    const key = `${from ?? "ABSENT"} -> ${to ?? "ABSENT"}`;
    const entry = counts.get(key) ?? { from, to, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => `${a.from}->${a.to}` < `${b.from}->${b.to}` ? -1 : 1)
    .map(entry => statusChange(group, entry.from, entry.to, counterpart, why, entry.count));
};

const statusChange = (
  group: FlowGroup,
  from: FlowChangeStatus | null,
  to: FlowChangeStatus | null,
  counterpart: FlowGroup,
  why: "STATUS_CHANGE" | "STEPS_CHANGED",
  count: number,
): FlowStatusChange => {
  const fromLabel = from ?? "ABSENT";
  const toLabel = to ?? "ABSENT";
  const evidenceBacked = group.allExecuted && counterpart.allExecuted && from !== null && to !== null;
  return {
    id: group.id,
    familyKey: group.familyKey,
    title: group.title,
    category: group.category,
    startPage: group.startPage,
    from: from ?? "NOT_EXECUTED",
    to: to ?? "NOT_EXECUTED",
    count,
    transition: `${fromLabel} -> ${toLabel}`,
    reason: why,
    evidenceBacked,
    note:
      why === "STEPS_CHANGED"
        ? "The flow's step sequence changed; the same flow family was found in both runs."
        : evidenceBacked
          ? "Both sides are recorded execution outcomes."
          : "At least one side is a recorded plan state rather than an execution outcome.",
  };
};

const hasExecution = (analysis: QaAnalysis, flowId: string): boolean =>
  (analysis.flowDiscovery?.executions ?? []).some(item => item.flowId === flowId);

// ---------------------------------------------------------------------------
// Verification + coverage
// ---------------------------------------------------------------------------

export type VerificationCounts = {
  /** Findings this run scheduled for verification. */
  scheduled: Measured;
  executed: Measured;
  reproduced: Measured;
  notReproduced: Measured;
  /** Verification that was deliberately not run. Never counted as a pass. */
  skipped: Measured;
  reviewRequired: Measured;
  unverified: Measured;
  /** Infrastructure failures. These are infrastructure, never website defects. */
  infrastructureProblems: Measured;
  infrastructureFailures: Measured;
};

export const VERIFICATION_MEASURES = [
  "scheduled", "executed", "reproduced", "notReproduced", "skipped",
  "reviewRequired", "unverified", "infrastructureProblems", "infrastructureFailures",
] as const;

export type VerificationMeasure = (typeof VERIFICATION_MEASURES)[number];

export type MeasurementBlock<T extends string> = {
  current: Record<T, Measured>;
  previous: Record<T, Measured>;
  delta: Record<T, Measured>;
  available: boolean;
  note: string | null;
};

export type VerificationChanges = MeasurementBlock<VerificationMeasure>;
export type CoverageChanges = MeasurementBlock<CoverageMeasure>;

export const COVERAGE_MEASURES = [
  "pagesTested", "pagesPartial", "pagesUntested", "pagesBlocked",
  "flowsExecuted", "interactionsTested", "interactionsPartial", "interactionsUntested",
] as const;

export type CoverageMeasure = (typeof COVERAGE_MEASURES)[number];

const measurementBlock = <T extends string>(
  measures: readonly T[],
  current: Record<T, Measured>,
  previous: Record<T, Measured>,
  available: boolean,
  note: string | null,
): MeasurementBlock<T> => {
  const currentOut = {} as Record<T, Measured>;
  const previousOut = {} as Record<T, Measured>;
  const deltaOut = {} as Record<T, Measured>;
  for (const measure of measures) {
    currentOut[measure] = current[measure];
    previousOut[measure] = previous[measure];
    deltaOut[measure] = current[measure] !== null && previous[measure] !== null ? current[measure]! - previous[measure]! : null;
  }
  return { current: currentOut, previous: previousOut, delta: deltaOut, available, note };
};

export function verificationCountsOf(analysis: QaAnalysis): VerificationCounts {
  const summary = analysis.summary ?? null;
  const executions = analysis.flowDiscovery?.executions ?? [];
  const summaryPresent = summary != null;
  // Skips are recorded across three distinct guards. Summing the recorded
  // counters is the only honest total; a skip is never folded into a pass.
  const skipped = summary
    ? (summary.skippedUnsupported ?? 0) + (summary.skippedLocatorGuard ?? 0) + (summary.skippedSafety ?? 0)
    : analysis.execution != null
      ? (analysis.execution.skipped ?? null)
      : null;
  return {
    // A report with no summary section never measured anything.
    scheduled: summaryPresent ? (summary.scheduled ?? null) : null,
    executed: summaryPresent ? (summary.executed ?? null) : null,
    reproduced: summaryPresent ? (summary.reproduced ?? null) : null,
    notReproduced: summaryPresent ? (summary.notReproduced ?? null) : null,
    skipped,
    reviewRequired: summaryPresent ? (summary.reviewRequired ?? null) : null,
    unverified: summaryPresent ? (summary.unverified ?? null) : null,
    // Finding-level infrastructure problems, from the summary.
    infrastructureProblems: summaryPresent ? (summary.infrastructureProblems ?? null) : null,
    // Flow-level infrastructure failures, from the recorded executions. These
    // are runner/network/timeout events, never website defects.
    infrastructureFailures: executions.length
      ? executions.filter(item => item.failureCategory === "INFRASTRUCTURE").length
      : null,
  };
}

export function coverageCountsOf(analysis: QaAnalysis): Record<CoverageMeasure, Measured> {
  const summary = analysis.coverage?.summary ?? null;
  if (!summary) return nullCoverageCounts();
  return {
    pagesTested: summary.pages?.tested ?? null,
    pagesPartial: summary.pages?.partial ?? null,
    pagesUntested: summary.pages?.untested ?? null,
    pagesBlocked: summary.pages?.blocked ?? null,
    flowsExecuted: summary.flows?.executed ?? null,
    interactionsTested: summary.interactions?.tested ?? null,
    interactionsPartial: summary.interactions?.partial ?? null,
    interactionsUntested: summary.interactions?.untested ?? null,
  };
}

/** A run that recorded nothing: every measure is unmeasured, not zero. */
const nullCoverageCounts = (): Record<CoverageMeasure, Measured> => ({
  pagesTested: null, pagesPartial: null, pagesUntested: null, pagesBlocked: null,
  flowsExecuted: null, interactionsTested: null, interactionsPartial: null, interactionsUntested: null,
});

const nullVerificationCounts = (): VerificationCounts => ({
  scheduled: null, executed: null, reproduced: null, notReproduced: null, skipped: null,
  reviewRequired: null, unverified: null, infrastructureProblems: null, infrastructureFailures: null,
});

// ---------------------------------------------------------------------------
// Recommendations (deterministic comparison only)
// ---------------------------------------------------------------------------

export type RecommendationChanges = {
  added: { id: string; name: string; type: string }[];
  removed: { id: string; name: string; type: string }[];
  unchanged: number;
  available: boolean;
  note: string | null;
};

const recommendationChangesOf = (current: QaAnalysis, previous: QaAnalysis, available: boolean): RecommendationChanges => {
  if (!available) {
    return { added: [], removed: [], unchanged: 0, available: false, note: "test-plan recommendations are not compared for this pair of runs" };
  }
  const planOf = (analysis: QaAnalysis) => {
    const byId = new Map<string, { id: string; name: string; type: string }>();
    for (const rec of analysis.coverage?.testPlan ?? []) {
      const id = recommendationSignature(rec);
      if (byId.has(id)) continue;
      byId.set(id, { id, name: rec.title, type: rec.type });
    }
    return byId;
  };
  const now = planOf(current);
  const before = planOf(previous);
  const added = [...now.values()].filter(item => !before.has(item.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const removed = [...before.values()].filter(item => !now.has(item.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const unchanged = [...now.keys()].filter(id => before.has(id)).length;
  return { added, removed, unchanged, available: true, note: null };
};

// ---------------------------------------------------------------------------
// Findings — READ from the existing project lifecycle, never recomputed
// ---------------------------------------------------------------------------

export type ChangeFindingRef = {
  /** projectFindingIdOf: the existing project finding identity. */
  id: string;
  /** The Phase 5 semantic fingerprint behind the project finding, read from the
   *  recorded lifecycle snapshot. Used only to find the existing historical
   *  intelligence record; never used to re-derive identity here. */
  fingerprint: string;
  title: string;
  code: string;
  severity: string;
  status: ProjectFindingStatus;
  page: string;
  /** Run-local finding id in the current run, when observed there. */
  runFindingId: string | null;
};

export type FindingChanges = {
  new: ChangeFindingRef[];
  resolved: ChangeFindingRef[];
  regressed: ChangeFindingRef[];
  active: ChangeFindingRef[];
  unchanged: ChangeFindingRef[];
  available: boolean;
  reason: ComparisonUnavailableReason | null;
  note: string | null;
};

/** Existing historical-intelligence record for a changed finding, exposed as-is. */
export type HistoryReference = {
  lifecycle: string;
  confidence: string;
  runIds: string[];
  firstSeenRunId: string | null;
  lastSeenRunId: string | null;
};

const findingChangesOf = (
  snapshot: ProjectRunFindingsSnapshot | null,
  titles: Map<string, { title: string; code: string; severity: string; page: string }>,
  runId: string,
): FindingChanges => {
  const resolve = (ids: string[], status: ProjectFindingStatus): ChangeFindingRef[] =>
    ids
      .map(id => {
        const meta = titles.get(id);
        if (!meta) return null;
        const entry = snapshot?.entries.find(item => item.projectFindingId === id) ?? null;
        return {
          id,
          fingerprint: entry?.fingerprint ?? "",
          title: meta.title,
          code: meta.code,
          severity: meta.severity,
          status,
          page: meta.page,
          runFindingId: entry?.runFindingId ?? null,
        };
      })
      .filter((item): item is ChangeFindingRef => item !== null)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (!snapshot) {
    return {
      new: [], resolved: [], regressed: [], active: [], unchanged: [],
      available: false,
      reason: "INSUFFICIENT_EVIDENCE",
      note: "this run has no recorded project finding snapshot, so no finding change can be shown",
    };
  }
  if (!snapshot.comparisonAvailable) {
    return {
      new: [], resolved: [], regressed: [], active: [], unchanged: [],
      available: false,
      reason: "INSUFFICIENT_EVIDENCE",
      note: snapshot.comparisonReason,
    };
  }
  return {
    new: resolve(snapshot.refs.new, "NEW"),
    resolved: resolve(snapshot.refs.resolved, "RESOLVED"),
    regressed: resolve(snapshot.refs.regressed, "REGRESSED"),
    active: resolve(snapshot.refs.active, "ACTIVE"),
    unchanged: resolve(snapshot.refs.unchanged, "ACTIVE"),
    available: true,
    reason: null,
    note: null,
  };
};

// ---------------------------------------------------------------------------
// The change summary
// ---------------------------------------------------------------------------

/** Compact, per-run record persisted with the project so history and the
 *  project page can show changes without re-reading report artifacts. */
export type RunChangeRecord = {
  currentRunId: string;
  previousRunId: string | null;
  availability: ComparisonAvailability;
  reason: ComparisonUnavailableReason | null;
  pagesAdded: number;
  pagesRemoved: number;
  elementsAdded: number;
  elementsRemoved: number;
  elementsUnmatched: number;
  interactiveAdded: number;
  interactiveRemoved: number;
  flowsAdded: number;
  flowsRemoved: number;
  flowStatusChanges: string[];
  accessPrevious: AccessStateLabel;
  accessCurrent: AccessStateLabel;
  accessChanged: boolean;
  coverageDelta: Record<CoverageMeasure, Measured>;
  verificationDelta: Record<VerificationMeasure, Measured>;
  /** Pre-rendered descriptive lines, so the project page and the run history
   *  never disagree about the wording of a change. */
  highlights: string[];
};

export type ChangeSummary = ComparisonAvailabilityBlock & {
  currentRunId: string;
  previousRunId: string | null;
  findings: FindingChanges;
  pages: PageChanges;
  elements: ElementChanges;
  flows: FlowChanges;
  verification: VerificationChanges;
  coverage: CoverageChanges;
  access: AccessChange;
  recommendations: RecommendationChanges;
  /** Existing historical-intelligence records for what changed, exposed as-is. */
  history: {
    status: string | null;
    findingReferences: Record<string, HistoryReference>;
    flowReferences: Record<string, { stability: string; confidence: string; runIds: string[] }>;
  };
};

export type ChangeSummaryInput = {
  currentRunId: string;
  current: QaAnalysis;
  previousRunId: string | null;
  previous: QaAnalysis | null;
  /** The project lifecycle snapshot recorded for the current run. */
  snapshot: ProjectRunFindingsSnapshot | null;
  /** projectFindingId -> display facts, from the project ledger. */
  findingTitles: Map<string, { title: string; code: string; severity: string; page: string }>;
  options?: RegressionCompareOptions;
};

/**
 * Decides what may be claimed about a pair of runs. Pure, and the single place
 * availability is decided.
 *
 * Order matters. No predecessor, then the access boundary, then the previous
 * run's own evidence, then the current run's evidence, then run comparability.
 *
 * The access boundary is checked BEFORE the evidence checks on purpose: when a
 * previous run could not reach the site, the honest output is not a dead end.
 * The access transition itself is a real, recorded fact, so it is shown as a
 * PARTIAL comparison, while pages, elements, findings and flows are withheld —
 * a run that never loaded the page says nothing about what changed on it.
 */
export function changeAvailability(
  current: QaAnalysis,
  previous: QaAnalysis | null,
): ComparisonAvailabilityBlock {
  if (!previous) {
    return { availability: "UNAVAILABLE", comparisonAvailable: false, reason: "NO_PREVIOUS_RUN", reasonDetail: "there is no earlier completed run for this project" };
  }

  const previousAccess = accessStateOf(previous);
  const currentAccess = accessStateOf(current);
  const previousEvidence = assessRunEvidence(previous);
  const currentEvidence = assessRunEvidence(current);
  const accessMoved = previousAccess !== currentAccess;
  const oneSideUnreachable = previousAccess !== "ACCESSIBLE" || currentAccess !== "ACCESSIBLE";

  if (accessMoved && oneSideUnreachable) {
    return {
      availability: "PARTIAL",
      comparisonAvailable: true,
      reason: "ACCESS_BOUNDARY",
      reasonDetail: `the access state changed from ${previousAccess} to ${currentAccess}, so only that transition is reported; pages, elements, findings and flows are not compared across that boundary`,
    };
  }
  if (!previousEvidence.resolutionTrustworthy) {
    return { availability: "UNAVAILABLE", comparisonAvailable: false, reason: "PREVIOUS_RUN_INCOMPLETE", reasonDetail: previousEvidence.reason };
  }
  if (!currentEvidence.resolutionTrustworthy) {
    return { availability: "UNAVAILABLE", comparisonAvailable: false, reason: "CURRENT_RUN_INCOMPLETE", reasonDetail: currentEvidence.reason };
  }
  const comparable = compareRunAnalyses(current, previous);
  if (!comparable.comparable) {
    return { availability: "UNAVAILABLE", comparisonAvailable: false, reason: "INSUFFICIENT_EVIDENCE", reasonDetail: comparable.reason };
  }
  return { availability: "AVAILABLE", comparisonAvailable: true, reason: null, reasonDetail: null };
}

/** Builds the full, deterministic change summary for a pair of run artifacts. */
export function buildChangeSummary(input: ChangeSummaryInput): ChangeSummary {
  const { currentRunId, current, previous, previousRunId, snapshot, findingTitles, options } = input;
  const availability = changeAvailability(current, previous);

  // Across an access boundary, only the transition itself is claimed.
  const dimensionsComparable = availability.availability === "AVAILABLE";
  const dimensionReason: ComparisonUnavailableReason | null = dimensionsComparable ? null : availability.reason;

  const previousPages = previous ? pagesOf(previous, options) : [];
  const currentPages = pagesOf(current, options);
  const currentPageIds = new Set(currentPages.map(page => page.id));
  const previousPageIds = new Set(previousPages.map(page => page.id));

  const pages: PageChanges = dimensionsComparable
    ? {
        added: currentPages.filter(page => !previousPageIds.has(page.id)),
        removed: previousPages.filter(page => !currentPageIds.has(page.id)),
        unchanged: currentPages.filter(page => previousPageIds.has(page.id)),
        notComparable: [],
        available: true,
        reason: null,
        note: null,
      }
    : {
        added: [], removed: [], unchanged: [], notComparable: previousPages,
        available: false,
        reason: dimensionReason,
        note: availability.reasonDetail,
      };

  const elements = elementChangesOf(current, previous ?? current, dimensionsComparable, dimensionReason);
  const flows = flowChangesOf(current, previous ?? current, dimensionsComparable, dimensionReason, options);
  const recommendations = recommendationChangesOf(current, previous ?? current, dimensionsComparable);

  const findings = findingChangesOf(snapshot, findingTitles, currentRunId);

  const verificationCurrent = verificationCountsOf(current);
  // With no predecessor at all, the previous column stays null rather than
  // echoing the current run: an unmeasured run must never look like a baseline.
  const verificationPrevious = previous ? verificationCountsOf(previous) : nullVerificationCounts();
  // A delta only exists when both runs measured the same thing. Across an
  // access boundary the raw counts are kept (they are facts about each run) but
  // the delta is withheld, because it would describe exercise that never
  // happened on one side.
  const deltasAvailable = availability.availability === "AVAILABLE";
  const verification = measurementBlock(
    VERIFICATION_MEASURES,
    verificationCurrent,
    verificationPrevious,
    deltasAvailable,
    deltasAvailable ? null : availability.reasonDetail,
  );

  const coverageCurrent = coverageCountsOf(current);
  const coveragePrevious = previous ? coverageCountsOf(previous) : nullCoverageCounts();
  const coverage = measurementBlock(
    COVERAGE_MEASURES,
    coverageCurrent,
    coveragePrevious,
    deltasAvailable,
    deltasAvailable ? null : availability.reasonDetail,
  );

  const previousAccess = previous ? accessLabel(previous) : "UNKNOWN";
  const currentAccess = accessLabel(current);
  const accessChanged = previousAccess !== currentAccess;
  const access: AccessChange = {
    previous: previousAccess,
    current: currentAccess,
    changed: accessChanged,
    transition: accessChanged ? `${previousAccess} -> ${currentAccess}` : null,
    previousStatus: previous?.accessPrerequisite?.status ?? previous?.scan?.accessPrerequisite?.status ?? null,
    currentStatus: current.accessPrerequisite?.status ?? current.scan?.accessPrerequisite?.status ?? null,
    note: accessChanged
      ? "This is an access-state change, not a judgement about the website."
      : "The access state did not change between these runs.",
  };

  return {
    ...availability,
    currentRunId,
    previousRunId,
    findings,
    pages,
    elements,
    flows,
    verification,
    coverage,
    access,
    recommendations,
    history: historyReferencesOf(current, findings, flows),
  };
}

/**
 * A change summary that claims nothing.
 *
 * Used when the current run's own report cannot be read at all, so there is no
 * evidence to compare from. Every dimension is explicitly unavailable with the
 * reason attached, rather than silently empty.
 */
export function unavailableChangeSummary(
  currentRunId: string,
  reason: ComparisonUnavailableReason,
  reasonDetail: string,
  previousRunId: string | null = null,
): ChangeSummary {
  const emptyPages: PageChangeItem[] = [];
  const block: ComparisonAvailabilityBlock = { availability: "UNAVAILABLE", comparisonAvailable: false, reason, reasonDetail };
  const notCompared = reasonDetail;
  return {
    ...block,
    currentRunId,
    previousRunId,
    findings: findingChangesOf(null, new Map(), currentRunId),
    pages: { added: emptyPages, removed: emptyPages, unchanged: emptyPages, notComparable: emptyPages, available: false, reason, note: notCompared },
    elements: elementChangesOf(null as unknown as QaAnalysis, null as unknown as QaAnalysis, false, reason),
    flows: flowChangesOf(null as unknown as QaAnalysis, null as unknown as QaAnalysis, false, reason),
    verification: measurementBlock(VERIFICATION_MEASURES, nullVerificationCounts(), nullVerificationCounts(), false, notCompared),
    coverage: measurementBlock(COVERAGE_MEASURES, nullCoverageCounts(), nullCoverageCounts(), false, notCompared),
    access: {
      previous: "UNKNOWN",
      current: "UNKNOWN",
      changed: false,
      transition: null,
      previousStatus: null,
      currentStatus: null,
      note: notCompared,
    },
    recommendations: recommendationChangesOf(null as unknown as QaAnalysis, null as unknown as QaAnalysis, false),
    history: { status: null, findingReferences: {}, flowReferences: {} },
  };
}

/** The compact record persisted for history and the project page. */
export function changeRecordOf(summary: ChangeSummary): RunChangeRecord {
  const coverageDelta = {} as Record<CoverageMeasure, Measured>;
  for (const measure of COVERAGE_MEASURES) coverageDelta[measure] = summary.coverage.delta[measure];
  const verificationDelta = {} as Record<VerificationMeasure, Measured>;
  for (const measure of VERIFICATION_MEASURES) verificationDelta[measure] = summary.verification.delta[measure];
  return {
    currentRunId: summary.currentRunId,
    previousRunId: summary.previousRunId,
    availability: summary.availability,
    reason: summary.reason,
    pagesAdded: summary.pages.added.length,
    pagesRemoved: summary.pages.removed.length,
    elementsAdded: summary.elements.added.length,
    elementsRemoved: summary.elements.removed.length,
    elementsUnmatched: summary.elements.unmatched.length,
    interactiveAdded: summary.elements.interactiveAdded,
    interactiveRemoved: summary.elements.interactiveRemoved,
    flowsAdded: summary.flows.added.length,
    flowsRemoved: summary.flows.removed.length,
    flowStatusChanges: summary.flows.statusChanged.map(item => item.transition),
    accessPrevious: summary.access.previous,
    accessCurrent: summary.access.current,
    accessChanged: summary.access.changed,
    coverageDelta,
    verificationDelta,
    highlights: highlightsOf(summary),
  };
}

// ---------------------------------------------------------------------------
// Existing historical intelligence, exposed rather than recalculated
// ---------------------------------------------------------------------------

function historyReferencesOf(
  current: QaAnalysis,
  findings: FindingChanges,
  flows: FlowChanges,
): ChangeSummary["history"] {
  const section = current.historicalIntelligence ?? null;
  const findingReferences: Record<string, HistoryReference> = {};
  const flowReferences: Record<string, { stability: string; confidence: string; runIds: string[] }> = {};

  if (section) {
    const findingsByKey = new Map((section.findings ?? []).map(item => [item.key, item]));
    for (const ref of [...findings.new, ...findings.resolved, ...findings.regressed]) {
      if (!ref.fingerprint) continue;
      const record = findingsByKey.get(ref.fingerprint);
      if (!record) continue;
      findingReferences[ref.id] = {
        lifecycle: record.lifecycle,
        confidence: record.confidence,
        runIds: [...record.runIds],
        firstSeenRunId: record.firstSeenRunId,
        lastSeenRunId: record.lastSeenRunId,
      };
    }
    const flowsByFamily = new Map((section.flows ?? []).map(item => [item.familyKey, item]));
    for (const item of [...flows.added, ...flows.removed, ...flows.statusChanged]) {
      const record = flowsByFamily.get(item.familyKey);
      if (!record) continue;
      flowReferences[item.familyKey] = {
        stability: record.stability,
        confidence: record.confidence,
        runIds: [...record.runIds],
      };
    }
  }

  return {
    status: section?.status ?? null,
    findingReferences,
    flowReferences,
  };
}

/**
 * The compact descriptive lines for a change record.
 *
 * Deduplicated and sorted, so the same pair of runs always produces the same
 * lines in the same order. No score, no ranking, no verdict: each line states a
 * count of recorded evidence.
 */
export function highlightsOf(summary: ChangeSummary): string[] {
  const lines: string[] = [];
  const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);
  // A line states a count of recorded evidence, so a dimension that recorded no
  // difference contributes no line at all. "0 flows added" is noise, not a
  // finding, and printing it on every unchanged run would train a reader to
  // stop reading.
  const findings = summary.findings;
  if (findings.available) {
    if (findings.new.length) lines.push(plural(findings.new.length, "new finding"));
    if (findings.resolved.length) lines.push(plural(findings.resolved.length, "finding resolved", "findings resolved"));
    if (findings.regressed.length) lines.push(plural(findings.regressed.length, "finding regressed", "findings regressed"));
  }
  if (summary.pages.available) {
    if (summary.pages.added.length) lines.push(plural(summary.pages.added.length, "page added", "pages added"));
    if (summary.pages.removed.length) lines.push(plural(summary.pages.removed.length, "page removed", "pages removed"));
  }
  if (summary.elements.available) {
    if (summary.elements.interactiveAdded) lines.push(plural(summary.elements.interactiveAdded, "interactive element added", "interactive elements added"));
    if (summary.elements.interactiveRemoved) lines.push(plural(summary.elements.interactiveRemoved, "interactive element removed", "interactive elements removed"));
    if (summary.elements.unmatched.length) lines.push(plural(summary.elements.unmatched.length, "unmatched element", "unmatched elements"));
  }
  if (summary.flows.available) {
    if (summary.flows.added.length) lines.push(plural(summary.flows.added.length, "flow added", "flows added"));
    if (summary.flows.removed.length) lines.push(plural(summary.flows.removed.length, "flow removed", "flows removed"));
    // Repeated transitions collapse into one counted line, so the number
    // reported is the number of flows that moved, not the number of entries.
    const counts = new Map<string, number>();
    for (const item of summary.flows.statusChanged) {
      counts.set(item.transition, (counts.get(item.transition) ?? 0) + item.count);
    }
    for (const transition of [...counts.keys()].sort()) {
      lines.push(plural(counts.get(transition)!, "flow") + " status changed: " + transition.replace(" -> ", " to "));
    }
  }
  if (summary.access.changed && summary.access.transition) {
    lines.push("access state changed: " + summary.access.transition.replace(" -> ", " to "));
  }
  if (summary.recommendations.available && summary.recommendations.added.length + summary.recommendations.removed.length) {
    lines.push(plural(summary.recommendations.added.length + summary.recommendations.removed.length, "recommendation change", "recommendation changes"));
  }
  return sortedUnique(lines);
}
