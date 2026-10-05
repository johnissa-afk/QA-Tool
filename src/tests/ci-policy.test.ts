import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CI_DEFAULT_FAIL_POLICY,
  CI_EXIT_INFRASTRUCTURE,
  CI_EXIT_POLICY_FAILURE,
  CI_EXIT_SUCCESS,
  CI_FAIL_POLICIES,
  decideCiExit,
  evaluateCiExit,
  formatCiExit,
  parseCiFailPolicy,
} from "../qa/ci-policy.js";
import { help, parseArgs } from "../qa-cli.js";

// --- exit-code model ---------------------------------------------------------

test("exit codes use the documented 0/1/2 model", () => {
  assert.equal(CI_EXIT_SUCCESS, 0);
  assert.equal(CI_EXIT_POLICY_FAILURE, 1);
  assert.equal(CI_EXIT_INFRASTRUCTURE, 2);
  assert.equal(new Set([CI_EXIT_SUCCESS, CI_EXIT_POLICY_FAILURE, CI_EXIT_INFRASTRUCTURE]).size, 3);
});

// --- policy logic matrix (spec §12) ------------------------------------------

test("PASS with --fail-on review is acceptable (exit 0)", () => {
  assert.equal(evaluateCiExit("PASS", "review"), CI_EXIT_SUCCESS);
});

test("REVIEW with --fail-on review is a QA policy failure (exit 1)", () => {
  assert.equal(evaluateCiExit("REVIEW", "review"), CI_EXIT_POLICY_FAILURE);
});

test("FAIL with --fail-on review is a QA policy failure (exit 1)", () => {
  assert.equal(evaluateCiExit("FAIL", "review"), CI_EXIT_POLICY_FAILURE);
});

test("PASS with --fail-on failed is acceptable (exit 0)", () => {
  assert.equal(evaluateCiExit("PASS", "failed"), CI_EXIT_SUCCESS);
});

test("REVIEW with --fail-on failed is acceptable (exit 0)", () => {
  assert.equal(evaluateCiExit("REVIEW", "failed"), CI_EXIT_SUCCESS);
});

test("FAIL with --fail-on failed is a QA policy failure (exit 1)", () => {
  assert.equal(evaluateCiExit("FAIL", "failed"), CI_EXIT_POLICY_FAILURE);
});

test("the policy never returns the infrastructure code (2) for a completed run", () => {
  for (const status of ["PASS", "REVIEW", "FAIL"] as const) {
    for (const policy of CI_FAIL_POLICIES) {
      const code = evaluateCiExit(status, policy);
      assert.ok(code === CI_EXIT_SUCCESS || code === CI_EXIT_POLICY_FAILURE, `${status}/${policy} must be 0 or 1, got ${code}`);
    }
  }
});

// --- expected skips are not infrastructure failures (spec §6) ----------------

test("expected skips (no baseline, no history, optional phases) are part of a completed result and never fail CI by themselves", () => {
  // The real status model has no SKIPPED/INFRASTRUCTURE status: a run that
  // skipped optional stages still reports PASS/REVIEW/FAIL. With the default
  // policy a clean PASS stays acceptable regardless of which stages were skipped.
  assert.equal(decideCiExit("PASS", CI_DEFAULT_FAIL_POLICY).failed, false);
  assert.equal(decideCiExit("PASS", CI_DEFAULT_FAIL_POLICY).code, CI_EXIT_SUCCESS);
});

// --- decision + rendering ----------------------------------------------------

test("decideCiExit reports the code, status, policy, and failed flag", () => {
  const failing = decideCiExit("FAIL", "review");
  assert.deepEqual(failing, { code: CI_EXIT_POLICY_FAILURE, status: "FAIL", policy: "review", failed: true });
  const passing = decideCiExit("REVIEW", "failed");
  assert.deepEqual(passing, { code: CI_EXIT_SUCCESS, status: "REVIEW", policy: "failed", failed: false });
  assert.equal(formatCiExit(failing), "CI: FAIL vs --fail-on review → exit 1 (QA policy failure).");
  assert.equal(formatCiExit(passing), "CI: REVIEW vs --fail-on failed → exit 0 (acceptable).");
});

// --- policy parsing / validation (spec §10) ----------------------------------

test("parseCiFailPolicy accepts the documented policies and is case-insensitive", () => {
  assert.equal(parseCiFailPolicy("review"), "review");
  assert.equal(parseCiFailPolicy("failed"), "failed");
  assert.equal(parseCiFailPolicy("REVIEW"), "review");
  assert.equal(parseCiFailPolicy("  Failed "), "failed");
});

test("parseCiFailPolicy rejects unknown values instead of falling back", () => {
  for (const invalid of ["invalid", "pass", "critical", "", "revi ew"]) {
    assert.throws(() => parseCiFailPolicy(invalid), /Invalid --fail-on policy/, `"${invalid}" must be rejected`);
  }
});

test("the default policy is 'failed' (fail only on critical findings)", () => {
  assert.equal(CI_DEFAULT_FAIL_POLICY, "failed");
  assert.deepEqual([...CI_FAIL_POLICIES], ["review", "failed"]);
});

// --- CLI argument wiring (spec §10 / §11) ------------------------------------

test("--ci enables CI mode with the default policy", () => {
  const options = parseArgs(["https://qa.test/en", "--crawl", "--execute", "--ci"]);
  assert.equal(options?.ci, true);
  assert.equal(options?.failOn, null);
});

test("--fail-on review implies CI mode and selects the review threshold", () => {
  const options = parseArgs(["https://qa.test/en", "--fail-on", "review"]);
  assert.equal(options?.ci, true);
  assert.equal(options?.failOn, "review");
});

test("--fail-on failed implies CI mode and selects the failed threshold", () => {
  const options = parseArgs(["https://qa.test/en", "--fail-on", "failed"]);
  assert.equal(options?.ci, true);
  assert.equal(options?.failOn, "failed");
});

test("--ci --fail-on review parses both flags and never mistakes the policy for a URL", () => {
  const options = parseArgs(["https://qa.test/en", "--crawl", "--execute", "--ci", "--fail-on", "review"]);
  assert.equal(options?.url, "https://qa.test/en");
  assert.equal(options?.ci, true);
  assert.equal(options?.failOn, "review");
});

test("an invalid --fail-on value fails loudly through parseArgs", () => {
  assert.throws(() => parseArgs(["https://qa.test/en", "--ci", "--fail-on", "invalid"]), /Invalid --fail-on policy/);
});

test("--fail-on without a value fails loudly instead of silently defaulting", () => {
  assert.throws(() => parseArgs(["https://qa.test/en", "--ci", "--fail-on"]), /--fail-on requires a value/);
  assert.throws(() => parseArgs(["https://qa.test/en", "--fail-on", "--crawl"]), /--fail-on requires a value/);
});

test("normal local runs keep CI mode off (pre-8C behavior preserved)", () => {
  const options = parseArgs(["https://qa.test/en", "--crawl", "--execute"]);
  assert.equal(options?.ci, false);
  assert.equal(options?.failOn, null);
});

test("help documents --ci, --fail-on, and the exit codes", () => {
  assert.ok(help.includes("--ci"));
  assert.ok(help.includes("--fail-on"));
  assert.ok(help.includes("infrastructure/runtime/tooling failure"));
  assert.ok(help.includes("--fail-on <status>"));
});