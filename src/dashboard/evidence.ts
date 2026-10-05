// ---------------------------------------------------------------------------
// Phase 8D — Evidence Explorer (bounded, read-only evidence views).
//
// Everything here is a pure CONSUMER of artifacts the pipeline already wrote:
// it NEVER re-runs the scanner, never synthesizes new analysis, never edits a
// finding, and never invents evidence. Two artifact shapes are accepted:
//
//   - "report":    the full current QaAnalysis JSON (schema v1). Richest view:
//                  scan elements/links/console/page evidence, full verification
//                  evidence, the intelligence map and the historical-intelligence
//                  section.
//   - "snapshot":  a persisted HistoryRunSnapshot. Only what the archive kept is
//                  shown — redacted evidence references, compact verification,
//                  and the reduced intelligence candidates. Full element
//                  metadata and historical intelligence are NOT part of this
//                  artifact, and that absence is stated, never implied.
//
// Boundedness: findings lists carry a small summary per finding; full
// descriptions, scan data, and recommendation text are only emitted for the
// single finding a user opens. Even the full report is only ever read into
// memory for the run that is the report's OWN current run.
// ---------------------------------------------------------------------------
import type { QaAnalysis, QaFinding, VerificationResult, Severity } from "../ai/types.js";
import type { HistoryRunSnapshot, FindingHistorySnapshot, VerificationHistorySnapshot } from "../history/types.js";
import { findingSignature } from "../regression/identity.js";
import type { ScanReport } from "../types.js";
import { evaluateGate, GATE_DEFAULT_MIN_SEVERITY, GATE_MIN_SEVERITIES, GateMinSeverity } from "../qa/gate.js";

export type RunArtifact =
  | { kind: "report"; analysis: QaAnalysis }
  | { kind: "snapshot"; snapshot: HistoryRunSnapshot };

export type RunMeta = {
  runId: string;
  source: "report" | "snapshot";
  sourceLabel: string;
  siteIdentity: string;
  entryUrl: string;
  startedAt: string;
  completedAt: string | null;
  scannedUrl: string | null;
  title: string | null;
  headline: string | null;
  findingCount: number;
};

export type FindingSummary = {
  id: string;
  code: string;
  severity: string;
  confidence: string;
  domain: string;
  status: string;
  lifecycle: string;
  title: string;
  page: string | null;
  occurrenceCount: number;
  verification: {
    disposition: string;
    status: string | null;
    verdict: string | null;
  } | null;
  rootCause: number;
};

export type OccurrenceView = {
  id: string;
  kind: string;
  selector?: string;
  tag?: string;
  role?: string;
  accessibleName?: string;
  href?: string;
  url?: string;
  text?: string;
  alt?: string;
  visible?: boolean;
  source: string;
  note?: string;
  detail: { label: string; value: string }[];
};

export type VerificationView = {
  disposition: string;
  scenarioId: string | null;
  strategy: string | null;
  status: string | null;
  category: string | null;
  verdict: string | null;
  confidence: string | null;
  reason: string;
  safety: string;
  locator: string | null;
  executedAt: string | null;
  durationMs: number | null;
  error: { type: string; message: string } | null;
  evidence: { label: string; value: string }[];
};

export type RootCauseView = {
  candidateId: string;
  title: string;
  description?: string;
  pattern: string;
  status: string;
  confidence: string;
  confidenceReason?: string;
  affectedPages: string[];
  priority?: string;
  priorityReason?: string;
};

export type HistoryView = {
  available: boolean;
  note: string | null;
  key?: string;
  page?: string;
  family?: string;
  lifecycle?: string;
  confidence?: string;
  confidenceReason?: string;
  runIds?: string[];
  runsObserved?: number;
  runsAbsent?: number;
  firstSeenRunId?: string | null;
  lastSeenRunId?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  latestDisposition?: string | null;
  latestVerdict?: string | null;
  reproducedRunIds?: string[];
  clearedRunIds?: string[];
  absentRunIds?: string[];
  reviewNote?: string | null;
  contradictions?: { runId: string; disposition: string; verdict: string | null; note: string }[];
};

