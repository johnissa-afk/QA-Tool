// ---------------------------------------------------------------------------
// Phase 7A — history identity FACADE.
//
// HARD CONTRACT (Phase 5/6): this module NEVER invents a second identity
// system. Every semantic key it exposes is the VERBATIM Phase 5/6 primitive
// (regression/identity.ts + intelligence/identity.ts) surfaced through this
// facade so the history layer has ONE vocabulary. The history layer stores
// ONLY these semantic keys — never generated ids, never base64 secrets, never
// locators, never element indices.
// ---------------------------------------------------------------------------
import { createHash, randomBytes } from "node:crypto";
import type { QaAnalysis, QaFinding } from "../ai/types.js";
import type { DiscoveredFlow, FlowStep } from "../flow/types.js";
import type { CoverageItem } from "../coverage/types.js";
import type { DiscoveredElement } from "../types.js";
import type { HistorySiteKey, HistorySiteIdentity } from "./types.js";
import {
  normalizeText,
  normalizePageUrl,
  elementSemanticKey,
  elementFamilyKey,
  findingSignature,
  flowStepKey,
  flowSignature,
  flowFamilyKey,
  coverageItemSignature,
  configDigestOf,
  originOf,
} from "../regression/identity.js";
import type { RegressionCompareOptions } from "../regression/types.js";

const sha = (value: string): string => createHash("sha1").update(value).digest("hex");

/** Site identity: origin + normalized start page + config digest — the EXACT
 *  Phase 5/6 site partition, never a second system. Optional `ignoreQueryKeys`
 *  (only explicitly proven-volatile keys) flow into page normalization. */
export function historySiteKeyOf(analysis: QaAnalysis, options?: RegressionCompareOptions): HistorySiteKey {
  return {
    origin: originOf(analysis.scan.scan.url),
    normalizedStartPage: normalizePageUrl(analysis.scan.scan.url, options?.ignoreQueryKeys ?? []),
    configDigest: configDigestOf(analysis),
  };
}

/** Canonical, inspectable site-identity string. Deterministic across runs that
 *  target the same site under the same configuration; different sites can
 *  never collide on it (origin is the first component). */
export function historySiteIdentityOf(analysis: QaAnalysis, options?: RegressionCompareOptions): HistorySiteIdentity {
  const key = historySiteKeyOf(analysis, options);
  return `${key.origin}|${key.normalizedStartPage}|${key.configDigest}`;
}

export const historySiteIdentityOfKey = (key: HistorySiteKey): HistorySiteIdentity =>
  `${key.origin}|${key.normalizedStartPage}|${key.configDigest}`;

/** Stable, bounded bucket id for a site key (sha1). Used only as an
 *  index-internal pointer and a directory-safe label — the canonical
 *  site identity remains the readable `historySiteIdentityOf` string. */
export function historySiteKeyId(key: HistorySiteKey): string {
  return sha(historySiteIdentityOfKey(key));
}

export const historySiteKeyIdOf = (analysis: QaAnalysis, options?: RegressionCompareOptions): string =>
  historySiteKeyId(historySiteKeyOf(analysis, options));

/**
 * Run ID. Timestamp (filename-safe) + a collision-safe sha1 suffix. Unique,
 * stable once assigned, dependent on nothing secret, and safe on disk:
 *
 *   `2026-09-18T09-30-12-123Z-8f3a1c02`
 *
 * Run IDs MAY be unique per run — only SEMANTIC identities must be
 * deterministic, and those never contain a run ID or a timestamp.
 */
export function newRunId(siteKey: HistorySiteKey, startedAt: string = new Date().toISOString()): string {
  const stamp = startedAt.replace(/[:.]/g, "-");
  const suffix = sha(`${historySiteIdentityOfKey(siteKey)}|${startedAt}|${randomBytes(4).toString("hex")}`).slice(0, 8);
  return `${stamp}-${suffix}`;
}

/** Finding identity: the Phase 5 SEMANTIC findingSignature (normalized page +
 *  element semantic key + family). NEVER the generated finding id, NEVER the
 *  run-local finding code index. */
export function findingHistoryKey(
  analysis: QaAnalysis,
  finding: QaFinding,
  options?: RegressionCompareOptions,
): { page: string; key: string; family: string } {
  return findingSignature(finding, analysis.scan.scan.url, analysis.scan.elements, options);
}

export function findingHistoryFamily(
  analysis: QaAnalysis,
  finding: QaFinding,
  options?: RegressionCompareOptions,
): string {
  return findingHistoryKey(analysis, finding, options).family;
}

/** Element identity: Phase 5 elementSemanticKey + elementFamilyKey. */
export const elementHistorySemanticKey = (element: DiscoveredElement): string => elementSemanticKey(element);
export const elementHistoryFamilyKey = (element: DiscoveredElement): string => elementFamilyKey(element);

/** Flow identity: flowFamilyKey (category + normalized start page) is the
 *  historical family; flowSignature additionally pins the step sequence. */
export const flowHistoryFamilyKey = (flow: DiscoveredFlow, options?: RegressionCompareOptions): string =>
  flowFamilyKey(flow, options);
export const flowHistorySignature = (flow: DiscoveredFlow, options?: RegressionCompareOptions): string =>
  flowSignature(flow, options);
export const flowHistoryStepKey = (step: FlowStep, options?: RegressionCompareOptions): string =>
  flowStepKey(step, options);

/** Coverage identity: Phase 5 coverageItemSignature — category + location +
 *  normalized name. NEVER the generated COV-* id. */
export const coverageHistoryKey = (item: CoverageItem, options?: RegressionCompareOptions): string =>
  coverageItemSignature(item, options);

/** Digests for integrity checks — always a sha1 over the semantic key string;
 *  computed here only so the history layer never embeds a "second identity". */
export const sha1Of = sha;