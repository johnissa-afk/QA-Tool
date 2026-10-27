// ---------------------------------------------------------------------------
// Phase 11A — CI contract tests.
//
// These tests invoke the BUILT CLI exactly as CI does — spawning
// `node dist/qa-cli.js` as a child process — and assert the canonical exit-code
// contract end to end:
//
//   0 = QA completed; no regression/gate/policy violation
//   1 = QA completed; regression/gate/policy violation (incl. stale rotation)
//   2 = baseline verification/integrity failure (or infrastructure error)
//
// Baselines are published by the CLI itself (the `--write-baseline` path),
// so every "verified baseline vs current run" pair is config-identical and the
// regression/gate verdicts are real. All fixtures live in temp directories
// scoped per test — never the committed `reports/` or real baseline artifacts.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { detectIssues, groupIssues } from "../checks.js";
import type { QaAnalysis } from "../ai/types.js";
import type { DiscoveredElement, Issue, LinkResult, ScanReport } from "../types.js";
import { CANONICAL_CI_COMMAND, CI_CONTRACT_SUMMARY, decideCiContractExit } from "../qa/ci-contract.js";
import { CI_EXIT_INFRASTRUCTURE, CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS } from "../qa/ci-policy.js";

// Deterministic mode for every child run and fixture.
process.env.AI_API_KEY = "";

const CLI_PATH = join(process.cwd(), "dist", "qa-cli.js");
assert.ok(existsSync(CLI_PATH), `the built CLI is required for CI-contract tests: ${CLI_PATH}`);

const sanitizedEnv = (): Record<string, string | undefined> => ({ ...process.env, AI_API_KEY: "", QA_USERNAME: "", QA_PASSWORD: "", QA_AUTHORIZATION: "" });

/** Runs the built CLI in a fresh temp working directory. */
function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(cwd), `cwd must exist before spawn: ${cwd}`);
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    env: sanitizedEnv(),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "qa-ci-contract-"));

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const issueOf = (link: LinkResult): Issue => ({ status: link.type === "BROKEN" || link.type === "ERROR" ? "FAIL" : "WARNING", code: "unhealthy-link", message: `Broken destination ${link.url}` });

