// ---------------------------------------------------------------------------
// Projects — the organizational layer above QA runs.
//
// A project is a saved website: a name, a URL, and a pointer to the last real
// QA run that was executed against it. It stores no QA results of its own. Every
// status, finding count, and coverage value it displays is read back from the
// report artifact the engine actually wrote, via RunManager's settled hook.
//
// Persistence is a single deterministic JSON document written atomically, which
// matches how this application already stores its history. It lives beside the
// run artifacts rather than inside them, so project metadata and engine output
// can never be confused with one another.
//
// Deleting a project removes only this document's record. Run artifacts, report
// JSON/HTML, and the engine's own history directory are never touched.
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteText } from "../atomic-write.js";
import { coverageStatusLabel } from "../qa/result.js";
import {
  applyRunToLedger,
  assessRunEvidence,
  compareProjectFindings,
  compareRunAnalyses,
  emptyFindingCounts,
  findingMatchesSearch,
  sameOrigin,
  type FindingLifecycleEvent,
  type FindingCounts,
  type ProjectComparisonFindingRef,
  type ProjectFinding,
  type ProjectFindingLedger,
  type ProjectFindingStatus,
  type ProjectRunComparisonResult,
  type ProjectRunFindingsSnapshot,
} from "./project-findings.js";
import {
  buildChangeSummary,
  changeRecordOf,
  unavailableChangeSummary,
  type ChangeSummary,
  type RunChangeRecord,
} from "./run-comparison.js";
import type { QaAnalysis } from "../ai/types.js";
import type { CoverageStatus } from "../coverage/types.js";
import {
  isProjectEmailPreferences,
  normalizeEventList,
  normalizeRecipientList,
  type ProjectEmailPreferences,
} from "./project-email-preferences.js";
import { validateRunUrl, type QaRun, type QaStatus, type RunState } from "./run-manager.js";

/** A saved website, plus a pointer to its most recent real QA run. */
export type Project = {
  id: string;
  name: string;
  /** Normalized absolute URL; this is the identity used for duplicate checks. */
  url: string;
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  /** The verdict the engine wrote, never one this layer computed. */
  lastStatus: QaStatus | null;
  lastFindingsCount: number | null;
  lastCoverageStatus: CoverageStatus | string | null;
  /**
   * Additive: this project's email notification configuration. A project saved
   * before the feature existed has none, and that means "email is off" - see
   * `emailPreferencesOf`. Nothing here is backfilled onto existing projects.
   */
  emailNotifications?: ProjectEmailPreferences;
};

/** One run started from this project, with the values read from its artifact. */
export type ProjectRunRecord = {
  runId: string;
  projectId: string;
  /** The project's URL at the time the run started. */
  url: string;
  startedAt: string;
  completedAt: string | null;
  state: RunState;
  status: QaStatus | null;
  findingsCount: number | null;
  coverageStatus: CoverageStatus | string | null;
  /** The engine's own report artifacts for this run. */
  reportJson: string;
  reportHtml: string;
  /** True when the engine wrote a report we could actually read. */
  hasResult: boolean;
  error: string | null;
};

type ProjectFile = {
  schemaVersion: 1;
  projects: Project[];
  runs: ProjectRunRecord[];
  /** Additive: the project-level finding ledger. Older documents simply have
   *  none, and those projects honestly report lifecycle as unavailable. */
  findings?: ProjectFinding[];
  findingEvents?: FindingLifecycleEvent[];
  findingSnapshots?: ProjectRunFindingsSnapshot[];
  /** Additive: the compact run-to-run change record for each settled run, so
   *  the project page and history table can show changes without re-reading
   *  report artifacts. A missing record is never reconstructed. */
  changeRecords?: RunChangeRecord[];
};

export type ProjectResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

/** Descriptive per-run lifecycle counts for the project history table. */
export type ProjectFindingSummary = {
  runId: string;
  at: string;
  comparisonAvailable: boolean;
  comparisonReason: string | null;
  resolutionTrustworthy: boolean;
  resolutionReason: string | null;
  counts: FindingCounts;
};

