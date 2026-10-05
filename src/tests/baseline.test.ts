// ---------------------------------------------------------------------------
// Phase 10A — baseline lifecycle: verified baseline loading tests.
//
// Covers the pure baseline module: structural validation, meta parsing,
// sha256 integrity, provenance, and every hard-error path (missing file,
// malformed JSON, invalid artifact, malformed sidecar, digest mismatch,
// and the legacy no-sidecar artifact).
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaAnalysis } from "../ai/types.js";
import {
  BASELINE_META_SCHEMA_VERSION,
  BASELINE_VERIFY_EXIT_FAILURE,
  BASELINE_VERIFY_EXIT_OK,
  assertBaselineAnalysis,
  baselineAgeOf,
  baselineDigestOf,
  baselineDigestOfFile,
  baselineMaxAgeLabel,
  baselineMetaPathOf,
  baselineProvenanceOf,
  baselineStalenessOf,
  formatBaselineAge,
  formatBaselineVerification,
  loadBaseline,
  parseBaselineMaxAge,
  parseBaselineMeta,
  readBaselineMeta,
  verifyBaseline,
} from "../qa/baseline.js";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "ai-website-qa-baseline-"));

/** Minimum structurally-valid QaAnalysis artifact (what assertBaselineAnalysis requires). */
const analysisFixture = (): QaAnalysis =>
  ({
    schemaVersion: 1,
    generatedAt: "2026-09-21T09:00:00.000Z",
    mode: "deterministic",
    aiProvider: "deterministic",
    scan: {
      scan: {
        url: "https://qa.test/en",
        finalUrl: "https://qa.test/en",
        title: "QA Test",
        timestamp: "2026-09-21T09:00:00.000Z",
        durationMs: 12,
        screenshotPath: "",
        navigationStatus: 200,
      },
    },
    findings: [],
    flows: [],
    scenarios: [],
    elementScenarios: [],
    verifications: [],
    flowDiscovery: null,
    coverage: null,
    regression: null,
    intelligence: null,
    execution: null,
    summary: {
      overallStatus: "UNKNOWN",
      headline: "No findings",
      issueCount: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      intentScenarios: 0,
      flowsDetected: 0,
      flowSummary: null,
      coverageSummary: null,
    },
  }) as unknown as QaAnalysis;

