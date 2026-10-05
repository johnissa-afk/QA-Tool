// ---------------------------------------------------------------------------
// The EMAIL channel transport.
//
// WHAT THIS IS
// One implementation of the Milestone 1 transport seam. It turns a notification
// that already exists in the inbox into a plain-text and an HTML email, hands it
// to SMTP, and reports what the server said. It has no opinion about WHICH
// notifications deserve an email: that decision belongs to a later milestone.
// Nothing here is automatic - an email is sent only when a caller asks the
// dispatcher to deliver one.
//
// ARCHITECTURE
//   NotificationDeliveryDispatcher (notification-delivery.ts: identity, retry,
//     idempotency)
//     -> NotificationEmailTransport (this file: render + send)
//       -> SMTP client (nodemailer, loaded only when a send is actually made)
//     -> DeliveryResult SENT | FAILED
//     -> NotificationDeliveryStore (records the attempt)
//
// CONFIGURATION IS ENVIRONMENT-ONLY AND IS A SECRET
// Configuration is read from SMTP_* variables and nowhere else. The resolved
// config holds the password in memory for the duration of one send and is never
// written to a file, returned from an API, put in a delivery record, or logged.
// Every error that leaves this module goes through the project's existing
// Redactor first, so a message from a server that echoed a credential cannot
// persist one. `EMAIL_NOT_CONFIGURED` is decided BEFORE any socket is opened, so
// an unconfigured deployment does not attempt a connection to find that out.
//
// FAILURE ISOLATION
// Every failure - refused connection, bad authentication, timeout, rejected
// recipient, missing configuration - becomes a FAILED delivery result. This
// module never throws to its caller, never touches QA state, and never creates a
// notification. A broken mail server cannot fail a QA run.
// ---------------------------------------------------------------------------
import { buildRedactor } from "../executor/redact.js";
import type { NotificationRecord } from "./notifications.js";
import type { DeliveryRequest, DeliveryResult, NotificationDeliveryTransport } from "./notification-delivery.js";

/** Reported when SMTP configuration is incomplete. Deterministic, pre-network. */
export const EMAIL_NOT_CONFIGURED = "EMAIL_NOT_CONFIGURED";

/**
 * Resolved SMTP configuration, held in memory only.
 *
 * `password` is deliberately typed as a separate field rather than folded into a
 * generic options bag: it is the one value here that must never be written
 * anywhere, and naming it makes that obvious at every use site.
 */
export type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  /** Null when the server needs no authentication. */
  user: string | null;
  /** Never persisted, never logged, never returned by any API. */
  password: string | null;
  from: string;
  fromName: string | null;
};

export type EmailConfigResult =
  | { ok: true; config: EmailConfig }
  | { ok: false; reason: typeof EMAIL_NOT_CONFIGURED; missing: string[] };

const DEFAULT_PORT = 587;
const DEFAULT_SECURE_PORT = 465;

const trimmed = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
};

const asBoolean = (value: string | null, fallback: boolean): boolean => {
  if (value === null) return fallback;
  const text = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
};

/**
 * Reads SMTP configuration from the environment.
 *
 * Missing values are REPORTED, never defaulted into a guess: a half-configured
 * pair (a user with no password) is treated as not configured rather than being
 * completed with an empty string, because an authentication attempt made with
 * invented credentials would fail in a way that looks like a server problem.
 */
