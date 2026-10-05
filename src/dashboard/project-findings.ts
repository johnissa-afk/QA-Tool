// ---------------------------------------------------------------------------
// Project finding lifecycle — how findings change across a project's QA runs.
//
// This module deliberately adds NO new identity system and NO new classification
// algorithm. It is a thin, deterministic project-level view built on top of
// infrastructure the engine already has:
//
//   identity           -> findingHistoryKey() / findingSignature()   (Phase 5 / 7A)
//   absence is not fix -> meaningfullyTested() / relationCoverageStatus()
//                                                                  (Phase 7B matching)
//   comparable runs    -> comparableRunPair()                      (Phase 5)
//   vocabulary         -> HistoricalFindingState                   (Phase 7B)
//
// Nothing here consults an AI provider. Identity is a hash of the semantic
// finding key; lifecycle is decided by set membership plus the coverage
// evidence the engine already recorded. The same project + previous run +
// current run always produce the same output.
//
// STATUS VOCABULARY
// The four project statuses are a project-scoped view of the existing Phase 7B
// lifecycle states, not a parallel system:
//
//   NEW       <- HistoricalFindingState.NEW         (first observed)
//   ACTIVE    <- HistoricalFindingState.PERSISTING  (present across runs)
//   REGRESSED <- HistoricalFindingState.REAPPEARED  (returned after absence)
//   RESOLVED  <- HistoricalFindingState.DISAPPEARED (absent while re-tested)
//
// `historicalStateOf` is the single place that mapping lives.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import type { QaAnalysis, QaFinding, Severity } from "../ai/types.js";
import { buildRunSnapshot } from "../history/snapshot.js";
import { findingHistoryKey } from "../history/identity.js";
import { identityMapsOf, meaningfullyTested, relationCoverageStatus } from "../history-intelligence/matching.js";
import type { HistoricalFindingState } from "../history-intelligence/types.js";
import { comparableRunPair, normalizePageUrl, normalizeText, originOf } from "../regression/identity.js";
import type { RegressionCompareOptions } from "../regression/types.js";

/** The project-scoped lifecycle status of a tracked finding. */
export type ProjectFindingStatus = "NEW" | "ACTIVE" | "REGRESSED" | "RESOLVED";

/**
 * Explicit uncertainty attached to a status.
 *
 * `ABSENCE_UNVERIFIED` is the important one: a finding that vanished from a run
 * whose coverage never meaningfully re-tested its page KEEPS its previous status
 * and carries this flag, instead of being reported as RESOLVED. Missing evidence
 * is never silently treated as a fix.
 */
export type FindingCertainty = "CONFIRMED" | "ABSENCE_UNVERIFIED" | "NOT_COMPARED";

/** Lifecycle status mapped onto the existing Phase 7B vocabulary. */
export function historicalStateOf(status: ProjectFindingStatus): HistoricalFindingState {
  switch (status) {
    case "NEW":
      return "NEW";
    case "ACTIVE":
      return "PERSISTING";
    case "REGRESSED":
      return "REAPPEARED";
    case "RESOLVED":
      return "DISAPPEARED";
  }
}

/** Persistent, project-level identity for a finding. */
export type ProjectFinding = {
  id: string;
  projectId: string;
  /** The Phase 5/7A semantic key: code + normalized page + semantic element. */
  fingerprint: string;
  /** Coarse family anchor, used to detect ambiguous same-family swaps. */
  family: string;
  page: string;
  title: string;
  code: string;
  domain: string;
  severity: Severity;
  firstSeenRunId: string;
  firstSeenAt: string;
  lastSeenRunId: string;
  lastSeenAt: string;
  /** How many comparable runs observed this finding. */
  occurrenceCount: number;
  status: ProjectFindingStatus;
  certainty: FindingCertainty;
  /** Plain-language reason for a non-CONFIRMED status. */
  reviewNote: string | null;
  /** The run in which it was last observed absent AND verified clear. */
  lastResolvedRunId: string | null;
  lastResolvedAt: string | null;
  /** How many times it has returned after being resolved. */
  regressionCount: number;
};

/** One recorded lifecycle step, for a finding's inspectable history. */
export type FindingLifecycleEvent = {
  findingId: string;
  fingerprint: string;
  runId: string;
  at: string;
  status: ProjectFindingStatus;
  observed: boolean;
  /** Run-local finding reference in that run, when present. */
  runFindingId: string | null;
  note: string | null;
};

