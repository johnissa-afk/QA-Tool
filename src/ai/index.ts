import { GeneratedTestSuite, ScanReport } from "../types.js";
import { buildFindings } from "./analysis.js";
import { detectFlows, relateFlows } from "./flows.js";
import { AnalysisParts, applyEnhancement, createAIProvider } from "./provider.js";
import { buildIntentScenarios, decorateScenarios } from "./scenarios.js";
import { buildSummary } from "./summary.js";
import { AIContext, AIProvider, QaAnalysis, QaExecution, VerificationResult } from "./types.js";
import { AI_SCHEMA_VERSION } from "./types.js";
import { applyVerification, explainStatus, recomputeOverallStatus, VerificationBundle } from "./lifecycle.js";
import { summarizeVerifications } from "./triage.js";
import { applyFlowAnalysis, buildFlowDiscovery, summarizeFlows } from "../flow/analysis.js";
import { defaultFlowLimits } from "../flow/graph.js";
import type { FlowLimits, FlowDigest, SiteGraph } from "../flow/types.js";
import { buildCoverage } from "../coverage/index.js";

// ---------------------------------------------------------------------------
// The analysis pipeline: scan facts -> deterministic findings/flows/scenarios
// -> optional bounded AI refinement -> QA summary -> QaAnalysis document.
//
// The deterministic engine always produces the safety baseline. AI may only
// reword/repair within validated bounds; it can never invent evidence.
// ---------------------------------------------------------------------------
export type AnalyzeOptions = {
  suite?: GeneratedTestSuite | null;
  provider?: AIProvider;
  /** Phase 3: limits for autonomous flow discovery (safety-guarded). */
  flowLimits?: FlowLimits;
  /** Phase 3: pre-built site graph (from a crawl) to discover flows from. */
  siteGraph?: SiteGraph;
  /** Phase 8E: when false, skip the deterministic coverage map entirely
   *  (`coverage.enabled = false`). Defaults to true — the pre-8E behavior. */
  coverage?: boolean;
};