export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfigResult {
  const host = trimmed(env.SMTP_HOST);
  const from = trimmed(env.SMTP_FROM);
  const user = trimmed(env.SMTP_USER);
  const password = trimmed(env.SMTP_PASSWORD);

  const missing: string[] = [];
  if (!host) missing.push("SMTP_HOST");
  if (!from) missing.push("SMTP_FROM");
  // Authentication is all-or-nothing: one half of a credential pair is a
  // misconfiguration, not an unauthenticated server.
  if (Boolean(user) !== Boolean(password)) {
    missing.push(user ? "SMTP_PASSWORD" : "SMTP_USER");
  }
  if (missing.length) return { ok: false, reason: EMAIL_NOT_CONFIGURED, missing };

  const rawPort = trimmed(env.SMTP_PORT);
  const parsedPort = rawPort === null ? Number.NaN : Number.parseInt(rawPort, 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;

  return {
    ok: true,
    config: {
      host: host!,
      port,
      // Implicit TLS on the submission port unless the deployment says otherwise.
      secure: asBoolean(trimmed(env.SMTP_SECURE), port === DEFAULT_SECURE_PORT),
      user,
      password,
      from: from!,
      fromName: trimmed(env.SMTP_FROM_NAME),
    },
  };
}

// ---------------------------------------------------------------------------
// Email content
// ---------------------------------------------------------------------------

/** One subject per existing notification type. No new events are introduced. */
const SUBJECTS: Record<NotificationRecord["type"], string> = {
  NEW_FINDING: "New finding",
  REGRESSED_FINDING: "Finding regressed",
  RESOLVED_FINDING: "Finding resolved",
  RUN_FAILED: "QA run failed",
  ACCESS_CHANGED: "Access changed",
  SCHEDULE_SKIPPED: "Scheduled run skipped",
  MEANINGFUL_CHANGE: "Meaningful QA change",
};

const FINDING_TYPES: readonly NotificationRecord["type"][] = ["NEW_FINDING", "REGRESSED_FINDING", "RESOLVED_FINDING"];

/**
 * A deterministic subject line.
 *
 * `AI Website QA` is a fixed prefix so a mail filter can route on it, and the
 * project name is the notification's own recorded name. The event word comes
 * from the existing type map, so an email can never describe an event the inbox
 * did not record.
 */
export function emailSubject(notification: NotificationRecord): string {
  return `[QA] ${SUBJECTS[notification.type]} — ${notification.projectName}`;
}

const htmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The dashboard link, using routes this app already serves.
 *
 * A finding opens on its project page, which is where the app already resolves
 * `?finding=`. Everything else opens that project's page. There is deliberately
 * no invented run deep link: the app reads no `run` query parameter, so emitting
 * one would produce a link that silently goes nowhere. When a notification
 * somehow carries no project, NO link is produced rather than a broken one.
 */
export function emailDashboardLink(notification: NotificationRecord, dashboardUrl: string | null): string | null {
  const base = trimmed(dashboardUrl);
  if (!base || !notification.projectId) return null;
  const project = `${base.replace(/\/+$/, "")}/projects/${encodeURIComponent(notification.projectId)}`;
  if (notification.findingId && FINDING_TYPES.includes(notification.type)) {
    return `${project}?finding=${encodeURIComponent(notification.findingId)}`;
  }
  return project;
}

/** The rendered message. Both bodies are pure functions of the notification. */
export type EmailMessage = {
  subject: string;
  text: string;
  html: string;
};

/**
 * Renders the deterministic plain-text and HTML bodies.
 *
 * Every line comes from a field the inbox actually recorded. A field the
 * notification does not have - a severity on a change summary, a finding on a
 * schedule skip - is OMITTED, never filled with a placeholder that would read as
 * a fact the QA run never produced.
 */
export function renderEmailMessage(notification: NotificationRecord, dashboardUrl: string | null): EmailMessage {
  const subject = emailSubject(notification);
  const link = emailDashboardLink(notification, dashboardUrl);

  const textLines: string[] = [
    subject,
    "",
    `Event: ${notification.type}`,
    `Project: ${notification.projectName}`,
  ];
  if (notification.severity) textLines.push(`Severity: ${notification.severity}`);
  if (notification.runId) textLines.push(`Run: ${notification.runId}`);
  if (notification.findingId) textLines.push(`Finding: ${notification.findingId}`);
  textLines.push("", notification.message);
  // Only real recorded detail lines; an absent list contributes nothing.
  if (notification.details?.length) textLines.push("", ...notification.details.map(detail => `- ${detail}`));
  textLines.push("", `Recorded at: ${notification.createdAt}`);
  if (link) textLines.push(`Dashboard: ${link}`);

  const htmlParts: string[] = [
    `<h1>${htmlEscape(subject)}</h1>`,
    "<table>",
    `<tr><th align="left">Event</th><td>${htmlEscape(notification.type)}</td></tr>`,
    `<tr><th align="left">Project</th><td>${htmlEscape(notification.projectName)}</td></tr>`,
  ];
  if (notification.severity) {
    htmlParts.push(`<tr><th align="left">Severity</th><td>${htmlEscape(notification.severity)}</td></tr>`);
  }
  if (notification.runId) {
    htmlParts.push(`<tr><th align="left">Run</th><td>${htmlEscape(notification.runId)}</td></tr>`);
  }
  if (notification.findingId) {
    htmlParts.push(`<tr><th align="left">Finding</th><td>${htmlEscape(notification.findingId)}</td></tr>`);
  }
  htmlParts.push("</table>");
  htmlParts.push(`<p>${htmlEscape(notification.message)}</p>`);
  if (notification.details?.length) {
    htmlParts.push(`<ul>${notification.details.map(detail => `<li>${htmlEscape(detail)}</li>`).join("")}</ul>`);
  }
  htmlParts.push(`<p><small>Recorded at ${htmlEscape(notification.createdAt)}</small></p>`);
  if (link) htmlParts.push(`<p><a href="${htmlEscape(link)}">Open in the QA dashboard</a></p>`);

  return { subject, text: `${textLines.join("\n")}\n`, html: `${htmlParts.join("\n")}\n` };
}

// ---------------------------------------------------------------------------
// The SMTP seam
// ---------------------------------------------------------------------------

/** The part of an outgoing mail the transport fills in. */
export type OutgoingEmail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

// ---------------------------------------------------------------------------
// Test email
//
// A delivery test, NOT a QA event. It carries no NotificationType, produces no
// inbox record, and is deliberately rendered from a project rather than from a
// notification, so there is no fake event anywhere in this path to accidentally
// persist. The body says so in as many words, because the recipient has no other
// way to tell a test from a real alert.
// ---------------------------------------------------------------------------

export type TestEmailProject = { id: string; name: string; url: string };

/**
 * The deterministic test message.
 *
 * Same project data a real alert would carry, with no timestamp and no event, so
 * the bytes are identical for the same configuration and a test can be diffed.
 */
export function renderTestEmailMessage(
  project: TestEmailProject,
  recipients: string[],
  dashboardUrl: string | null,
): EmailMessage {
  const subject = `AI Website QA: test email for ${project.name}`;
  const link = dashboardUrl ? `${dashboardUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(project.id)}` : null;

  const textLines = [
    subject,
    "",
    "This is a test email sent from the AI Website QA dashboard.",
    "",
    "It confirms that this project's email settings can reach a mailbox. It is",
    "not a QA notification, no QA run was performed, and no action is needed.",
    "",
    `Project: ${project.name}`,
    `Website: ${project.url}`,
    `Sent to: ${recipients.join(", ")}`,
  ];
  if (link) textLines.push("", `Dashboard: ${link}`);

  const htmlParts = [
    `<h1>${htmlEscape(subject)}</h1>`,
    "<p>This is a test email sent from the AI Website QA dashboard.</p>",
    "<p>It confirms that this project's email settings can reach a mailbox. It is",
    "<strong>not</strong> a QA notification, no QA run was performed, and no action is needed.</p>",
    "<table>",
    `<tr><th align="left">Project</th><td>${htmlEscape(project.name)}</td></tr>`,
    `<tr><th align="left">Website</th><td>${htmlEscape(project.url)}</td></tr>`,
    `<tr><th align="left">Sent to</th><td>${htmlEscape(recipients.join(", "))}</td></tr>`,
    "</table>",
  ];
  if (link) htmlParts.push(`<p><a href="${htmlEscape(link)}">Open in the QA dashboard</a></p>`);

  return { subject, text: `${textLines.join("\n")}\n`, html: `${htmlParts.join("\n")}\n` };
}

/** What one test-email send did. Never throws; a failure is a value. */
export type TestEmailOutcome = { status: "SENT" | "FAILED"; error?: string; providerMessageId?: string };

/**
 * The narrow contract the dashboard's test-email route depends on.
 *
 * Declared here, next to the transport that implements it, so the route cannot
 * grow a dependency on notification delivery it does not need.
 */
export type TestEmailSender = {
  sendTestMessage(message: EmailMessage, recipient: string): Promise<TestEmailOutcome>;
};

/** The part of a nodemailer response this transport reads. */
export type SmtpResponse = {
  messageId?: string;
  accepted?: unknown;
  rejected?: unknown;
};

/**
 * The minimal client this transport needs.
 *
 * Declared structurally rather than imported from nodemailer so the transport
 * carries no static dependency on a mail library: the production client is
 * created by loading nodemailer on first use, and tests inject their own.
 */
export type SmtpEmailClient = {
  sendMail(message: OutgoingEmail): Promise<SmtpResponse>;
};

export type SmtpClientFactory = (config: EmailConfig) => SmtpEmailClient;

/**
 * The production client factory: nodemailer, loaded only when a send is made.
 *
 * A lazy require means starting the dashboard does not pull in a mail stack, and
 * an installation without nodemailer still runs everything else. A missing
 * library is reported as a delivery failure, never as a crash.
 */
export const createNodemailerClient: SmtpClientFactory = (config) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodemailer = require("nodemailer") as {
    createTransport(options: Record<string, unknown>): SmtpEmailClient;
  };
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Only send credentials when the deployment actually supplied a pair.
    ...(config.user && config.password ? { auth: { user: config.user, pass: config.password } } : {}),
  });
};

