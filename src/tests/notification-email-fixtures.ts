// ---------------------------------------------------------------------------
// Shared fixtures for the Final Release Hardening suites.
//
// WHY THIS EXISTS
// The acceptance milestone asks the same question over and over: "a delivery
// problem must change nothing about QA". Answering it needs the same harness,
// the same transports and the same before/after comparison in six suites, so it
// lives here once rather than six times.
//
// WHAT IS REAL AND WHAT IS NOT
// Real: the dashboard server, the project, the run settled from a real report
// artifact, the notification store, the delivery dispatcher, the delivery store,
// and - wherever a case is about SMTP behaviour - the REAL NotificationEmailTransport
// driven through an injected SMTP client. Only the SMTP server itself and the
// project spawner are substituted. No test in these suites can reach a mail server
// or run a browser.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce, analysisWith, finding, waitFor } from "./notification-fixtures.js";
import { createHash } from "node:crypto";
import { fakeSpawner, postJson, send, start, stop } from "./notification-fixtures.js";
import type { DeliveryRequest, DeliveryResult, NotificationDelivery, NotificationDeliveryTransport } from "../dashboard/notification-delivery.js";
import { NotificationEmailTransport } from "../dashboard/email-transport.js";
import type { EmailConfig, SmtpClientFactory } from "../dashboard/email-transport.js";

export const ALICE = "alice@example.com";
export const BOB = "bob@example.com";
export const CAROL = "carol@example.com";

/** Every environment variable the transport and the test-email route read. */
export const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_FROM_NAME", "SMTP_SECURE", "SMTP_REJECT_UNAUTHORIZED"];

export const deliveriesOf = (dir: string): string => join(dir, "projects", "notification-deliveries.json");

/**
 * Reads the persisted delivery document.
 *
 * `existsSync` is not enough: when a write is deliberately broken the path is a
 * directory, and reading that must read as "no records" rather than throwing, so
 * a test can assert on what a broken store did *not* leave behind.
 */
export const readDeliveries = (dir: string): NotificationDelivery[] => {
  const path = deliveriesOf(dir);
  if (!existsSync(path) || !statSync(path).isFile()) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { deliveries?: NotificationDelivery[] }).deliveries ?? [];
};