/** A finding as it stood in one specific run. */
export type RunFindingSnapshotEntry = {
  fingerprint: string;
  projectFindingId: string;
  status: ProjectFindingStatus;
  observed: boolean;
  runFindingId: string | null;
  title: string;
  code: string;
  severity: Severity;
  page: string;
};

export type FindingCounts = {
  new: number;
  active: number;
  regressed: number;
  resolved: number;
  /** Of the active findings, how many carried identical recorded details. */
  unchanged: number;
  /** Of the active findings, how many changed title/severity. */
  changed: number;
};

export const emptyFindingCounts = (): FindingCounts => ({
  new: 0,
  active: 0,
  regressed: 0,
  resolved: 0,
  unchanged: 0,
  changed: 0,
});

/** The deterministic finding snapshot recorded for one completed project run. */
export type ProjectRunFindingsSnapshot = {
  runId: string;
  projectId: string;
  at: string;
  /** Whether this run could be compared with an earlier project run. */
  comparisonAvailable: boolean;
  /** Why a comparison is unavailable. Null when it is available. */
  comparisonReason: string | null;
  /** Whether absences in this run may be interpreted as resolved at all. */
  resolutionTrustworthy: boolean;
  /** Why resolution is untrustworthy, in plain language. */
  resolutionReason: string | null;
  counts: FindingCounts;
  /** Project finding ids grouped by outcome in THIS run, so a comparison can be
   *  served verbatim from persisted data rather than reconstructed. */
  refs: {
    new: string[];
    resolved: string[];
    regressed: string[];
    active: string[];
    unchanged: string[];
    changed: string[];
  };
  entries: RunFindingSnapshotEntry[];
};

const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");

/**
 * Deterministic project-level finding id. Depends only on the project and the
 * semantic fingerprint — never on a run id, a clock, or array position — so the
 * same finding in the same project always has the same id, across restarts and
 * across machines.
 */
export function projectFindingIdOf(projectId: string, fingerprint: string): string {
  return `prj-fnd-${sha1(`${projectId}|${fingerprint}`).slice(0, 16)}`;
}

/** Severity rank for ordering. Descriptive only — never a score. */
const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

