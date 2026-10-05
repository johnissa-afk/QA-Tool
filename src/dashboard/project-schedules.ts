// ---------------------------------------------------------------------------
// Project schedules — recurring QA for a saved Project.
//
// A schedule is configuration, not a result. It says when the EXISTING QA
// pipeline should next be launched against a Project's URL. It never says what
// the run found, never carries a score, and never stores run output: the engine
// still writes the artifacts, the existing Project finding lifecycle still folds
// them, and the existing run comparison still reads them.
//
// Persistence is a single deterministic JSON document written atomically, which
// is exactly how projects.json is already stored in this single-user local tool.
// It lives beside that document rather than inside any run artifact.
//
// DEPLOYMENT LIMITATION — read before adding a second process.
// Locking here is per-process: the due-claim is made synchronously, before any
// await, and the claim is persisted immediately, so two ticks of THIS process
// can never dispatch the same execution twice. That guarantee does not extend to
// a second server process pointed at the same file. This application is a
// single-user local tool that binds to loopback and launches one pipeline at a
// time (RunManager allows exactly one active run), so running two schedulers
// against one file is already outside its supported shape. Should that ever
// change, the claim would need a real cross-process lock (an O_EXCL lock file or
// a database transaction), not a different code path here.
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteText } from "../atomic-write.js";

/**
 * Stable frequency identifiers. The display label is derived, never stored, so a
 * wording change can never alter what an existing schedule means.
 */
export const SCHEDULE_FREQUENCIES = ["EVERY_15_MINUTES", "HOURLY", "EVERY_6_HOURS", "DAILY", "WEEKLY"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  EVERY_15_MINUTES: "Every 15 minutes",
  HOURLY: "Hourly",
  EVERY_6_HOURS: "Every 6 hours",
  DAILY: "Daily",
  WEEKLY: "Weekly",
};

export const frequencyLabel = (frequency: ScheduleFrequency): string => FREQUENCY_LABELS[frequency];

/** Exact-interval frequencies, which advance by elapsed time and so have no DST
 *  interaction: a 6-hourly schedule really is six hours later, including across a
 *  transition. */
const INTERVAL_FREQUENCIES: Record<string, number> = {
  EVERY_15_MINUTES: 15 * 60 * 1000,
  HOURLY: 60 * 60 * 1000,
  EVERY_6_HOURS: 6 * 60 * 60 * 1000,
};

/**
 * Explicit execution states. A scheduled execution is never marked COMPLETED
 * before the real run has finished and its real outcome is known.
 *
 * INTERRUPTED is the recovery state: the process went away while this execution
 * was in flight and nothing proves it finished. It is reported as its own thing
 * rather than quietly counted as a pass or a failure of the website.
 */
export const SCHEDULE_EXECUTION_STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "SKIPPED_OVERLAPPING_RUN",
  "SKIPPED_PROJECT_MISSING",
  "CANCELLED",
  "INTERRUPTED",
] as const;
export type ScheduleExecutionStatus = (typeof SCHEDULE_EXECUTION_STATUSES)[number];

/** States that can still change; used by recovery to decide what to inspect. */
const UNSETTLED_STATUSES: readonly ScheduleExecutionStatus[] = ["QUEUED", "RUNNING"];

/** What caused this execution. Recorded so a manual test trigger is never
 *  mistaken for the schedule having actually come due on its own. */
export type ScheduleTrigger = "SCHEDULER" | "MANUAL_TRIGGER";

export type ProjectSchedule = {
  id: string;
  projectId: string;
  enabled: boolean;
  frequency: ScheduleFrequency;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  /** UTC ISO. Null only while disabled with nothing ever scheduled. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastExecutionStatus: ScheduleExecutionStatus | null;
  /** Consecutive real dispatch failures; reset by any completed execution. */
  consecutiveFailures: number;
  /** Bumped on every mutation, so a stale writer cannot silently overwrite. */
  version: number;
  /**
   * Local wall-clock anchors, kept so recurrence is stable across restarts and
   * machines. "Daily" means the same local time every day, which cannot be
   * expressed as a fixed millisecond offset from an instant.
   */
  anchorLocalMinutes: number;
  /** 0 = Sunday, matching Date#getUTCDay. Only meaningful for WEEKLY. */
  anchorWeekday: number;
};

export type ScheduledExecution = {
  executionId: string;
  scheduleId: string;
  projectId: string;
  /** The UTC instant this execution was due for. */
  scheduledFor: string;
  /** When the run was actually launched; null until it is. */
  startedAt: string | null;
  completedAt: string | null;
  /** The real RunManager run id. Never fabricated, never pre-filled. */
  runId: string | null;
  status: ScheduleExecutionStatus;
  /** Short, redacted reason. Never a stack trace, secret or command line. */
  detail: string | null;
  trigger: ScheduleTrigger;
  version: number;
};