export const readNotifications = (dir: string): any[] => {
  const path = join(dir, "projects", "notifications.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as any).notifications : [];
};

export const readProjectsDoc = (dir: string): any =>
  JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8"));

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Records every send and returns a fixed or computed outcome. Opens no socket. */
export const fakeTransport = (outcome: DeliveryResult | ((request: DeliveryRequest) => DeliveryResult) = { status: "SENT" }) => {
  const attempts: DeliveryRequest[] = [];
  return {
    attempts,
    transport: {
      channel: "EMAIL",
      send: async (request: DeliveryRequest): Promise<DeliveryResult> => {
        attempts.push(request);
        return typeof outcome === "function" ? outcome(request) : outcome;
      },
    } satisfies NotificationDeliveryTransport,
  };
};

/** Sends only to recipients NOT named, so per-recipient isolation is honest. */
export const failFor = (...recipients: string[]) =>
  fakeTransport(request =>
    recipients.includes(request.recipient)
      ? { status: "FAILED", error: `refused for ${request.recipient}` }
      : { status: "SENT", providerMessageId: "ok" });

/**
 * Outcome chosen by call count, so a "fails once, then works" retry can be driven
 * deterministically instead of by timing.
 */
export const scriptedTransport = (script: DeliveryResult[]) => {
  const attempts: DeliveryRequest[] = [];
  return {
    attempts,
    transport: {
      channel: "EMAIL",
      send: async (request: DeliveryRequest): Promise<DeliveryResult> => {
        attempts.push(request);
        return script[Math.min(attempts.length - 1, script.length - 1)]!;
      },
    } satisfies NotificationDeliveryTransport,
  };
};

/**
 * Outcome chosen per recipient, not per call.
 *
 * With several recipients on one notification, a call-count script couples the
 * outcome to whatever order the dispatcher happened to use, so "BOB fails" ends
 * up failing whoever was dialled first. Keying on the recipient keeps a
 * per-recipient claim honest.
 */
export const perRecipientTransport = (outcome: (request: DeliveryRequest, seen: number) => DeliveryResult) => {
  const attempts: DeliveryRequest[] = [];
  const calls = new Map<string, number>();
  return {
    attempts,
    transport: {
      channel: "EMAIL",
      send: async (request: DeliveryRequest): Promise<DeliveryResult> => {
        attempts.push(request);
        const seen = calls.get(request.recipient) ?? 0;
        calls.set(request.recipient, seen + 1);
        return outcome(request, seen);
      },
    } satisfies NotificationDeliveryTransport,
  };
};

/**
 * A transport that never answers.
 *
 * Stands in for a process that is killed mid-delivery: the notification exists
 * and the send has begun, but nothing is ever reported back. Waiting for it would
 * hang, which is exactly why the settle step has to be something a crash skips.
 */
export const hangingTransport = () => {
  const attempts: DeliveryRequest[] = [];
  return {
    attempts,
    transport: {
      channel: "EMAIL",
      send: (request: DeliveryRequest): Promise<DeliveryResult> => {
        attempts.push(request);
        return new Promise<DeliveryResult>(() => undefined);
      },
    } satisfies NotificationDeliveryTransport,
  };
};

/** A transport that throws instead of returning an outcome. */
export const throwingTransport = (error: unknown) => {
  const attempts: DeliveryRequest[] = [];
  return {
    attempts,
    transport: {
      channel: "EMAIL",
      send: async (request: DeliveryRequest): Promise<DeliveryResult> => {
        attempts.push(request);
        throw error;
      },
    } satisfies NotificationDeliveryTransport,
  };
};

/**
 * The REAL transport, with only the SMTP client replaced.
 *
 * Everything that decides SENT vs FAILED - configuration reading, the rejection
 * check, redaction, error bounding - is the production code path. `rejection` is the
 * raw response the fake client resolves with, including deliberately malformed
 * shapes, because "what does the transport do with a bad response?" is exactly the
 * question several acceptance cases ask.
 */
export const realTransportWith = (options: {
  env?: NodeJS.ProcessEnv;
  rejection?: unknown;
  throws?: unknown;
  dashboardUrl?: string | null;
  createClient?: SmtpClientFactory;
}) => {
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const createClient: SmtpClientFactory = options.createClient ?? (() => ({
    sendMail: async (message: { to: string; subject: string; text: string; html: string }) => {
      sent.push(message);
      if (options.throws !== undefined) throw options.throws;
      return options.rejection as any;
    },
  }));
  const env = options.env ?? {};
  return {
    sent,
    env,
    transport: new NotificationEmailTransport({
      env,
      createClient,
      ...(options.dashboardUrl !== undefined ? { dashboardUrl: options.dashboardUrl } : {}),
    }),
  };
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A transport, optionally wrapped with the recorder that produced it. */
export type TransportOption =
  | NotificationDeliveryTransport
  | { attempts: DeliveryRequest[]; transport: NotificationDeliveryTransport }
  | null;

export type HarnessOptions = {
  enabled?: boolean;
  recipients?: string[];
  events?: string[];
  /** Injected automatic transport. `null` means: use the real default transport. */
  transport?: TransportOption;
  /** Reuse an existing directory instead of creating one: this is a restart. */
  dir?: string;
  /** Overrides for projects already present in `dir`. */
  projectId?: string;
  /** Persist the email settings even when the project already has them. */
  skipConfigure?: boolean;
};

/**
 * A real dashboard with one real project.
 *
 * The project is created through the real API and its email settings through the
 * real PUT route, so eligibility is always decided from persisted preferences.
 */
export const harness = async (options: HarnessOptions = {}) => {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "m6-harden-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  const { spawnImpl, children } = fakeSpawner();
  const saved = new Map<string, string | undefined>();
  for (const key of SMTP_VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  const dashOptions: Record<string, unknown> = {
    // The test-email route keeps its own seam, so a test email can never be
    // confused with an automatic delivery.
    emailTransport: { sendTestMessage: async () => ({ status: "SENT", providerMessageId: "test@test" }) },
  };
  if (options.transport !== undefined && options.transport !== null) {
    dashOptions.emailDeliveryTransport =
      "transport" in options.transport ? options.transport.transport : options.transport;
  }

  const { dash, base } = await start(dir, spawnImpl, () => Date.now(), dashOptions);

  // A second run in the same dashboard spawns a second child, so the run index
  // has to advance. Tests that run twice in one harness would otherwise wait for
  // a child that already exists and time out.
  let runs = 0;

  let projectId = options.projectId ?? "";
  if (!projectId) {
    const created = await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" });
    if (created.status !== 201) throw new Error(`project creation failed: ${JSON.stringify(created.json)}`);
    projectId = created.json.project.id as string;
  }
  if (!options.skipConfigure) {
    const configured = await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
      enabled: options.enabled ?? true,
      recipients: options.recipients ?? [ALICE],
      events: options.events ?? ["NEW_FINDING", "SCHEDULE_SKIPPED"],
    });
    if (configured.status !== 200) throw new Error(`email settings rejected: ${JSON.stringify(configured.json)}`);
  }

  return {
    dir,
    base,
    dash,
    children,
    projectId,
    /** The recording array, when a recording transport was injected. */
    attempts: options.transport && "attempts" in options.transport ? options.transport.attempts : [],
    /** Delivers one real run carrying one real finding, then drains delivery. */
    runFinding: async (f: Record<string, unknown> = finding()) => {
      const runId = await runOnce(base, projectId, children, runs++, analysisWith([f]));
      await dash.settleEmailDeliveries();
      return runId;
    },
    /**
     * The same run WITHOUT draining delivery, so a test can observe the window
     * where the notification exists but delivery has not been settled - the state
     * a killed process leaves behind.
     */
    runFindingUnsettled: async (f: Record<string, unknown> = finding()) => {
      const runId = await runOnce(base, projectId, children, runs++, analysisWith([f]));
      // The QA run itself is finished and reported; only delivery is outstanding.
      await waitFor(async () => {
        const detail = await (await fetch(`${base}/api/projects/${projectId}`)).json();
        return ["COMPLETED", "FAILED"].includes(detail.runs?.[0]?.state);
      });
      return runId;
    },
    notifications: async (): Promise<any[]> => (await (await fetch(`${base}/api/notifications`)).json()).notifications,
    cleanup: onceOnly(async () => {
      await stop(dash);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }),
  };
};

/**
 * Makes a teardown safe to call more than once.
 *
 * Restart tests deliberately stop a dashboard in the middle of a scenario and
 * again in a `finally`, so "already stopped" is a normal outcome rather than a
 * test bug. Throwing there would mask the assertion a test actually cares about.
 */
const onceOnly = (fn: () => Promise<void>): (() => Promise<void>) => {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await fn();
  };
};

