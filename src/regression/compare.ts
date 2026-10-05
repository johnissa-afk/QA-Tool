import type { QaAnalysis, QaFinding } from "../ai/types.js";
import type { CoverageItem, CoverageStatus, TestPlanRecommendation } from "../coverage/types.js";
import type { DiscoveredFlow, FlowExecutionResult } from "../flow/types.js";
import type { DiscoveredElement } from "../types.js";
import type { RegressionEnhancement } from "./types.js";
import {
  comparableRunPair,
  coverageItemSignature,
  elementFamilyKey,
  findingSignature,
  flowFamilyKey,
  flowSignature,
  normalizePageUrl,
  recommendationSignature,
  runIdentity,
} from "./identity.js";
import type {
  ChangeCategory,
  ChangeClassification,
  RegressionChange,
  RegressionCompareOptions,
  RegressionConfidence,
  RegressionMap,
  RegressionSummary,
} from "./types.js";

// ---------------------------------------------------------------------------
// Deterministic two-run comparison. Rules of evidence:
//  - A regression requires a previously verified/expected condition that now
//    changed negatively. Two different DOM snapshots are never a regression.
//  - Infrastructure failures are INFRASTRUCTURE_PROBLEM, never regressions.
//  - Missing evidence is never a FIX: unverified disappearances are
//    REVIEW_REQUIRED.
//  - Confidence is an explicit reason (HIGH/MEDIUM/LOW/INSUFFICIENT_EVIDENCE),
//    never a pseudo-percentage.
// ---------------------------------------------------------------------------

const CLASSIFICATION_ORDER: ChangeClassification[] = [
  "REGRESSION",
  "INFRASTRUCTURE_PROBLEM",
  "COVERAGE_CHANGED",
  "REVIEW_REQUIRED",
  "FIXED",
  "NEW",
  "CHANGED",
  "NEW_FLOW",
  "REMOVED_FLOW",
  "CHANGED_FLOW",
  "UNCHANGED",
  "UNCHANGED_FLOW",
];

const emptyCounts = (): Record<ChangeClassification, number> =>
  Object.fromEntries(CLASSIFICATION_ORDER.map(classification => [classification, 0])) as Record<ChangeClassification, number>;

const identityOf = (analysis: QaAnalysis, elements: DiscoveredElement[], options?: RegressionCompareOptions): Map<string, QaFinding[]> => {
  const page = analysis.scan.scan.url;
  const map = new Map<string, QaFinding[]>();
  for (const finding of analysis.findings) {
    const signature = findingSignature(finding, page, elements, options);
    const bucket = map.get(signature.key) ?? [];
    bucket.push(finding);
    map.set(signature.key, bucket);
  }
  return map;
};

/** How strongly a finding's problem state is represented. */
type FindingRepr =
  | "CONFIRMED" // verification REPRODUCED / WEBSITE — the problem was observed
  | "CLEAN"     // verification PASS / EXPECTATION — element present but clean
  | "ABSENT"    // verification NOT_REPRODUCED + LOCATOR — element not found
  | "PARTIAL"   // REVIEW_REQUIRED / CONDITIONAL / AUTHENTICATION — undecidable
  | "NOT_CONFIRMED" // NOT_REPRODUCED without a decisive category
  | "INFRA"     // infrastructure problem — no site verdict
  | "UNVERIFIED"; // no verification or skipped without outcome

const findingRepr = (finding: QaFinding): FindingRepr => {
  const v = finding.verification;
  if (!v || v.disposition === "SCHEDULED") return "UNVERIFIED";
  switch (v.disposition) {
    case "REPRODUCED":
      return "CONFIRMED";
    case "PASSED":
      return "CLEAN";
    case "NOT_REPRODUCED":
      switch (v.category) {
        case "LOCATOR":
          return "ABSENT";
        case "INFRASTRUCTURE":
          return "INFRA";
        case "CONDITIONAL":
          return "PARTIAL";
        case "AUTHENTICATION":
          return "PARTIAL";
        case "WEBSITE":
          return "CONFIRMED";
        default:
          return "NOT_CONFIRMED";
      }
    case "REVIEW_REQUIRED":
      return "PARTIAL";
    case "INFRASTRUCTURE_PROBLEM":
      return "INFRA";
    default:
      return "UNVERIFIED"; // SKIPPED_*
  }
};

