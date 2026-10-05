// ---------------------------------------------------------------------------
// Phase 7B — coverage trends.
//
// A coverage item is identified across runs by its Phase 7A/5 coverage SEMANTIC
// key (category + location + name). Each item gets one observation per ordered
// run; when the item was not crawled that run its observation is discovery
// variance and is NEVER used as a loss claim.
//
// Trend classification (documented, deterministic):
//   - INSUFFICIENT_EVIDENCE     — fewer than 2 ordered runs, or a single
//                                 observation that is not the latest run.
//   - NEWLY_TESTED              — the item appeared only in the latest run and
//                                 was exercised (TESTED / PARTIALLY_TESTED).
//   - PERSISTENTLY_UNTESTED     — present in >= 2 runs and never exercised.
//   - COVERAGE_GAIN             — un-tested in earlier runs, exercised by the
//                                 latest run (also when absent runs sit between,
//                                 since absence is discovery variance).
//   - COVERAGE_LOSS             — exercised in earlier runs, un-tested in the
//                                 latest RUN where the item was present. Only a
//                                 status change counts — never an absence.
//   - COVERAGE_STABLE           — present in >= 2 runs, exercised every time.
//   - COVERAGE_CHANGED          — statuses vary without forming a gain/loss.
// ---------------------------------------------------------------------------
import { deriveConfidence } from "./confidence.js";
import type { CoverageHistorySnapshot } from "../history/index.js";
import { identityMapsOf, OrderedRun } from "./matching.js";
import type { CoverageTrend, CoverageTrendRecord } from "./types.js";

const EXERCISED = new Set(["TESTED", "PARTIALLY_TESTED"]);

const exercisedOf = (status: string | null): boolean => status !== null && EXERCISED.has(status);

export function classifyCoverageTrend(
  statuses: (string | null)[],
  present: boolean[],
): { trend: CoverageTrend; reason: string; reviewNote: string | null } {
  const n = statuses.length;
  const lastIndex = n - 1;
  if (n < 2 || present.every(value => !value)) {
    return { trend: "INSUFFICIENT_EVIDENCE", reason: "coverage trends need 2+ ordered runs with observations", reviewNote: null };
  }
  const firstPresent = present.indexOf(true);
  const lastPresent = present.lastIndexOf(true);
  const exercisedAt = (index: number): boolean => exercisedOf(statuses[index]);
  const everExercised = present.some((value, index) => value && exercisedAt(index));

  if (!everExercised) {
    return { trend: "PERSISTENTLY_UNTESTED", reason: "the item was present in multiple runs but never exercised", reviewNote: "this area stays un-tested across runs — a persisting coverage gap" };
  }

  if (present.filter(Boolean).length === 1) {
    if (firstPresent === lastIndex && exercisedAt(firstPresent)) {
      return { trend: "NEWLY_TESTED", reason: "the item was first exercised in the latest run", reviewNote: null };
    }
    return { trend: "INSUFFICIENT_EVIDENCE", reason: "a single observation is not enough for a coverage trend", reviewNote: null };
  }

  const firstExercised = present.findIndex((value, index) => value && exercisedAt(index));
  const lastExercised = present.reduce<number>((found, value, index) => (value && exercisedAt(index) ? index : found), -1);

  if (exercisedAt(firstPresent) && !exercisedAt(lastPresent) && lastExercised < lastPresent) {
    return { trend: "COVERAGE_LOSS", reason: "the item was exercised in earlier runs but is un-tested in the latest run where it was present", reviewNote: "previously-tested area lost its exercised status — confirm whether the execution stop is intended" };
  }
  if (!exercisedAt(firstPresent) && exercisedAt(lastPresent) && firstExercised > firstPresent) {
    return { trend: "COVERAGE_GAIN", reason: "the item was un-tested earlier but is exercised in the latest run", reviewNote: null };
  }
  if (present.every((value, index) => value && exercisedAt(index))) {
    return { trend: "COVERAGE_STABLE", reason: "the item was exercised in every run it was present", reviewNote: null };
  }
  return { trend: "COVERAGE_CHANGED", reason: "the item's status varied across runs without a monotonic gain or loss", reviewNote: null };
}

export function buildCoverageTrends(ordered: OrderedRun[]): CoverageTrendRecord[] {
  // Universe: every coverage key + enough runs to observe absence as discovery
  // variance. statuses[i] is null when the item was not crawled in run i.
  const allKeys = new Set<string>();
  for (const item of ordered) for (const coverageKey of item.snapshot.coverage) allKeys.add(coverageKey.semanticKey);

  const contextual = ordered.map(item => ({ ordered: item, maps: identityMapsOf(item.snapshot) }));
  const records: CoverageTrendRecord[] = [];

  for (const semanticKey of [...allKeys].sort()) {
    const statuses: (string | null)[] = [];
    const present: boolean[] = [];
    let latestItem: CoverageHistorySnapshot | null = null;
    for (const { maps } of contextual) {
      const item = maps.coverageByKey.get(semanticKey) ?? null;
      present.push(item !== null);
      statuses.push(item?.status ?? null);
      if (item) latestItem = item;
    }
    const classification = classifyCoverageTrend(statuses, present);
    const latestStatus = statuses[statuses.length - 1] ?? null;
    const confidence = deriveConfidence({
      orderedRunCount: ordered.length,
      observedRunCount: present.filter(Boolean).length,
      contradictions: 0,
      verified: present.some((value, index) => value && exercisedOf(statuses[index])),
      covered: present.some(Boolean),
      gapDependent: classification.trend === "INSUFFICIENT_EVIDENCE" || classification.trend === "PERSISTENTLY_UNTESTED",
    });

    records.push({
      semanticKey,
      category: latestItem?.category ?? "",
      name: latestItem?.name ?? "",
      trend: classification.trend,
      confidence: classification.trend === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT" : confidence.confidence,
      confidenceReason: `${classification.reason}. ${confidence.reason}`.trim(),
      runIds: ordered.map(item => item.record.runId),
      statuses: ordered.map((item, index) => ({ runId: item.record.runId, status: statuses[index] ?? null })),
      latestStatus,
      reviewNote: classification.reviewNote,
    });
  }
  return records;
}