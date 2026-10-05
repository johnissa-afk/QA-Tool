// ---------------------------------------------------------------------------
// Phase 11B — deterministic artifact isolation tests.
//
// These tests spawn the BUILT CLI (`node dist/qa-cli.js`) exactly as CI does,
// in temp directories scoped per test, and verify the Phase 11B guarantees:
//
//   • Two equivalent runs yield byte-different raw reports but IDENTICAL
//     normalized artifacts (only runtime-specific fields — timestamps,
//     durations, run ids, machine paths — differ).
//   • Normalized artifacts never leak absolute paths, ISO timestamps, or run ids.
//   • A run never writes outside its own directory tree (committed `reports/`
//     and the repo root stay byte-identical).
//   • Bare/`--value` option misuse (`--write-baseline --execute …`) is rejected
//     as a usage error and can no longer create stray files.
//   • `--output` cannot collide with the loaded baseline, the published
//     baseline target, or its sidecar; a baseline cannot be published "over
//     itself" — every guard fires BEFORE any artifact is written.
//   • Published baselines carry a digest sidecar that matches the artifact
//     bytes, differs between runs, survives rewrites, and is enforced by the
//     existing `verify` exit code (0 ok / 2 unverifiable).
//   • History snapshots stay structurally distinct from regression baselines
//     and fail baseline verification (exit 2).
//   • Repeated runs do not mutate prior report artifacts; history is append-only.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { detectIssues, groupIssues } from "../checks.js";
import type { DiscoveredElement, Issue, LinkResult, ScanReport } from "../types.js";
import { CI_EXIT_POLICY_FAILURE, CI_EXIT_SUCCESS } from "../qa/ci-policy.js";
import { BASELINE_VERIFY_EXIT_FAILURE, BASELINE_VERIFY_EXIT_OK } from "../qa/baseline.js";
import { deterministicArtifactKey, normalizedArtifactsEqual } from "../qa/determinism.js";

// Deterministic mode for every child run and fixture.
process.env.AI_API_KEY = "";

const CLI_PATH = join(process.cwd(), "dist", "qa-cli.js");
assert.ok(existsSync(CLI_PATH), `the built CLI is required for Phase 11B tests: ${CLI_PATH}`);

const sanitizedEnv = (): Record<string, string | undefined> => ({ ...process.env, AI_API_KEY: "", QA_USERNAME: "", QA_PASSWORD: "", QA_AUTHORIZATION: "" });

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(cwd), `cwd must exist before spawn: ${cwd}`);
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, encoding: "utf8", timeout: 180000, env: sanitizedEnv() });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "qa-11b-"));

const element = (overrides: Partial<DiscoveredElement> = {}): DiscoveredElement => ({
  tag: "button", role: "button", text: "Save", ariaLabel: null, placeholder: null, name: null, id: null, testId: null, type: null, hasExplicitType: true, autocomplete: null, href: null, alt: null, visible: true, enabled: true, boundingBox: null, interactive: true, accessibleName: "Save", recommendedLocator: "page.getByRole(\"button\", { name: \"Save\" })", locatorQuality: "high", ...overrides,
});

const issueOf = (link: LinkResult): Issue => ({ status: link.type === "BROKEN" || link.type === "ERROR" ? "FAIL" : "WARNING", code: "unhealthy-link", message: `Broken destination ${link.url}` });

