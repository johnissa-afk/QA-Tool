// ---------------------------------------------------------------------------
// Phase 10A — baseline lifecycle: verified baseline loading.
//
// Runs compare against a previous artifact via `--baseline <path>`. That
// artifact is now loaded through THIS module instead of a blind JSON.parse:
//
//   - Structural validation always (must be a comparable QaAnalysis baseline:
//     scan.scan.url + findings + generatedAt).
//   - Integrity verification when the `<path>.meta.json` sidecar written by
//     `--write-baseline` exists: the exact sha256 digest of the artifact is
//     recomputed and compared. A mismatch is a hard error.
//   - Provenance reporting (run id / source / written-at / generated-at) so
//     the CLI, report, and CI output can say which baseline was compared
//     against and whether its content can be trusted.
//
// Phase 5-era baselines have no sidecar. They stay supported: structure is
// still validated, and integrity is reported as not verifiable. This is a
// lifecycle addition, never a second baseline system — `--write-baseline`
// stays the only writer, `--baseline` the only reader.
//
// Phase 10D — rotation / lifecycle management. A baseline describes the
// website at the moment it was published, so it decays. The loader now also
// computes the baseline AGE from the recorded timestamp (`writtenAt` in the
// sidecar when present, else the artifact's own `generatedAt` — always
// available for a structurally valid baseline), and the CLI can enforce a
// ROTATION POLICY via `--baseline-max-age <duration>` (or `baseline.maxAge`
// in qa.config.json): in CI a stale baseline is a QA/policy failure (exit 1)
// that tells the team to re-publish with `--write-baseline`. The age always
// comes from the actual artifact + sidecar — never reconstructed from history.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { QaAnalysis } from "../ai/types.js";

export const BASELINE_META_SCHEMA_VERSION = 1;

/** The `<path>.meta.json` sidecar written by `--write-baseline` (Phase 9). */
export type BaselineMeta = {
  schemaVersion?: number;
  baselinePath?: string;
  writtenAt?: string;
  runId?: string | null;
  sourceUrl?: string | null;
  generatedAt?: string;
  /** sha256 hex digest of the exact artifact bytes written by --write-baseline. */
  digest?: string;
  note?: string;
};

/** VERIFIED = sidecar present and the sha256 digest of the artifact matches.
 *  LEGACY_NO_META = no sidecar (Phase 5 artifact); structure validated, content
 *  integrity cannot be verified. A sidecar whose digest mismatches never
 *  returns — it is a hard error. */
export type BaselineIntegrity = "VERIFIED" | "LEGACY_NO_META";

export type BaselineProvenance = {
  runId: string | null;
  sourceUrl: string | null;
  writtenAt: string | null;
  generatedAt: string;
};

export type LoadedBaseline = {
  analysis: QaAnalysis;
  /** Absolute path of the loaded artifact. */
  path: string;
  integrity: BaselineIntegrity;
  meta: BaselineMeta | null;
  provenance: BaselineProvenance;
  /** Phase 10D: elapsed time since this baseline was recorded, when a usable
   *  timestamp exists (writtenAt, else the artifact's generatedAt). */
  age: BaselineAgeInfo | null;
};

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const baselineError = (path: string, detail: string): Error =>
  new Error(`Invalid baseline ${basename(path)}: ${detail}`);

/** Where the sidecar for a baseline artifact lives. */
export const baselineMetaPathOf = (path: string): string => `${path}.meta.json`;

export const baselineDigestOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** sha256 over the exact bytes of the artifact file (matches what
 *  `--write-baseline` hashed). */
export const baselineDigestOfFile = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseBaselineMeta(text: string, path: string): BaselineMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw baselineError(`${path}.meta.json`, error instanceof Error ? error.message : String(error));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw baselineError(`${path}.meta.json`, "expected a JSON object.");
  }
  const meta = raw as Record<string, unknown>;
  if (meta.schemaVersion !== undefined && (typeof meta.schemaVersion !== "number" || !Number.isInteger(meta.schemaVersion))) {
    throw baselineError(`${path}.meta.json`, `"schemaVersion" must be an integer (received ${JSON.stringify(meta.schemaVersion)}).`);
  }
  if (typeof meta.digest !== "string" || !SHA256_HEX.test(meta.digest)) {
    throw baselineError(`${path}.meta.json`, `"digest" must be a 64-character lowercase hex sha256 (received ${JSON.stringify(meta.digest)}).`);
  }
  return meta as unknown as BaselineMeta;
}

