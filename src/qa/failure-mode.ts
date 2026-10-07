// ---------------------------------------------------------------------------
// Phase 11C — the failure-mode matrix as an executable model.
//
// One pure, deterministic classification of EVERY way a QA/CI run can end, so
// the exit code, the machine-readable "Failure mode:" line, the tests, and the
// README all agree. It is a thin, additive layer over the existing decision
// stack — it adds no pipeline, no policy engine, and no baseline system:
//
//   exit 0  = success                          (Phase 11A contract)
//   exit 1  = policy / gate / rotation         (Phase 8C / 9 / 10D)
//   exit 2  = configuration / baseline-verification / infrastructure
//             (the pre-existing hard-failure paths; never collapsed into 1)
//
// Category names mirror the architecture: "policy" is the Phase 8C status
// policy (overallStatus vs --fail-on), "gate" is the Phase 9 baseline
// regression gate (computes the milestone's "regression" bucket — a NEW at/above
// the threshold or a verified REGRESSION surfaces here), and "rotation" is the
// Phase 10D rotation policy. Configuration errors preserve their established
// exit behavior (1 in a normal run, 2 in CI mode); every other hard failure is
// 2 under the CI contract.
//
// Precedence (deterministic, first match wins) — verified by the matrix tests:
//   1. infrastructure          -> 2   a runtime failure is never masked
//   2. configuration           -> 1 / 2 (CI)
//   3. baseline-verification   -> 2   never converted into a gate/regression
//   4. gate (enabled + failed) -> 1   the most specific regression signal
//   5. policy (CI status)      -> 1
//   6. rotation (stale)        -> 1
//   7. success                 -> 0
// ---------------------------------------------------------------------------
import { CI_EXIT_INFRASTRUCTURE, CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS } from "./ci-policy.js";

/** The stable failure categories. "policy" is the Phase 8C status decision;
 *  "gate" is the Phase 9 baseline regression gate (the project's regression
 *  decision). */
export type FailureModeCategory =
  | "success"
  | "configuration"
  | "baseline-verification"
  | "policy"
  | "gate"
  | "rotation"
  | "infrastructure";

/** The full classification of a run outcome. `continued`/`producedArtifact`
 *  describe whether the pipeline reaches completion and writes the report
 *  artifacts — for the hard-failure categories they are always NO (those runs
 *  abort before writeQaReport). */
export type FailureModeVerdict = {
  category: FailureModeCategory;
  exitCode: number;
  /** The pipeline continued past the decision point to a completed run. */
  continued: boolean;
  /** The run still produced its report artifacts (JSON/HTML). */
  producedArtifact: boolean;
};

/** Structural inputs — the exact objects the CLI already computes:
 *  `decision` from Phase 8C decideCiExit, `gate` from Phase 9 evaluateGate,
 *  `rotationFailed` from the Phase 10D rotation verdict, plus the hard-failure
 *  signals that abort the run (config / baseline / infrastructure). */
export type RunOutcomeInput = {
  decision: { failed: boolean };
  gate: { enabled: boolean; failed: boolean };
  rotationFailed: boolean;
  /** A configuration/usage error aborted the run before (or during) the pipeline. */
  configurationFailed?: boolean;
  /** Baseline loading/verification failed (missing/malformed/invalid/tampered). */
  baselineVerificationFailed?: boolean;
  /** Any other hard runtime/infrastructure failure. */
  infrastructureFailed?: boolean;
  /** True under `--ci`/`--fail-on`: configuration errors then abort as exit 2
   *  (the established Phase 11A behavior, preserved exactly). */
  ciMode?: boolean;
};

/** The categories a THROWN error can be — the subset reachable from the CLI's
 *  catch path. Completed-run verdicts never throw. */
export type ThrownFailureCategory = Extract<FailureModeCategory, "configuration" | "baseline-verification" | "infrastructure">;