const reportOf = (elements: DiscoveredElement[], links: LinkResult[] = []): ScanReport => {
  const issues = [...detectIssues(elements, { title: "QA 11B target", lang: "en", viewport: "width=device-width" }), ...links.map(issueOf)];
  const grouped = groupIssues(issues);
  const broken = links.filter(link => link.type === "BROKEN" || link.type === "ERROR").length;
  return {
    scan: { url: "https://qa11b.test/en", finalUrl: "https://qa11b.test/en", title: "QA 11B target", timestamp: new Date().toISOString(), durationMs: 1, navigationStatus: 200 },
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

/** Publishes a VERIFIED baseline via the CLI's own `--write-baseline <path>`
 *  path with a distinct discard `--output`, exactly as the docs prescribe. */
const publishBaseline = (dir: string, baselinePath: string, report: ScanReport = cleanReport()): { stdout: string } => {
  const fixturePath = writeReportFile(dir, report, `fixture-${basename(baselinePath).replace(/\.json$/, "")}-publish.json`);
  const reportOut = join(dir, `publish-${basename(baselinePath).replace(/\.json$/, "")}-report.json`);
  const { status, stdout, stderr } = runCli(["--report", fixturePath, "--output", reportOut, "--history-dir", join(dir, "history-publish"), "--write-baseline", baselinePath, "--execute", "none"], dir);
  assert.equal(status, CI_EXIT_SUCCESS, `publish failed: ${stdout}\n${stderr}`);
  return { stdout };
};

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const baseArgs = (dir: string, reportPath: string, outputName: string): string[] => [
  "--report", reportPath,
  "--output", join(dir, outputName),
  "--history-dir", join(dir, "history"),
  "--execute", "none",
];

const snapshotTree = (root: string): Map<string, { size: number; mtimeMs: number }> => {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  return out;
};

/** Committed QA artifact set that NO other test file writes to concurrently
 *  (the suite's live-crawl tests only touch `reports/crawl/`, which is
 *  deliberately excluded here — comparing the whole tree would race). */
const snapshotCommittedArtifacts = (): { paths: Map<string, { size: number; mtimeMs: number }>; root: string[]; historyRuns: string[] } => {
  const repo = process.cwd();
  const paths = new Map<string, { size: number; mtimeMs: number }>();
  for (const name of ["qa-analysis.json", "qa-analysis.html", "qa-execution.json", "qa-baseline.json", "qa-baseline.json.meta.json"]) {
    const p = join(repo, "reports", name);
    if (!existsSync(p)) continue;
    const stat = statSync(p);
    paths.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const historyRuns = existsSync(join(repo, "reports", "history", "runs")) ? readdirSync(join(repo, "reports", "history", "runs")).filter(n => n.endsWith(".json")).sort() : [];
  return { paths, root: readdirSync(repo).sort(), historyRuns };
};

const assertCommittedArtifactsUnchanged = (before: { paths: Map<string, { size: number; mtimeMs: number }>; root: string[]; historyRuns: string[] }): void => {
  const after = snapshotCommittedArtifacts();
  assert.deepEqual(after.root, before.root, "repo root listing is identical");
  assert.deepEqual(Array.from(after.paths.entries()), Array.from(before.paths.entries()), "committed artifact bytes/mtimes are identical");
  assert.deepEqual(after.historyRuns, before.historyRuns, "committed history run list is identical");
};

// --- deterministic equivalence ---------------------------------------------

test("two equivalent runs differ in raw JSON but normalize to an identical artifact", () => {
  const dirA = tempDir();
  const dirB = tempDir();
  publishBaseline(dirA, join(dirA, "qa-baseline.json"));
  publishBaseline(dirB, join(dirB, "qa-baseline.json"));

  const fixtureA = writeReportFile(dirA, cleanReport(), "fixture.json");
  const fixtureB = writeReportFile(dirB, cleanReport(), "fixture.json");
  const outA = join(dirA, "out-a.json");
  const outB = join(dirB, "out-b.json");

  const ra = runCli([...baseArgs(dirA, fixtureA, "out-a.json"), "--baseline", join(dirA, "qa-baseline.json")], dirA);
  const rb = runCli([...baseArgs(dirB, fixtureB, "out-b.json"), "--baseline", join(dirB, "qa-baseline.json")], dirB);
  assert.equal(ra.status, CI_EXIT_SUCCESS, `run A failed:\n${ra.stdout}\n${ra.stderr}`);
  assert.equal(rb.status, CI_EXIT_SUCCESS, `run B failed:\n${rb.stdout}\n${rb.stderr}`);

  const analysisA = JSON.parse(readFileSync(outA, "utf8")) as Record<string, unknown>;
  const analysisB = JSON.parse(readFileSync(outB, "utf8")) as Record<string, unknown>;
  assert.notEqual(JSON.stringify(analysisA), JSON.stringify(analysisB), "raw artifacts differ (runtime fields)");
  const runsOf = (x: Record<string, unknown>) => (x.regression as Record<string, unknown>).runs as Record<string, { runId: string }>;
  assert.notEqual(runsOf(analysisA).current!.runId, runsOf(analysisB).current!.runId, "regression run ids differ per run");
  assert.equal(deterministicArtifactKey(analysisA), deterministicArtifactKey(analysisB), "normalized artifacts are identical");
  assert.equal(normalizedArtifactsEqual(analysisA, analysisB), true);
});

test("normalized reports never leak absolute paths, ISO timestamps, or run ids", () => {
  const dir = tempDir();
  publishBaseline(dir, join(dir, "qa-baseline.json"));
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const out = join(dir, "out.json");
  const { status, stdout, stderr } = runCli([...baseArgs(dir, fixture, "out.json"), "--baseline", join(dir, "qa-baseline.json")], dir);
  assert.equal(status, CI_EXIT_SUCCESS, stdout + stderr);

  const key = deterministicArtifactKey(JSON.parse(readFileSync(out, "utf8")));
  const drivePath = /(?<![A-Za-z])[A-Za-z]:[\\/]/;
  assert.ok(!drivePath.test(key), "no absolute path leaks (starts like a drive or UNC)");
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(key), "no ISO timestamp leaks");
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/.test(key), "no run id leaks");
  assert.ok(key.includes("<machine-path>"), "machine paths are stubbed");
  assert.ok(key.includes("<runtime-timestamp>"), "timestamps are stubbed");
  assert.ok(key.includes("<runtime-duration-ms>"), "durations are stubbed");
  assert.ok(key.includes("<runtime-run-id>"), "run ids are stubbed");
  assert.ok(key.includes("https://qa11b.test/en"), "semantic site identity is preserved");
});

// --- isolation: nothing escapes the run directory --------------------------

test("a normal CI run never writes into the committed artifact set or the repo root", () => {
  const committed = snapshotCommittedArtifacts();

  const dir = tempDir();
  const baselinePath = join(dir, "reports", "qa-baseline.json");
  publishBaseline(dir, baselinePath);
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  // No --history-dir: the DEFAULT history location (cwd/reports/history) applies.
  const { status, stdout, stderr } = runCli(["--report", fixture, "--output", join(dir, "qa-analysis.json"), "--baseline", baselinePath, "--execute", "none"], dir);
  assert.equal(status, CI_EXIT_SUCCESS, stdout + stderr);

  assert.ok(existsSync(join(dir, "reports", "history", "index.json")), "default history stays inside the run cwd");
  assertCommittedArtifactsUnchanged(committed);
});

// --- guard: bare value-taking options are rejected --------------------------

test("bare --write-baseline is a usage error and creates no stray file", () => {
  const dir = tempDir();
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const rootBefore = readdirSync(dir).sort();
  const { status, stdout, stderr } = runCli([...baseArgs(dir, fixture, "out.json"), "--write-baseline", "--execute", "none"], dir);
  const combined = stdout + stderr;
  assert.equal(status, CI_EXIT_POLICY_FAILURE, "non-CI usage error exits 1");
  assert.ok(combined.includes("--write-baseline requires a value"), combined);
  assert.deepEqual(readdirSync(dir).sort(), rootBefore, "no stray file appears in the run cwd");
});

// --- guard: output collisions fail before any write -------------------------

test("a report cannot be written over the loaded --baseline artifact", () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  publishBaseline(dir, baselinePath);
  const before = sha256(baselinePath);
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const { status, stdout, stderr } = runCli(["--report", fixture, "--output", baselinePath, "--history-dir", join(dir, "history"), "--baseline", baselinePath, "--execute", "none"], dir);
  const combined = stdout + stderr;
  assert.equal(status, CI_EXIT_POLICY_FAILURE);
  assert.ok(combined.includes("must not be the loaded --baseline artifact"), combined);
  assert.equal(sha256(baselinePath), before, "the baseline bytes are untouched");
});