const findingPairVerdict = (base: FindingRepr, curr: FindingRepr): { classification: ChangeClassification; confidence: RegressionConfidence } => {
  if (base === curr) {
    switch (base) {
      case "CONFIRMED":
        return { classification: "UNCHANGED", confidence: "HIGH_CONFIDENCE" };
      case "CLEAN":
        return { classification: "UNCHANGED", confidence: "HIGH_CONFIDENCE" };
      case "ABSENT":
        return { classification: "UNCHANGED", confidence: "MEDIUM_CONFIDENCE" };
      case "PARTIAL":
        return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      case "NOT_CONFIRMED":
        return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      case "INFRA":
        return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
      case "UNVERIFIED":
        return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
    }
  }
  switch (base) {
    case "CONFIRMED":
      switch (curr) {
        case "CLEAN":
          return { classification: "FIXED", confidence: "HIGH_CONFIDENCE" };
        case "ABSENT":
          return { classification: "FIXED", confidence: "HIGH_CONFIDENCE" };
        case "NOT_CONFIRMED":
          return { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" };
        case "PARTIAL":
          return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "REVIEW_REQUIRED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNVERIFIED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "CLEAN":
      switch (curr) {
        case "CONFIRMED":
          return { classification: "REGRESSION", confidence: "HIGH_CONFIDENCE" };
        case "ABSENT":
          return { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" };
        case "NOT_CONFIRMED":
          return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
        case "PARTIAL":
          return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "CHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNVERIFIED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "ABSENT":
      switch (curr) {
        case "CONFIRMED":
          return { classification: "REGRESSION", confidence: "MEDIUM_CONFIDENCE" };
        case "CLEAN":
          return { classification: "FIXED", confidence: "MEDIUM_CONFIDENCE" };
        case "NOT_CONFIRMED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
        case "PARTIAL":
          return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNVERIFIED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "PARTIAL":
      switch (curr) {
        case "CONFIRMED":
          return { classification: "REGRESSION", confidence: "MEDIUM_CONFIDENCE" };
        case "CLEAN":
          return { classification: "FIXED", confidence: "MEDIUM_CONFIDENCE" };
        case "ABSENT":
          return { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
        case "INFRA":
          return { classification: "REVIEW_REQUIRED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "NOT_CONFIRMED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
        case "UNVERIFIED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "NOT_CONFIRMED":
      switch (curr) {
        case "CONFIRMED":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "CLEAN":
          return { classification: "FIXED", confidence: "LOW_CONFIDENCE" };
        case "ABSENT":
          return { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
        case "INFRA":
          return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "PARTIAL":
          return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
        case "UNVERIFIED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "INFRA":
      switch (curr) {
        case "CONFIRMED":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "CLEAN":
          return { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
        case "ABSENT":
          return { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
        case "NOT_CONFIRMED":
          return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "PARTIAL":
          return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNVERIFIED":
          return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
      }
      break;
    case "UNVERIFIED":
      switch (curr) {
        case "CONFIRMED":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "CLEAN":
          return { classification: "FIXED", confidence: "LOW_CONFIDENCE" };
        case "ABSENT":
          return { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
        case "NOT_CONFIRMED":
          return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
        case "PARTIAL":
          return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "UNCHANGED", confidence: "INSUFFICIENT_EVIDENCE" };
      }
      break;
  }
  return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
};

const REPR_WORDS: Record<FindingRepr, string> = {
  CONFIRMED: "verified problem (reproduced on the live page)",
  CLEAN: "verified clean (element present, expectation not met)",
  ABSENT: "element could not be located during verification",
  PARTIAL: "state-dependent or awaiting human review",
  NOT_CONFIRMED: "problem not reproduced (no decisive category)",
  INFRA: "verification failed for infrastructure reasons (no site verdict)",
  UNVERIFIED: "no verification outcome recorded",
};

const verificationPhrase = (finding: QaFinding): string => {
  const v = finding.verification;
  if (!v) return "analyzed only — no verification run attached";
  const outcome = [v.disposition, v.status ?? "", v.category ?? "", v.verdict ?? ""].filter(Boolean).join("/");
  return outcome + (v.reason ? ` — ${v.reason}` : "");
};

/** Current-run findings and flow executions keyed by flowId/scenarioId. */
type FlowOutcomeRef = { category: string | null };
const flowExecutionMap = (analysis: QaAnalysis): Map<string, FlowExecutionResult> =>
  new Map((analysis.flowDiscovery?.executions ?? []).map(execution => [execution.flowId, execution]));

type FlowRepr = "PASSING" | "SYMPTOM" | "FAILING" | "REVIEW" | "BLOCKED" | "INFRA" | "UNKNOWN";

const flowRepr = (execution: FlowExecutionResult | undefined): FlowRepr => {
  if (!execution) return "UNKNOWN";
  switch (execution.status) {
    case "PASS":
      return "PASSING";
    case "REPRODUCED":
      return "SYMPTOM";
    case "NOT_REPRODUCED":
      return "FAILING";
    case "REVIEW_REQUIRED":
      return "REVIEW";
    case "BLOCKED":
      return "BLOCKED";
    case "INFRASTRUCTURE_PROBLEM":
      return "INFRA";
  }
};

const flowPairVerdict = (
  base: FlowRepr,
  curr: FlowRepr,
  currExecution: FlowExecutionResult | undefined,
): { classification: ChangeClassification; confidence: RegressionConfidence } => {
  if (base === curr) {
    switch (base) {
      case "PASSING":
        return { classification: "UNCHANGED_FLOW", confidence: "HIGH_CONFIDENCE" };
      case "SYMPTOM":
        return { classification: "UNCHANGED_FLOW", confidence: "HIGH_CONFIDENCE" };
      case "FAILING":
        return { classification: "UNCHANGED_FLOW", confidence: "MEDIUM_CONFIDENCE" };
      case "REVIEW":
        return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
      case "BLOCKED":
        return { classification: "UNCHANGED_FLOW", confidence: "MEDIUM_CONFIDENCE" };
      case "INFRA":
        return { classification: "UNCHANGED_FLOW", confidence: "INSUFFICIENT_EVIDENCE" };
      case "UNKNOWN":
        return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
    }
  }
  const website = currExecution?.failureCategory === "WEBSITE";
  switch (base) {
    case "PASSING":
      switch (curr) {
        case "SYMPTOM":
          return { classification: "REGRESSION", confidence: "HIGH_CONFIDENCE" };
        case "FAILING":
          return { classification: "REGRESSION", confidence: website ? "HIGH_CONFIDENCE" : "MEDIUM_CONFIDENCE" };
        case "REVIEW":
          return { classification: "CHANGED_FLOW", confidence: "MEDIUM_CONFIDENCE" };
        case "BLOCKED":
          return { classification: "CHANGED_FLOW", confidence: "MEDIUM_CONFIDENCE" };
        case "INFRA":
          return { classification: "INFRASTRUCTURE_PROBLEM", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNKNOWN":
          return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "SYMPTOM":
      switch (curr) {
        case "PASSING":
          return { classification: "FIXED", confidence: "MEDIUM_CONFIDENCE" };
        case "FAILING":
          return { classification: "FIXED", confidence: "LOW_CONFIDENCE" };
        case "REVIEW":
          return { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
        case "BLOCKED":
          return { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
        case "INFRA":
          return { classification: "REVIEW_REQUIRED", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNKNOWN":
          return { classification: "REVIEW_REQUIRED", confidence: "INSUFFICIENT_EVIDENCE" };
      }
      break;
    case "FAILING":
      switch (curr) {
        case "PASSING":
          return { classification: "FIXED", confidence: "MEDIUM_CONFIDENCE" };
        case "SYMPTOM":
          return { classification: "REGRESSION", confidence: "MEDIUM_CONFIDENCE" };
        case "REVIEW":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "BLOCKED":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "INFRASTRUCTURE_PROBLEM", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNKNOWN":
          return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "REVIEW":
      switch (curr) {
        case "PASSING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "SYMPTOM":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "FAILING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "BLOCKED":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "INFRASTRUCTURE_PROBLEM", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNKNOWN":
          return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "BLOCKED":
      switch (curr) {
        case "PASSING":
          return { classification: "CHANGED_FLOW", confidence: "MEDIUM_CONFIDENCE" };
        case "SYMPTOM":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "FAILING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "REVIEW":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "INFRASTRUCTURE_PROBLEM", confidence: "INSUFFICIENT_EVIDENCE" };
        case "UNKNOWN":
          return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "INFRA":
      switch (curr) {
        case "PASSING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "SYMPTOM":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "FAILING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "REVIEW":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "BLOCKED":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "UNKNOWN":
          return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
      }
      break;
    case "UNKNOWN":
      switch (curr) {
        case "PASSING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "SYMPTOM":
          return { classification: "REGRESSION", confidence: "LOW_CONFIDENCE" };
        case "FAILING":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "REVIEW":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "BLOCKED":
          return { classification: "CHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
        case "INFRA":
          return { classification: "INFRASTRUCTURE_PROBLEM", confidence: "INSUFFICIENT_EVIDENCE" };
      }
      break;
  }
  return { classification: "UNCHANGED_FLOW", confidence: "LOW_CONFIDENCE" };
};

const FLOW_WORDS: Record<FlowRepr, string> = {
  PASSING: "executed successfully (PASS)",
  SYMPTOM: "reproduced a problem condition (REPRODUCED)",
  FAILING: "did not reproduce the expected behavior (NOT_REPRODUCED)",
  REVIEW: "outcome requires human review",
  BLOCKED: "execution stopped at a safety boundary",
  INFRA: "infrastructure failure (no site verdict)",
  UNKNOWN: "not executed in this run",
};

const coveragePairVerdict = (base: CoverageStatus, curr: CoverageStatus): { classification: ChangeClassification; confidence: RegressionConfidence } => {
  if (base === curr) {
    return curr === "TESTED"
      ? { classification: "UNCHANGED", confidence: "HIGH_CONFIDENCE" }
      : { classification: "UNCHANGED", confidence: "MEDIUM_CONFIDENCE" };
  }
  if (base === "TESTED" || base === "PARTIALLY_TESTED") {
    if (curr === "NOT_TESTED" || curr === "BLOCKED" || curr === "REVIEW_REQUIRED") {
      return { classification: "COVERAGE_CHANGED", confidence: base === "TESTED" ? "HIGH_CONFIDENCE" : "MEDIUM_CONFIDENCE" };
    }
    if (base === "TESTED" && curr === "PARTIALLY_TESTED") {
      return { classification: "COVERAGE_CHANGED", confidence: "MEDIUM_CONFIDENCE" };
    }
    if (base === "PARTIALLY_TESTED" && curr === "TESTED") {
      return { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" }; // coverage gained
    }
    return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
  }
  if (base === "NOT_TESTED") {
    switch (curr) {
      case "TESTED":
        return { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" }; // coverage gained
      case "PARTIALLY_TESTED":
        return { classification: "CHANGED", confidence: "LOW_CONFIDENCE" };
      case "BLOCKED":
        return { classification: "COVERAGE_CHANGED", confidence: "MEDIUM_CONFIDENCE" };
      case "REVIEW_REQUIRED":
        return { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
      default:
        return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
    }
  }
  if (base === "BLOCKED" || base === "REVIEW_REQUIRED") {
    const regained = curr === "TESTED" || curr === "PARTIALLY_TESTED" || curr === "NOT_TESTED";
    return regained
      ? { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" } // unblocked / reviewable again
      : { classification: "COVERAGE_CHANGED", confidence: "MEDIUM_CONFIDENCE" };
  }
  if (base === "NOT_APPLICABLE") {
    return curr === "NOT_APPLICABLE"
      ? { classification: "UNCHANGED", confidence: "HIGH_CONFIDENCE" }
      : { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" };
  }
  return { classification: "UNCHANGED", confidence: "LOW_CONFIDENCE" };
};

const actionFor = (classification: ChangeClassification): string => {
  switch (classification) {
    case "REGRESSION":
      return "Investigate the current reproduction and restore the previously verified behavior.";
    case "FIXED":
      return "Confirm the fix with a passed execution in the next run before closing.";
    case "NEW":
      return "Review the newly observed item and verify it in a dedicated execution run.";
    case "NEW_FLOW":
      return "Review the newly discovered flow; execution follows the deterministic safety classification.";
    case "REMOVED_FLOW":
      return "Confirm the route/control still exists on the site; re-run discovery before concluding.";
    case "CHANGED":
      return "Inspect what changed; no regression is claimed without negative evidence.";
    case "CHANGED_FLOW":
      return "Re-examine the flow's step semantics; the site behavior around it changed.";
    case "COVERAGE_CHANGED":
      return "Restore or extend the coverage by running the relevant flow/verification.";
    case "REVIEW_REQUIRED":
      return "Human review required — confirm the true state/identity manually.";
    case "INFRASTRUCTURE_PROBLEM":
      return "Re-run on a healthy runner — not a site verdict.";
    default:
      return "No action — the condition is stable between the two runs.";
  }
};

/** Assembles deterministic change records, counts, and headlines. */
class ChangeCollector {
  private readonly changes: RegressionChange[] = [];
  private readonly counts = emptyCounts();
  private sequence = 1;

  add(record: Omit<RegressionChange, "changeId">): void {
    const changeId = `RG-${String(this.sequence).padStart(4, "0")}`;
    this.sequence += 1;
    this.counts[record.classification] += 1;
    this.changes.push({ ...record, changeId });
  }

  all(): RegressionChange[] {
    return this.changes;
  }

  tally(): Record<ChangeClassification, number> {
    return this.counts;
  }
}

const summaryOf = (collector: ChangeCollector, comparable: boolean, reason: string | null): RegressionSummary => {
  const counts = collector.tally();
  const changeCount = collector.all().length;
  let headline: string;
  if (!comparable) {
    headline = `Runs are not comparable: ${reason ?? "unknown reason"}.`;
  } else if (counts.REGRESSION > 0) {
    headline = `${counts.REGRESSION} regression(s) across ${changeCount} change(s) — the pre-existing verified condition changed negatively.`;
  } else if (counts.INFRASTRUCTURE_PROBLEM > 0) {
    headline = `Infrastructure failures observed (${counts.INFRASTRUCTURE_PROBLEM}); not counted as regressions.`;
  } else if (counts.COVERAGE_CHANGED > 0 || counts.REVIEW_REQUIRED > 0) {
    headline = `${counts.COVERAGE_CHANGED + counts.REVIEW_REQUIRED} coverage/review change(s) across ${changeCount} change(s); no regressions detected.`;
  } else if (changeCount === 0) {
    headline = "No changes detected between the two runs.";
  } else {
    headline = `${changeCount} change(s) observed; no regressions detected.`;
  }
  return { comparable, notComparableReason: reason, changeCount, counts, headline };
};

const pagesOf = (analysis: QaAnalysis): { url: string; title: string | null }[] => {
  const pages = analysis.flowDiscovery?.graph.pages.map(page => ({ url: page.url, title: page.title }));
  if (pages && pages.length) return pages;
  return [{ url: analysis.scan.scan.url, title: analysis.scan.scan.title }];
};

const currentPageUrls = (analysis: QaAnalysis): Set<string> => new Set(pagesOf(analysis).map(page => normalizePageUrl(page.url)));

// --- pages comparison ------------------------------------------------------

const comparePages = (
  collector: ChangeCollector,
  baseUrls: Map<string, string>,
  currUrls: Map<string, string>,
  current: QaAnalysis,
  baseline: QaAnalysis,
): void => {
  const baseBroken = new Map((baseline.flowDiscovery?.graph.pages ?? []).map(page => [normalizePageUrl(page.url), page.brokenLinks]));
  const currBroken = new Map((current.flowDiscovery?.graph.pages ?? []).map(page => [normalizePageUrl(page.url), page.brokenLinks]));
  const all = new Set<string>([...baseUrls.keys(), ...currUrls.keys()]);

  for (const url of [...all].sort()) {
    const baseUrl = baseUrls.get(url);
    const currUrl = currUrls.get(url);
    if (baseUrl && !currUrl) {
      collector.add({
        category: "PAGE",
        classification: "REVIEW_REQUIRED",
        confidence: "LOW_CONFIDENCE",
        confidenceReason: "The page exists in the baseline crawl but not in the current run — this may be a crawl budget difference or a real removal, so it is recorded for review, never asserted.",
        anchor: `PAGE ${url}`,
        currentReference: "(none)",
        baselineReference: baseUrl,
        summary: `Page present in baseline but not in the current run.`,
        explanation: "The baseline crawler reached this page; the current run did not. Without a dedicated navigation probe this is not called a regression.",
        evidence: ["Baseline run discovered the page; current run did not."],
        recommendedAction: actionFor("REVIEW_REQUIRED"),
        relatedFindingIds: [],
        relatedFlowIds: [],
        relatedCoverageIds: [],
        relatedRecommendationIds: [],
      });
      continue;
    }
    if (!baseUrl && currUrl) {
      collector.add({
        category: "PAGE",
        classification: "NEW",
        confidence: "HIGH_CONFIDENCE",
        confidenceReason: "The page is present in the current run and was absent from the baseline run — a factual observation.",
        anchor: `PAGE ${url}`,
        currentReference: currUrl,
        baselineReference: "(none)",
        summary: "Page newly discovered in the current run.",
        explanation: "The current crawl discovered a page the baseline run did not visit.",
        evidence: ["Page discovered in the current run; absent from the baseline run."],
        recommendedAction: actionFor("NEW"),
        relatedFindingIds: [],
        relatedFlowIds: [],
        relatedCoverageIds: [],
        relatedRecommendationIds: [],
      });
      continue;
    }
    const brokenBefore = baseBroken.get(url) ?? 0;
    const brokenNow = currBroken.get(url) ?? 0;
    if (brokenNow > brokenBefore) {
      collector.add({
        category: "PAGE",
        classification: "CHANGED",
        confidence: "LOW_CONFIDENCE",
        confidenceReason: "The number of broken outgoing links increased, but each individual link is evaluated by its own flow; this is a surface signal, not a confirmed defect.",
        anchor: `PAGE ${url}`,
        currentReference: currUrl!,
        baselineReference: baseUrl!,
        summary: `Broken links on the page increased from ${brokenBefore} to ${brokenNow}.`,
        explanation: "The current crawl recorded more broken outgoing links than the baseline crawl on the same page.",
        evidence: [`Baseline broken links: ${brokenBefore}`, `Current broken links: ${brokenNow}`],
        recommendedAction: actionFor("CHANGED"),
        relatedFindingIds: [],
        relatedFlowIds: [],
        relatedCoverageIds: [],
        relatedRecommendationIds: [],
      });
    }
  }
};

// ---------------------------------------------------------------------------

export function compareRuns(current: QaAnalysis, baseline: QaAnalysis, options: RegressionCompareOptions = {}): RegressionMap {
  const collector = new ChangeCollector();
  const comparability = comparableRunPair(current, baseline);
  const compatible = options.baselinePath ?? null;

  if (!comparability.comparable) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      baselinePath: compatible,
      summary: summaryOf(collector, false, comparability.reason),
      runs: { baseline: runIdentity(baseline, "baseline"), current: runIdentity(current, "current") },
      changes: [],
      aiNotes: null,
    };
  }

  const elements = current.scan.elements ?? [];
  const baseElements = baseline.scan.elements ?? [];
  const baseUrls = new Map(pagesOf(baseline).map(page => [normalizePageUrl(page.url), page.url]));
  const currUrls = new Map(pagesOf(current).map(page => [normalizePageUrl(page.url), page.url]));
  const currentPages = currentPageUrls(current);

  comparePages(collector, baseUrls, currUrls, current, baseline);

  // --- findings -------------------------------------------------------------
  const currentByKey = identityOf(current, elements, options);
  const baselineByKey = identityOf(baseline, baseElements, options);
  const usedBaseline = new Set<string>();
  const usedCurrent = new Set<string>();

  const baselineFindings = baseline.findings;
  const currentFindings = current.findings;

  const currentNew = [...currentByKey.entries()].flatMap(([key, findings]) =>
    findings.map(finding => ({ key, finding, signature: findingSignature(finding, current.scan.scan.url, elements, options) })),
  );
  const baselineRemaining = [...baselineByKey.entries()].flatMap(([key, findings]) =>
    findings.map(finding => ({ key, finding, signature: findingSignature(finding, baseline.scan.scan.url, baseElements, options) })),
  );

  const anchorOf = (signature: { page: string }, code: string): string => `FINDING ${code} @ ${signature.page}`;

  // Pair exact matchers first.
  for (const candidate of currentNew) {
    const bucket = (baselineByKey.get(candidate.key) ?? []).filter(f => !usedBaseline.has(f.id));
    if (bucket.length === 0) continue;
    const matchedBaseline = bucket[0]!;
    usedBaseline.add(matchedBaseline.id);
    usedCurrent.add(candidate.finding.id);

    const base = findingRepr(matchedBaseline);
    const curr = findingRepr(candidate.finding);
    const verdict = findingPairVerdict(base, curr);
    const page = candidate.signature.page;
    const summary =
      base === curr
        ? `Finding ${candidate.finding.code} on ${page} unchanged.`
        : `Finding ${candidate.finding.code} on ${page}: ${REPR_WORDS[base].replace(/^verified /, "baseline verified ")} → ${REPR_WORDS[curr].replace(/^verified /, "current verified ")}.`;

    collector.add({
      category: "FINDING",
      classification: verdict.classification,
      confidence: verdict.confidence,
      confidenceReason: `${base.replace(/_/g, " ").toLowerCase()} baseline outcome vs ${curr.replace(/_/g, " ").toLowerCase()} current outcome → ${verdict.confidence.replace(/_/g, " ").toLowerCase()}.`,
      anchor: anchorOf(candidate.signature, candidate.finding.code),
      currentReference: candidate.finding.id,
      baselineReference: matchedBaseline.id,
      summary,
      explanation:
        base === curr
          ? "Both runs describe the same semantic target with the same verified outcome. A differing DOM snapshot is not evidence of change."
          : `The baseline records "${REPR_WORDS[base]}" and the current run records "${REPR_WORDS[curr]}" for the same code + page + semantic target.`,
      evidence: [`Baseline: ${verificationPhrase(matchedBaseline)}`, `Current: ${verificationPhrase(candidate.finding)}`],
      recommendedAction: actionFor(verdict.classification),
      relatedFindingIds: [matchedBaseline.id, candidate.finding.id],
      relatedFlowIds: [],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  // Remaining baseline findings: disappeared from the current run.
  const remainingBaseline = baselineRemaining.filter(item => !usedBaseline.has(item.finding.id));
  for (const item of remainingBaseline) {
    const stillPresent = currentByKey.has(item.key);
    const base = findingRepr(item.finding);
    if (base === "CLEAN") continue; // was never a defect
    const ambiguity = !stillPresent &&
      item.signature.family !== "" &&
      currentFindings.some(candidate =>
        candidate.code === item.finding.code &&
        normalizePageUrl(current.scan.scan.url) === item.signature.page &&
        elementFamilyKeyOf(current, candidate) === item.signature.family &&
        // The same-family candidate must be NEW relative to the baseline: if its
        // semantic signature already existed in the baseline (a survivor twin),
        // the family is already explained and the missing occurrence is a genuine
        // removal, not a relabeled element.
        !baselineByKey.has(findingSignature(candidate, current.scan.scan.url, elements, options).key),
      );

    const pageStillScanned = currentPages.has(item.signature.page) || normalizePageUrl(current.scan.scan.url) === item.signature.page;
    let verdict: { classification: ChangeClassification; confidence: RegressionConfidence };
    if (!pageStillScanned) {
      verdict = { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
    } else if (ambiguity) {
      verdict = { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
    } else if (stillPresent) {
      verdict = { classification: "CHANGED", confidence: "MEDIUM_CONFIDENCE" };
    } else {
      switch (base) {
        case "CONFIRMED":
          verdict = { classification: "FIXED", confidence: "HIGH_CONFIDENCE" };
          break;
        case "PARTIAL":
          verdict = { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
          break;
        case "ABSENT":
          verdict = { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
          break;
        case "NOT_CONFIRMED":
          verdict = { classification: "REVIEW_REQUIRED", confidence: "MEDIUM_CONFIDENCE" };
          break;
        case "INFRA":
          verdict = { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
          break;
        default:
          verdict = { classification: "REVIEW_REQUIRED", confidence: "LOW_CONFIDENCE" };
      }
    }

    collector.add({
      category: "FINDING",
      classification: verdict.classification,
      confidence: verdict.confidence,
      confidenceReason:
        verdict.classification === "FIXED"
          ? "The defect was previously verified (reproduced) and the same semantic target no longer appears in the current scan — strong fix evidence."
          : verdict.classification === "CHANGED"
            ? "The finding still exists in the current run but one occurrence is gone — a partial change, not a full fix."
            : ambiguity
              ? "A same-code, same-family element appeared with different text/locator — identity is ambiguous, so this is recorded for review."
              : "The baseline never confirmed the problem with reproducible evidence (or review/infra/absence prevented confirmation) — missing evidence alone is never a fix.",
      anchor: anchorOf(item.signature, item.finding.code),
      currentReference: stillPresent ? currentByKey.get(item.key)![0]!.id : "(none)",
      baselineReference: item.finding.id,
      summary: `Finding ${item.finding.code} on ${item.signature.page} no longer present${stillPresent ? " (one occurrence removed)" : " in the current run"}.`,
      explanation:
        verdict.classification === "FIXED"
          ? "Baseline verification reproduced the problem; the current scan of the same page no longer yields this finding, and verification of the condition is now clean or absent."
          : "The baseline was unconfirmed (unverified / not reproduced / unknown) so the disappearance alone is not proof of a fix. Target appears only when the current run clearly shows the condition clean.",
      evidence: [`Baseline: ${verificationPhrase(item.finding)}`, "Current scan of the same page does not report this finding."],
      recommendedAction: actionFor(verdict.classification),
      relatedFindingIds: [item.finding.id],
      relatedFlowIds: [],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  // NEW findings.
  for (const candidate of currentNew) {
    if (usedCurrent.has(candidate.finding.id)) continue;
    collector.add({
      category: "FINDING",
      classification: "NEW",
      confidence: "HIGH_CONFIDENCE",
      confidenceReason: "Present in the current run and absent from the baseline run for the same code + page + semantic target — a factual observation.",
      anchor: anchorOf(candidate.signature, candidate.finding.code),
      currentReference: candidate.finding.id,
      baselineReference: "(none)",
      summary: `Finding ${candidate.finding.code} newly observed on ${candidate.signature.page} (${verificationPhrase(candidate.finding)}).`,
      explanation: "The current run reports this finding where the baseline run did not.",
      evidence: [verificationPhrase(candidate.finding), "Absent from the baseline run."],
      recommendedAction: actionFor("NEW"),
      relatedFindingIds: [candidate.finding.id],
      relatedFlowIds: [],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  // --- flows ------------------------------------------------------------------
  const currentFlows = current.flowDiscovery?.flows ?? [];
  const baselineFlows = baseline.flowDiscovery?.flows ?? [];
  const currentExec = flowExecutionMap(current);
  const baselineExec = flowExecutionMap(baseline);
  const baseFlowByKey = new Map<string, DiscoveredFlow>();
  for (const flow of baselineFlows) baseFlowByKey.set(flowSignature(flow, options), flow);

  const matchedBaselineFlows = new Set<DiscoveredFlow>();
  const matchedCurrentFlows = new Set<DiscoveredFlow>();

  for (const flow of currentFlows) {
    const baselineMatch = baseFlowByKey.get(flowSignature(flow, options));
    if (!baselineMatch) continue;
    matchedCurrentFlows.add(flow);
    matchedBaselineFlows.add(baselineMatch);
    const base = flowRepr(baselineExec.get(baselineMatch.flowId));
    const curr = flowRepr(currentExec.get(flow.flowId));
    const verdict = flowPairVerdict(base, curr, currentExec.get(flow.flowId));
    const fam = flowFamilyKey(flow, options);
    const baseExec = baselineExec.get(baselineMatch.flowId);
    const currExecNow = currentExec.get(flow.flowId);
    collector.add({
      category: "FLOW",
      classification: verdict.classification,
      confidence: verdict.confidence,
      confidenceReason: `${base.toLowerCase()} baseline outcome vs ${curr.toLowerCase()} current outcome → ${verdict.confidence.replace(/_/g, " ").toLowerCase()}.`,
      anchor: `FLOW ${fam}`,
      currentReference: flow.flowId,
      baselineReference: baselineMatch.flowId,
      summary: `Flow ${flow.category} @ ${flow.startUrl}: ${FLOW_WORDS[base]} → ${FLOW_WORDS[curr]}.`,
      explanation:
        base === curr
          ? "Same semantic flow identity (category + start page + step targets) with the same execution outcome in both runs."
          : "The flow's execution outcome changed. The comparison matches flows by semantic identity (category + normalized start page + meaningful step targets), never by regenerated flow ids or locators.",
      evidence: [
        `Baseline execution: ${baseExec ? `${baseExec.status}${baseExec.failureCategory ? ` [${baseExec.failureCategory}]` : ""}` : "not executed"}`,
        `Current execution: ${currExecNow ? `${currExecNow.status}${currExecNow.failureCategory ? ` [${currExecNow.failureCategory}]` : ""}` : "not executed"}`,
      ],
      recommendedAction: actionFor(verdict.classification),
      relatedFindingIds: [],
      relatedFlowIds: [baselineMatch.flowId, flow.flowId],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  // Loose pairing: same category + start page, different step semantics → changed flow.
  const remainingBaseFlows = baselineFlows.filter(flow => !matchedBaselineFlows.has(flow));
  const remainingCurrFlows = currentFlows.filter(flow => !matchedCurrentFlows.has(flow));
  const baseFamily = new Map<string, DiscoveredFlow[]>();
  for (const flow of remainingBaseFlows) {
    const family = flowFamilyKey(flow, options);
    const bucket = baseFamily.get(family) ?? [];
    bucket.push(flow);
    baseFamily.set(family, bucket);
  }
  for (const flow of remainingCurrFlows) {
    const family = flowFamilyKey(flow, options);
    const bucket = (baseFamily.get(family) ?? []).filter(candidate => !matchedBaselineFlows.has(candidate));
    if (bucket.length === 0) continue;
    const baselineMatch = bucket[0]!;
    matchedBaselineFlows.add(baselineMatch);
    matchedCurrentFlows.add(flow);
    collector.add({
      category: "FLOW",
      classification: "CHANGED_FLOW",
      confidence: "HIGH_CONFIDENCE",
      confidenceReason: "Two flows share category and start page but their meaningful step targets differ — a factual step-sequence change.",
      anchor: `FLOW ${family}`,
      currentReference: flow.flowId,
      baselineReference: baselineMatch.flowId,
      summary: `Flow ${flow.category} @ ${flow.startUrl} changed its step semantics.`,
      explanation: "The same category + start page now carries a different step sequence; a locator/selector change alone would never be reported here.",
      evidence: [
        `Baseline steps: ${baselineMatch.steps.map(step => step.action).join("→") || "(none)"}`,
        `Current steps: ${flow.steps.map(step => step.action).join("→") || "(none)"}`,
      ],
      recommendedAction: actionFor("CHANGED_FLOW"),
      relatedFindingIds: [],
      relatedFlowIds: [baselineMatch.flowId, flow.flowId],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  for (const flow of currentFlows) {
    if (matchedCurrentFlows.has(flow)) continue;
    collector.add({
      category: "FLOW",
      classification: "NEW_FLOW",
      confidence: "HIGH_CONFIDENCE",
      confidenceReason: "Present in the current run and absent from the baseline run by semantic flow identity — a factual observation.",
      anchor: `FLOW ${flowFamilyKey(flow, options)}`,
      currentReference: flow.flowId,
      baselineReference: "(none)",
      summary: `Flow ${flow.category} @ ${flow.startUrl} newly discovered.`,
      explanation: "Current discovery produced a flow the baseline run did not (same category + start page + step targets absent before).",
      evidence: ["Flow present in current discovery; absent from baseline discovery."],
      recommendedAction: actionFor("NEW_FLOW"),
      relatedFindingIds: [],
      relatedFlowIds: [flow.flowId],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  for (const flow of baselineFlows) {
    if (matchedBaselineFlows.has(flow)) continue;
    collector.add({
      category: "FLOW",
      classification: "REMOVED_FLOW",
      confidence: "MEDIUM_CONFIDENCE",
      confidenceReason: "The flow existed in the baseline run but the current discovery no longer produces it — a genuine discovery change, with the caveat that crawl budgets can affect discovery.",
      anchor: `FLOW ${flowFamilyKey(flow, options)}`,
      currentReference: "(none)",
      baselineReference: flow.flowId,
      summary: `Flow ${flow.category} @ ${flow.startUrl} no longer discovered.`,
      explanation: "The baseline ran this flow; the current run does not discover an equivalent flow. This is recorded as a flow removal, not automatically a regression.",
      evidence: [`Baseline execution: ${baselineExec.get(flow.flowId)?.status ?? "not executed"}`, "Not discovered in the current run."],
      recommendedAction: actionFor("REMOVED_FLOW"),
      relatedFindingIds: [],
      relatedFlowIds: [flow.flowId],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  // --- coverage -------------------------------------------------------------
  const currentCoverage = current.coverage;
  const baselineCoverage = baseline.coverage;
  if (currentCoverage && baselineCoverage) {
    const baseItems = new Map<string, CoverageItem>();
    for (const item of baselineCoverage.items) baseItems.set(coverageItemSignature(item, options), item);
    const currItems = new Map<string, CoverageItem>();
    for (const item of currentCoverage.items) currItems.set(coverageItemSignature(item, options), item);

    const matchedBase = new Set<CoverageItem>();
    for (const item of currentCoverage.items) {
      const key = coverageItemSignature(item, options);
      const baselineItem = baseItems.get(key);
      if (!baselineItem) continue;
      matchedBase.add(baselineItem);
      const verdict = coveragePairVerdict(baselineItem.status, item.status);
      const change =
        verdict.classification === "UNCHANGED"
          ? `Coverage item ${item.category} stable.`
          : `Coverage item ${item.category} (${item.name}): ${baselineItem.status} → ${item.status}.`;
      collector.add({
        category: "COVERAGE",
        classification: verdict.classification,
        confidence: verdict.confidence,
        confidenceReason: `Coverage status ${baselineItem.status} → ${item.status} — every status is a direct count of items/executions, never a score.`,
        anchor: `COVERAGE ${item.category}: ${item.name}`,
        currentReference: item.coverageId,
        baselineReference: baselineItem.coverageId,
        summary: change,
        explanation:
          verdict.classification === "COVERAGE_CHANGED"
            ? "Previously tested (or partly tested) coverage is no longer met in the current run — a coverage regression signal, recorded without claiming a website regression."
            : verdict.classification === "REVIEW_REQUIRED"
              ? "This coverage area now requires human review before it can be exercised."
              : verdict.classification === "CHANGED"
                ? "The coverage status improved or its surface changed; positive/neutral, not a regression."
                : "The same coverage status holds in both runs.",
        evidence: [`Baseline status: ${baselineItem.status}${baselineItem.executionStatus ? ` (${baselineItem.executionStatus})` : ""}`, `Current status: ${item.status}${item.executionStatus ? ` (${item.executionStatus})` : ""}`],
        recommendedAction: actionFor(verdict.classification),
        relatedFindingIds: [...new Set([...baselineItem.relatedFindings, ...item.relatedFindings])],
        relatedFlowIds: [...new Set([...baselineItem.relatedFlows, ...item.relatedFlows])],
        relatedCoverageIds: [baselineItem.coverageId, item.coverageId],
        relatedRecommendationIds: [],
      });
    }

    for (const item of baselineCoverage.items) {
      if (matchedBase.has(item)) continue;
      const negative =
        item.status === "TESTED" || item.status === "PARTIALLY_TESTED" || item.status === "BLOCKED" || item.status === "REVIEW_REQUIRED";
      collector.add({
        category: "COVERAGE",
        classification: "COVERAGE_CHANGED",
        confidence: negative ? "HIGH_CONFIDENCE" : "MEDIUM_CONFIDENCE",
        confidenceReason: "The baseline coverage item has no counterpart in the current run — a coverage loss relative to the baseline.",
        anchor: `COVERAGE ${item.category}: ${item.name}`,
        currentReference: "(none)",
        baselineReference: item.coverageId,
        summary: `Coverage item ${item.category} ${item.status} no longer present.`,
        explanation: "The current run no longer produces this coverage item. It may reflect crawl differences or a real site change; it is never automatically a website regression.",
        evidence: [`Baseline status: ${item.status}${item.executionStatus ? ` (${item.executionStatus})` : ""}`, "No matching item in the current run."],
        recommendedAction: actionFor("COVERAGE_CHANGED"),
        relatedFindingIds: item.relatedFindings,
        relatedFlowIds: item.relatedFlows,
        relatedCoverageIds: [item.coverageId],
        relatedRecommendationIds: [],
      });
    }

    for (const item of currentCoverage.items) {
      const key = coverageItemSignature(item, options);
      if (baseItems.has(key)) continue;
      const blockingStatus = item.status === "BLOCKED";
      const reviewStatus = item.status === "REVIEW_REQUIRED";
      collector.add({
        category: "COVERAGE",
        classification: blockingStatus || reviewStatus ? (reviewStatus ? "REVIEW_REQUIRED" : "COVERAGE_CHANGED") : "NEW",
        confidence: "HIGH_CONFIDENCE",
        confidenceReason: "A coverage item exists in the current run that the baseline did not have — factual; a NEWLY BLOCKED/REVIEW item is a negative coverage change.",
        anchor: `COVERAGE ${item.category}: ${item.name}`,
        currentReference: item.coverageId,
        baselineReference: "(none)",
        summary: `Coverage item ${item.category} ${item.status} newly present.`,
        explanation: blockingStatus
          ? "The current run added a coverage item that is BLOCKED (cannot be exercised safely) — coverage narrowed."
          : reviewStatus
            ? "The current run added coverage that now requires human review before it can be exercised."
            : "The current run added a NEW coverage item (page/flow/interaction newly surfaced or newly executed).",
        evidence: [`Current status: ${item.status}${item.executionStatus ? ` (${item.executionStatus})` : ""}`, "Absent from the baseline run."],
        recommendedAction: actionFor(blockingStatus || reviewStatus ? "COVERAGE_CHANGED" : "NEW"),
        relatedFindingIds: item.relatedFindings,
        relatedFlowIds: item.relatedFlows,
        relatedCoverageIds: [item.coverageId],
        relatedRecommendationIds: [],
      });
    }

    // --- test-plan recommendations -----------------------------------------
    const baseRecs = new Map<string, TestPlanRecommendation>();
    for (const rec of baselineCoverage.testPlan) baseRecs.set(recommendationSignature(rec), rec);
    const currRecs = new Map<string, TestPlanRecommendation>();
    for (const rec of currentCoverage.testPlan) currRecs.set(recommendationSignature(rec), rec);

    const matchedRecs = new Set<TestPlanRecommendation>();
    for (const rec of currentCoverage.testPlan) {
      const key = recommendationSignature(rec);
      const baseRec = baseRecs.get(key);
      if (!baseRec) continue;
      matchedRecs.add(baseRec);
      if (rec.priority === baseRec.priority) {
        collector.add({
          category: "RECOMMENDATION",
          classification: "UNCHANGED",
          confidence: "HIGH_CONFIDENCE",
          confidenceReason: "Recommendation identity, target, and priority are identical between runs.",
          anchor: `RECOMMENDATION ${rec.type}`,
          currentReference: rec.recommendationId,
          baselineReference: baseRec.recommendationId,
          summary: `Recommendation ${rec.type} unchanged (priority ${rec.priority}).`,
          explanation: "The same recommendation (type + targets + priority) persists in both runs.",
          evidence: [`Baseline: ${baseRec.recommendationId} [${baseRec.priority}]`, `Current: ${rec.recommendationId} [${rec.priority}]`],
          recommendedAction: actionFor("UNCHANGED"),
          relatedFindingIds: rec.relatedFindings,
          relatedFlowIds: [],
          relatedCoverageIds: rec.coverageIds,
          relatedRecommendationIds: [rec.recommendationId],
        });
      } else {
        collector.add({
          category: "RECOMMENDATION",
          classification: "CHANGED",
          confidence: "MEDIUM_CONFIDENCE",
          confidenceReason: "The same recommendation exists in both runs with a different priority — a factual priority change.",
          anchor: `RECOMMENDATION ${rec.type}`,
          currentReference: rec.recommendationId,
          baselineReference: baseRec.recommendationId,
          summary: `Recommendation ${rec.type} priority changed from ${baseRec.priority} to ${rec.priority}.`,
          explanation: "The recommendation kept its identity and target but the deterministic plan re-prioritized it.",
          evidence: [`Baseline: [${baseRec.priority}] ${baseRec.title}`, `Current: [${rec.priority}] ${rec.title}`],
          recommendedAction: actionFor("CHANGED"),
          relatedFindingIds: rec.relatedFindings,
          relatedFlowIds: [],
          relatedCoverageIds: rec.coverageIds,
          relatedRecommendationIds: [rec.recommendationId],
        });
      }
    }

    for (const rec of currentCoverage.testPlan) {
      const key = recommendationSignature(rec);
      if (baseRecs.has(key)) continue;
      collector.add({
        category: "RECOMMENDATION",
        classification: "NEW",
        confidence: "HIGH_CONFIDENCE",
        confidenceReason: "The recommendation is present in the current test plan and absent from the baseline — factual.",
        anchor: `RECOMMENDATION ${rec.type}`,
        currentReference: rec.recommendationId,
        baselineReference: "(none)",
        summary: `New recommendation: ${rec.title} [${rec.priority}].`,
        explanation: "The current test plan added a recommendation the baseline plan did not have.",
        evidence: [`Current: ${rec.recommendationId} [${rec.priority}] ${rec.title}`, "Absent from the baseline test plan."],
        recommendedAction: actionFor("NEW"),
        relatedFindingIds: rec.relatedFindings,
        relatedFlowIds: [],
        relatedCoverageIds: rec.coverageIds,
        relatedRecommendationIds: [rec.recommendationId],
      });
    }

    for (const rec of baselineCoverage.testPlan) {
      if (matchedRecs.has(rec)) continue;
      const resolved = (rec.coverageIds.length > 0 && rec.coverageIds.every(id => {
        const curr = currentCoverage.items.find(item => item.coverageId === id);
        return curr && curr.status === "TESTED";
      })) && rec.relatedFindings.every(id =>
        current.findings.some(finding => finding.id === id && findingRepr(finding) === "CLEAN") ||
        !baseline.findings.some(finding => finding.id === id && findingRepr(finding) === "CONFIRMED"),
      );
      collector.add({
        category: "RECOMMENDATION",
        classification: resolved ? "CHANGED" : "REVIEW_REQUIRED",
        confidence: resolved ? "MEDIUM_CONFIDENCE" : "LOW_CONFIDENCE",
        confidenceReason: resolved
          ? "The recommendation disappeared while every targeted coverage item is now TESTED and no previously-confirmed related finding persists — it resolved."
          : "The recommendation disappeared without evidence its underlying cause is resolved — never assumed fixed.",
        anchor: `RECOMMENDATION ${rec.type}`,
        currentReference: "(none)",
        baselineReference: rec.recommendationId,
        summary: resolved
          ? `Recommendation ${rec.type} resolved (no longer recommended).`
          : `Recommendation ${rec.type} dropped without confirmed resolution.`,
        explanation: resolved
          ? "Every coverage target of this recommendation is now TESTED and the related confirmed findings are gone — the plan no longer recommends it, with evidence."
          : "The baseline plan recommended this; the current plan does not, but its underlying cause has no confirmed resolution — recorded for review, never assumed fixed.",
        evidence: [`Baseline: ${rec.recommendationId} [${rec.priority}] ${rec.title}`, `Targets: ${rec.coverageIds.join(", ") || "(none)"}`],
        recommendedAction: actionFor(resolved ? "CHANGED" : "REVIEW_REQUIRED"),
        relatedFindingIds: rec.relatedFindings,
        relatedFlowIds: [],
        relatedCoverageIds: rec.coverageIds,
        relatedRecommendationIds: [rec.recommendationId],
      });
    }
  } else if (currentCoverage?.items.length || baselineCoverage?.items.length) {
    collector.add({
      category: "COVERAGE",
      classification: "REVIEW_REQUIRED",
      confidence: "INSUFFICIENT_EVIDENCE",
      confidenceReason: "Only one of the two runs carries a coverage map — coverage cannot be compared layer-to-layer.",
      anchor: "COVERAGE (coverage maps)",
      currentReference: currentCoverage ? `${currentCoverage.items.length} item(s)` : "(none)",
      baselineReference: baselineCoverage ? `${baselineCoverage.items.length} item(s)` : "(none)",
      summary: "One of the two runs lacks a coverage map — coverage comparison skipped.",
      explanation: "Coverage comparison requires both runs to carry a coverage map; otherwise no coverage claim is made.",
      evidence: [`Baseline coverage map: ${baselineCoverage ? "present" : "absent"}`, `Current coverage map: ${currentCoverage ? "present" : "absent"}`],
      recommendedAction: actionFor("REVIEW_REQUIRED"),
      relatedFindingIds: [],
      relatedFlowIds: [],
      relatedCoverageIds: [],
      relatedRecommendationIds: [],
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baselinePath: compatible,
    summary: summaryOf(collector, true, null),
    runs: { baseline: runIdentity(baseline, "baseline"), current: runIdentity(current, "current") },
    changes: collector.all(),
    aiNotes: null,
  };
}

/** Bounded AI application: only headline + per-change notes for EXISTING change
 *  ids may be attached. Classifications, confidence, references, and evidence
 *  are never rewritten. */
export function applyRegressionNotes(map: RegressionMap, enhancement: RegressionEnhancement | null, providerName: string | null): RegressionMap {
  if (!enhancement || !providerName) return map;
  const existingIds = new Set(map.changes.map(change => change.changeId));
  const headline = typeof enhancement.headline === "string" && enhancement.headline.trim() ? enhancement.headline.trim().slice(0, 300) : undefined;
  const notes = (enhancement.notes ?? [])
    .filter(note => note && note.changeId && existingIds.has(note.changeId) && typeof note.note === "string" && note.note.trim())
    .slice(0, map.changes.length)
    .map(note => ({ changeId: note.changeId as string, note: (note.note as string).trim().slice(0, 500) }));
  if (!headline && !notes.length) return map;
  return { ...map, aiNotes: { headline, notes, provider: providerName } };
}

// --- small shared helpers ---------------------------------------------------

const elementFamilyKeyOf = (analysis: QaAnalysis, finding: QaFinding): string => {
  const ref = finding.evidence.find(item => item.type === "element");
  if (!ref) return "";
  if (ref.index != null && ref.index >= 0 && analysis.scan.elements[ref.index]) return elementFamilyKey(analysis.scan.elements[ref.index]!);
  return "";
};