/** Writes an artifact the way `--write-baseline` does (exact text, sidecar digest). */
const writeBaselineFixture = (dir: string): { path: string; digest: string } => {
  const a = analysisFixture();
  const text = JSON.stringify(a, null, 2);
  const digest = createHash("sha256").update(text).digest("hex");
  const path = join(dir, "baseline.json");
  writeFileSync(path, text, "utf8");
  writeFileSync(
    `${path}.meta.json`,
    JSON.stringify(
      {
        schemaVersion: BASELINE_META_SCHEMA_VERSION,
        baselinePath: path,
        writtenAt: "2026-09-21T10:00:00.000Z",
        runId: "2026-09-21T09-00-00-000Z-aaaa1111",
        sourceUrl: "https://qa.test/en",
        generatedAt: a.generatedAt,
        digest,
        note: "Baseline artifact.",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { path, digest };
};

// --- digest helpers ---------------------------------------------------------

test("baselineDigestOf produces a deterministic 64-hex sha256", () => {
  const a = baselineDigestOf("hello");
  const b = baselineDigestOf("hello");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, baselineDigestOf("hello!"));
});

test("baselineDigestOfFile matches baselineDigestOf over the exact file bytes", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "a.json");
    const text = JSON.stringify({ a: [1, 2, 3] }, null, 2);
    writeFileSync(path, text, "utf8");
    assert.equal(baselineDigestOfFile(path), baselineDigestOf(text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- meta parsing -----------------------------------------------------------

test("parseBaselineMeta accepts a valid sidecar and returns its fields", () => {
  const meta = parseBaselineMeta(
    JSON.stringify({ schemaVersion: 1, digest: "a".repeat(64), runId: "r1", sourceUrl: "https://qa.test" }),
    "x.json",
  );
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.digest, "a".repeat(64));
  assert.equal(meta.runId, "r1");
});

test("parseBaselineMeta rejects malformed JSON", () => {
  assert.throws(() => parseBaselineMeta("{ nope", "x.json"), /Invalid baseline x\.json\.meta\.json/);
});

test("parseBaselineMeta rejects a non-object", () => {
  assert.throws(() => parseBaselineMeta("[1,2]", "x.json"), /expected a JSON object/);
});

test("parseBaselineMeta rejects a missing or malformed digest", () => {
  assert.throws(() => parseBaselineMeta("{}", "x.json"), /"digest" must be a 64-character/);
  assert.throws(() => parseBaselineMeta(JSON.stringify({ digest: "not-hex" }), "x.json"), /"digest" must be a 64-character/);
  assert.throws(() => parseBaselineMeta(JSON.stringify({ digest: "ABCDEF".repeat(11) }), "x.json"), /"digest" must be a 64-character/);
});

test("readBaselineMeta returns null when no sidecar exists and parses when present", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "b.json");
    writeFileSync(path, "{}", "utf8");
    assert.equal(readBaselineMeta(path), null);
    writeFileSync(`${path}.meta.json`, JSON.stringify({ digest: "b".repeat(64) }), "utf8");
    assert.equal(readBaselineMeta(path)?.digest, "b".repeat(64));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- structural validation --------------------------------------------------

test("assertBaselineAnalysis accepts a structurally valid artifact", () => {
  const value = analysisFixture();
  assert.equal(assertBaselineAnalysis(value, "a.json"), value);
});

test("assertBaselineAnalysis rejects a non-object", () => {
  assert.throws(() => assertBaselineAnalysis([1], "a.json"), /not a QaAnalysis artifact/);
  assert.throws(() => assertBaselineAnalysis(null, "a.json"), /not a QaAnalysis artifact/);
  assert.throws(() => assertBaselineAnalysis("x", "a.json"), /not a QaAnalysis artifact/);
});

test("assertBaselineAnalysis rejects a missing or non-string scan.scan.url", () => {
  assert.throws(() => assertBaselineAnalysis({}, "a.json"), /missing scan\.scan\.url/);
  assert.throws(() => assertBaselineAnalysis({ scan: { scan: {} } }, "a.json"), /missing scan\.scan\.url/);
  assert.throws(() => assertBaselineAnalysis({ scan: { scan: { url: 42 } }, findings: [] }, "a.json"), /missing scan\.scan\.url/);
});

test("assertBaselineAnalysis rejects missing findings and generatedAt", () => {
  const base = analysisFixture();
  const withoutFindings = { ...base, findings: undefined };
  const withoutGeneratedAt = { ...base, generatedAt: undefined };
  assert.throws(() => assertBaselineAnalysis(withoutFindings, "a.json"), /missing findings array/);
  assert.throws(() => assertBaselineAnalysis(withoutGeneratedAt, "a.json"), /missing generatedAt/);
});

// --- loadBaseline: success paths -------------------------------------------

test("loadBaseline returns VERIFIED with provenance when the sidecar matches", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    const loaded = loadBaseline(path);
    assert.equal(loaded.integrity, "VERIFIED");
    assert.equal(loaded.analysis.scan.scan.url, "https://qa.test/en");
    assert.equal(loaded.provenance.runId, "2026-09-21T09-00-00-000Z-aaaa1111");
    assert.equal(loaded.provenance.sourceUrl, "https://qa.test/en");
    assert.equal(loaded.provenance.generatedAt, "2026-09-21T09:00:00.000Z");
    assert.equal(loaded.path, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline accepts a legacy Phase 5 artifact without a sidecar (LEGACY_NO_META)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8");
    const loaded = loadBaseline(path);
    assert.equal(loaded.integrity, "LEGACY_NO_META");
    assert.equal(loaded.meta, null);
    assert.equal(loaded.provenance.runId, null);
    assert.equal(loaded.provenance.sourceUrl, null);
    assert.equal(loaded.provenance.generatedAt, "2026-09-21T09:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- loadBaseline: error paths ---------------------------------------------

test("loadBaseline rejects a missing file with a clear message", () => {
  assert.throws(() => loadBaseline("reports/does-not-exist-baseline.json"), /no such file/);
});

test("loadBaseline rejects malformed JSON", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => loadBaseline(path), /Invalid baseline bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline rejects a structurally invalid artifact (not a QaAnalysis)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "exec.json");
    writeFileSync(path, JSON.stringify({ tests: 1, passed: 1 }), "utf8");
    assert.throws(() => loadBaseline(path), /not a QaAnalysis artifact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline rejects a digest mismatch (artifact tampered after write)", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    const tampered = { ...analysisFixture(), generatedAt: "2026-09-22T00:00:00.000Z" };
    writeFileSync(path, JSON.stringify(tampered, null, 2), "utf8");
    assert.throws(() => loadBaseline(path), /failed digest verification/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline rejects a malformed sidecar", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "meta.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8");
    writeFileSync(`${path}.meta.json`, "{ broken", "utf8");
    assert.throws(() => loadBaseline(path), /Invalid baseline meta\.json\.meta\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline rejects a sidecar without a digest", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "nodigest.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8");
    writeFileSync(`${path}.meta.json`, JSON.stringify({ schemaVersion: 1 }), "utf8");
    assert.throws(() => loadBaseline(path), /"digest" must be a 64-character/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- provenance -------------------------------------------------------------

test("baselineProvenanceOf falls back to the analysis when the meta is absent", () => {
  const a = analysisFixture();
  const provenance = baselineProvenanceOf(a, null);
  assert.equal(provenance.generatedAt, "2026-09-21T09:00:00.000Z");
  assert.equal(provenance.runId, null);
});

test("baselineProvenanceOf prefers meta fields over analysis fields", () => {
  const a = analysisFixture();
  const provenance = baselineProvenanceOf(a, { runId: "r-meta", sourceUrl: "https://meta.test", generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(provenance.runId, "r-meta");
  assert.equal(provenance.sourceUrl, "https://meta.test");
  assert.equal(provenance.generatedAt, "2026-01-01T00:00:00.000Z");
});

test("baselineMetaPathOf appends the .meta.json suffix", () => {
  assert.equal(baselineMetaPathOf("reports/qa-baseline.json"), "reports/qa-baseline.json.meta.json");
});

// --- verifyBaseline: offline verification (Phase 10B) -----------------------

test("verifyBaseline reports PASS/VERIFIED with provenance when the sidecar matches", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    const verification = verifyBaseline(path);
    assert.equal(verification.ok, true);
    assert.equal(verification.integrity, "VERIFIED");
    assert.equal(verification.error, null);
    assert.equal(verification.digestPrefix?.length, 12);
    assert.match(verification.digestPrefix ?? "", /^[0-9a-f]{12}$/);
    assert.equal(verification.provenance?.runId, "2026-09-21T09-00-00-000Z-aaaa1111");
    assert.equal(verification.provenance?.sourceUrl, "https://qa.test/en");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline reports PASS/LEGACY_NO_META for a legacy Phase 5 artifact", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8");
    const verification = verifyBaseline(path);
    assert.equal(verification.ok, true);
    assert.equal(verification.integrity, "LEGACY_NO_META");
    assert.equal(verification.digestPrefix, null);
    assert.equal(verification.provenance?.runId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline reports FAIL for a missing file", () => {
  const verification = verifyBaseline("reports/does-not-exist-baseline.json");
  assert.equal(verification.ok, false);
  assert.equal(verification.integrity, null);
  assert.equal(verification.provenance, null);
  assert.equal(verification.digestPrefix, null);
  assert.match(verification.error ?? "", /no such file/);
});

test("verifyBaseline reports FAIL for malformed JSON", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json", "utf8");
    const verification = verifyBaseline(path);
    assert.equal(verification.ok, false);
    assert.match(verification.error ?? "", /Invalid baseline bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline reports FAIL for a structurally invalid artifact", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "exec.json");
    writeFileSync(path, JSON.stringify({ tests: 1, passed: 1 }), "utf8");
    const verification = verifyBaseline(path);
    assert.equal(verification.ok, false);
    assert.match(verification.error ?? "", /not a QaAnalysis artifact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline reports FAIL for a digest mismatch", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    const tampered = { ...analysisFixture(), generatedAt: "2026-09-22T00:00:00.000Z" };
    writeFileSync(path, JSON.stringify(tampered, null, 2), "utf8");
    const verification = verifyBaseline(path);
    assert.equal(verification.ok, false);
    assert.match(verification.error ?? "", /failed digest verification/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline reports FAIL for a malformed sidecar", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "meta.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8");
    writeFileSync(`${path}.meta.json`, "{ broken", "utf8");
    const verification = verifyBaseline(path);
    assert.equal(verification.ok, false);
    assert.match(verification.error ?? "", /Invalid baseline meta\.json\.meta\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline never throws — every failure path is a result, not an exception", () => {
  assert.doesNotThrow(() => verifyBaseline("reports/does-not-exist-baseline.json"));
  assert.doesNotThrow(() => verifyBaseline("."));
});

// --- formatBaselineVerification ---------------------------------------------

test("formatBaselineVerification renders a deterministic PASS block", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    const text = formatBaselineVerification(verifyBaseline(path));
    assert.match(text, /BASELINE VERIFY: PASS → exit 0/);
    assert.match(text, /integrity: verified — sha256 [0-9a-f]{12}…/);
    assert.match(text, /provenance: run 2026-09-21T09-00-00-000Z-aaaa1111 · generated 2026-09-21T09:00:00\.000Z · source https:\/\/qa\.test\/en/);
    assert.equal(text, formatBaselineVerification(verifyBaseline(path)), "the block is stable across calls");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatBaselineVerification renders a deterministic legacy PASS block", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8");
    const text = formatBaselineVerification(verifyBaseline(path));
    assert.match(text, /BASELINE VERIFY: PASS → exit 0/);
    assert.match(text, /legacy artifact — no legacy\.json\.meta\.json sidecar/);
    assert.match(text, /provenance: run \(none\) · generated 2026-09-21T09:00:00\.000Z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatBaselineVerification renders a deterministic FAIL block with the precise error", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    writeFileSync(path, "tampered-bytes", "utf8");
    const text = formatBaselineVerification(verifyBaseline(path));
    assert.match(text, /BASELINE VERIFY: FAIL → exit 2/);
    assert.match(text, /error: Invalid baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the verify exit-code contract is 0 for acceptable, 2 for unverifiable", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    assert.equal(BASELINE_VERIFY_EXIT_OK, 0);
    assert.equal(BASELINE_VERIFY_EXIT_FAILURE, 2);
    assert.equal(verifyBaseline(path).ok ? BASELINE_VERIFY_EXIT_OK : BASELINE_VERIFY_EXIT_FAILURE, BASELINE_VERIFY_EXIT_OK);
    const verification = verifyBaseline(join(dir, "missing.json"));
    assert.equal(verification.ok ? BASELINE_VERIFY_EXIT_OK : BASELINE_VERIFY_EXIT_FAILURE, BASELINE_VERIFY_EXIT_FAILURE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Phase 10D: baseline age + rotation policy --------------------------------

test("parseBaselineMaxAge parses <number>m|h|d|w durations in milliseconds", () => {
  const MINUTE = 60_000;
  assert.equal(parseBaselineMaxAge("30d"), 30 * 24 * 60 * MINUTE);
  assert.equal(parseBaselineMaxAge("12h"), 12 * 60 * MINUTE);
  assert.equal(parseBaselineMaxAge("90m"), 90 * MINUTE);
  assert.equal(parseBaselineMaxAge("2w"), 2 * 7 * 24 * 60 * MINUTE);
  assert.equal(parseBaselineMaxAge("1h"), 60 * MINUTE);
  assert.equal(parseBaselineMaxAge("0d"), 0);
});

test("parseBaselineMaxAge is case-insensitive on the unit and trims whitespace", () => {
  assert.equal(parseBaselineMaxAge("30D"), parseBaselineMaxAge("30d"));
  assert.equal(parseBaselineMaxAge(" 7w "), parseBaselineMaxAge("7w"));
});

test("parseBaselineMaxAge rejects malformed durations with a clear message", () => {
  for (const bad of ["30", "d30", "30days", "", "   ", "30x", "abc", "1.5d", "-1h"]) {
    assert.throws(() => parseBaselineMaxAge(bad), /Invalid baseline max-age/);
  }
});

test("baselineMaxAgeLabel round-trips normalized CLI/config durations", () => {
  assert.equal(baselineMaxAgeLabel(parseBaselineMaxAge("30d")), "30d");
  assert.equal(baselineMaxAgeLabel(parseBaselineMaxAge("12h")), "12h");
  assert.equal(baselineMaxAgeLabel(parseBaselineMaxAge("90m")), "90m");
  assert.equal(baselineMaxAgeLabel(parseBaselineMaxAge("2w")), "2w");
});

test("baselineAgeOf prefers writtenAt over generatedAt and computes elapsed ms deterministically", () => {
  const writtenAt = "2026-09-21T10:00:00.000Z";
  const generatedAt = "2026-09-21T09:00:00.000Z";
  const now = new Date("2026-09-22T10:00:00.000Z");
  const age = baselineAgeOf({ writtenAt, generatedAt }, generatedAt, now);
  assert.equal(age?.ms, 24 * 60 * 60_000);
  assert.equal(age?.source, "writtenAt");
});

test("baselineAgeOf falls back to generatedAt when there is no sidecar timestamp", () => {
  const now = new Date("2026-09-22T09:00:00.000Z");
  const age = baselineAgeOf(null, "2026-09-21T09:00:00.000Z", now);
  assert.equal(age?.ms, 24 * 60 * 60_000);
  assert.equal(age?.source, "generatedAt");
});

test("baselineAgeOf returns null when no usable timestamp exists (never throws)", () => {
  assert.equal(baselineAgeOf(null, null, new Date("2026-09-22T09:00:00.000Z")), null);
  assert.equal(baselineAgeOf(null, "", new Date("2026-09-22T09:00:00.000Z")), null);
  assert.equal(baselineAgeOf(null, "not-a-date", new Date("2026-09-22T09:00:00.000Z")), null);
});

test("baselineStalenessOf is FRESH/STALE vs the policy, UNKNOWN for no timestamp, null without a policy", () => {
  const oldAge = baselineAgeOf(null, "2026-09-20T09:00:00.000Z", new Date("2026-09-22T09:00:00.000Z"));
  assert.equal(baselineStalenessOf(oldAge, null), null, "no policy → no position");
  assert.equal(baselineStalenessOf(null, 60_000), "UNKNOWN", "no usable timestamp → not enforceable");
  assert.equal(baselineStalenessOf(oldAge, 60_000), "STALE");
  assert.equal(baselineStalenessOf(oldAge, 48 * 60 * 60_000), "FRESH", "age at exactly the policy bound is fresh");
  assert.equal(baselineStalenessOf({ ms: 1, source: "writtenAt" }, 0), "STALE", "a zero-length policy flags any nonzero age as stale");
  assert.equal(baselineStalenessOf({ ms: 0, source: "writtenAt" }, 0), "FRESH");
});

test("formatBaselineAge renders compact, deterministic durations or 'unknown'", () => {
  assert.equal(formatBaselineAge(null), "unknown (no recorded timestamp)");
  assert.equal(formatBaselineAge({ ms: 0, source: "writtenAt" }), "0s (from writtenAt)");
  assert.equal(formatBaselineAge({ ms: 3 * 24 * 60 * 60_000, source: "writtenAt" }), "3d (from writtenAt)");
  assert.equal(formatBaselineAge({ ms: 2 * 24 * 60 * 60_000 + 4 * 60 * 60_000 + 5 * 60_000, source: "generatedAt" }), "2d 4h 5m (from generatedAt)");
});

test("loadBaseline computes the age from the sidecar writtenAt when now is injected", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir); // writtenAt 2026-09-21T10:00:00.000Z
    const loaded = loadBaseline(path, { now: new Date("2026-09-22T10:00:00.000Z") });
    assert.equal(loaded.age?.ms, 24 * 60 * 60_000);
    assert.equal(loaded.age?.source, "writtenAt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline computes the age from generatedAt for a legacy artifact", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(analysisFixture(), null, 2), "utf8"); // generatedAt 2026-09-21T09:00:00.000Z
    const loaded = loadBaseline(path, { now: new Date("2026-09-22T09:00:00.000Z") });
    assert.equal(loaded.age?.ms, 24 * 60 * 60_000);
    assert.equal(loaded.age?.source, "generatedAt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBaseline reports UNKNOWN-age baselines without failing (legacy compat)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "weird.json");
    const fixture = { ...analysisFixture(), generatedAt: "not-a-date" } as unknown as QaAnalysis;
    writeFileSync(path, JSON.stringify(fixture), "utf8");
    const loaded = loadBaseline(path);
    assert.equal(loaded.age, null);
    assert.equal(baselineStalenessOf(loaded.age, 60_000), "UNKNOWN", "no usable timestamp is never a failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBaseline carries age + staleness against a supplied rotation policy", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir); // writtenAt 2026-09-21T10:00:00.000Z
    const now = new Date("2026-09-25T10:00:00.000Z"); // 4 days later
    const stale = verifyBaseline(path, { maxAgeMs: parseBaselineMaxAge("1h"), now });
    assert.equal(stale.ok, true);
    assert.equal(stale.age?.ms, 4 * 24 * 60 * 60_000);
    assert.equal(stale.staleness, "STALE");

    const fresh = verifyBaseline(path, { maxAgeMs: parseBaselineMaxAge("7d"), now });
    assert.equal(fresh.staleness, "FRESH");

    const noPolicy = verifyBaseline(path);
    assert.equal(noPolicy.staleness, null, "verify keeps its 0/2 contract — no position without a policy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatBaselineVerification adds the age line and the rotation position", () => {
  const dir = tempDir();
  try {
    const { path } = writeBaselineFixture(dir);
    const now = new Date("2026-09-25T10:00:00.000Z");
    const text = formatBaselineVerification(verifyBaseline(path, { maxAgeMs: parseBaselineMaxAge("1h"), now }));
    assert.match(text, /BASELINE VERIFY: PASS → exit 0/);
    assert.match(text, /age: 4d \(from writtenAt\)/);
    assert.match(text, /rotation: STALE — baseline exceeds the rotation max-age/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});