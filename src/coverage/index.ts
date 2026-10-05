// Phase 4 coverage module — deterministic, evidence-based test planning.
export {
  buildCoverage,
  applyCoverageNotes,
  coverageDigest,
  gapHeadlines,
} from "./engine.js";
export type { CoverageEngineInput } from "./engine.js";
export {
  emptyCoverageSummary,
} from "./types.js";
export type {
  CoverageCategory,
  CoverageExecutionStatus,
  CoverageSafety,
  CoverageStatus,
  CoverageItem,
  CoverageMap,
  CoverageSummary,
  CoverageAiNotes,
  CoverageDigest,
  CoverageEnhancement,
  TestPlanRecommendation,
  TestPlanRecommendationType,
} from "./types.js";
export { buildTestPlan } from "./test-plan.js";