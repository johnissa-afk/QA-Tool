import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../dashboard/server.js";
import { baselineDigestOf } from "../qa/baseline.js";



const tempDir = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-dashboard-"));

const writeFixture = (dir: string, reportOverrides: object = {}): void => {
  mkdirSync(join(dir, "history", "runs"), { recursive: true });
  writeFileSync(
    join(dir, "qa-analysis.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      mode: "deterministic",
      aiProvider: "deterministic",
      scan: { scan: { url: "https://qa.test/en", title: "QA target" } },
      findings: [],
      flows: [],
      scenarios: [],
      elementScenarios: [],
      verifications: [],
      flowDiscovery: null,
      coverage: null,
      regression: null,
      intelligence: null,
      historicalIntelligence: { status: "AVAILABLE", investigationQueue: [{ priority: "P2", title: "x" }] },
      history: { runsAvailable: 1 },
      execution: null,
      summary: { overallStatus: "REVIEW", issueCount: 3, verified: 1, reproduced: 1, bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 } },
      ...reportOverrides,
    }),
  );
  writeFileSync(join(dir, "qa-analysis.html"), "<html><body>fixture-report</body></html>");
  writeFileSync(
    join(dir, "history", "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      sites: [{
        siteKeyId: "abc123",
        siteIdentity: "https://qa.test|https://qa.test/en|cfg",
        runs: [{ runId: "r1-artifact", completedAt: "2026-09-21T00:01:00.000Z", findingCount: 3, executionReproduced: 1, executionInfraProblems: 0, identityDigest: "0123456789abcdef0123456789abcdef01234567" }],
      }],
    }),
  );
  writeFileSync(join(dir, "history", "runs", "r1-artifact.json"), JSON.stringify({ schemaVersion: 1, runId: "r1-artifact", siteIdentity: "https://qa.test|https://qa.test/en|cfg", findings: [] }));
};

const writeVerifiedBaseline = (path: string): void => {
  const text = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-20T00:00:00.000Z",
    scan: { scan: { url: "https://qa.test/en", title: "QA target" } },
    findings: [],
  });
  writeFileSync(path, text);
  writeFileSync(`${path}.meta.json`, JSON.stringify({ digest: baselineDigestOf(text), runId: "base", sourceUrl: "https://qa.test/en", generatedAt: "2026-09-20T00:00:00.000Z" }));
};

const start = (dir: string) => startDashboard({ reportDir: dir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0, pagePath: join(process.cwd(), "src", "dashboard", "index.html") });

const stop = async (dash: Awaited<ReturnType<typeof startDashboard>>): Promise<void> => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

const get = async (url: string): Promise<{ status: number; body: string; json: unknown }> => {
  const res = await fetch(url);
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }
  return { status: res.status, body, json };
};

test("dashboard serves the UI and health endpoint", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const page = await get(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /AI Website QA/);
    const health = await get(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, service: "ai-website-qa" });
  } finally {
    await stop(dash);
  }
});

test("dashboard exposes the report, history, run artifacts, and HTML report read-only", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const report = await get(`${base}/api/report`);
    assert.equal(report.status, 200);
    assert.equal((report.json as { scan: { scan: { url: string } } }).scan.scan.url, "https://qa.test/en");

    const history = await get(`${base}/api/history`);
    assert.equal(history.status, 200);
    assert.equal((history.json as { sites: unknown[] }).sites.length, 1);

    const run = await get(`${base}/api/runs/r1-artifact`);
    assert.equal(run.status, 200);
    assert.equal((run.json as { runId: string }).runId, "r1-artifact");

    const html = await get(`${base}/report.html`);
    assert.equal(html.status, 200);
    assert.match(html.body, /fixture-report/);

    const state = await get(`${base}/api/state`);
    assert.equal(state.status, 200);
    const payload = state.json as { ok: boolean; report: { summary: { overallStatus: string } }; history: { sites: unknown[] }; artifacts: { historyDir: string }; gate: { enabled: boolean; failed: boolean; minSeverity: string; violations: unknown[] } };
    assert.equal(payload.ok, true);
    assert.equal(payload.report.summary.overallStatus, "REVIEW");
    assert.equal(payload.history.sites.length, 1);
    assert.ok(payload.artifacts.historyDir.endsWith("history"));
    assert.equal(payload.gate.enabled, false, "a report without a baseline comparison is not gated");
    assert.equal(payload.gate.failed, false);
    assert.equal(payload.gate.minSeverity, "HIGH");
    assert.deepEqual(payload.gate.violations, []);
  } finally {
    await stop(dash);
  }
});

