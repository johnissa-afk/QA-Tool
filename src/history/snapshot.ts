// ---------------------------------------------------------------------------
// Phase 7A — run snapshot builder.
//
// Turns a completed QaAnalysis into a bounded, deterministic, redacted
// HistoryRunSnapshot: run metadata + SEMANTIC identities for every finding,
// flow, and coverage item, the verification outcomes, and compact regression /
// intelligence output — everything Phase 7B needs to MATCH the same things
// across runs, and nothing it can't (no full DOM, no crawl ordering, no
// generated raw selector dumps beyond the run-local references, no secrets).
// ---------------------------------------------------------------------------
import type { QaAnalysis } from "../ai/types.js";
import type { HistoryRunSnapshot } from "./types.js";
import {
  findingHistoryKey,
  flowHistoryFamilyKey,
  flowHistorySignature,
  flowHistoryStepKey,
  coverageHistoryKey,
  historySiteIdentityOfKey,
  historySiteKeyOf,
  sha1Of,
} from "./identity.js";
import { normalizePageUrl, normalizeText } from "../regression/identity.js";
import { buildRedactor, redactObject, Redactor } from "../executor/redact.js";

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

export type BuildRunSnapshotOptions = {
  runId: string;
  startedAt: string;
  completedAt?: string;
  siteKey?: ReturnType<typeof historySiteKeyOf>;
  redact?: Redactor;
  environment?: string;
  browser?: string;
};

/** All semantic identities recorded in a snapshot — kept sorted and joined so
 *  `identityDigest` is deterministic across identical runs. */
function collectIdentities(snapshot: Omit<HistoryRunSnapshot, "identityDigest">): string[] {
  const parts: string[] = [];
  for (const finding of snapshot.findings) parts.push(`finding:${finding.semanticKey}`);
  for (const flow of snapshot.flows) parts.push(`flow:${flow.signature}`, `flow-family:${flow.familyKey}`);
  for (const coverage of snapshot.coverage) parts.push(`coverage:${coverage.semanticKey}`);
  return [...new Set(parts)].sort();
}