/** The only part of a run the project index needs. Keeping this narrow makes it
 *  obvious the store reads nothing else off a run. */
export type ProjectRunInput = Pick<QaRun, "runId" | "projectId" | "url" | "startedAt" | "state" | "artifacts">;

const MAX_NAME_LENGTH = 120;
/** Runs remembered per project. Artifacts on disk are never pruned by this. */
const MAX_RUNS_PER_PROJECT = 50;

const emptyFile = (): ProjectFile => ({ schemaVersion: 1, projects: [], runs: [], findings: [], findingEvents: [], findingSnapshots: [], changeRecords: [] });

const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "");

/** The engine's own coverage label, folded from the page counts it recorded. */
function coverageStatusOf(analysis: QaAnalysis): string | null {
  const pages = analysis.coverage?.summary?.pages;
  return pages ? coverageStatusLabel(pages) : null;
}

export class ProjectStore {
  private readonly path: string;
  private data: ProjectFile;
  /**
   * Reads a past run's real report. Supplied by the server so a comparison is
   * made from the artifact the engine actually wrote, never from memory.
   * Without it a project's first run simply has no comparable predecessor.
   */
  private readonly readAnalysis: ((runId: string) => QaAnalysis | null) | null;

  constructor(filePath: string, options: { readAnalysis?: (runId: string) => QaAnalysis | null } = {}) {
    this.path = resolve(filePath);
    this.readAnalysis = options.readAnalysis ?? null;
    this.data = this.load();
  }

  /** Where the project document lives (surfaced by the API for transparency). */
  get filePath(): string {
    return this.path;
  }

  private load(): ProjectFile {
    if (!existsSync(this.path)) return emptyFile();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
      const file = parsed as Partial<ProjectFile>;
      if (!Array.isArray(file.projects)) return emptyFile();
      return {
        schemaVersion: 1,
        // A project record written before email preferences existed simply has
        // none, and that reads as "email off". A malformed block - a hand-edited
        // document, say - is dropped rather than trusted, so bad config can never
        // become a mailing list.
        projects: file.projects.filter(isProject).map(dropUntrustedEmailPreferences),
        runs: Array.isArray(file.runs) ? file.runs.filter(isProjectRun) : [],
        // A document written before project findings existed simply has none.
        // Nothing is reconstructed: those runs report lifecycle as unavailable.
        findings: Array.isArray(file.findings) ? file.findings.filter(isProjectFinding) : [],
        findingEvents: Array.isArray(file.findingEvents) ? file.findingEvents.filter(isFindingEvent) : [],
        findingSnapshots: Array.isArray(file.findingSnapshots) ? file.findingSnapshots.filter(isFindingSnapshot) : [],
        // Same for change records: a run settled before this feature existed has
        // no record, and its absence is reported rather than filled in.
        changeRecords: Array.isArray(file.changeRecords) ? file.changeRecords.filter(isChangeRecord) : [],
      };
    } catch {
      // A corrupt document must not take the app down; it is an organizational
      // convenience, and no QA artifact depends on it.
      return emptyFile();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    atomicWriteText(this.path, JSON.stringify(this.data, null, 2));
  }

  list(): Project[] {
    return [...this.data.projects];
  }

  get(id: string): Project | null {
    const clean = sanitizeId(id);
    return this.data.projects.find(project => project.id === clean) ?? null;
  }

  create(input: { name?: unknown; url?: unknown }, now: string = new Date().toISOString()): ProjectResult<Project> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return { ok: false, status: 400, error: "Enter a project name." };
    if (name.length > MAX_NAME_LENGTH) return { ok: false, status: 400, error: `Keep the project name under ${MAX_NAME_LENGTH} characters.` };

    const url = validateRunUrl(typeof input.url === "string" ? input.url.trim() : input.url);
    if (url === null) return { ok: false, status: 400, error: "Enter a valid http:// or https:// website URL." };

    const existing = this.data.projects.find(project => project.url === url);
    if (existing) {
      return { ok: false, status: 409, error: `A project for this website already exists: "${existing.name}". Open it instead of creating a duplicate.` };
    }