const reportOf = (elements: DiscoveredElement[], links: LinkResult[] = []): ScanReport => {
  const issues = [...detectIssues(elements, { title: "QA contract target", lang: "en", viewport: "width=device-width" }), ...links.map(issueOf)];
  const grouped = groupIssues(issues);
  const broken = links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length;
  return {
    scan: { url: "https://contract.qa.test/en", finalUrl: "https://contract.qa.test/en", title: "QA contract target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.filter(item => item.interactive).length, passes: 0, warnings: grouped.filter(issue => issue.status === "WARNING").length, failures: grouped.filter(issue => issue.status === "FAIL").length, infos: grouped.filter(issue => issue.status === "INFO").length, linksChecked: links.length, brokenLinks: broken, consoleErrors: 0, pageErrors: 0, issueGroups: grouped.length, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: links.length, buttons: elements.filter(item => item.tag === "button").length, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements, issues: grouped, links, consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
  };
};

// A clean report: no HIGH findings, nothing unavailable. A HIGH-severity report:
// a visible interactive button with no accessible name (button-missing-name).
const cleanReport = (): ScanReport => reportOf([element()]);
const highFindingReport = (): ScanReport => reportOf([element({ text: undefined, ariaLabel: null, name: null, accessibleName: null, recommendedLocator: "page.getByRole(\"button\", { name: \"?\" })" })]);

const writeReportFile = (dir: string, report: ScanReport, fileName = "report.json"): string => {
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
};

/** Publishes a VERIFIED baseline exactly how the workflow documents it — via the
 *  CLI's own `--write-baseline <path>` path — so baseline and current run share the
 *  same configuration and the regression/gate verdicts are genuine. The report is
 *  written to a separate discard path (`--output`), never over the baseline. */
const publishBaseline = (dir: string, baselinePath: string, report: ScanReport = cleanReport()): void => {
  const fixturePath = writeReportFile(dir, report, `fixture-${basename(baselinePath).replace(/\.json$/, "")}-publish.json`);
  const reportOut = join(dir, `publish-${basename(baselinePath).replace(/\.json$/, "")}-report.json`);
  const { status, stdout, stderr } = runCli([
    "--report", fixturePath,
    "--output", reportOut,
    "--history-dir", join(dir, "history-publish"),
    "--write-baseline", baselinePath, "--execute", "none",
  ], dir);
  assert.equal(status, CI_EXIT_SUCCESS, `publish failed: ${stdout}\n${stderr}`);
};

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const baseArgs = (dir: string, reportPath: string, outputName: string): string[] => [
  "--report", reportPath,
  "--output", join(dir, outputName),
  "--history-dir", join(dir, "history"),
  "--execute", "none",
];

// --- pure contract unit ------------------------------------------------------

test("the CI contract uses the canonical 0/1/2 exit codes", () => {
  assert.equal(CI_EXIT_SUCCESS, 0);
  assert.equal(CI_EXIT_POLICY_FAILURE, 1);
  assert.equal(CI_EXIT_INFRASTRUCTURE, 2);
  assert.ok(typeof CANONICAL_CI_COMMAND === "string" && CANONICAL_CI_COMMAND.includes("npm run qa --"));
  assert.ok(CI_CONTRACT_SUMMARY.includes("Exit 0"));
  assert.ok(CI_CONTRACT_SUMMARY.includes("Exit 1"));
  assert.ok(CI_CONTRACT_SUMMARY.includes("Exit 2"));
});

test("decideCiContractExit maps completed-run outcomes to 0/1 only", () => {
  const ok = { decision: { failed: false }, gate: { enabled: true, failed: false }, rotationFailed: false };
  assert.equal(decideCiContractExit(ok), CI_EXIT_SUCCESS);
  assert.equal(decideCiContractExit({ ...ok, decision: { failed: true } }), CI_EXIT_POLICY_FAILURE);
  assert.equal(decideCiContractExit({ ...ok, gate: { enabled: true, failed: true } }), CI_EXIT_POLICY_FAILURE);
  assert.equal(decideCiContractExit({ ...ok, rotationFailed: true }), CI_EXIT_POLICY_FAILURE);
  assert.equal(decideCiContractExit({ ...ok, gate: { enabled: false, failed: false }, rotationFailed: true }), CI_EXIT_POLICY_FAILURE);
  assert.equal(decideCiContractExit({ ...ok, gate: { enabled: false, failed: false } }), CI_EXIT_SUCCESS, "an inactive gate never fails a run");
});

test("an access prerequisite that blocks normal QA fails CI with exit 1 (never 0)", () => {
  const ok = { decision: { failed: false }, gate: { enabled: false, failed: false }, rotationFailed: false };

  // The website was not tested — a completed QA policy outcome, exit 1.
  assert.equal(decideCiContractExit({ ...ok, accessPrerequisiteStatus: "REVIEW_REQUIRED" }), CI_EXIT_POLICY_FAILURE,
    "an ambiguous/inaccessible target (HTTP 404, login, challenge) must not be reported as acceptable");
  assert.equal(decideCiContractExit({ ...ok, accessPrerequisiteStatus: "BLOCKED" }), CI_EXIT_POLICY_FAILURE,
    "an access-denied target must not be reported as acceptable");

  // Everything else is unchanged.
  assert.equal(decideCiContractExit({ ...ok, accessPrerequisiteStatus: "PASS" }), CI_EXIT_SUCCESS, "PASS carries no failure");
  assert.equal(decideCiContractExit({ ...ok, accessPrerequisiteStatus: null }), CI_EXIT_SUCCESS, "absent prerequisite is unchanged");
  assert.equal(decideCiContractExit(ok), CI_EXIT_SUCCESS, "no access input is unchanged");

  // The access verdict never depends on --fail-on: it fails even when the
  // status policy is satisfied (QA status REVIEW under the default policy).
  assert.equal(decideCiContractExit({ ...ok, decision: { failed: false }, accessPrerequisiteStatus: "REVIEW_REQUIRED" }), CI_EXIT_POLICY_FAILURE);

  // The access verdict never converts into exit 2 — that stays reserved for
  // baseline integrity and infrastructure, which are asserted end to end below.
  assert.equal(decideCiContractExit({ ...ok, accessPrerequisiteStatus: "REVIEW_REQUIRED" }), CI_EXIT_POLICY_FAILURE);
});

// --- success path ------------------------------------------------------------

test("valid verified baseline + clean QA run -> exit 0", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--ci"], dir);
    assert.equal(status, CI_EXIT_SUCCESS, `stderr: ${stderr}`);
    assert.ok(stdout.includes("Regression baseline:"), "the baseline comparison ran");
    assert.ok(stdout.includes("integrity: verified"), "the published baseline verifies on load");
    assert.ok(stdout.includes("CI: acceptable → exit 0"), stdout);
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as QaAnalysis;
    assert.equal(out.configuration?.resolved?.baselinePath, baselinePath, "the snapshot records the compared baseline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate verdict without --ci never changes the exit code (exit 0)", () => {
  const dir = tempDir();
  try {
    const hiPath = writeReportFile(dir, highFindingReport(), "report-hi.json");
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath, cleanReport());
    const { status } = runCli([...baseArgs(dir, hiPath, "out.json"), "--baseline", baselinePath], dir);
    assert.equal(status, CI_EXIT_SUCCESS, "without --ci the gate is printed but has no exit effect");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- regression / gate failure -------------------------------------------

test("valid baseline + NEW HIGH regression/gate violation -> exit 1", () => {
  const dir = tempDir();
  try {
    const cleanPath = writeReportFile(dir, cleanReport(), "report-clean.json");
    const hiPath = writeReportFile(dir, highFindingReport(), "report-hi.json");
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath, cleanReport());
    const { status, stdout } = runCli([...baseArgs(dir, hiPath, "out.json"), "--baseline", baselinePath, "--ci"], dir);
    assert.equal(status, CI_EXIT_POLICY_FAILURE, stdout);
    assert.ok(stdout.includes("GATE (fail on new findings"), stdout);
    assert.ok(stdout.includes("NEW (HIGH)"), stdout);
    assert.ok(stdout.includes("CI: policy or gate violation → exit 1"), stdout);
    assert.ok(!stdout.includes("not comparable"), "the regression comparison was real, not skipped");
    void cleanPath;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- access prerequisite: the website was not tested -----------------------

/** A scan whose target could NOT be classified: HTTP 404, access status
 *  `unknown`, `continueScan: false`, so the normal QA scan never runs and the
 *  analysis carries a REVIEW_REQUIRED access prerequisite. This is the exact
 *  shape the real CI run produced — and it used to report
 *  `CI: acceptable → exit 0`. */
const accessReviewReport = (): ScanReport => ({
  ...reportOf([]),
  scan: { url: "https://404.qa.test/en", finalUrl: "https://404.qa.test/en", title: "404 Not Found", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 404 },
  access: {
    url: "https://404.qa.test/en",
    finalUrl: "https://404.qa.test/en",
    httpStatus: 404,
    accessStatus: "unknown",
    authenticationType: "none",
    challenge: null,
    redirectDestination: null,
    reason: "The target returned HTTP 404; access could not be classified.",
    continueScan: false,
    humanReview: true,
  },
  accessPrerequisite: {
    type: "unknown",
    status: "REVIEW_REQUIRED",
    message: "Access prerequisite requires human review.",
    httpStatus: 404,
    challenge: null,
  },
});

/** An access-denied target: the scan stops and the prerequisite is BLOCKED. */
const accessBlockedReport = (): ScanReport => {
  const base = accessReviewReport();
  return {
    ...base,
    scan: { ...base.scan, title: "403 Forbidden", navigationStatus: 403 },
    access: { ...(base.access as NonNullable<ScanReport["access"]>), httpStatus: 403, accessStatus: "access-blocked", reason: "The target denied access (HTTP 403)." },
    accessPrerequisite: { type: "access-blocked", status: "BLOCKED", message: "Access prerequisite requires human review.", httpStatus: 403, challenge: null },
  };
};

test("HTTP 404 / access cannot be classified -> REVIEW_REQUIRED -> normal QA never runs -> CI exit 1, not 0", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, accessReviewReport(), "report-404.json");
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--ci"], dir);
    assert.equal(status, CI_EXIT_POLICY_FAILURE, `CI must exit 1 for an untested website\n${stdout}\n${stderr}`);

    // The real scenario: the website was not actually tested.
    assert.ok(stdout.includes("QA status: REVIEW"), stdout);
    assert.ok(stdout.includes("access prerequisite requires human review"), stdout);
    assert.ok(stdout.includes("Normal QA scan: not run"), "the safety boundary still prevented normal QA");
    assert.ok(stdout.includes("status: REVIEW_REQUIRED"), stdout);

    // CI must report a policy failure — and must NOT report a clean exit.
    assert.ok(stdout.includes("CI: policy or gate violation → exit 1"), stdout);
    assert.ok(stdout.includes("CI: access prerequisite REVIEW_REQUIRED → normal QA did not run → exit 1 (the website was not tested)"),
      `the CI log must name the access reason for the exit 1\n${stdout}`);
    assert.ok(!stdout.includes("CI: acceptable → exit 0"),
      "CI must never report an untested website as acceptable");
    assert.ok(stdout.includes("Failure mode: policy → exit 1."),
      `the failure-mode line must agree with the exit code\n${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an access-denied target (BLOCKED) also exits 1 and never reports acceptable", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, accessBlockedReport(), "report-403.json");
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--ci"], dir);
    assert.equal(status, CI_EXIT_POLICY_FAILURE, `CI must exit 1\n${stdout}\n${stderr}`);
    assert.ok(stdout.includes("status: BLOCKED"), stdout);
    assert.ok(stdout.includes("CI: access prerequisite BLOCKED → normal QA did not run → exit 1 (the website was not tested)"), stdout);
    assert.ok(!stdout.includes("CI: acceptable → exit 0"), stdout);
    assert.ok(stdout.includes("Failure mode: policy → exit 1."), stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a normal local run still just shows REVIEW for the same untested target (no CI-style failure)", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, accessReviewReport(), "report-404.json");
    const { status, stdout } = runCli([...baseArgs(dir, reportPath, "out.json")], dir);
    assert.equal(status, CI_EXIT_SUCCESS, "without --ci an access prerequisite is not a process failure");
    assert.ok(stdout.includes("QA status: REVIEW"), "the local run still displays REVIEW");
    assert.ok(!stdout.includes("CI:"), "no CI verdict is printed outside --ci");
    assert.ok(!stdout.includes("Failure mode:"), "no failure-mode line outside --ci");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- baseline verification failures (exit 2) ---------------------------------

test("malformed baseline -> exit 2", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "malformed.json");
    writeFileSync(baselinePath, "{ not valid json", "utf8");
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--ci"], dir);
    assert.equal(status, CI_EXIT_INFRASTRUCTURE);
    assert.ok(`${stdout}\n${stderr}`.includes("Invalid baseline malformed.json"), `${stdout}\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structurally invalid baseline -> exit 2", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "invalid.json");
    writeFileSync(baselinePath, JSON.stringify({ something: "else" }), "utf8");
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--ci"], dir);
    assert.equal(status, CI_EXIT_INFRASTRUCTURE);
    assert.ok(`${stdout}\n${stderr}`.includes("not a QaAnalysis artifact"), `${stdout}\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tampered baseline (sha256 digest mismatch) -> exit 2", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    writeFileSync(baselinePath, `${readFileSync(baselinePath, "utf8")}\n`, "utf8"); // re-save changes the digest
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--ci"], dir);
    assert.equal(status, CI_EXIT_INFRASTRUCTURE);
    assert.ok(`${stdout}\n${stderr}`.includes("failed digest verification"), `${stdout}\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing baseline -> exit 2 (existing hard-failure behavior preserved)", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "does-not-exist.json");
    const { status, stdout, stderr } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--ci"], dir);
    assert.equal(status, CI_EXIT_INFRASTRUCTURE);
    assert.ok(`${stdout}\n${stderr}`.includes("no such file"), `${stdout}\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale baseline under the configured rotation policy -> exit 1 (cannot silently pass)", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    const metaPath = `${baselinePath}.meta.json`;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { writtenAt?: string };
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(metaPath, JSON.stringify({ ...meta, writtenAt: old }, null, 2), "utf8");
    const { status, stdout } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--baseline-max-age", "1h", "--ci"], dir);
    assert.equal(status, CI_EXIT_POLICY_FAILURE);
    assert.ok(stdout.includes("rotation: STALE"), stdout);
    assert.ok(stdout.includes("CI rotation: FAIL"), stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale baseline WITHOUT --ci keeps the normal-run exit code (0 when otherwise clean)", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    const metaPath = `${baselinePath}.meta.json`;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { writtenAt?: string };
    writeFileSync(metaPath, JSON.stringify({ ...meta, writtenAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }, null, 2), "utf8");
    const { status, stdout } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--baseline-max-age", "1h"], dir);
    assert.equal(status, CI_EXIT_SUCCESS, "without --ci the rotation verdict is printed but has no exit effect");
    assert.ok(stdout.includes("rotation: STALE"), stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy baseline with no usable timestamp is UNKNOWN and never failed (UNKNOWN-safe)", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "legacy.json");
    publishBaseline(dir, baselinePath);
    rmSync(`${baselinePath}.meta.json`, { force: true }); // drop the sidecar -> LEGACY_NO_META
    const legacy = JSON.parse(readFileSync(baselinePath, "utf8")) as { generatedAt: string };
    writeFileSync(baselinePath, JSON.stringify({ ...legacy, generatedAt: "not-a-date" }, null, 2), "utf8"); // no usable timestamp
    const { status, stdout } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", baselinePath, "--baseline-max-age", "1h", "--ci"], dir);
    assert.equal(status, CI_EXIT_SUCCESS, "an UNKNOWN age is not enforceable and cannot fail CI");
    assert.ok(stdout.includes("rotation: unknown"), stdout);
    assert.ok(stdout.includes("legacy artifact"), stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- configuration -----------------------------------------------------------

const writeConfig = (dir: string, config: unknown): void => {
  writeFileSync(join(dir, "qa.config.json"), JSON.stringify(config), "utf8");
};

test("configured baseline.path is used automatically (no --baseline flag)", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    writeConfig(dir, { baseline: { path: baselinePath, maxAge: "30d" } });
    const { status, stdout } = runCli([...baseArgs(dir, reportPath, "out.json"), "--ci"], dir);
    assert.equal(status, CI_EXIT_SUCCESS);
    assert.ok(stdout.includes("Regression baseline:"), "the configured baseline was loaded");
    assert.ok(stdout.includes(baselinePath), stdout);
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as QaAnalysis;
    assert.equal(out.configuration?.resolved?.baselinePath, baselinePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--baseline overrides the configured baseline.path", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const configured = join(dir, "configured.json");
    publishBaseline(dir, configured);
    const override = join(dir, "override.json");
    publishBaseline(dir, override);
    writeConfig(dir, { baseline: { path: configured } });
    const { status, stdout } = runCli([...baseArgs(dir, reportPath, "out.json"), "--baseline", override, "--ci"], dir);
    assert.equal(status, CI_EXIT_SUCCESS);
    assert.ok(stdout.includes("override.json"), `the override baseline was used: ${stdout}`);
    assert.ok(!stdout.includes("configured.json"), "the configured baseline was not used");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid baseline.path fails before the pipeline with the existing config-error behavior", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    writeConfig(dir, { baseline: { path: "" } });
    const local = runCli([...baseArgs(dir, reportPath, "out.json")], dir);
    assert.equal(local.status, CI_EXIT_POLICY_FAILURE, "normal runs keep their exit-1 error path");
    assert.ok(`${local.stdout}\n${local.stderr}`.includes(`"baseline.path" must be a non-empty file path`), `${local.stdout}\n${local.stderr}`);
    const ci = runCli([...baseArgs(dir, reportPath, "out.json"), "--ci"], dir);
    assert.equal(ci.status, CI_EXIT_INFRASTRUCTURE, "in CI mode a config error aborts as exit 2 (infrastructure)");
    assert.ok(`${ci.stdout}\n${ci.stderr}`.includes(`"baseline.path" must be a non-empty file path`), `${ci.stdout}\n${ci.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- artifact safety ---------------------------------------------------------

test("CI runs never mutate the committed baseline or its sidecar", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    const baselineBefore = sha256(baselinePath);
    const sidecarPath = `${baselinePath}.meta.json`;
    const sidecarBefore = readFileSync(sidecarPath, "utf8");
    const meta = JSON.parse(readFileSync(sidecarPath, "utf8")) as { digest: string };

    // A full CI run against the baseline (fresh variant) must not touch the artifact.
    runCli([...baseArgs(dir, reportPath, "out-fresh.json"), "--baseline", baselinePath, "--baseline-max-age", "10000d", "--ci"], dir);
    assert.equal(sha256(baselinePath), baselineBefore, "the baseline artifact bytes are unchanged after a CI run");
    assert.equal(readFileSync(sidecarPath, "utf8"), sidecarBefore, "the sidecar is unchanged after a CI run");
    assert.equal(meta.digest, sha256(baselinePath), "the sidecar digest still matches the artifact");

    // Age the sidecar (test-only) and run again; the run still never writes back.
    const aged = { ...meta, writtenAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() };
    writeFileSync(sidecarPath, JSON.stringify(aged, null, 2), "utf8");
    const stale = runCli([...baseArgs(dir, reportPath, "out-stale.json"), "--baseline", baselinePath, "--baseline-max-age", "1h", "--ci"], dir);
    assert.equal(stale.status, CI_EXIT_POLICY_FAILURE, "stale still fails CI");
    assert.equal(sha256(baselinePath), baselineBefore, "the baseline artifact bytes are unchanged after the stale run");
    assert.equal(readFileSync(sidecarPath, "utf8"), JSON.stringify(aged, null, 2), "the aged sidecar was not overwritten by the run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CI runs write every artifact under the temp cwd and never escape it", () => {
  const dir = tempDir();
  try {
    const reportPath = writeReportFile(dir, cleanReport());
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath);
    const outPath = join(dir, "out.json");
    const historyDir = join(dir, "history");
    runCli(["--report", reportPath, "--output", outPath, "--history-dir", historyDir, "--baseline", baselinePath, "--ci", "--execute", "none"], dir);
    assert.ok(existsSync(outPath), "the JSON report is written at the requested output path");
    assert.ok(existsSync(join(dir, "out.html")), "the HTML report lands next to the requested output path");
    assert.ok(existsSync(historyDir) && readdirSync(historyDir).length > 0, "history is written under the requested history dir");
    assert.ok(existsSync(baselinePath) && existsSync(`${baselinePath}.meta.json`), "the baseline and its sidecar live under the temp dir");
    // Scope: no default-relative artifact (reports/, qa-analysis.json, …) escaped into the temp cwd.
    const names = readdirSync(dir);
    assert.ok(!names.some(name => name === "reports" || name.endsWith("qa-analysis.json")), `no default-named artifacts escaped: ${names.join(", ")}`);
    const repoReports = join(process.cwd(), "reports", "qa-analysis.json");
    assert.ok(repoReports !== outPath, "the committed default report path is never the temp output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});