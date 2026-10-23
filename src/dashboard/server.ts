// ---------------------------------------------------------------------------
// Phase 8B — local QA dashboard server.
//
// A zero-dependency Node http server. It exposes the existing report and
// history artifacts read-only (QA analysis JSON, HTML report, history index,
// individual run artifacts) and, since Phase 12, serves the QA application at
// / (src/dashboard/app.html) which can START a real run via POST /api/qa/run.
// The run manager (./run-manager.ts) launches the same src/qa-cli.ts the CLI
// uses, so the QA engine is never duplicated behind the UI. The original
// read-only evidence dashboard remains available at /dashboard. Binds to
// loopback by default — local tool, not a network service.
// ---------------------------------------------------------------------------
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateRunSnapshot } from "../history/validate.js";
import { findingDetail, gateMinSeverityOf, listFindings, RunArtifact } from "./evidence.js";
import { evaluateGate } from "../qa/gate.js";
import { parseBaselineMaxAge, verifyBaseline } from "../qa/baseline.js";
import { RunManager, RUN_STAGES, parseMaxConcurrentRuns, type QaRun } from "./run-manager.js";
import { defaultProjectsPath, ProjectStore } from "./projects.js";
import { defaultSchedulesPath, frequencyLabel, ScheduleStore, SCHEDULE_FREQUENCIES, type ScheduleFrequency, type ScheduledExecution } from "./project-schedules.js";
import { artifactProof, Scheduler } from "./scheduler.js";
import { buildNotificationPreview, deriveNotificationEvents, deriveScheduleExecutionEvents } from "./notification-preview.js";
import { defaultNotificationsPath, NotificationStore } from "./notifications.js";
import {
  defaultNotificationDeliveriesPath,
  isDeliveryStatus,
  isNotificationChannel,
  NotificationDeliveryDispatcher,
  NotificationDeliveryStore,
} from "./notification-delivery.js";
import type { DeliveryStatus, NotificationChannel, NotificationDeliveryTransport } from "./notification-delivery.js";
import { NotificationEmailTransport, renderTestEmailMessage } from "./email-transport.js";
import type { TestEmailSender } from "./email-transport.js";
import { NotificationEmailDispatch } from "./notification-email-dispatch.js";
import {
  emailEventOptions,
  emailPreferencesOf,
  emailReadiness,
  parseEmailPreferences,
} from "./project-email-preferences.js";
import { buildResultsView } from "./results-view.js";
import type { QaAnalysis } from "../ai/types.js";

export type DashboardOptions = {
  reportDir: string;
  jsonReport?: string;
  htmlReport?: string;
  historyDir: string;
  host: string;
  port: number;
  pagePath?: string;
  /** Phase 10D: baseline rotation policy duration (e.g. "30d"); enables the
   *  staleness position in the home-view baseline trust card. */
  baselineMaxAge?: string | null;
  /** How many QA runs the dashboard may execute at once (default 1; also QA_MAX_CONCURRENT_RUNS). */
  maxConcurrentRuns?: number;
  /** Phase 12: project root holding src/qa-cli.ts; enables QA run execution. */
  projectRoot?: string;
  /** Phase 12: test seam for the run manager's child spawner. */
  spawnImpl?: typeof import("node:child_process").spawn;
  /** Where the saved-projects document is kept. Defaults beside the reports. */
  projectsPath?: string;
  /** Where the QA-schedule document is kept. Defaults beside the reports. */
  schedulesPath?: string;
  /** Where the in-app notification inbox is kept. Defaults beside the reports. */
  notificationsPath?: string;
  /** Where notification delivery attempts are kept. Defaults beside the reports. */
  notificationDeliveriesPath?: string;
  /** Test seam for the clock, shared by the schedule store and the scheduler. */
  now?: () => number;
  /**
   * Test seam for the test-email route. Defaults to a real
   * NotificationEmailTransport over the environment SMTP configuration; tests
   * inject a fake so no test can reach a mail server.
   */
  emailTransport?: TestEmailSender;
  /**
   * Test seam for AUTOMATIC notification email delivery, distinct from the
   * test-email route above. Defaults to a real NotificationEmailTransport over the
   * environment SMTP configuration; tests inject a fake so no test can reach a
   * mail server. A test email never goes through here.
   */
  emailDeliveryTransport?: NotificationDeliveryTransport;
  /** How often due schedules are checked. Defaults to 30s. */
  scheduleTickMs?: number;
  /** Set false to build a server without starting the scheduler. */
  scheduleEnabled?: boolean;
};

export type DashboardServer = {
  server: ReturnType<typeof createServer>;
  host: string;
  port: number;
  url: string;
  /** The live scheduler, exposed so tests and validation can drive it directly. */
  scheduler: Scheduler;
  schedules: ScheduleStore;
  /** The in-app notification inbox, exposed for the same reason. */
  notifications: NotificationStore;
  /** Notification delivery attempts, exposed so tests can dispatch deliberately. */
  notificationDeliveries: NotificationDeliveryStore;
  /**
   * The dispatcher behind AUTOMATIC notification email delivery, exposed so a
   * retry or an idempotency check can be driven directly and asserted on.
   */
  emailDeliveryDispatcher: NotificationDeliveryDispatcher;
  /**
   * Awaits every automatic email delivery started so far, including any started
   * while an earlier one was still in flight.
   *
   * Delivery deliberately runs outside notification creation, so this is how a
   * caller - the real browser validation, or a test - observes it deterministically
   * instead of polling a file.
   */
  settleEmailDeliveries: () => Promise<void>;
};

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const send = (res: ServerResponse, status: number, contentType: string, body: string | Buffer): void => {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "connection": "close",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
};

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
};

/** Reads a small JSON request body (bounded), rejecting anything oversized. */
const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        rejectBody(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", rejectBody);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolveBody(null);
      try {
        resolveBody(JSON.parse(text));
      } catch {
        rejectBody(new Error("invalid json"));
      }
    });
  });

/**
 * Cached parse of the current report keyed by file identity (path + size +
 * mtime), so per-request evidence views never re-read or re-parse the full
 * report artifact (it can be large). The memo is refreshed whenever the file
 * on disk changes.
 */
type CurrentReport = { kind: "ok"; report: unknown } | { kind: "missing" } | { kind: "malformed" };

let currentReportMemo: { path: string; size: number; mtimeMs: number; report: unknown } | null = null;