/** Returns the sidecar when present, or null (Phase 5 artifact). A present but
 *  malformed sidecar is a hard error — a broken sidecar is never ignored. */
export function readBaselineMeta(path: string): BaselineMeta | null {
  const metaPath = baselineMetaPathOf(path);
  if (!existsSync(metaPath)) return null;
  return parseBaselineMeta(readFileSync(metaPath, "utf8"), path);
}

/** Validates that a parsed value is a comparable QaAnalysis baseline artifact.
 *  Structural checks only — staying aligned with what compareRuns needs. */
export function assertBaselineAnalysis(value: unknown, path: string): QaAnalysis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw baselineError(path, "not a QaAnalysis artifact (expected a JSON object).");
  }
  const record = value as Record<string, unknown>;
  const scan = record.scan;
  if (typeof scan !== "object" || scan === null) {
    throw baselineError(path, "not a QaAnalysis artifact (missing scan.scan.url).");
  }
  const scanUrl = (scan as Record<string, unknown>).scan;
  if (typeof scanUrl !== "object" || scanUrl === null || typeof (scanUrl as Record<string, unknown>).url !== "string") {
    throw baselineError(path, "not a QaAnalysis artifact (missing scan.scan.url).");
  }
  if (!Array.isArray(record.findings)) {
    throw baselineError(path, "not a QaAnalysis artifact (missing findings array).");
  }
  if (typeof record.generatedAt !== "string") {
    throw baselineError(path, "not a QaAnalysis artifact (missing generatedAt).");
  }
  return value as QaAnalysis;
}

export const baselineProvenanceOf = (analysis: QaAnalysis, meta: BaselineMeta | null): BaselineProvenance => ({
  runId: meta?.runId ?? analysis.history?.currentRunId ?? null,
  sourceUrl: meta?.sourceUrl ?? null,
  writtenAt: meta?.writtenAt ?? null,
  generatedAt: meta?.generatedAt ?? analysis.generatedAt,
});

// ---------------------------------------------------------------------------
// Phase 10D — baseline age and rotation policy.
//
// `writtenAt` is published by `--write-baseline` into the sidecar and is the
// most accurate "as of when" marker; Phase 5-era (sidecar-less) artifacts fall
// back to the artifact's own `generatedAt`, so EVERY structurally valid
// baseline yields either a computed age or a null age (never a thrown error).
// `UNKNOWN` (null age) is treated as *not enforceable*, keeping legacy
// baselines fail-safe in the "no opinion" direction.
// ---------------------------------------------------------------------------

export type BaselineAgeSource = "writtenAt" | "generatedAt";

export type BaselineAgeInfo = {
  /** Whole elapsed milliseconds since the recorded timestamp (clamped >= 0). */
  ms: number;
  /** Which recorded timestamp the age was computed from. */
  source: BaselineAgeSource;
};

export type BaselineStaleness = "FRESH" | "STALE" | "UNKNOWN";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const BASELINE_MAX_AGE_UNITS: Record<string, number> = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
};

/** Strict parser shared by `--baseline-max-age` and `baseline.maxAge`:
 *  `<int><m|h|d|w>` (e.g. "30d", "12h", "90m", "2w"). Throws on anything else. */