export type FindingDetailView = {
  run: RunMeta;
  finding: {
    id: string;
    code: string;
    severity: string;
    confidence: string;
    domain: string;
    status: string;
    lifecycle: string;
    title: string;
    description: string;
    recommendation: string;
    userImpact: string;
    rationale: string;
    count: number | null;
    occurrenceCount: number;
    page: string | null;
    relatedScenarioIds: string[];
  };
  verification: VerificationView | null;
  occurrences: OccurrenceView[];
  rootCause: RootCauseView[];
  history: HistoryView | null;
  gate: GateDetailView | null;
  notes: string[];
};

/** Phase 9 gate status for a single finding, derived from the report's OWN
 *  regression map — never re-analyzed, never invented. */
export type GateDetailView = {
  /** The report carries a baseline comparison, so the gate is meaningful. */
  active: boolean;
  minSeverity: GateMinSeverity;
  violation: {
    classification: "NEW" | "REGRESSION";
    severity: Severity | null;
    findingId: string | null;
    anchor: string;
    summary: string;
    evidence: string[];
    recommendedAction: string;
  } | null;
};

export type FindingsFilter = {
  q?: string;
  severity?: string;
  status?: string;
  domain?: string;
  code?: string;
};

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const has = (value: unknown): value is string | number | boolean => value !== null && value !== undefined;

