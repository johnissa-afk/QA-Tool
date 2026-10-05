// ---------------------------------------------------------------------------
// Phase 11C — the failure-mode matrix.
//
// An executable, table-driven matrix over every way a QA/CI run ends. Two
// layers:
//
//   1. PURE classification (no I/O): classifyRunOutcome over the existing
//      decision stack (Phase 8C decision / Phase 9 gate / 10D rotation +
//      hard-failure signals), including the precedence rules, plus the stable
//      category of thrown errors (config / baseline-verification /
//      infrastructure).
//   2. SPAWNED CLI matrix: each row drives the BUILT CLI exactly as CI does and
//      verifies the scenario's exit code, the machine-readable
//      `Failure mode: <category> → exit <code>.` line, whether the pipeline
//      continued ("QA RESULT"), and whether the report artifact was produced.
//
// Every case uses temp directories and deterministic fixtures; no live Noor
// infrastructure is involved. Baselines are published by the CLI itself.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { detectIssues, groupIssues } from "../checks.js";
import type { QaAnalysis } from "../ai/types.js";
import type { DiscoveredElement, Issue, LinkResult, ScanReport } from "../types.js";
import {
  FailureModeCategory, RunOutcomeInput, classifyRunOutcome,
  classifyThrownError, formatFailureModeLine,
} from "../qa/failure-mode.js";
import { decideCiContractExit } from "../qa/ci-contract.js";
import { CI_EXIT_INFRASTRUCTURE, CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS } from "../qa/ci-policy.js";

// Deterministic mode for every child run and fixture.
process.env.AI_API_KEY = "";

const CLI_PATH = join(process.cwd(), "dist", "qa-cli.js");
assert.ok(existsSync(CLI_PATH), `the built CLI is required for failure-mode tests: ${CLI_PATH}`);

const sanitizedEnv = (): Record<string, string | undefined> => ({ ...process.env, AI_API_KEY: "", QA_USERNAME: "", QA_PASSWORD: "", QA_AUTHORIZATION: "" });

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

const tempDir = (): string => mkdtempSync(join(tmpdir(), "qa-failure-mode-"));

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const issueOf = (link: LinkResult): Issue => ({ status: link.type === "BROKEN" || link.type === "ERROR" ? "FAIL" : "WARNING", code: "unhealthy-link", message: `Broken destination ${link.url}` });

