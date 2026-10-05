// ---------------------------------------------------------------------------
// Phase 7A — history store.
//
// Layout:
//   <history-dir>/
//     index.json            metadata per site (never full reports)
//     runs/<run-id>.json    full redacted run artifact (source of truth)
//     .lock                 advisory exclusive lock (created on demand)
//
// Writing is atomic (temp file + rename) and serialized with a lock file so
// two QA processes cannot corrupt index.json (no lost update). Site history is
// isolated per site bucket AND re-validated against the requested site key on
// load. Incompatible or corrupted history is never overwritten.
// ---------------------------------------------------------------------------
import { basename, dirname, join, resolve } from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { QaAnalysis } from "../ai/types.js";
import { buildRunSnapshot, qaRunRecordOf } from "./snapshot.js";
import { newRunId } from "./identity.js";
import { HISTORY_SCHEMA_VERSION } from "./types.js";
import type { HistoryIndex, HistoryLoadResult, HistoryRunSnapshot, HistorySiteBucket, HistorySiteKey, PersistRunResult, QaRunRecord, ResetHistoryResult } from "./types.js";
import { historySiteKeysEqual, validateHistoryIndex, validateRunSnapshot, validateSiteKey } from "./validate.js";
import { historySiteKeyId } from "./identity.js";

export const DEFAULT_HISTORY_DIR = "reports/history";
const INDEX_FILE = "index.json";
const RUNS_DIR = "runs";
const LOCK_FILE = ".lock";
const LOCK_STALE_MS = 30000;
const LOCK_TIMEOUT_MS = 10000;

export const historyPaths = (historyDir: string): { root: string; indexPath: string; runsDir: string; lockPath: string } => {
  const root = resolve(historyDir);
  return { root, indexPath: join(root, INDEX_FILE), runsDir: join(root, RUNS_DIR), lockPath: join(root, LOCK_FILE) };
};

/** Recursively reorders object keys so serialized history is stable and
 *  diffable. Arrays are left in their (already sorted) order. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sortKeys(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortKeys(record[key])]));
  }
  return value;
}

export const stableJson = (value: unknown): string => `${JSON.stringify(sortKeys(value), null, 2)}\n`;

// ---------------------------------------------------------------------------
// Atomic file writes (Windows-safe: rename-over-existing is retried).
// ---------------------------------------------------------------------------
export function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
  writeFileSync(tmp, stableJson(value), "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST" || code === "ENOENT") {
      try { unlinkSync(filePath); } catch { /* destination did not exist */ }
      renameSync(tmp, filePath);
    } else {
      throw error;
    }
  }
}

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function acquireLock(historyDir: string): string {
  const lockPath = join(historyDir, LOCK_FILE);
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return lockPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const mtime = statSync(lockPath).mtimeMs;
        if (Date.now() - mtime > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { continue; }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`Could not acquire the history lock (${lockPath}) within ${LOCK_TIMEOUT_MS}ms — another QA run may still be writing.`);
      }
      pause(150);
    }
  }
}

export function withHistoryLock<T>(historyDir: string, fn: () => T): T {
  const paths = historyPaths(historyDir);
  mkdirSync(paths.root, { recursive: true });
  const lockPath = acquireLock(paths.root);
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Index loading. Distinguishes EMPTY (nothing to read) from UNAVAILABLE
// (data exists but cannot be trusted) and INCOMPATIBLE (schema mismatch).
// ---------------------------------------------------------------------------
export type IndexLoadResult = { status: "AVAILABLE" | "EMPTY" | "UNAVAILABLE" | "INCOMPATIBLE"; reason: string | null; index: HistoryIndex | null; historyDir: string };

export function loadIndex(historyDir: string): IndexLoadResult {
  const paths = historyPaths(historyDir);
  if (!existsSync(paths.root)) {
    return { status: "EMPTY", reason: "history directory does not exist", index: null, historyDir: paths.root };
  }
  if (!existsSync(paths.indexPath)) {
    let hasArtifacts = false;
    try { hasArtifacts = existsSync(paths.runsDir) && readdirSync(paths.runsDir).some(name => name.endsWith(".json")); } catch { hasArtifacts = false; }
    if (hasArtifacts) {
      return { status: "UNAVAILABLE", reason: "index.json is missing while run artifacts exist under runs/ — history cannot be trusted", index: null, historyDir: paths.root };
    }
    return { status: "EMPTY", reason: "history not initialized", index: null, historyDir: paths.root };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.indexPath, "utf8"));
  } catch (error) {
    return { status: "UNAVAILABLE", reason: `index.json is malformed (${error instanceof Error ? error.message : "parse error"})`, index: null, historyDir: paths.root };
  }

  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).schemaVersion === "number" && (raw as Record<string, unknown>).schemaVersion !== HISTORY_SCHEMA_VERSION) {
    return {
      status: "INCOMPATIBLE",
      reason: `index.json schema version ${(raw as Record<string, unknown>).schemaVersion} is not supported (expected ${HISTORY_SCHEMA_VERSION})`,
      index: null,
      historyDir: paths.root,
    };
  }

  const validated = validateHistoryIndex(raw);
  if (!validated.ok) {
    return { status: "UNAVAILABLE", reason: `index.json is invalid: ${validated.reason}`, index: null, historyDir: paths.root };
  }
  return { status: "AVAILABLE", reason: null, index: validated.value, historyDir: paths.root };
}

