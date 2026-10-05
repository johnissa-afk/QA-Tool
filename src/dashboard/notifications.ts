// ---------------------------------------------------------------------------
// In-app notifications — the PERSISTENT record of real QA events.
//
// WHAT THIS IS
// The storage half of in-app notifications. It keeps what actually happened,
// once, and remembers whether the user has read it. The DECISION of which events
// exist is not made here: it is made by the shared event derivation in
// notification-preview.ts, which reads the existing finding lifecycle, run
// comparison, access comparison and scheduler documents. This module only
// persists, de-duplicates and serves those events.
//
// ARCHITECTURE
//   existing QA run / scheduler execution
//     -> shared event derivation (notification-preview.ts)
//       -> NotificationStore (this file: dedup + persist)
//         -> GET /api/notifications, mark read
//
// It is NOT an intelligence layer, NOT a delivery system and NOT a scheduler:
// no email, no webhook, no worker, no retry, no priority score, no AI
// classification. There is one in-app inbox and the existing project/run/finding
// pages it links to.
//
// PERSISTENCE
// A single deterministic JSON document beside projects.json and schedules.json,
// written atomically, so notifications survive a restart exactly like projects
// and schedules do. Read state is part of the same document: it is the only
// mutable field, and it is never a second source of truth.
//
// IDEMPOTENCY
// Every record's id is a hash of its own dedup key, which is built only from
// stable recorded facts (project, type, run, finding or scheduler execution).
// Processing the same run twice therefore writes the same id and changes
// nothing, while two different runs about the same finding remain two separate
// notifications.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteText } from "../atomic-write.js";
import type { Severity } from "../ai/types.js";
import type { NotificationPreviewEvent, NotificationPreviewSource, NotificationPreviewType } from "./notification-preview.js";

/** The closed set of in-app notification kinds. Mirrors the derived events. */
export type NotificationType = NotificationPreviewType;

/**
 * Which existing subsystem the record was read from, coarsened to the store's
 * four production sources. `run-state` and `verification` are both the run's own
 * recorded failure evidence; `schedule-execution` and `access-comparison` map
 * onto the scheduler and the access comparison respectively.
 */
export type NotificationSource = "run" | "scheduler" | "access" | "finding-lifecycle" | "change-intelligence";

const SOURCE_OF: Record<NotificationPreviewSource, NotificationSource> = {
  "run-state": "run",
  verification: "run",
  "schedule-execution": "scheduler",
  "access-comparison": "access",
  "finding-lifecycle": "finding-lifecycle",
  "change-intelligence": "change-intelligence",
};

/**
 * One persisted notification.
 *
 * `id` is a hash of `dedupKey`, so identity is derived from recorded facts
 * rather than from a clock or a counter. `createdAt` is the instant of the
 * RECORDED event (the run's own completion stamp, or the scheduler execution's
 * own completion stamp), not the moment this store happened to be written.
 */
export type NotificationRecord = {
  id: string;
  projectId: string;
  projectName: string;
  type: NotificationType;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  runId: string | null;
  findingId: string | null;
  severity: Severity | null;
  source: NotificationSource;
  dedupKey: string;
  /** Where this event was read from: a finding id, a run id, an execution id. */
  reference: string | null;
  details?: string[];
};

export type NotificationFile = {
  schemaVersion: 1;
  notifications: NotificationRecord[];
};

/** Newest first, optional unread-only filter, optional limit. */
export type NotificationQuery = {
  projectId?: string | null;
  unreadOnly?: boolean;
  limit?: number | null;
};

export type NotificationList = {
  notifications: NotificationRecord[];
  unreadCount: number;
  total: number;
};

export type NotificationStoreResult<T> = { ok: true; value: T } | { ok: false; status: 404 | 500; error: string };

const MAX_NOTIFICATIONS = 500;
const NOTIFICATION_ID_PREFIX = "ntf";
const SAVE_FAILED: NotificationStoreResult<never> = {
  ok: false,
  status: 500,
  error: "The notification could not be saved. Check that the data directory is writable.",
};

