// ---------------------------------------------------------------------------
// Phase 7A — history validation.
//
// Loaded history is NEVER trusted blindly: an index or run artifact that fails
// schema checks, is missing required fields, carries a foreign schema version,
// embeds a non-normalized/empty identity, or duplicates a run id is rejected
// with an explicit reason. Corrupted data is never silently accepted and never
// silently reset. Each validator returns an explicit verdict.
// ---------------------------------------------------------------------------
import { HISTORY_SCHEMA_VERSION } from "./types.js";
import type { HistoryIndex, HistoryRunSnapshot, QaRunRecord } from "./types.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): value is string => typeof value === "string";
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableStr = (value: unknown): value is string | null => value === null || str(value);
const bool = (value: unknown): value is boolean => typeof value === "boolean";

const nonEmpty = (value: unknown): value is string => str(value) && value.trim().length > 0;

export const validSiteKey = (value: unknown): value is { origin: string; normalizedStartPage: string; configDigest: string } =>
  isRecord(value) && nonEmpty(value.origin) && nonEmpty(value.normalizedStartPage) && nonEmpty(value.configDigest);

export const validSemanticKey = (value: unknown): value is string => nonEmpty(value) && value.length <= 512;

/** sha1 digests and site-key ids must be 40-hex (or 8-hex bucket labels). */
export const validDigest = (value: unknown): value is string => str(value) && /^[0-9a-f]{8,40}$/.test(value);

export function validateSiteKey(value: unknown): ValidationResult<{ origin: string; normalizedStartPage: string; configDigest: string }> {
  if (!isRecord(value)) return { ok: false, reason: "siteKey is not an object" };
  if (!nonEmpty(value.origin)) return { ok: false, reason: "siteKey.origin is missing or empty" };
  if (!nonEmpty(value.normalizedStartPage)) return { ok: false, reason: "siteKey.normalizedStartPage is missing or empty" };
  if (!nonEmpty(value.configDigest)) return { ok: false, reason: "siteKey.configDigest is missing or empty" };
  if (!validDigest(value.configDigest)) return { ok: false, reason: "siteKey.configDigest is not a valid digest" };
  return { ok: true, value: { origin: value.origin, normalizedStartPage: value.normalizedStartPage, configDigest: value.configDigest } };
}