test("a report cannot be written over the --write-baseline target or its sidecar", () => {
  const dir = tempDir();
  const target = join(dir, "publish-target.json");
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const attempts: Array<{ args: string[]; banned: string[] }> = [
    // --output == --write-baseline target
    { args: ["--report", fixture, "--output", target, "--history-dir", join(dir, "history"), "--execute", "none", "--write-baseline", target], banned: [target, `${target}.meta.json`] },
    // --output == the sidecar path
    { args: ["--report", fixture, "--output", `${target}.meta.json`, "--history-dir", join(dir, "history"), "--execute", "none", "--write-baseline", target], banned: [target, `${target}.meta.json`] },
  ];
  for (const { args, banned } of attempts) {
    const { status, stdout, stderr } = runCli(args, dir);
    const combined = stdout + stderr;
    assert.equal(status, CI_EXIT_POLICY_FAILURE, combined);
    assert.ok(combined.includes("must not be the --write-baseline"), combined);
    for (const p of banned) assert.ok(!existsSync(p), `nothing was written to ${basename(p)}`);
  }
});

test("a baseline cannot be published over the very artifact it compares against", () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  publishBaseline(dir, baselinePath);
  const before = sha256(baselinePath);
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const { status, stdout, stderr } = runCli([...baseArgs(dir, fixture, "out.json"), "--baseline", baselinePath, "--write-baseline", baselinePath], dir);
  const combined = stdout + stderr;
  assert.equal(status, CI_EXIT_POLICY_FAILURE);
  assert.ok(combined.includes("must not be the --baseline artifact"), combined);
  assert.equal(sha256(baselinePath), before, "the comparison baseline is untouched");
});

