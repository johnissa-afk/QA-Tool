// ---------------------------------------------------------------------------
// Notification delivery — the DELIVERY CORE for one already-stored notification.
//
// WHAT THIS IS
// The recording half of delivery. It takes a notification that already exists in
// the in-app inbox and records what happened when that notification was sent to a
// target. This milestone sends NOTHING: the only transport here is an in-memory
// one that records what would have been delivered. A real email transport, email
// preferences, dashboard settings and automatic delivery are later milestones and
// deliberately do not exist yet.
//
// ARCHITECTURE
//   NotificationRecord (already persisted by NotificationStore)
//     -> NotificationDeliveryDispatcher (this file: identity + idempotency)
//       -> NotificationDeliveryTransport (this file: the in-memory test seam)
//         -> DeliveryOutcome
//           -> NotificationDeliveryStore (this file: persist one record)
//
// It is NOT a notification source and NOT a decision layer. It never derives an
// event, never invents a finding, and never reads a QA report: it consumes
// notifications the existing pipeline already recorded, and it never writes back
// to the notification document.
//
// WHY THE IDEMPOTENCY KEY IS NOT THE DELIVERY ID
// `notificationId + channel + recipient` is the identity of the DELIVERY TARGET -
// the one thing that must never be sent twice. A single target may be attempted
// several times (a failure, then a retry), and each attempt is its own record with
// its own outcome. So the id is a hash of that key PLUS the attempt number, which
// makes every record unique and stable, while `deliveryKey` groups the attempts
// belonging to one target. Without the attempt number a retry would overwrite the
// failure it was retrying, and the history of what actually happened would be lost.
//
// SECRETS
// Nothing here accepts, stores or logs a credential. There is no SMTP host, no
// password, no API token and no auth header anywhere in this file or in the
// document it writes. `recipient` is stored because it is the delivery target and
// is needed to explain a record; transport errors are reduced to a short, bounded
// summary before they are written, so a provider message that happened to quote a
// secret cannot become a persisted one.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteText } from "../atomic-write.js";
import { buildRedactor } from "../executor/redact.js";
import type { NotificationRecord } from "./notifications.js";

/** The channels a notification can be delivered through. Closed on purpose. */
export type NotificationChannel = "EMAIL";

/** What happened to one delivery attempt. */
export type DeliveryStatus = "SENT" | "FAILED" | "SKIPPED";

/** Why an attempt was skipped, for the attempts that were skipped. */
export type DeliverySkipReason = "ALREADY_DELIVERED" | "NO_TRANSPORT" | "INVALID_RECIPIENT";

/**
 * One attempt to deliver one notification to one recipient.
 *
 * `attempt` is 1-based and is the ONLY thing that varies between records sharing a
 * `deliveryKey`. `attemptedAt` is the clock reading of that attempt and is never
 * part of identity, so the same attempt number keeps its id across restarts.
 */
export type NotificationDelivery = {
  id: string;
  /** Stable identity of the delivery TARGET: notification + channel + recipient. */
  deliveryKey: string;
  notificationId: string;
  channel: NotificationChannel;
  recipient: string;
  /** 1 for the first attempt at this target, 2 for its retry, and so on. */
  attempt: number;
  status: DeliveryStatus;
  attemptedAt: string;
  /** Set only for SKIPPED attempts. */
  reason?: DeliverySkipReason;
  /** Set only for FAILED attempts: a short, secret-free summary. */
  error?: string;
  /** Set only for SENT attempts, when the transport reports one. */
  providerMessageId?: string;
};

/** The persisted document. One delivery record per element. */
export type NotificationDeliveryFile = {
  schemaVersion: 1;
  deliveries: NotificationDelivery[];
};

export type NotificationDeliveryResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/** What the dispatcher hands back after one delivery request. */
export type DeliveryDispatch = {
  /** The attempt this request produced, always persisted. */
  delivery: NotificationDelivery;
  /** True when the target had already succeeded and no transport was called. */
  alreadyDelivered: boolean;
};

export type NotificationDeliveryQuery = {
  notificationId?: string | null;
  channel?: NotificationChannel | null;
  recipient?: string | null;
  status?: DeliveryStatus | null;
  limit?: number | null;
};

export type NotificationDeliveryList = {
  deliveries: NotificationDelivery[];
  /** Attempts for the matching target(s), before any limit is applied. */
  total: number;
  /** How many distinct delivery targets these attempts belong to. */
  targets: number;
};