export function validateRunRecord(value: unknown): ValidationResult<QaRunRecord> {
  if (!isRecord(value)) return { ok: false, reason: "run record is not an object" };
  if (!nonEmpty(value.runId)) return { ok: false, reason: "run record is missing runId" };
  if (/[\\/:*?"<>|]/.test(value.runId)) return { ok: false, reason: "runId contains characters unsafe for filenames" };
  if (!str(value.startedAt)) return { ok: false, reason: "run record is missing startedAt" };
  if (!num(value.schemaVersion)) return { ok: false, reason: "run record is missing schemaVersion" };
  const siteKey = validateSiteKey(value.siteKey);
  if (!siteKey.ok) return { ok: false, reason: `run record siteKey invalid: ${siteKey.reason}` };
  if (!nonEmpty(value.siteIdentity)) return { ok: false, reason: "run record is missing siteIdentity" };
  return {
    ok: true,
    value: {
      runId: value.runId,
      siteKey: siteKey.value,
      siteIdentity: value.siteIdentity,
      entryUrl: str(value.entryUrl) ? value.entryUrl : "",
      startedAt: value.startedAt,
      completedAt: nullableStr(value.completedAt) ? value.completedAt : null,
      schemaVersion: value.schemaVersion,
      mode: str(value.mode) ? value.mode : "",
      aiProvider: str(value.aiProvider) ? value.aiProvider : "",
      scannedOriginUrl: str(value.scannedOriginUrl) ? value.scannedOriginUrl : "",
      environment: str(value.environment) ? value.environment : undefined,
      browser: str(value.browser) ? value.browser : undefined,
      findingCount: num(value.findingCount) ? value.findingCount : 0,
      flowCount: num(value.flowCount) ? value.flowCount : 0,
      coverageCount: num(value.coverageCount) ? value.coverageCount : 0,
      executionPlanned: num(value.executionPlanned) ? value.executionPlanned : 0,
      executionReproduced: num(value.executionReproduced) ? value.executionReproduced : 0,
      executionNotReproduced: num(value.executionNotReproduced) ? value.executionNotReproduced : 0,
      executionInfraProblems: num(value.executionInfraProblems) ? value.executionInfraProblems : 0,
      headline: str(value.headline) ? value.headline : "",
      identityDigest: str(value.identityDigest) ? value.identityDigest : "",
      artifactPath: str(value.artifactPath) ? value.artifactPath : undefined,
    },
  };
}

export function validateHistoryIndex(value: unknown): ValidationResult<HistoryIndex> {
  if (!isRecord(value)) return { ok: false, reason: "index.json is not an object" };
  if (!num(value.schemaVersion)) return { ok: false, reason: "index.json is missing schemaVersion" };
  if (value.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    return { ok: false, reason: `index.json schema version ${value.schemaVersion} is not supported (expected ${HISTORY_SCHEMA_VERSION})` };
  }
  if (!Array.isArray(value.sites)) return { ok: false, reason: "index.json is missing the sites array" };
  const sites: HistoryIndex["sites"] = [];
  for (const [index, raw] of value.sites.entries()) {
    if (!isRecord(raw)) return { ok: false, reason: `index.json sites[${index}] is not an object` };
    const siteKey = validateSiteKey(raw.siteKey);
    if (!siteKey.ok) return { ok: false, reason: `index.json sites[${index}] siteKey invalid: ${siteKey.reason}` };
    if (!nonEmpty(raw.siteKeyId)) return { ok: false, reason: `index.json sites[${index}] is missing siteKeyId` };
    if (!Array.isArray(raw.runs)) return { ok: false, reason: `index.json sites[${index}] is missing runs` };
    const seen = new Set<string>();
    const runs: QaRunRecord[] = [];
    for (const [runIndex, runRaw] of raw.runs.entries()) {
      const record = validateRunRecord(runRaw);
      if (!record.ok) return { ok: false, reason: `index.json sites[${index}].runs[${runIndex}] invalid: ${record.reason}` };
      if (seen.has(record.value.runId)) return { ok: false, reason: `index.json sites[${index}] contains a duplicate runId ${record.value.runId}` };
      seen.add(record.value.runId);
      runs.push(record.value);
    }
    sites.push({ siteKey: siteKey.value, siteKeyId: raw.siteKeyId, runs });
  }
  return { ok: true, value: { schemaVersion: HISTORY_SCHEMA_VERSION, sites } };
}

export function validateRunSnapshot(value: unknown): ValidationResult<HistoryRunSnapshot> {
  if (!isRecord(value)) return { ok: false, reason: "run artifact is not an object" };
  if (!num(value.schemaVersion)) return { ok: false, reason: "run artifact is missing schemaVersion" };
  if (value.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    return { ok: false, reason: `run artifact schema version ${value.schemaVersion} is not supported (expected ${HISTORY_SCHEMA_VERSION})` };
  }
  if (!nonEmpty(value.runId)) return { ok: false, reason: "run artifact is missing runId" };
  if (/[\\/:*?"<>|]/.test(value.runId)) return { ok: false, reason: "run artifact runId contains characters unsafe for filenames" };
  if (!str(value.startedAt)) return { ok: false, reason: "run artifact is missing startedAt" };
  const siteKey = validateSiteKey(value.siteKey);
  if (!siteKey.ok) return { ok: false, reason: `run artifact siteKey invalid: ${siteKey.reason}` };
  if (!nonEmpty(value.siteIdentity)) return { ok: false, reason: "run artifact has an empty siteIdentity" };

  // Semantic identity sanity: every recorded identity must be a non-empty,
  // bounded, normalized key — never a generated id or an unbounded blob.
  if (!Array.isArray(value.findings)) return { ok: false, reason: "run artifact is missing findings" };
  for (const [index, finding] of value.findings.entries()) {
    if (!isRecord(finding)) return { ok: false, reason: `findings[${index}] is not an object` };
    if (!validSemanticKey(finding.semanticKey)) return { ok: false, reason: `findings[${index}] has an invalid semanticKey` };
    if (!validSemanticKey(finding.page)) return { ok: false, reason: `findings[${index}] has an invalid page identity` };
  }
  if (!Array.isArray(value.flows)) return { ok: false, reason: "run artifact is missing flows" };
  for (const [index, flow] of value.flows.entries()) {
    if (!isRecord(flow)) return { ok: false, reason: `flows[${index}] is not an object` };
    if (!validSemanticKey(flow.familyKey)) return { ok: false, reason: `flows[${index}] has an invalid familyKey` };
    if (!validSemanticKey(flow.signature)) return { ok: false, reason: `flows[${index}] has an invalid signature` };
  }
  if (!Array.isArray(value.coverage)) return { ok: false, reason: "run artifact is missing coverage" };
  for (const [index, item] of value.coverage.entries()) {
    if (!isRecord(item)) return { ok: false, reason: `coverage[${index}] is not an object` };
    if (!validSemanticKey(item.semanticKey)) return { ok: false, reason: `coverage[${index}] has an invalid semanticKey` };
  }
  if (!Array.isArray(value.verifications)) return { ok: false, reason: "run artifact is missing verifications" };
  if (!(value.regression === null || isRecord(value.regression))) return { ok: false, reason: "run artifact regression section is malformed" };
  if (!(value.intelligence === null || isRecord(value.intelligence))) return { ok: false, reason: "run artifact intelligence section is malformed" };
  if (value.identityDigest !== undefined && !validDigest(value.identityDigest)) return { ok: false, reason: "run artifact has an invalid identityDigest" };

  return { ok: true, value: value as unknown as HistoryRunSnapshot };
}

export function historySiteKeysEqual(
  a: { origin: string; normalizedStartPage: string; configDigest: string },
  b: { origin: string; normalizedStartPage: string; configDigest: string },
): boolean {
  return a.origin === b.origin && a.normalizedStartPage === b.normalizedStartPage && a.configDigest === b.configDigest;
}