const emptyFile = (): NotificationFile => ({ schemaVersion: 1, notifications: [] });

const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "");

/**
 * The stable identity of one event.
 *
 * Composed only from recorded facts, never from a timestamp or a counter:
 *   * a finding event is one finding in one run;
 *   * a scheduler skip is the execution that recorded it - a skip belongs to no
 *     run of its own, so it must not be duplicated by reprocessing;
 *   * a failure names the evidence that proved it, so run-state and
 *     infrastructure failures are separate records;
 *   * access and change-summary are one per run.
 */
export function notificationDedupKey(event: NotificationPreviewEvent): string {
  const project = sanitizeId(event.projectId);
  switch (event.type) {
    case "NEW_FINDING":
    case "REGRESSED_FINDING":
    case "RESOLVED_FINDING":
      return `${project}:${event.type}:${sanitizeId(event.runId ?? "-")}:${sanitizeId(event.findingId ?? "-")}`;
    case "SCHEDULE_SKIPPED":
      return `${project}:${event.type}:${sanitizeId(event.reference ?? "-")}`;
    case "RUN_FAILED":
      return `${project}:${event.type}:${sanitizeId(event.runId ?? "-")}:${event.source}:${sanitizeId(event.reference ?? "-")}`;
    default:
      return `${project}:${event.type}:${sanitizeId(event.runId ?? "-")}`;
  }
}

/** A stable id for a dedup key. Same key, same id, on every machine and restart. */
export function notificationIdFor(dedupKey: string): string {
  return `${NOTIFICATION_ID_PREFIX}-${createHash("sha256").update(dedupKey).digest("hex").slice(0, 32)}`;
}

/** Newest first, with a total order so equal timestamps never reorder. */
const byNewestFirst = (a: NotificationRecord, b: NotificationRecord): number => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id.localeCompare(b.id);
};

const isNotificationRecord = (value: unknown): value is NotificationRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NotificationRecord>;
  return (
    typeof record.id === "string" && record.id !== "" &&
    typeof record.projectId === "string" &&
    typeof record.type === "string" &&
    typeof record.title === "string" &&
    typeof record.message === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.read === "boolean" &&
    typeof record.dedupKey === "string"
  );
};

/**
 * The one place a derived event becomes a stored record.
 *
 * `createdAt` prefers the recorded instant the event actually happened, and only
 * falls back to the caller's clock when the run recorded none at all.
 */
export function notificationFromEvent(
  event: NotificationPreviewEvent,
  fallbackCreatedAt: string = new Date().toISOString(),
): NotificationRecord {
  const dedupKey = notificationDedupKey(event);
  return {
    id: notificationIdFor(dedupKey),
    projectId: event.projectId,
    projectName: event.projectName,
    type: event.type,
    title: event.title,
    message: event.message,
    createdAt: fallbackCreatedAt,
    read: false,
    runId: event.runId,
    findingId: event.findingId,
    severity: event.severity,
    source: SOURCE_OF[event.source],
    dedupKey,
    reference: event.reference,
    ...(event.details ? { details: event.details } : {}),
  };
}

/**
 * Persistent, deterministic in-app notifications.
 *
 * Writes are reported as failures rather than swallowed: the caller must never be
 * told a notification exists when it was never written.
 */
export class NotificationStore {
  private readonly path: string;
  private data: NotificationFile;

  constructor(filePath: string) {
    this.path = resolve(filePath);
    this.data = this.load();
  }

  get filePath(): string {
    return this.path;
  }

