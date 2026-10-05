// ---------------------------------------------------------------------------
// Notification -> email delivery. The AUTOMATIC half of production delivery.
//
// WHAT THIS IS
// The glue between three seams that already exist and none of which is changed
// here:
//   NotificationStore        already decided an event is real and stored it
//   deliverEligibleProjectEmail   already decides eligibility from preferences
//   NotificationDeliveryDispatcher   already owns identity, idempotency, retries
//   NotificationEmailTransport      already owns SMTP and redaction
//
// All this module adds is the ORDER: once the inbox has created a record, ask the
// preference layer whether that project wants it emailed, and hand the eligible
// ones to the dispatcher.
//
// WHY IT IS ITS OWN MODULE
// Notification creation must not be able to fail because a mail server did.
// So the dispatch is never awaited by, and never part of, the code that records a
// notification: `dispatchCreated` is called with records the inbox has ALREADY
// persisted, and it cannot throw. Delivery is an operational side effect of a QA
// event, not part of the event and never part of the QA verdict.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It does not decide whether an event happened (that is the existing derivation),
// it does not derive recipients (that is the preference layer), it does not send
// mail itself (that is the transport), it does not own a delivery store (that is
// the existing store), and it does not retry. A retry is a second call to the
// dispatcher, which numbers its own attempts; there is no queue and no worker here,
// because the milestone explicitly rules those out.
//
// SECRETS
// Nothing in this module reads, accepts or logs a credential. The only SMTP fact it
// can surface is whatever the transport already reduced into a delivery record, and
// the summary it returns carries only status, reason and a bounded error.
// ---------------------------------------------------------------------------
import type { NotificationRecord } from "./notifications.js";
import type { NotificationDeliveryDispatcher } from "./notification-delivery.js";
import {
  deliverEligibleProjectEmail,
  type EmailEligibilityReason,
  type ProjectEmailDeliveryResult,
} from "./project-email-preferences.js";

/**
 * Why a notification's automatic delivery did not complete.
 *
 * The first five are the project's own answer and come from the preference layer
 * unchanged. `DISPATCH_ERROR` is NOT an eligibility reason and is deliberately not
 * part of `EmailEligibilityReason`: it means this module could not get far enough to
 * find out. Reporting one of the eligibility reasons here would be a guess - most
 * importantly it would claim `PROJECT_NOT_FOUND` for what is usually a store or
 * transport failure, which sends the reader looking for a project that is right there.
 */
export type NotificationEmailReason = EmailEligibilityReason | "DISPATCH_ERROR";

/** What happened to one notification's automatic email delivery. */
export type NotificationEmailSummary = {
  notificationId: string;
  projectId: string;
  type: NotificationRecord["type"];
  /** False whenever the project did not want this event emailed. */
  eligible: boolean;
  /**
   * The FIRST reason the notification was not eligible, or ELIGIBLE. `DISPATCH_ERROR`
   * is not a judgement about the project: `eligible` is false for it only because no
   * delivery was attempted, and `results` is empty because nothing was ever asked.
   */
  reason: NotificationEmailReason;
  /**
   * One entry per recipient the dispatcher was asked about. Several recipients are
   * reported independently: a failure for one of them never becomes a success for
   * the others, and `results` is never collapsed into a single verdict.
   */
  results: ProjectEmailDeliveryResult["dispatches"];
};

export type NotificationEmailDispatchOptions = {
  /** The existing dispatcher. Identity, idempotency and retries are its job. */
  dispatcher: Pick<NotificationDeliveryDispatcher, "deliver">;
  /**
   * Reads the project a notification belongs to. Injected rather than imported so
   * this module cannot reach into project persistence, and so a test can drive the
   * PROJECT_NOT_FOUND path without a filesystem.
   */
  loadProject: (projectId: string) => { id: string; emailNotifications?: unknown } | null;
  /** Where an unexpected failure is reported. Defaults to a console line. */
  onError?: (message: string) => void;
};

/**
 * Delivers newly created notifications by email, once each, and only when the
 * project asked for that event.
 *
 * The dispatcher already makes a repeat request for the same
 * notification+channel+recipient a recorded SKIPPED/ALREADY_DELIVERED instead of a
 * second email, so calling this twice for the same records cannot double-send. That
 * is why the inbox is free to hand over everything it just created without this
 * module keeping its own memory of what it has already seen.
 */
export class NotificationEmailDispatch {
  private readonly dispatcher: Pick<NotificationDeliveryDispatcher, "deliver">;
  private readonly loadProject: (projectId: string) => { id: string; emailNotifications?: unknown } | null;
  private readonly onError: (message: string) => void;

  constructor(options: NotificationEmailDispatchOptions) {
    this.dispatcher = options.dispatcher;
    this.loadProject = options.loadProject;
    this.onError = options.onError ?? ((message: string) => console.error(message));
  }

  /**
   * Offers every record to the delivery layer and returns one summary per record.
   *
   * Ineligible records are reported, not silently dropped: "this project has email
   * switched off" is an answer a caller and a test both need. No delivery record is
   * written for an ineligible notification, because the dispatcher is never called.
   */
  async dispatchCreated(records: readonly NotificationRecord[]): Promise<NotificationEmailSummary[]> {
    const summaries: NotificationEmailSummary[] = [];
    for (const record of records) {
      try {
        const project = this.loadProject(record.projectId);
        const result = await deliverEligibleProjectEmail(this.dispatcher, project, record);
        summaries.push({
          notificationId: record.id,
          projectId: record.projectId,
          type: record.type,
          eligible: result.eligibility.eligible,
          reason: result.eligibility.reason,
          results: result.dispatches,
        });
      } catch (error) {
        // Contained here on purpose: a transport, a store or a preference read that
        // throws must not propagate into the run that produced the notification.
        // The notification is already persisted; delivery is best-effort by design.
        const detail = error instanceof Error ? error.message : String(error);
        this.onError(`  email delivery: skipped ${record.id}: ${detail}`);
        summaries.push({
          notificationId: record.id,
          projectId: record.projectId,
          type: record.type,
          eligible: false,
          // Not PROJECT_NOT_FOUND: the project may well exist. The preference layer is
          // the only thing allowed to say PROJECT_NOT_FOUND, and it says it from the
          // project lookup itself rather than from a thrown error.
          reason: "DISPATCH_ERROR",
          results: [],
        });
      }
    }
    return summaries;
  }
}