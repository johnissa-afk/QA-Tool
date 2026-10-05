export { buildRedactor, redactObject, Redactor } from "./redact.js";
export { buildVerificationTasks, codesForStrategy, isPageLevelStrategy, isSafeLocator, uniqueReferenceLocator, EXPECTATION_BY_STRATEGY, TaskSkip, TaskSkipCause, VerificationTask } from "./tasks.js";
export { classifyError, locatorFromExpr, probeElements, runVerification, triageOutcome, VerifyOptions } from "./verify.js";
export { renderVerificationSpec, VERIFICATION_DIR } from "./spec.js";
export { loadVerificationResults } from "./parse.js";
export { runVerificationSpec, runPlaywright, summarizePlaywrightJson, VerificationRun } from "./runner.js";