const emptyIndex = (): HistoryIndex => ({ schemaVersion: HISTORY_SCHEMA_VERSION, sites: [] });

const findBucket = (index: HistoryIndex, siteKey: HistorySiteKey): HistorySiteBucket | null => {
  const siteKeyId = historySiteKeyId(siteKey);
  return index.sites.find(bucket => bucket.siteKeyId === siteKeyId || historySiteKeysEqual(bucket.siteKey, siteKey)) ?? null;
};

const runSort = (a: QaRunRecord, b: QaRunRecord): number => {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
};

// ---------------------------------------------------------------------------
// History loading for one site (validated + isolated).
// ---------------------------------------------------------------------------
export function loadSiteHistory(siteKey: HistorySiteKey, historyDir: string): HistoryLoadResult {
  const paths = historyPaths(historyDir);
  const base = loadIndex(historyDir);
  if (base.status !== "AVAILABLE") {
    return { status: base.status, reason: base.reason, warnings: [], state: null, historyDir: paths.root };
  }
  const bucket = findBucket(base.index!, siteKey);
  if (!bucket || bucket.runs.length === 0) {
    return { status: "EMPTY", reason: "no persisted runs for this site", warnings: [], state: null, historyDir: paths.root };
  }

  const warnings: string[] = [];
  const valid: QaRunRecord[] = [];
  for (const record of bucket.runs) {
    const artifactPath = join(paths.runsDir, `${record.runId}.json`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(artifactPath, "utf8"));
    } catch (error) {
      warnings.push(`run ${record.runId}: artifact is missing or malformed (${error instanceof Error ? error.message : "read error"}) — excluded`);
      continue;
    }
    const snapshot = validateRunSnapshot(raw);
    if (!snapshot.ok) {
      warnings.push(`run ${record.runId}: invalid artifact (${snapshot.reason}) — excluded`);
      continue;
    }
    if (snapshot.value.runId !== record.runId) {
      warnings.push(`run ${record.runId}: artifact runId mismatch (${snapshot.value.runId}) — excluded`);
      continue;
    }
    if (!historySiteKeysEqual(snapshot.value.siteKey, siteKey)) {
      warnings.push(`run ${record.runId}: artifact belongs to a different site identity (site isolation) — excluded`);
      continue;
    }
    valid.push(qaRunRecordOf(snapshot.value, { artifactPath, environment: snapshot.value.environment ?? undefined, browser: snapshot.value.browser ?? undefined }));
  }
  valid.sort(runSort);

  if (valid.length === 0) {
    return {
      status: warnings.length ? "UNAVAILABLE" : "EMPTY",
      reason: warnings.length ? `all persisted runs for this site are invalid: ${warnings.join("; ")}` : "no persisted runs for this site",
      warnings,
      state: null,
      historyDir: paths.root,
    };
  }
  return {
    status: "AVAILABLE",
    reason: warnings.length ? `${warnings.length} invalid run(s) were excluded` : null,
    warnings,
    state: {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      runs: valid,
      latestRunId: valid[valid.length - 1]!.runId,
    },
    historyDir: paths.root,
  };
}

// ---------------------------------------------------------------------------
// Persistence. NEVER overwrites incompatible/corrupted history, and NEVER
// overwrites an existing run id.
// ---------------------------------------------------------------------------
export type PersistRunOptions = {
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  environment?: string;
  browser?: string;
};

