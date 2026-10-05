// ---------------------------------------------------------------------------
// Phase 7A — public history API.
//
// Consumers import from "./history/index.js" ONLY. The layer exposes: run
// identity, schema/validation, snapshot building, and the store (persist,
// load, reset). Phase 7A does not interpret history — no helpers imply that
// two runs "mean" something, only that they can be compared.
// ---------------------------------------------------------------------------
import type { QaAnalysis } from "../ai/types.js";
import { HISTORY_SCHEMA_VERSION } from "./types.js";
import {
  historySiteKeyOf,
  historySiteIdentityOf,
  historySiteIdentityOfKey,
  historySiteKeyId,
  historySiteKeyIdOf,
  newRunId,
  findingHistoryKey,
  findingHistoryFamily,
  elementHistorySemanticKey,
  elementHistoryFamilyKey,
  flowHistoryFamilyKey,
  flowHistorySignature,
  flowHistoryStepKey,
  coverageHistoryKey,
  sha1Of,
} from "./identity.js";
import { validateHistoryIndex, validateRunRecord, validateRunSnapshot, validateSiteKey } from "./validate.js";
import { buildRunSnapshot, qaRunRecordOf } from "./snapshot.js";
import {
  DEFAULT_HISTORY_DIR,
  loadIndex,
  loadSiteHistory,
  listSiteRunIds,
  persistRun,
  readRunSnapshot,
  resetHistory,
  withHistoryLock,
  historyPaths,
  atomicWriteJson,
  sortKeys,
  stableJson,
} from "./store.js";

/** Convenience: one-shot load of a site's persisted history. */
export const loadHistory = (
  analysis: QaAnalysis,
  historyDir: string = DEFAULT_HISTORY_DIR,
  options?: { ignoreQueryKeys?: string[] },
): ReturnType<typeof loadSiteHistory> => loadSiteHistory(historySiteKeyOf(analysis, options), historyDir);

export {
  // schema
  HISTORY_SCHEMA_VERSION,
  // identity facade (Phase 5/6 primitives, never a second system)
  historySiteKeyOf,
  historySiteIdentityOf,
  historySiteIdentityOfKey,
  historySiteKeyId,
  historySiteKeyIdOf,
  newRunId,
  findingHistoryKey,
  findingHistoryFamily,
  elementHistorySemanticKey,
  elementHistoryFamilyKey,
  flowHistoryFamilyKey,
  flowHistorySignature,
  flowHistoryStepKey,
  coverageHistoryKey,
  sha1Of,
  // validation
  validateHistoryIndex,
  validateRunRecord,
  validateRunSnapshot,
  validateSiteKey,
  // snapshot builder
  buildRunSnapshot,
  qaRunRecordOf,
  // store
  DEFAULT_HISTORY_DIR,
  loadIndex,
  loadSiteHistory,
  listSiteRunIds,
  persistRun,
  readRunSnapshot,
  resetHistory,
  withHistoryLock,
  historyPaths,
  atomicWriteJson,
  sortKeys,
  stableJson,
};

export type { ValidationResult } from "./validate.js";
export type { IndexLoadResult, PersistRunOptions } from "./store.js";
export type { BuildRunSnapshotOptions } from "./snapshot.js";
export type {
  HistorySiteKey,
  HistorySiteIdentity,
  HistoryRunIdentity,
  QaRunRecord,
  HistoryState,
  HistoryStatus,
  HistoryLoadResult,
  PersistRunResult,
  ResetHistoryResult,
  HistorySiteBucket,
  HistoryIndex,
  FindingHistorySnapshot,
  VerificationHistorySnapshot,
  FlowStepHistorySnapshot,
  FlowHistorySnapshot,
  CoverageHistorySnapshot,
  RegressionHistorySnapshot,
  IntelligenceHistorySnapshot,
  HistoryRunSnapshot,
  HistoryReportSection,
} from "./types.js";