// --- baseline/sidecar digest consistency -----------------------------------

test("publishing a baseline writes a digest sidecar matching the artifact bytes, differing between runs and stateless on rewrites", () => {
  const dir = tempDir();
  const one = join(dir, "qa-baseline.json");
  const two = join(dir, "qa-baseline-two.json");
  publishBaseline(dir, one, cleanReport());
  publishBaseline(dir, two, highFindingReport());

  const metaOne = JSON.parse(readFileSync(`${one}.meta.json`, "utf8")) as { digest: string };
  const metaTwo = JSON.parse(readFileSync(`${two}.meta.json`, "utf8")) as { digest: string };
  assert.equal(metaOne.digest, sha256(one), "sidecar digest matches artifact bytes");
  assert.equal(metaTwo.digest, sha256(two), "sidecar digest matches artifact bytes");
  assert.notEqual(metaOne.digest, metaTwo.digest, "digests differ between runs");

  const v1 = runCli(["verify", one], dir);
  const v2 = runCli(["verify", two], dir);
  assert.equal(v1.status, BASELINE_VERIFY_EXIT_OK, v1.stdout + v1.stderr);
  assert.equal(v2.status, BASELINE_VERIFY_EXIT_OK, v2.stdout + v2.stderr);
  assert.equal(sha256(one), metaOne.digest, "publishing the second baseline did not touch the first");
});

test("rewriting a baseline keeps the sidecar consistent with the new bytes", () => {
  const dir = tempDir();
  const path = join(dir, "rewritten.json");
  publishBaseline(dir, path, cleanReport());
  const oldBytes = sha256(path);
  const oldMeta = JSON.parse(readFileSync(`${path}.meta.json`, "utf8"));
  // simulate a clean re-publish (delete-old-then-publish, the only supported rewrite)
  rmSync(`${path}.meta.json`);
  rmSync(path);
  publishBaseline(dir, path, highFindingReport());
  const newBytes = sha256(path);
  const newMeta = JSON.parse(readFileSync(`${path}.meta.json`, "utf8")) as { digest: string };
  assert.notEqual(newBytes, oldBytes, "rewrite produced different bytes");
  assert.notEqual(newMeta.digest, oldMeta.digest, "rewrite produced a new digest");
  assert.equal(newMeta.digest, newBytes, "the new sidecar matches the new bytes");
  const v = runCli(["verify", path], dir);
  assert.equal(v.status, BASELINE_VERIFY_EXIT_OK, v.stdout + v.stderr);
});

test("tampering with a verified baseline is rejected by the existing verifier", () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  publishBaseline(dir, baselinePath);
  const ok = runCli(["verify", baselinePath], dir);
  assert.equal(ok.status, BASELINE_VERIFY_EXIT_OK, ok.stdout + ok.stderr);

  writeFileSync(baselinePath, readFileSync(baselinePath, "utf8") + "\n ", "utf8");
  const bad = runCli(["verify", baselinePath], dir);
  const combined = bad.stdout + bad.stderr;
  assert.equal(bad.status, BASELINE_VERIFY_EXIT_FAILURE, combined);
  assert.ok(combined.includes("BASELINE VERIFY: FAIL"), combined);
});

// --- history snapshots vs regression baselines -----------------------------

test("history snapshots stay structurally distinct from regression baselines and fail baseline verification", () => {
  const dir = tempDir();
  publishBaseline(dir, join(dir, "qa-baseline.json"));
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const out = join(dir, "out.json");
  const { status } = runCli([...baseArgs(dir, fixture, "out.json"), "--baseline", join(dir, "qa-baseline.json")], dir);
  assert.equal(status, CI_EXIT_SUCCESS);

  const index = JSON.parse(readFileSync(join(dir, "history", "index.json"), "utf8")) as { sites: Array<{ runs: Array<{ runId: string }> }> };
  const runId = index.sites[0]!.runs[0]!.runId;
  const runArtifact = join(dir, "history", "runs", `${runId}.json`);
  const snapshot = JSON.parse(readFileSync(runArtifact, "utf8")) as Record<string, unknown>;
  assert.equal(snapshot.runId, runId, "history snapshots carry a runId");
  assert.ok("siteKey" in snapshot && "identityDigest" in snapshot, "history snapshots carry site identity");
  assert.equal(snapshot.scan, undefined, "history snapshots are NOT full scan reports");
  assert.equal(snapshot.generatedAt, undefined, "history snapshots are NOT full QaAnalysis reports");

  const asBaseline = runCli(["verify", runArtifact], dir);
  assert.equal(asBaseline.status, BASELINE_VERIFY_EXIT_FAILURE, "a history snapshot cannot be used as a baseline");
  assert.ok((asBaseline.stdout + asBaseline.stderr).includes("not a QaAnalysis artifact"), asBaseline.stdout + asBaseline.stderr);

  const asReport = runCli(["verify", out], dir);
  assert.equal(asReport.status, BASELINE_VERIFY_EXIT_OK, "the full report IS a structure-valid QaAnalysis baseline");
});

