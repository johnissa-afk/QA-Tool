// ---------------------------------------------------------------------------
// Phase 7B — historical investigation queue.
//
// Only evidence-backed kinds are ever queued (INSUFFICIENT_EVIDENCE and
// INFORMATIONAL items are never queued, mirroring Phase 6). Priority reuses
// the Phase 6 principle: identify EXPLAINABLE factors, then derive an honest
// P1/P2/P3 per entry with a plain-language `priorityReason`. There is NO global
// quality/health score — the queue is a ranked list of specific things to look
// at, nothing more.
//
// Factors (all evidence-derived, never invented):
//   - high severity (HIGH / CRITICAL)
//   - repeatedly reproduced (finding reproduced in >= 2 runs, flow failed in
//     >= 2 runs, infrastructure present in >= 2 runs, coverage gap in >= 2 runs)
//   - recurring in time (signal spans >= 3 runs)
//
// Priority mapping (documented):
//   - P1 — a high-severity, reproduced, recurring signal.
//   - P2 — a high-severity signal that is reproduced but not yet recurring, or
//          a reproduced recurring signal that is not high-severity.
//   - P3 — every other queued signal (single-signal gaps and infrastructure).
// ---------------------------------------------------------------------------
import type {
  CoverageTrendRecord,
  FlowStabilityRecord,
  HistoricalFinding,
  HistoricalInvPriority,
  HistoricalQueueEntry,
  HistoricalQueueKind,
  RecurringInfrastructure,
} from "./types.js";

const HIGH_SEVERITY = new Set(["HIGH", "CRITICAL"]);

function entryOf(
  kind: HistoricalQueueKind,
  identifier: string,
  title: string,
  runIds: string[],
  factors: string[],
  confidence: HistoricalQueueEntry["confidence"],
): HistoricalQueueEntry {
  const highSeverity = factors.includes("high severity");
  const reproduced = factors.includes("reproduced in multiple runs");
  const recurring = factors.includes("recurring across runs");
  const priority: HistoricalInvPriority = highSeverity && reproduced && recurring ? "P1" : reproduced && recurring ? "P2" : highSeverity ? "P2" : "P3";
  return {
    entryId: "",
    kind,
    priority,
    priorityReason: `Priority ${priority}: ${factors.join(", ")}.`,
    title,
    identifier,
    runIds,
    confidence,
  };
}

let entryCounter = 0;
export function resetEntryCounter(): void {
  entryCounter = 0;
}

export function buildHistoricalInvQueue(
  findings: HistoricalFinding[],
  flows: FlowStabilityRecord[],
  coverage: CoverageTrendRecord[],
  infrastructure: RecurringInfrastructure[],
): HistoricalQueueEntry[] {
  const queue: HistoricalQueueEntry[] = [];

  for (const finding of findings) {
    if (finding.confidence === "INSUFFICIENT") continue;
    const highSeverity = HIGH_SEVERITY.has(finding.severity);
    const reproduced = finding.reproducedRunIds.length >= 2;
    const recurring = finding.runIds.length >= 3;
    const factors: string[] = [];
    if (highSeverity) factors.push("high severity");
    if (reproduced) factors.push("reproduced in multiple runs");
    if (recurring) factors.push("recurring across runs");

    const kind: HistoricalQueueKind | null =
      finding.lifecycle === "REAPPEARED" ? "REAPPEARED_HIGH_SEVERITY"
        : finding.lifecycle === "PERSISTING" ? "PERSISTENT_HIGH_SEVERITY"
        : finding.lifecycle === "INTERMITTENT" ? "INTERMITTENT_HIGH_SEVERITY"
        : null;
    if (kind && highSeverity) {
      queue.push(entryOf(kind, finding.key, finding.title || `${finding.code} on ${finding.page}`, finding.runIds, factors, finding.confidence));
    }
  }

  for (const flow of flows) {
    if (flow.confidence === "INSUFFICIENT") continue;
    if (flow.failureRunIds.length >= 2) {
      const factors: string[] = [];
      factors.push("reproduced in multiple runs");
      if (flow.failureRunIds.length >= 3) factors.push("recurring across runs");
      queue.push(entryOf("RECURRING_FLOW_FAILURE", flow.familyKey, flow.title || flow.familyKey, flow.failureRunIds, factors, flow.confidence));
    }
  }

  for (const record of infrastructure) {
    if (record.count >= 2) {
      const factors: string[] = [];
      factors.push("reproduced in multiple runs");
      if (record.count >= 3) factors.push("recurring across runs");
      queue.push(entryOf("RECURRING_INFRASTRUCTURE", record.infrastructureId, "recurring infrastructure problems", record.runIds, factors, record.confidence));
    }
  }

  for (const record of coverage) {
    if (record.confidence === "INSUFFICIENT") continue;
    if (record.trend === "PERSISTENTLY_UNTESTED" && record.runIds.length >= 2) {
      const factors: string[] = [];
      factors.push("reproduced in multiple runs");
      if (record.runIds.length >= 3) factors.push("recurring across runs");
      queue.push(entryOf("PERSISTENT_COVERAGE_GAP", record.semanticKey, record.name || record.semanticKey, record.runIds, factors, record.confidence));
    }
  }

  queue.sort((a, b) => {
    const priorityOrder: Record<HistoricalInvPriority, number> = { P1: 0, P2: 1, P3: 2 };
    const diff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (diff !== 0) return diff;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
  return queue.map(entry => ({ ...entry, entryId: `HIQ-${String(++entryCounter).padStart(3, "0")}` }));
}