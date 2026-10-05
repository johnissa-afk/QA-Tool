// ---------------------------------------------------------------------------
// Phase 7B — finding timelines and lifecycle classification.
//
// Every historical finding is keyed on the persisted Phase 7A/5 SEMANTIC key
// (code + normalized page + semantic element target) — never the run-local
// QA-F-* id. For each key we build an observation per ordered run (present /
// absent / why absent / what coverage says) and then classify the timeline.
//
// Classification is fully documented and deterministic:
//   - 1 ordered run  -> INSUFFICIENT_EVIDENCE (history exists, no pattern).
//   - 2 ordered runs -> PERSISTING / DISAPPEARED / NEW / CHANGED.
//   - 3+ ordered runs-> REAPPEARED / RECURRING / INTERMITTENT.
//   - Absence is NEVER a fix: DISAPPEARED is only claimed when the area was
//     meaningfully re-tested (OBSERVED_AND_CLEAR); a vanished finding that was
//     never re-tested is NOT_OBSERVED and stays REVIEW_REQUIRED (or DISAPPEARED
//     with a review note when it had been reproduced before).
//   - Contradictions (reproduced then observed-clear) are preserved verbatim
//     and downgrade confidence / force REVIEW_REQUIRED when the pattern cannot
//     be decided.
//   - A same-family swap between adjacent runs (a key vanishes while another
//     key of the same family appears) is ambiguous identity -> REVIEW_REQUIRED,
//     exactly as in Phase 5.
// ---------------------------------------------------------------------------
import type {
  FindingHistorySnapshot,
  HistoryRunSnapshot,
  IntelligenceHistorySnapshot,
} from "../history/index.js";
import { deriveConfidence } from "./confidence.js";
import type { HistoricalFinding, HistoricalFindingState, HistoricalConfidence, FindingObservation } from "./types.js";
import { identityMapsOf, relationCoverageStatus, pageCoverageStatus, meaningfullyTested, OrderedRun, RunIdentityMaps } from "./matching.js";

const REPRODUCED_DISPOSITIONS = new Set(["REPRODUCED", "REPRODUCED / WEBSITE", "PASS / FAILED"]);
const CLEAR_DISPOSITIONS = new Set(["NOT_REPRODUCED", "PASS"]);

const disposedOf = (record: FindingHistorySnapshot): string | null => record.verification?.disposition ?? null;
const verdictOf = (record: FindingHistorySnapshot): string | null => record.verification?.verdict ?? null;

const isReproduced = (disposition: string | null, verdict: string | null): boolean =>
  (disposition !== null && REPRODUCED_DISPOSITIONS.has(disposition)) || verdict === "LIKELY_DEFECT";

const isObservedClear = (disposition: string | null, verdict: string | null): boolean =>
  (disposition !== null && CLEAR_DISPOSITIONS.has(disposition)) || verdict === "NOT_REPRODUCED" || verdict === "CONDITIONAL";

type RunContext = { ordered: OrderedRun; maps: RunIdentityMaps };

// ---------------------------------------------------------------------------
// Per-run observations.
// ---------------------------------------------------------------------------
function observeFinding(contexts: RunContext[], key: string): { observations: FindingObservation[]; records: (FindingHistorySnapshot | null)[] } {
  const observations: FindingObservation[] = [];
  const records: (FindingHistorySnapshot | null)[] = [];
  const findingPage = [...contexts]
    .map(({ maps }) => maps.findingByKey.get(key)?.page ?? "")
    .find(page => page !== "") ?? "";
  for (const { ordered, maps } of contexts) {
    const record = maps.findingByKey.get(key) ?? null;
    records.push(record);
    if (record) {
      const disposition = disposedOf(record);
      const verdict = verdictOf(record);
      observations.push({
        runId: ordered.record.runId,
        page: record.page,
        status: "PRESENT",
        findingId: record.findingId,
        code: record.code,
        severity: record.severity,
        title: record.title,
        disposition,
        verdict,
        relationCoverage: relationCoverageStatus(maps, record),
        discoveryVariance: null,
        verifiedClear: isObservedClear(disposition, verdict),
      });
    } else {
      // Absence: never a fix claim on its own — the deciding factor is whether
      // the area was meaningfully exercised that run.
      const coverage = pageCoverageStatus(maps, findingPage);
      const clear = meaningfullyTested(coverage);
      observations.push({
        runId: ordered.record.runId,
        page: findingPage,
        status: "ABSENT",
        findingId: null,
        code: null,
        severity: null,
        title: null,
        disposition: null,
        verdict: null,
        relationCoverage: coverage,
        discoveryVariance: clear ? "OBSERVED_AND_CLEAR" : "NOT_OBSERVED",
        verifiedClear: clear,
      });
    }
  }
  return { observations, records };
}