type ScheduleFile = {
  schemaVersion: 1;
  schedules: ProjectSchedule[];
  executions: ScheduledExecution[];
};

export type ScheduleResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/* Execution history is never trimmed. The brief requires every historical
 * execution record to survive editing and disabling a schedule, so the document
 * grows without bound rather than silently dropping the audit trail. */

const emptyFile = (): ScheduleFile => ({ schemaVersion: 1, schedules: [], executions: [] });

const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "");

const isFrequency = (value: unknown): value is ScheduleFrequency =>
  typeof value === "string" && (SCHEDULE_FREQUENCIES as readonly string[]).includes(value);

const isExecutionStatus = (value: unknown): value is ScheduleExecutionStatus =>
  typeof value === "string" && (SCHEDULE_EXECUTION_STATUSES as readonly string[]).includes(value);

/**
 * True for an IANA zone this runtime actually knows. Constructing a formatter is
 * the only reliable check: string shape validation would accept "Mars/Olympus".
 */
export function isValidTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset of `timeZone` at a given instant, in milliseconds east of UTC.
 *
 * Derived by formatting the instant in that zone and re-reading the parts, so it
 * is correct for every zone including half-hour and 45-minute offsets, and
 * correct on both sides of a DST transition because the offset is asked about a
 * specific instant rather than assumed.
 */
function offsetAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const read = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The calendar parts of an instant as seen in a zone. */
function localPartsAt(instantMs: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instantMs));
  const read = (type: string): string => parts.find(part => part.type === type)?.value ?? "0";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
    weekday: weekdays[read("weekday")] ?? 0,
  };
}

/**
 * The UTC instant at which a local wall-clock time occurs in a zone.
 *
 * Two pathological local times are resolved by an explicit, documented rule so
 * the answer is deterministic rather than dependent on the platform:
 *
 *   - Ambiguous (clocks go back, so the wall time happens twice): the EARLIER
 *     occurrence is chosen, so a daily run never fires an hour late.
 *   - Nonexistent (clocks go forward, so the wall time never happens): the
 *     instant the gap closes is chosen, so the run happens instead of being
 *     skipped. Verified by round-tripping the candidate back through the zone.
 */
/** True when an instant, read in a zone, shows exactly this wall-clock time. */
const showsLocalTime = (
  instantMs: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): boolean => {
  const parts = localPartsAt(instantMs, timeZone);
  return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
};

/**
 * The instant at which a zone's UTC offset changes, bracketed by two readings
 * that straddle the transition. "Clocks go forward" always increases the UTC
 * offset, so the numerically smaller offset is unambiguously the pre-transition
 * one, and bisecting on it lands on the transition to the millisecond.
 */