export function buildRunSnapshot(analysis: QaAnalysis, options: BuildRunSnapshotOptions): HistoryRunSnapshot {
  const redact = options.redact ?? buildRedactor(process.env);
  const siteKey = options.siteKey ?? historySiteKeyOf(analysis);
  const siteIdentity = historySiteIdentityOfKey(siteKey);
  const startedAt = options.startedAt;
  const completedAt = options.completedAt ?? startedAt;

  const findings = analysis.findings.map(finding => {
    const historyKey = findingHistoryKey(analysis, finding);
    return {
      findingId: finding.id,
      page: historyKey.page,
      semanticKey: historyKey.key,
      family: historyKey.family,
      code: finding.code,
      domain: finding.domain,
      severity: finding.severity,
      status: finding.status,
      lifecycle: finding.lifecycle,
      title: clip(finding.title, 200),
      description: clip(finding.description, 400),
      verification: finding.verification
        ? {
            disposition: finding.verification.disposition,
            status: finding.verification.status,
            category: finding.verification.category,
            verdict: finding.verification.verdict,
            reason: clip(finding.verification.reason, 300),
            safety: finding.verification.safety,
            executedAt: finding.verification.executedAt,
            durationMs: finding.verification.durationMs,
          }
        : null,
      evidence: finding.evidence.map(ref => ({
        type: ref.type,
        index: ref.index,
        ...(ref.locator !== undefined ? { locator: clip(redact(ref.locator), 200) } : {}),
        ...(ref.accessibleName !== undefined ? { accessibleName: ref.accessibleName } : {}),
        ...(ref.tag !== undefined ? { tag: ref.tag } : {}),
      })),
    };
  });

  const verifications = analysis.verifications.map(result => ({
    scenarioId: result.scenarioId,
    findingId: result.findingId,
    strategy: result.strategy,
    status: result.status,
    category: result.category,
    verdict: result.triage?.verdict ?? null,
    confidence: result.triage?.confidence ?? null,
    executedAt: result.executedAt,
    durationMs: result.durationMs,
    locator: result.locator ? clip(redact(result.locator), 200) : null,
  }));

  const flows = (analysis.flowDiscovery?.flows ?? []).map(flow => ({
    flowId: flow.flowId,
    category: flow.category,
    startPage: normalizePageUrl(flow.startUrl),
    familyKey: flowHistoryFamilyKey(flow),
    signature: flowHistorySignature(flow),
    title: clip(flow.title, 200),
    description: clip(flow.description, 400),
    safety: flow.safety,
    automation: flow.automation,
    executable: flow.executable,
    priority: flow.priority,
    occurrenceCount: flow.occurrenceCount,
    confidence: flow.confidence,
    boundary: flow.boundary
      ? { stepIndex: flow.boundary.stepIndex, safety: flow.boundary.safety, automation: flow.boundary.automation, reason: clip(flow.boundary.reason, 300) }
      : null,
    steps: flow.steps.map((step, index) => ({
      index,
      action: step.action,
      targetKey: flowHistoryStepKey(step),
      targetUrl: step.targetUrl ? normalizePageUrl(step.targetUrl) : null,
      safety: step.safety,
      automation: step.automation,
      expected: clip(step.expected, 200),
    })),
  }));

  const coverage = (analysis.coverage?.items ?? []).map(item => ({
    coverageId: item.coverageId,
    semanticKey: coverageHistoryKey(item),
    category: item.category,
    name: clip(item.name, 200),
    status: item.status,
    reason: clip(item.reason, 300),
    safety: item.safety,
    executionStatus: item.executionStatus ?? null,
    pageId: item.pageId,
    url: item.url ? normalizePageUrl(item.url) : null,
    relatedFlows: [...item.relatedFlows].sort(),
    relatedScenarios: [...item.relatedScenarios].sort(),
    relatedFindings: [...item.relatedFindings].sort(),
    evidence: item.evidence.map(ref => ({ pageId: ref.pageId, elementIndex: ref.elementIndex, detail: clip(redact(ref.detail), 200) })),
  }));

  let regression: HistoryRunSnapshot["regression"] = null;
  if (analysis.regression) {
    const map = analysis.regression;
    regression = {
      comparable: map.summary.comparable,
      notComparableReason: map.summary.notComparableReason,
      changeCount: map.summary.changeCount,
      counts: { ...map.summary.counts },
      headline: clip(map.summary.headline, 300),
      baselineReference: { runId: map.runs.baseline.runId, scannedAt: map.runs.baseline.scannedAt },
      currentReference: { runId: map.runs.current.runId, scannedAt: map.runs.current.scannedAt },
      changes: map.changes.map(change => ({
        changeId: change.changeId,
        category: change.category,
        classification: change.classification,
        confidence: change.confidence,
        anchor: change.anchor,
        summary: clip(change.summary, 200),
      })),
    };
  }

  let intelligence: HistoryRunSnapshot["intelligence"] = null;
  if (analysis.intelligence) {
    const map = analysis.intelligence;
    intelligence = {
      generatedAt: map.generatedAt,
      candidates: map.summary.candidates,
      actionable: map.summary.actionable,
      investigationRequired: map.summary.investigationRequired,
      insufficientEvidence: map.summary.insufficientEvidence,
      informational: map.summary.informational,
      highConfidence: map.summary.highConfidence,
      mediumConfidence: map.summary.mediumConfidence,
      lowConfidence: map.summary.lowConfidence,
      insufficientConfidence: map.summary.insufficientConfidence,
      relationships: map.summary.relationships,
      contradictions: map.summary.contradictions,
      investigationQueue: map.summary.investigationQueue,
      rootCauseCandidates: map.rootCauseCandidates.map(candidate => ({
        candidateId: candidate.candidateId,
        pattern: candidate.pattern,
        status: candidate.status,
        confidence: candidate.confidence,
        title: clip(candidate.title, 200),
        findingIds: [...candidate.findingIds].sort(),
        flowIds: [...candidate.flowIds].sort(),
        affectedPages: [...candidate.affectedPages].sort(),
      })),
    };
  }

  const verificationSurface = analysis.findings.filter(finding => finding.verification !== null).length;
  const raw: Omit<HistoryRunSnapshot, "identityDigest"> = {
    schemaVersion: 1,
    runId: options.runId,
    siteKey,
    siteIdentity,
    entryUrl: analysis.scan.scan.url,
    startedAt,
    completedAt,
    mode: analysis.mode,
    aiProvider: analysis.aiProvider,
    scannedOriginUrl: analysis.summary.sourceUrl,
    environment: options.environment ?? null,
    browser: options.browser ?? null,
    summary: {
      headline: clip(analysis.summary.headline, 300),
      findingCount: findings.length,
      flowCount: (analysis.flowDiscovery?.flows.length ?? 0),
      coverageCount: coverage.length,
      executionPlanned: verificationSurface,
      executionReproduced: analysis.summary.reproduced,
      executionNotReproduced: analysis.summary.notReproduced,
      executionInfraProblems: analysis.summary.infrastructureProblems,
    },
    findings,
    verifications,
    flows,
    coverage,
    regression,
    intelligence,
  };

  const identityDigest = sha1Of(collectIdentities(raw).join("\n"));
  // Redact captured content (titles, locators, details, URLs) but NEVER the
  // identity contract: siteKey, siteIdentity, runId, and identityDigest are
  // derived, deterministic metadata — masking them would break cross-run
  // matching and site isolation (redacted origins must keep matching their
  // bucket). Secrets never appear in these fields.
  const snapshot: HistoryRunSnapshot = { ...raw, identityDigest };
  const redacted = redactObject(snapshot, redact);
  redacted.siteKey = snapshot.siteKey;
  redacted.siteIdentity = snapshot.siteIdentity;
  redacted.runId = snapshot.runId;
  redacted.identityDigest = snapshot.identityDigest;
  return redacted;
}

/** The canonical run record for the history index, derived from a snapshot. */
export function qaRunRecordOf(
  snapshot: HistoryRunSnapshot,
  options: { artifactPath?: string; environment?: string; browser?: string } = {},
): import("./types.js").QaRunRecord {
  return {
    runId: snapshot.runId,
    siteKey: snapshot.siteKey,
    siteIdentity: snapshot.siteIdentity,
    entryUrl: snapshot.entryUrl,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    schemaVersion: snapshot.schemaVersion,
    mode: snapshot.mode,
    aiProvider: snapshot.aiProvider,
    scannedOriginUrl: snapshot.scannedOriginUrl,
    environment: options.environment ?? snapshot.environment ?? undefined,
    browser: options.browser ?? snapshot.browser ?? undefined,
    findingCount: snapshot.summary.findingCount,
    flowCount: snapshot.summary.flowCount,
    coverageCount: snapshot.summary.coverageCount,
    executionPlanned: snapshot.summary.executionPlanned,
    executionReproduced: snapshot.summary.executionReproduced,
    executionNotReproduced: snapshot.summary.executionNotReproduced,
    executionInfraProblems: snapshot.summary.executionInfraProblems,
    headline: snapshot.summary.headline,
    identityDigest: snapshot.identityDigest,
    artifactPath: options.artifactPath,
  };
}

/** Counts lookup used by tests and validation. */
export const snapshotTextSize = (value: string): number => normalizeText(value).length;