export { compareRuns, applyRegressionNotes } from "./compare.js";
export type { RegressionEnhancement } from "./types.js";
export { normalizePageUrl, normalizeText, runIdentity, comparableRunPair, elementSemanticKey, findingSignature, flowSignature, configDigestOf } from "./identity.js";
export type { FindingSignature } from "./identity.js";
export type {
  RegressionChange,
  RegressionCompareOptions,
  RegressionConfidence,
  ChangeCategory,
  ChangeClassification,
  RegressionDigest,
  RegressionMap,
  RegressionSummary,
  RunIdentity,
} from "./types.js";