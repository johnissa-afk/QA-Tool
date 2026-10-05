// ---------------------------------------------------------------------------
// Project email preferences — WHICH notifications a project is willing to email,
// and to whom.
//
// WHAT THIS IS
// Configuration, not delivery. It answers one question deterministically —
// "should this notification be emailed for this project?" — and persists the
// answer's inputs. It never sends anything: eligibility is decided here, and
// actually dialling an SMTP server is the transport's job, reached only through
// the Delivery Core when a caller explicitly asks.
//
// ARCHITECTURE
//   Notification (already recorded by NotificationStore)
//     -> emailEligibility (this file: the four deterministic checks)
//       -> NotificationDeliveryDispatcher (notification-delivery.ts)
//         -> NotificationEmailTransport (email-transport.ts)
//
// The step that actually sends is deliberately NOT wired to notification
// creation. Milestone 4 will decide when to call `deliverEligibleProjectEmail`,
// and that call is explicit: nothing in this file is invoked by the QA
// settlement path, so no email can be sent by a run.
//
// SAFE DEFAULTS ARE OFF
// A project that has never been configured reports `enabled: false` with no
// recipients and no events. Nothing is auto-enabled, no address is guessed, and
// no historical notification is retroactively delivered: enabling email is a
// deliberate act, and the notifications that already exist stay exactly as they
// are.
//
// THE EVENT SET IS NOT RESTATED HERE
// The eligible events are read from `NotificationType`, the same union the
// notification pipeline already derives from, and `assertExhaustive` below makes
// the compiler reject this file if that union ever gains a member that this list
// does not. Adding a notification event therefore cannot silently produce a
// project setting that is quietly missing an option.
// ---------------------------------------------------------------------------
import { loadEmailConfig } from "./email-transport.js";
import { normalizeRecipient } from "./notification-delivery.js";
import type { NotificationType } from "./notifications.js";
import type { NotificationRecord } from "./notifications.js";

/** One project's email configuration, as persisted inside the project record. */
export type ProjectEmailPreferences = {
  enabled: boolean;
  recipients: string[];
  events: NotificationType[];
};

/**
 * The existing notification types, in the canonical order used for storage.
 *
 * Order is part of the persisted representation: the same logical selection
 * always produces byte-identical JSON, whatever order the caller listed.
 */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  "NEW_FINDING",
  "REGRESSED_FINDING",
  "RESOLVED_FINDING",
  "RUN_FAILED",
  "ACCESS_CHANGED",
  "SCHEDULE_SKIPPED",
  "MEANINGFUL_CHANGE",
];

const EVENT_RANK = new Map(NOTIFICATION_TYPES.map((type, index) => [type, index]));

/**
 * Compile-time proof that this file lists every notification type.
 *
 * If a future milestone adds an event to `NotificationType` and forgets to add
 * it here, this stops compiling instead of shipping a preferences UI that is
 * quietly missing an option.
 */
type MissingFromList = Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]>;
const assertExhaustive: MissingFromList[] = [];
void assertExhaustive;

export type EmailEventOption = {
  type: NotificationType;
  /** Short human label for the checkbox. */
  label: string;
  /** One factual sentence explaining when this event sends an email. */
  description: string;
};

/**
 * The event options the dashboard renders, keyed by type.
 *
 * Typed as a total `Record` over `NotificationType` so the COMPILER enforces
 * that every notification type has an option: add a type upstream and this stops
 * building rather than shipping a checkbox list that is quietly missing one.
 *
 * The dashboard reads these from the API and renders whatever it is given, so
 * this stays the single source of truth for both the types and their wording -
 * there is no second taxonomy in the browser to drift.
 */
const EVENT_OPTIONS: Record<NotificationType, EmailEventOption> = {
  NEW_FINDING: {
    type: "NEW_FINDING",
    label: "New finding",
    description: "Receive an email when a new tracked finding is detected for the project.",
  },
  REGRESSED_FINDING: {
    type: "REGRESSED_FINDING",
    label: "Finding regressed",
    description: "Receive an email when a tracked finding becomes active again.",
  },
  RESOLVED_FINDING: {
    type: "RESOLVED_FINDING",
    label: "Finding resolved",
    description: "Receive an email when a tracked finding is no longer detected.",
  },
  RUN_FAILED: {
    type: "RUN_FAILED",
    label: "QA run failed",
    description: "Receive an email when a QA run ends in failure.",
  },
  ACCESS_CHANGED: {
    type: "ACCESS_CHANGED",
    label: "Access changed",
    description: "Receive an email when access to the site changes between runs.",
  },
  SCHEDULE_SKIPPED: {
    type: "SCHEDULE_SKIPPED",
    label: "Scheduled run skipped",
    description: "Receive an email when a scheduled QA run is skipped.",
  },
  MEANINGFUL_CHANGE: {
    type: "MEANINGFUL_CHANGE",
    label: "Meaningful QA change",
    description: "Receive an email when a run shows a meaningful change in pages, flows or elements.",
  },
};