function transitionInstant(low: number, high: number, timeZone: string): number {
  const preOffset = Math.min(offsetAt(low, timeZone), offsetAt(high, timeZone));
  let lo = low;
  let hi = high;
  // 1s resolution is finer than any real-world zone transition, so this always
  // converges without depending on the platform's transition granularity.
  for (let guard = 0; guard < 64 && hi - lo > 1000; guard += 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetAt(mid, timeZone) === preOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The UTC instant at which a local wall-clock time occurs in a zone.
 *
 * Two pathological local times are resolved by an explicit, documented rule so
 * the answer is deterministic rather than dependent on the platform:
 *
 *   - Ambiguous (clocks go back, so the wall time happens twice): the EARLIER
 *     occurrence wins, so a daily run never fires an hour late.
 *   - Nonexistent (clocks go forward, so the wall time never happens): the
 *     instant the gap CLOSES wins, so the run happens instead of being skipped.
 *
 * Both are decided by round-tripping candidate instants back through the zone
 * and reading the result, never by assuming which offset applies.
 */
export function localTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // Every offset in play near this wall time, so a candidate reading either side
  // of a transition is tried rather than guessed.
  const guesses = new Set<number>();
  for (const offset of [offsetAt(wall, timeZone), offsetAt(wall - 12 * 3600000, timeZone), offsetAt(wall + 12 * 3600000, timeZone)]) {
    const guess = wall - offset;
    guesses.add(guess);
    guesses.add(wall - offsetAt(guess, timeZone));
  }
  const verified = [...guesses].filter(guess => showsLocalTime(guess, year, month, day, hour, minute, timeZone));
  if (verified.length) return Math.min(...verified);
  // No reading reproduces the requested wall time: it fell in a gap.
  const all = [...guesses];
  return transitionInstant(Math.min(...all), Math.max(...all), timeZone);
}

/** Adds whole days to a calendar date, independent of any zone. */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Weekday of a calendar date, 0 = Sunday. Computed on the date itself so zone
 *  rules can never shift which weekday a weekly schedule lands on. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The next UTC instant a schedule should run at, strictly after `afterMs`.
 *
 * Interval frequencies step by exact elapsed time. DAILY and WEEKLY step to the
 * anchored local wall-clock time, which is what makes them mean what a user
 * expects: "daily at 09:00 in Europe/Berlin" stays 09:00 local on both sides of a
 * DST change, so its UTC instant shifts and its local time does not.
 *
 * Returns null only for an unsupported frequency, which validation rejects
 * before a schedule can ever hold one.
 */
export function nextRunAtFor(
  frequency: ScheduleFrequency,
  timeZone: string,
  anchorLocalMinutes: number,
  anchorWeekday: number,
  afterMs: number,
): number | null {
  const interval = INTERVAL_FREQUENCIES[frequency];
  if (interval !== undefined) return afterMs + interval;
  if (frequency !== "DAILY" && frequency !== "WEEKLY") return null;

  const hour = Math.floor(anchorLocalMinutes / 60);
  const minute = anchorLocalMinutes % 60;
  // Start from the local calendar day AFTER the anchor instant's own day, so the
  // result is always strictly in the future. Today's slot is offered by a later
  // step instead of being skipped when it has not arrived yet.
  const here = localPartsAt(afterMs, timeZone);
  let day = addDays(here.year, here.month, here.day, 1);

  if (frequency === "WEEKLY") {
    const ahead = (anchorWeekday - weekdayOf(day.year, day.month, day.day) + 7) % 7;
    day = addDays(day.year, day.month, day.day, ahead);
  }

  // Step forward until the local time is genuinely in the future. Bounded so a
  // pathological zone cannot spin.
  for (let step = 0; step <= 8; step += 1) {
    const instant = localTimeToInstant(day.year, day.month, day.day, hour, minute, timeZone);
    if (instant > afterMs) return instant;
    day = addDays(day.year, day.month, day.day, 1);
  }
  return null;
}

export type ScheduleStoreOptions = {
  /** Injectable clock, so tests never wait in real time. */
  now?: () => number;
};

/**
 * Persistent schedules and their execution history.
 *
 * Every mutation is validated and persisted before it is reported as done, and
 * a persistence failure is returned as a 500 rather than swallowed — the caller
 * must never be told a schedule was saved when it was not.
 */
export class ScheduleStore {
  private readonly path: string;
  private readonly now: () => number;
  private data: ScheduleFile;
  /** Projects with a dispatch in flight in THIS process. */
  private readonly dispatching = new Set<string>();
  /** Set while a tick is running, so ticks never overlap. */
  private ticking = false;

  constructor(filePath: string, options: ScheduleStoreOptions = {}) {
    this.path = resolve(filePath);
    this.now = options.now ?? (() => Date.now());
    this.data = this.load();
  }

  get filePath(): string {
    return this.path;
  }

  private load(): ScheduleFile {
    if (!existsSync(this.path)) return emptyFile();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
      const file = parsed as Partial<ScheduleFile>;
      // One malformed record is dropped, never allowed to abort the load: a bad
      // schedule must not be able to stop every other schedule from running.
      return {
        schemaVersion: 1,
        schedules: Array.isArray(file.schedules) ? file.schedules.filter(isProjectSchedule) : [],
        executions: Array.isArray(file.executions) ? file.executions.filter(isScheduledExecution) : [],
      };
    } catch {
      return emptyFile();
    }
  }

  private persist(): ScheduleResult<true> {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      atomicWriteText(this.path, JSON.stringify(this.data, null, 2));
      return { ok: true, value: true };
    } catch {
      return { ok: false, status: 500, error: "The schedule could not be saved. Check that the data directory is writable." };
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(): ProjectSchedule[] {
    return [...this.data.schedules].sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  get(scheduleIdOrProjectId: string): ProjectSchedule | null {
    const clean = sanitizeId(scheduleIdOrProjectId);
    return (
      this.data.schedules.find(schedule => schedule.id === clean) ??
      this.data.schedules.find(schedule => schedule.projectId === clean) ??
      null
    );
  }

  forProject(projectId: string): ProjectSchedule | null {
    const clean = sanitizeId(projectId);
    return this.data.schedules.find(schedule => schedule.projectId === clean) ?? null;
  }

  /** Execution history for one schedule, newest first. Never synthesized. */
  executionsFor(scheduleIdOrProjectId: string): ScheduledExecution[] {
    const schedule = this.get(scheduleIdOrProjectId);
    const projectId = sanitizeId(scheduleIdOrProjectId);
    return this.data.executions
      .filter(execution => (schedule ? execution.scheduleId === schedule.id : execution.projectId === projectId))
      .sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : a.scheduledFor > b.scheduledFor ? -1 : b.executionId.localeCompare(a.executionId)));
  }

  /** True when this process already has a dispatch in flight for a project. */
  isDispatching(projectId: string): boolean {
    return this.dispatching.has(sanitizeId(projectId));
  }

  markDispatching(projectId: string, active: boolean): void {
    const clean = sanitizeId(projectId);
    if (active) this.dispatching.add(clean);
    else this.dispatching.delete(clean);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Creates or replaces the schedule for a project. A project has at most one
   * schedule, so this is idempotent: the existing row is updated rather than a
   * second one appearing.
   *
   * Editing never rewrites execution history, and changing the frequency or zone
   * recomputes nextRunAt from the real current time so the schedule cannot claim
   * to be due at a moment that has already passed.
   */
  upsert(
    projectId: string,
    input: { enabled?: unknown; frequency?: unknown; timezone?: unknown },
    nowMs: number = this.now(),
  ): ScheduleResult<ProjectSchedule> {
    const cleanProjectId = sanitizeId(projectId);
    if (!cleanProjectId) return { ok: false, status: 400, error: "Invalid project id." };

    const frequency = input.frequency ?? "DAILY";
    if (!isFrequency(frequency)) {
      return { ok: false, status: 400, error: `Choose a frequency: ${SCHEDULE_FREQUENCIES.join(", ")}.` };
    }
    const timezone = input.timezone ?? "UTC";
    if (!isValidTimeZone(timezone)) {
      return { ok: false, status: 400, error: "Choose a valid IANA timezone, for example Europe/Berlin or America/New_York." };
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      return { ok: false, status: 400, error: "enabled must be true or false." };
    }
    const enabled = input.enabled === undefined ? true : input.enabled;

    const existing = this.forProject(cleanProjectId);
    const now = new Date(nowMs).toISOString();
    // An edit that keeps frequency and timezone keeps the existing anchor, so
    // editing a schedule never silently moves the local wall-clock time a daily
    // or weekly schedule was created for. Changing either one re-anchors,
    // because the previous anchor means something different in the new zone.
    const previous = existing ?? null;
    const reanchor = previous !== null && (previous.frequency !== frequency || previous.timezone !== timezone);
    const anchor = previous !== null && !reanchor
      ? { anchorLocalMinutes: previous.anchorLocalMinutes, anchorWeekday: previous.anchorWeekday }
      : this.localAnchorOf(frequency, timezone, nowMs);
    const nextRunAt = this.isoOrNull(enabled ? this.computeNextRunAt(frequency, timezone, anchor, nowMs) : null);

    const schedule: ProjectSchedule = existing
      ? {
          ...existing,
          enabled,
          frequency,
          timezone,
          nextRunAt,
          updatedAt: now,
          version: existing.version + 1,
          // The local anchors follow the zone, so a zone change re-anchors the
          // schedule to the local time it is being edited at.
          anchorLocalMinutes: anchor.anchorLocalMinutes,
          anchorWeekday: anchor.anchorWeekday,
        }
      : {
          id: `sch-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`,
          projectId: cleanProjectId,
          enabled,
          frequency,
          timezone,
          createdAt: now,
          updatedAt: now,
          nextRunAt,
          lastRunAt: null,
          lastRunId: null,
          lastExecutionStatus: null,
          consecutiveFailures: 0,
          version: 1,
          anchorLocalMinutes: anchor.anchorLocalMinutes,
          anchorWeekday: anchor.anchorWeekday,
        };

    if (existing) {
      this.data.schedules = this.data.schedules.map(entry => (entry.id === existing.id ? schedule : entry));
    } else {
      this.data.schedules = [...this.data.schedules, schedule];
    }
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: schedule };
  }

  /**
   * Turns a schedule on. Disabling preserved every execution record, so
   * re-enabling restores the schedule's own history rather than starting fresh.
   */
  setEnabled(projectId: string, enabled: boolean, nowMs: number = this.now()): ScheduleResult<ProjectSchedule> {
    const schedule = this.forProject(projectId);
    if (!schedule) return { ok: false, status: 404, error: "This project has no QA schedule." };
    const now = new Date(nowMs).toISOString();
    schedule.enabled = enabled;
    schedule.updatedAt = now;
    schedule.version += 1;
    // Coming back from disabled, the next slot is recomputed from now: a slot
    // that passed while the schedule was off is not backfilled.
    schedule.nextRunAt = this.isoOrNull(enabled ? this.computeNextRunAt(schedule.frequency, schedule.timezone, schedule, nowMs) : null);
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: { ...schedule } };
  }

  /** Removes the schedule row only. Execution history is deliberately kept. */
  remove(scheduleId: string): ScheduleResult<{ id: string; keptExecutions: number }> {
    const schedule = this.get(scheduleId);
    if (!schedule) return { ok: false, status: 404, error: "That schedule does not exist." };
    // Counted before the row goes, because once it is gone the executions can only
    // be reached by project id.
    const keptExecutions = this.executionsFor(schedule.id).length;
    this.data.schedules = this.data.schedules.filter(entry => entry.id !== schedule.id);
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: { id: schedule.id, keptExecutions } };
  }

  // -------------------------------------------------------------------------
  // Due-schedule claiming
  // -------------------------------------------------------------------------

  /** Enabled schedules whose next slot has arrived, oldest due time first. */
  dueSchedules(nowMs: number = this.now()): ProjectSchedule[] {
    return this.data.schedules
      .filter(schedule => schedule.enabled && schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) <= nowMs)
      .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : a.nextRunAt! > b.nextRunAt! ? 1 : a.id.localeCompare(b.id)));
  }

  /**
   * Atomically claims one due schedule and advances its next slot, writing the
   * execution record in the same persist.
   *
   * The claim is synchronous end to end and there is no await inside it, so a
   * second tick cannot observe the half-claimed state; and because the advanced
   * nextRunAt is written in the SAME atomic document as the new execution, a
   * crash between the two is impossible. Returns null when the schedule is no
   * longer due, which is exactly how a duplicate dispatch is rejected.
   */
  claimDue(
    scheduleId: string,
    options: { nowMs?: number; trigger?: ScheduleTrigger; runId?: string } = {},
  ): ScheduleResult<ScheduledExecution> {
    const nowMs = options.nowMs ?? this.now();
    const trigger = options.trigger ?? "SCHEDULER";
    // A manual trigger is an explicit request, so it claims whether or not the
    // slot is due. It still requires the schedule to be enabled, and it still
    // advances nextRunAt, so it cannot collide with the slot it jumps ahead of.
    const manual = trigger === "MANUAL_TRIGGER";
    const schedule = this.data.schedules.find(entry => entry.id === sanitizeId(scheduleId));
    if (!schedule) return { ok: false, status: 404, error: "That schedule does not exist." };
    if (!schedule.enabled) return { ok: false, status: 409, error: "This schedule is not enabled." };
    if (manual && schedule.nextRunAt === null) {
      return { ok: false, status: 409, error: "This schedule has no next run time." };
    }
    if (!manual && (schedule.nextRunAt === null || Date.parse(schedule.nextRunAt) > nowMs)) {
      return { ok: false, status: 409, error: "This schedule is not due right now." };
    }

    const scheduledFor = schedule.nextRunAt;
    // Non-null for both paths: a manual trigger requires it, and a timed claim
    // only reaches here once the due check has passed.
    if (scheduledFor === null) return { ok: false, status: 409, error: "This schedule has no next run time." };
    const execution: ScheduledExecution = {
      executionId: `exe-${nowMs.toString(36)}-${randomBytes(4).toString("hex")}`,
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      scheduledFor,
      startedAt: null,
      completedAt: null,
      runId: options.runId ?? null,
      status: "QUEUED",
      detail: null,
      trigger,
      version: 1,
    };

    // Advance past the claimed slot BEFORE anything can fail, so a slot is never
    // dispatched twice because a later step of this dispatch threw.
    schedule.nextRunAt = this.isoOrNull(this.computeNextRunAt(schedule.frequency, schedule.timezone, schedule, nowMs));
    schedule.updatedAt = new Date(nowMs).toISOString();
    schedule.version += 1;
    this.data.executions = [...this.data.executions, execution];

    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: execution };
  }

  /**
   * Records an execution that will never run because the Project is gone. Kept
   * separate from claiming so no slot is consumed for it: the next slot is
   * still advanced, because a deleted project will stay deleted.
   */
  recordMissingProject(projectId: string, scheduledFor: string, detail: string, nowMs: number = this.now()): ScheduleResult<ScheduledExecution> {
    const schedule = this.forProject(projectId);
    if (!schedule) return { ok: false, status: 404, error: "That project has no QA schedule." };
    const execution: ScheduledExecution = {
      executionId: `exe-${nowMs.toString(36)}-${randomBytes(4).toString("hex")}`,
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      scheduledFor,
      startedAt: null,
      completedAt: nowMs > Date.parse(scheduledFor) ? new Date(nowMs).toISOString() : null,
      runId: null,
      status: "SKIPPED_PROJECT_MISSING",
      detail: detail.slice(0, 200),
      trigger: "SCHEDULER",
      version: 1,
    };
    schedule.nextRunAt = this.isoOrNull(this.computeNextRunAt(schedule.frequency, schedule.timezone, schedule, nowMs));
    schedule.lastExecutionStatus = execution.status;
    schedule.updatedAt = new Date(nowMs).toISOString();
    schedule.version += 1;
    this.data.executions = [...this.data.executions, execution];
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: execution };
  }

  /** Records a skip because the Project already had a run in progress. */
  recordSkippedOverlap(projectId: string, scheduledFor: string, detail: string, nowMs: number = this.now()): ScheduleResult<ScheduledExecution> {
    return this.recordTerminal(projectId, scheduledFor, "SKIPPED_OVERLAPPING_RUN", detail, nowMs);
  }

  /** Records a cancellation, which only exists where a run can actually be
   *  cancelled. The schedule row and its history both survive. */
  recordCancelled(projectId: string, scheduledFor: string, detail: string, nowMs: number = this.now()): ScheduleResult<ScheduledExecution> {
    return this.recordTerminal(projectId, scheduledFor, "CANCELLED", detail, nowMs);
  }

  private recordTerminal(
    projectId: string,
    scheduledFor: string,
    status: ScheduleExecutionStatus,
    detail: string,
    nowMs: number,
  ): ScheduleResult<ScheduledExecution> {
    const schedule = this.forProject(projectId);
    if (!schedule) return { ok: false, status: 404, error: "That project has no QA schedule." };
    const execution: ScheduledExecution = {
      executionId: `exe-${nowMs.toString(36)}-${randomBytes(4).toString("hex")}`,
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      scheduledFor,
      startedAt: null,
      completedAt: new Date(nowMs).toISOString(),
      runId: null,
      status,
      detail: detail.slice(0, 200),
      trigger: "SCHEDULER",
      version: 1,
    };
    // The slot is consumed even though no run happened, so the schedule must move
    // on. Without this the slot would stay due and be skipped again on every tick.
    schedule.nextRunAt = this.isoOrNull(this.computeNextRunAt(schedule.frequency, schedule.timezone, schedule, nowMs));
    schedule.lastExecutionStatus = status;
    schedule.updatedAt = new Date(nowMs).toISOString();
    schedule.version += 1;
    this.data.executions = [...this.data.executions, execution];
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: execution };
  }

  // -------------------------------------------------------------------------
  // Execution lifecycle
  // -------------------------------------------------------------------------

  /** Associates a real run with a claimed execution and marks it RUNNING. */
  markRunning(executionId: string, runId: string, nowMs: number = this.now()): ScheduleResult<ScheduledExecution> {
    return this.updateExecution(executionId, nowMs, execution => ({
      ...execution,
      // A run id is only ever written from the id RunManager actually issued.
      runId: sanitizeId(runId),
      startedAt: execution.startedAt ?? new Date(nowMs).toISOString(),
      status: "RUNNING",
      detail: null,
      version: execution.version + 1,
    }));
  }

  /** The real outcome of a run. `COMPLETED` requires a real run id. */
  markSettled(
    executionId: string,
    outcome: { ok: boolean; runId: string | null; qaStatus: string | null; detail?: string | null },
    nowMs: number = this.now(),
  ): ScheduleResult<ScheduledExecution> {
    const status: ScheduleExecutionStatus = outcome.ok ? "COMPLETED" : "FAILED";
    if (outcome.ok && !outcome.runId) {
      // Defensive: a completion without a real run id is not a completion.
      return this.updateExecution(executionId, nowMs, execution => ({
        ...execution,
        status: "FAILED",
        completedAt: new Date(nowMs).toISOString(),
        detail: "The run reported success without a real run id, so it was recorded as failed.",
        version: execution.version + 1,
      }));
    }
    return this.updateExecution(executionId, nowMs, execution => {
      const settled: ScheduledExecution = {
        ...execution,
        runId: outcome.runId ? sanitizeId(outcome.runId) : execution.runId,
        startedAt: execution.startedAt ?? new Date(nowMs).toISOString(),
        completedAt: new Date(nowMs).toISOString(),
        status,
        detail: outcome.detail ? outcome.detail.slice(0, 200) : outcome.ok ? null : `QA run reported ${outcome.qaStatus ?? "no verdict"}.`,
        version: execution.version + 1,
      };
      this.applyOutcomeToSchedule(settled, nowMs);
      return settled;
    });
  }

  /** Applies one execution's outcome to its schedule's own bookkeeping. */
  private applyOutcomeToSchedule(execution: ScheduledExecution, nowMs: number): void {
    const schedule = this.data.schedules.find(entry => entry.id === execution.scheduleId);
    if (!schedule) return;
    // A skip or a failed start has no run behind it, so it must never erase
    // the id of the last run that actually happened. `lastRunId` describes a
    // real run; `lastExecutionStatus` describes the latest slot.
    if (execution.runId) {
      schedule.lastRunId = execution.runId;
      schedule.lastRunAt = execution.completedAt ?? execution.startedAt ?? new Date(nowMs).toISOString();
    }
    schedule.lastExecutionStatus = execution.status;
    // A real failure counts; a skip (overlap, missing project, cancellation) is
    // not the project's fault and must not look like an unhealthy schedule.
    schedule.consecutiveFailures = execution.status === "FAILED" ? schedule.consecutiveFailures + 1 : 0;
    schedule.updatedAt = new Date(nowMs).toISOString();
    schedule.version += 1;
  }

  private updateExecution(
    executionId: string,
    nowMs: number,
    change: (execution: ScheduledExecution) => ScheduledExecution,
  ): ScheduleResult<ScheduledExecution> {
    const clean = sanitizeId(executionId);
    const index = this.data.executions.findIndex(execution => execution.executionId === clean);
    if (index === -1) return { ok: false, status: 404, error: "That scheduled execution does not exist." };
    const next = change(this.data.executions[index]!);
    this.data.executions = this.data.executions.map((execution, position) => (position === index ? next : execution));
    const saved = this.persist();
    if (!saved.ok) return saved;
    return { ok: true, value: next };
  }

  // -------------------------------------------------------------------------
  // Restart recovery
  // -------------------------------------------------------------------------

  /**
   * Reconciles executions left QUEUED or RUNNING by a process that went away.
   *
   * Nothing is assumed to have succeeded. An execution is only reconciled to
   * COMPLETED when the caller proves it — by finding the real run's real report
   * artifact — and is otherwise recorded as INTERRUPTED with the run id left as
   * whatever was genuinely known. An uncertain execution is never re-dispatched;
   * the next slot continues on its own schedule.
   */
  recover(
    proveCompleted: (execution: ScheduledExecution) => { completed: boolean; qaStatus?: string | null },
    nowMs: number = this.now(),
  ): { reconciled: ScheduledExecution[]; interrupted: ScheduledExecution[] } {
    const settled = this.data.executions.filter(execution => UNSETTLED_STATUSES.includes(execution.status));
    if (!settled.length) return { reconciled: [], interrupted: [] };

    const reconciled: ScheduledExecution[] = [];
    const interrupted: ScheduledExecution[] = [];
    for (const execution of settled) {
      let proof: { completed: boolean; qaStatus?: string | null };
      try {
        proof = proveCompleted(execution);
      } catch {
        // An unreadable artifact is not proof of anything.
        proof = { completed: false };
      }
      const next: ScheduledExecution = proof.completed
        ? {
            ...execution,
            status: "COMPLETED",
            completedAt: execution.completedAt ?? new Date(nowMs).toISOString(),
            detail: null,
            version: execution.version + 1,
          }
        : {
            ...execution,
            status: "INTERRUPTED",
            completedAt: new Date(nowMs).toISOString(),
            detail: "The server restarted while this scheduled run was in flight, and no completed report artifact was found for it.",
            version: execution.version + 1,
          };
      this.applyOutcomeToSchedule(next, nowMs);
      this.data.executions = this.data.executions.map(entry => (entry.executionId === next.executionId ? next : entry));
      (proof.completed ? reconciled : interrupted).push(next);
    }
    this.persist();
    return { reconciled, interrupted };
  }

  /** The next upcoming slots across enabled schedules, soonest first. */
  upcoming(limit = 20): { scheduleId: string; projectId: string; nextRunAt: string }[] {
    return this.data.schedules
      .filter(schedule => schedule.enabled && schedule.nextRunAt !== null)
      .map(schedule => ({ scheduleId: schedule.id, projectId: schedule.projectId, nextRunAt: schedule.nextRunAt! }))
      .sort((a, b) => (a.nextRunAt < b.nextRunAt ? -1 : a.nextRunAt > b.nextRunAt ? 1 : a.scheduleId.localeCompare(b.scheduleId)))
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isoOrNull(value: number | null): string | null {
    return value === null ? null : new Date(value).toISOString();
  }

  private computeNextRunAt(
    frequency: ScheduleFrequency,
    timezone: string,
    anchor: { anchorLocalMinutes: number; anchorWeekday: number },
    afterMs: number,
  ): number | null {
    return nextRunAtFor(frequency, timezone, anchor.anchorLocalMinutes, anchor.anchorWeekday, afterMs);
  }

  /** The local wall-clock anchors a new schedule starts from: the local time it
   *  was created at, which is the only local time a user has expressed. */
  private localAnchorOf(frequency: ScheduleFrequency, timezone: string, nowMs: number): { anchorLocalMinutes: number; anchorWeekday: number } {
    const local = localPartsAt(nowMs, timezone);
    return {
      anchorLocalMinutes: local.hour * 60 + local.minute,
      // A weekly schedule keeps the weekday it was created on.
      anchorWeekday: frequency === "WEEKLY" ? local.weekday : 0,
    };
  }

  }