export async function analyzeScan(report: ScanReport, options: AnalyzeOptions = {}): Promise<QaAnalysis> {
  const provider = options.provider ?? createAIProvider();
  const suite = options.suite ?? null;
  const generatedAt = new Date().toISOString();

   const findings = buildFindings(report).map(finding => ({ ...finding, lifecycle: "ANALYZED" as const }));
   if (report.access && !report.access.continueScan) {
     const accessStatus = report.access.accessStatus;
     const prerequisiteStatus: "REVIEW_REQUIRED" | "BLOCKED" = accessStatus === "access-blocked" ? "BLOCKED" : "REVIEW_REQUIRED";
     const summary = buildSummary(report, [], [], [], null, provider.mode, provider.name, `QA (${accessStatus}): access prerequisite requires human review before normal website QA can run.`);
     return {
       schemaVersion: AI_SCHEMA_VERSION,
       generatedAt,
       mode: provider.mode,
       aiProvider: provider.name,
       scan: report,
       accessPrerequisite: report.accessPrerequisite ?? {
         type: accessStatus,
         status: prerequisiteStatus,
         message: report.access.reason,
         httpStatus: report.access.httpStatus,
         challenge: report.access.challenge,
       },
       findings: [],
       flows: [],
       scenarios: [],
       elementScenarios: [],
       verifications: [],
       flowDiscovery: null,
       coverage: null,
       regression: null,
       intelligence: null,
       execution: null,
       summary,
     };
   }
  const elementScenarios = suite ? decorateScenarios(suite) : [];
  const flows = relateFlows(detectFlows(report), elementScenarios);
  const scenarios = buildIntentScenarios(report, flows, findings, elementScenarios);

  const context: AIContext = {
    url: report.scan.url,
    title: report.scan.title,
    mode: "deterministic",
    findings: findings.map(finding => ({ id: finding.id, code: finding.code, severity: finding.severity, confidence: finding.confidence, count: finding.count, message: finding.description })),
    flows: flows.map(flow => ({ id: flow.id, kind: flow.kind, title: flow.title })),
    scenarios: scenarios.map(scenario => ({ id: scenario.id, intent: scenario.intent, priority: scenario.priority, title: scenario.title })),
  };

  const enhancement = provider.mode === "ai-enhanced" ? await provider.enhance(context) : null;
  const parts: AnalysisParts = { findings, flows, scenarios };
  const merged = applyEnhancement(parts, enhancement);

  // Phase 3: deterministic user-flow discovery. AI may only reword/prioritize.
  const flowLimits = options.flowLimits ?? defaultFlowLimits();
  let flowDiscovery = buildFlowDiscovery(report, flowLimits, [], options.siteGraph);
  if (provider.mode === "ai-enhanced" && typeof provider.analyzeFlows === "function") {
    try {
      const digests: FlowDigest[] = flowDiscovery.flows.map(flow => ({
        flowId: flow.flowId,
        category: flow.category,
        title: flow.title,
        safety: flow.safety,
        automation: flow.automation,
        priority: flow.priority,
        startUrl: flow.startUrl,
      }));
      const enhancements = await provider.analyzeFlows(digests, { url: report.scan.url, title: report.scan.title });
      if (enhancements) {
        const byId = new Map(enhancements.map(item => [item.flowId, item]));
        const refinedFlows = flowDiscovery.flows.map(flow => applyFlowAnalysis(flow, byId.get(flow.flowId) ?? null));
        const refinedChanged = refinedFlows.some((flow, index) => flow.title !== flowDiscovery.flows[index]?.title || flow.priority !== flowDiscovery.flows[index]?.priority);
        if (refinedChanged) flowDiscovery = { ...flowDiscovery, flows: refinedFlows, summary: summarizeFlows(refinedFlows, [], flowDiscovery.graph.pages.length) };
      }
    } catch { /* keep the deterministic discovery */ }
  }

  // Phase 4: deterministic, evidence-based coverage map + test plan. The AI
  // coverage refinement (reworded gaps / reprioritized recommendations) is
  // applied by the CLI AFTER flow executions, because the test plan changes as
  // executions land — analyzeScan always produces the pure deterministic map.
  let coverage = null as QaAnalysis["coverage"];
  if (flowDiscovery && options.coverage !== false) {
    coverage = buildCoverage({
      report,
      flowDiscovery,
      findings: merged.findings,
      verifications: [],
    });
  }

  const summary = buildSummary(
    report,
    merged.findings,
    merged.flows,
    merged.scenarios,
    suite,
    provider.mode,
    provider.name,
    enhancement?.summary?.headline,
    enhancement?.summary?.topRecommendations,
    { verified: 0, reproduced: 0, notReproduced: 0, pass: 0, review: 0, infrastructureFailures: 0, unverified: merged.findings.length, scheduled: 0, executed: 0, skippedUnsupported: 0, skippedLocatorGuard: 0, skippedSafety: 0, reviewRequired: 0, infrastructureProblems: 0, verificationRun: false },
    flowDiscovery.summary,
    coverage?.summary ?? null,
  );

  return {
    schemaVersion: AI_SCHEMA_VERSION,
    generatedAt,
    mode: provider.mode,
    aiProvider: provider.name,
    scan: report,
    findings: merged.findings,
    flows: merged.flows,
    scenarios: merged.scenarios,
    elementScenarios,
    verifications: [] as VerificationResult[],
    flowDiscovery,
    coverage,
    regression: null,
    intelligence: null,
    execution: null as QaExecution | null,
    summary,
  };
}

export { AI_SCHEMA_VERSION, buildFindings, detectFlows, decorateScenarios, buildIntentScenarios, buildSummary, applyVerification, explainStatus, recomputeOverallStatus, summarizeVerifications };
export type { VerificationBundle };