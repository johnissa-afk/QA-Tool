// ---------------------------------------------------------------------------
// Phase 11A — the canonical CI contract.
//
// One place that names the canonical CI command and the exit-code contract,
// so the CLI, tests, and the GitHub Actions workflow all agree on what CI
// receives. It is a thin, pure layer over the existing modules — it adds no
// pipeline, no policy engine, and no baseline system.
//
// Exit codes (0/1/2 — unchanged from Phase 8C/9/10):
//
//   0  QA completed successfully; the configured CI policy is satisfied, the
//      Phase 9 gate found no NEW >= threshold / verified REGRESSION, no
//      baseline is STALE under the configured rotation policy, AND the site was
//      actually testable (no blocking access prerequisite).
//
//   1  QA completed but the result is a QA policy failure: the CI policy
//      (status threshold), the Phase 9 gate, or the Phase 10D rotation policy
//      was violated. It ALSO covers an access prerequisite that kept normal QA
//      from running — `REVIEW_REQUIRED` (access ambiguous, e.g. HTTP 404 or a
//      login/challenge page) and `BLOCKED` (access denied). Those are a
//      completed QA verdict: the website was NOT tested, so CI must fail rather
//      than report "acceptable → exit 0". The run itself still completes and
//      writes its artifacts, so it stays exit 1 and never borrows exit 2.
//
//   2  The run did not complete as a trustable QA result: baseline
//      verification/integrity failure (missing, malformed, structurally
//      invalid, or sha256-digest-mismatched artifact) or another existing
//      infrastructure/runtime/tooling failure. The offline `verify`
//      subcommand uses the same code for a non-trustworthy artifact
//      (BASELINE_VERIFY_EXIT_FAILURE). A baseline failure is NEVER collapsed
//      into the exit-1 "completed but violating" verdict.
//
// Ordering guarantee: the baseline is loaded and verified (structure always;
// sha256 integrity when the sidecar exists) BEFORE the regression comparison
// and Phase 9 gate evaluation. Any verification failure aborts to exit 2 in
// CI mode — there is no silent fallback to an unverified baseline comparison
// (legacy sidecar-less artifacts stay supported as LEGACY_NO_META, the
// established Phase 10A behavior).
//
// Precedence (Phase 8E/11): defaults < qa.config.json (baseline.path) < CLI
// (--baseline). Configuration errors keep their own behavior: they abort
// before the pipeline with a property-naming message — exit 1 in a normal
// local run, exit 2 in CI mode.
// ---------------------------------------------------------------------------
import type { AccessPrerequisite } from "../types.js";
import { CI_EXIT_INFRASTRUCTURE, CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS } from "./ci-policy.js";
import { classifyRunOutcome } from "./failure-mode.js";

/** The canonical command CI should execute. Any other flag (--report, --crawl,
 *  --fail-on, --output, …) composes as usual; the baseline comes from
 *  `baseline.path` in qa.config.json by default and `--baseline` overrides it. */
export const CANONICAL_CI_COMMAND =
  "npm run qa -- <url> --execute --ci --baseline <baseline-path> [--baseline-max-age <duration>]";

/** The inputs — kept structural so any existing verdict object can be passed:
 *  `decision` from the Phase 8C CI policy, `gate` from the Phase 9 evaluator,
 *  `rotationFailed` from the Phase 10D rotation verdict, and the access
 *  prerequisite status the scan produced (`REVIEW_REQUIRED`/`BLOCKED` means the
 *  website was never tested — a policy failure, not a runtime fault). */
export type CiContractDecisionInput = {
  decision: { failed: boolean };
  gate: { enabled: boolean; failed: boolean };
  rotationFailed: boolean;
  accessPrerequisiteStatus?: AccessPrerequisite["status"] | null;
};

/** Final CI exit code for a COMPLETED run: 0 when every policy is satisfied,
 *  1 when the policy, gate, rotation policy, or the access prerequisite fails.
 *  An access prerequisite of `REVIEW_REQUIRED` or `BLOCKED` means normal QA
 *  could not run, so the site was not tested — that is exit 1, never exit 0.
 *  It never returns 2 — 2 (infrastructure / baseline-integrity failure) is
 *  produced upstream by the top-level error handler and the baseline verifier,
 *  not by this function.
 *  Since Phase 11C this delegates to the one failure-mode classifier, so the
 *  exit code and the "Failure mode:" category always agree. */
export function decideCiContractExit(input: CiContractDecisionInput): number {
  return classifyRunOutcome({ ...input }).exitCode;
}

/** The full 0/1/2 contract as rendered text (used by help and docs). */
export const CI_CONTRACT_SUMMARY = `CI contract (Phase 11A):
  Canonical command: ${CANONICAL_CI_COMMAND}
  Exit ${CI_EXIT_SUCCESS} = QA completed; no regression/gate/policy violation; the site was testable.
  Exit ${CI_EXIT_POLICY_FAILURE} = QA completed; regression, gate, or rotation-policy violation — OR the access
           prerequisite prevented normal QA (REVIEW_REQUIRED / BLOCKED). An
           inaccessible or ambiguous target is a QA policy failure, not a clean
           run: the site was not tested, so CI must not report exit ${CI_EXIT_SUCCESS}.
  Exit ${CI_EXIT_INFRASTRUCTURE} = baseline verification/integrity failure, or infrastructure/runtime
           failure (the offline verify subcommand uses the same exit ${CI_EXIT_INFRASTRUCTURE}).
  A baseline is verified (structure always, sha256 integrity when the sidecar
  exists) BEFORE regression and gate evaluation; a verification failure aborts
  to exit ${CI_EXIT_INFRASTRUCTURE} and never falls back to an unverified comparison. --baseline
  overrides baseline.path in qa.config.json. Configuration errors abort before
  the pipeline (exit ${CI_EXIT_POLICY_FAILURE} locally, exit ${CI_EXIT_INFRASTRUCTURE} in CI mode).`;