    const project: Project = {
      id: `prj-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`,
      name,
      url,
      createdAt: now,
      updatedAt: now,
      lastRunId: null,
      lastRunAt: null,
      lastStatus: null,
      lastFindingsCount: null,
      lastCoverageStatus: null,
    };
    this.data.projects.push(project);
    this.persist();
    return { ok: true, value: project };
  }

  update(id: string, patch: { name?: unknown; url?: unknown }, now: string = new Date().toISOString()): ProjectResult<Project> {
    const project = this.get(id);
    if (!project) return { ok: false, status: 404, error: "That project does not exist." };

    if (patch.name !== undefined) {
      const name = typeof patch.name === "string" ? patch.name.trim() : "";
      if (!name) return { ok: false, status: 400, error: "Enter a project name." };
      if (name.length > MAX_NAME_LENGTH) return { ok: false, status: 400, error: `Keep the project name under ${MAX_NAME_LENGTH} characters.` };
      project.name = name;
    }

    if (patch.url !== undefined) {
      const url = validateRunUrl(typeof patch.url === "string" ? patch.url.trim() : patch.url);
      if (url === null) return { ok: false, status: 400, error: "Enter a valid http:// or https:// website URL." };
      const clash = this.data.projects.find(other => other.url === url && other.id !== project.id);
      if (clash) return { ok: false, status: 409, error: `A project for this website already exists: "${clash.name}".` };
      project.url = url;
    }

    project.updatedAt = now;
    this.persist();
    return { ok: true, value: project };
  }

  /**
   * Stores this project's email preferences, replacing them as a whole.
   *
   * The block is written or not written: there is no partial update, because the
   * caller validates the complete payload first. Nothing else on the project is
   * read or touched - no run is started, no finding, schedule or run record is
   * read or modified - so this is a configuration write, not an action.
   *
   * Normalization happens HERE as well as in the API, so the determinism
   * guarantee holds for every caller: recipients are re-validated, deduplicated
   * and sorted, and events are put into canonical order, whatever order they
   * arrive in. The same logical configuration therefore produces the same
   * persisted bytes.
   */
  setEmailPreferences(
    id: string,
    preferences: ProjectEmailPreferences,
    now: string = new Date().toISOString(),
  ): ProjectResult<Project> {
    const project = this.get(id);
    if (!project) return { ok: false, status: 404, error: "That project does not exist." };

    const recipients = normalizeRecipientList(preferences.recipients);
    const events = normalizeEventList(preferences.events);
    if (typeof preferences.enabled !== "boolean" || !recipients.ok || !events.ok) {
      return { ok: false, status: 400, error: "Those email settings are not valid." };
    }
    project.emailNotifications = {
      enabled: preferences.enabled,
      recipients: recipients.value,
      events: events.value,
    };
    project.updatedAt = now;
    this.persist();
    return { ok: true, value: project };
  }

  /**
   * Removes the project's own record and its run index. Run artifacts on disk
   * and the engine's history are deliberately left alone.
   */
  remove(id: string): ProjectResult<{ id: string }> {
    const clean = sanitizeId(id);
    const index = this.data.projects.findIndex(project => project.id === clean);
    if (index === -1) return { ok: false, status: 404, error: "That project does not exist." };
    this.data.projects.splice(index, 1);
    this.data.runs = this.data.runs.filter(run => run.projectId !== clean);
    this.persist();
    return { ok: true, value: { id: clean } };
  }

  /** Records that a run was started for this project. */
  runStarted(project: Project, run: ProjectRunInput): void {
    this.data.runs.push({
      runId: run.runId,
      projectId: project.id,
      url: run.url,
      startedAt: run.startedAt,
      completedAt: null,
      state: run.state,
      status: null,
      findingsCount: null,
      coverageStatus: null,
      reportJson: run.artifacts.reportJson,
      reportHtml: run.artifacts.reportHtml,
      hasResult: false,
      error: null,
    });
    this.trimRuns(project.id);
    this.persist();
  }

  /**
   * Folds a finished run into the project. Every value comes from the report the
   * engine wrote — nothing is inferred from the browser or re-scanned here.
   */
  runSettled(run: QaRun, analysis: QaAnalysis | null): void {
    if (!run.projectId) return;
    const project = this.get(run.projectId);
    if (!project) return;

    const record = this.data.runs.find(entry => entry.runId === run.runId);
    // Coverage is a real, deterministic label folded from the page counts the
    // engine recorded. It is never invented here.
    const coverage = analysis ? coverageStatusOf(analysis) : null;

    if (record) {
      record.state = run.state;
      record.completedAt = run.completedAt;
      record.error = run.error;
      record.status = run.qaStatus;
      record.hasResult = analysis !== null;
      if (analysis) {
        record.findingsCount = analysis.findings?.length ?? null;
        record.coverageStatus = coverage;
      }
    }

    project.updatedAt = new Date().toISOString();
    project.lastRunId = run.runId;
    project.lastRunAt = run.completedAt ?? run.startedAt;
    project.lastStatus = run.qaStatus;
    project.lastFindingsCount = analysis ? (analysis.findings?.length ?? null) : null;
    project.lastCoverageStatus = coverage;
    this.updateFindingLifecycle(run.runId, analysis, run.completedAt ?? run.startedAt);
    this.recordRunChange(run.runId, analysis, run.completedAt ?? run.startedAt);
    this.persist();
  }

  /**
   * Records the compact change record for a finished run, computed once from the
   * two real report artifacts. Like the lifecycle snapshot this is idempotent: a
   * re-settled run keeps the record it was first given, so a comparison never
   * drifts under the reader.
   *
   * The detailed change summary is rebuilt on demand from the same artifacts
   * (see changeSummary); this record only carries the counts the project page and
   * history table display.
   */
  private recordRunChange(
    runId: string,
    analysis: QaAnalysis | null,
    runCompletedAt: string | null,
  ): void {
    if (!analysis) return;
    const projectId = this.data.runs.find(entry => entry.runId === runId)?.projectId;
    if (!projectId) return;
    if ((this.data.changeRecords ?? []).some(record => record.currentRunId === runId)) return;

    const summary = this.computeChangeSummary(projectId, runId, analysis, runCompletedAt);
    if (!summary) return;
    this.data.changeRecords = [...(this.data.changeRecords ?? []), changeRecordOf(summary)];
  }

  /**
   * Advances the project finding ledger for one completed run.
   *
   * Only runs that actually produced a report participate — a failed,
   * interrupted, blocked or infrastructure-broken run is recorded as a run but
   * never updates the finding lifecycle, so it cannot falsely resolve anything.
   * This is entirely separate from the regression gate: a finding returning here
   * is a lifecycle event, never a CI policy decision.
   */
  private updateFindingLifecycle(
    runId: string,
    analysis: QaAnalysis | null,
    /** This run's own persisted completion time, used to order runs. */
    runCompletedAt: string | null,
  ): void {
    if (!analysis) return;
    const projectId = this.data.runs.find(entry => entry.runId === runId)?.projectId;
    if (!projectId) return;
    // Idempotent: a re-settled run keeps its original lifecycle.
    if (this.data.findingSnapshots?.some(snapshot => snapshot.runId === runId)) return;

    const previous = this.previousComparableRun(projectId, analysis, runCompletedAt, runId);
    const result = applyRunToLedger({
      projectId,
      runId,
      analysis,
      ledger: this.ledger(projectId),
      previousAnalysis: previous?.analysis ?? null,
      previousRunId: previous?.runId ?? null,
    });

    const others = (this.data.findings ?? []).filter(finding => finding.projectId !== projectId);
    this.data.findings = [...others, ...result.ledger.findings];
    const otherEvents = (this.data.findingEvents ?? []).filter(event => !result.ledger.events.some(mine => mine.runId === event.runId));
    this.data.findingEvents = [...otherEvents, ...result.ledger.events];
    this.data.findingSnapshots = [...(this.data.findingSnapshots ?? []), result.snapshot];
    this.trimFindingEvents(projectId);
  }

  /** The project's ledger, isolated to this project. */
  private ledger(projectId: string): ProjectFindingLedger {
    return {
      findings: (this.data.findings ?? []).filter(finding => finding.projectId === projectId),
      events: (this.data.findingEvents ?? []).filter(event => {
        const finding = (this.data.findings ?? []).find(item => item.id === event.findingId);
        return finding?.projectId === projectId;
      }),
    };
  }

  /**
   * The nearest earlier project run whose report is still readable and is
   * genuinely comparable to this one. Comparison reuse lives in
   * compareRunAnalyses; this only supplies the candidate.
   */
  private previousComparableRun(
    projectId: string,
    analysis: QaAnalysis,
    runCompletedAt: string | null,
    runId: string,
  ): { runId: string; analysis: QaAnalysis } | null {
    if (!this.readAnalysis) return null;
    // The predecessor is the latest run that COMPLETED before this one. Sorting
    // the candidates by their own completion stamp (newest first) rather than
    // by start time or array position matters when two runs overlap: a run that
    // started earlier but finished later is not this run's predecessor.
    const stamp = runCompletedAt ?? "";
    const earlier = this.data.runs
      .filter(run => run.projectId === projectId)
      .filter(run => run.runId !== runId)
      .filter(run => run.completedAt !== null && (stamp === "" || run.completedAt! < stamp))
      .sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1));
    for (const record of earlier) {
      const candidate = this.readAnalysis(record.runId);
      if (!candidate) continue;
      // Never compare against a run that could not test the site itself.
      if (!assessRunEvidence(candidate).resolutionTrustworthy) continue;
      if (sameOrigin(candidate, analysis) && compareRunAnalyses(analysis, candidate).comparable) {
        return { runId: record.runId, analysis: candidate };
      }
    }
    return null;
  }

  private trimFindingEvents(projectId: string): void {
    const runIds = this.history(projectId).slice(0, MAX_RUNS_PER_PROJECT).map(record => record.runId);
    const keep = new Set(runIds);
    const mine = (this.data.findingEvents ?? []).filter(event => {
      const finding = (this.data.findings ?? []).find(item => item.id === event.findingId);
      return finding?.projectId !== projectId || keep.has(event.runId);
    });
    this.data.findingEvents = mine;
  }

  /** A project's runs, newest first. */
  history(projectId: string): ProjectRunRecord[] {
    const clean = sanitizeId(projectId);
    return this.data.runs
      .filter(run => run.projectId === clean)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  /** Everything one project needs to render itself. */
  detail(id: string): ProjectResult<{ project: Project; runs: ProjectRunRecord[]; findings: ProjectFindingSummary[]; changes: RunChangeRecord[] }> {
    const project = this.get(id);
    if (!project) return { ok: false, status: 404, error: "That project does not exist." };
    return {
      ok: true,
      value: {
        project,
        runs: this.history(project.id),
        findings: this.findingSummary(project.id),
        changes: this.changeRecords(project.id),
      },
    };
  }

  /**
   * The nearest earlier project run whose report is still readable — with no
   * trust filtering.
   *
   * This is deliberately more permissive than previousComparableRun. A run that
   * could not reach the site is still the truth about what happened before it,
   * and an access transition has to be reportable precisely because one side
   * was blocked. Whether anything may be CONCLUDED from the pair is decided by
   * run-comparison's availability rules, not by hiding the run here.
   */
  private previousRunForComparison(
    projectId: string,
    runId: string,
    runCompletedAt: string | null,
  ): { runId: string; analysis: QaAnalysis } | null {
    if (!this.readAnalysis) return null;
    const stamp = runCompletedAt ?? "";
    const earlier = this.history(projectId)
      .filter(record => record.runId !== runId)
      .filter(record => record.completedAt !== null && (stamp === "" || record.completedAt < stamp));
    for (const record of earlier) {
      const candidate = this.readAnalysis(record.runId);
      if (candidate) return { runId: record.runId, analysis: candidate };
    }
    return null;
  }

  /**
   * Builds the full change summary for a run from the two real report
   * artifacts, or null when the current artifact cannot be read at all.
   */
  private computeChangeSummary(
    projectId: string,
    runId: string,
    analysis: QaAnalysis,
    runCompletedAt: string | null,
  ): ChangeSummary | null {
    const previous = this.previousRunForComparison(projectId, runId, runCompletedAt);
    const titles = new Map(
      this.findings(projectId).map(finding => [finding.id, {
        title: finding.title,
        code: finding.code,
        severity: finding.severity,
        page: finding.page,
      }]),
    );
    return buildChangeSummary({
      currentRunId: runId,
      current: analysis,
      previousRunId: previous?.runId ?? null,
      previous: previous?.analysis ?? null,
      // Findings are read from the recorded lifecycle snapshot, never recomputed.
      snapshot: this.findingSnapshot(runId),
      findingTitles: titles,
    });
  }

  /**
   * The run-to-run change summary for one project run, recomputed from the real
   * report artifacts on every request.
   *
   * A run with no readable report, or no recorded snapshot, reports an
   * unavailable comparison with a machine-readable reason rather than
   * reconstructing anything.
   */
  changeSummary(projectId: string, runId: string): ProjectResult<ChangeSummary> {
    const project = this.get(projectId);
    if (!project) return { ok: false, status: 404, error: "That project does not exist." };
    const record = this.data.runs.find(entry => entry.runId === sanitizeId(runId) && entry.projectId === project.id);
    if (!record) return { ok: false, status: 404, error: "That run does not belong to this project." };
    if (!this.readAnalysis) {
      return {
        ok: true,
        value: unavailableChangeSummary(
          record.runId,
          "INSUFFICIENT_EVIDENCE",
          "past report artifacts are not readable in this process, so no run-to-run comparison can be made",
        ),
      };
    }
    const current = this.readAnalysis(record.runId);
    if (!current) {
      return { ok: false, status: 404, error: "That run has no readable report artifact." };
    }
    const summary = this.computeChangeSummary(project.id, record.runId, current, record.completedAt ?? record.startedAt);
    return summary
      ? { ok: true, value: summary }
      : { ok: false, status: 404, error: "That run has no readable report artifact." };
  }

  /** The compact change record recorded for a run, or null if it has none. */
  changeRecord(runId: string): RunChangeRecord | null {
    const clean = sanitizeId(runId);
    return (this.data.changeRecords ?? []).find(record => record.currentRunId === clean) ?? null;
  }

  /** Compact change records for a project, newest first, for the project page. */
  changeRecords(projectId: string): RunChangeRecord[] {
    const clean = sanitizeId(projectId);
    // A change record exists because a run SETTLED, so completion time is the
    // honest clock here; startedAt only breaks a tie. Ordering is total and
    // deterministic: the same project file always renders the same order.
    const stampOf = new Map(
      this.data.runs
        .filter(run => run.projectId === clean)
        .map(run => [run.runId, `${run.completedAt ?? run.startedAt} ${run.runId}`] as const),
    );
    return (this.data.changeRecords ?? [])
      .filter(record => stampOf.has(record.currentRunId))
      .sort((a, b) => (stampOf.get(b.currentRunId)! < stampOf.get(a.currentRunId)! ? -1 : 1));
  }

  /**
   * Descriptive lifecycle measurements per run, newest first, for the project
   * history table. These are counts of real recorded outcomes — never a score,
   * a ranking, or a health number.
   */
  findingSummary(projectId: string): ProjectFindingSummary[] {
    const clean = sanitizeId(projectId);
    return (this.data.findingSnapshots ?? [])
      .filter(snapshot => snapshot.projectId === clean)
      .map(snapshot => ({
        runId: snapshot.runId,
        at: snapshot.at,
        comparisonAvailable: snapshot.comparisonAvailable,
        comparisonReason: snapshot.comparisonReason,
        resolutionTrustworthy: snapshot.resolutionTrustworthy,
        resolutionReason: snapshot.resolutionReason,
        counts: snapshot.counts,
      }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  private trimRuns(projectId: string): void {
    const mine = this.data.runs.filter(run => run.projectId === projectId);
    if (mine.length <= MAX_RUNS_PER_PROJECT) return;
    const keep = new Set(mine.slice(mine.length - MAX_RUNS_PER_PROJECT).map(run => run.runId));
    this.data.runs = this.data.runs.filter(run => run.projectId !== projectId || keep.has(run.runId));
  }

  // -------------------------------------------------------------------------
  // Project findings.
  // -------------------------------------------------------------------------

  /** A project's tracked findings, in a stable severity-then-fingerprint order. */
  findings(projectId: string): ProjectFinding[] {
    return (this.data.findings ?? [])
      .filter(finding => finding.projectId === sanitizeId(projectId))
      .sort(compareProjectFindings);
  }

  /** Optional status / severity / free-text filtering. */
  findingsFiltered(
    projectId: string,
    filters: { status?: string | null; severity?: string | null; search?: string | null } = {},
  ): ProjectFinding[] {
    const status = filters.status ? filters.status.trim().toUpperCase() : null;
    const severity = filters.severity ? filters.severity.trim().toUpperCase() : null;
    const search = filters.search ?? "";
    return this.findings(projectId).filter(finding => {
      if (status && finding.status !== status) return false;
      if (severity && finding.severity !== severity) return false;
      return findingMatchesSearch(finding, search);
    });
  }

  findingDetail(projectId: string, findingId: string): ProjectResult<{
    finding: ProjectFinding;
    events: FindingLifecycleEvent[];
    relatedRuns: { runId: string; status: ProjectFindingStatus; observed: boolean; runFindingId: string | null; at: string }[];
  }> {
    const project = this.get(projectId);
    if (!project) return { ok: false, status: 404, error: "That project does not exist." };
    const finding = this.findings(project.id).find(item => item.id === sanitizeId(findingId));
    if (!finding) return { ok: false, status: 404, error: "That finding is not tracked for this project." };
    const events = this.findingEvents(project.id, finding.id);
    // Deterministic, no fabricated run entries: only recorded runs appear.
    const relatedRuns = events.map(event => ({
      runId: event.runId,
      status: event.status,
      observed: event.observed,
      runFindingId: event.runFindingId,
      at: event.at,
    }));
    return { ok: true, value: { finding, events, relatedRuns } };
  }

  /** A finding's recorded lifecycle, oldest first. */
  findingEvents(projectId: string, findingId: string): FindingLifecycleEvent[] {
    const clean = sanitizeId(findingId);
    return (this.data.findingEvents ?? [])
      .filter(event => event.findingId === clean)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.runId < b.runId ? -1 : 1));
  }

  /** The recorded finding snapshot for one run, if it has one. */
  findingSnapshot(runId: string): ProjectRunFindingsSnapshot | null {
    return (this.data.findingSnapshots ?? []).find(snapshot => snapshot.runId === sanitizeId(runId)) ?? null;
  }

  findingSnapshots(projectId: string): ProjectRunFindingsSnapshot[] {
    const clean = sanitizeId(projectId);
    return (this.data.findingSnapshots ?? []).filter(snapshot => snapshot.projectId === clean);
  }

  /**
   * The comparison between a run and the project's previous comparable run.
   *
   * A run with no recorded snapshot (for example one that completed before
   * project finding tracking existed) reports the comparison as unavailable
   * rather than reconstructing unsupported history.
   */
  runComparison(projectId: string, runId: string): ProjectResult<{ runId: string; comparison: ProjectRunComparisonResult; snapshot: ProjectRunFindingsSnapshot | null }> {
    const project = this.get(projectId);
    if (!project) return { ok: false, status: 404, error: "That project does not exist." };
    const clean = sanitizeId(runId);
    const snapshot = this.findingSnapshot(clean);
    if (!snapshot || snapshot.projectId !== project.id) {
      return {
        ok: true,
        value: {
          runId: clean,
          snapshot: null,
          comparison: {
            comparisonAvailable: false,
            reason: "this run has no recorded project finding snapshot, so no comparison can be shown",
            counts: emptyFindingCounts(),
            new: [], resolved: [], regressed: [], active: [], unchanged: [], changed: [],
          },
        },
      };
    }

    // Resolve each recorded id to a reference the UI can link to. Served
    // verbatim from persisted refs; nothing is recomputed here.
    const runFindingIdOf = (findingId: string): string | null =>
      snapshot.entries.find(entry => entry.projectFindingId === findingId)?.runFindingId ?? null;
    const resolve = (ids: string[]) => {
      const out: ProjectComparisonFindingRef[] = [];
      for (const id of ids) {
        const finding = this.findings(project.id).find(item => item.id === id);
        if (!finding) continue;
        out.push({
          id: finding.id,
          fingerprint: finding.fingerprint,
          title: finding.title,
          code: finding.code,
          severity: finding.severity,
          status: finding.status,
          page: finding.page,
          runId: snapshot.runId,
          runFindingId: runFindingIdOf(finding.id),
        });
      }
      return out;
    };

    return {
      ok: true,
      value: {
        runId: clean,
        snapshot,
        comparison: {
          comparisonAvailable: snapshot.comparisonAvailable,
          reason: snapshot.comparisonReason,
          counts: snapshot.counts,
          new: resolve(snapshot.refs.new),
          resolved: resolve(snapshot.refs.resolved),
          regressed: resolve(snapshot.refs.regressed),
          active: resolve(snapshot.refs.active),
          unchanged: resolve(snapshot.refs.unchanged),
          changed: resolve(snapshot.refs.changed),
        },
      },
    };
  }
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<Project>;
  return typeof project.id === "string" && typeof project.name === "string" && typeof project.url === "string";
}

/**
 * Removes an `emailNotifications` block that does not validate, leaving every
 * other project field exactly as it was read.
 *
 * The alternative - accepting an unvalidated block - would mean a file edited by
 * hand could put arbitrary strings into `recipients` and have the API treat them
 * as configured.
 */
function dropUntrustedEmailPreferences(project: Project): Project {
  if (project.emailNotifications === undefined || isProjectEmailPreferences(project.emailNotifications)) return project;
  const { emailNotifications: _discarded, ...rest } = project;
  return rest as Project;
}

function isProjectRun(value: unknown): value is ProjectRunRecord {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<ProjectRunRecord>;
  return typeof run.runId === "string" && typeof run.projectId === "string";
}

function isChangeRecord(value: unknown): value is RunChangeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RunChangeRecord>;
  return (
    typeof record.currentRunId === "string" &&
    typeof record.availability === "string" &&
    typeof record.pagesAdded === "number" &&
    typeof record.flowsAdded === "number" &&
    Array.isArray(record.flowStatusChanges)
  );
}

const FINDING_STATUSES: ProjectFindingStatus[] = ["NEW", "ACTIVE", "REGRESSED", "RESOLVED"];

function isProjectFinding(value: unknown): value is ProjectFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<ProjectFinding>;
  return (
    typeof finding.id === "string" &&
    typeof finding.fingerprint === "string" &&
    typeof finding.projectId === "string" &&
    typeof finding.severity === "string" &&
    typeof finding.title === "string" &&
    typeof finding.status === "string" &&
    FINDING_STATUSES.includes(finding.status as ProjectFindingStatus)
  );
}

function isFindingEvent(value: unknown): value is FindingLifecycleEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<FindingLifecycleEvent>;
  return typeof event.findingId === "string" && typeof event.runId === "string" && typeof event.status === "string";
}

function isFindingSnapshot(value: unknown): value is ProjectRunFindingsSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ProjectRunFindingsSnapshot>;
  return typeof snapshot.runId === "string" && typeof snapshot.projectId === "string" && Array.isArray(snapshot.entries);}

/** Default location: its own folder beside the run artifacts. */
export function defaultProjectsPath(reportDir: string): string {
  return join(reportDir, "projects", "projects.json");
}