function readCurrentReport(jsonReport: string): CurrentReport {
  try {
    const stat = statSync(jsonReport);
    const memo = currentReportMemo;
    if (memo && memo.path === jsonReport && memo.size === stat.size && memo.mtimeMs === stat.mtimeMs) {
      return { kind: "ok", report: memo.report };
    }
    const report = JSON.parse(readFileSync(jsonReport, "utf8"));
    currentReportMemo = { path: jsonReport, size: stat.size, mtimeMs: stat.mtimeMs, report };
    return { kind: "ok", report };
  } catch (error) {
    currentReportMemo = null;
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "malformed" };
  }
}

/**
 * Same memoized read for a WEB run's own report artifact, keyed by file
 * identity. The productized results view and the finding detail view are both
 * pure reads of the artifact the CLI already wrote.
 */
const runReportMemo = new Map<string, { size: number; mtimeMs: number; analysis: QaAnalysis | null }>();

type RunReport = { kind: "ok"; analysis: QaAnalysis } | { kind: "missing" } | { kind: "malformed" };

function readRunReport(run: QaRun): RunReport {
  const path = run.artifacts.reportJson;
  try {
    const stat = statSync(path);
    const memo = runReportMemo.get(path);
    if (memo && memo.size === stat.size && memo.mtimeMs === stat.mtimeMs && memo.analysis) {
      return { kind: "ok", analysis: memo.analysis };
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const analysis = parsed && typeof parsed === "object" ? (parsed as QaAnalysis) : null;
    if (!analysis) return { kind: "malformed" };
    runReportMemo.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, analysis });
    return { kind: "ok", analysis };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "malformed" };
  }
}

function baselineVerificationOf(report: QaAnalysis | null, maxAgeMs: number | null): ReturnType<typeof verifyBaseline> | null {
  const baselinePath = report?.regression?.baselinePath;
  return baselinePath ? verifyBaseline(baselinePath, { maxAgeMs }) : null;
}

/**
 * Resolve a run id to an artifact for the Evidence Explorer. The run that IS
 * the current report (report.history.currentRunId) is served from the full
 * report; every other run is served from its persisted snapshot. Returns null
 * when neither the report nor a persisted artifact matches.
 */