// ---------------------------------------------------------------------------
// Family ambiguity: same-family key swapped between adjacent runs.
// ---------------------------------------------------------------------------
function ambiguityFish(contexts: RunContext[]): Map<string, string> {
  const notes = new Map<string, string>();
  for (let i = 0; i + 1 < contexts.length; i++) {
    const aKeys = new Set(contexts[i]!.maps.findingByKey.keys());
    const bKeys = new Set(contexts[i + 1]!.maps.findingByKey.keys());
    const familyByKeyA = new Map<string, string>();
    const familyByKeyB = new Map<string, string>();
    for (const record of [...contexts[i]!.maps.findingByKey.values()]) familyByKeyA.set(record.semanticKey, record.family);
    for (const record of [...contexts[i + 1]!.maps.findingByKey.values()]) familyByKeyB.set(record.semanticKey, record.family);

    const vanished = [...aKeys].filter(key => !bKeys.has(key));
    const appeared = [...bKeys].filter(key => !aKeys.has(key));
    for (const fromKey of vanished.sort()) {
      const family = familyByKeyA.get(fromKey);
      if (!family) continue;
      const swapIn = appeared.filter(key => familyByKeyB.get(key) === family).sort();
      if (!swapIn.length) continue;
      const note = `family "${family}" swapped targets between ${contexts[i]!.ordered.record.runId} and ${contexts[i + 1]!.ordered.record.runId} (${fromKey} → ${swapIn[0]}) — ambiguous identity, treat as review, not as fixed/regressed`;
      notes.set(fromKey, note);
      for (const toKey of swapIn) notes.set(toKey, note);
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Lifecycle classification.
// ---------------------------------------------------------------------------
type Presence = boolean[];

function transitionsOf(presence: Presence): number {
  let count = 0;
  for (let i = 1; i < presence.length; i++) if (presence[i] !== presence[i - 1]) count++;
  return count;
}

/** Absent-run segments strictly between the first and last present run. One
 *  segment = "disappeared once"; two or more = "came back through more than one
 *  absence". Absences before the first appearance are not disappearance. */
function countAbsentSegments(presence: Presence, from: number, to: number): number {
  let segments = 0;
  let inside = false;
  for (let i = from + 1; i < to; i++) {
    if (!presence[i]) {
      if (!inside) segments++;
      inside = true;
    } else {
      inside = false;
    }
  }
  return segments;
}

function classifyLifecycle(
  observations: FindingObservation[],
  presence: Presence,
  detailsChanged: boolean,
  contradicted: boolean,
  reproducedBefore: boolean,
): { state: HistoricalFindingState; reviewNote: string | null } {
  const n = presence.length;
  if (n < 2) return { state: "INSUFFICIENT_EVIDENCE", reviewNote: "only a single ordered run was analyzed — no historical pattern can be claimed" };
  if (contradicted && presence.every(Boolean)) {
    return { state: "REVIEW_REQUIRED", reviewNote: "the finding persisted but was contradicted (reproduced in some runs, observed-clear in others) — its reality must be reviewed" };
  }

  const firstTrue = presence.indexOf(true);
  const lastTrue = presence.lastIndexOf(true);
  const endsPresent = presence[presence.length - 1]!;
  const gaps = countAbsentSegments(presence, firstTrue, lastTrue);
  const strictlyAlternating = transitionsOf(presence) === n - 1;

  if (!endsPresent) {
    // Vanished at the end of the window. Absence is never a fix by itself.
    const lastObservation = observations[observations.length - 1]!;
    const notReTested = lastObservation.discoveryVariance === "NOT_OBSERVED";
    if (notReTested && !reproducedBefore) {
      return { state: "REVIEW_REQUIRED", reviewNote: "the finding vanished without a clean re-test and was never reproduced — absence cannot be interpreted as a fix" };
    }
    if (notReTested && reproducedBefore) {
      return { state: "DISAPPEARED", reviewNote: "was reproduced earlier, then vanished without a clean re-test — absence is unresolved and needs coverage confirmation" };
    }
    return { state: "DISAPPEARED", reviewNote: "no longer observed in later runs while the area was re-tested" };
  }

  if (gaps === 0) {
    // Continuous presence since the first appearance.
    if (firstTrue === n - 1) return { state: "NEW", reviewNote: null };
    if (detailsChanged) return { state: "CHANGED", reviewNote: null };
    if (n === 2 || firstTrue > 0) return { state: "PERSISTING", reviewNote: null };
    return { state: "UNCHANGED", reviewNote: null };
  }

  // Ends present with at least one absence between appearances.
  if (gaps === 1) return { state: "REAPPEARED", reviewNote: null };
  if (strictlyAlternating) {
    return { state: "INTERMITTENT", reviewNote: "the finding's presence toggles in every run — an ongoing on/off pattern" };
  }
  return { state: "RECURRING", reviewNote: null };
}

// ---------------------------------------------------------------------------
// Phase 6 correlation (read-only).
// ---------------------------------------------------------------------------
function relatedCandidatesOf(snapshot: HistoryRunSnapshot | null, runLocalFindingIds: (string | null)[]): HistoricalFinding["relatedCandidates"] {
  const intelligence: IntelligenceHistorySnapshot | null = snapshot?.intelligence ?? null;
  if (!intelligence) return [];
  const candidates = intelligence.rootCauseCandidates ?? [];
  const matched = candidates.filter(candidate => candidate.findingIds.some(id => runLocalFindingIds.includes(id)));
  return matched.map(candidate => ({
    candidateId: candidate.candidateId,
    pattern: candidate.pattern,
    status: candidate.status,
    confidence: candidate.confidence,
  }));
}

// ---------------------------------------------------------------------------
// Public builder.
// ---------------------------------------------------------------------------
export function buildHistoricalFindings(ordered: OrderedRun[]): HistoricalFinding[] {
  const contexts: RunContext[] = ordered.map(item => ({ ordered: item, maps: identityMapsOf(item.snapshot) }));
  const ambiguityNotes = ambiguityFish(contexts);
  const allKeys = new Set<string>();
  for (const { maps } of contexts) for (const key of maps.findingByKey.keys()) allKeys.add(key);

  const findings: HistoricalFinding[] = [];
  for (const key of [...allKeys].sort()) {
    const { observations, records } = observeFinding(contexts, key);
    const presence: Presence = observations.map(observation => observation.status === "PRESENT");
    const presentObservations = observations.filter(observation => observation.status === "PRESENT");
    const reproducedRunIds = observations.filter(observation => isReproduced(observation.disposition, observation.verdict)).map(observation => observation.runId);
    const clearedRunIds = observations.filter(observation => observation.verifiedClear).map(observation => observation.runId);
    const absentRunIds = observations.filter(observation => observation.status === "ABSENT").map(observation => observation.runId);

    // Details changed? Compared across the observed runs.
    const severities = new Set(presentObservations.map(observation => observation.severity).filter(Boolean));
    const titles = new Set(presentObservations.map(observation => observation.title).filter(Boolean));
    const detailsChanged = severities.size > 1 || titles.size > 1;

    const contradictions: HistoricalFinding["contradictions"] = [];
    if (reproducedRunIds.length && clearedRunIds.length) {
      for (const observation of observations) {
        if (isReproduced(observation.disposition, observation.verdict)) {
          contradictions.push({ runId: observation.runId, disposition: observation.disposition ?? "REPRODUCED", verdict: observation.verdict, note: "confirmed suspected problem in this run" });
        } else if (observation.verifiedClear) {
          contradictions.push({ runId: observation.runId, disposition: observation.disposition ?? "CLEAR", verdict: observation.verdict, note: "observed-and-clear in this run" });
        }
      }
    }

    const ambiguityNote = ambiguityNotes.get(key) ?? null;
    const reproducedBefore = reproducedRunIds.length > 0;
    const lifecycle = ambiguityNote
      ? { state: "REVIEW_REQUIRED" as HistoricalFindingState, reviewNote: ambiguityNote }
      : classifyLifecycle(observations, presence, detailsChanged, contradictions.length > 0, reproducedBefore);

    const lastObservation = observations[observations.length - 1]!;
    const latestDisposition = lastObservation.disposition;
    const repository = records[records.length - 1] ?? [...records].reverse().find(Boolean) ?? null;

    const orderedRunCount = ordered.length;
    const confidenceResult = deriveConfidence({
      orderedRunCount,
      observedRunCount: observedCountOf(presence),
      contradictions: contradictions.length,
      verified: reproducedRunIds.length > 0,
      covered: clearedRunIds.length > 0 || meaningfullyTested(lastObservation.relationCoverage),
      gapDependent: lastObservation.status === "ABSENT" && lastObservation.discoveryVariance === "NOT_OBSERVED",
    });

    const presentRuns = observations.filter(observation => observation.status === "PRESENT");
    const confidence: HistoricalConfidence = lifecycle.state === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT" : confidenceResult.confidence;
    const confidenceReason = lifecycle.state === "INSUFFICIENT_EVIDENCE" ? confidenceResult.reason : `${confidenceResult.reason}. ${lifecycle.reviewNote ?? ""}`.trim();

    const firstPresent = presentRuns[0];
    const lastPresent = presentRuns[presentRuns.length - 1];
    const runIds = observations.map(observation => observation.runId);
    const latestSnapshot = ordered[ordered.length - 1]?.snapshot ?? null;

    findings.push({
      key,
      family: repository?.family ?? "",
      page: repository?.page ?? observations[0]!.page,
      code: repository?.code ?? presentObservations[0]?.code ?? "",
      domain: repository?.domain ?? "",
      severity: repository?.severity ?? presentObservations[0]?.severity ?? "",
      title: repository?.title ?? presentObservations[0]?.title ?? "",
      lifecycle: lifecycle.state,
      confidence,
      confidenceReason,
      runIds,
      runsObserved: presentRuns.length,
      runsAbsent: absentRunIds.length,
      firstSeenRunId: firstPresent?.runId ?? null,
      lastSeenRunId: lastPresent?.runId ?? null,
      firstSeenAt: firstPresent ? timestampOf(findOrderStamp(ordered, firstPresent.runId)) : null,
      lastSeenAt: lastPresent ? timestampOf(findOrderStamp(ordered, lastPresent.runId)) : null,
      latestDisposition,
      latestVerdict: lastObservation.verdict,
      latestDiscoveryVariance: lastObservation.discoveryVariance,
      reproducedRunIds,
      clearedRunIds,
      absentRunIds,
      contradictions,
      relatedCandidates: relatedCandidatesOf(latestSnapshot, records.map(record => record?.findingId ?? null)),
      evidence: observations,
      reviewNote: lifecycle.reviewNote,
    });
  }
  return findings;
}

function observedCountOf(presence: Presence): number {
  return presence.filter(Boolean).length;
}

function findOrderStamp(ordered: OrderedRun[], runId: string): string | null {
  return ordered.find(item => item.record.runId === runId)?.order.stamp ?? null;
}

const timestampOf = (stamp: string | null): string | null => stamp;