test("dashboard reports the CI gate verdict in /api/state for a gated report", async () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  writeVerifiedBaseline(baselinePath);
  writeFixture(dir, {
    findings: [{ id: "QA-F-001", code: "BTN", severity: "HIGH", status: "FAIL" }],
    regression: {
      schemaVersion: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      baselinePath,
      summary: { comparable: true, notComparableReason: null, changeCount: 2, counts: {}, headline: "2 changes" },
      runs: {
        baseline: { runId: "base", runLabel: "baseline", origin: "qa.test", sourceUrl: "https://qa.test/en", scannedAt: "2026-09-20T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" },
        current: { runId: "current", runLabel: "current", origin: "qa.test", sourceUrl: "https://qa.test/en", scannedAt: "2026-09-21T00:00:00.000Z", mode: "deterministic", aiProvider: "deterministic", schemaVersion: 1, configDigest: "cfg" },
      },
      changes: [
        {
          changeId: "R-1", category: "FINDING", classification: "NEW", confidence: "HIGH_CONFIDENCE", confidenceReason: "Present now, absent before.",
          anchor: "BTN|/en", currentReference: "QA-F-001", baselineReference: "(none)",
          summary: "New high-severity finding.", explanation: "Explained.", evidence: ["Verified REPRODUCED"], recommendedAction: "Fix it.",
          relatedFindingIds: ["QA-F-001"], relatedFlowIds: [], relatedCoverageIds: [], relatedRecommendationIds: [],
        },
        {
          changeId: "R-2", category: "FINDING", classification: "FIXED", confidence: "HIGH_CONFIDENCE", confidenceReason: "Absent now, present before.",
          anchor: "LNK|/en", currentReference: "(none)", baselineReference: "QA-F-OLD",
          summary: "Fixed.", explanation: "Gone.", evidence: [], recommendedAction: "",
          relatedFindingIds: ["QA-F-OLD"], relatedFlowIds: [], relatedCoverageIds: [], relatedRecommendationIds: [],
        },
      ],
      aiNotes: null,
    },
  });
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const state = await get(`${base}/api/state`);
    assert.equal(state.status, 200);
    const payload = state.json as { ok: boolean; baselineVerification: { ok: boolean; integrity: string; provenance: { runId: string } }; gate: { enabled: boolean; failed: boolean; minSeverity: string; evaluated: number; violations: { classification: string; findingId: string; severity: string }[] } };
    assert.equal(payload.ok, true);
    assert.equal(payload.baselineVerification.ok, true);
    assert.equal(payload.baselineVerification.integrity, "VERIFIED");
    assert.equal(payload.baselineVerification.provenance.runId, "base");
    assert.equal(payload.gate.enabled, true);
    assert.equal(payload.gate.failed, true);
    assert.equal(payload.gate.evaluated, 1, "only FINDING NEW/REGRESSION changes are gated");
    assert.equal(payload.gate.minSeverity, "HIGH");
    assert.equal(payload.gate.violations.length, 1);
    assert.equal(payload.gate.violations[0]!.classification, "NEW");
    assert.equal(payload.gate.violations[0]!.findingId, "QA-F-001");
    assert.equal(payload.gate.violations[0]!.severity, "HIGH");
  } finally {
    await stop(dash);
  }
});

test("dashboard suppresses the CI gate when the recorded baseline fails verification", async () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  writeVerifiedBaseline(baselinePath);
  writeFixture(dir, {
    regression: {
      schemaVersion: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      baselinePath,
      summary: { comparable: true, notComparableReason: null, changeCount: 1, counts: {}, headline: "1 change" },
      runs: { baseline: { runId: "base", runLabel: "baseline" }, current: { runId: "current", runLabel: "current" } },
      changes: [],
      aiNotes: null,
    },
  });
  writeFileSync(baselinePath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-09-21T00:00:00.000Z",
    scan: { scan: { url: "https://qa.test/en", title: "QA target" } },
    findings: [],
  }));
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const state = await get(`${base}/api/state`);
    assert.equal(state.status, 200);
    const payload = state.json as { baselineVerification: { ok: boolean; error: string }; gate: { enabled: boolean; failed: boolean } };
    assert.equal(payload.baselineVerification.ok, false);
    assert.match(payload.baselineVerification.error, /failed digest verification/);
    assert.equal(payload.gate.enabled, false);
    assert.equal(payload.gate.failed, false);
  } finally {
    await stop(dash);
  }
});

test("dashboard refuses traversal and unknown artifacts", async () => {
  const dir = tempDir();
  writeFixture(dir);
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const traversal = await get(`${base}/api/runs/${encodeURIComponent("..%2F..%2Fqa-analysis.json")}`);
    assert.equal(traversal.status, 400, "traversal run ids are rejected");
    const pathTraversal = await get(`${base}/api/runs/..%5C..%5Cpackage.json`);
    assert.equal(pathTraversal.status, 400, "backslash traversal is rejected");
    const missing = await get(`${base}/api/runs/does-not-exist`);
    assert.equal(missing.status, 404);
    const notFound = await get(`${base}/api/bogus`);
    assert.equal(notFound.status, 404);
    const favicon = await get(`${base}/favicon.ico`);
    assert.equal(favicon.status, 204);
  } finally {
    await stop(dash);
  }
});

