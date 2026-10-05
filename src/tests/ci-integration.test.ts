// ---------------------------------------------------------------------------
// Phase 11D — static GitHub Actions integration checks.
//
// The workflow deliberately contains no exit-code logic: the CLI is the only
// authority for baseline verification, gates, rotation, failure categories,
// and the 0/1/2 result. These checks protect that boundary without adding a
// YAML parser dependency or attempting to emulate GitHub Actions locally.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_CI_COMMAND } from "../qa/ci-contract.js";

const workflowPath = join(process.cwd(), ".github", "workflows", "qa-ci.yml");
const workflow = readFileSync(workflowPath, "utf8");

/**
 * Returns a single workflow step block, from its `- name:` header up to the
 * next step header. Slicing to the next step (rather than to the next named
 * step or to end-of-file) keeps each assertion scoped to exactly one step.
 */
const step = (name: string): string => {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start === -1) return "";
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^\s{6}- (?:name|uses|run):/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
};

test("Phase 11D workflow preserves the canonical CI command and required setup", () => {
  assert.ok(workflow.includes("workflow_dispatch:"));
  assert.ok(workflow.includes("required: true"));
  assert.ok(workflow.includes("actions/setup-node@v4"));
  assert.ok(workflow.includes("npm ci"));
  assert.ok(workflow.includes("npx playwright install --with-deps chromium"));
  assert.ok(workflow.includes("npm run build"));
  assert.ok(workflow.includes('npm run qa -- "${args[@]}" --execute --ci'));
  assert.ok(workflow.includes('args+=(--baseline "$QA_BASELINE")'));
  assert.ok(workflow.includes('args+=(--baseline-max-age "$QA_MAX_AGE")'));
  assert.ok(CANONICAL_CI_COMMAND.includes("npm run qa -- <url> --execute --ci"));
});

test("CI runs the unit test suite before the gate", () => {
  const testStep = step("Run the unit test suite");
  assert.ok(testStep.length > 0, "the unit test step exists");
  assert.ok(testStep.includes("npm test"));
  assert.ok(
    workflow.indexOf("- name: Run the unit test suite") < workflow.indexOf("- name: Run the canonical QA gate command"),
    "tests run before the gate so a broken suite cannot ship green",
  );
});

test("CI resolves a real baseline instead of silently gating nothing", () => {
  // An explicit baseline that does not exist is a hard error, never a no-op.
  assert.match(workflow, /::error::The requested baseline does not exist/);
  // A missing baseline is at minimum a visible warning.
  assert.match(workflow, /::warning::No baseline is available/);
  // `require-baseline` turns the warning into a failure.
  assert.match(workflow, /QA_REQUIRE_BASELINE/);
  // The committed/downloaded baseline directory is used as the fallback, and
  // it lives outside the gitignored reports/ directory.
  assert.match(workflow, /\.qa-baseline\/\*\.json/);
  assert.ok(
    workflow.indexOf("- name: Check that a baseline is available") < workflow.indexOf("- name: Run the canonical QA gate command"),
    "baseline availability is checked before the gate runs",
  );
  // The baseline is a downloaded artifact, not an unreferenced upload.
  assert.ok(workflow.includes("actions/download-artifact@v4"));
  assert.ok(workflow.includes("name: qa-baseline"));
  assert.ok(workflow.includes("--write-baseline .qa-baseline/qa-baseline.json"));
});

test("Phase 11D workflow does not mask the CLI exit code", () => {
  const qaStep = step("Run the canonical QA gate command");
  assert.ok(qaStep.includes("npm run qa --"));
  assert.doesNotMatch(qaStep, /continue-on-error\s*:/);
  assert.doesNotMatch(qaStep, /if:\s*always\(\)/);
  assert.doesNotMatch(qaStep, /\|\s*true\b/);
});