export type NotificationEmailTransportOptions = {
  /** Pre-resolved configuration; otherwise read from `env`. */
  config?: EmailConfigResult;
  env?: NodeJS.ProcessEnv;
  /** Base URL of the dashboard, used only to build links. */
  dashboardUrl?: string | null;
  /** Injected in tests; defaults to nodemailer on first use. */
  createClient?: SmtpClientFactory;
};

/**
 * Sends a notification by email.
 *
 * The contract with the dispatcher is deliberately narrow: it returns SENT or
 * FAILED and never throws. `EMAIL_NOT_CONFIGURED` is surfaced as a FAILED result
 * carrying that exact token, with no socket opened and no credential touched.
 */
export class NotificationEmailTransport implements NotificationDeliveryTransport, TestEmailSender {
  readonly channel = "EMAIL" as const;

  private readonly options: NotificationEmailTransportOptions;
  private readonly redact: (text: string) => string;

  constructor(options: NotificationEmailTransportOptions = {}) {
    this.options = options;
    // The project's existing redactor, built from the same environment, so SMTP
    // credentials are scrubbed exactly like every other secret in this codebase.
    this.redact = buildRedactor(options.env ?? process.env);
  }

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const resolved = this.options.config ?? loadEmailConfig(this.options.env ?? process.env);
    if (!resolved.ok) {
      // Deterministic and pre-network: nothing was dialled to learn this.
      return {
        status: "FAILED",
        error: `${EMAIL_NOT_CONFIGURED}: missing ${resolved.missing.join(", ")}`,
      };
    }