test("dashboard reports a missing report honestly", async () => {
  const dir = tempDir();
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const report = await get(`${base}/api/report`);
    assert.equal(report.status, 404);
    const state = await get(`${base}/api/state`);
    const payload = state.json as { ok: boolean; report: null; history: { sites: unknown[] } };
    assert.equal(payload.ok, false);
    assert.equal(payload.report, null);
    assert.deepEqual(payload.history.sites, []);
    const html = await get(`${base}/report.html`);
    assert.equal(html.status, 404);
  } finally {
    await stop(dash);
  }
});

// --- Phase 10D: baseline age + rotation in the home view ---------------------

test("dashboard exposes the baseline age and the configured rotation policy in /api/state", async () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  writeVerifiedBaseline(baselinePath); // generatedAt 2026-09-20T00:00:00.000Z
  writeFixture(dir, {
    regression: {
      schemaVersion: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      baselinePath,
      summary: { comparable: true, notComparableReason: null, changeCount: 1, counts: {}, headline: "1 change" },
      runs: { baseline: { runId: "base", runLabel: "baseline" }, current: { runId: "current", runLabel: "current" } },
      changes: [],
      aiNotes: null,
    },
  });
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    baselineMaxAge: "1h",
  });
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const state = await get(`${base}/api/state`);
    assert.equal(state.status, 200);
    const payload = state.json as {
      baselineMaxAge: string | null;
      baselineVerification: { ok: boolean; age: { ms: number; source: string } | null; staleness: string | null };
    };
    assert.equal(payload.baselineMaxAge, "1h");
    assert.equal(payload.baselineVerification.ok, true);
    assert.ok(payload.baselineVerification.age, "the baseline card gets an age");
    assert.equal(payload.baselineVerification.age!.source, "generatedAt", "a sidecar without writtenAt falls back to the artifact timestamp");
    assert.ok(payload.baselineVerification.age!.ms > 0);
    assert.equal(payload.baselineVerification.staleness, "STALE", "a 2-day-old baseline exceeds a 1h rotation policy");
  } finally {
    await stop(dash);
  }
});

test("dashboard reports FRESH when the rotation policy easily covers the baseline age", async () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  writeVerifiedBaseline(baselinePath);
  writeFixture(dir, {
    regression: {
      schemaVersion: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      baselinePath,
      summary: { comparable: true, notComparableReason: null, changeCount: 1, counts: {}, headline: "1 change" },
      runs: { baseline: { runId: "base", runLabel: "baseline" }, current: { runId: "current", runLabel: "current" } },
      changes: [],
      aiNotes: null,
    },
  });
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    baselineMaxAge: "10000d",
  });
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const state = await get(`${base}/api/state`);
    const payload = state.json as { baselineVerification: { staleness: string | null } };
    assert.equal(payload.baselineVerification.staleness, "FRESH");
  } finally {
    await stop(dash);
  }
});

test("dashboard defaults to no rotation policy (staleness null) when --baseline-max-age is absent", async () => {
  const dir = tempDir();
  const baselinePath = join(dir, "qa-baseline.json");
  writeVerifiedBaseline(baselinePath);
  writeFixture(dir, {
    regression: {
      schemaVersion: 1,
      generatedAt: "2026-09-21T00:00:00.000Z",
      baselinePath,
      summary: { comparable: true, notComparableReason: null, changeCount: 1, counts: {}, headline: "1 change" },
      runs: { baseline: { runId: "base", runLabel: "baseline" }, current: { runId: "current", runLabel: "current" } },
      changes: [],
      aiNotes: null,
    },
  });
  const dash = await start(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const state = await get(`${base}/api/state`);
    const payload = state.json as { baselineMaxAge: string | null; baselineVerification: { staleness: string | null } | null };
    assert.equal(payload.baselineMaxAge, null);
    assert.equal(payload.baselineVerification?.staleness, null, "the card shows the age but takes no position without a policy");
  } finally {
    await stop(dash);
  }
});

test("dashboard rejects an invalid --baseline-max-age value", () => {
  const dir = tempDir();
  writeFixture(dir);
  assert.throws(
    () => startDashboard({ reportDir: dir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0, pagePath: join(process.cwd(), "src", "dashboard", "index.html"), baselineMaxAge: "30" }),
    /Invalid baseline max-age/,
  );
});
