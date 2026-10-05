import { IntentCategory } from "../types.js";
import { QaExecution, QaAnalysis, QaSummary, VerificationDisposition, VerificationResult, Severity } from "./types.js";
import { TaskSkip, VerificationTask } from "../executor/tasks.js";
import { VerificationCounts } from "./summary.js";
import { SEVERITY_RANK } from "./severity.js";

// ---------------------------------------------------------------------------
// Finding lifecycle (EXECUTOR side).
//
// After a verification run this module:
//   - gives EVERY finding an explicit verification disposition, even when it
//     was skipped or unsupported (nothing is silently dropped),
//   - advances each finding's lifecycle and attaches its compact verification
//     pointer with a traceable reason,
//   - links findings to the verification scenario (SC-VER-*) and to the
//     element / intent scenarios that can confirm them,
//   - refreshes the QA summary with verification counts that come directly
//     from the disposition model.
//
// Failures are never silently dropped: INFRASTRUCTURE / AUTHENTICATION /
// REVIEW outcomes keep the finding visible with its evidence, exactly as
// required by the honest-scan principle.
// ---------------------------------------------------------------------------
export type VerificationBundle = {
  tasks: VerificationTask[];
  skipped: TaskSkip[];
  results: VerificationResult[];
  execution: QaExecution | null;
};

const FIXED_INTENT_BY_DOMAIN: Record<string, IntentCategory> = {
  accessibility: "ACCESSIBILITY",
  navigation: "NAVIGATION",
  authentication: "AUTHENTICATION",
  content: "CONTENT",
};

function elementLinks(analysis: QaAnalysis, findingLocator: string | null): string[] {
  if (!findingLocator) return [];
  return analysis.elementScenarios.filter(scenario => scenario.locator === findingLocator).map(scenario => scenario.id);
}

export function dispositionForResult(result: VerificationResult): VerificationDisposition {
  if (result.category === "INFRASTRUCTURE") return "INFRASTRUCTURE_PROBLEM";
  switch (result.status) {
    case "REPRODUCED": return "REPRODUCED";
    case "NOT_REPRODUCED": return "NOT_REPRODUCED";
    case "PASS": return "PASSED";
    default: return "REVIEW_REQUIRED";
  }
}

/** Inputs for the single status authority below. */
type StatusInputs = {
  accessPrerequisite: QaAnalysis["accessPrerequisite"];
  findings: ReadonlyArray<{ severity: Severity; count: number }>;
  summary: QaAnalysis["summary"];
  execution: QaExecution | null;
};

/**
 * The single authority for the final QA status and status explanation.
 *
 * Rules, in order:
 *   1. An access prerequisite is NOT a website defect. The run stopped before
 *      normal scanning, so the prerequisite's own status is the QA status
 *      (REVIEW_REQUIRED -> REVIEW, BLOCKED -> BLOCKED).
 *   2. A CRITICAL finding is a FAIL; a HIGH finding needs REVIEW.
 *   3. Otherwise the run is PASS if and only if testing actually happened —
 *      a verification probe executed, a flow executed, or the Playwright suite
 *      ran tests. Zero findings never implies "tested": a page nobody executed
 *      is NOT_TESTED.
 *
 * Every caller MUST go through here. This logic used to be duplicated in
 * applyVerification and recomputeOverallStatus, and the copies had already
 * drifted (one counted flow execution, the other did not), so the JSON report
 * and the CLI could disagree about the same run.
 *
 * The headline answers "what actually executed?" with the same counters:
 *   - verification executed (summary.executed > 0): describe the verification
 *     outcome, NEVER "no verification run performed";
 *   - otherwise flow / Playwright execution is reported as flow / scenario
 *     execution, NOT as finding verification;
 *   - nothing executed: "no verification run performed". This is the only
 *     place the phrase may appear, and it is true exactly then.
 */
function computeOverallStatus(inputs: StatusInputs): QaAnalysis["summary"]["overallStatus"] {
  if (inputs.accessPrerequisite) return inputs.summary.overallStatus;
  const bySeverity: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const finding of inputs.findings) bySeverity[finding.severity] += finding.count;
  if (bySeverity.CRITICAL > 0) return "FAIL";
  if (bySeverity.HIGH > 0) return "REVIEW";
  const { summary, execution } = inputs;
  const verificationRan = (summary.executed ?? 0) > 0;
  const flowRan = (summary.flowSummary?.executed ?? 0) > 0;
  const suiteRan = (execution?.tests ?? 0) > 0;
  return verificationRan || flowRan || suiteRan ? "PASS" : "NOT_TESTED";
}