const labelRows = (pairs: [string, unknown][]): { label: string; value: string }[] => {
  const rows: { label: string; value: string }[] = [];
  for (const [label, value] of pairs) {
    if (!has(value) || value === "") continue;
    rows.push({ label, value: typeof value === "boolean" ? (value ? "true" : "false") : String(value) });
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Run metadata across both artifact shapes.
// ---------------------------------------------------------------------------
export function runMetaOf(artifact: RunArtifact): RunMeta {
  if (artifact.kind === "report") {
    const analysis = artifact.analysis;
const scannedUrl = analysis.scan?.scan?.url ?? null;
    return {
      runId: analysis.history?.currentRunId ?? "current",
      source: "report",
      sourceLabel: "current report (qa-analysis.json)",
      siteIdentity: analysis.history?.siteIdentity ?? scannedUrl ?? "",
      entryUrl: scannedUrl ?? "",
      startedAt: analysis.scan?.scan?.timestamp ?? analysis.generatedAt,
      completedAt: analysis.scan?.scan?.timestamp ?? null,
      scannedUrl,
      title: analysis.scan?.scan?.title ?? null,
      headline: analysis.summary?.headline ?? null,
      findingCount: asArray<QaFinding>(analysis.findings).length,
    };
  }
  const snapshot = artifact.snapshot;
  return {
    runId: snapshot.runId,
    source: "snapshot",
    sourceLabel: `archived run artifact (runs/${snapshot.runId}.json)`,
    siteIdentity: snapshot.siteIdentity,
    entryUrl: snapshot.entryUrl,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    scannedUrl: snapshot.scannedOriginUrl || null,
    title: null,
    headline: snapshot.summary?.headline ?? null,
    findingCount: asArray<FindingHistorySnapshot>(snapshot.findings).length,
  };
}

/** Raw findings in artifact order, or [] when absent/malformed. */
export function findingsOf(artifact: RunArtifact): (QaFinding | FindingHistorySnapshot)[] {
  if (artifact.kind === "report") return asArray<QaFinding>(artifact.analysis.findings);
  return asArray<FindingHistorySnapshot>(artifact.snapshot.findings);
}

const idOf = (finding: QaFinding | FindingHistorySnapshot): string =>
  "id" in finding ? finding.id : finding.findingId;

const findingBase = (finding: QaFinding | FindingHistorySnapshot) => ({
  id: idOf(finding),
  code: finding.code,
  severity: finding.severity,
  confidence: "confidence" in finding ? finding.confidence : "unknown",
  domain: finding.domain,
  status: finding.status,
  lifecycle: finding.lifecycle,
  title: finding.title,
});

const evidenceRefsOf = (finding: QaFinding | FindingHistorySnapshot): { type: string; index: number | null; locator?: string; accessibleName?: string; tag?: string }[] =>
  asArray<{ type: string; index: number | null; locator?: string; accessibleName?: string; tag?: string }>(finding.evidence);

const occurrenceCountOf = (finding: QaFinding | FindingHistorySnapshot): number => evidenceRefsOf(finding).length;

const verificationSummaryOf = (finding: QaFinding | FindingHistorySnapshot): FindingSummary["verification"] => {
  const verification = finding.verification ?? null;
  if (!verification) return null;
  const status = "status" in verification ? (verification.status ?? null) : null;
  const verdict = "verdict" in verification ? (verification.verdict ?? null) : null;
  return {
    disposition: verification.disposition,
    status: status ?? null,
    verdict: verdict ?? null,
  };
};

// ---------------------------------------------------------------------------
// Findings list (bounded) + filtering.
// ---------------------------------------------------------------------------
export function listFindings(artifact: RunArtifact, filter: FindingsFilter = {}): { run: RunMeta; total: number; findings: FindingSummary[] } {
  const run = runMetaOf(artifact);
  const q = filter.q?.trim().toLowerCase() ?? "";
  const severity = filter.severity?.trim().toUpperCase() ?? "";
  const status = filter.status?.trim().toUpperCase() ?? "";
  const domain = filter.domain?.trim().toLowerCase() ?? "";
  const code = filter.code?.trim().toUpperCase() ?? "";
  const matches = (finding: QaFinding | FindingHistorySnapshot): boolean => {
    if (severity && finding.severity.toUpperCase() !== severity) return false;
    if (status && finding.status.toUpperCase() !== status) return false;
    if (domain && finding.domain.toLowerCase() !== domain) return false;
    if (code && !finding.code.toUpperCase().startsWith(code)) return false;
    if (q) {
      const haystack = [finding.title, finding.description, finding.code, idOf(finding), finding.domain, finding.severity]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  };
  const findings = findingsOf(artifact)
    .filter(matches)
    .map((finding) => ({
      ...findingBase(finding),
      page: "page" in finding ? (finding.page ?? null) : null,
      occurrenceCount: occurrenceCountOf(finding),
      verification: verificationSummaryOf(finding),
      rootCause: 0,
    }));
  const candidates = rootCauseCandidatesOf(artifact);
  for (const item of findings) {
    item.rootCause = candidates.filter((candidate) => (candidate.findingIds ?? []).includes(item.id)).length;
  }
  return { run, total: findings.length, findings };
}

// ---------------------------------------------------------------------------
// Root-cause candidates across both shapes.
// ---------------------------------------------------------------------------
type RootCauseCandidateEntry = {
  candidateId: string;
  title: string;
  description?: string;
  pattern: string;
  status: string;
  confidence: string;
  confidenceReason?: string;
  affectedPages: string[];
  findingIds: string[];
};

function rootCauseCandidatesOf(artifact: RunArtifact): RootCauseCandidateEntry[] {
  if (artifact.kind === "report") {
    const intelligence = artifact.analysis.intelligence;
    if (!intelligence) return [];
    return asArray<{
      candidateId: string;
      title: string;
      description?: string;
      pattern: string;
      status: string;
      confidence: string;
      confidenceReason?: string;
      affectedPages?: string[];
      findingIds?: string[];
    }>(intelligence.rootCauseCandidates).map((candidate) => ({
      candidateId: candidate.candidateId,
      title: candidate.title,
      description: candidate.description,
      pattern: candidate.pattern,
      status: candidate.status,
      confidence: candidate.confidence,
      confidenceReason: candidate.confidenceReason,
      affectedPages: candidate.affectedPages ?? [],
      findingIds: candidate.findingIds ?? [],
    }));
  }
  const intelligence = artifact.snapshot.intelligence;
  if (!intelligence) return [];
  return asArray<{
    candidateId: string;
    title: string;
    pattern: string;
    status: string;
    confidence: string;
    affectedPages?: string[];
    findingIds?: string[];
  }>(intelligence.rootCauseCandidates).map((candidate) => ({
    candidateId: candidate.candidateId,
    title: candidate.title,
    pattern: candidate.pattern,
    status: candidate.status,
    confidence: candidate.confidence,
    affectedPages: candidate.affectedPages ?? [],
    findingIds: candidate.findingIds ?? [],
  }));
}

const rootCauseViewsOf = (artifact: RunArtifact, findingId: string): RootCauseView[] => {
  const queueById = new Map<string, { priority?: string; priorityReason?: string }>();
  if (artifact.kind === "report" && artifact.analysis.intelligence) {
    for (const entry of asArray<{ candidateId: string; priority?: string; priorityReason?: string }>(artifact.analysis.intelligence.investigationQueue)) {
      queueById.set(entry.candidateId, { priority: entry.priority, priorityReason: entry.priorityReason });
    }
  }
  return rootCauseCandidatesOf(artifact)
    .filter((candidate) => candidate.findingIds.includes(findingId))
    .map((candidate) => {
      const queue = queueById.get(candidate.candidateId) ?? {};
      return {
        candidateId: candidate.candidateId,
        title: candidate.title,
        description: candidate.description,
        pattern: candidate.pattern,
        status: candidate.status,
        confidence: candidate.confidence,
        confidenceReason: candidate.confidenceReason,
        affectedPages: candidate.affectedPages,
        priority: queue.priority,
        priorityReason: queue.priorityReason,
      };
    });
};

// ---------------------------------------------------------------------------
// Historical join. Historical-finding key == findingSignature key (the phase
// 5/6 semantic key persisted verbatim as snapshot.semanticKey). For the
// current full report we recompute it against the live analysis; archived
// snapshots simply do not carry a historical-intelligence section.
// ---------------------------------------------------------------------------
const historyOf = (artifact: RunArtifact, finding: QaFinding | FindingHistorySnapshot): HistoryView | null => {
  if (artifact.kind === "snapshot") {
    return { available: false, note: "Historical intelligence is only included in the report of the latest run, not in archived run artifacts." };
  }
  const historical = artifact.analysis.historicalIntelligence;
  if (!historical || !Array.isArray(historical.findings)) {
    return { available: false, note: "No historical intelligence section exists in this run's report." };
  }
  const key = findingSignature(finding as QaFinding, artifact.analysis.scan?.scan?.url ?? "", artifact.analysis.scan?.elements ?? []).key;
  const record = historical.findings.find((item) => item.key === key);
  if (!record) {
    return {
      available: false,
      note: "This finding has no matched historical record for its semantic key.",
      key,
      page: "page" in finding ? finding.page ?? undefined : undefined,
    };
  }
  return {
    available: true,
    key: record.key,
    page: record.page,
    family: record.family,
    lifecycle: record.lifecycle,
    confidence: record.confidence,
    confidenceReason: record.confidenceReason,
    runIds: record.runIds,
    runsObserved: record.runsObserved,
    runsAbsent: record.runsAbsent,
    firstSeenRunId: record.firstSeenRunId,
    lastSeenRunId: record.lastSeenRunId,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    latestDisposition: record.latestDisposition,
    latestVerdict: record.latestVerdict,
    reproducedRunIds: record.reproducedRunIds,
    clearedRunIds: record.clearedRunIds,
    absentRunIds: record.absentRunIds,
    reviewNote: record.reviewNote,
    contradictions: record.contradictions,
    note: null,
  };
};

// ---------------------------------------------------------------------------
// Occurrences: resolve evidence references against the artifact's scan data
// (report) or the redacted reference itself (snapshot). Indices that point
// outside the recorded arrays produce an occurrence that says so instead of
// crashing or guessing.
// ---------------------------------------------------------------------------
function occurrencesOf(artifact: RunArtifact, finding: QaFinding | FindingHistorySnapshot): OccurrenceView[] {
  const refs = evidenceRefsOf(finding);
  const isReport = artifact.kind === "report";
  const scan: ScanReport | null = isReport ? artifact.analysis.scan : null;
  const results: OccurrenceView[] = [];
  let position = 0;
  for (const ref of refs) {
    const kind = ref.type;
    const index = ref.index;
    const occurrenceId = index != null && kind !== "authentication" ? `${kind}-${index}` : `${kind || "ref"}-${position}`;
    position += 1;
    const occurrence: OccurrenceView = {
      id: occurrenceId,
      kind,
      source: isReport
        ? `current report — ${kind === "element" ? "scan.elements[]" : kind === "console" ? "scan.consoleDiagnostics[]" : kind === "link" ? "scan.links[]" : kind === "page" ? "scan.pageErrors[]" : "scan.authentication"}`
        : `archived run artifact — findings[].evidence[]`,
      detail: [],
    };

    if (isReport && kind === "authentication") {
      const authentication = scan?.authentication;
      if (authentication) {
        occurrence.detail = labelRows([
          ["Method", authentication.method],
          ["Username header present", authentication.usernamePresent],
          ["Password header present", authentication.passwordPresent],
          ["Authorization header present", authentication.authorizationPresent],
          ["Accepted", authentication.accepted],
        ]);
      } else {
        occurrence.note = "No authentication diagnostic was recorded in this run.";
      }
    } else if (isReport && index != null) {
      if (kind === "element") {
        const element = scan?.elements?.[index];
        if (element) {
          occurrence.selector = element.recommendedLocator;
          occurrence.tag = element.tag;
          occurrence.role = element.role ?? undefined;
          occurrence.accessibleName = element.accessibleName ?? undefined;
          occurrence.href = element.href ?? undefined;
          occurrence.text = element.text || undefined;
          occurrence.alt = element.alt ?? undefined;
          occurrence.visible = element.visible;
          occurrence.detail = labelRows([
            ["Element index", index],
            ["Locator quality", element.locatorQuality],
            ["Id", element.id],
            ["Name", element.name],
            ["Placeholder", element.placeholder],
            ["Type", element.type],
            ["Enabled", element.enabled],
            ["Interactive", element.interactive],
          ]);
        } else {
          occurrence.selector = ref.locator;
          occurrence.note = `Element index ${index} is outside the recorded scan.elements array (length ${scan?.elements?.length ?? 0}); only the reference itself was retained.`;
        }
      } else if (kind === "link") {
        const link = scan?.links?.[index];
        if (link) {
          occurrence.url = link.url;
          occurrence.selector = ref.locator;
          occurrence.detail = labelRows([
            ["Link index", index],
            ["Status", link.status],
            ["Type", link.type],
            ["Error", link.error],
          ]);
        } else {
          occurrence.note = `Link index ${index} is outside the recorded scan.links array (length ${scan?.links?.length ?? 0}).`;
        }
      } else if (kind === "console") {
        const diagnostic = scan?.consoleDiagnostics?.[index];
        if (diagnostic) {
          occurrence.detail = labelRows([
            ["Console index", index],
            ["Message", diagnostic.message],
            ["Source", diagnostic.source],
            ["Category", diagnostic.category],
            ["Status", diagnostic.status],
          ]);
        } else {
          occurrence.note = `Console index ${index} is outside the recorded scan.consoleDiagnostics array (length ${scan?.consoleDiagnostics?.length ?? 0}).`;
        }
      } else if (kind === "page") {
        const error = scan?.pageErrors?.[index];
        if (error !== undefined) {
          occurrence.detail = labelRows([
            ["Page error index", index],
            ["Error", error],
          ]);
        } else {
          occurrence.note = `Page error index ${index} is outside the recorded scan.pageErrors array (length ${scan?.pageErrors?.length ?? 0}).`;
        }
      }
    } else if (isReport && index == null) {
      // Snapshot-style locator reference embedded directly in the finding.
      occurrence.selector = ref.locator;
      occurrence.accessibleName = ref.accessibleName;
      occurrence.tag = ref.tag;
      if (!ref.locator && !ref.accessibleName && !ref.tag) {
        occurrence.note = "This reference carries no embedded element snapshot.";
      }
    } else if (!isReport) {
      // Archived run artifact: only the redacted reference survived.
      occurrence.selector = ref.locator;
      occurrence.accessibleName = ref.accessibleName;
      occurrence.tag = ref.tag;
      occurrence.detail = labelRows([
        ["Index", index],
        ["Recorded kind", kind === "authentication" ? "authentication diagnostic" : `${kind} evidence`],
      ]);
      if (!ref.locator && !ref.accessibleName && !ref.tag) {
        occurrence.note = "The archived snapshot retains only this reference; full element metadata is not persisted for archived runs.";
      }
    }

    results.push(occurrence);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Verification evidence (report = full VerificationResult, snapshot = the
// compact VerificationHistorySnapshot).
// ---------------------------------------------------------------------------
function verificationOf(artifact: RunArtifact, findingId: string): VerificationView | null {
  if (artifact.kind === "report") {
    const result = asArray<VerificationResult>(artifact.analysis.verifications).find((item) => item.findingId === findingId);
    if (result) {
      const evidence = result.evidence;
      const detail: { label: string; value: string }[] = [];
      if (evidence) {
        detail.push(...labelRows([
          ["Located", evidence.located],
          ["Url", evidence.url],
          ["Tag", evidence.tag],
          ["Role", evidence.role],
          ["Accessible name", evidence.accessibleName],
          ["Text", evidence.text],
          ["Visible", evidence.visible],
          ["Enabled", evidence.enabled],
          ["Href", evidence.href],
          ["Id", evidence.id],
          ["Count", evidence.count],
          ["Screenshot path", evidence.screenshotPath],
        ]));
        if (evidence.attributes) detail.push(...labelRows(Object.entries(evidence.attributes).map(([key, value]) => [key, value] as [string, unknown])));
      }
      return {
        disposition: findFinding(artifact, findingId)?.verification?.disposition ?? "SCHEDULED",
        scenarioId: result.scenarioId,
        strategy: result.strategy,
        status: result.status,
        category: result.category,
        verdict: result.triage?.verdict ?? null,
        confidence: result.triage?.confidence ?? null,
        reason: result.triage?.reason ?? "",
        safety: "n/a",
        locator: result.locator,
        executedAt: result.executedAt,
        durationMs: result.durationMs,
        error: result.error,
        evidence: detail,
      };
    }
  } else {
    const snapshot = asArray<VerificationHistorySnapshot>(artifact.snapshot.verifications).find((item) => item.findingId === findingId);
    if (snapshot) {
      return {
        disposition: findFinding(artifact, findingId)?.verification?.disposition ?? "SCHEDULED",
        scenarioId: snapshot.scenarioId,
        strategy: snapshot.strategy,
        status: snapshot.status,
        category: snapshot.category,
        verdict: snapshot.verdict,
        confidence: snapshot.confidence,
        reason: "",
        safety: "n/a",
        locator: snapshot.locator,
        executedAt: snapshot.executedAt,
        durationMs: snapshot.durationMs,
        error: null,
        evidence: [],
      };
    }
    return null;
  }
  return null;
}

function findFinding(artifact: RunArtifact, findingId: string): (QaFinding | FindingHistorySnapshot) | undefined {
  return findingsOf(artifact).find((item) => idOf(item) === findingId);
}

/** The gate threshold recorded in the report's reproducibility snapshot. */
export function gateMinSeverityOf(analysis: QaAnalysis | null | undefined): GateMinSeverity {
  const value = analysis?.configuration?.resolved?.ciGateMinSeverity;
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return (GATE_MIN_SEVERITIES as readonly string[]).includes(normalized) ? (normalized as GateMinSeverity) : GATE_DEFAULT_MIN_SEVERITY;
}

/**
 * Phase 9 gate status for one finding id: which FINDING changes in the report's
 * regression map flag this finding as introduced (NEW) or a verified
 * regression (REGRESSION). Returns null for archived snapshots, which carry no
 * regression map.
 */
export function gateDetailOf(analysis: QaAnalysis, findingId: string): GateDetailView | null {
  const minSeverity = gateMinSeverityOf(analysis);
  if (!analysis.regression) return { active: false, minSeverity, violation: null };
  const verdict = evaluateGate({ regression: analysis.regression, findings: analysis.findings }, { minSeverity });
  const violation = verdict.violations.find((item) => item.findingId === findingId) ?? null;
  return {
    active: true,
    minSeverity,
    violation: violation
      ? {
          classification: violation.classification,
          severity: violation.severity,
          findingId: violation.findingId,
          anchor: violation.anchor,
          summary: violation.summary,
          evidence: violation.evidence,
          recommendedAction: violation.recommendedAction,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Finding detail — the single bounded view a user opens.
// ---------------------------------------------------------------------------
export function findingDetail(artifact: RunArtifact, findingId: string): (FindingDetailView & { ok: true }) | { ok: false; error: string } {
  const finding = findFinding(artifact, findingId);
  if (!finding) return { ok: false, error: `finding ${findingId} not found in run ${runMetaOf(artifact).runId}` };
  const run = runMetaOf(artifact);
  const occurrences = occurrencesOf(artifact, finding);
  const verification = verificationOf(artifact, findingId);
  const rootCause = rootCauseViewsOf(artifact, findingId);
  const history = historyOf(artifact, finding);
  const gate = artifact.kind === "report" ? gateDetailOf(artifact.analysis, findingId) : null;

  const notes: string[] = [];
  if (artifact.kind === "report") {
    if (!artifact.analysis.scan) notes.push("This report carries no scan section, so element-level evidence cannot be resolved.");
  }
  if (!verification) notes.push("No verification result is recorded in this artifact for this finding.");
  if (rootCause.length === 0) notes.push("This finding is not cited by any root-cause candidate in this artifact.");
  if (!history?.available) notes.push(history?.note ?? "No historical record is available for this finding.");
  for (const occurrence of occurrences) if (occurrence.note) notes.push(`Occurrence ${occurrence.id}: ${occurrence.note}`);

  return {
    ok: true,
    run,
    finding: {
      id: idOf(finding),
      code: finding.code,
      severity: finding.severity,
      confidence: "confidence" in finding ? finding.confidence : "unknown",
      domain: finding.domain,
      status: finding.status,
      lifecycle: finding.lifecycle,
      title: finding.title,
      description: "description" in finding ? finding.description : "",
      recommendation: "recommendation" in finding ? finding.recommendation : "",
      userImpact: "userImpact" in finding ? finding.userImpact : "",
      rationale: "rationale" in finding ? finding.rationale : "",
      count: "count" in finding ? finding.count : null,
      occurrenceCount: occurrenceCountOf(finding),
      page: "page" in finding ? (finding.page ?? null) : (history?.page ?? null),
      relatedScenarioIds: "relatedScenarioIds" in finding ? (finding.relatedScenarioIds ?? []) : [],
    },
    verification,
    occurrences,
    rootCause,
    history,
    gate,
    notes,
  };
}