/** Deterministic precedence order. First true condition wins, so a baseline
 *  verification failure is never converted into a gate/regression verdict, an
 *  infrastructure failure is never masked by a regression/gate/rotation result,
 *  and among the exit-1 conditions the gate is the most specific signal. */
export function classifyRunOutcome(input: RunOutcomeInput): FailureModeVerdict {
  const { decision, gate, rotationFailed } = input;

  // Hard failures — exit 2 (configuration is 1 in a normal run, 2 in CI).
  if (input.infrastructureFailed) return verdict("infrastructure", CI_EXIT_INFRASTRUCTURE, false, false);
  if (input.configurationFailed) return verdict("configuration", input.ciMode ? CI_EXIT_INFRASTRUCTURE : CI_EXIT_POLICY_FAILURE, false, false);
  if (input.baselineVerificationFailed) return verdict("baseline-verification", CI_EXIT_INFRASTRUCTURE, false, false);

  // Completed-run policy failures — exit 1.
  if (gate.enabled && gate.failed) return verdict("gate", CI_EXIT_POLICY_FAILURE, true, true);
  if (decision.failed) return verdict("policy", CI_EXIT_POLICY_FAILURE, true, true);
  if (rotationFailed) return verdict("rotation", CI_EXIT_POLICY_FAILURE, true, true);

  return verdict("success", CI_EXIT_SUCCESS, true, true);
}

const verdict = (category: FailureModeCategory, exitCode: number, continued: boolean, producedArtifact: boolean): FailureModeVerdict =>
  ({ category, exitCode, continued, producedArtifact });

/** Renders the single machine-readable classification line:
 *  `Failure mode: <category> → exit <code>.` */
export function formatFailureModeLine(category: FailureModeCategory, exitCode: number): string {
  return `Failure mode: ${category} → exit ${exitCode}.`;
}

// ---------------------------------------------------------------------------
// Thrown-error classification.
//
// The CLI's top-level catch is the only other place a run can end. Errors are
// bucketed by the same stable messages the rest of the suite already asserts
// verbatim (config errors name the file/option; baseline errors use the
// `Invalid baseline …` / `Baseline … failed digest verification` contract
// text). Anything unrecognized is infrastructure — never guessed as success.
// ---------------------------------------------------------------------------

const CONFIG_ERROR_PATTERNS: readonly RegExp[] = [
  /^Invalid qa\.config\.json:/,
  /requires a value \(a file path or argument\)/,
  /^--fail-on requires a value:/,
  /Invalid --fail-on policy/,
  /Invalid gate severity/,
  /Invalid baseline max-age/,
  /must not be the (?:loaded --baseline artifact|--write-baseline (?:target|sidecar)|--baseline artifact)/,
  /refuses to overwrite an existing baseline/,
  /requires a start URL/,
  /A URL or --report path is required/,
  /must be a positive number/,
  /--port must be an integer/,
  // Phase 13: a missing/malformed/unknown-key performance budgets file is a
  // configuration failure (1 locally, 2 with --ci) — never a silent pass and
  // never an infrastructure failure.
  /^Invalid performance budgets file/,
];

const BASELINE_ERROR_PATTERNS: readonly RegExp[] = [
  /^Invalid baseline /,
  /failed digest verification/,
  /changed after --write-baseline wrote it/,
];

/** Classifies a thrown error into the stable category for the running CLI.
 *  Order matters: "Invalid baseline max-age" is configuration, while
 *  "Invalid baseline <file>: …" is a baseline-verification failure. */
export function classifyThrownError(error: unknown): ThrownFailureCategory {
  const message = error instanceof Error ? error.message : String(error);
  for (const pattern of CONFIG_ERROR_PATTERNS) {
    if (pattern.test(message)) return "configuration";
  }
  for (const pattern of BASELINE_ERROR_PATTERNS) {
    if (pattern.test(message)) return "baseline-verification";
  }
  return "infrastructure";
}