    const message = renderEmailMessage(request.notification, this.options.dashboardUrl ?? null);
    const outcome = await this.put(resolved.config, message, request.recipient);
    if (outcome.status === "SENT") {
      return outcome.providerMessageId ? { status: "SENT", providerMessageId: outcome.providerMessageId } : { status: "SENT" };
    }
    return { status: "FAILED", error: outcome.error ?? "the message could not be sent" };
  }

  /**
   * Sends a composed message to one recipient.
   *
   * Shares the SMTP path with `send` rather than reimplementing it, so a test
   * email exercises exactly the code a real alert would: the same client
   * factory, the same rejection check, the same redaction. Missing configuration
   * is decided before any socket is opened, here as everywhere else.
   *
   * Nothing is persisted: a test email is not a notification delivery and must
   * not leave a record that claims to be one.
   */
  async sendTestMessage(message: EmailMessage, recipient: string): Promise<TestEmailOutcome> {
    const resolved = this.options.config ?? loadEmailConfig(this.options.env ?? process.env);
    if (!resolved.ok) {
      return { status: "FAILED", error: `${EMAIL_NOT_CONFIGURED}: missing ${resolved.missing.join(", ")}` };
    }
    return this.put(resolved.config, message, recipient);
  }

  /** The one place a message actually reaches an SMTP server. */
  private async put(config: EmailConfig, message: EmailMessage, recipient: string): Promise<TestEmailOutcome> {
    const from = config.fromName ? `${config.fromName} <${config.from}>` : config.from;

    let client: SmtpEmailClient;
    try {
      const factory = this.options.createClient ?? createNodemailerClient;
      client = factory(config);
    } catch (error) {
      return { status: "FAILED", error: this.redact(`the SMTP client could not be created: ${describe(error)}`) };
    }

    try {
      const response = await client.sendMail({
        from,
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      // A server that accepts the message but not this recipient has not sent it.
      // Reporting SENT here would silently lose an alert, so it is a failure.
      const acceptance = acceptanceFrom(response, recipient);
      if (!acceptance.accepted) return { status: "FAILED", error: acceptance.error };
      return acceptance.messageId ? { status: "SENT", providerMessageId: this.redact(acceptance.messageId) } : { status: "SENT" };
    } catch (error) {
      // Authentication failures, timeouts, refused connections and TLS errors all
      // land here. Redacted, bounded by the delivery store, and recorded as a
      // failed delivery - never thrown at the QA pipeline.
      return { status: "FAILED", error: this.redact(`SMTP send failed: ${describe(error)}`) };
    }
  }
}

/**
 * What the SMTP client's response actually proves about this recipient.
 *
 * The rule is deliberately one-directional: an acceptance claim may only be made
 * from a response that positively shows it. Anything unreadable - a response that
 * is not an object, or a rejection list this transport cannot enumerate - is a
 * failure, because the alternative is to report SENT for an alert that was
 * probably lost. Losing an alert is visible; a fabricated success is not.
 */
type Acceptance = { accepted: true; messageId?: string } | { accepted: false; error: string };

const acceptanceFrom = (response: unknown, recipient: string): Acceptance => {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { accepted: false, error: "the SMTP client returned no usable response, so acceptance could not be confirmed" };
  }
  const { rejected } = response as SmtpResponse;
  if (rejected !== undefined && rejected !== null) {
    // A rejection this transport cannot read cannot be searched for the recipient,
    // so it cannot be ruled out either. An unreadable rejection is not an absent
    // one, and treating the two as the same is how an alert goes missing quietly.
    if (!Array.isArray(rejected) || rejected.some(entry => typeof entry !== "string")) {
      return { accepted: false, error: "the SMTP client reported a recipient rejection this transport could not read" };
    }
    if (rejected.map(entry => entry.toLowerCase()).includes(recipient.toLowerCase())) {
      return { accepted: false, error: `the SMTP server rejected the recipient ${recipient}` };
    }
  }
  const { messageId } = response as SmtpResponse;
  return typeof messageId === "string" && messageId ? { accepted: true, messageId } : { accepted: true };
};

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    // `code` is nodemailer's stable machine-readable reason (EAUTH, ETIMEDOUT,
    // ECONNREFUSED...). Keeping it makes a failure actionable without keeping
    // anything that could identify the account.
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code ? `${code}: ${error.message}` : error.message;
  }
  return String(error ?? "unknown error");
};