/** Recomputes the QA overall status from the current summary counts. */
export function recomputeOverallStatus(analysis: QaAnalysis): QaAnalysis["summary"]["overallStatus"] {
  return explainStatus(analysis).overallStatus;
}

/** The accurate, deterministic status explanation for a finished run. */
export function explainStatus(analysis: QaAnalysis): Pick<QaSummary, "overallStatus" | "headline"> {
  const { summary } = analysis;
  if (analysis.accessPrerequisite) {
    return { overallStatus: summary.overallStatus, headline: summary.headline };
  }
  const bySeverity: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const finding of analysis.findings) bySeverity[finding.severity] += finding.count;
  const url = analysis.scan.scan.url;
  if (bySeverity.CRITICAL > 0) {
    return { overallStatus: "FAIL", headline: `QA (${summary.mode}): ${bySeverity.CRITICAL} critical finding(s) block release of ${url}.` };
  }
  if (bySeverity.HIGH > 0) {
    return { overallStatus: "REVIEW", headline: `QA (${summary.mode}): ${bySeverity.HIGH} high-severity finding(s) require review before release of ${url}.` };
  }
  const executed = summary.executed ?? 0;
  if (executed > 0) {
    return {
      overallStatus: "PASS",
      headline: `QA (${summary.mode}): verification completed; ${summary.verified} finding(s) verified, ${summary.reproduced} reproduced, ${summary.notReproduced} not reproduced.`,
    };
  }
  const flowExecuted = summary.flowSummary?.executed ?? 0;
  const testsExecuted = analysis.execution?.tests ?? 0;
  if (flowExecuted > 0) {
    return {
      overallStatus: "PASS",
      headline: `QA (${summary.mode}): no verification run performed — ${flowExecuted} flow(s) executed for ${url}; ${summary.interactiveElements} interactive elements scanned.`,
    };
  }
  if (testsExecuted > 0) {
    return {
      overallStatus: "PASS",
      headline: `QA (${summary.mode}): no verification run performed — ${testsExecuted} Playwright test(s) executed for ${url}; ${summary.interactiveElements} interactive elements scanned.`,
    };
  }
  return {
    overallStatus: "NOT_TESTED",
    headline: `QA (${summary.mode}): no verification run performed for ${url} — ${summary.interactiveElements} interactive elements scanned.`,
  };
}

function reasonForResult(result: VerificationResult): string {
  return result.triage?.reason ?? result.error?.message ?? "No outcome explanation was recorded.";
}

export function summarizeDispositions(
  findings: Pick<QaAnalysis["findings"][number], "verification">[],
): VerificationCounts {
  let scheduled = 0;
  let executed = 0;
  let reproduced = 0;
  let notReproduced = 0;
  let passed = 0;
  let reviewRequired = 0;
  let infrastructureProblems = 0;
  let skippedUnsupported = 0;
  let skippedLocatorGuard = 0;
  let skippedSafety = 0;
  for (const finding of findings) {
    const disposition = finding.verification?.disposition;
    if (!disposition) continue; // disposition null when no verification run was requested
    // A finding with a task assigned counts as scheduled for verification,
    // whether the task later executed or is still waiting for an outcome.
    if (disposition !== "SKIPPED_UNSUPPORTED" && disposition !== "SKIPPED_LOCATOR_GUARD" && disposition !== "SKIPPED_SAFETY") scheduled++;
    switch (disposition) {
      case "SCHEDULED": break; // scheduled, no outcome yet — not executed
      case "REPRODUCED": executed++; reproduced++; break;
      case "NOT_REPRODUCED": executed++; notReproduced++; break;
      case "PASSED": executed++; passed++; break;
      case "REVIEW_REQUIRED": executed++; reviewRequired++; break;
      case "INFRASTRUCTURE_PROBLEM": executed++; infrastructureProblems++; break;
      case "SKIPPED_UNSUPPORTED": skippedUnsupported++; break;
      case "SKIPPED_LOCATOR_GUARD": skippedLocatorGuard++; break;
      case "SKIPPED_SAFETY": skippedSafety++; break;
      default: break;
    }
  }
  const verified = reproduced + notReproduced + passed;
  return {
    verified,
    reproduced,
    notReproduced,
    pass: passed,
    review: reviewRequired,
    infrastructureFailures: infrastructureProblems,
    unverified: findings.length - verified - reviewRequired - infrastructureProblems,
    scheduled,
    executed,
    skippedUnsupported,
    skippedLocatorGuard,
    skippedSafety,
    reviewRequired,
    infrastructureProblems,
  };
}

