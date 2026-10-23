import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunWorkspace, distImportPrefix, pruneStaleSpecDirs } from "../qa/run-workspace.js";
import { renderVerificationSpec } from "../executor/spec.js";
import { renderFlowSpec } from "../flow/spec.js";

const fakeReport = { scan: { url: "https://x.test/" } } as never;

function inTempCwd<T>(fn: (cwd: string) => T): T {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "qa-ws-"));
  process.chdir(dir);
  try { return fn(dir); } finally { process.chdir(previous); }
}

test("two workspaces never share a spec, outcome or Playwright output path", () => {
  inTempCwd(() => {
    const a = createRunWorkspace({ registerExitCleanup: false });
    const b = createRunWorkspace({ registerExitCleanup: false });
    assert.notEqual(a.id, b.id);
    for (const key of ["specDir", "verificationSpec", "flowSpec", "verificationDir", "flowsDir", "outputDir"] as const) {
      assert.notEqual(a[key], b[key], `${key} must differ between runs`);
    }
    assert.match(a.verificationSpec, /^generated\/run-[^/]+\/qa-verification\.spec\.ts$/);
  });
});

test("specs rendered into a run workspace import dist from the right depth and write to that run's directory", () => {
  inTempCwd(() => {
    const ws = createRunWorkspace({ registerExitCleanup: false });
    renderVerificationSpec(fakeReport, [], ws.verificationSpec, { resultsDir: ws.verificationDir });
    renderFlowSpec(fakeReport, [], {} as never, ws.flowSpec, { resultsDir: ws.flowsDir });
    const verification = readFileSync(ws.verificationSpec, "utf8");
    const flows = readFileSync(ws.flowSpec, "utf8");
    assert.match(verification, /from "\.\.\/\.\.\/dist\/executor\/verify\.js"/);
    assert.match(flows, /from "\.\.\/\.\.\/dist\/flow\/execute\.js"/);
    assert.ok(verification.includes(JSON.stringify(ws.verificationDir)));
    assert.ok(flows.includes(JSON.stringify(ws.flowsDir)));
    assert.ok(!verification.includes('"reports/verification"'), "must not fall back to the shared directory");
  });
});

test("default rendering is unchanged for the legacy generated/ location", () => {
  inTempCwd(() => {
    mkdirSync("generated", { recursive: true });
    renderVerificationSpec(fakeReport, [], "generated/qa-verification.spec.ts");
    renderFlowSpec(fakeReport, [], {} as never, "generated/qa-flows.spec.ts");
    const verification = readFileSync("generated/qa-verification.spec.ts", "utf8");
    assert.match(verification, /from "\.\.\/dist\/executor\/verify\.js"/);
    assert.ok(verification.includes('"reports/verification"'));
    assert.ok(readFileSync("generated/qa-flows.spec.ts", "utf8").includes('"reports/flows"'));
    assert.equal(distImportPrefix(join(process.cwd(), "generated", "x.spec.ts")), "../dist");
  });
});

test("cleanup removes generated specs and Playwright output but keeps outcome evidence; QA_KEEP_WORK keeps everything", () => {
  inTempCwd(() => {
    const ws = createRunWorkspace({ registerExitCleanup: false });
    for (const dir of [ws.specDir, ws.verificationDir, ws.outputDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(`${ws.verificationDir}/SC-VER-001.json`, "{}");
    ws.cleanup();
    assert.equal(existsSync(ws.specDir), false);
    assert.equal(existsSync(ws.outputDir), false);
    assert.equal(existsSync(`${ws.verificationDir}/SC-VER-001.json`), true);

    const kept = createRunWorkspace({ registerExitCleanup: false, env: { QA_KEEP_WORK: "1" } });
    mkdirSync(kept.specDir, { recursive: true });
    kept.cleanup();
    assert.equal(existsSync(kept.specDir), true);
  });
});

test("stale run-* spec directories from crashed runs are pruned; fresh ones are left alone", () => {
  inTempCwd(cwd => {
    mkdirSync("generated/run-old", { recursive: true });
    mkdirSync("generated/run-new", { recursive: true });
    mkdirSync("generated/keep-me", { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(join(cwd, "generated/run-old"), old, old);
    utimesSync(join(cwd, "generated/keep-me"), old, old);
    assert.deepEqual(pruneStaleSpecDirs(cwd), ["run-old"]);
    assert.equal(existsSync("generated/run-new"), true);
    assert.equal(existsSync("generated/keep-me"), true);
  });
});
