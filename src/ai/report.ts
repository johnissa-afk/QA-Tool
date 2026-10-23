import { atomicWriteText } from "../atomic-write.js";
import { extname, resolve } from "node:path";
import { QaAnalysis, QaFinding, Severity } from "./types.js";
import { escapeHtml, safeHref } from "../html-escape.js";
import { PERF_METRIC_LABELS, isPerfBudgetCode } from "../perf-budgets.js";
import type { PerformanceMetrics } from "../types.js";
import type { HistoricalIntelligenceMap } from "../history-intelligence/types.js";

// ---------------------------------------------------------------------------
// QA analysis HTML report (15 sections).
// ---------------------------------------------------------------------------

const REGRESSION_TONES: Record<string, string> = {
  REGRESSION: "badge-status-fail",
  INFRASTRUCTURE_PROBLEM: "badge-status-review",
  REVIEW_REQUIRED: "badge-status-review",
  COVERAGE_CHANGED: "badge-conf-medium",
  FIXED: "badge-status-pass",
  NEW: "badge-info",
  CHANGED: "badge-conf-medium",
  NEW_FLOW: "badge-flow",
  REMOVED_FLOW: "badge-conf-low",
  CHANGED_FLOW: "badge-flow",
  UNCHANGED: "badge-state",
  UNCHANGED_FLOW: "badge-state",
};

const REGRESSION_DISPLAY_ORDER = [
  "REGRESSION",
  "INFRASTRUCTURE_PROBLEM",
  "REVIEW_REQUIRED",
  "COVERAGE_CHANGED",
  "FIXED",
  "NEW",
  "REMOVED_FLOW",
  "CHANGED_FLOW",
  "NEW_FLOW",
  "CHANGED",
  "UNCHANGED_FLOW",
  "UNCHANGED",
];

const confidenceBadgeFor = (confidence: string): string => {
  const tone = confidence === "HIGH_CONFIDENCE" ? "badge-conf-high" : confidence === "MEDIUM_CONFIDENCE" ? "badge-conf-medium" : confidence === "LOW_CONFIDENCE" ? "badge-conf-low" : "badge-state";
  return `<span class="badge ${tone}">${escapeHtml(confidence.replace(/_/g, " "))}</span>`;
};

const classificationBadge = (classification: string): string => `<span class="badge ${REGRESSION_TONES[classification] ?? "badge-state"}">${escapeHtml(classification)}</span>`;

/** Phase 5 REGRESSION SUMMARY section. Every row is WHAT / WHY / EVIDENCE /
 *  CONFIDENCE / RECOMMENDED ACTION. No arbitrary scores are ever rendered. */
