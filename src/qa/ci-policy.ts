// ---------------------------------------------------------------------------
// Phase 8C — CI exit policy.
//
// Pure, deterministic logic that maps the existing unified QA result to a
// process exit code. It consumes the *existing* status model — the analysis
// derives `overallStatus` as `"PASS" | "REVIEW" | "FAIL" | "NOT_TESTED" | "BLOCKED"`
// (critical > 0 → FAIL, high > 0 → REVIEW, no verification run → NOT_TESTED,
// access blocked → BLOCKED, else PASS) — and never invents new statuses.
//
// Exit codes (documented in README + CLI help):
//   0  acceptable result — QA status is within the configured failure policy
//   1  QA policy failure — the unified QA status reached/exceeded --fail-on
//   2  infrastructure/runtime/tooling failure (never returned here; it maps
//      to the CLI error path for pipeline exceptions, bad usage, missing
//      dependencies, etc.)
//
// The module has no side effects and no process.exit() calls — the CLI only
// applies the returned code.
// ---------------------------------------------------------------------------

/** A QA overall status, as produced by the existing analysis. */
export type QaOverallStatus = "PASS" | "REVIEW" | "FAIL" | "NOT_TESTED" | "BLOCKED";

/** Accepted --fail-on policies (lowercase), matching the QA overall statuses. */
export type CiFailPolicy = "review" | "failed";

export const CI_EXIT_SUCCESS = 0;
export const CI_EXIT_POLICY_FAILURE = 1;
export const CI_EXIT_INFRASTRUCTURE = 2;

/** Default policy when `--ci` is used without `--fail-on`. */
export const CI_DEFAULT_FAIL_POLICY: CiFailPolicy = "failed";

/** Severity rank of QA statuses: PASS < NOT_TESTED < REVIEW < FAIL < BLOCKED. */
export const QA_STATUS_RANK: Record<QaOverallStatus, number> = { PASS: 0, NOT_TESTED: 1, REVIEW: 2, FAIL: 3, BLOCKED: 4 };

/** Severity rank of fail-on policies: review < failed. */
export const CI_POLICY_RANK: Record<CiFailPolicy, number> = { review: 1, failed: 2 };

/** All valid --fail-on values for help/validation output. */
export const CI_FAIL_POLICIES: readonly CiFailPolicy[] = ["review", "failed"];

/**
 * Parses a --fail-on value. Throws a clear error on anything invalid — it
 * never silently falls back to another policy.
 */
export function parseCiFailPolicy(value: string): CiFailPolicy {
  const normalized = value.trim().toLowerCase();
  for (const policy of CI_FAIL_POLICIES) {
    if (normalized === policy) return policy;
  }
  throw new Error(`Invalid --fail-on policy "${value}". Valid policies: ${CI_FAIL_POLICIES.join(" | ")}.`);
}

/**
 * Decides the exit code for a completed QA run.
 *
 * The failure threshold is per-policy, matching the Phase 8C table:
 *   --fail-on review  → REVIEW, FAIL, BLOCKED fail CI (PASS, NOT_TESTED pass)
 *   --fail-on failed  → FAIL, BLOCKED fail CI (PASS, REVIEW, NOT_TESTED pass)
 *
 * Returns CI_EXIT_SUCCESS (0) or CI_EXIT_POLICY_FAILURE (1). Infrastructure
 * failures (exit 2) are only ever the CLI error path, never a policy outcome.
 */
export function evaluateCiExit(status: QaOverallStatus, policy: CiFailPolicy): number {
  const statusRank = QA_STATUS_RANK[status] ?? -1;
  if (statusRank < 0) return CI_EXIT_SUCCESS;
  // NOT_TESTED is never a policy failure — it means no testing occurred.
  if (status === "NOT_TESTED") return CI_EXIT_SUCCESS;
  const threshold = policy === "review" ? QA_STATUS_RANK.REVIEW : QA_STATUS_RANK.FAIL;
  return statusRank >= threshold ? CI_EXIT_POLICY_FAILURE : CI_EXIT_SUCCESS;
}

/** A completed CI exit decision (0 or 1) with a human-readable summary. */
export type CiExitDecision = {
  code: number;
  status: QaOverallStatus;
  policy: CiFailPolicy;
  failed: boolean;
};

/** Applies the unified result + configured policy and produces the decision. */
export function decideCiExit(status: QaOverallStatus, policy: CiFailPolicy): CiExitDecision {
  const code = evaluateCiExit(status, policy);
  return { code, status, policy, failed: code === CI_EXIT_POLICY_FAILURE };
}

/** Human-readable one-line rendering of a decision. */
export function formatCiExit(decision: CiExitDecision): string {
  const outcome = decision.failed ? "QA policy failure" : "acceptable";
  return `CI: ${decision.status} vs --fail-on ${decision.policy} → exit ${decision.code} (${outcome}).`;
}