export function persistRun(analysis: QaAnalysis, siteKey: HistorySiteKey, historyDir: string, options: PersistRunOptions = {}): PersistRunResult {
  const paths = historyPaths(historyDir);
  const startedAt = options.startedAt ?? analysis.generatedAt ?? new Date().toISOString();
  const completedAt = options.completedAt ?? new Date().toISOString();
  const runId = options.runId ?? newRunId(siteKey, startedAt);

  return withHistoryLock(historyDir, (): PersistRunResult => {
    const loaded = loadIndex(paths.root);
    if (loaded.status === "INCOMPATIBLE") {
      return { persisted: false, runId: null, status: "INCOMPATIBLE", runsAvailable: 0, duplicateRunId: false, historyDir: paths.root, reason: loaded.reason };
    }
    if (loaded.status === "UNAVAILABLE") {
      return { persisted: false, runId: null, status: "UNAVAILABLE", runsAvailable: 0, duplicateRunId: false, historyDir: paths.root, reason: loaded.reason };
    }
    const index = loaded.status === "AVAILABLE" ? loaded.index! : emptyIndex();
    const bucket = findBucket(index, siteKey);
    if (bucket && bucket.runs.some(record => record.runId === runId)) {
      return { persisted: false, runId, status: "AVAILABLE", runsAvailable: bucket.runs.length, duplicateRunId: true, historyDir: paths.root, reason: `a run with id ${runId} already exists — refusing to overwrite` };
    }

    const snapshot = buildRunSnapshot(analysis, { runId, startedAt, completedAt, siteKey, environment: options.environment, browser: options.browser });
    const artifactPath = join(paths.runsDir, `${runId}.json`);
    atomicWriteJson(artifactPath, snapshot);
    const record = qaRunRecordOf(snapshot, { artifactPath, environment: options.environment, browser: options.browser });

    if (bucket) {
      bucket.runs.push(record);
      bucket.runs.sort(runSort);
    } else {
      index.sites.push({ siteKey, siteKeyId: historySiteKeyId(siteKey), runs: [record] });
      index.sites.sort((a, b) => (a.siteKeyId < b.siteKeyId ? -1 : a.siteKeyId > b.siteKeyId ? 1 : 0));
    }
    atomicWriteJson(paths.indexPath, index);
    return { persisted: true, runId, status: "AVAILABLE", runsAvailable: bucket ? bucket.runs.length : 1, duplicateRunId: false, historyDir: paths.root, reason: null };
  });
}

/** Read a single persisted run artifact (bounded metadata), or null when it is
 *  missing or invalid. Used by the multi-run E2E to re-inspect what was stored. */
export function readRunSnapshot(historyDir: string, runId: string): HistoryRunSnapshot | null {
  const artifactPath = join(historyPaths(historyDir).runsDir, `${runId}.json`);
  if (!existsSync(artifactPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    return null;
  }
  const validated = validateRunSnapshot(raw);
  return validated.ok ? validated.value : null;
}

/** List persisted run ids for a site (from the index), or [] when none. */
export function listSiteRunIds(siteKey: HistorySiteKey, historyDir: string): string[] {
  const loaded = loadIndex(historyDir);
  if (loaded.status !== "AVAILABLE") return [];
  const bucket = findBucket(loaded.index!, siteKey);
  return bucket ? [...bucket.runs].sort(runSort).map(record => record.runId) : [];
}

// ---------------------------------------------------------------------------
// Reset — explicit, scoped to the selected history directory only.
// ---------------------------------------------------------------------------
export function resetHistory(historyDir: string): ResetHistoryResult {
  const paths = historyPaths(historyDir);
  const removed: string[] = [];
  if (!existsSync(paths.root)) {
    return { reset: true, historyDir: paths.root, removed };
  }
  withHistoryLock(paths.root, () => {
    if (existsSync(paths.indexPath)) {
      removed.push(paths.indexPath);
      unlinkSync(paths.indexPath);
    }
    if (existsSync(paths.runsDir)) {
      for (const name of readdirSync(paths.runsDir)) {
        if (!name.endsWith(".json")) continue;
        const file = join(paths.runsDir, name);
        removed.push(file);
        unlinkSync(file);
      }
    }
  });
  return { reset: true, historyDir: paths.root, removed };
}

export { validateSiteKey };

export type { HistoryIndex, HistoryRunSnapshot, HistorySiteKey, QaRunRecord };