export type Harness = Awaited<ReturnType<typeof harness>>;

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

/**
 * Stops nothing and starts a second server over the SAME documents.
 *
 * This is what a restart is from the delivery layer's point of view: new store
 * instance, new dispatcher, new transport, no shared memory with the process that
 * ran before. The caller is responsible for having stopped the first server.
 */
export const restartOn = async (dir: string, projectId: string, transport?: NotificationDeliveryTransport) => {
  const { spawnImpl, children } = fakeSpawner();
  let runs = 0;
  const dashOptions: Record<string, unknown> = {
    emailTransport: { sendTestMessage: async () => ({ status: "SENT" }) },
  };
  if (transport) dashOptions.emailDeliveryTransport = transport;
  const { dash, base } = await start(dir, spawnImpl, () => Date.now(), dashOptions);
  return {
    dash,
    base,
    children,
    projectId,
    runFinding: async (f: Record<string, unknown> = finding()) => {
      const runId = await runOnce(base, projectId, children, runs++, analysisWith([f]));
      await dash.settleEmailDeliveries();
      return runId;
    },
    runFindingUnsettled: async (f: Record<string, unknown> = finding()) => {
      const runId = await runOnce(base, projectId, children, runs++, analysisWith([f]));
      await waitFor(async () => {
        const detail = await (await fetch(`${base}/api/projects/${projectId}`)).json();
        return ["COMPLETED", "FAILED"].includes(detail.runs?.[0]?.state);
      });
      return runId;
    },
    dir,
    attempts: [],
    notifications: async (): Promise<any[]> => (await (await fetch(`${base}/api/notifications`)).json()).notifications,
    cleanup: onceOnly(async () => { await stop(dash); }),
  };
};

