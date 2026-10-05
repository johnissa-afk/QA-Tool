// ---------------------------------------------------------------------------
// Phase 7B — run ordering + semantic identity maps.
//
// Historical claims are only as good as the ORDER the runs are read in. Runs
// are ordered by the persisted `completedAt`, tie-broken by `runId` — never by
// filesystem order, JSON property order, insertion order, or generated ids.
// Runs whose persisted timestamp is missing or not a valid ISO timestamp cannot
// take part in pattern claims (they are counted and reported as ordering-
// unusable, never silently dropped and never guessed).
//
// Identity maps rebuild the same semantic vocabulary the run artifacts already
// carry (finding semanticKey/family, flow familyKey/signature, coverage
// semanticKey) so matching across runs rides on ONE identity system.
// ---------------------------------------------------------------------------
import { readRunSnapshot } from "../history/index.js";
import type {
  FindingHistorySnapshot,
  FlowHistorySnapshot,
  CoverageHistorySnapshot,
  HistoryRunSnapshot,
  QaRunRecord,
} from "../history/index.js";
import { normalizePageUrl } from "../regression/identity.js";

/** Bounded loading: only this many most-recent runs are ever analyzed, so the
 *  memory/cpu cost stays flat no matter how large the site history grows. */
export const HISTORY_MAX_RUNS = 50;

const isValidIso = (value: string): boolean => !Number.isNaN(new Date(value).getTime());

/** Per-run ordering key: completedAt is authoritative, runId breaks ties. */
export type RunOrderKey = {
  valid: boolean;
  stamp: string;
  reason: string | null;
};

export function runOrderKey(record: QaRunRecord): RunOrderKey {
  const completedAt = typeof record.completedAt === "string" && record.completedAt.trim() ? record.completedAt : null;
  if (!completedAt) {
    return { valid: false, stamp: typeof record.startedAt === "string" ? record.startedAt : record.runId, reason: "run has no persisted completedAt — ordering unavailable" };
  }
  if (!isValidIso(completedAt)) {
    return { valid: false, stamp: typeof record.startedAt === "string" ? record.startedAt : record.runId, reason: "run completedAt is not a valid ISO timestamp — ordering unavailable" };
  }
  return { valid: true, stamp: completedAt, reason: null };
}

export type OrderedRun = {
  record: QaRunRecord;
  snapshot: HistoryRunSnapshot;
  order: RunOrderKey;
};

/** Order the run records by completedAt (then runId), reading each snapshot
 *  from the given history directory. Returns ordered (valid timestamp) and
 *  unordered (unusable ordering) runs. Reading is bounded to the `maxRuns`
 *  most recent runs, and unreadable artifacts are excluded from analysis. */
export function loadOrderedRuns(
  runs: QaRunRecord[],
  historyDir: string,
  maxRuns: number = HISTORY_MAX_RUNS,
  readSnapshot: (historyDir: string, runId: string) => HistoryRunSnapshot | null = readRunSnapshot,
): { ordered: OrderedRun[]; unordered: OrderedRun[] } {
  const keyed: { record: QaRunRecord; snapshot: HistoryRunSnapshot | null; order: RunOrderKey }[] = runs.map(record => {
    const order = runOrderKey(record);
    const snapshot = readSnapshot(historyDir, record.runId);
    return { record, snapshot, order };
  });

  const withSnapshot = keyed.filter(item => item.snapshot !== null) as {
    record: QaRunRecord;
    snapshot: HistoryRunSnapshot;
    order: RunOrderKey;
  }[];

  const all = withSnapshot.map(item => ({ ...item, order: item.order }));
  const valid = all.filter(item => item.order.valid);
  const invalid = all.filter(item => !item.order.valid);
  valid.sort((a, b) => {
    const diff = a.order.stamp < b.order.stamp ? -1 : a.order.stamp > b.order.stamp ? 1 : 0;
    if (diff !== 0) return diff;
    return a.record.runId < b.record.runId ? -1 : a.record.runId > b.record.runId ? 1 : 0;
  });
  invalid.sort((a, b) => (a.order.stamp < b.order.stamp ? -1 : a.order.stamp > b.order.stamp ? 1 : 0));

  // Bounded: analyze only the maxRuns most recent ordered runs.
  const recent = valid.slice(-Math.max(1, maxRuns));
  return {
    ordered: recent.map(item => ({ record: item.record, snapshot: item.snapshot, order: item.order })),
    unordered: invalid.map(item => ({ record: item.record, snapshot: item.snapshot, order: item.order })),
  };
}