  private load(): NotificationFile {
    if (!existsSync(this.path)) return emptyFile();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
      const file = parsed as Partial<NotificationFile>;
      if (!Array.isArray(file.notifications)) return emptyFile();
      return { schemaVersion: 1, notifications: file.notifications.filter(isNotificationRecord) };
    } catch {
      // A corrupt inbox must not take the dashboard down, and nothing QA depends
      // on lives here. An unreadable document reads as an empty inbox.
      return emptyFile();
    }
  }

  private persist(): NotificationStoreResult<true> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      atomicWriteText(this.path, JSON.stringify(this.data, null, 2));
      return { ok: true, value: true };
    } catch {
      return { ...SAVE_FAILED };
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(query: NotificationQuery = {}): NotificationList {
    const projectId = query.projectId ? sanitizeId(query.projectId) : null;
    const scoped = projectId
      ? this.data.notifications.filter(record => sanitizeId(record.projectId) === projectId)
      : this.data.notifications;
    const matching = query.unreadOnly ? scoped.filter(record => record.read === false) : scoped;
    const ordered = [...matching].sort(byNewestFirst);
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : null;
    return {
      notifications: limit === null ? ordered : ordered.slice(0, limit),
      // `total` describes the list the caller actually asked for, so an
      // unread-filtered request cannot report a total of records it did not
      // return. The count is of the unread records in scope, not of the page
      // that happened to be returned: a limited list still reports every
      // unread match.
      total: matching.length,
      unreadCount: scoped.filter(record => record.read === false).length,
    };
  }

  get(id: string): NotificationRecord | null {
    const clean = sanitizeId(id);
    return this.data.notifications.find(record => record.id === clean) ?? null;
  }

  unreadCount(projectId?: string | null): number {
    if (!projectId) return this.data.notifications.filter(record => record.read === false).length;
    const clean = sanitizeId(projectId);
    return this.data.notifications.filter(record => record.read === false && sanitizeId(record.projectId) === clean).length;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Stores events that are not stored yet, keyed by their own dedup key.
   *
   * Re-processing the same run returns an empty `created` list and rewrites
   * nothing: the existing record, including its read state, is left untouched.
   * Only the genuinely new records are appended, so the document is written once
   * per real event and not at all on a repeat.
   */
  record(events: readonly NotificationPreviewEvent[], nowIso?: string): NotificationStoreResult<NotificationRecord[]> {
    const existing = new Set(this.data.notifications.map(record => record.dedupKey));
    const created: NotificationRecord[] = [];
    for (const item of events) {
      const record = notificationFromEvent(item, nowIso);
      if (existing.has(record.dedupKey)) continue;
      existing.add(record.dedupKey);
      created.push(record);
    }
    if (!created.length) return { ok: true, value: [] };

    // Newest first, so the persisted document is already in reading order.
    const merged = [...created, ...this.data.notifications].sort(byNewestFirst);
    this.data = { schemaVersion: 1, notifications: merged.slice(0, MAX_NOTIFICATIONS) };
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: created };
  }

  /**
   * Marks one notification read. Idempotent: a notification that is already read
   * is reported as read and nothing is written.
   */
  markRead(id: string): NotificationStoreResult<{ notification: NotificationRecord; changed: boolean }> {
    const clean = sanitizeId(id);
    const index = this.data.notifications.findIndex(record => record.id === clean);
    if (index === -1) return { ok: false, status: 404, error: "That notification does not exist." };
    const record = this.data.notifications[index]!;
    if (record.read) return { ok: true, value: { notification: record, changed: false } };
    const next: NotificationRecord = { ...record, read: true };
    this.data = { schemaVersion: 1, notifications: this.data.notifications.map(item => (item.id === clean ? next : item)) };
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: { notification: next, changed: true } };
  }

  /**
   * Marks every unread notification read, optionally within one project. Only
   * unread records are touched; a document with nothing unread is not rewritten.
   */
  markAllRead(projectId?: string | null): NotificationStoreResult<{ updated: number }> {
    const clean = projectId ? sanitizeId(projectId) : null;
    const targets = this.data.notifications.filter(
      record => record.read === false && (!clean || sanitizeId(record.projectId) === clean),
    );
    if (!targets.length) return { ok: true, value: { updated: 0 } };
    const targetIds = new Set(targets.map(record => record.id));
    this.data = {
      schemaVersion: 1,
      notifications: this.data.notifications.map(record => (targetIds.has(record.id) ? { ...record, read: true } : record)),
    };
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: { updated: targets.length } };
  }
}

/** Beside projects.json and schedules.json, under the report persistence area. */
export function defaultNotificationsPath(reportDir: string): string {
  return join(reportDir, "projects", "notifications.json");
}