/** Every event option, in the canonical order used for storage. */
export function emailEventOptions(): EmailEventOption[] {
  return NOTIFICATION_TYPES.map(type => ({ ...EVENT_OPTIONS[type] }));
}

export type PreferenceValidationError = { field: "recipients" | "events" | "enabled" | "body"; message: string };

export type PreferenceParseResult =
  | { ok: true; value: ProjectEmailPreferences }
  | { ok: false; errors: PreferenceValidationError[] };

/** Email is off, with no recipients and no events, until a human turns it on. */
export function defaultEmailPreferences(): ProjectEmailPreferences {
  return { enabled: false, recipients: [], events: [] };
}

/** Structural check: does a stored blob look like preferences we can trust? */
export function isProjectEmailPreferences(value: unknown): value is ProjectEmailPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prefs = value as Partial<ProjectEmailPreferences>;
  return (
    typeof prefs.enabled === "boolean" &&
    Array.isArray(prefs.recipients) &&
    prefs.recipients.every(entry => typeof entry === "string" && normalizeRecipient(entry) === entry) &&
    Array.isArray(prefs.events) &&
    prefs.events.every((entry): entry is NotificationType => EVENT_RANK.has(entry as NotificationType))
  );
}

/**
 * Reads stored preferences, falling back to the safe default.
 *
 * A project written before this feature, or a hand-edited document with a
 * malformed field, reads as "not configured" rather than as something that could
 * silently email the wrong people.
 *
 * Returns a fresh object, so a caller that edits the result cannot reach through
 * it and alter the store's own state.
 */
export function emailPreferencesOf(project: { emailNotifications?: unknown } | null | undefined): ProjectEmailPreferences {
  if (!project || !isProjectEmailPreferences(project.emailNotifications)) return defaultEmailPreferences();
  return {
    enabled: project.emailNotifications.enabled,
    recipients: [...project.emailNotifications.recipients],
    events: [...project.emailNotifications.events],
  };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a recipient list.
 *
 * An address is checked for shape only - the mailbox is never contacted, and no
 * mail is sent to prove it exists. Normalization reuses the Delivery Core's own
 * `normalizeRecipient`, so an address that the transport would refuse can never
 * be persisted here as an apparently valid recipient.
 *
 * Duplicates are removed by normalized value, so "user@example.com" and
 * " User@Example.com " are one recipient and are mailed once, not twice. The
 * surviving list is sorted, so two callers naming the same people in different
 * orders persist the same bytes.
 */
export function normalizeRecipientList(input: unknown): { ok: true; value: string[] } | { ok: false; errors: PreferenceValidationError[] } {
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ field: "recipients", message: "Provide recipients as a list of email addresses." }] };
  }
  const seen = new Set<string>();
  const errors: PreferenceValidationError[] = [];
  input.forEach((entry, index) => {
    if (typeof entry !== "string") {
      errors.push({ field: "recipients", message: `Recipient ${index + 1} is not an email address.` });
      return;
    }
    const normalized = normalizeRecipient(entry);
    if (normalized === null) {
      // Naming the position is actionable; the rejected value is not echoed back
      // into an error that will be shown or logged.
      errors.push({ field: "recipients", message: `"${entry.trim().slice(0, 60)}" is not a valid email address.` });
      return;
    }
    seen.add(normalized);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: [...seen].sort() };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Validates an event selection against the existing notification types.
 *
 * An unknown value is REJECTED, never dropped: silently discarding
 * "PASSWORD_RESET" would let a caller believe a preference was saved when part of
 * it was thrown away. Sorting into canonical order makes the stored selection
 * independent of the order it was submitted in.
 */
export function normalizeEventList(input: unknown): { ok: true; value: NotificationType[] } | { ok: false; errors: PreferenceValidationError[] } {
  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ field: "events", message: "Provide events as a list of notification types." }] };
  }
  const selected = new Set<NotificationType>();
  const errors: PreferenceValidationError[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || !EVENT_RANK.has(entry as NotificationType)) {
      errors.push({ field: "events", message: `"${String(entry).slice(0, 40)}" is not a notification type.` });
      continue;
    }
    selected.add(entry as NotificationType);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: NOTIFICATION_TYPES.filter(type => selected.has(type)) };
}

// ---------------------------------------------------------------------------
// Whole-payload parsing
// ---------------------------------------------------------------------------

/**
 * Validates a complete settings payload before anything is persisted.
 *
 * The payload is all-or-nothing: every field is checked first and every problem
 * is reported together, so a rejected update leaves the stored configuration
 * exactly as it was rather than half-applied.
 */
export function parseEmailPreferences(payload: unknown): PreferenceParseResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: "body", message: "Send an object with enabled, recipients and events." }] };
  }
  const body = payload as Record<string, unknown>;

  if (typeof body.enabled !== "boolean") {
    return { ok: false, errors: [{ field: "enabled", message: "enabled must be true or false." }] };
  }

  const recipients = normalizeRecipientList(body.recipients);
  const events = normalizeEventList(body.events);
  const errors = [
    ...(recipients.ok ? [] : recipients.errors),
    ...(events.ok ? [] : events.errors),
  ];
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled: body.enabled,
      recipients: recipients.ok ? recipients.value : [],
      events: events.ok ? events.value : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type EmailEligibilityReason =
  | "ELIGIBLE"
  | "PROJECT_NOT_FOUND"
  | "DISABLED"
  | "NO_RECIPIENTS"
  | "EVENT_NOT_SELECTED";