const reportOf = (elements: DiscoveredElement[], links: LinkResult[] = []): ScanReport => {
  const issues = [...detectIssues(elements, { title: "QA matrix target", lang: "en", viewport: "width=device-width" }), ...links.map(issueOf)];
  const grouped = groupIssues(issues);
  const broken = links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length;
  return {
    scan: { url: "https://matrix.qa.test/en", finalUrl: "https://matrix.qa.test/en", title: "QA matrix target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
    authentication: { method: "none", usernamePresent: false, passwordPresent: false, authorizationPresent: false, accepted: true },
    summary: { totalElements: elements.length, interactiveElements: elements.filter(item => item.interactive).length, passes: 0, warnings: grouped.filter(issue => issue.status === "WARNING").length, failures: grouped.filter(issue => issue.status === "FAIL").length, infos: grouped.filter(issue => issue.status === "INFO").length, linksChecked: links.length, brokenLinks: broken, consoleErrors: 0, pageErrors: 0, issueGroups: grouped.length, groupedIssueCounts: { passes: 0, warnings: 0, failures: 0, infos: 0 } },
    page: { language: "en", viewport: "width=device-width", forms: 0, images: 0, links: links.length, buttons: elements.filter(item => item.tag === "button").length, inputs: 0, textareas: 0, selects: 0, dialogs: 0, media: 0 },
    elements, issues: grouped, links, consoleErrors: [], consoleDiagnostics: [], pageErrors: [],
  };
};

const cleanReport = (): ScanReport => reportOf([element()]);
const highFindingReport = (): ScanReport => reportOf([element({ text: undefined, ariaLabel: null, name: null, accessibleName: null, recommendedLocator: "page.getByRole(\"button\", { name: \"?\" })" })]);

const writeReportFile = (dir: string, report: ScanReport, fileName = "report.json"): string => {
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
};

const writeConfig = (dir: string, config: unknown): void => {
  writeFileSync(join(dir, "qa.config.json"), JSON.stringify(config), "utf8");
};

/** Publishes a VERIFIED baseline via the CLI's own `--write-baseline`. */
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

const baseArgs = (reportPath: string, outputName: string): string[] => [
  "--report", reportPath,
  "--output", join(dirname(reportPath), outputName),
  "--history-dir", join(dirname(reportPath), "history"),
  "--execute", "none",
];

// ---------------------------------------------------------------------------
// 1. Pure classification — categories, exit codes, and precedence.
// ---------------------------------------------------------------------------

const done = (overrides: Partial<RunOutcomeInput> = {}): RunOutcomeInput => ({
  decision: { failed: false },
  gate: { enabled: false, failed: false },
  rotationFailed: false,
  ...overrides,
});

type PureCase = {
  name: string;
  input: RunOutcomeInput;
  category: FailureModeCategory;
  exit: number;
  continued: boolean;
  artifact: boolean;
};

const PURE_MATRIX: PureCase[] = [
  { name: "clean run, no failure", input: done(), category: "success", exit: 0, continued: true, artifact: true },
  { name: "CI status policy fails (8C)", input: done({ decision: { failed: true } }), category: "policy", exit: 1, continued: true, artifact: true },
  { name: "Phase 9 gate enabled and passing", input: done({ gate: { enabled: true, failed: false } }), category: "success", exit: 0, continued: true, artifact: true },
  { name: "Phase 9 gate enabled and failing (NEW/REGRESSION)", input: done({ gate: { enabled: true, failed: true } }), category: "gate", exit: 1, continued: true, artifact: true },
  { name: "gate disabled never fails alone", input: done({ gate: { enabled: false, failed: true } }), category: "success", exit: 0, continued: true, artifact: true },
  { name: "gate disabled + otherwise failing condition", input: done({ decision: { failed: true }, gate: { enabled: false, failed: true } }), category: "policy", exit: 1, continued: true, artifact: true },
  { name: "rotation fails (stale baseline in CI)", input: done({ rotationFailed: true }), category: "rotation", exit: 1, continued: true, artifact: true },
  { name: "rotation fresh", input: done({ rotationFailed: false }), category: "success", exit: 0, continued: true, artifact: true },
  { name: "regression (gate) + policy together", input: done({ decision: { failed: true }, gate: { enabled: true, failed: true } }), category: "gate", exit: 1, continued: true, artifact: true },
  { name: "regression (gate) + rotation together", input: done({ gate: { enabled: true, failed: true }, rotationFailed: true }), category: "gate", exit: 1, continued: true, artifact: true },
  { name: "gate + rotation together", input: done({ gate: { enabled: true, failed: true }, rotationFailed: true }), category: "gate", exit: 1, continued: true, artifact: true },
  { name: "policy + rotation together", input: done({ decision: { failed: true }, rotationFailed: true }), category: "policy", exit: 1, continued: true, artifact: true },
  { name: "gate + policy + rotation together", input: done({ decision: { failed: true }, gate: { enabled: true, failed: true }, rotationFailed: true }), category: "gate", exit: 1, continued: true, artifact: true },
  { name: "baseline failure beats a would-be regression", input: done({ baselineVerificationFailed: true, gate: { enabled: true, failed: true } }), category: "baseline-verification", exit: 2, continued: false, artifact: false },
  { name: "baseline failure beats a would-be gate", input: done({ baselineVerificationFailed: true, decision: { failed: true }, gate: { enabled: true, failed: true } }), category: "baseline-verification", exit: 2, continued: false, artifact: false },
  { name: "baseline failure beats rotation", input: done({ baselineVerificationFailed: true, rotationFailed: true }), category: "baseline-verification", exit: 2, continued: false, artifact: false },
  { name: "configuration failure (local) beats gate", input: done({ configurationFailed: true, gate: { enabled: true, failed: true } }), category: "configuration", exit: 1, continued: false, artifact: false },
  { name: "configuration failure (CI) beats gate", input: done({ configurationFailed: true, ciMode: true, gate: { enabled: true, failed: true } }), category: "configuration", exit: 2, continued: false, artifact: false },
  { name: "infrastructure failure is never masked by regression/gate/rotation", input: done({ infrastructureFailed: true, decision: { failed: true }, gate: { enabled: true, failed: true }, rotationFailed: true }), category: "infrastructure", exit: 2, continued: false, artifact: false },
  { name: "infrastructure failure beats configuration", input: done({ infrastructureFailed: true, configurationFailed: true }), category: "infrastructure", exit: 2, continued: false, artifact: false },
  { name: "infrastructure failure beats baseline", input: done({ infrastructureFailed: true, baselineVerificationFailed: true }), category: "infrastructure", exit: 2, continued: false, artifact: false },
];

test("pure matrix: every outcome classifies to the documented category and exit code", () => {
  for (const row of PURE_MATRIX) {
    const actual = classifyRunOutcome(row.input);
    assert.equal(actual.category, row.category, `${row.name}: category`);
    assert.equal(actual.exitCode, row.exit, `${row.name}: exit code`);
    assert.equal(actual.continued, row.continued, `${row.name}: continued`);
    assert.equal(actual.producedArtifact, row.artifact, `${row.name}: producedArtifact`);
  }
});

test("classifyRunOutcome agrees with decideCiContractExit on every completed-run input", () => {
  for (const decisionFailed of [false, true]) {
    for (const gateEnabled of [false, true]) {
      for (const gateFailed of [false, true]) {
        for (const rotationFailed of [false, true]) {
          const input = { decision: { failed: decisionFailed }, gate: { enabled: gateEnabled, failed: gateFailed }, rotationFailed };
          assert.equal(classifyRunOutcome(input).exitCode, decideCiContractExit(input));
        }
      }
    }
  }
});

test("no failure condition can accidentally return 0", () => {
  // Exhaustive sweep over the completed-run flags x hard-failure flags x ciMode:
  // whenever ANY failure signal is present the run can never classify as exit 0,
  // and every verdict is internally consistent with the documented contract.
  for (const decisionFailed of [false, true]) {
    for (const gateEnabled of [false, true]) {
      for (const gateFailed of [false, true]) {
        for (const rotationFailed of [false, true]) {
          for (const configurationFailed of [false, true]) {
            for (const baselineVerificationFailed of [false, true]) {
              for (const infrastructureFailed of [false, true]) {
                for (const ciMode of [false, true]) {
                  const anyCompletedFailure = decisionFailed || (gateEnabled && gateFailed) || rotationFailed;
                  const anyHardFailure = configurationFailed || baselineVerificationFailed || infrastructureFailed;
                  const verdict = classifyRunOutcome({ decision: { failed: decisionFailed }, gate: { enabled: gateEnabled, failed: gateFailed }, rotationFailed, configurationFailed, baselineVerificationFailed, infrastructureFailed, ciMode });
                  assert.equal(verdict.exitCode === 0, !anyCompletedFailure && !anyHardFailure, "only a fully clean state is exit 0");
                  assert.equal(
                    verdict.exitCode,
                    verdict.category === "success" ? 0
                      : verdict.category === "gate" || verdict.category === "policy" || verdict.category === "rotation" ? 1
                        : verdict.category === "configuration" ? (ciMode ? 2 : 1)
                          : 2,
                    `category ${verdict.category} must map to its contract exit code`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Thrown-error classification (the CLI's catch path).
// ---------------------------------------------------------------------------

type ThrownCase = { name: string; message: string; category: "configuration" | "baseline-verification" | "infrastructure" };

const THROWN_MATRIX: ThrownCase[] = [
  { name: "malformed config JSON", message: "Invalid qa.config.json: Unexpected token 'o'...", category: "configuration" },
  { name: "invalid baseline.path config", message: "Invalid qa.config.json: \"baseline.path\" must be a non-empty file path (e.g. \"reports/qa-baseline.json\").", category: "configuration" },
  { name: "unknown config property", message: "Invalid qa.config.json: unknown property \"covergae\" — supported: crawl, ...", category: "configuration" },
  { name: "dash guard (value option)", message: "--baseline requires a value (a file path or argument), got (missing).", category: "configuration" },
  { name: "--fail-on missing value", message: "--fail-on requires a value: review | failed.", category: "configuration" },
  { name: "invalid --fail-on value", message: "Invalid --fail-on policy \"never\". Valid policies: review | failed.", category: "configuration" },
  { name: "invalid gate severity", message: "Invalid gate severity \"CRAZY\" — must be one of HIGH | CRITICAL.", category: "configuration" },
  { name: "invalid baseline max-age", message: "Invalid baseline max-age \"nope\" — use <number>m|h|d|w (e.g. \"30d\", \"12h\", \"90m\").", category: "configuration" },
  { name: "output overwrites the loaded baseline", message: "--output <path> must not be the loaded --baseline artifact (reports/qa-analysis.json) — the report write would overwrite it.", category: "configuration" },
  { name: "output overwrites the write-baseline target", message: "--output <path> must not be the --write-baseline target (base.json) — the report write would overwrite it.", category: "configuration" },
  { name: "output overwrites the write-baseline sidecar", message: "--output <path> must not be the --write-baseline sidecar (base.json.meta.json) — the report write would overwrite it.", category: "configuration" },
  { name: "write-baseline over the baseline", message: "--write-baseline <path> must not be the --baseline artifact (base.json) — publishing would replace the baseline being compared against.", category: "configuration" },
  { name: "write-baseline overwrite refusal", message: "--write-baseline refuses to overwrite an existing baseline: base.json (remove the file to replace it).", category: "configuration" },
  { name: "missing URL/report", message: "A URL or --report path is required.", category: "configuration" },
  { name: "--crawl needs a URL", message: "--crawl requires a start URL (not just --report).", category: "configuration" },
  { name: "--reset-history needs a URL", message: "--reset-history requires a start URL — run history is per-site and needs a site to resume.", category: "configuration" },
  { name: "bad --timeout", message: "--timeout must be a positive number.", category: "configuration" },
  { name: "bad --port", message: "--port must be an integer between 1 and 65535.", category: "configuration" },
  { name: "missing baseline file", message: "Invalid baseline does-not-exist.json: no such file — point --baseline at a previous qa-analysis.json (or a --write-baseline artifact).", category: "baseline-verification" },
  { name: "malformed baseline JSON", message: "Invalid baseline malformed.json: Unexpected token 'n', \"{ not val\"... is not valid JSON", category: "baseline-verification" },
  { name: "structurally invalid baseline", message: "Invalid baseline invalid.json: not a QaAnalysis artifact (missing scan.scan.url).", category: "baseline-verification" },
  { name: "unreadable baseline target", message: "Invalid baseline dir: unable to read the file (EISDIR: illegal operation on a directory, read).", category: "baseline-verification" },
  { name: "tampered baseline digest", message: "Baseline baseline.json failed digest verification: sidecar sha256 a1b2c3..., artifact sha256 d4e5f6....", category: "baseline-verification" },
  { name: "invalid baseline sidecar meta", message: "Invalid baseline baseline.json.meta.json: \"digest\" must be a 64-character lowercase hex sha256 (received \"zzz\").", category: "baseline-verification" },
  { name: "release touched the baseline after publish", message: "The artifact changed after --write-baseline wrote it (or was re-saved, e.g. CRLF line endings).", category: "baseline-verification" },
  { name: "filesystem failure", message: "ENOENT: no such file or directory, open 'C:\\x\\scan.ts'", category: "infrastructure" },
  { name: "network failure", message: "net::ERR_NAME_NOT_RESOLVED", category: "infrastructure" },
  { name: "browser launch failure", message: "Executable doesn't exist at C:\\ms-playwright\\chromium\\chrome.exe", category: "infrastructure" },
  { name: "executor build missing", message: "The EXECUTOR build is missing (C:\\proj\\dist\\executor\\verify.js). Run \"npm run build\" before --execute.", category: "infrastructure" },
];

test("thrown errors classify into the stable failure categories", () => {
  for (const row of THROWN_MATRIX) {
    assert.equal(classifyThrownError(new Error(row.message)), row.category, row.name);
    assert.equal(classifyThrownError(row.message), row.category, `${row.name} (non-Error)`);
  }
});

// ---------------------------------------------------------------------------
// 3. Spawned CLI matrix — every matrix case that reaches CI verifies the
//    exit code, the classification line, pipeline continuation, and artifact.
// ---------------------------------------------------------------------------

const line = formatFailureModeLine; // exact-match helper below

type MatrixCase = {
  name: string;
  /// Writes the fixtures and returns the metadata the args builder needs.
  setup: (dir: string) => { reportPath: string; baselinePath: string | null };
  args: (reportPath: string, baselinePath: string | null) => string[];
  expectedExit: number;
  /** Exact "Failure mode: <cat> → exit <n>." line expected (search stdout+stderr),
   *  or null when it must be ABSENT (no CI verdict in that run). */
  categoryLine: string | null;
  continued: boolean;
  artifact: boolean;
};

const CLI_MATRIX: MatrixCase[] = [
  {
    name: "valid baseline + clean QA -> success / 0 (gate enabled and passing)",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_SUCCESS, categoryLine: line("success", 0), continued: true, artifact: true,
  },
  {
    name: "valid baseline + NEW HIGH regression -> gate / 1",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("gate", 1), continued: true, artifact: true,
  },
  {
    name: "regression + policy together (NEW HIGH + --fail-on review) -> gate / 1",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--fail-on", "review"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("gate", 1), continued: true, artifact: true,
  },
  {
    name: "gate disabled + otherwise failing (no baseline, --fail-on review) -> policy / 1",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      return { reportPath, baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--fail-on", "review"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("policy", 1), continued: true, artifact: true,
  },
  {
    name: "fresh baseline under the rotation policy -> success / 0",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "10000d", "--ci"],
    expectedExit: CI_EXIT_SUCCESS, categoryLine: line("success", 0), continued: true, artifact: true,
  },
  {
    name: "stale baseline under the rotation policy in CI -> rotation / 1",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      const metaPath = `${baselinePath}.meta.json`;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { writtenAt?: string };
      writeFileSync(metaPath, JSON.stringify({ ...meta, writtenAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "1h", "--ci"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("rotation", 1), continued: true, artifact: true,
  },
  {
    name: "stale baseline WITHOUT --ci stays a completed local run -> 0, no classification line",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      const metaPath = `${baselinePath}.meta.json`;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { writtenAt?: string };
      writeFileSync(metaPath, JSON.stringify({ ...meta, writtenAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "1h"],
    expectedExit: CI_EXIT_SUCCESS, categoryLine: null, continued: true, artifact: true,
  },
  {
    name: "missing baseline -> baseline-verification / 2",
    setup: (dir) => ({ reportPath: writeReportFile(dir, cleanReport()), baselinePath: null }),
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--baseline", join(dirname(reportPath), "does-not-exist.json"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "malformed baseline -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      writeFileSync(join(dir, "malformed.json"), "{ not valid json", "utf8");
      return { reportPath, baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--baseline", join(dirname(reportPath), "malformed.json"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "structurally invalid baseline -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      writeFileSync(join(dir, "invalid.json"), JSON.stringify({ something: "else" }), "utf8");
      return { reportPath, baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--baseline", join(dirname(reportPath), "invalid.json"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "tampered baseline (sha256 mismatch) -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      writeFileSync(baselinePath, `${readFileSync(baselinePath, "utf8")}\n`, "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "invalid baseline metadata (sidecar digest corrupt) -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      writeFileSync(`${baselinePath}.meta.json`, JSON.stringify({ schemaVersion: 1, digest: "not-a-hex-digest" }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "unusable baseline (target is a directory) -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      mkdirSync(join(dir, "baseline-dir"));
      return { reportPath, baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--baseline", join(dirname(reportPath), "baseline-dir"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "malformed qa.config.json -> configuration / 2 in CI",
    setup: (dir) => {
      writeFileSync(join(dir, "qa.config.json"), "{ not json", "utf8");
      return { reportPath: writeReportFile(dir, cleanReport()), baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("configuration", 2), continued: false, artifact: false,
  },
  {
    name: "invalid baseline.path config -> configuration / 2 in CI",
    setup: (dir) => {
      writeConfig(dir, { baseline: { path: "" } });
      return { reportPath: writeReportFile(dir, cleanReport()), baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("configuration", 2), continued: false, artifact: false,
  },
  {
    name: "invalid --baseline-max-age value -> configuration / 2 in CI",
    setup: (dir) => ({ reportPath: writeReportFile(dir, cleanReport()), baselinePath: null }),
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--baseline-max-age", "nope", "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("configuration", 2), continued: false, artifact: false,
  },
  {
    name: "legacy UNKNOWN baseline age + clean run -> success / 0 (UNKNOWN-safe)",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "legacy.json");
      publishBaseline(dir, baselinePath, cleanReport());
      rmSync(`${baselinePath}.meta.json`, { force: true });
      const legacy = JSON.parse(readFileSync(baselinePath, "utf8")) as { generatedAt: string };
      writeFileSync(baselinePath, JSON.stringify({ ...legacy, generatedAt: "not-a-date" }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "1h", "--ci"],
    expectedExit: CI_EXIT_SUCCESS, categoryLine: line("success", 0), continued: true, artifact: true,
  },
  {
    name: "legacy UNKNOWN baseline + NEW HIGH -> gate / 1 (UNKNOWN never becomes a regression)",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      const baselinePath = join(dir, "legacy.json");
      publishBaseline(dir, baselinePath, cleanReport());
      rmSync(`${baselinePath}.meta.json`, { force: true });
      const legacy = JSON.parse(readFileSync(baselinePath, "utf8")) as { generatedAt: string };
      writeFileSync(baselinePath, JSON.stringify({ ...legacy, generatedAt: "not-a-date" }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "1h", "--ci"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("gate", 1), continued: true, artifact: true,
  },
  {
    name: "baseline failure + would-be regression (tampered baseline, NEW HIGH report) -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      writeFileSync(baselinePath, `${readFileSync(baselinePath, "utf8")}\n`, "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "baseline failure + would-be gate (structurally invalid baseline, NEW HIGH report) -> baseline-verification / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      writeFileSync(join(dir, "invalid.json"), JSON.stringify({ something: "else" }), "utf8");
      return { reportPath, baselinePath: null };
    },
    args: (reportPath) => [...baseArgs(reportPath, "out.json"), "--baseline", join(dirname(reportPath), "invalid.json"), "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("baseline-verification", 2), continued: false, artifact: false,
  },
  {
    name: "regression + rotation together (NEW HIGH on a stale baseline) -> gate / 1",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      const metaPath = `${baselinePath}.meta.json`;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { writtenAt?: string };
      writeFileSync(metaPath, JSON.stringify({ ...meta, writtenAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "1h", "--ci"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("gate", 1), continued: true, artifact: true,
  },
  {
    name: "gate + rotation together -> gate / 1 (exit 1 deterministically)",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, highFindingReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      const metaPath = `${baselinePath}.meta.json`;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { writtenAt?: string };
      writeFileSync(metaPath, JSON.stringify({ ...meta, writtenAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }, null, 2), "utf8");
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--baseline-max-age", "1h", "--ci"],
    expectedExit: CI_EXIT_POLICY_FAILURE, categoryLine: line("gate", 1), continued: true, artifact: true,
  },
  {
    name: "infrastructure failure, not masked by regression flags -> infrastructure / 2",
    setup: (dir) => {
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      mkdirSync(join(dir, "report-as-dir")); // an unreadable report input
      return { reportPath: join(dir, "report-as-dir"), baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("infrastructure", 2), continued: false, artifact: false,
  },
  {
    name: "regression comparison disabled by configuration (allowed) -> success / 0",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      writeConfig(dir, { regression: { enabled: false } });
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => [...baseArgs(reportPath, "out.json"), "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_SUCCESS, categoryLine: line("success", 0), continued: true, artifact: true,
  },
  {
    name: "artifact-collision guard (--output == --baseline) -> configuration / 2",
    setup: (dir) => {
      const reportPath = writeReportFile(dir, cleanReport());
      const baselinePath = join(dir, "baseline.json");
      publishBaseline(dir, baselinePath, cleanReport());
      return { reportPath, baselinePath };
    },
    args: (reportPath, baselinePath) => ["--report", reportPath, "--output", baselinePath!, "--history-dir", join(dirname(reportPath), "history"), "--execute", "none", "--baseline", baselinePath!, "--ci"],
    expectedExit: CI_EXIT_INFRASTRUCTURE, categoryLine: line("configuration", 2), continued: false, artifact: false,
  },
];

test("spawned CLI matrix: exit codes, classification line, continuation, and artifacts", () => {
  for (const row of CLI_MATRIX) {
    const dir = tempDir();
    try {
      const ctx = row.setup(dir);
      const args = row.args(ctx.reportPath, ctx.baselinePath);
      const { status, stdout, stderr } = runCli(args, dir);
      const combined = `${stdout}\n${stderr}`;
      assert.equal(status, row.expectedExit, `${row.name}: exit code\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      if (row.categoryLine) {
        assert.ok(combined.includes(row.categoryLine), `${row.name}: expected classification line "${row.categoryLine}"\n${combined}`);
      } else {
        assert.ok(!combined.includes("Failure mode:"), `${row.name}: no classification line without a CI verdict\n${combined}`);
      }

      const continued = stdout.includes("QA RESULT");
      assert.equal(continued, row.continued, `${row.name}: pipeline continuation ("QA RESULT" block)`);

      const outPath = join(dir, "out.json");
      assert.equal(existsSync(outPath), row.artifact, `${row.name}: report artifact presence`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("configuration errors preserve the established local exit-1 / CI exit-2 behavior", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "qa.config.json"), "{ not json", "utf8");
    const reportPath = writeReportFile(dir, cleanReport());
    const local = runCli(baseArgs(reportPath, "out.json"), dir);
    assert.equal(local.status, CI_EXIT_POLICY_FAILURE, "a normal local run keeps its exit-1 error path");
    assert.ok(`${local.stdout}\n${local.stderr}`.includes(line("configuration", 1)), `${local.stdout}\n${local.stderr}`);
    const ci = runCli([...baseArgs(reportPath, "out.json"), "--ci"], dir);
    assert.equal(ci.status, CI_EXIT_INFRASTRUCTURE, "in CI mode a config error aborts as exit 2");
    assert.ok(`${ci.stdout}\n${ci.stderr}`.includes(line("configuration", 2)), `${ci.stdout}\n${ci.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone verify preserves the baseline 0/2 contract for valid and tampered artifacts", () => {
  const dir = tempDir();
  try {
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath, cleanReport());

    const valid = runCli(["verify", baselinePath], dir);
    assert.equal(valid.status, CI_EXIT_SUCCESS, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /BASELINE VERIFY: PASS/);
    assert.match(valid.stdout, /integrity: verified/);

    writeFileSync(baselinePath, `${readFileSync(baselinePath, "utf8")}\n`, "utf8");
    const tampered = runCli(["verify", baselinePath], dir);
    assert.equal(tampered.status, CI_EXIT_INFRASTRUCTURE, `${tampered.stdout}\n${tampered.stderr}`);
    assert.match(tampered.stdout, /BASELINE VERIFY: FAIL/);
    assert.match(tampered.stdout, /failed digest verification/);
    assert.doesNotMatch(`${tampered.stdout}\n${tampered.stderr}`, /Failure mode:/, "verify keeps its dedicated output contract");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every completed matrix row writes a report whose configuration snapshot is intact", () => {
  const dir = tempDir();
  try {
    const baselinePath = join(dir, "baseline.json");
    publishBaseline(dir, baselinePath, cleanReport());
    const reportPath = writeReportFile(dir, cleanReport(), "report-current.json");
    const outPath = join(dir, "out.json");
    const { status } = runCli(["--report", reportPath, "--output", outPath, "--history-dir", join(dir, "history"), "--baseline", baselinePath, "--ci", "--execute", "none"], dir);
    assert.equal(status, CI_EXIT_SUCCESS);
    const analysis = JSON.parse(readFileSync(outPath, "utf8")) as QaAnalysis;
    assert.equal(analysis.configuration?.resolved?.baselinePath, baselinePath);
    assert.equal(analysis.scan?.scan?.url, "https://matrix.qa.test/en");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});