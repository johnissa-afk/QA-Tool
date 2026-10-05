// ---------------------------------------------------------------------------
// Phase 11B — deterministic artifact normalization.
//
// A PURE helper for deterministic comparison and testing of machine-readable
// QA artifacts (the qa-analysis.json report, a --write-baseline artifact, the
// <path>.meta.json sidecar, history run snapshots). It exists so two equivalent
// runs can be proven equivalent WITHOUT deleting the useful runtime metadata
// that production reporting needs:
//
//   - It never modifies the original object (returns a normalized deep copy).
//   - It has no filesystem or network side effects.
//   - It preserves every field it does not explicitly recognize as runtime-
//     specific; findings, evidence, coverage, regression changes, intelligence
//     candidates, configuration values, URLs, and titles survive untouched.
//   - It reuses the project's canonical key-stable serialization (history/store
//     `sortKeys`/`stableJson`) so the normalized form is byte-diffable.
//
// INTENTIONALLY NONDETERMINISTIC FIELDS — normalized to fixed, documented
// sentinels:
//
//   timestamps    every ISO-8601 string: `generatedAt`, `scan.scan.timestamp`,
//                 `summary.scannedAt`, `execution.startedAt`, verification
//                 `executedAt`, intelligence `generatedAt`, history
//                 `startedAt`/`completedAt`, the sidecar `writtenAt`, historical
//                 `firstSeenAt`/`lastSeenAt`/`dateRange.*`, ... → RUNTIME_TIMESTAMP_STUB
//   run ids       `runId` / `currentRunId` values and `runIds` arrays, plus any
//                 string in the history `newRunId` shape → RUNTIME_RUN_ID_STUB
//   durations     `durationMs` numeric values → RUNTIME_DURATION_MS_STUB
//   machine paths absolute-path strings: `configuration.path`,
//                 `configuration.resolved.baselinePath`, `regression.baselinePath`,
//                 `history.historyDir`, scan/verification `screenshotPath`,
//                 the sidecar `baselinePath`, history `artifactPath`s → MACHINE_PATH_STUB
//
// Semantic identity fields are NEVER masked: siteKey / siteIdentity,
// identityDigest, semantic keys, and content are deterministic by construction
// and survive normalization unchanged.
// ---------------------------------------------------------------------------
import { sortKeys, stableJson } from "../history/store.js";

/** Normalized sentinel for any runtime timestamp. */
export const RUNTIME_TIMESTAMP_STUB = "<runtime-timestamp>";
/** Normalized sentinel for any measured run duration. */
export const RUNTIME_DURATION_MS_STUB = "<runtime-duration-ms>";
/** Normalized sentinel for any run id / generated id. */
export const RUNTIME_RUN_ID_STUB = "<runtime-run-id>";
/** Normalized sentinel for any machine-specific absolute path. */
export const MACHINE_PATH_STUB = "<machine-path>";

/** ISO-8601 wall-clock timestamps write `delimiter ":"` after the hour
 *  (`2026-09-22T12:00:00.000Z`). The filename-safe run-id stamp uses `-`
 *  (`2026-09-22T09-30-12-123Z`), so the two patterns can never collide. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The `newRunId` shape from history/identity:
 *  `2026-09-22T09-30-12-123Z-8f3a1c02`. */
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;

/** Absolute paths on win32 (`C:\…`, `\\server\…`) or posix (`/…`). */
const ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]|^\\\\|^\//;

/** Applies the four mask rules to a leaf value identified by its key. */
function normalizeField(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (key === "runId" || key === "currentRunId") return RUNTIME_RUN_ID_STUB;
    if (RUN_ID_PATTERN.test(value)) return RUNTIME_RUN_ID_STUB;
    if (ISO_TIMESTAMP_PATTERN.test(value)) return RUNTIME_TIMESTAMP_STUB;
    if (ABSOLUTE_PATH_PATTERN.test(value)) return MACHINE_PATH_STUB;
    return value;
  }
  if ((key === "runIds") && Array.isArray(value)) {
    return value.map(item => (typeof item === "string" ? RUNTIME_RUN_ID_STUB : item));
  }
  if (key === "durationMs" && typeof value === "number" && Number.isFinite(value)) {
    return RUNTIME_DURATION_MS_STUB;
  }
  if (Array.isArray(value)) return value.map(item => normalizeField(key, item));
  if (value && typeof value === "object") {
    const record: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      record[nestedKey] = normalizeField(nestedKey, nestedValue);
    }
    return sortKeys(record);
  }
  return value;
}

/**
 * Returns a deep copy of `value` with every explicitly recognized runtime-
 * specific value normalized to its sentinel and every object key sorted into
 * the canonical (alphabetical) order. The input is never modified; unknown
 * fields and all meaningful report data are preserved verbatim.
 */
export function normalizeArtifact(value: unknown): unknown {
  return normalizeField("", value);
}

/**
 * Canonical byte-stable key for a normalized artifact: alphabetically sorted
 * object keys (recursively), 2-space JSON, trailing newline. Two equivalent
 * runs produce the SAME key even when their generatedAt / run ids / paths /
 * durations differ.
 */
export const deterministicArtifactKey = (value: unknown): string => stableJson(normalizeArtifact(value));

/** `true` when two artifacts are equivalent after runtime-field normalization. */
export const normalizedArtifactsEqual = (a: unknown, b: unknown): boolean =>
  deterministicArtifactKey(a) === deterministicArtifactKey(b);

export { sortKeys, stableJson };