export function parseBaselineMaxAge(value: string): number {
  const match = /^(\d+)([mhdw])$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid baseline max-age "${value}" — use <number>m|h|d|w (e.g. "30d", "12h", "90m").`);
  }
  return Number(match[1]) * BASELINE_MAX_AGE_UNITS[match[2]!.toLowerCase()]!;
}

/** Elapsed time since the recorded timestamp. The recorded timestamp is
 *  `writtenAt` when the sidecar provides one — otherwise `generatedAt` (the
 *  artifact's own, or the sidecar's). Returns null when no usable timestamp
 *  exists (age cannot be computed → the rotation policy is not enforceable). */
export function baselineAgeOf(
  meta: Pick<BaselineMeta, "writtenAt" | "generatedAt"> | null,
  fallbackGeneratedAt: string | null,
  now?: Date,
): BaselineAgeInfo | null {
  const timestamp = (meta?.writtenAt || meta?.generatedAt) || fallbackGeneratedAt;
  if (typeof timestamp !== "string" || timestamp === "") return null;
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return null;
  const ms = Math.max(0, (now?.getTime() ?? Date.now()) - time);
  return { ms, source: typeof meta?.writtenAt === "string" ? "writtenAt" : "generatedAt" };
}

/** Evaluates an age against a rotation policy. Returns null when no policy is
 *  configured (options.maxAgeMs) — the CLI prints the age for visibility and
 *  takes no position. An UNKNOWN age is never a failure. */
export function baselineStalenessOf(age: BaselineAgeInfo | null, maxAgeMs: number | null): BaselineStaleness | null {
  if (maxAgeMs == null) return null;
  if (age == null) return "UNKNOWN";
  return age.ms > maxAgeMs ? "STALE" : "FRESH";
}

/** Compact, deterministic human rendering: "30d", "2d 4h 5m", "0s", … */
export function formatBaselineAge(age: BaselineAgeInfo | null): string {
  if (!age) return "unknown (no recorded timestamp)";
  const d = Math.floor(age.ms / DAY_MS);
  const h = Math.floor((age.ms % DAY_MS) / HOUR_MS);
  const m = Math.floor((age.ms % HOUR_MS) / MINUTE_MS);
  const s = Math.floor((age.ms % MINUTE_MS) / 1000);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return `${parts.join(" ")} (from ${age.source})`;
}

/** Persistent-options (de)serialization for the rotation policy, so a CLI
 *  max-age flows into the report and dashboard as a human-readable label. */
export function baselineMaxAgeLabel(maxAgeMs: number): string {
  if (maxAgeMs % WEEK_MS === 0) return `${Math.round(maxAgeMs / WEEK_MS)}w`;
  if (maxAgeMs % DAY_MS === 0) return `${Math.round(maxAgeMs / DAY_MS)}d`;
  if (maxAgeMs % HOUR_MS === 0) return `${Math.round(maxAgeMs / HOUR_MS)}h`;
  if (maxAgeMs % MINUTE_MS === 0) return `${Math.round(maxAgeMs / MINUTE_MS)}m`;
  return `${maxAgeMs}ms`;
}

// ---------------------------------------------------------------------------

/** Loads, validates, and (when possible) integrity-verifies a baseline
 *  artifact. Throws with a precise message on every failure path:
 *  missing file, malformed JSON, structurally invalid artifact, malformed
 *  sidecar, or a sha256 digest mismatch. */
export function loadBaseline(path: string, options: LoadBaselineOptions = {}): LoadedBaseline {
  if (!existsSync(path)) {
    throw baselineError(path, "no such file — point --baseline at a previous qa-analysis.json (or a --write-baseline artifact).");
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw baselineError(path, `unable to read the file (${error instanceof Error ? error.message : String(error)}).`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw baselineError(path, error instanceof Error ? error.message : String(error));
  }
  const analysis = assertBaselineAnalysis(raw, path);

  const meta = readBaselineMeta(path);
  if (meta) {
    const actual = baselineDigestOfFile(path);
    if (actual !== meta.digest) {
      throw new Error(
        `Baseline ${basename(path)} failed digest verification: sidecar sha256 ${meta.digest?.slice(0, 12)}…, artifact sha256 ${actual.slice(0, 12)}…. ` +
        `The artifact changed after --write-baseline wrote it (or was re-saved, e.g. CRLF line endings). ` +
        `Re-create the baseline with --write-baseline to a fresh path, or remove ${basename(baselineMetaPathOf(path))} to fall back to structure-only loading.`,
      );
    }
  }

  return {
    analysis,
    path: resolve(path),
    integrity: meta ? "VERIFIED" : "LEGACY_NO_META",
    meta,
    provenance: baselineProvenanceOf(analysis, meta),
    age: baselineAgeOf(meta, analysis.generatedAt, options.now),
  };
}

export type LoadBaselineOptions = {
  /** Fixed "now" for deterministic tests and offline verification output. */
  now?: Date;
};

// ---------------------------------------------------------------------------
// Offline baseline verification (`npm run qa verify -- <path>`).
//
// The standalone, pipeline-free surface for loadBaseline: validate a baseline
// artifact exactly the way `--baseline` loads it, with no scan, no comparison,
// and no browser. Deterministic, fully pure, and reuses loadBaseline — there
// is no second loader and no duplicated validation.
// ---------------------------------------------------------------------------

/** Exit code when the artifact is a valid baseline (verified, or legacy). */
export const BASELINE_VERIFY_EXIT_OK = 0;
/** Exit code when the artifact cannot be trusted — the destination of the
 *  existing exit-2 "infrastructure/runtime/tooling failure" model. A corrupt
 *  or unverifiable baseline is never a QA/policy (exit-1) verdict. */
export const BASELINE_VERIFY_EXIT_FAILURE = 2;

export type BaselineVerification = {
  /** Absolute path of the verified artifact. */
  path: string;
  ok: boolean;
  integrity: BaselineIntegrity | null;
  provenance: BaselineProvenance | null;
  /** First 12 hex chars of the verified sha256, when integrity is VERIFIED. */
  digestPrefix: string | null;
  /** Phase 10D: elapsed age when computable, else null. */
  age: BaselineAgeInfo | null;
  /** Phase 10D: FRESH/STALE/UNKNOWN vs the rotation policy, or null when no
   *  policy was supplied (maxAgeMs not provided). */
  staleness: BaselineStaleness | null;
  /** The precise loadBaseline failure message, when not ok. */
  error: string | null;
};

export type BaselineVerifyOptions = {
  /** Phase 10D rotation policy in milliseconds; staleness is evaluated against
   *  it. When omitted (the `verify` subcommand), age is reported but no
   *  position is taken — `verify` keeps its documented 0/2 exit contract. */
  maxAgeMs?: number | null;
  /** Fixed "now" for deterministic tests. */
  now?: Date;
};

/** Runs loadBaseline and captures the outcome instead of throwing. */
export function verifyBaseline(path: string, options: BaselineVerifyOptions = {}): BaselineVerification {
  try {
    const loaded = loadBaseline(path, { now: options.now });
    return {
      path: loaded.path,
      ok: true,
      integrity: loaded.integrity,
      provenance: loaded.provenance,
      digestPrefix: loaded.integrity === "VERIFIED" ? loaded.meta?.digest?.slice(0, 12) ?? null : null,
      age: loaded.age,
      staleness: baselineStalenessOf(loaded.age, options.maxAgeMs ?? null),
      error: null,
    };
  } catch (error) {
    return {
      path: resolve(path),
      ok: false,
      integrity: null,
      provenance: null,
      digestPrefix: null,
      age: null,
      staleness: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Deterministic console rendering of a baseline verification outcome.
 *  Phase 10D adds the `age:` line (time-dependent by nature) and, when a
 *  rotation policy was supplied, the `rotation:` position line. */
export function formatBaselineVerification(verification: BaselineVerification): string {
  if (!verification.ok) {
    return [
      `BASELINE VERIFY: FAIL → exit ${BASELINE_VERIFY_EXIT_FAILURE}`,
      `  path:  ${verification.path}`,
      `  error: ${verification.error ?? "unknown"}`,
    ].join("\n");
  }
  const integrityLine =
    verification.integrity === "VERIFIED"
      ? `  integrity: verified — sha256 ${verification.digestPrefix}…`
      : `  integrity: legacy artifact — no ${basename(baselineMetaPathOf(verification.path))} sidecar (structure validated; digest not verifiable)`;
  const provenance = verification.provenance;
  const source = provenance?.sourceUrl ? ` · source ${provenance.sourceUrl}` : "";
  const lines = [
    `BASELINE VERIFY: PASS → exit ${BASELINE_VERIFY_EXIT_OK}`,
    `  path:  ${verification.path}`,
    integrityLine,
    `  provenance: run ${provenance?.runId ?? "(none)"} · generated ${provenance?.generatedAt ?? "(none)"}${source}`,
  ];
  if (verification.age) {
    lines.push(`  age: ${formatBaselineAge(verification.age)}`);
  }
  if (verification.staleness) {
    lines.push(
      verification.staleness === "STALE"
        ? `  rotation: STALE — baseline exceeds the rotation max-age; re-publish with --write-baseline.`
        : verification.staleness === "FRESH"
          ? `  rotation: fresh — within the rotation max-age.`
          : `  rotation: unknown — no usable timestamp; the rotation policy cannot be evaluated.`,
    );
  }
  return lines.join("\n");
}