function resolveRunArtifact(runId: string, jsonReport: string, historyDir: string): RunArtifact | null {
  const current = readCurrentReport(jsonReport);
  if (current.kind === "ok") {
    const report = current.report as { history?: { currentRunId?: string | null } };
    if (report.history?.currentRunId === runId) {
      return { kind: "report", analysis: current.report as QaAnalysis };
    }
  }
  const artifactPath = join(historyDir, "runs", `${runId}.json`);
  if (!existsSync(artifactPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    // Malformed snapshot — treat as an unknown run (404), never a 500.
    return null;
  }
  const validated = validateRunSnapshot(parsed);
  if (!validated.ok) return null;
  return { kind: "snapshot", snapshot: validated.value };
}

export function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const reportDir = resolve(options.reportDir);
  const jsonReport = options.jsonReport ? resolve(options.jsonReport) : join(reportDir, "qa-analysis.json");
  const htmlReport = options.htmlReport ? resolve(options.htmlReport) : join(reportDir, "qa-analysis.html");
  const historyDir = resolve(options.historyDir);
  const pagePath = options.pagePath ? resolve(options.pagePath) : join(process.cwd(), "src", "dashboard", "index.html");
  const appPath = join(dirname(pagePath), "app.html");
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 4173;
  const baselineMaxAgeMs = options.baselineMaxAge != null ? parseBaselineMaxAge(options.baselineMaxAge) : null;
  // Runs are launched by the real CLI, rooted at the project that owns it.
  const projectRoot = resolve(options.projectRoot ?? join(dirname(pagePath), "..", ".."));
  // Projects sit above runs, not inside the engine. The store is wired to the
  // run manager's lifecycle hooks so a project's summary is always folded from
  // the report artifact the engine actually wrote. `readAnalysis` re-reads that
  // real artifact when a later run needs to be compared with an earlier one.
  const readRunAnalysis = (runId: string): QaAnalysis | null => {
    const file = join(reportDir, "runs", runId, "qa-analysis.json");
    try {
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, "utf8")) as QaAnalysis;
    } catch {
      // An unreadable or truncated artifact is reported as "no comparison",
      // never as a comparison built from guessed data.
      return null;
    }
  };
  const projects = new ProjectStore(options.projectsPath ?? defaultProjectsPath(reportDir), { readAnalysis: readRunAnalysis });
  const runsDir = join(reportDir, "runs");

  // Schedules are their own document, separate from run artifacts, so a
  // scheduled run is stored and read exactly like any other run.
  const schedules = new ScheduleStore(options.schedulesPath ?? defaultSchedulesPath(reportDir), {
    now: options.now,
  });

  // In-app notifications are a third document, again separate from run
  // artifacts. It stores only what the shared event derivation already decided,
  // so this layer decides nothing about whether an event exists.
  const notifications = new NotificationStore(options.notificationsPath ?? defaultNotificationsPath(reportDir));

  // Delivery history is a SEPARATE document from the inbox, so recording a
  // delivery can never rewrite a notification: notifications.json is only ever
  // written by NotificationStore, and notification-deliveries.json is only ever
  // written by the dispatcher.
  const notificationDeliveries = new NotificationDeliveryStore(
    options.notificationDeliveriesPath ?? defaultNotificationDeliveriesPath(reportDir),
    // The server is the composition root and is the only place allowed to know
    // about the process environment. The delivery store only ever needs it so it
    // can strip those values back OUT of anything it persists.
    process.env,
  );

  /**
   * The base URL this server can be reached at, used only to build links inside
   * outgoing mail. Assigned once the server is listening, and read lazily by the
   * test-email route, so the port is the real one.
   */
  let dashboardUrl = "";
  // A real transport over the environment configuration by default; a test seam
  // so no test can reach a mail server. Used ONLY by the test-email route.
  const emailTransport: TestEmailSender = options.emailTransport ?? {
    sendTestMessage: (message, recipient) =>
      new NotificationEmailTransport({ dashboardUrl }).sendTestMessage(message, recipient),
  };

  // --- Automatic notification email delivery --------------------------------------
  //
  // The real transport is built lazily per send for one reason: `dashboardUrl` is
  // only known once the listener is bound, and a message must link back to the
  // port the server actually got. This is the SAME transport class the test-email
  // route uses, reached through the existing dispatcher, so idempotency, retry
  // numbering and redaction are the ones already tested.
  const emailDeliveryTransport: NotificationDeliveryTransport = options.emailDeliveryTransport ?? {
    channel: "EMAIL",
    send: request => new NotificationEmailTransport({ dashboardUrl }).send(request),
  };

  const emailDeliveryDispatcher = new NotificationDeliveryDispatcher({
    store: notificationDeliveries,
    transports: { EMAIL: emailDeliveryTransport },
    ...(options.now ? { now: options.now } : {}),
  });

  const emailDispatch = new NotificationEmailDispatch({
    dispatcher: emailDeliveryDispatcher,
    // A read, and only a read: delivery never writes to a project document.
    loadProject: projectId => projects.get(projectId),
  });

  /**
   * Delivery in flight, chained so `settleEmailDeliveries` can drain it.
   *
   * Notifications must not wait on SMTP, so this work is deliberately detached from
   * the code that records a notification. The chain keeps the failures contained:
   * one rejected delivery never rejects the next.
   */
  let emailDeliveryChain: Promise<unknown> = Promise.resolve();
  const trackEmailDelivery = (work: Promise<unknown>): void => {
    emailDeliveryChain = emailDeliveryChain.then(() => work).catch(() => undefined);
  };
  const settleEmailDeliveries = async (): Promise<void> => {
    // Loops so deliveries started while an earlier one was in flight are drained
    // too, rather than leaving a caller to guess whether it is finished.
    let settled: Promise<unknown>;
    do {
      settled = emailDeliveryChain;
      await settled;
    } while (settled !== emailDeliveryChain);
  };

  /**
   * Turns already-recorded verdicts for one settled run into stored
   * notifications, using the SAME derivation the preview endpoint calls.
   *
   * Called only after the project update and the schedule bookkeeping have both
   * completed, so the lifecycle snapshot, comparison, change summary and
   * execution history this reads are already final. The run's own completion
   * stamp is used as the event time, so a notification is dated when the event
   * happened rather than when the inbox happened to be written.
   *
   * A failed write is logged and never blocks anything: the QA run has already
   * settled, and losing a notification must not disturb an engine result.
   */
  const recordRunNotifications = (projectId: string | null, runId: string): void => {
    if (!projectId) return;
    const project = projects.get(projectId);
    if (!project) return;
    const run = projects.history(project.id).find(entry => entry.runId === runId);
    if (!run) return;
    const comparison = projects.runComparison(project.id, runId);
    const changes = projects.changeSummary(project.id, runId);
    const saved = notifications.record(
      deriveNotificationEvents({
        project,
        run,
        analysis: run.hasResult ? readRunAnalysis(runId) : null,
        snapshot: projects.findingSnapshot(runId),
        comparison: comparison.ok ? comparison.value.comparison : null,
        changeSummary: changes.ok ? changes.value : null,
        executions: schedules.executionsFor(project.id),
      }),
      run.completedAt ?? run.startedAt,
    );
    if (!saved.ok) { console.error(`  notifications: ${saved.error}`); return; }
    // Only the records the inbox actually CREATED are offered for delivery: a
    // repeat of an already-recorded run returns an empty list, so re-processing the
    // same run is not a second chance to email it.
    trackEmailDelivery(emailDispatch.dispatchCreated(saved.value));
  };

  /**
   * The same treatment for one scheduler execution the scheduler has just
   * persisted in a state worth telling someone about (skipped, cancelled,
   * missing project, failed, interrupted).
   */
  const recordScheduleExecutionNotifications = (execution: ScheduledExecution, runId: string | null): void => {
    const project = projects.get(execution.projectId);
    if (!project) return;
    const saved = notifications.record(deriveScheduleExecutionEvents(project, execution, runId), execution.completedAt ?? execution.scheduledFor);
    if (!saved.ok) { console.error(`  notifications: ${saved.error}`); return; }
    // A scheduler-produced notification takes the same path as a run-produced one,
    // so SCHEDULE_SKIPPED is delivered by the same rules with no scheduler code.
    trackEmailDelivery(emailDispatch.dispatchCreated(saved.value));
  };

  // Declared first because the run manager's settle hook needs it; the run
  // manager is created immediately below, so no run can settle before then.
  let scheduler: Scheduler;
  const runManager = new RunManager({
    projectRoot,
    runsDir,
    historyDir,
    spawnImpl: options.spawnImpl,
    maxConcurrentRuns: parseMaxConcurrentRuns(options.maxConcurrentRuns ?? process.env.QA_MAX_CONCURRENT_RUNS),
    onRunStarted: run => {
      const project = run.projectId ? projects.get(run.projectId) : null;
      if (project) projects.runStarted(project, run);
    },
    onRunSettled: (run, analysis) => {
      // Project bookkeeping first, then the schedule, so a scheduled run
      // reaches the same state a manual one does before its history is written.
      projects.runSettled(run, analysis);
      scheduler.onRunSettled(run, analysis);
      // Notifications last: they are derived entirely from the records those two
      // steps just wrote, so no event can ever precede the evidence for it.
      recordRunNotifications(run.projectId, run.runId);
    },
  });

  scheduler = new Scheduler({
    schedules,
    runManager,
    projects: { get: id => projects.get(id) },
    now: options.now,
    tickMs: options.scheduleTickMs,
    proveRunCompleted: artifactProof(runsDir),
    onLog: message => console.log(`  scheduler: ${message}`),
    onExecutionRecorded: (execution, runId) => recordScheduleExecutionNotifications(execution, runId),
  });

  // Read once: the QA console is served at "/" and is also the document behind
  // the /projects routes, which only change which view the page renders.
  const appHtml = existsSync(appPath)
    ? readFileSync(appPath, "utf8")
    : "<!doctype html><title>AI Website QA</title><p>QA application page not found.</p>";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const pathname = (req.url ?? "/").split("?")[0]!;
      if (pathname === "/" || pathname === "/index.html") {
        return send(res, 200, "text/html; charset=utf-8", appHtml);
      }
      if (pathname === "/dashboard") {
        const html = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : "<!doctype html><title>AI Website QA</title><p>Dashboard page not found.</p>";
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      if (pathname === "/health") return sendJson(res, 200, { ok: true, service: "ai-website-qa" });
      if (pathname === "/favicon.ico") return send(res, 204, "text/plain", "");

      // --- Projects -------------------------------------------------------
      // The organizational layer above runs. Every value it returns is either
      // saved metadata or a number read back from a real report artifact.
      if (pathname === "/api/projects" && req.method === "POST") {
        readJsonBody(req).then(
          body => {
            const result = projects.create((body && typeof body === "object" ? body : {}) as { name?: unknown; url?: unknown });
            if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
            return sendJson(res, 201, { ok: true, project: result.value });
          },
          () => sendJson(res, 400, { ok: false, error: "request body must be JSON" }),
        );
        return;
      }
      if (pathname === "/api/projects" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, projects: projects.list() });
      }

      // --- Project email settings -------------------------------------------
      // Configuration only. This endpoint stores WHO a project emails and WHICH
      // events it emails about; it never sends anything, and nothing in the run
      // or notification path reads it to trigger a send. That call is left
      // explicit for a later milestone.
      const emailSettingsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/email-settings$/);
      if (emailSettingsMatch) {
        const projectId = emailSettingsMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });

        if (req.method === "GET") {
          const project = projects.get(projectId);
          if (!project) return sendJson(res, 404, { ok: false, error: "That project does not exist." });
          // Readiness reports a boolean and the NAMES of missing variables only.
          // The host, from-address, user and password never appear in this
          // response, so no settings screen can leak a credential.
          const readiness = emailReadiness();
          return sendJson(res, 200, {
            ok: true,
            projectId: project.id,
            settings: emailPreferencesOf(project),
            emailConfigured: readiness.configured,
            missingSmtpVariables: readiness.missing,
            // The canonical event list, so the browser renders these options
            // rather than keeping a second taxonomy of its own.
            eventOptions: emailEventOptions(),
          });
        }

        if (req.method === "PUT") {
          readJsonBody(req).then(
            body => {
              // The whole payload is validated before a single field is stored, so
              // a rejected update cannot leave the project half-configured.
              const parsed = parseEmailPreferences(body);
              if (!parsed.ok) {
                const summary = parsed.errors[0]?.message ?? "Those email settings are not valid.";
                return sendJson(res, 400, { ok: false, error: summary, errors: parsed.errors });
              }
              const result = projects.setEmailPreferences(projectId, parsed.value);
              if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
              const readiness = emailReadiness();
              return sendJson(res, 200, {
                ok: true,
                projectId: result.value.id,
                settings: emailPreferencesOf(result.value),
                emailConfigured: readiness.configured,
                missingSmtpVariables: readiness.missing,
                eventOptions: emailEventOptions(),
              });
            },
            () => sendJson(res, 400, { ok: false, error: "request body must be JSON" }),
          );
          return;
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }

      // --- Test email --------------------------------------------------------
      // A DELIVERY TEST, not a QA event. It reaches the mail server through the
      // same transport a real alert uses, but it creates no notification record,
      // writes no delivery history, and touches no run, finding or schedule. The
      // only durable effect of pressing this button is the mail itself.
      const emailTestMatch = pathname.match(/^\/api\/projects\/([^/]+)\/email-settings\/test$/);
      if (emailTestMatch) {
        const projectId = emailTestMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

        const project = projects.get(projectId);
        if (!project) return sendJson(res, 404, { ok: false, error: "That project does not exist." });

        const settings = emailPreferencesOf(project);
        if (!settings.enabled) {
          return sendJson(res, 400, {
            ok: false,
            code: "EMAIL_DISABLED",
            error: "Email notifications are turned off for this project. Turn them on and save before sending a test email.",
          });
        }
        if (!settings.recipients.length) {
          return sendJson(res, 400, {
            ok: false,
            code: "NO_RECIPIENTS",
            error: "Add at least one recipient before sending a test email.",
          });
        }

        // Decided before any send: with no SMTP configuration there is nothing to
        // try, and the answer is reported without opening a socket.
        const readiness = emailReadiness();
        if (!readiness.configured) {
          return sendJson(res, 400, {
            ok: false,
            code: "EMAIL_NOT_CONFIGURED",
            error: "Email could not be sent because SMTP is not configured.",
            missingSmtpVariables: readiness.missing,
          });
        }

        // Only explicitly configured recipients, each mailed once.
        const message = renderTestEmailMessage(project, settings.recipients, dashboardUrl);
        (async () => {
          const results: Array<{ recipient: string; status: string }> = [];
          for (const recipient of settings.recipients) {
            const outcome = await emailTransport.sendTestMessage(message, recipient);
            results.push({ recipient, status: outcome.status });
          }
          const sent = results.filter(entry => entry.status === "SENT").length;
          if (sent === results.length) {
            sendJson(res, 200, {
              ok: true,
              code: "EMAIL_SENT",
              message: "Email sent successfully.",
              sent,
              recipients: settings.recipients,
              results,
            });
            return;
          }
          // The raw SMTP error is deliberately not returned: an authentication or
          // TLS message can name the account and the server. The user gets one
          // actionable sentence and nothing that identifies the deployment.
          sendJson(res, 502, {
            ok: false,
            code: "EMAIL_SEND_FAILED",
            error: "Email could not be sent. Check the email configuration and try again.",
            sent,
            results,
          });
        })().catch(() => {
          // A transport that throws instead of returning a failure must still not
          // take the dashboard down, and must not leak whatever it threw.
          sendJson(res, 502, {
            ok: false,
            code: "EMAIL_SEND_FAILED",
            error: "Email could not be sent. Check the email configuration and try again.",
          });
        });
        return;
      }

      // --- In-app notifications ---------------------------------------------
      // One persisted inbox of real QA events. Every entry was derived by the
      // shared event derivation from records the engine actually wrote, and every
      // id is a hash of its own dedup key, so re-processing a run cannot
      // duplicate anything.
      const notificationListQuery = (req: IncomingMessage, projectId?: string): { projectId?: string | null; unreadOnly?: boolean; limit?: number | null } => {
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        const rawLimit = q.get("limit");
        const parsed = rawLimit === null ? Number.NaN : Number.parseInt(rawLimit, 10);
        // The global route honours ?projectId. The project-scoped route overrides
        // this with its own project id, so a project route can never be widened.
        const requestedProject = q.get("projectId") ?? projectId;
        return {
          projectId: requestedProject === null || requestedProject === "" ? null : requestedProject,
          unreadOnly: q.get("unread") === "true",
          limit: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
        };
      };
      if (pathname === "/api/notifications" && req.method === "GET") {
        // Exactly the agreed shape, and nothing else: no server-side paths and no
        // derived fields the browser would have to guess at.
        return sendJson(res, 200, { ok: true, ...notifications.list(notificationListQuery(req)) });
      }
      if (pathname === "/api/notifications/unread-count") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { ok: true, count: notifications.unreadCount() });
      }
      if (pathname === "/api/notifications/read-all") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const result = notifications.markAllRead();
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        return sendJson(res, 200, { ok: true, updated: result.value.updated, unreadCount: notifications.unreadCount() });
      }
      const notificationReadMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (notificationReadMatch) {
        const id = notificationReadMatch[1]!;
        if (!RUN_ID_PATTERN.test(id)) return sendJson(res, 400, { ok: false, error: "invalid notification id" });
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        // Idempotent by contract: marking an already-read notification succeeds
        // and changes nothing, so a double click is harmless.
        const result = notifications.markRead(id);
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        return sendJson(res, 200, {
          ok: true,
          notification: result.value.notification,
          changed: result.value.changed,
          unreadCount: notifications.unreadCount(),
        });
      }
      const projectNotificationsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/notifications$/);
      if (projectNotificationsMatch) {
        const projectId = projectNotificationsMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const project = projects.get(projectId);
        if (!project) return sendJson(res, 404, { ok: false, error: "That project does not exist." });
        const list = notifications.list({ ...notificationListQuery(req), projectId: project.id });
        return sendJson(res, 200, { ok: true, projectId: project.id, ...list });
      }

      // Read-only delivery history for one notification. Delivery is recorded by
      // the dispatcher, not derived here: this route never creates an attempt and
      // never delivers anything. It reports only the attempts already persisted,
      // and it says nothing a caller could use to reach a credential, because no
      // credential is ever accepted or stored.
      const notificationDeliveriesMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/deliveries$/);
      if (notificationDeliveriesMatch) {
        const notificationId = notificationDeliveriesMatch[1]!;
        if (!RUN_ID_PATTERN.test(notificationId)) return sendJson(res, 400, { ok: false, error: "invalid notification id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        // The inbox is the authority on whether a notification exists: reporting a
        // delivery history for something that was never recorded would invent one.
        if (!notifications.get(notificationId)) {
          return sendJson(res, 404, { ok: false, error: "That notification does not exist." });
        }
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        const requestedChannel = q.get("channel");
        if (requestedChannel !== null && !isNotificationChannel(requestedChannel)) {
          return sendJson(res, 400, { ok: false, error: "invalid channel" });
        }
        const requestedStatus = q.get("status");
        if (requestedStatus !== null && !isDeliveryStatus(requestedStatus)) {
          return sendJson(res, 400, { ok: false, error: "invalid status" });
        }
        const list = notificationDeliveries.list({
          notificationId,
          channel: requestedChannel as NotificationChannel | null,
          recipient: q.get("recipient"),
          status: requestedStatus as DeliveryStatus | null,
        });
        return sendJson(res, 200, { ok: true, notificationId, ...list });
      }

      // --- QA schedules ----------------------------------------------------
      // One schedule per project. Every value here comes from the persisted
      // schedule document or from a real run that actually happened.
      if (pathname === "/api/schedules" && req.method === "GET") {
        const all = schedules.list().map(schedule => {
          const project = projects.get(schedule.projectId);
          return {
            ...schedule,
            frequencyLabel: frequencyLabel(schedule.frequency),
            projectName: project?.name ?? null,
            projectUrl: project?.url ?? null,
            projectMissing: project === null,
            upcoming: schedules.upcoming().filter(entry => entry.scheduleId === schedule.id)[0] ?? null,
          };
        });
        return sendJson(res, 200, {
          ok: true,
          schedules: all,
          upcoming: schedules.upcoming(),
          // A count, not a health verdict: the UI states the fact and no more.
          projectMissingCount: all.filter((entry: { projectMissing: boolean }) => entry.projectMissing).length,
          frequencies: SCHEDULE_FREQUENCIES.map(value => ({ value, label: frequencyLabel(value) })),
        });
      }
      const scheduleHistoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/schedule\/history$/);
      if (scheduleHistoryMatch) {
        const projectId = scheduleHistoryMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const schedule = schedules.get(projectId);
        if (!schedule) return sendJson(res, 404, { ok: false, error: "This project has no QA schedule." });
        // Newest first, and only real records: nothing is backfilled for slots
        // that never ran.
        return sendJson(res, 200, { ok: true, scheduleId: schedule.id, executions: schedules.executionsFor(schedule.id) });
      }
      const scheduleSubMatch = pathname.match(/^\/api\/projects\/([^/]+)\/schedule\/(enable|disable|run-now)$/);
      if (scheduleSubMatch) {
        const projectId = scheduleSubMatch[1]!;
        const action = scheduleSubMatch[2]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        // A schedule can only exist for a real project.
        if (!projects.get(projectId)) return sendJson(res, 404, { ok: false, error: "That project does not exist." });
        if (action === "run-now") {
          const triggered = scheduler.triggerNow(projectId);
          if (!triggered.ok) return sendJson(res, triggered.status, { ok: false, error: triggered.error });
          return sendJson(res, 200, { ok: true, execution: triggered.value });
        }
        const result = schedules.setEnabled(projectId, action === "enable");
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        return sendJson(res, 200, { ok: true, schedule: result.value });
      }
      const scheduleMatch = pathname.match(/^\/api\/projects\/([^/]+)\/schedule$/);
      if (scheduleMatch) {
        const projectId = scheduleMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });
        if (!projects.get(projectId)) return sendJson(res, 404, { ok: false, error: "That project does not exist." });
        if (req.method === "GET") {
          const schedule = schedules.get(projectId);
          // No schedule yet is a real, non-error answer: the UI offers to create one.
          return sendJson(res, 200, {
            ok: true,
            schedule: schedule ? { ...schedule, frequencyLabel: frequencyLabel(schedule.frequency) } : null,
          });
        }
        if (req.method === "PUT") {
          return readJsonBody(req).then(
            body => {
              const result = schedules.upsert(projectId, (body && typeof body === "object" ? body : {}) as { enabled?: unknown; frequency?: unknown; timezone?: unknown });
              if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
              return sendJson(res, 200, { ok: true, schedule: { ...result.value, frequencyLabel: frequencyLabel(result.value.frequency) } });
            },
            () => sendJson(res, 400, { ok: false, error: "request body must be JSON" }),
          );
          return;
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const projectChangeSummaryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/change-summary$/);
      if (projectChangeSummaryMatch) {
        const projectId = projectChangeSummaryMatch[1]!;
        const runId = projectChangeSummaryMatch[2]!;
        if (!RUN_ID_PATTERN.test(projectId) || !RUN_ID_PATTERN.test(runId)) return sendJson(res, 400, { ok: false, error: "invalid project or run id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const result = projects.changeSummary(projectId, runId);
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        return sendJson(res, 200, { ok: true, changeSummary: result.value });
      }
      const projectComparisonMatch = pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/comparison$/);
      if (projectComparisonMatch) {
        const projectId = projectComparisonMatch[1]!;
        const runId = projectComparisonMatch[2]!;
        if (!RUN_ID_PATTERN.test(projectId) || !RUN_ID_PATTERN.test(runId)) return sendJson(res, 400, { ok: false, error: "invalid project or run id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const result = projects.runComparison(projectId, runId);
        if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
        return sendJson(res, 200, { ok: true, ...result.value });
      }
      // TEMPORARY: notification preview. A read-only answer to "which
      // notifications would this run generate?". It stores nothing and has no UI,
      // but it calls the very same event derivation that production notification
      // generation uses, so it stays a trustworthy debugging tool.
      const notificationPreviewMatch = pathname.match(/^\/api\/projects\/([^/]+)\/notification-preview\/([^/]+)$/);
      if (notificationPreviewMatch) {
        const projectId = notificationPreviewMatch[1]!;
        const runId = notificationPreviewMatch[2]!;
        if (!RUN_ID_PATTERN.test(projectId) || !RUN_ID_PATTERN.test(runId)) return sendJson(res, 400, { ok: false, error: "invalid project or run id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const project = projects.get(projectId);
        if (!project) return sendJson(res, 404, { ok: false, error: "That project does not exist." });
        // A run that is not one of this project's runs is refused rather than
        // associated with the project by guesswork.
        const run = projects.history(project.id).find(entry => entry.runId === runId);
        if (!run) return sendJson(res, 404, { ok: false, error: "That run does not belong to this project." });
        const comparison = projects.runComparison(project.id, run.runId);
        const changes = projects.changeSummary(project.id, run.runId);
        return sendJson(res, 200, {
          ok: true,
          notificationPreview: buildNotificationPreview({
            project,
            run,
            analysis: run.hasResult ? readRunAnalysis(run.runId) : null,
            snapshot: projects.findingSnapshot(run.runId),
            comparison: comparison.ok ? comparison.value.comparison : null,
            changeSummary: changes.ok ? changes.value : null,
            executions: schedules.executionsFor(project.id),
          }),
        });
      }
      const projectFindingHistoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/findings\/([^/]+)\/history$/);
      if (projectFindingHistoryMatch) {
        const projectId = projectFindingHistoryMatch[1]!;
        const findingId = projectFindingHistoryMatch[2]!;
        if (!RUN_ID_PATTERN.test(projectId) || !RUN_ID_PATTERN.test(findingId)) return sendJson(res, 400, { ok: false, error: "invalid project or finding id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const detail = projects.findingDetail(projectId, findingId);
        if (!detail.ok) return sendJson(res, detail.status, { ok: false, error: detail.error });
        // Chronological, oldest first. Only recorded runs appear; nothing is
        // invented to fill a gap.
        return sendJson(res, 200, { ok: true, findingId: detail.value.finding.id, events: detail.value.events });
      }
      const projectFindingMatch = pathname.match(/^\/api\/projects\/([^/]+)\/findings\/([^/]+)$/);
      if (projectFindingMatch) {
        const projectId = projectFindingMatch[1]!;
        const findingId = projectFindingMatch[2]!;
        if (!RUN_ID_PATTERN.test(projectId) || !RUN_ID_PATTERN.test(findingId)) return sendJson(res, 400, { ok: false, error: "invalid project or finding id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const detail = projects.findingDetail(projectId, findingId);
        if (!detail.ok) return sendJson(res, detail.status, { ok: false, error: detail.error });
        const { finding, events, relatedRuns } = detail.value;
        return sendJson(res, 200, {
          ok: true,
          finding,
          lifecycleStatus: finding.status,
          firstSeen: { runId: finding.firstSeenRunId, at: finding.firstSeenAt },
          lastSeen: { runId: finding.lastSeenRunId, at: finding.lastSeenAt },
          occurrenceCount: finding.occurrenceCount,
          firstSeenRunId: finding.firstSeenRunId,
          lastSeenRunId: finding.lastSeenRunId,
          relatedRuns,
          history: events,
          // Evidence stays where it already lives: the run-local finding id
          // links straight into the existing finding detail endpoint.
          evidenceReferences: { runFindingId: events.filter(event => event.observed && event.runFindingId).at(-1)?.runFindingId ?? null, runId: finding.lastSeenRunId },
        });
      }
      const projectFindingsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/findings$/);
      if (projectFindingsMatch) {
        const projectId = projectFindingsMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { ok: false, error: "invalid project id" });
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const project = projects.get(projectId);
        if (!project) return sendJson(res, 404, { ok: false, error: `project ${projectId} not found` });
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        const filtered = projects.findingsFiltered(projectId, {
          status: q.get("status"),
          severity: q.get("severity"),
          search: q.get("search"),
        });
        // Descriptive measurements grouped for the UI, never a score or ranking.
        const all = projects.findings(projectId);
        const byStatus = { NEW: 0, ACTIVE: 0, REGRESSED: 0, RESOLVED: 0 } as Record<string, number>;
        for (const finding of all) byStatus[finding.status] = (byStatus[finding.status] ?? 0) + 1;
        return sendJson(res, 200, {
          ok: true,
          projectId: project.id,
          findings: filtered,
          total: filtered.length,
          trackedTotal: all.length,
          countsByStatus: byStatus,
          filters: { status: q.get("status"), severity: q.get("severity"), search: q.get("search") },
        });
      }
      const projectRunMatch = pathname.match(/^\/api\/projects\/([^/]+)\/runs$/);
      if (projectRunMatch) {
        const projectId = projectRunMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { error: "invalid project id" });
        if (req.method === "GET") {
          const project = projects.get(projectId);
          if (!project) return sendJson(res, 404, { error: `project ${projectId} not found` });
          return sendJson(res, 200, { ok: true, runs: projects.history(project.id) });
        }
        if (req.method === "POST") {
          // Delegates straight to the real QA pipeline via RunManager; there is
          // no second engine here.
          const project = projects.get(projectId);
          if (!project) return sendJson(res, 404, { error: `project ${projectId} not found` });
          const result = runManager.start(project.url, project.id);
          if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
          return sendJson(res, 202, { ok: true, run: result.run, projectId: project.id });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const projectId = projectMatch[1]!;
        if (!RUN_ID_PATTERN.test(projectId)) return sendJson(res, 400, { error: "invalid project id" });
        if (req.method === "GET") {
          const result = projects.detail(projectId);
          if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
          // `changes` carries the compact recorded comparison for each settled
          // run, which is what the run history's Pages/Flows columns and the
          // Latest Changes section are drawn from.
          return sendJson(res, 200, {
            ok: true,
            project: result.value.project,
            runs: result.value.runs,
            findings: result.value.findings,
            changes: result.value.changes,
          });
        }
        if (req.method === "PATCH" || req.method === "PUT") {
          readJsonBody(req).then(
            body => {
              const result = projects.update(projectId, (body && typeof body === "object" ? body : {}) as { name?: unknown; url?: unknown });
              if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
              return sendJson(res, 200, { ok: true, project: result.value });
            },
            () => sendJson(res, 400, { ok: false, error: "request body must be JSON" }),
          );
          return;
        }
        if (req.method === "DELETE") {
          const result = projects.remove(projectId);
          if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
          return sendJson(res, 200, { ok: true, deleted: result.value.id, note: "QA run artifacts and engine history were not touched." });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      // Client-side routes for the Projects UI. Every one of them is the same
      // single-page console; the path only picks the view it renders on load.
      if (req.method === "GET" && (pathname === "/projects" || pathname === "/projects/" || /^\/projects\/[^/]+\/?$/.test(pathname))) {
        return send(res, 200, "text/html; charset=utf-8", appHtml);
      }
      if (req.method === "GET" && (pathname === "/schedules" || pathname === "/schedules/")) {
        return send(res, 200, "text/html; charset=utf-8", appHtml);
      }
      // The stage tracker renders this order, so the UI and the engine cannot
      // disagree about what ran when.
      if (pathname === "/api/qa/stages" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, stages: RUN_STAGES });
      }

      if (pathname === "/api/qa/run" && req.method === "POST") {
        readJsonBody(req).then(
          body => {
            const result = runManager.start(body && typeof body === "object" ? (body as { url?: unknown }).url : undefined);
            if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
            return sendJson(res, 202, { ok: true, run: result.run });
          },
          () => sendJson(res, 400, { ok: false, error: "request body must be JSON" }),
        );
        return;
      }
      if (pathname === "/api/qa/runs") {
        return sendJson(res, 200, { ok: true, runs: runManager.list(), active: runManager.activeRun(), activeRuns: runManager.activeRuns() });
      }
      const qaRunMatch = pathname.match(/^\/api\/qa\/runs\/([^/]+)(?:\/(results|report\.html|report|execution|findings(?:\/[^/]+)?))?$/);
      if (qaRunMatch) {
        const runId = qaRunMatch[1]!;
        if (!RUN_ID_PATTERN.test(runId)) return sendJson(res, 400, { error: "invalid run id" });
        const run = runManager.get(runId);
        if (!run) return sendJson(res, 404, { error: `run ${runId} not found` });
        const which = qaRunMatch[2];
        // The productized results view: one bounded, shape-stable view model of
        // the run's OWN report. Never synthesized, never re-analyzed.
        if (which === "results") {
          const report = readRunReport(run);
          if (report.kind === "missing") return sendJson(res, 404, { error: "no report artifact for this run yet" });
          if (report.kind === "malformed") return sendJson(res, 500, { error: "this run's report artifact could not be read" });
          // The Results Experience is the run's OWN report, unchanged. The
          // Findings Changes section is ADDITIVE and only ever present when this
          // run belongs to a project that recorded a real comparison. A
          // standalone run gets no comparison block at all — nothing invented.
          const changes = run.projectId ? projects.runComparison(run.projectId, run.runId) : null;
          const body: Record<string, unknown> = {
            ok: true,
            results: buildResultsView(report.analysis, { runId: run.runId, executionAvailable: Boolean(run.artifacts.executionJson && existsSync(run.artifacts.executionJson)) }),
            projectId: run.projectId ?? null,
          };
          body.findingsChanges = changes && changes.ok && changes.value.comparison.comparisonAvailable ? changes.value.comparison : null;
          // "What Changed" is likewise additive and project-only. It carries its
          // own availability, so even a standalone run's absence of it is never
          // mistaken for "nothing changed".
          const change = run.projectId ? projects.changeSummary(run.projectId, run.runId) : null;
          body.whatChanged = change && change.ok ? change.value : null;
          return sendJson(res, 200, body);
        }
        // Bounded finding views for the run's own report, reusing the canonical
        // evidence helpers so the results screen and the evidence explorer can
        // never disagree about a finding.
        if (which === "findings" || (which && which.startsWith("findings/"))) {
          const report = readRunReport(run);
          if (report.kind === "missing") return sendJson(res, 404, { error: "no report artifact for this run yet" });
          if (report.kind === "malformed") return sendJson(res, 500, { error: "this run's report artifact could not be read" });
          const artifact: RunArtifact = { kind: "report", analysis: report.analysis };
          const findingId = which.length > "findings/".length ? decodeURIComponent(which.slice("findings/".length)) : undefined;
          if (findingId !== undefined && !RUN_ID_PATTERN.test(findingId)) return sendJson(res, 400, { error: "invalid finding id" });
          if (findingId !== undefined) {
            const detail = findingDetail(artifact, findingId);
            if (!detail.ok) return sendJson(res, 404, { error: detail.error });
            return sendJson(res, 200, detail);
          }
          return sendJson(res, 200, listFindings(artifact));
        }
        if (which === "report") {
          if (!existsSync(run.artifacts.reportJson)) return sendJson(res, 404, { error: "no report artifact for this run yet" });
          return send(res, 200, "application/json; charset=utf-8", readFileSync(run.artifacts.reportJson));
        }
        if (which === "report.html") {
          if (!existsSync(run.artifacts.reportHtml)) return sendJson(res, 404, { error: "no HTML report for this run yet" });
          return send(res, 200, "text/html; charset=utf-8", readFileSync(run.artifacts.reportHtml));
        }
        if (which === "execution") {
          const path = run.artifacts.executionJson;
          if (!path || !existsSync(path)) return sendJson(res, 404, { error: "this run produced no execution evidence (no verification was executed)" });
          return send(res, 200, "application/json; charset=utf-8", readFileSync(path));
        }
        return sendJson(res, 200, { ok: true, run });
      }
      if (pathname === "/report.html" || pathname === "/qa-analysis.html") {
        if (!existsSync(htmlReport)) return sendJson(res, 404, { error: "no HTML report has been generated yet" });
        return send(res, 200, "text/html; charset=utf-8", readFileSync(htmlReport));
      }
      if (pathname === "/api/report") {
        if (!existsSync(jsonReport)) return sendJson(res, 404, { error: "no QA analysis report yet — run `npm run qa` first" });
        return send(res, 200, "application/json; charset=utf-8", readFileSync(jsonReport));
      }
      if (pathname === "/api/history") {
        const indexPath = join(historyDir, "index.json");
        if (!existsSync(indexPath)) return sendJson(res, 200, { schemaVersion: 1, sites: [] });
        return send(res, 200, "application/json; charset=utf-8", readFileSync(indexPath));
      }
      const evidenceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/findings(?:\/([^/]+))?$/);
      if (evidenceMatch) {
        const runId = evidenceMatch[1]!;
        const findingId = evidenceMatch[2];
        if (!RUN_ID_PATTERN.test(runId)) return sendJson(res, 400, { error: "invalid run id" });
        if (findingId !== undefined && !RUN_ID_PATTERN.test(findingId)) return sendJson(res, 400, { error: "invalid finding id" });
        const artifact = resolveRunArtifact(runId, jsonReport, historyDir);
        if (!artifact) return sendJson(res, 404, { error: `run ${runId} not found` });
        if (findingId !== undefined) {
          const detail = findingDetail(artifact, findingId);
          if (!detail.ok) return sendJson(res, 404, { error: detail.error });
          return sendJson(res, 200, detail);
        }
        const params = new URL(req.url ?? "/", "http://localhost");
        return sendJson(res, 200, listFindings(artifact, {
          q: params.searchParams.get("q") ?? undefined,
          severity: params.searchParams.get("severity") ?? undefined,
          status: params.searchParams.get("status") ?? undefined,
          domain: params.searchParams.get("domain") ?? undefined,
          code: params.searchParams.get("code") ?? undefined,
        }));
      }
      if (pathname.startsWith("/api/runs/")) {
        const runId = pathname.slice("/api/runs/".length);
        if (!RUN_ID_PATTERN.test(runId)) return sendJson(res, 400, { error: "invalid run id" });
        const artifactPath = join(historyDir, "runs", `${runId}.json`);
        if (!existsSync(artifactPath)) return sendJson(res, 404, { error: `run ${runId} not found` });
        return send(res, 200, "application/json; charset=utf-8", readFileSync(artifactPath));
      }
      if (pathname === "/api/state") {
        const current = readCurrentReport(jsonReport);
        if (current.kind === "malformed") {
          return sendJson(res, 500, { error: "report artifact is malformed" });
        }
        const report = current.kind === "ok" ? (current.report as QaAnalysis) : null;
        const baselineVerification = baselineVerificationOf(report, baselineMaxAgeMs);
        const baselineTrusted = !baselineVerification || baselineVerification.ok;
        const gate = evaluateGate(
          { regression: baselineTrusted ? report?.regression ?? null : null, findings: report?.findings ?? [] },
          { minSeverity: gateMinSeverityOf(report) },
        );
        const indexPath = join(historyDir, "index.json");
        const history = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { schemaVersion: 1, sites: [] };
        return sendJson(res, 200, {
          ok: report !== null,
          report,
          history,
          gate,
          baselineVerification,
          baselineMaxAge: options.baselineMaxAge ?? null,
          artifacts: {
            reportJson: jsonReport,
            reportHtml: htmlReport,
            historyDir,
          },
        });
      }
      return sendJson(res, 404, { error: `not found: ${pathname}` });
    } catch (error) {
      console.error("Dashboard request failed:", error);
      return sendJson(res, 500, { error: "internal error" });
    }
  });

  // Started once the listener is bound, so a scheduled run can never race the
  // server it dispatches through.
  const startScheduler = options.scheduleEnabled !== false;

  return new Promise<DashboardServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const livePort = (server.address() as { port: number }).port;
      // Now that the real port is known, outgoing mail can link back to this
      // dashboard. A wildcard bind is reported as localhost, which is what a
      // recipient could actually open.
      dashboardUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${livePort}`;
      // Recovery always runs. Only the background timer is optional, so starting a
    // server with the scheduler "off" still reconciles its document.
    const recovery = scheduler.start({ timer: startScheduler });
    if (recovery.interrupted.length) {
        console.log(`  scheduler: ${recovery.interrupted.length} interrupted scheduled run(s) recorded.`);
      }
      // Shutdown never leaves a timer or an engine process behind.
      const stopAll = (): void => {
        scheduler.stop();
        runManager.stop();
      };
      server.once("close", stopAll);
      process.once("SIGINT", stopAll);
      process.once("SIGTERM", stopAll);
      resolve({
        server,
        host,
        port: livePort,
        url: `http://${host}:${livePort}`,
        scheduler,
        schedules,
        notifications,
        notificationDeliveries,
        emailDeliveryDispatcher,
        settleEmailDeliveries,
      });
    });
  });
}

/** Starts the dashboard and blocks until the process stops. */
export async function serveUntilClosed(options: DashboardOptions): Promise<void> {
  const { url } = await startDashboard(options);
  console.log(`QA dashboard: ${url}`);
  console.log(`  report:   ${resolve(options.reportDir)}`);
  console.log(`  history:  ${resolve(options.historyDir)}`);
  console.log(`  baseline rotation: ${options.baselineMaxAge ?? "off"}`);
  console.log("  Press Ctrl+C to stop.");
}