/** Stable, total ordering so output never depends on input array order. */
export function compareProjectFindings(a: ProjectFinding, b: ProjectFinding): number {
  const sev = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  if (sev !== 0) return sev;
  if (a.fingerprint !== b.fingerprint) return a.fingerprint < b.fingerprint ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Run evidence — the gate that decides what may be concluded at all.
// ---------------------------------------------------------------------------

export type RunEvidence = {
  hasReport: boolean;
  accessStatus: "PASS" | "REVIEW_REQUIRED" | "BLOCKED" | null;
  /** The verification/execution layer actually ran. */
  executed: boolean;
  /** A coverage crawl produced a coverage map. */
  crawled: boolean;
  /** Absences in this run may be interpreted as resolved. */
  resolutionTrustworthy: boolean;
  reason: string | null;
};

/**
 * Decides, from the report alone, whether this run's ABSENCES mean anything.
 *
 * A run that was blocked, needed authentication, hit bot protection, or failed
 * for infrastructure reasons never exercised the site, so a finding missing from
 * it says nothing at all. Such runs are still recorded — they just resolve
 * nothing.
 */
/**
 * Whether this report can produce semantic finding identity at all.
 *
 * The Phase 5 signature is `code + normalized page + element semantic key`, so
 * a report without discovered elements has no identity to track. Rather than
 * inventing one, lifecycle reporting is simply unavailable for such a run.
 */
export function semanticIdentityAvailable(analysis: QaAnalysis): boolean {
  return Array.isArray(analysis.scan?.elements);
}

export function assessRunEvidence(analysis: QaAnalysis): RunEvidence {
  const access = analysis.accessPrerequisite?.status ?? null;
  const executed =
    analysis.execution !== null ||
    (analysis.flowDiscovery?.executions?.length ?? 0) > 0 ||
    (analysis.verifications?.length ?? 0) > 0;
  const crawled = analysis.coverage !== null && analysis.coverage !== undefined;
  const infrastructureProblems = analysis.summary?.infrastructureProblems ?? 0;

  const base = { hasReport: true, accessStatus: access, executed, crawled };

  if (access === "BLOCKED") {
    return { ...base, resolutionTrustworthy: false, reason: "the run could not access the site (BLOCKED), so nothing can be concluded from what is missing" };
  }
  if (access === "REVIEW_REQUIRED") {
    return { ...base, resolutionTrustworthy: false, reason: "the run required review (for example authentication or bot protection), so findings were never meaningfully re-tested" };
  }
  if (infrastructureProblems > 0) {
    return { ...base, resolutionTrustworthy: false, reason: `the run recorded ${infrastructureProblems} infrastructure problem(s); the untested parts of the site say nothing about whether a finding is fixed` };
  }
  if (!crawled) {
    return { ...base, resolutionTrustworthy: false, reason: "the run produced no coverage map, so it is unknown which areas were exercised" };
  }
  const pages = analysis.coverage?.summary?.pages;
  if (pages && pages.tested === 0 && pages.partial === 0) {
    return { ...base, resolutionTrustworthy: false, reason: "no page was meaningfully tested in this run, so no finding can be considered resolved" };
  }
  return { ...base, resolutionTrustworthy: true, reason: null };
}

/** Per-finding coverage evidence, computed once per run and shared. */
type AreaEvidence = {
  /** True when the finding's own area was meaningfully exercised this run. */
  exercised: boolean;
  /** The coverage status behind that answer, for display. */
  coverageStatus: string | null;
};

/** Coverage evidence for a whole run, indexed the two ways it is needed. */
type RunAreaEvidence = {
  /** By the finding's own semantic key, for findings present this run. */
  byKey: Map<string, AreaEvidence>;
  /**
   * By normalized page, for a finding that is ABSENT this run. An absent
   * finding has no record in this run, so its area's evidence can only be read
   * from the page it used to live on. Without this the engine could never say a
   * finding was resolved.
   */
  byPage: Map<string, AreaEvidence>;
};

function areaEvidenceForRun(
  analysis: QaAnalysis,
  options?: RegressionCompareOptions,
): RunAreaEvidence {
  const byKey = new Map<string, AreaEvidence>();
  const byPage = new Map<string, AreaEvidence>();
  // An unreadable snapshot means no coverage evidence, which can only ever
  // make a resolution LESS likely. It never throws a run into failure.
  let maps: ReturnType<typeof identityMapsOf>;
  try {
    const snapshot = buildRunSnapshot(analysis, { runId: "project-findings-probe", startedAt: analysis.generatedAt });
    maps = identityMapsOf(snapshot);
  } catch {
    return { byKey, byPage };
  }
  for (const [key, record] of maps.findingByKey) {
    const coverageStatus = relationCoverageStatus(maps, record);
    byKey.set(key, { exercised: meaningfullyTested(coverageStatus), coverageStatus });
  }

  for (const item of maps.coverageByKey.values()) {
    if (!item.url) continue;
    const page = normalizePageUrl(item.url);
    const existing = byPage.get(page);
    // An exercised status wins over an unexercised one, so the answer does not
    // depend on the order coverage items happened to be recorded in.
    if (!existing || (!existing.exercised && meaningfullyTested(item.status))) {
      byPage.set(page, { exercised: meaningfullyTested(item.status), coverageStatus: item.status });
    }
  }
  return { byKey, byPage };
}

// ---------------------------------------------------------------------------
// The transition: ledger + current run -> updated ledger, snapshot, events.
// ---------------------------------------------------------------------------

/** The project ledger this module reads and writes. */
export type ProjectFindingLedger = {
  findings: ProjectFinding[];
  events: FindingLifecycleEvent[];
};

export const emptyLedger = (): ProjectFindingLedger => ({ findings: [], events: [] });

export type ApplyRunInput = {
  projectId: string;
  runId: string;
  analysis: QaAnalysis;
  /** The project's ledger as of the previous run. */
  ledger: ProjectFindingLedger;
  /**
   * The immediately-preceding project run's report, when one exists and is
   * comparable. Null for a project's first run.
   */
  previousAnalysis: QaAnalysis | null;
  previousRunId: string | null;
  options?: RegressionCompareOptions;
};

export type ApplyRunResult = {
  ledger: ProjectFindingLedger;
  snapshot: ProjectRunFindingsSnapshot;
  /** Deterministic per-finding comparison against the previous run. */
  comparison: ProjectRunComparison;
};

export type ProjectRunComparison = {
  comparisonAvailable: boolean;
  reason: string | null;
  counts: FindingCounts;
  new: string[];
  resolved: string[];
  regressed: string[];
  active: string[];
  unchanged: string[];
  changed: string[];
};

/** A finding reference resolved out of a persisted comparison, for the API. */
export type ProjectComparisonFindingRef = {
  id: string;
  fingerprint: string;
  title: string;
  code: string;
  severity: Severity;
  status: ProjectFindingStatus;
  page: string;
  runId: string;
  /** Run-local reference, so the UI can open the existing evidence detail. */
  runFindingId: string | null;
};

/** The API-facing comparison: the same persisted data, with resolved refs. */
export type ProjectRunComparisonResult = {
  comparisonAvailable: boolean;
  reason: string | null;
  counts: FindingCounts;
  new: ProjectComparisonFindingRef[];
  resolved: ProjectComparisonFindingRef[];
  regressed: ProjectComparisonFindingRef[];
  active: ProjectComparisonFindingRef[];
  unchanged: ProjectComparisonFindingRef[];
  changed: ProjectComparisonFindingRef[];
};

/**
 * Applies one completed run to the project ledger.
 *
 * Pure and deterministic: the same project, previous run and current run always
 * produce the same ledger, snapshot and comparison. No AI, no clock, no
 * randomness, and no dependence on finding array order.
 */
export function applyRunToLedger(input: ApplyRunInput): ApplyRunResult {
  const { projectId, runId, analysis, ledger, options } = input;
  const at = analysis.generatedAt;

  // A report that cannot yield semantic identity records no lifecycle at all.
  // The run is still stored, still counted, and still has a result page; this
  // project simply reports "not available" instead of guessing identities.
  if (!semanticIdentityAvailable(analysis)) {
    const reason = "this run's report carries no discovered elements, so finding identity cannot be computed and no project lifecycle is recorded";
    const snapshot: ProjectRunFindingsSnapshot = {
      runId, projectId, at,
      comparisonAvailable: false,
      comparisonReason: reason,
      resolutionTrustworthy: false,
      resolutionReason: reason,
      counts: emptyFindingCounts(),
      refs: { new: [], resolved: [], regressed: [], active: [], unchanged: [], changed: [] },
      entries: [],
    };
    return {
      ledger,
      snapshot,
      comparison: { comparisonAvailable: false, reason, counts: emptyFindingCounts(), new: [], resolved: [], regressed: [], active: [], unchanged: [], changed: [] },
    };
  }

  const evidence = assessRunEvidence(analysis);
  const area = areaEvidenceForRun(analysis, options);

  const pair = compareRunAnalyses(analysis, input.previousAnalysis);
  // A run that could not access or meaningfully test the site is recorded, but
  // it may neither change a lifecycle status nor be compared against an earlier
  // run: its missing findings would be a statement about the crawler, not the
  // website. This is the rule that keeps a blocked or auth-walled run from
  // marking a whole project RESOLVED.
  const trackable = evidence.resolutionTrustworthy;
  const comparisonAvailable = pair.comparable && trackable;
  const comparisonReason = !pair.comparable ? pair.reason : trackable ? null : evidence.reason;

  // The previous run's own recorded details let us report "unchanged" vs
  // "changed" for carried-over findings.
  const previousByKey = new Map<string, { title: string; severity: string }>();
  if (input.previousAnalysis) {
    for (const finding of input.previousAnalysis.findings) {
      const key = findingHistoryKey(input.previousAnalysis, finding, options).key;
      previousByKey.set(key, { title: normalizeText(finding.title), severity: finding.severity });
    }
  }

  // Observed this run, ordered by fingerprint so output is order-independent.
  const observed = analysis.findings
    .map(finding => ({ finding, key: findingHistoryKey(analysis, finding, options) }))
    .filter(item => item.key.key.length > 0)
    .sort((a, b) => (a.key.key < b.key.key ? -1 : a.key.key > b.key.key ? 1 : 0));

  const priorByFingerprint = new Map(ledger.findings.map(finding => [finding.fingerprint, finding]));
  const counts = emptyFindingCounts();
  const entries: RunFindingSnapshotEntry[] = [];
  const events: FindingLifecycleEvent[] = [];
  const nextFindings: ProjectFinding[] = [];
  const touched = new Set<string>();

  const comparisonRefs = { new: [] as string[], resolved: [] as string[], regressed: [] as string[], active: [] as string[], unchanged: [] as string[], changed: [] as string[] };

  for (const { finding, key } of observed) {
    const fingerprint = key.key;
    const id = projectFindingIdOf(projectId, fingerprint);
    const prior = priorByFingerprint.get(fingerprint);
    let status: ProjectFindingStatus;
    let certainty: FindingCertainty = "CONFIRMED";
    let reviewNote: string | null = null;

    if (!prior) {
      status = "NEW";
    } else if (!trackable) {
      // The finding was genuinely seen, but this run could not be compared, so
      // the recorded lifecycle stands unchanged.
      status = prior.status;
      reviewNote = `observed in a run that could not be compared: ${evidence.reason}`;
    } else if (prior.status === "RESOLVED") {
      // It had disappeared and is back: a lifecycle regression, independent of
      // the separate regression-gate policy decision.
      status = "REGRESSED";
    } else {
      // Present again, no new reappearance. A REGRESSED finding that keeps being
      // observed is simply persisting from here on.
      status = "ACTIVE";
    }

    const next: ProjectFinding = {
      id,
      projectId,
      fingerprint,
      family: key.family,
      page: key.page,
      title: finding.title,
      code: finding.code,
      domain: finding.domain,
      severity: finding.severity,
      firstSeenRunId: prior ? prior.firstSeenRunId : runId,
      firstSeenAt: prior ? prior.firstSeenAt : at,
      lastSeenRunId: runId,
      lastSeenAt: at,
      // Occurrences only accrue on runs that could actually be compared.
      occurrenceCount: prior ? prior.occurrenceCount + (trackable ? 1 : 0) : 1,
      status,
      certainty,
      reviewNote,
      lastResolvedRunId: prior?.lastResolvedRunId ?? null,
      lastResolvedAt: prior?.lastResolvedAt ?? null,
      regressionCount: status === "REGRESSED" ? (prior?.regressionCount ?? 0) + 1 : prior?.regressionCount ?? 0,
    };

    nextFindings.push(next);
    touched.add(fingerprint);
    events.push({ findingId: id, fingerprint, runId, at, status, observed: true, runFindingId: finding.id, note: null });
    entries.push({ fingerprint, projectFindingId: id, status, observed: true, runFindingId: finding.id, title: finding.title, code: finding.code, severity: finding.severity, page: key.page });

    // Counting and comparison refs. These are facts about THIS run and are only
    // recorded on a run that could be compared at all; `comparisonAvailable`
    // decides whether a comparison may be *presented* to anyone.
    if (!trackable) {
      // Nothing is counted. The snapshot still records that these findings were
      // observed, and why no comparison was made.
    } else if (status === "NEW") {
      counts.new++;
      comparisonRefs.new.push(id);
    } else if (status === "REGRESSED") {
      counts.regressed++;
      comparisonRefs.regressed.push(id);
    } else {
      counts.active++;
      comparisonRefs.active.push(id);
      if (pair.comparable) {
        const before = previousByKey.get(fingerprint);
        const same = before ? before.title === normalizeText(finding.title) && before.severity === finding.severity : true;
        if (same) {
          counts.unchanged++;
          comparisonRefs.unchanged.push(id);
        } else {
          counts.changed++;
          comparisonRefs.changed.push(id);
        }
      }
    }
  }

  // Findings the project knows about that are absent from this run. They are
  // candidates for RESOLVED — but only when this run actually exercised the site.
  const absent = ledger.findings
    .filter(finding => !touched.has(finding.fingerprint) && finding.status !== "RESOLVED")
    .sort((a, b) => compareProjectFindings(a, b));

  for (const prior of absent) {
    // An absent finding has no record in this run, so its area's evidence comes
    // from the page it used to live on.
    const evidenceForArea = area.byKey.get(prior.fingerprint) ?? area.byPage.get(normalizePageUrl(prior.page)) ?? null;
    const exercised = evidenceForArea?.exercised ?? false;
    const resolvable = evidence.resolutionTrustworthy && exercised;

    if (resolvable) {
      const next: ProjectFinding = {
        ...prior,
        status: "RESOLVED",
        certainty: "CONFIRMED",
        reviewNote: null,
        lastResolvedRunId: runId,
        lastResolvedAt: at,
      };
      nextFindings.push(next);
      counts.resolved++;
      comparisonRefs.resolved.push(prior.id);
      events.push({ findingId: prior.id, fingerprint: prior.fingerprint, runId, at, status: "RESOLVED", observed: false, runFindingId: null, note: null });
    } else {
      // NOT resolvable. The finding keeps its previous status and is marked
      // explicitly uncertain. This is the rule that stops a blocked or
      // un-tested run from reporting everything as fixed.
      const why = !evidence.resolutionTrustworthy
        ? evidence.reason
        : `the page this finding was on was not meaningfully re-tested (coverage: ${evidenceForArea?.coverageStatus ?? "unknown"})`;
      const next: ProjectFinding = {
        ...prior,
        status: prior.status === "NEW" ? "NEW" : "ACTIVE",
        certainty: "ABSENCE_UNVERIFIED",
        reviewNote: `not reported as resolved because ${why}`,
      };
      nextFindings.push(next);
      events.push({ findingId: prior.id, fingerprint: prior.fingerprint, runId, at, status: next.status, observed: false, runFindingId: null, note: next.reviewNote });
    }
  }

  // Unchanged ledger entries that this run did not touch at all (already
  // RESOLVED, or unresolved in a way the run said nothing about) carry over
  // byte-for-byte, preserving their recorded lifecycle.
  for (const prior of ledger.findings) {
    if (touched.has(prior.fingerprint)) continue;
    if (absent.some(item => item.id === prior.id)) continue;
    nextFindings.push(prior);
  }

  nextFindings.sort(compareProjectFindings);

  const sortedRefs = {
    new: [...comparisonRefs.new].sort(),
    resolved: [...comparisonRefs.resolved].sort(),
    regressed: [...comparisonRefs.regressed].sort(),
    active: [...comparisonRefs.active].sort(),
    unchanged: [...comparisonRefs.unchanged].sort(),
    changed: [...comparisonRefs.changed].sort(),
  };

  const snapshot: ProjectRunFindingsSnapshot = {
    runId,
    projectId,
    at,
    comparisonAvailable,
    comparisonReason,
    resolutionTrustworthy: evidence.resolutionTrustworthy,
    resolutionReason: evidence.reason,
    counts,
    refs: sortedRefs,
    entries: entries.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)),
  };

  const comparison: ProjectRunComparison = {
    comparisonAvailable,
    reason: comparisonReason,
    counts,
    new: sortedRefs.new,
    resolved: sortedRefs.resolved,
    regressed: sortedRefs.regressed,
    active: sortedRefs.active,
    unchanged: sortedRefs.unchanged,
    changed: sortedRefs.changed,
  };

  return {
    ledger: { findings: nextFindings, events: [...ledger.events, ...events] },
    snapshot,
    comparison,
  };
}

/** Whether two project runs may be compared at all (origin, config, schema). */
export function compareRunAnalyses(
  current: QaAnalysis,
  previous: QaAnalysis | null,
): { comparable: boolean; reason: string | null } {
  if (!previous) return { comparable: false, reason: "there is no earlier completed run for this project" };
  const result = comparableRunPair(current, previous);
  if (!result.comparable) return { comparable: false, reason: result.reason };
  return { comparable: true, reason: null };
}

/** Same-origin check, used to keep a project's runs on one site. */
export function sameOrigin(a: QaAnalysis, b: QaAnalysis): boolean {
  return originOf(a.scan.scan.url) === originOf(b.scan.scan.url);
}

/** Free-text match over title, code and page, for the list filter. */
export function findingMatchesSearch(finding: ProjectFinding, search: string): boolean {
  const needle = normalizeText(search);
  if (!needle) return true;
  return (
    normalizeText(finding.title).includes(needle) ||
    normalizeText(finding.code).includes(needle) ||
    normalizeText(finding.page).includes(needle)
  );
}