// ---------------------------------------------------------------------------
// Per-run semantic identity maps (ONE vocabulary — the persisted keys).
// ---------------------------------------------------------------------------
export type RunIdentityMaps = {
  findingByKey: Map<string, FindingHistorySnapshot>;
  findingByFamily: Map<string, FindingHistorySnapshot[]>;
  flowsByFamily: Map<string, FlowHistorySnapshot>;
  flowsById: Map<string, FlowHistorySnapshot>;
  coverageByKey: Map<string, CoverageHistorySnapshot>;
  /** Run-local finding id -> coverage items that explicitly relate to it. */
  coverageByFinding: Map<string, CoverageHistorySnapshot[]>;
  /** Run-local flow id -> coverage items that reference it. */
  coverageByFlow: Map<string, CoverageHistorySnapshot[]>;
};

export function identityMapsOf(snapshot: HistoryRunSnapshot): RunIdentityMaps {
  const findingByKey = new Map<string, FindingHistorySnapshot>();
  const findingByFamily = new Map<string, FindingHistorySnapshot[]>();
  for (const finding of snapshot.findings) {
    findingByKey.set(finding.semanticKey, finding);
    const family = findingByFamily.get(finding.family) ?? [];
    family.push(finding);
    findingByFamily.set(finding.family, family);
  }
  const flowsByFamily = new Map<string, FlowHistorySnapshot>();
  const flowsById = new Map<string, FlowHistorySnapshot>();
  for (const flow of snapshot.flows) {
    flowsByFamily.set(flow.familyKey, flow);
    flowsById.set(flow.flowId, flow);
  }
  const coverageByKey = new Map<string, CoverageHistorySnapshot>();
  const coverageByFinding = new Map<string, CoverageHistorySnapshot[]>();
  const coverageByFlow = new Map<string, CoverageHistorySnapshot[]>();
  for (const item of snapshot.coverage) {
    coverageByKey.set(item.semanticKey, item);
    for (const findingId of item.relatedFindings) {
      const list = coverageByFinding.get(findingId) ?? [];
      list.push(item);
      coverageByFinding.set(findingId, list);
    }
    for (const flowId of item.relatedFlows) {
      const list = coverageByFlow.get(flowId) ?? [];
      list.push(item);
      coverageByFlow.set(flowId, list);
    }
  }
  return { findingByKey, findingByFamily, flowsByFamily, flowsById, coverageByKey, coverageByFinding, coverageByFlow };
}

// ---------------------------------------------------------------------------
// Coverage-aware helpers.
// ---------------------------------------------------------------------------
const TESTED_STATUSES = new Set(["TESTED", "PARTIALLY_TESTED"]);

export const meaningfullyTested = (status: string | null): boolean =>
  status !== null && TESTED_STATUSES.has(status);

/** Coverage status on a normalized page (any category) — used to decide whether
 *  an ABSENT finding's area was meaningfully exercised. Prefers an exercised
 *  (TESTED/PARTIALLY_TESTED) status so the answer is deterministic. */
export function pageCoverageStatus(maps: RunIdentityMaps, page: string): string | null {
  const normalized = normalizePageUrl(page);
  const candidates = [...maps.coverageByKey.values()].filter(item => item.url && normalizePageUrl(item.url) === normalized);
  if (!candidates.length) return null;
  const exercised = candidates.find(item => TESTED_STATUSES.has(item.status));
  if (exercised) return exercised.status;
  return [...candidates].sort((a, b) => (a.semanticKey < b.semanticKey ? -1 : a.semanticKey > b.semanticKey ? 1 : 0))[0]!.status;
}

/** The most relevant coverage status for a finding record in one run: prefer an
 *  item explicitly related through `relatedFindings`, then any item on the same
 *  normalized page. Returns null when no coverage evidence exists. When multiple
 *  candidates exist, an explicitly exercised (TESTED/PARTIALLY_TESTED) status
 *  wins so the answer is deterministic. */
export function relationCoverageStatus(
  snapshotMaps: RunIdentityMaps,
  finding: FindingHistorySnapshot,
): string | null {
  const related = snapshotMaps.coverageByFinding.get(finding.findingId) ?? [];
  if (related.length) {
    const exercised = related.find(item => TESTED_STATUSES.has(item.status));
    if (exercised) return exercised.status;
    return [...related].sort((a, b) => (a.semanticKey < b.semanticKey ? -1 : a.semanticKey > b.semanticKey ? 1 : 0))[0]!.status;
  }
  return pageCoverageStatus(snapshotMaps, finding.page);
}