/** A restarted harness has the same surface, so helpers work on either. */
export type RestartHarness = Awaited<ReturnType<typeof restartOn>>;

// ---------------------------------------------------------------------------
// The QA fingerprint
// ---------------------------------------------------------------------------

/**
 * Everything about a project's QA outcome, in a form that is identical across two
 * independent runs of the same scenario.
 *
 * Ids are deliberately excluded. Two harnesses have different project ids, run ids
 * and finding ids - they contain timestamps and ephemeral ports - so comparing them
 * would compare noise. Everything that decides a verdict is included: run state,
 * verdict, finding count, coverage, the finding ledger's own fields, the lifecycle
 * observations and the change-intelligence result with its run references removed.
 */
export type QaFingerprint = {
  runs: Array<{ state: string; status: string | null; findingsCount: number | null; coverageStatus: string | null }>;
  findings: Array<{ code: string; severity: string; status: string; domain: string; title: string }>;
  lifecycle: Array<{ status: string; observed: boolean }>;
  changes: unknown[];
};

const byCanonical = (values: unknown[]): unknown[] =>
  [...values].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));

export const qaFingerprint = (dir: string, projectId: string): QaFingerprint => {
  const doc = readProjectsDoc(dir);
  const mine = (rows: any[]) => rows.filter(row => row.projectId === projectId);
  return {
    runs: mine(doc.runs).map(run => ({
      state: run.state,
      status: run.status ?? null,
      findingsCount: run.findingsCount ?? null,
      coverageStatus: run.coverageStatus ?? null,
    })),
    findings: byCanonical(mine(doc.findings).map(f => ({
      code: f.code, severity: f.severity, status: f.status, domain: f.domain, title: f.title,
    }))) as QaFingerprint["findings"],
    // Lifecycle rows carry no projectId; they are linked to findings by id.
    lifecycle: byCanonical(mine(doc.findings).flatMap(f =>
      (doc.findingEvents ?? [])
        .filter((e: any) => e.findingId === f.id)
        .map((e: any) => ({ status: e.status, observed: e.observed === true })),
    )) as QaFingerprint["lifecycle"],
    changes: byCanonical(mine(doc.changeRecords).map(({ currentRunId: _c, previousRunId: _p, ...rest }: any) => rest)),
  };
};

// ---------------------------------------------------------------------------
// File fingerprints, for byte-level historical integrity
// ---------------------------------------------------------------------------

/** SHA-256 of a file's bytes, or null when the file does not exist. */
export const fileDigest = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

/** Digests of every file in a directory, keyed by relative path. */
export const digestTree = (root: string, names: readonly string[]): Map<string, string | null> => {
  const out = new Map<string, string | null>();
  for (const name of names) out.set(name, fileDigest(join(root, "projects", name)));
  return out;
};

export const digestDiff = (
  before: Map<string, string | null>,
  after: Map<string, string | null>,
): { changed: string[]; added: string[]; removed: string[]; unchanged: string[] } => {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const [name, digest] of before) {
    if (!after.has(name)) { removed.push(name); continue; }
    if (after.get(name) === digest) unchanged.push(name);
    else changed.push(name);
  }
  for (const name of after.keys()) if (!before.has(name)) added.push(name);
  return { changed, added, removed, unchanged };
};

// ---------------------------------------------------------------------------
// A delivery store whose writes fail, for the persistence-failure case
// ---------------------------------------------------------------------------

/**
 * Makes every write to the delivery document fail, without touching product code.
 *
 * A DIRECTORY is created where the document belongs: a rename onto a directory
 * fails on every platform, so the store's atomic write fails the way a full disk
 * or a read-only data directory would, without needing permissions.
 */
export const breakDeliveryWrites = (dir: string): void => {
  const path = deliveriesOf(dir);
  mkdirSync(path, { recursive: true });
};

/** Undoes `breakDeliveryWrites`, standing in for the disk becoming writable again. */
export const unbreakDeliveryWrites = (dir: string): void => {
  const path = deliveriesOf(dir);
  if (existsSync(path) && statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
};

export type { DeliveryRequest, DeliveryResult, NotificationDelivery, NotificationDeliveryTransport, EmailConfig, SmtpClientFactory };