const MAX_DELIVERIES = 500;
const DELIVERY_ID_PREFIX = "dlv";
const MAX_ERROR_LENGTH = 300;
/**
 * One address grammar, shared by the delivery layer and by project email
 * preferences, so an address that cannot be persisted is also an address the
 * transport refuses.
 *
 * Local part: dot-atom - one or more RFC 5322 `atext` runs joined by SINGLE dots.
 * Domain: dot-separated labels of letters, digits and inner hyphens.
 *
 * The dot rules are what a "looks fine to me" check would miss: a leading,
 * trailing or doubled dot (`alice..b@`, `.alice@`, `alice@example..com`) leaves
 * an EMPTY label that no mail server accepts. Characters that would let an
 * address smuggle a header or an extra recipient into an outgoing message -
 * whitespace, comma, semicolon and friends - remain rejected outright.
 */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const EMAIL_PATTERN = new RegExp(
  `^${ATEXT}+(?:\\.${ATEXT}+)*@(?:${LABEL}\\.)*${LABEL}$`,
);

const SAVE_FAILED = {
  ok: false,
  status: 500,
  error: "The delivery could not be saved. Check that the data directory is writable.",
} as const;

/** Beside notifications.json, under the report persistence area. */
export function defaultNotificationDeliveriesPath(reportDir: string): string {
  return join(reportDir, "projects", "notification-deliveries.json");
}

export const isDeliveryStatus = (value: unknown): value is DeliveryStatus =>
  value === "SENT" || value === "FAILED" || value === "SKIPPED";

export const isNotificationChannel = (value: unknown): value is NotificationChannel => value === "EMAIL";

const emptyFile = (): NotificationDeliveryFile => ({ schemaVersion: 1, deliveries: [] });

const sanitizeId = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "");

/**
 * Rejects anything that is not a plain address.
 *
 * Newlines and header separators are refused outright rather than stripped,
 * because a recipient containing one is never a real address and stripping it
 * would quietly deliver to somewhere the caller did not name.
 */
export function normalizeRecipient(value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  // Addresses are compared case-insensitively so the same person cannot become
  // two delivery targets and be mailed twice.
  const lower = trimmed.toLowerCase();
  return EMAIL_PATTERN.test(lower) ? lower : null;
}

/**
 * Reduces a transport error to a bounded, single-line summary.
 *
 * Provider messages are untrusted input that can echo back whatever the transport
 * was configured with. Trimming and collapsing whitespace keeps the document
 * readable, and the length bound keeps one pathological message from becoming the
 * whole record.
 */
export function deliveryErrorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "The transport reported a failure without a message.";
  return collapsed.length > MAX_ERROR_LENGTH ? `${collapsed.slice(0, MAX_ERROR_LENGTH)}...` : collapsed;
}

/**
 * The stable identity of one delivery TARGET.
 *
 * Composed only from the notification, the channel and the recipient - never from
 * a clock, a counter or a run id - so the same request always resolves to the same
 * key on every machine and after every restart. That is what makes "has this
 * already been sent?" answerable from the persisted document alone.
 */
export function deliveryKey(notificationId: string, channel: NotificationChannel, recipient: string): string {
  const normalized = normalizeRecipient(recipient) ?? recipient.trim().toLowerCase();
  return `${sanitizeId(notificationId)}:${channel}:${normalized}`;
}

/**
 * A stable id for one attempt at one target.
 *
 * The attempt number is part of the id so a retry is a NEW record rather than an
 * overwrite of the failure it is retrying, and it is derived from state that is
 * already persisted, so it never depends on when the write happened.
 */
export function deliveryIdFor(deliveryKeyValue: string, attempt: number): string {
  const hash = createHash("sha256").update(`${deliveryKeyValue}#${attempt}`).digest("hex").slice(0, 32);
  return `${DELIVERY_ID_PREFIX}-${hash}`;
}

/** Newest first, with a total order so equal timestamps never reorder. */
const byNewestFirst = (a: NotificationDelivery, b: NotificationDelivery): number => {
  if (a.attemptedAt !== b.attemptedAt) return a.attemptedAt < b.attemptedAt ? 1 : -1;
  // Same instant: most recent attempt of each target first, then id, so the order
  // is total and reproducible.
  if (a.attempt !== b.attempt) return b.attempt - a.attempt;
  return a.id.localeCompare(b.id);
};