test("Phase 11D uploads diagnostics after failures without publishing the baseline", () => {
  const uploadStep = step("Upload QA reports");
  assert.match(uploadStep, /if:\s*always\(\)/);
  assert.match(uploadStep, /reports\/qa-analysis\.json/);
  assert.match(uploadStep, /reports\/qa-analysis\.html/);
  assert.match(uploadStep, /reports\/qa-execution\.json/);
  assert.match(uploadStep, /test-results\/\*\*/);
  assert.match(uploadStep, /playwright-report\/\*\*/);
  // The always-on diagnostics upload must never carry the baseline: a failing
  // run must not be able to publish a baseline other runs then gate against.
  assert.doesNotMatch(uploadStep, /qa-baseline\.json|baseline\.json/);
});

test("the baseline is only published from a run that already passed", () => {
  const publishStep = step("Publish this run as a baseline candidate");
  assert.ok(publishStep.length > 0, "the publish step exists");
  assert.match(publishStep, /if:\s*\$\{\{ success\(\) && inputs\.publish-baseline == 'true' \}\}/);
  assert.doesNotMatch(publishStep, /if:\s*always\(\)/);
});

test("a cross-run baseline is resolved to an explicit run id before downloading", () => {
  // actions/download-artifact@v4 only searches the CURRENT run by default, so
  // a baseline-artifact name alone would silently resolve to nothing. Both
  // `github-token` and `run-id` are required for a cross-run download.
  const downloadStep = step("Download the baseline artifact from a previous run");
  assert.ok(downloadStep.length > 0, "the download step exists");
  assert.match(downloadStep, /uses:\s*actions\/download-artifact@v4/);
  assert.match(downloadStep, /name:\s*\$\{\{ inputs\.baseline-artifact \}\}/);
  assert.match(downloadStep, /github-token:\s*\$\{\{ github\.token \}\}/, "a token is required to read another run's artifacts");
  assert.match(downloadStep, /run-id:\s*\$\{\{ steps\.baseline-run\.outputs\.run-id \}\}/, "the download targets the resolved run, not the current one");
  assert.doesNotMatch(downloadStep, /run-id:\s*""/);

  // The run id is resolved explicitly, and a caller can pin it.
  const resolveStep = step("Resolve the baseline run id");
  assert.ok(resolveStep.length > 0, "the run id resolution step exists");
  assert.match(resolveStep, /inputs\.baseline-run-id/);
  assert.match(resolveStep, /gh api/);
  assert.match(resolveStep, /status=success/, "only a successful run is eligible as a baseline");
  assert.match(resolveStep, /GITHUB_RUN_ID/, "the in-flight run is excluded");
  assert.match(resolveStep, /GITHUB_OUTPUT/);
  assert.match(resolveStep, /::error::No previous successful run found/);
  assert.ok(
    workflow.indexOf("- name: Resolve the baseline run id") < workflow.indexOf("- name: Download the baseline artifact from a previous run"),
    "the run id is resolved before it is used",
  );

  // Listing runs and reading their artifacts both need the actions scope.
  assert.match(workflow, /^\s{2}actions:\s*read$/m, "the token can read other runs' artifacts");
});

test("Phase 11D keeps credentials secret-backed and optional AI configuration unhardcoded", () => {
  assert.match(workflow, /QA_USERNAME:\s*\$\{\{ secrets\.QA_USERNAME \}\}/);
  assert.match(workflow, /QA_PASSWORD:\s*\$\{\{ secrets\.QA_PASSWORD \}\}/);
  assert.match(workflow, /QA_BASIC_AUTH_USER:\s*\$\{\{ secrets\.QA_BASIC_AUTH_USER \}\}/);
  assert.match(workflow, /QA_BASIC_AUTH_PASSWORD:\s*\$\{\{ secrets\.QA_BASIC_AUTH_PASSWORD \}\}/);
  assert.match(workflow, /QA_AUTHORIZATION:\s*\$\{\{ secrets\.QA_AUTHORIZATION \}\}/);
  assert.match(workflow, /AI_API_KEY:\s*\$\{\{ secrets\.AI_API_KEY \}\}/);
  assert.doesNotMatch(workflow, /QA_(?:USERNAME|PASSWORD|AUTHORIZATION):\s*[^$\s]/);
  assert.doesNotMatch(workflow, /AI_API_KEY:\s*[^$\s]/);
  assert.doesNotMatch(workflow, /QA_BASIC_AUTH_PASSWORD:\s*[^$\s]/);
});