// --- repeated runs: append-only, no mutation of prior artifacts ------------

test("repeated runs do not mutate prior report artifacts; history is append-only", () => {
  const dir = tempDir();
  publishBaseline(dir, join(dir, "qa-baseline.json"));
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const out1 = join(dir, "out-1.json");

  const run1 = runCli([...baseArgs(dir, fixture, "out-1.json"), "--baseline", join(dir, "qa-baseline.json")], dir);
  assert.equal(run1.status, CI_EXIT_SUCCESS, run1.stdout + run1.stderr);
  const run1Bytes = sha256(out1);
  const index1 = JSON.parse(readFileSync(join(dir, "history", "index.json"), "utf8")) as { sites: Array<{ runs: Array<{ runId: string }> }> };
  const run1Artifact = join(dir, "history", "runs", `${index1.sites[0]!.runs[0]!.runId}.json`);
  const run1ArtifactBytes = sha256(run1Artifact);

  const run2 = runCli([...baseArgs(dir, fixture, "out-2.json"), "--baseline", join(dir, "qa-baseline.json")], dir);
  assert.equal(run2.status, CI_EXIT_SUCCESS, run2.stdout + run2.stderr);

  assert.equal(sha256(out1), run1Bytes, "the first report is byte-identical after a second run");
  assert.equal(sha256(run1Artifact), run1ArtifactBytes, "the first history snapshot is byte-identical after a second run");
  const index2 = JSON.parse(readFileSync(join(dir, "history", "index.json"), "utf8")) as { sites: Array<{ runs: Array<{ runId: string }> }> };
  assert.equal(index2.sites[0]!.runs.length, index1.sites[0]!.runs.length + 1, "history is append-only");
  // NOTE: normalized keys of out-1 vs out-2 are NOT asserted equal here —
  // history.accumulated context (runsAvailable, historical counts) is MEANINGFUL
  // data and legitimately grows per run. Cross-directory equivalence is proven
  // in the two-equivalent-runs test above against fresh, isolated history.
});

// --- CLI artifact inventory block ------------------------------------------

test("the CLI emits a relative artifact-inventory block with no absolute paths", () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  const { stdout } = publishBaseline(dir, baselinePath);
  const start = stdout.indexOf("Artifacts (");
  assert.ok(start >= 0, `Artifacts block present in:\n${stdout}`);
  const end = stdout.indexOf("QA RESULT", start);
  const block = (end >= 0 ? stdout.slice(start, end) : stdout.slice(start))
    .replace(/\r/g, "")
    .trim();
  assert.ok(!/[a-zA-Z]:[\\/]/.test(block), `the block is relative-only:\n${block}`);
  assert.ok(block.includes("[baseline]"), block);
  assert.ok(block.includes("[baseline-meta]"), block);
  assert.ok(block.includes("[report]"), block);
  assert.ok(block.includes("[history]"), block);
  assert.ok(block.includes("summary:"), block);
  assert.ok(isAbsolute(baselinePath), "precondition: published baseline path was absolute");
  assert.ok(!block.includes(baselinePath), "the absolute baseline path never appears verbatim in the block");
});

// --- temp artifacts never escape (structure-level containment) --------------

test("all produced artifacts live under the run directory tree", () => {
  const committed = snapshotCommittedArtifacts();
  const dir = tempDir();
  publishBaseline(dir, join(dir, "qa-baseline.json"));
  const fixture = writeReportFile(dir, cleanReport(), "fixture.json");
  const { status } = runCli([...baseArgs(dir, fixture, "out.json"), "--baseline", join(dir, "qa-baseline.json")], dir);
  assert.equal(status, CI_EXIT_SUCCESS);

  // Walk the temp tree: every artifact is under the run dir; nothing named
  // "--*" (a swallowed option) exists anywhere.
  const walk = (root: string, acc: string[]): string[] => {
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else acc.push(p);
    }
    return acc;
  };
  const files = walk(dir, []);
  assert.ok(files.length >= 6, `expected report + html + baseline + meta + history index + run artifact, got ${files.length}`);
  for (const file of files) assert.ok(!basename(file).startsWith("--"), `no swallowed-option file: ${basename(file)}`);
  assertCommittedArtifactsUnchanged(committed);
});