const isNotificationDelivery = (value: unknown): value is NotificationDelivery => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NotificationDelivery>;
  return (
    typeof record.id === "string" && record.id !== "" &&
    typeof record.deliveryKey === "string" && record.deliveryKey !== "" &&
    typeof record.notificationId === "string" &&
    isNotificationChannel(record.channel) &&
    typeof record.recipient === "string" &&
    typeof record.attempt === "number" && Number.isInteger(record.attempt) && record.attempt > 0 &&
    isDeliveryStatus(record.status) &&
    typeof record.attemptedAt === "string" &&
    // A reason on a non-skip, or a missing one on a skip, would make the record
    // contradict itself; drop such a record rather than trust it.
    (record.status === "SKIPPED" ? typeof record.reason === "string" : record.reason === undefined)
  );
};

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/** What a transport is asked to deliver. Read-only: a transport cannot mutate it. */
export type DeliveryRequest = {
  notification: Readonly<NotificationRecord>;
  recipient: string;
};

/** What a transport reports back. A transport decides SENT/FAILED, never SKIPPED. */
export type DeliveryResult =
  | { status: "SENT"; providerMessageId?: string }
  | { status: "FAILED"; error: unknown };

/**
 * The seam the Email Channel milestone implements.
 *
 * A transport knows how to put one notification in front of one recipient on one
 * channel. It has no notion of idempotency, retries or persistence: the dispatcher
 * owns all three, so a real transport cannot accidentally re-send or re-write.
 */
export type NotificationDeliveryTransport = {
  readonly channel: NotificationChannel;
  send(request: DeliveryRequest): Promise<DeliveryResult>;
};

/**
 * The in-memory transport for this milestone.
 *
 * It records what WOULD have been delivered and returns deterministic results
 * driven by the addresses given to it, so the delivery core can be exercised with
 * no network, no SMTP host, no credentials and no clock dependence. Sending
 * nothing is the point: no transport in this file opens a socket.
 */
export class InMemoryDeliveryTransport implements NotificationDeliveryTransport {
  readonly channel: NotificationChannel = "EMAIL";

  /** Every send that reached the transport, in order. */
  readonly attempts: DeliveryRequest[] = [];

  private readonly alwaysFail: Set<string>;

  constructor(options: { failRecipients?: readonly string[] } = {}) {
    this.alwaysFail = new Set(
      (options.failRecipients ?? []).map(entry => normalizeRecipient(entry)).filter((entry): entry is string => entry !== null),
    );
  }

  /** How many times the transport was asked to deliver to one address. */
  sendCount(recipient: string): number {
    const normalized = normalizeRecipient(recipient);
    return this.attempts.filter(attempt => attempt.recipient === normalized).length;
  }

  /**
   * Deterministic by construction: the same address always behaves the same way,
   * so a retry test cannot pass or fail by accident.
   */
  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    this.attempts.push(request);
    if (this.alwaysFail.has(request.recipient)) {
      return { status: "FAILED", error: `transport refused ${request.recipient}` };
    }
    return { status: "SENT", providerMessageId: `mem-${this.attempts.length}` };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persistent, deterministic delivery attempts.
 *
 * Writes are reported as failures rather than swallowed: the caller must never be
 * told a delivery was recorded when it was not.
 */
export class NotificationDeliveryStore {
  private readonly path: string;
  private data: NotificationDeliveryFile;
  /**
   * The last gate before a failure message reaches a file a human will read.
   *
   * The transport already redacts its own errors, but the dispatcher also
   * contains transports that THROW, and a thrown error arrives here raw. Without
   * this, a misbehaving or future transport could put a credential into a
   * persisted delivery record that is then rendered in the UI. Redacting at the
   * persistence boundary covers every path into the document rather than relying
   * on each producer remembering to do it.
   */
  private readonly redact: (text: string) => string;

  constructor(filePath: string, env: NodeJS.ProcessEnv = {}) {
    this.path = resolve(filePath);
    this.redact = buildRedactor(env);
    this.data = this.load();
  }

  get filePath(): string {
    return this.path;
  }

  private load(): NotificationDeliveryFile {
    if (!existsSync(this.path)) return emptyFile();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
      const file = parsed as Partial<NotificationDeliveryFile>;
      if (!Array.isArray(file.deliveries)) return emptyFile();
      return { schemaVersion: 1, deliveries: file.deliveries.filter(isNotificationDelivery) };
    } catch {
      // Nothing QA depends on lives here, so a corrupt document reads as an empty
      // delivery history rather than taking the dashboard down.
      return emptyFile();
    }
  }

