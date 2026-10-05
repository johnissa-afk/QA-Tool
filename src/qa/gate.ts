// ---------------------------------------------------------------------------
// Phase 9 — baseline regression gate.
//
// A deterministic, evidence-only gate for CI: given a run's regression map
// (Phase 5C) and its findings, decide whether the run INTRODUCED regressions
// against the baseline. It reuses the existing compareRuns classifications —
// it never re-analyzes, re-scores, or invents reasons. Only two classifications
// on FINDING changes can fail the gate:
//
//   - NEW        a finding present now and absent from the baseline
//                (gated only when its severity meets minSeverity)
//   - REGRESSION a previously verified condition is now broken
//                (gated regardless of severity — it is already a verified
//                 negative change)
//
// Everything else (FIXED, UNCHANGED, CHANGED, REVIEW_REQUIRED, flows,
// coverage, recommendations, infrastructure problems) is never a gate
// violation. The module is pure: no side effects, no process.exit, no I/O.
// ---------------------------------------------------------------------------
import type { Severity } from "../ai/types.js";
import type { RegressionMap } from "../regression/types.js";

/** Accepted `ci.gateMinSeverity` values; NEW findings below this never fail. */
export const GATE_MIN_SEVERITIES = ["HIGH", "CRITICAL"] as const;
export type GateMinSeverity = (typeof GATE_MIN_SEVERITIES)[number];
export const GATE_DEFAULT_MIN_SEVERITY: GateMinSeverity = "HIGH";

/** Numerical severity ordering across the full severity axis. */
const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export type GateInput = {
  /** The run's Phase 5C regression map, or null when no baseline was compared. */
  regression: RegressionMap | null;
  /** The run's findings (id + severity) used to resolve NEW finding severities. */
  findings: { id: string; severity: Severity }[];
};

export type GateViolation = {
  changeId: string;
  classification: "NEW" | "REGRESSION";
  /** Current-run finding id when the change references one, else null. */
  findingId: string | null;
  /** Severity when resolvable for the current finding, else null. */
  severity: Severity | null;
  /** Stable touchstone (code + page) carried over from the change. */
  anchor: string;
  summary: string;
  evidence: string[];
  recommendedAction: string;
};

export type GateVerdict = {
  /** The gate is active when the regression comparison is available. */
  enabled: boolean;
  minSeverity: GateMinSeverity;
  failed: boolean;
  violations: GateViolation[];
  /** Number of FINDING NEW/REGRESSION changes the gate considered. */
  evaluated: number;
  /** NEW finding changes that did not meet minSeverity (informational). */
  newBelowThreshold: number;
};

/** Parses/validates a gate severity value, mirroring the `--fail-on` contract. */
export function parseGateMinSeverity(value: unknown): GateMinSeverity {
  if (typeof value !== "string") {
    throw new Error(`Invalid gate severity ${JSON.stringify(value)} — must be one of ${GATE_MIN_SEVERITIES.join(" | ")}.`);
  }
  const normalized = value.trim().toUpperCase() as GateMinSeverity;
  if (!GATE_MIN_SEVERITIES.includes(normalized)) {
    throw new Error(`Invalid gate severity ${JSON.stringify(value)} — must be one of ${GATE_MIN_SEVERITIES.join(" | ")}.`);
  }
  return normalized;
}

const findingIdOf = (change: { currentReference: string; relatedFindingIds: string[] }): string | null => {
  if (change.currentReference && change.currentReference !== "(none)") return change.currentReference;
  return change.relatedFindingIds.length > 0 ? change.relatedFindingIds[change.relatedFindingIds.length - 1]! : null;
};

/**
 * Evaluates the baseline regression gate for a run. With no regression
 * comparison the gate is inactive (never fails) — gating in CI requires a
 * `--baseline` comparison, exactly like 8C requires an explicit policy.
 */
export function evaluateGate(input: GateInput, options: { minSeverity?: GateMinSeverity } = {}): GateVerdict {
  const minSeverity = options.minSeverity ?? GATE_DEFAULT_MIN_SEVERITY;
  const regression = input.regression;
  if (!regression) {
    return { enabled: false, minSeverity, failed: false, violations: [], evaluated: 0, newBelowThreshold: 0 };
  }
  const severityById = new Map(input.findings.map((finding) => [finding.id, finding.severity]));
  const violations: GateViolation[] = [];
  let evaluated = 0;
  let newBelowThreshold = 0;

  for (const change of regression.changes) {
    if (change.category !== "FINDING") continue;
    if (change.classification !== "NEW" && change.classification !== "REGRESSION") continue;
    evaluated += 1;
    const findingId = findingIdOf(change);
    const severity = findingId ? severityById.get(findingId) ?? null : null;

    if (change.classification === "REGRESSION") {
      violations.push({
        changeId: change.changeId,
        classification: "REGRESSION",
        findingId,
        severity,
        anchor: change.anchor,
        summary: change.summary,
        evidence: change.evidence,
        recommendedAction: change.recommendedAction,
      });
      continue;
    }

    // NEW: only a finding that meets the severity threshold fails the gate.
    if (severity && SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity]) {
      violations.push({
        changeId: change.changeId,
        classification: "NEW",
        findingId,
        severity,
        anchor: change.anchor,
        summary: change.summary,
        evidence: change.evidence,
        recommendedAction: change.recommendedAction,
      });
    } else {
      newBelowThreshold += 1;
    }
  }

  return {
    enabled: true,
    minSeverity,
    failed: violations.length > 0,
    violations,
    evaluated,
    newBelowThreshold,
  };
}

/** Deterministic console rendering of the gate verdict. */
export function formatGateVerdict(verdict: GateVerdict): string {
  if (!verdict.enabled) {
    return "GATE: inactive (no baseline comparison — add --baseline to gate CI on regressions)";
  }
  const lines = [
    `GATE (fail on new findings ≥ ${verdict.minSeverity} or a verified finding regression)`,
    `Result: ${verdict.failed ? "FAIL" : "OK"} — ${verdict.violations.length} violation(s) · ${verdict.evaluated} compared`,
  ];
  if (verdict.newBelowThreshold > 0) {
    lines.push(`  ${verdict.newBelowThreshold} NEW finding(s) below the ${verdict.minSeverity} threshold are not gate failures`);
  }
  for (const violation of verdict.violations) {
    lines.push(`  - ${violation.classification}${violation.severity ? ` (${violation.severity})` : ""} · ${violation.findingId ?? violation.anchor}: ${violation.summary}`);
  }
  return lines.join("\n");
}