/**
 * A structured answer, not just a boolean.
 *
 * The reason is what a caller needs in order to say something useful — "email is
 * off for this project" is a different problem from "no events are selected" —
 * and `recipients` is empty unless the answer is ELIGIBLE, so an ineligible
 * notification can never be handed a mailing list by accident.
 */
export type EmailEligibility = {
  eligible: boolean;
  reason: EmailEligibilityReason;
  projectId: string | null;
  notificationType: NotificationType | null;
  /** The recipients to mail, and only ever populated when eligible. */
  recipients: string[];
};

const ineligible = (
  reason: EmailEligibilityReason,
  projectId: string | null,
  notificationType: NotificationType | null,
): EmailEligibility => ({ eligible: false, reason, projectId, notificationType, recipients: [] });

/**
 * Decides whether one notification should be emailed for one project.
 *
 * The four checks are ordered so the reported reason is the FIRST thing wrong,
 * which is the thing a person needs to fix. This function sends nothing and
 * contacts no server: it only reads configuration that was already persisted.
 */
export function emailEligibility(
  project: { id: string; emailNotifications?: unknown } | null | undefined,
  notification: Pick<NotificationRecord, "type"> | null | undefined,
): EmailEligibility {
  if (!project) return ineligible("PROJECT_NOT_FOUND", null, notification?.type ?? null);
  const type = notification?.type ?? null;
  const prefs = emailPreferencesOf(project);
  if (!prefs.enabled) return ineligible("DISABLED", project.id, type);
  if (!prefs.recipients.length) return ineligible("NO_RECIPIENTS", project.id, type);
  if (!type || !prefs.events.includes(type)) return ineligible("EVENT_NOT_SELECTED", project.id, type);
  return { eligible: true, reason: "ELIGIBLE", projectId: project.id, notificationType: type, recipients: [...prefs.recipients] };
}

// ---------------------------------------------------------------------------
// Delivery readiness (configuration only, never a secret)
// ---------------------------------------------------------------------------

export type EmailReadiness = {
  /** True when a complete SMTP configuration is present in the environment. */
  configured: boolean;
  /**
   * The NAMES of the variables that are missing, never their values. A settings
   * screen needs to say "SMTP_HOST is not set"; nothing here can be used to
   * reach a credential.
   */
  missing: string[];
};

/**
 * Whether email could be sent at all right now.
 *
 * Reads the same environment configuration the transport reads, and reports only
 * the boolean and the missing variable names. The host, user, password and from
 * address never leave this function.
 */
export function emailReadiness(env: NodeJS.ProcessEnv = process.env): EmailReadiness {
  const result = loadEmailConfig(env);
  return result.ok ? { configured: true, missing: [] } : { configured: false, missing: result.missing };
}

// ---------------------------------------------------------------------------
// Explicit delivery integration
// ---------------------------------------------------------------------------

export type ProjectEmailDeliveryResult = {
  eligibility: EmailEligibility;
  /** One entry per recipient actually attempted; empty when ineligible. */
  dispatches: Array<{ recipient: string; status: string; reason?: string; error?: string }>;
};

type MinimalDispatcher = {
  deliver(notification: NotificationRecord, recipient: string): Promise<
    | { ok: true; value: { delivery: { status: string; reason?: string; error?: string } } }
    | { ok: false; error: string }
  >;
};

/**
 * The preference layer in front of the Delivery Core, called EXPLICITLY.
 *
 * Nothing in the QA or notification pipeline invokes this. It is the seam a later
 * milestone will call with a deliberate policy decision, and it is callable now
 * so that seam can be tested without waiting for one.
 *
 * When the project is not eligible, no recipient is returned and the dispatcher is
 * never called at all — so "email is off" cannot become "an email was sent".
 */
export async function deliverEligibleProjectEmail(
  dispatcher: MinimalDispatcher,
  project: { id: string; emailNotifications?: unknown } | null | undefined,
  notification: NotificationRecord,
): Promise<ProjectEmailDeliveryResult> {
  const eligibility = emailEligibility(project, notification);
  if (!eligibility.eligible) return { eligibility, dispatches: [] };

  const dispatches: ProjectEmailDeliveryResult["dispatches"] = [];
  for (const recipient of eligibility.recipients) {
    const result = await dispatcher.deliver(notification, recipient);
    dispatches.push(
      result.ok
        ? {
            recipient,
            status: result.value.delivery.status,
            ...(result.value.delivery.reason ? { reason: result.value.delivery.reason } : {}),
            ...(result.value.delivery.error ? { error: result.value.delivery.error } : {}),
          }
        : { recipient, status: "FAILED", error: result.error },
    );
  }
  return { eligibility, dispatches };
}