/** Persisted shape guards. A record that does not match is dropped on load. */
function isProjectSchedule(value: unknown): value is ProjectSchedule {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ProjectSchedule>;
  return (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    typeof entry.projectId === "string" &&
    entry.projectId !== "" &&
    typeof entry.enabled === "boolean" &&
    isFrequency(entry.frequency) &&
    isValidTimeZone(entry.timezone) &&
    typeof entry.createdAt === "string" &&
    Number.isFinite(Date.parse(entry.createdAt)) &&
    typeof entry.updatedAt === "string" &&
    Number.isFinite(Date.parse(entry.updatedAt)) &&
    // nextRunAt is nullable but must be a real instant when present, so a bad
    // value can never make a schedule look permanently due.
    (entry.nextRunAt === null || (typeof entry.nextRunAt === "string" && Number.isFinite(Date.parse(entry.nextRunAt)))) &&
    (entry.lastRunAt === null || (typeof entry.lastRunAt === "string" && Number.isFinite(Date.parse(entry.lastRunAt)))) &&
    (entry.lastRunId === null || typeof entry.lastRunId === "string") &&
    (entry.lastExecutionStatus === null || isExecutionStatus(entry.lastExecutionStatus)) &&
    typeof entry.consecutiveFailures === "number" &&
    Number.isInteger(entry.consecutiveFailures) &&
    entry.consecutiveFailures >= 0 &&
    typeof entry.version === "number" &&
    Number.isInteger(entry.version) &&
    entry.version >= 1 &&
    // Anchors are bounded, so a corrupt value cannot drive nextRunAt into an
    // unbounded loop when it is converted back to a local time.
    typeof entry.anchorLocalMinutes === "number" &&
    Number.isInteger(entry.anchorLocalMinutes) &&
    entry.anchorLocalMinutes >= 0 &&
    entry.anchorLocalMinutes <= 1439 &&
    typeof entry.anchorWeekday === "number" &&
    Number.isInteger(entry.anchorWeekday) &&
    entry.anchorWeekday >= 0 &&
    entry.anchorWeekday <= 6
  );
}