export function applyVerification(analysis: QaAnalysis, bundle: VerificationBundle): QaAnalysis {
  const { tasks, skipped, results } = bundle;
  const taskByFinding = new Map(tasks.map(task => [task.findingId, task]));
  const skipByFinding = new Map(skipped.map(skip => [skip.findingId, skip]));
  const resultByFinding = new Map(results.map(result => [result.findingId, result]));

  const elementScenarios = analysis.elementScenarios.map(scenario => {
    const finding = analysis.findings.find(item => item.evidence.find(ref => ref.type === "element")?.locator === scenario.locator);
    if (!finding) return scenario;
    return { ...scenario, findingIds: [...new Set([...(scenario.findingIds ?? []), finding.id])] };
  });

  const findings = analysis.findings.map(finding => {
    const task = taskByFinding.get(finding.id);
    const result = resultByFinding.get(finding.id);
    const skip = skipByFinding.get(finding.id);
    const candidateLocator = finding.evidence.find(ref => ref.type === "element")?.locator ?? null;
    const related = new Set<string>(finding.relatedScenarioIds);
    if (task) related.add(task.scenarioId);
    for (const id of elementLinks(analysis, candidateLocator)) related.add(id);

    const intent = FIXED_INTENT_BY_DOMAIN[finding.domain];
    if (intent) {
      for (const scenario of analysis.scenarios) {
        if (scenario.intent === intent) related.add(scenario.id);
      }
    }

    let lifecycle = finding.lifecycle;
    if (task && !result) lifecycle = "TEST_GENERATED";
    if (result) {
      if (result.status === "REPRODUCED") lifecycle = "REPRODUCED";
      else if (result.status === "NOT_REPRODUCED") lifecycle = "NOT_REPRODUCED";
      else if (result.status === "PASS") lifecycle = "PASS";
      else lifecycle = "REVIEW";
    } else if (skip) {
      lifecycle = "DISCOVERED";
    }

    const verification = result
      ? {
          disposition: dispositionForResult(result),
          scenarioId: result.scenarioId,
          status: result.status,
          category: result.category,
          verdict: result.triage?.verdict ?? null,
          reason: reasonForResult(result),
          safety: "safe" as const,
          locator: result.locator,
          executedAt: result.executedAt,
          durationMs: result.durationMs,
          error: result.error,
        }
      : task
        ? {
            disposition: "SCHEDULED" as const,
            scenarioId: task.scenarioId,
            status: null,
            category: null,
            verdict: null,
            reason: "A safe verification task was scheduled but no outcome was recorded.",
            safety: "safe" as const,
            locator: task.locator,
            executedAt: null,
            durationMs: null,
            error: null,
          }
        : skip
          ? {
              disposition: skip.disposition,
              scenarioId: skip.scenarioId,
              status: null,
              category: null,
              verdict: null,
              reason: skip.reason,
              safety: skip.safety,
              locator: skip.locator,
              executedAt: skip.executedAt,
              durationMs: null,
              error: null,
            }
          : finding.verification;

    return {
      ...finding,
      lifecycle,
      relatedScenarioIds: [...related],
      verification,
    };
  });

  const execution = bundle.execution ?? analysis.execution;
  const base = { ...analysis.summary, ...summarizeDispositions(findings), verificationRun: true };

  // Single status + explanation authority — see explainStatus. The JSON/HTML
  // report and the CLI now always agree, because there is only one
  // implementation. applyVerification is where the "scheduled → executed →
  // outcome" story becomes real, so this is where the headline stops saying
  // "no verification run performed" once verification actually executed.
  const explained = { ...analysis, findings, elementScenarios, verifications: results, execution, summary: base };
  const summary = { ...base, ...explainStatus(explained) };

  return {
    ...analysis,
    findings,
    elementScenarios,
    verifications: results,
    execution,
    summary,
  };
}