  /**
   * Writes a candidate document and only returns true if it reached disk.
   *
   * Takes the candidate rather than reading `this.data`, so a caller can decide
   * to commit in memory only after the write actually succeeded. That ordering is
   * what keeps a failed save from leaving a record this process believes in and
   * the next process cannot see.
   */
  private persist(next: NotificationDeliveryFile): NotificationDeliveryResult<true> {
    try {
      atomicWriteText(this.path, JSON.stringify(next, null, 2));
      return { ok: true, value: true };
    } catch {
      return { ...SAVE_FAILED };
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(query: NotificationDeliveryQuery = {}): NotificationDeliveryList {
    const notificationId = query.notificationId ? sanitizeId(query.notificationId) : null;
    const recipient = query.recipient ? normalizeRecipient(query.recipient) : null;
    const matching = this.data.deliveries.filter(record => {
      if (notificationId && sanitizeId(record.notificationId) !== notificationId) return false;
      if (query.channel && record.channel !== query.channel) return false;
      if (recipient && record.recipient !== recipient) return false;
      if (query.status && record.status !== query.status) return false;
      return true;
    });
    const ordered = [...matching].sort(byNewestFirst);
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : null;
    return {
      deliveries: limit === null ? ordered : ordered.slice(0, limit),
      total: matching.length,
      targets: new Set(matching.map(record => record.deliveryKey)).size,
    };
  }

  get(id: string): NotificationDelivery | null {
    const clean = sanitizeId(id);
    return this.data.deliveries.find(record => record.id === clean) ?? null;
  }

  /** Every attempt recorded for one delivery target, oldest first. */
  attemptsFor(key: string): NotificationDelivery[] {
    return this.data.deliveries
      .filter(record => record.deliveryKey === key)
      .sort((a, b) => a.attempt - b.attempt);
  }

  /** The 1-based attempt number this target has reached. Zero when never tried. */
  attemptCount(key: string): number {
    return this.attemptsFor(key).length;
  }

  /**
   * Has this exact target ever been delivered successfully?
   *
   * Answered from the persisted document, so it survives a restart and does not
   * depend on anything still held in memory.
   */
  hasSucceeded(key: string): boolean {
    return this.data.deliveries.some(record => record.deliveryKey === key && record.status === "SENT");
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Appends one attempt.
   *
   * A record whose id already exists is NOT rewritten: an id is derived from the
   * target and the attempt number, so the same attempt recorded twice is the same
   * record and re-recording it would rewrite history rather than add to it. The
   * caller is told the existing record so a duplicate request stays idempotent.
   */
  record(delivery: NotificationDelivery): NotificationDeliveryResult<{ delivery: NotificationDelivery; created: boolean }> {
    // Redacted here, not only at the producer, so no path into the document can
    // carry a credential. See the redactor's note above.
    const safe: NotificationDelivery =
      typeof delivery.error === "string" ? { ...delivery, error: this.redact(delivery.error) } : delivery;
    if (this.data.deliveries.some(record => record.id === safe.id)) {
      return { ok: true, value: { delivery: this.get(safe.id)!, created: false } };
    }
    const next: NotificationDeliveryFile = {
      schemaVersion: 1,
      deliveries: [...this.data.deliveries, safe].sort(byNewestFirst).slice(0, MAX_DELIVERIES),
    };
    // The write is the commit point, not the assignment. If it fails, in-memory
    // state stays exactly as it was: a record this process can see but the file
    // cannot would make a retry look delivered here and absent after a restart.
    const saved = this.persist(next);
    if (!saved.ok) return saved;
    this.data = next;
    return { ok: true, value: { delivery: safe, created: true } };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type NotificationDeliveryDispatcherOptions = {
  store: NotificationDeliveryStore;
  /** Keyed by channel, so adding a second channel later adds a transport, not a fork. */
  transports?: Partial<Record<NotificationChannel, NotificationDeliveryTransport>>;
  /** Injectable clock; the production default is the wall clock. */
  now?: () => number;
};

/**
 * Routes one notification to one recipient through a channel transport, and
 * records the attempt.
 *
 * The dispatcher owns identity, idempotency and retry numbering. It has no SMTP
 * knowledge: a channel it has no transport for is a recorded SKIPPED, never a
 * crash and never a silent success.
 */
export class NotificationDeliveryDispatcher {
  private readonly store: NotificationDeliveryStore;
  private readonly transports: Partial<Record<NotificationChannel, NotificationDeliveryTransport>>;
  private readonly now: () => number;

  constructor(options: NotificationDeliveryDispatcherOptions) {
    this.store = options.store;
    this.transports = options.transports ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Attempts to deliver one notification to one recipient.
   *
   * The rules, in order:
   *   1. an unusable recipient is refused before any transport is consulted;
   *   2. a target that has already succeeded is SKIPPED/ALREADY_DELIVERED and the
   *      transport is NOT called - that is the whole point of the deterministic
   *      identity, and it holds across restarts;
   *   3. a channel with no transport is SKIPPED/NO_TRANSPORT;
   *   4. otherwise the transport is asked exactly once, and whatever it reports is
   *      recorded as that attempt. A failure is never rewritten into a success:
   *      retrying is a separate call, which produces its own attempt.
   */
  async deliver(
    notification: NotificationRecord,
    recipient: string,
    channel: NotificationChannel = "EMAIL",
  ): Promise<NotificationDeliveryResult<DeliveryDispatch>> {
    const cleanNotificationId = sanitizeId(notification.id);
    if (!cleanNotificationId) {
      return { ok: false, status: 400, error: "invalid notification id" };
    }
    const normalized = normalizeRecipient(recipient);
    const attemptedAt = new Date(this.now()).toISOString();

    const skipped = (reason: DeliverySkipReason, attempt: number): NotificationDelivery => ({
      id: deliveryIdFor(deliveryKey(cleanNotificationId, channel, normalized ?? recipient.trim().toLowerCase()), attempt),
      deliveryKey: deliveryKey(cleanNotificationId, channel, normalized ?? recipient.trim().toLowerCase()),
      notificationId: cleanNotificationId,
      channel,
      recipient: normalized ?? recipient.trim().toLowerCase(),
      attempt,
      status: "SKIPPED",
      attemptedAt,
      reason,
    });

    if (!normalized) {
      const key = deliveryKey(cleanNotificationId, channel, recipient.trim().toLowerCase());
      const attempt = this.store.attemptCount(key) + 1;
      const saved = this.store.record(skipped("INVALID_RECIPIENT", attempt));
      if (!saved.ok) return saved;
      return { ok: true, value: { delivery: saved.value.delivery, alreadyDelivered: false } };
    }

    const key = deliveryKey(cleanNotificationId, channel, normalized);

    // (2) Strict idempotency. The success is remembered in the document, so a
    // second request is a no-op even after the process has restarted.
    if (this.store.hasSucceeded(key)) {
      const attempt = this.store.attemptCount(key) + 1;
      const saved = this.store.record(skipped("ALREADY_DELIVERED", attempt));
      if (!saved.ok) return saved;
      return { ok: true, value: { delivery: saved.value.delivery, alreadyDelivered: true } };
    }

    const transport = this.transports[channel];
    if (!transport) {
      const attempt = this.store.attemptCount(key) + 1;
      const saved = this.store.record(skipped("NO_TRANSPORT", attempt));
      if (!saved.ok) return saved;
      return { ok: true, value: { delivery: saved.value.delivery, alreadyDelivered: false } };
    }

    const attempt = this.store.attemptCount(key) + 1;
    let result: DeliveryResult;
    try {
      result = await transport.send({ notification: Object.freeze({ ...notification }), recipient: normalized });
    } catch (error) {
      // A transport that throws is a FAILED attempt, not a crashed dispatcher: an
      // unattended delivery must never take the dashboard with it.
      result = { status: "FAILED", error };
    }

    const base = {
      id: deliveryIdFor(key, attempt),
      deliveryKey: key,
      notificationId: cleanNotificationId,
      channel,
      recipient: normalized,
      attempt,
      attemptedAt,
    };
    const delivery: NotificationDelivery = result.status === "SENT"
      ? { ...base, status: "SENT", ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}) }
      : { ...base, status: "FAILED", error: deliveryErrorSummary(result.error) };

    const saved = this.store.record(delivery);
    if (!saved.ok) return saved;
    return { ok: true, value: { delivery: saved.value.delivery, alreadyDelivered: false } };
  }
}