function isScheduledExecution(value: unknown): value is ScheduledExecution {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ScheduledExecution>;
  return (
    typeof entry.executionId === "string" &&
    entry.executionId !== "" &&
    typeof entry.scheduleId === "string" &&
    entry.scheduleId !== "" &&
    typeof entry.projectId === "string" &&
    entry.projectId !== "" &&
    typeof entry.scheduledFor === "string" &&
    Number.isFinite(Date.parse(entry.scheduledFor)) &&
    (entry.startedAt === null || (typeof entry.startedAt === "string" && Number.isFinite(Date.parse(entry.startedAt)))) &&
    (entry.completedAt === null || (typeof entry.completedAt === "string" && Number.isFinite(Date.parse(entry.completedAt)))) &&
    (entry.runId === null || typeof entry.runId === "string") &&
    isExecutionStatus(entry.status) &&
    (entry.detail === null || typeof entry.detail === "string") &&
    (entry.trigger === "SCHEDULER" || entry.trigger === "MANUAL_TRIGGER") &&
    typeof entry.version === "number" &&
    Number.isInteger(entry.version) &&
    entry.version >= 1
  );
}

/** Where the schedule document lives, beside the saved-projects document. */
export function defaultSchedulesPath(reportDir: string): string {
  return join(reportDir, "projects", "schedules.json");
}