const regressionSection = (analysis: QaAnalysis): string => {
  const map = analysis.regression;
  if (!map) return "";
  const { summary, changes } = map;
  if (!summary.comparable) {
    return `<section>
  <h2>Regression Summary</h2>
  <p class="headline">Regression comparison: not available — <span class="fail">the two runs are not comparable (${escapeHtml(summary.notComparableReason ?? "unknown reason")}).</span></p>
  <p class="sub">A regression is only ever claimed with evidence that a previously verified or expected condition changed negatively.</p>
</section>`;
  }
  const countChips = REGRESSION_DISPLAY_ORDER
    .filter(classification => (summary.counts[classification as keyof typeof summary.counts] ?? 0) > 0)
    .map(classification => `${classificationBadge(classification)} ${escapeHtml(summary.counts[classification as keyof typeof summary.counts]!)}`)
    .join(" ");

  const attentionOrder = ["REGRESSION", "INFRASTRUCTURE_PROBLEM", "REVIEW_REQUIRED", "COVERAGE_CHANGED", "FIXED", "NEW", "REMOVED_FLOW", "CHANGED_FLOW", "NEW_FLOW", "CHANGED"];
  const ranked = [...changes].sort((a, b) => {
    const aRank = attentionOrder.indexOf(a.classification);
    const bRank = attentionOrder.indexOf(b.classification);
    if (aRank !== bRank) return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
    return a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0;
  });
  const rows = ranked
    .filter(change => change.classification !== "UNCHANGED" && change.classification !== "UNCHANGED_FLOW")
    .map(change => `<tr>
  <td><code>${escapeHtml(change.changeId)}</code></td>
  <td>${escapeHtml(change.category)}<br>${classificationBadge(change.classification)}</td>
  <td><span class="q">${escapeHtml(change.summary)}</span><br><span class="sub">${escapeHtml(change.explanation)}</span><div class="sub">Current: <code>${escapeHtml(change.currentReference)}</code> · Baseline: <code>${escapeHtml(change.baselineReference)}</code></div></td>
  <td>${change.evidence.map(item => `<div class="ev">${escapeHtml(item)}</div>`).join("")}</td>
  <td>${confidenceBadgeFor(change.confidence)}<div class="sub">${escapeHtml(change.confidenceReason)}</div></td>
  <td class="sub">${escapeHtml(change.recommendedAction)}</td>
</tr>`).join("");

  const notes = map.aiNotes
    ? (map.aiNotes.notes ?? []).map(note => `<div class="ev">${escapeHtml(note.changeId)} — ${escapeHtml(note.note)}</div>`).join("")
    : "";

  return `<section>
  <h2>Regression Summary</h2>
  <p class="headline">${escapeHtml(summary.headline)}</p>
  <p class="sub">Baseline: <code>${escapeHtml(map.runs.baseline.runId)}</code> (${escapeHtml(map.runs.baseline.scannedAt)}${map.baselinePath ? `, ${escapeHtml(map.baselinePath)}` : ""}) · Current: <code>${escapeHtml(map.runs.current.runId)}</code> (${escapeHtml(map.runs.current.scannedAt)}).</p>
  <p class="sub">${escapeHtml(summary.changeCount)} change record(s). A regression is only claimed when a previously verified or expected condition changed negatively; infrastructure failures are never regressions and missing evidence alone is never a fix.</p>
  <div class="chips">${countChips}</div>
  ${map.aiNotes?.headline ? `<p class="headline">${escapeHtml(map.aiNotes.headline)}</p>` : ""}
  ${notes ? `<h3>AI notes</h3>${notes}` : ""}
  ${rows ? `<h3>Changes compared with baseline</h3><table><thead><tr><th>ID</th><th>Type</th><th>What changed</th><th>Evidence</th><th>Confidence</th><th>Recommended action</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">No meaningful changes between the two runs.</div>`}
</section>`;
};

const INTELLIGENCE_TONES: Record<string, string> = {
  ACTIONABLE: "badge-status-pass",
  INVESTIGATION_REQUIRED: "badge-status-review",
  INSUFFICIENT_EVIDENCE: "badge-conf-low",
  INFORMATIONAL: "badge-info",
  HIGH: "badge-conf-high",
  MEDIUM: "badge-conf-medium",
  LOW: "badge-conf-low",
  INSUFFICIENT: "badge-state",
};

const intelligenceBadge = (value: string): string => `<span class="badge ${INTELLIGENCE_TONES[value] ?? "badge-state"}">${escapeHtml(value.replace(/_/g, " "))}</span>`;

/** Phase 6 QA INTELLIGENCE section. Every candidate is framed as a hypothesis
 *  derived from evidence, never a confirmed cause: it lists supporting AND
 *  contradicting evidence, the safe investigation actions, coverage impact,
 *  and regression context. Uncertainty is shown explicitly. */
const intelligenceSection = (analysis: QaAnalysis): string => {
  const map = analysis.intelligence;
  if (!map) return "";
  const { summary, rootCauseCandidates, evidenceRelationships, investigationQueue, aiNotes } = map;

  const chipData: [string, number][] = [
    ["Candidates", summary.candidates],
    ["Actionable", summary.actionable],
    ["Investigation required", summary.investigationRequired],
    ["Insufficient evidence", summary.insufficientEvidence],
    ["Informational", summary.informational],
    ["High confidence", summary.highConfidence],
    ["Evidence relationships", summary.relationships],
    ["Contradictions found", summary.contradictions],
  ];
  const chips = chipData
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `<span class="q">${escapeHtml(label)}</span>: ${escapeHtml(String(value))}`)
    .join(" · ");

  const candidateCards = rootCauseCandidates.map(candidate => {
    const affected = [
      ...(candidate.affectedPages.length ? [`<div class="ev">Affected pages: ${candidate.affectedPages.map(escapeHtml).join(" · ")}</div>`] : []),
      ...(candidate.flowIds.length ? [`<div class="ev">Affected flows: ${candidate.flowIds.map(x => `<code>${escapeHtml(x)}</code>`).join(" · ")}</div>`] : []),
      ...(candidate.findingIds.length ? [`<div class="ev">Affected findings: ${candidate.findingIds.map(x => `<code>${escapeHtml(x)}</code>`).join(" · ")}</div>`] : []),
      ...(candidate.affectedCategories.length ? [`<div class="ev">Categories: ${candidate.affectedCategories.map(escapeHtml).join(" · ")}</div>`] : []),
    ].join("");
    const supportRows = candidate.supportingEvidence.map(rel => `<div class="ev">${escapeHtml(rel.reason.replace(/_/g, " "))} — <span class="q">${escapeHtml(rel.from.refId)}</span> ↔ <span class="q">${escapeHtml(rel.to.refId)}</span>: ${escapeHtml(rel.description)}</div>`).join("");
    const contradictRows = candidate.contradictingEvidence.map(rel => `<div class="ev fail">${escapeHtml(rel.reason.replace(/_/g, " "))} — ${escapeHtml(rel.description)}</div>`).join("");
    const actionRows = candidate.investigationActions.map(action => `<div class="ev"><span class="badge badge-safe">SAFE</span> <span class="q">${escapeHtml(action.title)}</span> — ${escapeHtml(action.detail)}</div>`).join("");
    const coverageImpact = candidate.coverageImpact.length ? `<h4>Coverage impact</h4>${candidate.coverageImpact.map(line => `<div class="ev">${escapeHtml(line)}</div>`).join("")}` : "";
    const regressionContext = candidate.regressionContext.length ? `<h4>Regression context</h4>${candidate.regressionContext.map(line => `<div class="ev">${escapeHtml(line)}</div>`).join("")}` : "";
    return `<div class="card">
  <div><span class="q">${escapeHtml(candidate.title)}</span> ${intelligenceBadge(candidate.status)} ${intelligenceBadge(candidate.confidence)} <code>${escapeHtml(candidate.candidateId)}</code></div>
  <p class="sub">${escapeHtml(candidate.description)}</p>
  <div class="sub">Confidence reason: ${escapeHtml(candidate.confidenceReason)}</div>
  ${affected}
  ${supportRows ? `<h4>Supporting evidence (${candidate.supportingEvidence.length})</h4>${supportRows}` : ""}
  ${contradictRows ? `<h4 class="fail">Contradicting evidence (${candidate.contradictingEvidence.length})</h4>${contradictRows}` : ""}
  <h4>Safe investigation actions</h4>${actionRows}
  ${coverageImpact}
  ${regressionContext}
</div>`;
  }).join("");

  const relationshipRows = evidenceRelationships.slice(0, 80).map(rel => `<tr>
  <td><code>${escapeHtml(rel.relationshipId)}</code></td>
  <td>${intelligenceBadge(rel.relation)}</td>
  <td>${escapeHtml(rel.reason.replace(/_/g, " "))}</td>
  <td><span class="q">${escapeHtml(rel.from.refId)}</span> <span class="sub">(${escapeHtml(rel.from.kind)})</span> ↔ <span class="q">${escapeHtml(rel.to.refId)}</span> <span class="sub">(${escapeHtml(rel.to.kind)})</span><div class="sub">${escapeHtml(rel.description)}</div></td>
</tr>`).join("");

  const queueRows = investigationQueue.map(entry => `<tr>
  <td><code>${escapeHtml(entry.entryId)}</code></td>
  <td>${intelligenceBadge(entry.priority)}</td>
  <td><code>${escapeHtml(entry.candidateId)}</code> <span class="q">${escapeHtml(entry.title)}</span></td>
  <td class="sub">${escapeHtml(entry.priorityReason)}</td>
</tr>`).join("");

  const uncertainty = rootCauseCandidates
    .filter(candidate => candidate.status === "INSUFFICIENT_EVIDENCE")
    .map(candidate => `<div class="ev">${escapeHtml(candidate.candidateId)} ${escapeHtml(candidate.title)} — ${escapeHtml(candidate.confidenceReason)}</div>`)
    .join("");

  return `<section>
  <h2>QA Intelligence</h2>
  <p class="sub">Phase 6: evidence relationships → related-finding groups → root-cause CANDIDATES → investigation queue. Grouping is semantic only (same normalized element identity on the same page); nothing is grouped by category, severity, URL text, or shared words. Every candidate is a hypothesis, never a confirmed cause.</p>
  <div class="chips">${chips}</div>
  ${rootCauseCandidates.length ? `<h3>Root-cause candidates</h3>${candidateCards}` : `<div class="empty">No root-cause candidates — the evidence does not support clustering any signals yet.</div>`}
  ${queueRows ? `<h3>Investigation queue</h3><table><thead><tr><th>ID</th><th>Priority</th><th>Candidate</th><th>Why</th></tr></thead><tbody>${queueRows}</tbody></table>` : ""}
  ${evidenceRelationships.length ? `<h3>Evidence relationships</h3><p class="sub">${summary.relationships} relationship(s); ${summary.contradictions} of them contradict. Contradicting evidence is never hidden.</p><table><thead><tr><th>ID</th><th>Relation</th><th>Reason</th><th>Evidence</th></tr></thead><tbody>${relationshipRows}</tbody></table>${evidenceRelationships.length > 80 ? `<div class="sub">Showing 80 of ${summary.relationships} relationships (full list in the JSON report).</div>` : ""}` : ""}
  ${uncertainty ? `<h3>Uncertainty</h3><p class="sub">Signals too weak or conflicted to reason about reliably. Explicitly kept out of the actionable set.</p>${uncertainty}` : ""}
  ${aiNotes?.wording?.length ? `<h3>AI notes</h3>${aiNotes.wording.map(note => `<div class="ev">${escapeHtml(note.candidateId)} — ${escapeHtml(note.title)}</div>`).join("")}<p class="sub">Evidence, confidence, statuses, and actions remain deterministic (${escapeHtml(aiNotes.provider ?? "")}).</p>` : ""}
</section>`;
};

const SEVERITY_ORDER: { severity: Severity; label: string }[] = [
  { severity: "CRITICAL", label: "Critical" },
  { severity: "HIGH", label: "High" },
  { severity: "MEDIUM", label: "Medium" },
  { severity: "LOW", label: "Low" },
  { severity: "INFO", label: "Informational" },
];

const severityBadge = (severity: Severity): string => `<span class="badge badge-${severity.toLowerCase()}">${severity}</span>`;
const confidenceBadge = (confidence: string): string => `<span class="badge badge-conf-${confidence}">${confidence}</span>`;
const statusBadge = (status: "PASS" | "REVIEW" | "FAIL" | "NOT_TESTED" | "BLOCKED"): string => `<span class="badge badge-status-${status.toLowerCase()}">${status}</span>`;
const lifecycleBadge = (lifecycle: string): string => `<span class="badge badge-state">${escapeHtml(lifecycle)}</span>`;
const DISPOSITION_TONES: Record<string, string> = {
  REPRODUCED: "badge-status-fail",
  PASSED: "badge-status-pass",
  NOT_REPRODUCED: "badge-conf-medium",
  REVIEW_REQUIRED: "badge-status-review",
  INFRASTRUCTURE_PROBLEM: "badge-status-review",
  SCHEDULED: "badge-state",
  SKIPPED_UNSUPPORTED: "badge-conf-low",
  SKIPPED_LOCATOR_GUARD: "badge-conf-low",
  SKIPPED_SAFETY: "badge-conf-low",
};
const dispositionBadge = (finding: QaFinding): string => {
  if (!finding.verification) return "";
  const { disposition, category, status } = finding.verification;
  const tone = DISPOSITION_TONES[disposition] ?? "badge-state";
  const detail = status === "REVIEW" && disposition === "REVIEW_REQUIRED" && category ? `${disposition} (${category})` : disposition;
  return `<span class="badge ${tone}">${escapeHtml(detail)}</span>`;
};
const verificationBadge = (finding: QaFinding): string => {
  if (!finding.verification) return "";
  const verdict = finding.verification.verdict;
  return `${dispositionBadge(finding)}${verdict ? `<span class="badge badge-state">${escapeHtml(verdict)}</span>` : ""}`;
};

const findingEvidence = (analysis: QaAnalysis, finding: QaFinding): string => {
  const parts = finding.evidence.map(ref => {
    let description: string = ref.type;
    if (ref.type === "element") {
      const element = ref.index !== null ? analysis.scan.elements[ref.index] : undefined;
      description = element ? `${element.tag} "${element.accessibleName || element.text}"` : `element ${ref.locator ?? ""}`;
    } else if (ref.type === "console") {
      const diagnostic = ref.index !== null ? analysis.scan.consoleDiagnostics[ref.index] : undefined;
      description = diagnostic ? `console: ${diagnostic.message}` : "console diagnostic";
    } else if (ref.type === "link") {
      const link = ref.index !== null ? analysis.scan.links[ref.index] : undefined;
      description = link ? `link ${link.url}` : "link";
    } else if (ref.type === "page") {
      const error = ref.index !== null ? analysis.scan.pageErrors[ref.index] : undefined;
      description = error ? `page error: ${error}` : "page error";
    } else {
      description = "authentication response";
    }
    const locator = ref.locator ? ` <code>${escapeHtml(ref.locator)}</code>` : "";
    return `<li>${escapeHtml(description)}${locator}</li>`;
  });
  return `<ol class="ev">${parts.join("")}</ol>`;
};

const findingRows = (analysis: QaAnalysis, severity: Severity): string => {
  const rows = analysis.findings.filter(finding => finding.severity === severity).map(finding => {
    const count = finding.count > 1 ? ` ×${finding.count}` : "";
    const examples = (finding.examples ?? []).slice(0, 2).map(example => {
      const detail = example.element ? `${example.element.tag} "${example.element.accessibleName || example.element.text || example.element.placeholder || ""}"` : (example.detail ?? "");
      return `<code>${escapeHtml(detail)}</code>`;
    }).join(" ");
    return `<tr>
      <td>${escapeHtml(finding.id)}</td>
      <td>${historicalLifecycleBadge(finding.lifecycle)} ${verificationBadge(finding)}</td>
      <td>${confidenceBadge(finding.confidence)}</td>
      <td><code>${escapeHtml(finding.code)}</code></td>
      <td><span class="q">${escapeHtml(finding.title)}</span><br><span class="sub">${escapeHtml(finding.description)}</span></td>
      <td class="num">${escapeHtml(count || 1)}</td>
      <td>${findingEvidence(analysis, finding)}</td>
      <td>${examples}</td>
    </tr>`;
  });
  return rows.join("") || `<tr><td colspan="8" class="empty">None</td></tr>`;
};

const findingCards = (analysis: QaAnalysis, domain: string): string => {
  const findings = analysis.findings.filter(finding => finding.domain === domain);
  return findings.map(finding => `<div class="card finding">
    <div class="finding-head">${severityBadge(finding.severity)} ${confidenceBadge(finding.confidence)} <code>${escapeHtml(finding.code)}</code> <span class="q">${escapeHtml(finding.title)}</span>${finding.count > 1 ? ` <span class="num">×${finding.count}</span>` : ""}</div>
    <div class="sub">${escapeHtml(finding.description)}</div>
    <div class="chips">${escapeHtml(finding.rationale)}</div>
  </div>`).join("") || `<div class="empty">No ${escapeHtml(domain)} findings.</div>`;
};

const flowCards = (analysis: QaAnalysis): string => analysis.flows.map(flow => `<div class="card flow">
  <div class="finding-head"><strong>${escapeHtml(flow.title)}</strong> <span class="badge badge-flow">${escapeHtml(flow.kind)}</span> ${historicalConfidenceBadge(flow.confidence)} <span class="badge badge-state">${escapeHtml(flow.status)}</span></div>
  <div class="sub">${escapeHtml(flow.description)}</div>
  ${flow.blockReason ? `<div class="chips warn">${escapeHtml(flow.blockReason)}</div>` : ""}
  <div class="sub">Trigger: <code>${escapeHtml(flow.trigger)}</code></div>
  ${flow.elements.length ? `<ul class="flow-el">${flow.elements.map(el => `<li>${escapeHtml(el.role ?? el.locator)} "${escapeHtml(el.accessibleName ?? "")}" — ${el.visible ? "visible" : "hidden"}</li>`).join("")}</ul>` : ""}
  ${flow.relatedScenarios.length ? `<div class="sub">Related: ${flow.relatedScenarios.map(id => `<code>${escapeHtml(id)}</code>`).join(" ")}</div>` : ""}
</div>`).join("") || `<div class="empty">No flows detected.</div>`;

const scenarioCards = (analysis: QaAnalysis, predicate: (scenario: (typeof analysis.scenarios)[number]) => boolean): string => {
  const list = analysis.scenarios.filter(predicate);
  return list.map(scenario => `<div class="card scenario">
    <div class="finding-head"><code>${escapeHtml(scenario.id)}</code> <strong>${escapeHtml(scenario.title)}</strong> <span class="badge badge-intent">${escapeHtml(scenario.intent)}</span> <span class="badge badge-prio">${escapeHtml(scenario.priority)}</span> <span class="badge badge-state">${escapeHtml(scenario.automation)}</span></div>
    <div class="sub">${escapeHtml(scenario.description)}</div>
    <div class="chips">${escapeHtml(scenario.automationReason)}</div>
    ${scenario.safetyNote ? `<div class="chips warn">Safe: ${escapeHtml(scenario.safetyNote)}</div>` : ""}
    ${scenario.relatedScenarios.length ? `<div class="sub">Related: ${scenario.relatedScenarios.map(id => `<code>${escapeHtml(id)}</code>`).join(" ")}</div>` : ""}
  </div>`).join("") || `<div class="empty">None.</div>`;
};

const elementScenarioCards = (analysis: QaAnalysis, predicate: (scenario: (typeof analysis.elementScenarios)[number]) => boolean): string => {
  const list = analysis.elementScenarios.filter(predicate).slice(0, 200);
  return list.map(scenario => `<div class="card scenario">
    <div class="finding-head"><code>${escapeHtml(scenario.id)}</code> <strong>${escapeHtml(scenario.title)}</strong> <span class="badge badge-risk ${scenario.risk}">${escapeHtml(scenario.risk)}</span> ${scenario.automated ? '<span class="badge badge-auto">auto</span>' : '<span class="badge badge-manual">manual</span>'} <span class="badge badge-intent">${escapeHtml(scenario.intent ?? "—")}</span> <span class="badge badge-prio">${escapeHtml(scenario.priority ?? "—")}</span></div>
    <div class="sub">${escapeHtml(scenario.description)}</div>
    <div class="chips">${escapeHtml(scenario.riskReason)}</div>
    ${scenario.locator ? `<div class="sub">Locator: <code>${escapeHtml(scenario.locator)}</code></div>` : ""}
    ${scenario.setupNote ? `<div class="chips warn">Setup: ${escapeHtml(scenario.setupNote)}</div>` : ""}
  </div>`).join("") || `<div class="empty">None.</div>`;
};

const flowSafetyBadge = (safety: string): string => `<span class="badge badge-${safety.toLowerCase()}">${escapeHtml(safety)}</span>`;
const flowOutcomeBadge = (outcome: string): string => {
  const tone = outcome === "PASS" ? "badge-status-pass" : outcome === "REPRODUCED" ? "badge-status-fail" : outcome === "INFRASTRUCTURE_PROBLEM" || outcome === "REVIEW_REQUIRED" ? "badge-status-review" : outcome === "BLOCKED" ? "badge-state" : "badge-conf-medium";
  return `<span class="badge ${tone}">${escapeHtml(outcome)}</span>`;
};

const flowDiscoverySection = (analysis: QaAnalysis): string => {
  const discovery = analysis.flowDiscovery;
  if (!discovery) return `<div class="empty">No flow discovery performed.</div>`;
  const { graph, flows, executions, summary, limits } = discovery;
  const byScenario = new Map(executions.map(result => [result.scenarioId, result]));

  const pagesTable = `<table><thead><tr><th>Page</th><th>URL</th><th>Title</th><th>Depth</th><th>Controls</th><th>Links</th><th>Broken</th></tr></thead><tbody>
    ${graph.pages.map(page => `<tr>
      <td><code>${escapeHtml(page.id)}</code></td>
      <td><a href="${safeHref(page.url)}">${escapeHtml(page.url)}</a></td>
      <td class="sub">${escapeHtml(page.title ?? "—")}</td>
      <td class="num">${escapeHtml(page.depth)}</td>
      <td class="num">${escapeHtml(page.controls.length)}</td>
      <td class="num">${escapeHtml(page.edges.length)}</td>
      <td class="num">${page.brokenLinks > 0 ? `<span class="fail">${escapeHtml(page.brokenLinks)}</span>` : escapeHtml(page.brokenLinks)}</td>
    </tr>`).join("")}
  </tbody></table>`;

  const flowCards = flows.map(flow => {
    const execution = byScenario.get(`SC-${flow.flowId}`) ?? null;
    const stepList = flow.steps.map((step, index) => {
      const outcome = execution?.steps[index]?.outcome ?? null;
      const isBoundary = index === flow.boundary?.stepIndex;
      return `<li><code>${escapeHtml(step.action)}</code> ${flowSafetyBadge(step.safety)} <span class="badge badge-state">${escapeHtml(step.automation)}</span> ${isBoundary ? '<span class="badge badge-review">boundary</span>' : ""} ${step.locator ? `<code>${escapeHtml(step.locator)}</code>` : ""} ${step.targetUrl ? `<a href="${safeHref(step.targetUrl)}">${escapeHtml(step.targetUrl)}</a>` : ""}<div class="sub">${escapeHtml(step.expected)} — ${escapeHtml(step.reason)}${outcome ? ` · ${flowOutcomeBadge(outcome)}` : ""}</div></li>`;
    }).join("");
    return `<div class="card finding">
      <div class="finding-head"><code>${escapeHtml(flow.flowId)}</code> <span class="badge badge-flow">${escapeHtml(flow.category)}</span> <span class="badge badge-prio">${escapeHtml(flow.priority)}</span> ${flowSafetyBadge(flow.safety)} ${escapeHtml(flow.confidence)} <strong>${escapeHtml(flow.title)}</strong></div>
      <div class="sub">${escapeHtml(flow.description)}</div>
      <div class="chips">×${escapeHtml(flow.occurrenceCount)} occurrence(s) · ${escapeHtml(flow.executable ? "executable (SAFE + AUTOMATED steps)" : "no executable steps")}</div>
      ${flow.boundary ? `<div class="chips warn">Boundary at step ${escapeHtml(flow.boundary.stepIndex)} (${escapeHtml(flow.boundary.safety)}/${escapeHtml(flow.boundary.automation)}): ${escapeHtml(flow.boundary.reason)}</div>` : ""}
      ${execution ? `<div class="chips">Execution: ${flowOutcomeBadge(execution.status)}${execution.failureCategory ? ` [${escapeHtml(execution.failureCategory)}]` : ""}${execution.boundary ? ` — ${escapeHtml(execution.boundary)}` : ""}</div>` : ""}
      <ol class="ev">${stepList}</ol>
    </div>`;
  }).join("") || `<div class="empty">No user flows discovered on this page set.</div>`;

  return `
    <p class="sub">Limits: ${escapeHtml(summary.pages)}/${escapeHtml(limits.maxPages)} pages · max depth ${escapeHtml(limits.maxDepth)} · ${escapeHtml(limits.maxFlows)} max flows · ${escapeHtml(limits.maxFlowSteps)} steps per flow.</p>
    <p class="sub">Counts: ${escapeHtml(summary.flows)} discovered · ${escapeHtml(summary.executable)} executable · ${escapeHtml(summary.review)} review · ${escapeHtml(summary.highRisk)} high-risk · ${escapeHtml(summary.blocked)} blocked · ${escapeHtml(summary.steps)} steps.</p>
    <p class="sub">Execution: ${escapeHtml(summary.executed)} run · ${escapeHtml(summary.passed)} passed · ${escapeHtml(summary.reproduced)} reproduced · ${escapeHtml(summary.notReproduced)} not reproduced · ${escapeHtml(summary.reviewRequired)} review required · ${escapeHtml(summary.infrastructure)} infrastructure.</p>
    <h3>Site graph</h3>${pagesTable}
    <h3>Discovered flows</h3>${flowCards}`;
};

const recommendedFixes = (analysis: QaAnalysis): string => {
  const grouped = new Map<string, string[]>();
  for (const finding of analysis.findings) {
    const list = grouped.get(finding.code) ?? [];
    list.push(finding.recommendation);
    grouped.set(finding.code, list);
  }
  return [...grouped.entries()].map(([code, recommendations]) => `<div class="card fix">
    <div class="finding-head"><code>${escapeHtml(code)}</code> — ${escapeHtml(analysis.findings.find(f => f.code === code)?.title ?? code)}</div>
    <ul>${[...new Set(recommendations)].map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  </div>`).join("") || `<div class="empty">No recommended fixes.</div>`;
};

const findingStatusTable = (analysis: QaAnalysis): string => {
  const order = ["DISCOVERED", "ANALYZED", "TEST_GENERATED", "TEST_EXECUTED", "REPRODUCED", "NOT_REPRODUCED", "PASS", "REVIEW"];
  const rows = order.map(lifecycle => {
    const items = analysis.findings.filter(finding => finding.lifecycle === lifecycle);
    if (!items.length) return "";
    const list = items.map(finding => {
      const verdict = finding.verification?.verdict ? ` — <span class="sub">${escapeHtml(finding.verification.verdict)}</span>` : "";
      const scenario = finding.verification ? ` <code>${escapeHtml(finding.verification.scenarioId)}</code>` : "";
      return `<li><code>${escapeHtml(finding.id)}</code> <span class="q">${escapeHtml(finding.title)}</span>${scenario}${verdict} ${verificationBadge(finding)}</li>`;
    }).join("");
    return `<tr><td>${lifecycleBadge(lifecycle)}</td><td class="num">${items.length}</td><td><ul class="ev">${list}</ul></td></tr>`;
  }).filter(Boolean).join("");
  return rows || `<div class="empty">No findings.</div>`;
};

const dispositionTable = (analysis: QaAnalysis): string => {
  if (!analysis.findings.some(finding => finding.verification)) return `<div class="empty">No verification run attached. Run with <code>--execute</code> to compute finding dispositions on the live page.</div>`;
  const rows = analysis.findings.map(finding => `<tr>
    <td><code>${escapeHtml(finding.id)}</code></td>
    <td><code>${escapeHtml(finding.code)}</code></td>
    <td>${dispositionBadge(finding)}</td>
    <td>${escapeHtml(finding.verification?.status ? `${finding.verification.status}${finding.verification.category ? `/${finding.verification.category}` : ""}` : "—")}</td>
    <td class="sub">${escapeHtml(finding.verification?.reason ?? "No verification run — finding analyzed only.")}</td>
    <td>${escapeHtml(finding.verification?.safety ?? "—")}</td>
    <td>${finding.verification?.locator ? `<code>${escapeHtml(finding.verification.locator)}</code>` : "—"}</td>
    <td class="sub">${escapeHtml(finding.verification?.executedAt ?? "—")}</td>
  </tr>`).join("");
  return `<table class="dispositions"><thead><tr><th>Finding</th><th>Code</th><th>Disposition</th><th>Outcome</th><th>Why</th><th>Safety</th><th>Locator</th><th>Executed at</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const verificationTable = (analysis: QaAnalysis): string => {
  const results = analysis.verifications;
  if (!results.length) return `<div class="empty">No verification results attached. Run with <code>--execute</code> to confirm findings on the live page.</div>`;
  const rows = results.map(result => `<tr>
    <td><code>${escapeHtml(result.scenarioId)}</code></td>
    <td><code>${escapeHtml(result.findingId)}</code></td>
    <td>${escapeHtml(result.strategy)}</td>
    <td>${(result.status === "REPRODUCED" ? '<span class="badge badge-status-fail">' : result.status === "PASS" ? '<span class="badge badge-status-pass">' : result.status === "REVIEW" ? '<span class="badge badge-status-review">' : '<span class="badge badge-conf-medium">') + escapeHtml(result.status)}${result.category ? `/${escapeHtml(result.category)}` : ""}</span></td>
    <td>${result.triage ? `${escapeHtml(result.triage.verdict)} <span class="sub">(${escapeHtml(result.triage.confidence)})</span>` : "—"}</td>
    <td class="num">${result.durationMs != null ? `${escapeHtml(Math.round(result.durationMs / 1000))}s` : "—"}</td>
    <td class="sub">${result.locator ? `<code>${escapeHtml(result.locator)}</code>` : "—"}${result.error ? `<br><span class="fail">${escapeHtml(result.error.type)}: ${escapeHtml(result.error.message.length > 140 ? result.error.message.slice(0, 140) + "…" : result.error.message)}</span>` : ""}</td>
  </tr>`).join("");
  return `<table class="verifications"><thead><tr><th>Scenario</th><th>Finding</th><th>Strategy</th><th>Outcome</th><th>Triage verdict</th><th>Duration</th><th>Locator / error</th></tr></thead><tbody>${rows}</tbody></table>`;
};

/** Phase 7A QA HISTORY section. References the persisted run store only — Phase
 *  7A never interprets history (no recurrence/trends; that is Phase 7B). */
const historySection = (analysis: QaAnalysis): string => {
  const history = analysis.history;
  if (!history) return "";
  const tone = history.status === "AVAILABLE" ? "badge-status-pass" : history.status === "INCOMPATIBLE" ? "badge-status-fail" : history.status === "UNAVAILABLE" ? "badge-status-review" : "badge-state";
  return `<section>
  <h2>QA History</h2>
  <p class="headline">Phase 7A: persisted QA run history for this site.</p>
  <div class="chips">Status: <span class="badge ${tone}">${escapeHtml(history.status)}</span> · schema v${escapeHtml(String(history.schemaVersion))} · <span class="q">${escapeHtml(String(history.runsAvailable))}</span> run(s) stored</div>
  <table><tbody>
    <tr><th>Site identity</th><td><code>${escapeHtml(history.siteIdentity)}</code></td></tr>
    <tr><th>Current run</th><td>${history.currentRunId ? `<code>${escapeHtml(history.currentRunId)}</code>` : "<span class=\"sub\">not persisted</span>"}</td></tr>
    <tr><th>History directory</th><td><code>${escapeHtml(history.historyDir)}</code></td></tr>
    <tr><th>Note</th><td class="sub">${escapeHtml(history.note)}</td></tr>
  </tbody></table>
  <p class="sub">Full run artifacts live in the history directory; the JSON report carries this pointer only. Cross-run interpretation (lifecycle trends, flow stability, investigation queue) is rendered in the Historical Intelligence section below.</p>
</section>`;
};

// ---------------------------------------------------------------------------
// Phase 7B: Historical Intelligence & Trends.
// ---------------------------------------------------------------------------
const historicalLifecycleBadge = (lifecycle: string): string =>
  `<span class="badge ${lifecycle === "REVIEW_REQUIRED" || lifecycle === "INSUFFICIENT_EVIDENCE" ? "badge-status-review" : lifecycle === "DISAPPEARED" || lifecycle === "NEW" ? "badge-conf-medium" : "badge-state"}">${escapeHtml(lifecycle)}</span>`;

const historicalConfidenceBadge = (confidence: string): string =>
  `<span class="badge ${confidence === "HIGH" ? "badge-status-pass" : confidence === "MEDIUM" ? "badge-conf-medium" : confidence === "LOW" ? "badge-conf-low" : "badge-state"}">${escapeHtml(confidence)}</span>`;

const historicalIntelligenceSection = (analysis: QaAnalysis): string => {
  const map: HistoricalIntelligenceMap | undefined = analysis.historicalIntelligence;
  if (!map) return "";
  const { summary } = map;
  const tone = map.status === "AVAILABLE" ? "badge-status-pass" : map.status === "INSUFFICIENT_HISTORY" ? "badge-conf-medium" : "badge-status-fail";
  const sections: string[] = [];

  sections.push(`<div class="chips">Status: <span class="badge ${tone}">${escapeHtml(map.status)}</span> · schema v${escapeHtml(String(map.schemaVersion))} · <span class="q">${escapeHtml(String(summary.orderedRuns))}</span> ordered run(s) analyzed${summary.unorderedRuns ? ` (${escapeHtml(String(summary.unorderedRuns))} run(s) excluded from patterns)` : ""}</div>`);
  if (summary.dateRange.firstRunStartedAt) {
    sections.push(`<p class="sub">Window: ${escapeHtml(summary.dateRange.firstRunStartedAt)} → ${escapeHtml(summary.dateRange.latestRunCompletedAt ?? "still running")}.</p>`);
  }
  if (map.aiNotes?.headline) {
    sections.push(`<p class="headline">${escapeHtml(map.aiNotes.headline)} <span class="sub">(AI refined wording; every classification remains deterministic)</span></p>`);
  }

  const findings = summary.findings;
  sections.push(`<table class="summary-cards"><tbody><tr>
    <td class="card"><span class="card-value">${findings.observed}</span><span class="card-label">findings tracked</span></td>
    <td class="card"><span class="card-value">${findings.new}</span><span class="card-label">new</span></td>
    <td class="card"><span class="card-value">${findings.persisting}</span><span class="card-label">persisting</span></td>
    <td class="card"><span class="card-value">${findings.disappeared}</span><span class="card-label">disappeared</span></td>
    <td class="card"><span class="card-value">${findings.reappeared}</span><span class="card-label">reappeared</span></td>
    <td class="card"><span class="card-value">${findings.recurring}</span><span class="card-label">recurring</span></td>
    <td class="card"><span class="card-value">${findings.intermittent}</span><span class="card-label">intermittent</span></td>
    <td class="card"><span class="card-value">${findings.reviewRequired}</span><span class="card-label">review required</span></td>
  </tr></tbody></table>`);

  if (map.investigationQueue.length) {
    sections.push(`<h3>Investigation queue (${map.investigationQueue.length})</h3><table><thead><tr><th>ID</th><th>Priority</th><th>Kind</th><th>Title</th><th>Runs</th><th>Confidence</th><th>Reason</th></tr></thead><tbody>${map.investigationQueue.map(entry => `<tr>
      <td><code>${escapeHtml(entry.entryId)}</code></td>
      <td>${escapeHtml(entry.priority)}</td>
      <td>${escapeHtml(entry.kind)}</td>
      <td><span class="q">${escapeHtml(entry.title)}</span></td>
      <td class="sub">${entry.runIds.slice(0, 6).map(id => `<code>${escapeHtml(id)}</code>`).join(" ") || "—"}</td>
      <td>${historicalConfidenceBadge(entry.confidence)}</td>
      <td class="sub">${escapeHtml(entry.priorityReason)}</td>
    </tr>`).join("")}</tbody></table>`);
  }

  if (map.findings.length) {
    sections.push(`<h3>Finding timelines (${map.findings.length})</h3><table><thead><tr><th>Key</th><th>Lifecycle</th><th>Confidence</th><th>Severity</th><th>Finding</th><th>Observed</th><th>Absent</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>${map.findings.slice(0, 60).map(finding => `<tr>
      <td><code>${escapeHtml(finding.key)}</code></td>
      <td>${historicalLifecycleBadge(finding.lifecycle)}</td>
      <td>${confidenceBadge(finding.confidence)}</td>
      <td>${severityBadge(finding.severity as Severity)}</td>
      <td><span class="q">${escapeHtml(finding.title)}</span>${finding.reviewNote ? `<br><span class="sub fail">${escapeHtml(finding.reviewNote)}</span>` : ""}</td>
      <td class="num">${finding.runsObserved}</td>
      <td class="num">${finding.runsAbsent}</td>
      <td class="sub">${finding.firstSeenRunId ? `<code>${escapeHtml(finding.firstSeenRunId)}</code>` : "—"}</td>
      <td class="sub">${finding.lastSeenRunId ? `<code>${escapeHtml(finding.lastSeenRunId)}</code>` : "—"}</td>
    </tr>`).join("")}</tbody></table>`);
    if (map.findings.length > 60) sections.push(`<p class="sub">… and ${map.findings.length - 60} more finding timelines (full detail in the JSON report).</p>`);
  }

  if (map.flows.length) {
    sections.push(`<h3>Flow stability (${map.flows.length})</h3><table><thead><tr><th>Family key</th><th>Flow</th><th>Stability</th><th>Confidence</th><th>Failures</th><th>Runs</th></tr></thead><tbody>${map.flows.slice(0, 40).map(flow => `<tr>
      <td><code>${escapeHtml(flow.familyKey)}</code></td>
      <td><span class="q">${escapeHtml(flow.title)}</span></td>
      <td>${flow.stability === "UNSTABLE" ? '<span class="badge badge-status-fail">' : flow.stability === "VARIABLE" ? '<span class="badge badge-conf-medium">' : flow.stability === "STABLE" ? '<span class="badge badge-status-pass">' : '<span class="badge badge-state">'}${escapeHtml(flow.stability)}</span></td>
      <td>${historicalConfidenceBadge(flow.confidence)}</td>
      <td class="num">${flow.failureRunIds.length}</td>
      <td class="sub">${flow.runIds.slice(0, 6).map(id => `<code>${escapeHtml(id)}</code>`).join(" ") || "—"}</td>
    </tr>`).join("")}</tbody></table>`);
  }

  if (map.coverage.length) {
    sections.push(`<h3>Coverage trends (${map.coverage.length})</h3><table><thead><tr><th>Semantic key</th><th>Coverage item</th><th>Trend</th><th>Confidence</th><th>Latest status</th></tr></thead><tbody>${map.coverage.slice(0, 40).map(record => `<tr>
      <td><code>${escapeHtml(record.semanticKey)}</code></td>
      <td>${escapeHtml(record.name)}</td>
      <td>${record.trend === "COVERAGE_LOSS" || record.trend === "PERSISTENTLY_UNTESTED" ? '<span class="badge badge-status-fail">' : record.trend === "COVERAGE_GAIN" || record.trend === "NEWLY_TESTED" ? '<span class="badge badge-status-pass">' : '<span class="badge badge-state">'}${escapeHtml(record.trend)}</span></td>
      <td>${historicalConfidenceBadge(record.confidence)}</td>
      <td>${record.latestStatus ? escapeHtml(record.latestStatus) : "—"}</td>
    </tr>`).join("")}</tbody></table>`);
  }

  if (map.infrastructure.length) {
    sections.push(`<h3>Recurring infrastructure (${map.infrastructure.length})</h3>${map.infrastructure.map(record => `<p>${escapeHtml(record.infrastructureId)} — ${record.count} affected run(s): ${record.notes.map(escapeHtml).join("; ")}</p>`).join("")}`);
  }

  if (map.relationships.length) {
    sections.push(`<h3>Historical relationships (${map.relationships.length})</h3><ul>${map.relationships.slice(0, 30).map(relationship => `<li><strong>${escapeHtml(relationship.kind)}</strong> — <code>${escapeHtml(relationship.source)}</code> → <code>${escapeHtml(relationship.target)}</code> <span class="sub">(${historicalConfidenceBadge(relationship.confidence)} · ${relationship.runIds.slice(0, 5).map(id => `<code>${escapeHtml(id)}</code>`).join(" ") || "no runs"})</span><br><span class="sub">${escapeHtml(relationship.reason)}</span></li>`).join("")}</ul>`);
    if (map.relationships.length > 30) sections.push(`<p class="sub">… and ${map.relationships.length - 30} more relationships (full detail in the JSON report).</p>`);
  }

  if (map.limitations.length) {
    sections.push(`<h3>Limitations</h3><ul>${map.limitations.map(limitation => `<li class="sub">${escapeHtml(limitation)}</li>`).join("")}</ul>`);
  }

  return `<section>
  <h2>Historical Intelligence</h2>
  <p class="headline">Phase 7B: deterministic, confidence-aware interpretation of the persisted QA runs for this site.</p>
  ${sections.join("\n")}
  <p class="sub">Evidence first, interpretation second, AI optional. No overall quality or health score is offered.</p>
</section>`;
};

const executionTable = (analysis: QaAnalysis): string => {
  const execution = analysis.execution;
  if (!execution) return `<div class="empty">No test execution run was attached. Run with <code>--execute</code> to attach results.</div>`;
  const result = Number(execution.failed ?? 0) > 0 ? "FAILURE" : execution.status === "not-run" ? "SKIPPED" : "SUCCESS";
  return `<p><strong>Status:</strong> <span class="badge badge-status-${result === "SUCCESS" ? "pass" : result === "FAILURE" ? "fail" : "review"}">${escapeHtml(result)}</span> <span class="sub">${escapeHtml(execution.command)}</span></p>
  <table><thead><tr><th>Total</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Flaky</th><th>Duration</th></tr></thead><tbody>
  <tr><td class="num">${escapeHtml(execution.tests ?? "—")}</td><td class="num">${escapeHtml(execution.passed ?? "—")}</td><td class="num fail">${escapeHtml(execution.failed ?? "—")}</td><td class="num">${escapeHtml(execution.skipped ?? "—")}</td><td class="num">${escapeHtml(execution.flaky ?? "—")}</td><td>${escapeHtml(execution.durationMs != null ? `${Math.round(execution.durationMs / 1000)}s` : "—")}</td></tr></tbody></table>
  ${execution.failures.length ? `<h3>Failures</h3><ul>${execution.failures.slice(0, 20).map(failure => `<li><strong>${escapeHtml(failure.title)}</strong><br><code>${escapeHtml(failure.message.length > 400 ? failure.message.slice(0, 400) + "…" : failure.message)}</code></li>`).join("")}</ul>` : ""}`;
};

// ---------------------------------------------------------------------------
// Phase 4: Coverage Overview.
// ---------------------------------------------------------------------------
const COVERAGE_TONE: Record<string, string> = {
  TESTED: "badge-status-pass",
  PARTIALLY_TESTED: "badge-conf-medium",
  NOT_TESTED: "badge-state",
  BLOCKED: "badge-blocked",
  REVIEW_REQUIRED: "badge-status-review",
  NOT_APPLICABLE: "badge-conf-low",
};
const coverageStatusBadge = (status: string): string => `<span class="badge ${COVERAGE_TONE[status] ?? "badge-state"}">${escapeHtml(status)}</span>`;

const CATEGORY_ORDER: { category: string; label: string }[] = [
  { category: "PAGE", label: "Page coverage" },
  { category: "NAVIGATION", label: "Navigation coverage" },
  { category: "CONTENT_DISCOVERY", label: "Content discovery coverage" },
  { category: "FLOW", label: "Flow coverage" },
  { category: "AUTHENTICATION_BOUNDARY", label: "Authentication boundary" },
  { category: "INTERACTION", label: "Interaction coverage" },
  { category: "FORM", label: "Form coverage" },
  { category: "SEARCH", label: "Search coverage" },
  { category: "LANGUAGE", label: "Language coverage" },
  { category: "MEDIA", label: "Media coverage" },
  { category: "ERROR_HANDLING", label: "Error-handling coverage" },
  { category: "ACCESSIBILITY_CHECK", label: "Accessibility coverage" },
  { category: "RESPONSIVE_CHECK", label: "Responsive coverage" },
];

const coverageItemsTable = (analysis: QaAnalysis, category: string): string => {
  if (!analysis.coverage) return "";
  const items = analysis.coverage.items.filter(item => item.category === category);
  if (!items.length) return "";
  const rows = items.map(item => {
    const evidence = Array.from(new Set(item.evidence.map(ref => ref.detail).filter(Boolean))).slice(0, 3).map(detail => `<li>${escapeHtml(detail)}</li>`).join("");
    const flows = item.relatedFlows.length ? item.relatedFlows.map(id => `<code>${escapeHtml(id)}</code>`).join(" ") : "";
    const findings = item.relatedFindings.length ? item.relatedFindings.map(id => `<code>${escapeHtml(id)}</code>`).join(" ") : "";
    return `<tr>
      <td><code>${escapeHtml(item.coverageId)}</code></td>
      <td>${coverageStatusBadge(item.status)}</td>
      <td><span class="q">${escapeHtml(item.name)}</span><br><span class="sub">${escapeHtml(item.reason)}</span></td>
      <td>${escapeHtml(item.safety)}</td>
      <td class="sub">${item.executionStatus ? escapeHtml(item.executionStatus) : "—"}</td>
      <td>${flows || "—"}${findings ? `<div>${findings}</div>` : ""}</td>
      <td>${evidence ? `<ol class="ev">${evidence}</ol>` : "—"}</td>
    </tr>`;
  }).join("");
  return `<h3>${category}</h3><table><thead><tr><th>ID</th><th>Status</th><th>Coverage item</th><th>Safety</th><th>Execution</th><th>Related</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
};

const coverageSection = (analysis: QaAnalysis): string => {
  const coverage = analysis.coverage;
  if (!coverage) return `<div class="empty">No coverage map was built (flow discovery disabled).</div>`;
  const { summary, testPlan } = coverage;

  const cards = [
    ["Pages discovered", summary.pages.discovered],
    ["Pages tested", summary.pages.tested],
    ["Pages partial", summary.pages.partial],
    ["Pages untested", summary.pages.untested],
    ["Pages blocked", summary.pages.blocked],
    ["Pages review", summary.pages.review],
    ["Flows discovered", summary.flows.discovered],
    ["Flows executed", summary.flows.executed],
    ["Passed", summary.flows.passed],
    ["Reproduced", summary.flows.reproduced],
    ["Not reproduced", summary.flows.notReproduced],
    ["Review required", summary.flows.review],
    ["Blocked", summary.flows.blocked],
    ["Interactions tested", summary.interactions.tested],
    ["Interactions partial", summary.interactions.partial],
    ["Interactions untested", summary.interactions.untested],
    ["Findings analyzed", summary.findings.analyzed],
    ["Findings verified", summary.findings.verified],
    ["Findings reproduced", summary.findings.reproduced],
    ["Findings not reproduced", summary.findings.notReproduced],
    ["Findings unverified", summary.findings.unverified],
    ["Test-plan actions", summary.recommendations],
  ].map(([label, value]) => `<div class="card"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("");

  // A scan that never reached the site must not render a wall of zeros: "0 findings"
  // would read as "nothing is wrong". Show an explicit NOT TESTED notice instead.
  const blocked = analysis.accessPrerequisite ?? null;
  const blockedNotice = blocked
    ? `<div class="notice" role="alert"><strong>SITE NOT TESTED — this is NOT a clean result.</strong><br>Reason: <code>${escapeHtml(blocked.type)}</code> (${escapeHtml(blocked.status)}) — ${escapeHtml(blocked.message)}<br>No page content was scanned, so no findings, counts or coverage figures were assessed. Provide an approved session or credentials, then re-run. Details are in the <em>Access Prerequisite</em> section below.</div>`
    : "";
  const summaryBody = blocked ? blockedNotice : `<div class="grid">${cards}</div>`;

  const planRows = testPlan.map(rec => `<div class="card fix">
    <div class="finding-head"><code>${escapeHtml(rec.recommendationId)}</code> <span class="badge badge-prio">${escapeHtml(rec.priority)}</span> <strong>${escapeHtml(rec.title)}</strong></div>
    <div class="chips">${escapeHtml(rec.priorityReason)}</div>
    <div class="sub">${escapeHtml(rec.reason)}</div>
    <div class="sub">Coverage: ${rec.coverageIds.map(id => `<code>${escapeHtml(id)}</code>`).join(" ")}${rec.relatedFindings.length ? ` · Findings: ${rec.relatedFindings.map(id => `<code>${escapeHtml(id)}</code>`).join(" ")}` : ""}</div>
  </div>`).join("") || `<div class="empty">Nothing actionable — no coverage gaps remain.</div>`;

  const tables = CATEGORY_ORDER.map(({ category }) => coverageItemsTable(analysis, category)).filter(Boolean).join("");
  const aiNotes = coverage.aiNotes?.gaps?.length ? `<h3>Coverage gaps (deterministic + AI reword)</h3><ul>${coverage.aiNotes.gaps.map(gap => `<li>${escapeHtml(gap)}</li>`).join("")}</ul>` : "";

  return `
    <p class="sub">Evidence-based coverage: TESTED requires execution evidence (a flow step, a verification probe, or a live scanner read such as link-integrity). Scanning an element is a fact, never a test; responsive coverage is never claimed from a desktop-only scan.</p>
    <div class="grid">${cards}</div>
    <h3>Test plan (what QA should do next)</h3>${planRows}
    ${aiNotes}
    ${tables}`;
};

// Phase 13 - performance: the measured metrics plus, when a budgets file was
// configured, the breaches (which are ordinary findings and also appear in the
// severity tables above). Pure presentation: nothing is measured, scored, or
// invented here.
const performanceSection = (analysis: QaAnalysis): string => {
  const metrics: PerformanceMetrics | undefined = analysis.scan.performance;
  const breached = analysis.findings.filter(finding => isPerfBudgetCode(finding.code));
  if (!metrics && breached.length === 0) return "";
  const keys = Object.keys(PERF_METRIC_LABELS) as (keyof PerformanceMetrics)[];
  const rows = keys.map(key => {
    const value = metrics?.[key] ?? null;
    const rendered = value == null ? "unavailable" : key === "cls" ? value.toFixed(3) : `${Math.round(value)} ms`;
    return `<tr><th>${escapeHtml(PERF_METRIC_LABELS[key])}</th><td>${escapeHtml(rendered)}</td></tr>`;
  }).join("");
  const breachTable = breached.length
    ? `<h3>Declared budgets exceeded</h3>
  <table><thead><tr><th>Finding</th><th>Metric</th><th>Measured vs budget</th></tr></thead><tbody>${breached.map(finding => `<tr><td><code>${escapeHtml(finding.id)}</code></td><td><span class="q">${escapeHtml(finding.title)}</span></td><td class="sub">${escapeHtml(finding.description)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="sub">No configured performance budget was exceeded.</p>`;
  return `<section>
  <h2>Performance</h2>
  <p class="sub">Measured during the scan. Metrics are checked against the performance budgets file only when one was configured (<code>--perf-budgets</code> or <code>perf.budgets</code> in qa.config.json); a breach is an ordinary CRITICAL finding, never a separate gate or a new exit code.</p>
  <table><tbody>${rows}</tbody></table>
  ${breachTable}
</section>`;
};

const accessPrerequisiteSection = (analysis: QaAnalysis): string => {
  const ap = analysis.accessPrerequisite;
  if (!ap) return "";
  const tone = ap.status === "BLOCKED" ? "badge-status-fail" : ap.status === "PASS" ? "badge-status-pass" : "badge-status-review";
  return `<section>
  <h2>Access Prerequisite</h2>
  <p class="sub">The normal QA scan did not run because this site requires an access prerequisite. Access prerequisites are not website defects; they are kept separate from the website findings below.</p>
  <div class="chips">Type: <span class="badge badge-state">${escapeHtml(ap.type)}</span> · Status: <span class="badge ${tone}">${escapeHtml(ap.status)}</span></div>
  <table><tbody>
    <tr><th>Type</th><td><code>${escapeHtml(ap.type)}</code></td></tr>
    <tr><th>Status</th><td>${escapeHtml(ap.status)}</td></tr>
    <tr><th>Message</th><td class="sub">${escapeHtml(ap.message)}</td></tr>
    ${ap.httpStatus != null ? `<tr><th>HTTP status</th><td>${escapeHtml(String(ap.httpStatus))}</td></tr>` : ""}
    ${ap.challenge ? `<tr><th>Challenge</th><td>${escapeHtml(ap.challenge)}</td></tr>` : ""}
  </tbody></table>
  <p class="sub">Website findings: ${analysis.findings.length} issue group(s). Normal QA scan: not run — content is inaccessible without human review.</p>
</section>`;
};

export function renderQaHtml(analysis: QaAnalysis): string {
  const { scan, summary, findings } = analysis;
  const status = summary.overallStatus;
  const cards = [
    ["Elements", summary.elementCount],
    ["Interactive", summary.interactiveElements],
    ["Findings", summary.issueCount],
    ["Flows", summary.flowsDetected],
    ["Intent scenarios", summary.intentScenarios],
    ["Automated", summary.automatedScenarios],
    ["Review", summary.reviewTests],
    ["Manual", summary.manualScenarios],
    ["Broken links", summary.brokenLinks],
    ["Verified", summary.verified],
    ["Executed", summary.executed],
    ["Reproduced", summary.reproduced],
    ["Not reproduced", summary.notReproduced],
    ["Passed checks", summary.pass],
    ["Review needed", summary.reviewRequired],
    ["Scheduled", summary.scheduled],
    ["Skipped", summary.skippedUnsupported + summary.skippedLocatorGuard + summary.skippedSafety],
    ["Infrastructure", summary.infrastructureProblems],
    ["Unverified", summary.unverified],
    ["Manual flows", summary.flowsDetected],
    ["Flow discovery", summary.flowSummary?.flows ?? 0],
    ["Flows executed", summary.flowSummary?.executed ?? 0],
    ["Coverage actions", analysis.coverage?.summary.recommendations ?? 0],
    ["Pages tested", analysis.coverage?.summary.pages.tested ?? 0],
    ["Root-cause candidates", analysis.intelligence?.summary.candidates ?? 0],
    ["Investigation queue", analysis.intelligence?.summary.investigationQueue ?? 0],
  ].map(([label, value]) => `<div class="card"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("");

  // A scan that never reached the site must not render a wall of zeros: "0 findings"
  // would read as "nothing is wrong". Show an explicit NOT TESTED notice instead.
  const blocked = analysis.accessPrerequisite ?? null;
  const blockedNotice = blocked
    ? `<div class="notice" role="alert"><strong>SITE NOT TESTED — this is NOT a clean result.</strong><br>Reason: <code>${escapeHtml(blocked.type)}</code> (${escapeHtml(blocked.status)}) — ${escapeHtml(blocked.message)}<br>No page content was scanned, so no findings, counts or coverage figures were assessed. Provide an approved session or credentials, then re-run. Details are in the <em>Access Prerequisite</em> section below.</div>`
    : "";
  const summaryBody = blocked ? blockedNotice : `<div class="grid">${cards}</div>`;

  const countTable = SEVERITY_ORDER.map(({ severity, label }) => `<tr><td>${severityBadge(severity)}</td><td>${label}</td><td class="num">${escapeHtml(summary.bySeverity[severity])}</td></tr>`).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA Analysis — ${escapeHtml(scan.scan.title || scan.scan.url)}</title>
<style>
:root{color-scheme:light}body{font:14px system-ui,sans-serif;margin:0;background:#f7f9fc;color:#17212b;line-height:1.45}main{max-width:1440px;margin:auto;padding:2rem}h1{margin:0}h2{margin:2.2rem 0 .7rem}section,.overview{background:#fff;border:1px solid #d7dee8;border-radius:10px;padding:1.2rem;margin-top:1rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem}.card{background:#fff;border:1px solid #d7dee8;border-radius:8px;padding:.85rem;margin-top:.6rem}.card strong{font-size:1.2rem;display:block}.headline{font-size:1.05rem;font-weight:600}.sub{color:#64748b;font-size:.85rem;margin-top:.15rem}.chips{color:#475569;font-size:.82rem;margin-top:.35rem}.notice{background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:.8rem 1rem;margin-top:.6rem;color:#7c2d12}.chips.warn{background:#fef3c7;border-radius:6px;padding:.35rem .5rem}.fail{color:#b42318}.warning{color:#9a6700}.info{color:#175cd3}.pass{color:#067647}.num{text-align:right;font-variant-numeric:tabular-nums}.empty{color:#94a3b8;font-style:italic;padding:.4rem 0}.q{font-weight:600}.ev{margin:.2rem 0;padding-left:1.1rem;font-size:.82rem}.flow-el{font-size:.82rem;color:#475569}.badge{font-weight:700;font-size:.72rem;padding:.12rem .45rem;border-radius:99px;white-space:nowrap;display:inline-block;margin:.05rem}.badge-critical,.badge-fail,.badge-status-fail{background:#fde8e8;color:#b42318}.badge-high,.badge-status-review{background:#fef3c7;color:#9a6700}.badge-medium{background:#fff4e5;color:#b54708}.badge-low,.badge-info{background:#eef2f7;color:#475569}.badge-status-pass{background:#e6f4ea;color:#067647}.badge-status-not-tested{background:#eef2f7;color:#475569}.badge-status-blocked{background:#fde8e8;color:#b42318}.badge-conf-high{background:#e6f4ea;color:#067647}.badge-conf-medium{background:#fef3c7;color:#9a6700}.badge-conf-low{background:#fde8e8;color:#b42318}.badge-auto{background:#e0edff;color:#175cd3}.badge-manual{background:#f1f5f9;color:#475569}.badge-safe{background:#e6f4ea;color:#067647}.badge-review{background:#fef3c7;color:#9a6700}.badge-high-risk{background:#fde8e8;color:#b42318}.badge-blocked{background:#f8fafc;color:#0f172a;border:1px solid #94a3b8}.badge-flow{background:#ede9fe;color:#6d28d9}.badge-state{background:#e2e8f0;color:#334155}.badge-intent{background:#e0edff;color:#175cd3}.badge-prio{background:#f1f5f9;color:#475569}.badge-risk.safe{background:#e6f4ea;color:#067647}.badge-risk.review{background:#fef3c7;color:#9a6700}.badge-risk.high-risk{background:#fde8e8;color:#b42318}.finding-head{display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}table{border-collapse:collapse;width:100%;background:#fff}td,th{padding:.6rem;border:1px solid #d7dee8;text-align:left;vertical-align:top;word-break:break-word}th{background:#f1f5f9}code{white-space:pre-wrap;font-size:.85em}.finding{font-size:.85rem}.finding .q{font-size:.9rem}.finding .heading{font-size:1rem}.fix ul{margin:.3rem 0;padding-left:1.2rem}ol,ul{margin:.15rem 0}
</style></head><body><main>

<h1>QA Analysis</h1>
<section class="overview">
  <h2>Executive Summary</h2>
  <p class="headline">${statusBadge(status)} ${escapeHtml(summary.headline)}</p>
  <p class="sub">Analyzed by <code>${escapeHtml(summary.aiProvider)}</code> in ${escapeHtml(summary.mode)} mode on ${escapeHtml(summary.scannedAt)}.</p>
  ${summaryBody}
  ${summary.topRecommendations.length ? `<h3>Top recommended fixes</h3><ol>${summary.topRecommendations.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : ""}
</section>

${regressionSection(analysis)}

${intelligenceSection(analysis)}

${historySection(analysis)}

${historicalIntelligenceSection(analysis)}

${accessPrerequisiteSection(analysis)}

<section>
  <h2>Scan Information</h2>
  <table><tbody>
    <tr><th>URL</th><td><a href="${safeHref(scan.scan.url)}">${escapeHtml(scan.scan.url)}</a></td></tr>
    <tr><th>Final URL</th><td><a href="${safeHref(scan.scan.finalUrl)}">${escapeHtml(scan.scan.finalUrl)}</a></td></tr>
    <tr><th>HTTP status</th><td>${escapeHtml(scan.scan.navigationStatus)}</td></tr>
    <tr><th>Page title</th><td>${escapeHtml(scan.scan.title || "(missing)")}</td></tr>
    <tr><th>Language</th><td>${escapeHtml(scan.page.language ?? "(missing)")}</td></tr>
    <tr><th>Viewport meta</th><td>${escapeHtml(scan.page.viewport ?? "(missing)")}</td></tr>
    <tr><th>Authentication</th><td>${escapeHtml(scan.authentication.method)}; accepted: ${escapeHtml(scan.authentication.accepted)}</td></tr>
    <tr><th>Scan time</th><td>${escapeHtml(scan.scan.timestamp)} (${escapeHtml(scan.scan.durationMs)} ms)</td></tr>
  </tbody></table>
</section>

${performanceSection(analysis)}

<section>
  <h2>QA Findings by Severity</h2>
  ${blocked ? `<p class="sub">Not assessed — the site was not scanned (see Access Prerequisite).</p>` : `<table><thead><tr><th>Severity</th><th>Description</th><th>Findings</th></tr></thead><tbody>${countTable}</tbody></table>`}
  ${SEVERITY_ORDER.map(({ severity, label }) => `${findings.filter(finding => finding.severity === severity).length ? `<h3>${label} (${findings.filter(finding => finding.severity === severity).length})</h3><table><thead><tr><th>ID</th><th>Lifecycle</th><th>Confidence</th><th>Code</th><th>Finding</th><th>Count</th><th>Evidence</th><th>Example</th></tr></thead><tbody>${findingRows(analysis, severity)}</tbody></table>` : ""}`).join("")}
</section>

<section>
  <h2>Finding Status</h2>
  <p class="sub">Lifecycle: DISCOVERED → ANALYZED → TEST_GENERATED → TEST_EXECUTED → REPRODUCED / NOT_REPRODUCED / PASS / REVIEW. A finding stays visible even when verification cannot reproduce it — nothing is silently dropped.</p>
  ${findingStatusTable(analysis)}
</section>

<section>
  <h2>Verification Disposition</h2>
  <p class="sub">Explicit per-finding disposition: what did the scanner find, was it analyzed, was it tested, was it reproduced — and if it was not tested, exactly why not (unsupported code, unsafe/ambiguous/fragile locator, or safety guard).</p>
  ${dispositionTable(analysis)}
</section>

<section>
  <h2>Verification Results</h2>
  <p class="sub">Outcome classes: REPRODUCED/WEBSITE (live DOM matches the signal), NOT_REPRODUCED/LOCATOR (element absent), NOT_REPRODUCED/EXPECTATION or PASS (element present but clean), CONDITIONAL (state-dependent UI), REVIEW/INFRASTRUCTURE (runner/network — not evidence about the site).</p>
  <p class="sub">Disposition counts: ${summary.scheduled} scheduled, ${summary.executed} executed, ${summary.reproduced} reproduced, ${summary.notReproduced} not reproduced, ${summary.pass} passed, ${summary.reviewRequired} review required, ${summary.skippedUnsupported} skipped (unsupported), ${summary.skippedLocatorGuard} skipped (locator guard), ${summary.skippedSafety} skipped (safety), ${summary.infrastructureProblems} infrastructure.</p>
  ${verificationTable(analysis)}
</section>

<section>
  <h2>Accessibility Findings</h2>
  ${findingCards(analysis, "accessibility")}
</section>

<section>
  <h2>Navigation Findings</h2>
  ${findingCards(analysis, "navigation")}
</section>

<section>
  <h2>User Flows</h2>
  ${flowCards(analysis)}
</section>

<section>
  <h2>Flow Discovery</h2>
  <p class="sub">Phase 3 autonomous discovery: site-graph facts → user flows → safe execution. Every step is classified deterministically; only SAFE + AUTOMATED steps run. REVIEW/HIGH_RISK/BLOCKED steps are recorded as boundaries and stopped before execution.</p>
  ${flowDiscoverySection(analysis)}
</section>

<section>
  <h2>Coverage Overview</h2>
  <p class="sub">Phase 4: what is tested, what is only partially tested, what could not be tested safely, what remains uncovered — and what QA should investigate next. Every item and recommendation traces to evidence.</p>
  ${coverageSection(analysis)}
</section>

<section>
  <h2>Automated Test Coverage</h2>
  <p class="sub"><code>${scan.scan.url}</code> — ${summary.automatedScenarios} automated element scenario(s); counted here as the executable smoke surface.</p>
  <h3>Automated element scenarios</h3>
  ${elementScenarioCards(analysis, scenario => scenario.automated)}
  <h3>Verification intent scenarios</h3>
  ${scenarioCards(analysis, scenario => scenario.automation === "AUTOMATED")}
</section>

<section>
  <h2>Manual / Review Scenarios</h2>
  <p class="sub">${summary.reviewTests} review test(s) are parked as <code>test.fixme</code> placeholders in the generated spec; ${summary.manualScenarios} scenario(s) across all manual work streams.</p>
  <h3>Intent scenarios needing review</h3>
  ${scenarioCards(analysis, scenario => scenario.automation === "REVIEW" || scenario.automation === "MANUAL")}
  <h3>Element scenarios marked manual/review</h3>
  ${elementScenarioCards(analysis, scenario => !scenario.automated)}
</section>

<section>
  <h2>High-Risk Scenarios</h2>
  <p class="sub">These scenarios are never automated. ${summary.highRiskScenarios} high-risk element scenario(s) exist; review before any manual execution.</p>
  ${elementScenarioCards(analysis, scenario => scenario.risk === "high-risk")}
</section>

<section>
  <h2>Detailed Evidence</h2>
  <table><thead><tr><th>ID</th><th>Severity</th><th>Finding</th><th>Evidence trail</th><th>Rationale</th></tr></thead><tbody>
  ${findings.map(finding => `<tr><td>${escapeHtml(finding.id)}</td><td>${severityBadge(finding.severity)}</td><td><code>${escapeHtml(finding.code)}</code><br><span class="q">${escapeHtml(finding.title)}</span></td><td>${findingEvidence(analysis, finding)}</td><td class="sub">${escapeHtml(finding.rationale)}</td></tr>`).join("")}
  </tbody></table>
</section>

<section>
  <h2>Recommended Fixes</h2>
  ${recommendedFixes(analysis)}
</section>

<section>
  <h2>Test Execution Results</h2>
  ${executionTable(analysis)}
</section>

</main></body></html>`;

  return html;
}

export function writeQaReport(analysis: QaAnalysis, outputPath: string): { jsonPath: string; htmlPath: string } {
  const jsonPath = resolve(outputPath);
  const htmlPath = jsonPath.slice(0, jsonPath.length - extname(jsonPath).length) + ".html";
  atomicWriteText(jsonPath, JSON.stringify(analysis, null, 2));
  atomicWriteText(htmlPath, renderQaHtml(analysis));
  return { jsonPath, htmlPath };
}