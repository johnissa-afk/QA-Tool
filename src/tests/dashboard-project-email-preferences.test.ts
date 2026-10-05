// ---------------------------------------------------------------------------
// Milestone 3: project-level email PREFERENCES.
//
// Who a project emails, which event types it emails about, and whether it is
// enabled at all - persisted on the project record itself, validated strictly,
// scoped strictly to one project, and answerable as a deterministic eligibility
// decision.
//
// What this milestone deliberately does NOT do, asserted here rather than merely
// intended: nothing sends mail, no QA run is created by a settings write, and no
// existing notification is re-examined when settings change.
//
// Every fixture is an isolated temporary directory with a hand-written project
// document, so these tests prove backward compatibility against the shape of a
// file written by an earlier version rather than against one this code wrote.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSpawner, getJson, send } from "./notification-fixtures.js";
import { startDashboard } from "../dashboard/server.js";
import { ProjectStore } from "../dashboard/projects.js";
import {
  InMemoryDeliveryTransport,
  NotificationDeliveryDispatcher,
  NotificationDeliveryStore,
} from "../dashboard/notification-delivery.js";
import { notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationRecord, NotificationType } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";
import {
  NOTIFICATION_TYPES,
  defaultEmailPreferences,
  deliverEligibleProjectEmail,
  emailEligibility,
  emailPreferencesOf,
  emailReadiness,
  isProjectEmailPreferences,
  normalizeEventList,
  normalizeRecipientList,
  parseEmailPreferences,
} from "../dashboard/project-email-preferences.js";
import type { ProjectEmailPreferences } from "../dashboard/project-email-preferences.js";

/**
 * A temporary report directory, with the `projects/` subtree the app itself
 * creates. Tests seed a project document into it BEFORE the server boots, so the
 * store reads a file an earlier version could have written rather than one this
 * code produced.
 */
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
};
const projectsPath = (dir: string): string => join(dir, "projects", "projects.json");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const SECRET = "smtp-secret-pw-9f3a-do-not-leak";

const WITH_SMTP = {
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "qa@example.test",
  SMTP_PASSWORD: SECRET,
  SMTP_FROM: "qa@example.test",
} as NodeJS.ProcessEnv;

/**
 * A project document written by an EARLIER version of this app: no
 * `emailNotifications` key anywhere. Written as literal JSON so the test does not
 * depend on the current code being able to produce it.
 */
const legacyProjectDocument = (id: string, name: string, url: string): string =>
  JSON.stringify(
    {
      schemaVersion: 1,
      projects: [
        {
          id,
          name,
          url,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastRunId: null,
          lastRunAt: null,
          lastStatus: null,
          lastFindingsCount: null,
          lastCoverageStatus: null,
        },
      ],
      runs: [],
      findings: [],
      findingEvents: [],
      findingSnapshots: [],
      changeRecords: [],
    },
    null,
    2,
  );

const event = (overrides: Partial<NotificationPreviewEvent> = {}): NotificationPreviewEvent => ({
  type: "NEW_FINDING",
  projectId: "web-abc123",
  projectName: "Checkout",
  runId: "web-run-1",
  findingId: "prj-fnd-1",
  severity: "HIGH",
  title: "New finding",
  message: "A tracked finding appeared for the first time.",
  source: "finding-lifecycle",
  reference: "prj-fnd-1",
  ...overrides,
});

const notification = (overrides: Partial<NotificationPreviewEvent> = {}): NotificationRecord =>
  notificationFromEvent(event(overrides)) as NotificationRecord;

const prefs = (overrides: Partial<ProjectEmailPreferences> = {}): ProjectEmailPreferences => ({
  enabled: true,
  recipients: [ALICE],
  events: ["NEW_FINDING"],
  ...overrides,
});

/** Runs `body` with a temporary process.env, restoring the previous values. */
const withEnv = async (overrides: NodeJS.ProcessEnv, body: () => Promise<void>): Promise<void> => {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// ===========================================================================
// Defaults
// ===========================================================================

test("a project saved before this feature reads the safe defaults", () => {
  const dir = tempDir("pef-legacy-");
  writeFileSync(projectsPath(dir), legacyProjectDocument("prj-legacy-1", "Checkout", "https://qa.test/checkout"), { flag: "w" });

  const project = new ProjectStore(projectsPath(dir)).get("prj-legacy-1");
  assert.ok(project, "the legacy project still loads");
  // Not defaulted into the document: the key is genuinely absent, and it is read
  // through the same accessor the API uses.
  assert.equal(project.emailNotifications, undefined);
  assert.deepEqual(emailPreferencesOf(project), { enabled: false, recipients: [], events: [] });
});

test("email is off by default and nothing is opted in on the user's behalf", () => {
  const defaults = defaultEmailPreferences();
  assert.equal(defaults.enabled, false, "email is not auto-enabled");
  assert.deepEqual(defaults.recipients, [], "no address is invented");
  assert.deepEqual(defaults.events, [], "no event is auto-selected");
});

test("reading defaults does not write anything to disk", () => {
  const dir = tempDir("pef-readonly-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-ro-1", "Checkout", "https://qa.test/checkout"));
  const before = readFileSync(file, "utf8");

  const store = new ProjectStore(file);
  for (let i = 0; i < 3; i += 1) emailPreferencesOf(store.get("prj-ro-1"));

  // A read must not trigger the additive migration or any other rewrite: the
  // bytes on disk are identical, key-for-key.
  assert.equal(readFileSync(file, "utf8"), before, "no silent migration of the project document");
});

test("loading a document with a malformed email block drops only that block", () => {
  const dir = tempDir("pef-malformed-");
  const file = projectsPath(dir);
  const document = JSON.parse(legacyProjectDocument("prj-bad-1", "Checkout", "https://qa.test/checkout"));
  // A hand-edited document claiming recipients that would never validate.
  document.projects[0].emailNotifications = { enabled: true, recipients: ["not-an-email", 42], events: ["NEW_FINDING"] };
  writeFileSync(file, JSON.stringify(document, null, 2));

  const project = new ProjectStore(file).get("prj-bad-1");
  assert.ok(project);
  assert.deepEqual(emailPreferencesOf(project), defaultEmailPreferences(), "untrusted recipients never become configured");
  assert.equal(project.name, "Checkout", "unrelated project fields survive");
  assert.equal(project.url, "https://qa.test/checkout");
  assert.equal(project.id, "prj-bad-1");
});

test("isProjectEmailPreferences accepts only fully-formed normalized blocks", () => {
  assert.equal(isProjectEmailPreferences(prefs()), true);
  assert.equal(isProjectEmailPreferences({ ...prefs(), recipients: ["Alice@Example.com"] }), false, "a non-normalized address is not trusted on read");
  assert.equal(isProjectEmailPreferences({ ...prefs(), events: ["PASSWORD_RESET"] as unknown as NotificationType[] }), false);
  assert.equal(isProjectEmailPreferences({ ...prefs(), enabled: "true" as unknown as boolean }), false);
  assert.equal(isProjectEmailPreferences(null), false);
  assert.equal(isProjectEmailPreferences([]), false);
});

// ===========================================================================
// Recipients
// ===========================================================================

test("a valid recipient is accepted", () => {
  const result = normalizeRecipientList([ALICE]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, [ALICE]);
});

test("whitespace is trimmed", () => {
  const result = normalizeRecipientList(["  alice@example.com  "]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, [ALICE], "leading and trailing whitespace removed");
});

test("the same address written three ways collapses to one recipient", () => {
  // The exact example from the milestone.
  const result = normalizeRecipientList(["user@example.com", " user@example.com "]);
  assert.deepEqual(result.ok ? result.value : null, ["user@example.com"], "one normalized recipient, not two");
});

test("case differences are one recipient", () => {
  // Addresses compare case-insensitively, so this person cannot become two
  // delivery targets and be mailed twice.
  const result = normalizeRecipientList(["Alice@Example.com", "alice@example.com", "ALICE@EXAMPLE.COM"]);
  assert.deepEqual(result.ok ? result.value : null, [ALICE]);
});

test("multiple recipients are all preserved", () => {
  const result = normalizeRecipientList([BOB, ALICE]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, [ALICE, BOB], "both kept, in deterministic order");
});

test("recipients persist identically whatever order they are submitted in", () => {
  const first = parseEmailPreferences({ enabled: true, recipients: [BOB, ALICE], events: ["RUN_FAILED", "NEW_FINDING"] });
  const second = parseEmailPreferences({ enabled: true, recipients: [ALICE, BOB], events: ["NEW_FINDING", "RUN_FAILED"] });
  assert.deepEqual(first.ok ? first.value : null, second.ok ? second.value : null);
});

test("a malformed recipient is rejected", () => {
  for (const bad of ["not-an-email", "@example.com", "alice@", "alice@@example.com", "alice example.com", "alice@example..com"]) {
    const result = normalizeRecipientList([bad]);
    assert.equal(result.ok, false, `${bad} must be rejected`);
  }
});

test("an empty recipient is rejected", () => {
  for (const empty of ["", "   ", "\t"]) {
    assert.equal(normalizeRecipientList([empty]).ok, false, "an empty address is rejected, not silently dropped");
  }
});

test("a header-injection attempt is rejected", () => {
  // Never normalized into something that could add a header to an outgoing mail.
  const result = normalizeRecipientList(["alice@example.com\r\nBcc: victim@example.com"]);
  assert.equal(result.ok, false);
});

test("a non-string recipient is rejected", () => {
  for (const bad of [42, null, {}, [], true]) {
    assert.equal(normalizeRecipientList([bad]).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("recipients must be a list", () => {
  assert.equal(normalizeRecipientList("alice@example.com").ok, false, "a bare string is not a list");
  assert.equal(normalizeRecipientList(undefined).ok, false);
});

test("validation never contacts a server or sends mail", async () => {
  // Recipient validation is purely syntactic: the same payload is accepted with
  // no SMTP configuration at all and with a complete one, which it could not be
  // if it had attempted a connection.
  const payload = { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] };
  await withEnv({ SMTP_HOST: undefined, SMTP_FROM: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined }, async () => {
    const withoutSmtp = parseEmailPreferences(payload);
    assert.equal(withoutSmtp.ok, true, "accepted with no SMTP configured");
    assert.deepEqual(withoutSmtp.ok ? withoutSmtp.value : null, { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] });
  });
  await withEnv(WITH_SMTP, async () => {
    const withSmtp = parseEmailPreferences(payload);
    assert.deepEqual(withSmtp.ok ? withSmtp.value : null, { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] });
  });
});

// ===========================================================================
// Events
// ===========================================================================

test("every existing notification type is accepted", () => {
  const result = normalizeEventList([...NOTIFICATION_TYPES]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, [...NOTIFICATION_TYPES]);
});

test("the event list matches the existing notification types exactly", () => {
  // Guards against the list drifting from the union the pipeline derives from.
  assert.equal(NOTIFICATION_TYPES.length, 7);
  assert.deepEqual([...NOTIFICATION_TYPES], [
    "NEW_FINDING",
    "REGRESSED_FINDING",
    "RESOLVED_FINDING",
    "RUN_FAILED",
    "ACCESS_CHANGED",
    "SCHEDULE_SKIPPED",
    "MEANINGFUL_CHANGE",
  ]);
});

test("an unknown event type is rejected rather than silently added", () => {
  // The exact example from the milestone.
  const result = normalizeEventList(["NEW_FINDING", "PASSWORD_RESET", "SYSTEM_ALERT", "RANDOM_EVENT"]);
  // Throwing rather than asserting makes the whole point explicit: not one
  // unknown value is quietly kept, and "NEW_FINDING" does not sneak through alone.
  if (result.ok) throw new Error(`unknown values must be refused, kept: ${result.value.join(", ")}`);
  assert.equal(result.errors.length, 3, "the three unknown values are each reported");
});

test("a rejected event reports why, naming the offending value", () => {
  const result = normalizeEventList(["PASSWORD_RESET"]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors[0]?.field, "events");
  assert.match(result.errors[0]?.message ?? "", /PASSWORD_RESET/);
});

test("event order is canonical regardless of submission order", () => {
  const shuffled = normalizeEventList(["MEANINGFUL_CHANGE", "RUN_FAILED", "NEW_FINDING"]);
  assert.deepEqual(shuffled.ok ? shuffled.value : null, ["NEW_FINDING", "RUN_FAILED", "MEANINGFUL_CHANGE"]);
});

test("duplicate events are removed", () => {
  const result = normalizeEventList(["NEW_FINDING", "NEW_FINDING", "RUN_FAILED", "RUN_FAILED"]);
  assert.deepEqual(result.ok ? result.value : null, ["NEW_FINDING", "RUN_FAILED"]);
});

test("a non-string event is rejected", () => {
  assert.equal(normalizeEventList([7]).ok, false);
  assert.equal(normalizeEventList([null]).ok, false);
});

test("events must be a list", () => {
  assert.equal(normalizeEventList("NEW_FINDING").ok, false);
});

// ===========================================================================
// Whole-payload validation
// ===========================================================================

test("a valid payload is accepted and normalized", () => {
  const result = parseEmailPreferences({
    enabled: true,
    recipients: [" Developer@Example.com ", "qa@example.com", "developer@example.com"],
    events: ["RUN_FAILED", "NEW_FINDING", "NEW_FINDING"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, {
    enabled: true,
    recipients: ["developer@example.com", "qa@example.com"],
    events: ["NEW_FINDING", "RUN_FAILED"],
  });
});

test("every field is required and typed", () => {
  assert.equal(parseEmailPreferences({ recipients: [ALICE], events: [] }).ok, false, "enabled is required");
  assert.equal(parseEmailPreferences({ enabled: true, events: [] }).ok, false, "recipients is required");
  assert.equal(parseEmailPreferences({ enabled: true, recipients: [] }).ok, false, "events is required");
  assert.equal(parseEmailPreferences({ enabled: "yes", recipients: [], events: [] }).ok, false, "enabled must be boolean");
});

test("a non-object payload is rejected", () => {
  for (const bad of [null, undefined, "on", 42, []]) {
    assert.equal(parseEmailPreferences(bad).ok, false, `${JSON.stringify(bad) ?? "undefined"} must be rejected`);
  }
});

test("every invalid field is reported at once", () => {
  // One round trip reports both problems, so a caller does not fix them one at a
  // time by trial and error.
  const result = parseEmailPreferences({ enabled: true, recipients: ["nope"], events: ["PASSWORD_RESET"] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.errors.map(entry => entry.field).sort(), ["events", "recipients"]);
});

test("an empty selection is valid - it just does not email anything", () => {
  const result = parseEmailPreferences({ enabled: true, recipients: [], events: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, { enabled: true, recipients: [], events: [] });
});

// ===========================================================================
// Eligibility
// ===========================================================================

const projectWith = (preferences: unknown): { id: string; emailNotifications?: unknown } =>
  preferences === undefined ? { id: "prj-1" } : { id: "prj-1", emailNotifications: preferences };

test("enabled + recipient + selected event is ELIGIBLE", () => {
  const result = emailEligibility(projectWith(prefs()), notification({ type: "NEW_FINDING" }));
  assert.equal(result.reason, "ELIGIBLE");
  assert.equal(result.eligible, true);
  assert.deepEqual(result.recipients, [ALICE]);
  assert.equal(result.notificationType, "NEW_FINDING");
});

test("disabled is DISABLED", () => {
  const result = emailEligibility(projectWith(prefs({ enabled: false })), notification());
  assert.equal(result.reason, "DISABLED");
  assert.equal(result.eligible, false);
  assert.deepEqual(result.recipients, [], "an ineligible result carries no mailing list");
});

test("a project that was never configured is DISABLED, not eligible", () => {
  const result = emailEligibility(projectWith(undefined), notification());
  assert.equal(result.reason, "DISABLED");
});

test("no recipients is NO_RECIPIENTS", () => {
  const result = emailEligibility(projectWith(prefs({ recipients: [] })), notification());
  assert.equal(result.reason, "NO_RECIPIENTS");
  assert.equal(result.eligible, false);
});

test("an unselected event is EVENT_NOT_SELECTED", () => {
  const result = emailEligibility(projectWith(prefs({ events: ["RUN_FAILED"] })), notification({ type: "NEW_FINDING" }));
  assert.equal(result.reason, "EVENT_NOT_SELECTED");
  assert.equal(result.eligible, false);
});

test("a missing project is PROJECT_NOT_FOUND", () => {
  const result = emailEligibility(null, notification());
  assert.equal(result.reason, "PROJECT_NOT_FOUND");
  assert.equal(result.eligible, false);
  assert.equal(result.projectId, null);
});

test("each event in the type list is selectable and eligible once chosen", () => {
  for (const type of NOTIFICATION_TYPES) {
    const result = emailEligibility(projectWith(prefs({ events: [type] })), notification({ type }));
    assert.equal(result.reason, "ELIGIBLE", `${type} must be eligible once selected`);
  }
});

test("the first thing wrong is the reason reported", () => {
  // Disabled beats "no recipients": the fix is to turn email on, and saying
  // "no recipients" would send the reader to the wrong field.
  const result = emailEligibility(projectWith(prefs({ enabled: false, recipients: [], events: [] })), notification());
  assert.equal(result.reason, "DISABLED");
});

test("eligibility is deterministic", () => {
  const project = projectWith(prefs());
  const note = notification();
  const results = Array.from({ length: 5 }, () => emailEligibility(project, note));
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("eligibility does not mutate the stored configuration", () => {
  const project = projectWith(prefs());
  const before = JSON.stringify(project);
  for (let i = 0; i < 3; i += 1) emailEligibility(project, notification());
  assert.equal(JSON.stringify(project), before);
});

// ===========================================================================
// Persistence
// ===========================================================================

test("settings are stored inside the existing project document", () => {
  const dir = tempDir("pef-store-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));

  const store = new ProjectStore(file);
  const saved = store.setEmailPreferences("prj-1", prefs({ recipients: [BOB, ALICE], events: ["RUN_FAILED"] }));
  assert.equal(saved.ok, true);

  // The same document - not a second database, not a new file.
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as any;
  assert.equal(onDisk.schemaVersion, 1, "the schema version is unchanged");
  assert.equal(onDisk.projects.length, 1);
  assert.deepEqual(onDisk.projects[0].emailNotifications, { enabled: true, recipients: [ALICE, BOB], events: ["RUN_FAILED"] });
  assert.equal(existsSync(join(dir, "projects", "email-preferences.json")), false, "no second project database");
});

test("stored settings survive a reload", () => {
  const dir = tempDir("pef-reload-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  new ProjectStore(file).setEmailPreferences("prj-1", prefs({ recipients: [ALICE, BOB] }));
  assert.deepEqual(emailPreferencesOf(new ProjectStore(file).get("prj-1")), prefs({ recipients: [ALICE, BOB] }));
});

test("writing settings does not disturb any other project field", () => {
  const dir = tempDir("pef-fields-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const before = JSON.parse(readFileSync(file, "utf8")).projects[0];

  new ProjectStore(file).setEmailPreferences("prj-1", prefs());

  const after = JSON.parse(readFileSync(file, "utf8")).projects[0];
  for (const key of Object.keys(before)) {
    if (key === "updatedAt") continue;
    assert.deepEqual(after[key], before[key], `${key} must be untouched`);
  }
  assert.notEqual(after.updatedAt, before.updatedAt, "updatedAt moves, because the project did change");
});

test("saving settings creates no QA run", () => {
  const dir = tempDir("pef-norun-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const store = new ProjectStore(file);
  const runsBefore = (JSON.parse(readFileSync(file, "utf8")) as any).runs.length;

  store.setEmailPreferences("prj-1", prefs());

  const onDisk = JSON.parse(readFileSync(file, "utf8")) as any;
  assert.equal(onDisk.runs.length, runsBefore, "no run record was written");
  assert.deepEqual(onDisk.runs, [], "the run list stays empty");
  assert.equal(onDisk.projects[0].lastRunId, null, "the project is not pointed at a run");
  assert.equal(onDisk.projects[0].lastRunAt, null);
  assert.equal(onDisk.projects[0].lastStatus, null);
  assert.equal(onDisk.projects[0].lastFindingsCount, null);
  // And no run artifacts appeared on disk.
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).findings, []);
});

test("settings for an unknown project are a 404, not a silent create", () => {
  const dir = tempDir("pef-unknown-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const result = new ProjectStore(file).setEmailPreferences("prj-does-not-exist", prefs());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
  // Nothing was added to the document by the failed attempt.
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as any).projects.length, 1);
});

test("the store refuses to persist a block that does not validate", () => {
  // A second gate behind the API's validation, so no caller can write garbage.
  const dir = tempDir("pef-guard-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const store = new ProjectStore(file);
  const bad = { enabled: true, recipients: ["not-an-email"], events: ["NEW_FINDING"] } as unknown as ProjectEmailPreferences;
  const result = store.setEmailPreferences("prj-1", bad);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).projects[0].emailNotifications, undefined);
});

test("settings are replaced as a whole, never merged", () => {
  const dir = tempDir("pef-replace-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const store = new ProjectStore(file);
  store.setEmailPreferences("prj-1", prefs({ recipients: [ALICE, BOB], events: ["NEW_FINDING", "RUN_FAILED"] }));
  store.setEmailPreferences("prj-1", prefs({ recipients: [BOB], events: ["ACCESS_CHANGED"] }));
  assert.deepEqual(emailPreferencesOf(store.get("prj-1")), {
    enabled: true,
    recipients: [BOB],
    events: ["ACCESS_CHANGED"],
  });
});

// ===========================================================================
// Project isolation
// ===========================================================================

const twoProjects = (dir: string): { store: ProjectStore; a: string; b: string } => {
  const file = projectsPath(dir);
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        JSON.parse(legacyProjectDocument("prj-a", "Alpha", "https://qa.test/alpha")).projects[0],
        JSON.parse(legacyProjectDocument("prj-b", "Beta", "https://qa.test/beta")).projects[0],
      ],
      runs: [],
      findings: [],
      findingEvents: [],
      findingSnapshots: [],
      changeRecords: [],
    }, null, 2),
  );
  return { store: new ProjectStore(file), a: "prj-a", b: "prj-b" };
};

test("Project A's settings do not affect Project B", () => {
  const { store, a, b } = twoProjects(tempDir("pef-iso-"));
  store.setEmailPreferences(a, prefs({ recipients: [ALICE], events: ["NEW_FINDING"] }));
  assert.deepEqual(emailPreferencesOf(store.get(b)), defaultEmailPreferences(), "B is untouched and still off");
});

test("Project A's recipients are never offered to Project B", () => {
  const { store, a, b } = twoProjects(tempDir("pef-iso-recipients-"));
  store.setEmailPreferences(a, prefs({ recipients: [ALICE, BOB], events: ["NEW_FINDING"] }));
  const forA = emailEligibility(store.get(a), notification({ projectId: "prj-a", type: "NEW_FINDING" }));
  const forB = emailEligibility(store.get(b), notification({ projectId: "prj-b", type: "NEW_FINDING" }));
  assert.equal(forA.reason, "ELIGIBLE");
  assert.equal(forB.reason, "DISABLED");
  assert.deepEqual(forB.recipients, [], "B cannot receive A's mailing list");
});

test("Project A's event selection does not extend to Project B", () => {
  const { store, a, b } = twoProjects(tempDir("pef-iso-events-"));
  store.setEmailPreferences(a, prefs({ recipients: [ALICE], events: ["NEW_FINDING", "RUN_FAILED"] }));
  // B is enabled with its own recipient but has selected nothing.
  store.setEmailPreferences(b, prefs({ recipients: [BOB], events: [] }));
  const forB = emailEligibility(store.get(b), notification({ projectId: "prj-b", type: "NEW_FINDING" }));
  assert.equal(forB.reason, "EVENT_NOT_SELECTED");
  assert.deepEqual(emailPreferencesOf(store.get(a)).events, ["NEW_FINDING", "RUN_FAILED"], "A keeps its own selection");
});

test("disabling Project A leaves Project B enabled", () => {
  const { store, a, b } = twoProjects(tempDir("pef-iso-disable-"));
  store.setEmailPreferences(a, prefs());
  store.setEmailPreferences(b, prefs({ recipients: [BOB] }));
  store.setEmailPreferences(a, prefs({ enabled: false }));
  assert.equal(emailPreferencesOf(store.get(a)).enabled, false);
  assert.equal(emailPreferencesOf(store.get(b)).enabled, true);
});

test("removing a project does not disturb another project's settings", () => {
  const dir = tempDir("pef-iso-remove-");
  const { store, a, b } = twoProjects(dir);
  store.setEmailPreferences(a, prefs());
  store.setEmailPreferences(b, prefs({ recipients: [BOB], events: ["RUN_FAILED"] }));
  store.remove(a);
  assert.equal(store.get(a), null);
  assert.deepEqual(emailPreferencesOf(store.get(b)), prefs({ recipients: [BOB], events: ["RUN_FAILED"] }));
});

// ===========================================================================
// Delivery readiness (configuration state, never a secret)
// ===========================================================================

test("readiness reports a complete configuration as usable", () => {
  const readiness = emailReadiness(WITH_SMTP);
  assert.deepEqual(readiness, { configured: true, missing: [] });
});

test("readiness reports missing variable names, never their values", () => {
  const readiness = emailReadiness({ SMTP_USER: "qa@example.test", SMTP_PASSWORD: SECRET } as NodeJS.ProcessEnv);
  assert.equal(readiness.configured, false);
  assert.deepEqual(readiness.missing.sort(), ["SMTP_FROM", "SMTP_HOST"]);
  const serialized = JSON.stringify(readiness);
  assert.equal(serialized.includes(SECRET), false, "a password can never appear in readiness");
});

test("readiness counts a half-configured credential pair as unusable", () => {
  const readiness = emailReadiness({ SMTP_HOST: "smtp.example.test", SMTP_FROM: "qa@example.test", SMTP_USER: "qa@example.test" } as NodeJS.ProcessEnv);
  assert.equal(readiness.configured, false);
  assert.deepEqual(readiness.missing, ["SMTP_PASSWORD"]);
});

// ===========================================================================
// Explicit delivery integration
// ===========================================================================

const fakeDispatcher = (status: "SENT" | "FAILED" = "SENT") => {
  const calls: Array<{ recipient: string; notificationId: string }> = [];
  return {
    calls,
    deliver: async (note: NotificationRecord, recipient: string) => {
      calls.push({ recipient, notificationId: note.id });
      return status === "SENT"
        ? { ok: true as const, value: { delivery: { status: "SENT" as const } } }
        : { ok: true as const, value: { delivery: { status: "FAILED" as const, error: "ETIMEDOUT" } } };
    },
  };
};

test("an eligible notification is handed to every recipient", async () => {
  const dispatcher = fakeDispatcher();
  const result = await deliverEligibleProjectEmail(dispatcher, projectWith(prefs({ recipients: [ALICE, BOB] })), notification());
  assert.equal(result.eligibility.reason, "ELIGIBLE");
  assert.equal(result.dispatches.length, 2);
  assert.deepEqual(dispatcher.calls.map(call => call.recipient), [ALICE, BOB]);
  assert.deepEqual(result.dispatches.map(entry => entry.status), ["SENT", "SENT"]);
});

test("an ineligible notification never reaches the dispatcher", async () => {
  for (const [label, preferences] of [
    ["disabled", prefs({ enabled: false })],
    ["no recipients", prefs({ recipients: [] })],
    ["event not selected", prefs({ events: ["RUN_FAILED"] })],
    ["unconfigured", undefined],
  ] as const) {
    const dispatcher = fakeDispatcher();
    const result = await deliverEligibleProjectEmail(dispatcher, projectWith(preferences), notification());
    assert.equal(result.eligibility.eligible, false, `${label} is ineligible`);
    assert.deepEqual(result.dispatches, [], `${label} dispatches nothing`);
    assert.deepEqual(dispatcher.calls, [], `${label} never reaches delivery`);
  }
});

test("a missing project never reaches the dispatcher", async () => {
  const dispatcher = fakeDispatcher();
  const result = await deliverEligibleProjectEmail(dispatcher, null, notification());
  assert.equal(result.eligibility.reason, "PROJECT_NOT_FOUND");
  assert.deepEqual(dispatcher.calls, []);
});

test("a transport failure is reported per recipient without stopping the rest", async () => {
  const dispatcher = fakeDispatcher("FAILED");
  const result = await deliverEligibleProjectEmail(dispatcher, projectWith(prefs({ recipients: [ALICE, BOB] })), notification());
  assert.equal(result.dispatches.length, 2);
  for (const entry of result.dispatches) assert.equal(entry.status, "FAILED");
  assert.equal(result.dispatches[0]?.error, "ETIMEDOUT", "the reason travels back for the caller");
});

test("the real Delivery Core dispatcher satisfies the integration seam", async () => {
  // The point of the seam: production delivery code can call
  // `deliverEligibleProjectEmail` with the ACTUAL dispatcher, not only with a
  // fake shaped to match it. This compiles only if the structural type is
  // genuinely satisfied by NotificationDeliveryDispatcher.
  const dir = tempDir("pef-real-dispatcher-");
  const transport = new InMemoryDeliveryTransport();
  const store = new NotificationDeliveryStore(join(dir, "projects", "notification-deliveries.json"));
  const dispatcher = new NotificationDeliveryDispatcher({ store, transports: { EMAIL: transport } });

  const eligible = await deliverEligibleProjectEmail(
    dispatcher,
    projectWith(prefs({ recipients: [ALICE, BOB] })),
    notification({ type: "NEW_FINDING" }),
  );
  assert.equal(eligible.eligibility.reason, "ELIGIBLE");
  assert.deepEqual(eligible.dispatches.map(entry => entry.recipient), [ALICE, BOB]);
  assert.deepEqual(eligible.dispatches.map(entry => entry.status), ["SENT", "SENT"]);
  // One real delivery record per recipient, keyed by that recipient - so two
  // projects sharing a notification could never collapse into one target.
  assert.equal(store.list({ notificationId: notification().id }).targets, 2);
  assert.equal(existsSync(join(dir, "projects", "notification-deliveries.json")), true, "delivery history was written only because the caller explicitly asked");

  // And the same call with email off writes nothing at all.
  const before = readFileSync(join(dir, "projects", "notification-deliveries.json"), "utf8");
  const blocked = await deliverEligibleProjectEmail(dispatcher, projectWith(prefs({ enabled: false })), notification());
  assert.equal(blocked.eligibility.reason, "DISABLED");
  assert.deepEqual(blocked.dispatches, []);
  assert.equal(readFileSync(join(dir, "projects", "notification-deliveries.json"), "utf8"), before, "an ineligible call does not even record an attempt");
});

test("nothing in the notification or run path can reach the delivery integration", () => {
  // The integration must stay a seam a later milestone invokes deliberately. If
  // any of these modules ever names it, a notification being CREATED could start
  // sending mail - which is exactly what this milestone must not allow.
  const mustNotReference = [
    "notifications.ts",
    "notification-preview.ts",
    "notification-delivery.ts",
    "email-transport.ts",
    "projects.ts",
    "scheduler.ts",
    "run-manager.ts",
    "server.ts",
  ];
  for (const name of mustNotReference) {
    const text = readFileSync(join(process.cwd(), "src", "dashboard", name), "utf8");
    assert.equal(
      text.includes("deliverEligibleProjectEmail"),
      false,
      `${name} must not reference deliverEligibleProjectEmail - automatic delivery stays off`,
    );
  }
});

// ===========================================================================
// API
// ===========================================================================

const boot = async (dir: string, options: Record<string, unknown> = {}) =>
  startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    projectRoot: process.cwd(),
    spawnImpl: fakeSpawner().spawnImpl,
    scheduleTickMs: 60_000,
    scheduleEnabled: false,
    ...options,
  });

/**
 * Boots a dashboard over a freshly seeded report directory.
 *
 * `seed` runs BEFORE the server starts, so the store reads exactly the bytes a
 * test handed it - which is how the backward-compatibility claims are proven
 * rather than assumed.
 */
const withServer = async (
  body: (base: string, dir: string) => Promise<void>,
  seed: (dir: string) => void = () => {},
): Promise<void> => {
  const dir = tempDir("pef-api-");
  seed(dir);
  const dash = await boot(dir);
  try {
    await body(`http://127.0.0.1:${dash.port}`, dir);
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

test("GET returns the safe defaults for a project with no email configuration", async () => {
  await withServer(
    async base => {
      const { status, json } = await getJson(`${base}/api/projects/prj-1/email-settings`);
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.projectId, "prj-1");
      assert.deepEqual(json.settings, { enabled: false, recipients: [], events: [] });
      assert.equal(typeof json.emailConfigured, "boolean");
    },
    dir => writeFileSync(projectsPath(dir), legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout")),
  );
});

test("GET does not write to the project document while reading defaults", async () => {
  await withServer(
    async (base, dir) => {
      const before = readFileSync(projectsPath(dir), "utf8");
      await getJson(`${base}/api/projects/prj-1/email-settings`);
      await getJson(`${base}/api/projects/prj-1/email-settings`);
      assert.equal(readFileSync(projectsPath(dir), "utf8"), before, "reading settings does not migrate the document");
    },
    dir => writeFileSync(projectsPath(dir), legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout")),
  );
});

test("GET on an unknown project is a 404", async () => {
  await withServer(async base => {
    const { status, json } = await getJson(`${base}/api/projects/prj-missing/email-settings`);
    assert.equal(status, 404);
    assert.equal(json.ok, false);
  });
});

test("GET rejects a malformed project id", async () => {
  await withServer(async base => {
    const { status } = await getJson(`${base}/api/projects/${encodeURIComponent("../../secrets")}/email-settings`);
    assert.equal(status, 400);
  });
});

test("PUT saves valid settings and GET reads them back", async () => {
  const dir = tempDir("pef-api-put-");
  writeFileSync(projectsPath(dir), legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  const close = async () => {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  try {
    const saved = await send("PUT", `${base}/api/projects/prj-1/email-settings`, {
      enabled: true,
      recipients: ["qa@example.com", " Developer@Example.com ", "qa@example.com"],
      events: ["NEW_FINDING", "REGRESSED_FINDING", "RUN_FAILED"],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.deepEqual(saved.json.settings, {
      enabled: true,
      recipients: ["developer@example.com", "qa@example.com"],
      events: ["NEW_FINDING", "REGRESSED_FINDING", "RUN_FAILED"],
    });

    const read = await getJson(`${base}/api/projects/prj-1/email-settings`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.settings, saved.json.settings, "the read-back matches what was written");

    // And it reached the existing project document, not a new file.
    const onDisk = JSON.parse(readFileSync(projectsPath(dir), "utf8")) as any;
    assert.deepEqual(onDisk.projects[0].emailNotifications.recipients, ["developer@example.com", "qa@example.com"]);
    assert.equal(existsSync(join(dir, "projects", "email-preferences.json")), false);
  } finally {
    await close();
  }
});

test("PUT rejects an invalid payload with a clear error", async () => {
  const dir = tempDir("pef-api-invalid-");
  writeFileSync(projectsPath(dir), legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const { status, json } = await send("PUT", `${base}/api/projects/prj-1/email-settings`, {
      enabled: true,
      recipients: ["not-an-email"],
      events: ["PASSWORD_RESET"],
    });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /valid email address/);
    assert.equal(json.errors.length, 2, "both problems are reported");
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a rejected PUT does not partially persist", async () => {
  const dir = tempDir("pef-api-atomic-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    // First establish a good configuration.
    await send("PUT", `${base}/api/projects/prj-1/email-settings`, prefs({ recipients: [BOB], events: ["RUN_FAILED"] }));
    const before = readFileSync(file, "utf8");

    // Now an update that is valid except for one recipient.
    const rejected = await send("PUT", `${base}/api/projects/prj-1/email-settings`, {
      enabled: false,
      recipients: [ALICE, "broken"],
      events: ["ACCESS_CHANGED"],
    });
    assert.equal(rejected.status, 400);

    // Byte-for-byte unchanged: not even `enabled` flipped, and the bad address
    // did not sneak into the document.
    assert.equal(readFileSync(file, "utf8"), before, "a rejected update writes nothing at all");
    const after = JSON.parse(readFileSync(file, "utf8")) as any;
    assert.equal(after.projects[0].emailNotifications.enabled, true, "enabled was not half-applied");
    assert.deepEqual(after.projects[0].emailNotifications.recipients, [BOB]);
    assert.equal(JSON.stringify(after).includes("broken"), false, "the rejected address never reaches disk");

    // And the stored configuration still behaves as it did.
    const read = await getJson(`${base}/api/projects/prj-1/email-settings`);
    assert.equal(read.json.settings.enabled, true);
    assert.deepEqual(read.json.settings.recipients, [BOB]);
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("PUT to an unknown project is a 404 and creates nothing", async () => {
  const dir = tempDir("pef-api-404-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const { status, json } = await send("PUT", `${base}/api/projects/prj-nope/email-settings`, prefs());
    assert.equal(status, 404);
    assert.equal(json.ok, false);
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as any).projects.length, 1, "no project was created");
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("PUT with a non-JSON body is rejected without changing anything", async () => {
  const dir = tempDir("pef-api-json-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const before = readFileSync(file, "utf8");
    const res = await fetch(`${base}/api/projects/prj-1/email-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("another method on the settings route is a 405", async () => {
  await withServer(async base => {
    for (const method of ["POST", "DELETE", "PATCH"] as const) {
      const res = await fetch(`${base}/api/projects/prj-1/email-settings`, { method });
      assert.equal(res.status, 405, `${method} must not be allowed`);
    }
  });
});

test("the settings response never exposes SMTP configuration or secrets", async () => {
  const dir = tempDir("pef-api-secret-");
  writeFileSync(projectsPath(dir), legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    await withEnv(WITH_SMTP, async () => {
      const saved = await send("PUT", `${base}/api/projects/prj-1/email-settings`, prefs());
      assert.equal(saved.json.emailConfigured, true, "with a full SMTP configuration the API says so");

      const text = JSON.stringify(saved.json);
      for (const secret of [SECRET, "smtp.example.test", "qa@example.test"]) {
        assert.equal(text.includes(secret), false, `${secret} must never appear in the settings response`);
      }
      // Only the variable NAMES may be reported, and only when something is missing.
      await withEnv({ ...WITH_SMTP, SMTP_FROM: undefined }, async () => {
        const unconfigured = await getJson(`${base}/api/projects/prj-1/email-settings`);
        assert.equal(unconfigured.json.emailConfigured, false);
        assert.deepEqual(unconfigured.json.missingSmtpVariables, ["SMTP_FROM"]);
        assert.equal(JSON.stringify(unconfigured.json).includes(SECRET), false);
      });
    });
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("the project API does not start reporting email configuration on projects", async () => {
  // Nothing outside the settings endpoint changed shape: the project list is
  // unchanged for existing callers, and no UI is added.
  await withServer(async base => {
    const { status, json } = await getJson(`${base}/api/projects`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.projects));
  });
});

test("settings survive a server restart", async () => {
  const dir = tempDir("pef-api-restart-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const first = await boot(dir);
  const firstBase = `http://127.0.0.1:${first.port}`;
  await send("PUT", `${firstBase}/api/projects/prj-1/email-settings`, prefs({ recipients: [ALICE, BOB], events: ["ACCESS_CHANGED"] }));
  await new Promise<void>(resolve => {
    const server = first.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

  const second = await boot(dir);
  const secondBase = `http://127.0.0.1:${second.port}`;
  try {
    const read = await getJson(`${secondBase}/api/projects/prj-1/email-settings`);
    assert.deepEqual(read.json.settings, { enabled: true, recipients: [ALICE, BOB], events: ["ACCESS_CHANGED"] });
  } finally {
    const server = second.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("settings writes do not create QA runs, artifacts, notifications or deliveries", async () => {
  const dir = tempDir("pef-api-quiet-");
  const file = projectsPath(dir);
  writeFileSync(file, legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    await send("PUT", `${base}/api/projects/prj-1/email-settings`, prefs());
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as any;
    assert.deepEqual(onDisk.runs, [], "no run was started");
    assert.deepEqual(onDisk.findings, [], "no finding was recorded");
    assert.deepEqual(onDisk.findingEvents, []);
    assert.deepEqual(onDisk.changeRecords, []);
    // No notification history and no delivery history were invented.
    assert.equal(existsSync(join(dir, "projects", "notifications.json")), false, "no notifications were created");
    assert.equal(existsSync(join(dir, "projects", "notification-deliveries.json")), false, "no deliveries were recorded");
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("no historical notification is examined or backfilled by a settings change", async () => {
  const dir = tempDir("pef-api-backfill-");
  const file = projectsPath(dir);
  const document = JSON.parse(legacyProjectDocument("prj-1", "Checkout", "https://qa.test/checkout"));
  // A notification that predates this feature entirely.
  const notesPath = join(dir, "projects", "notifications.json");
  writeFileSync(
    notesPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        notifications: [
          {
            id: "ntf-ancient-1",
            type: "NEW_FINDING",
            source: "finding-lifecycle",
            projectId: "prj-1",
            projectName: "Checkout",
            runId: "web-run-old",
            findingId: "prj-fnd-old",
            severity: "HIGH",
            title: "An old finding",
            message: "Recorded long before email settings existed.",
            at: "2025-01-01T00:00:00.000Z",
            read: true,
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(file, JSON.stringify(document, null, 2));
  const notesBefore = readFileSync(notesPath, "utf8");

  const dash = await boot(dir);
  const base = `http://127.0.0.1:${dash.port}`;
  try {
    const saved = await send("PUT", `${base}/api/projects/prj-1/email-settings`, prefs());
    assert.equal(saved.status, 200);
    // Turning email on must not rewrite history in either direction.
    assert.equal(readFileSync(notesPath, "utf8"), notesBefore, "the existing notification is untouched");
    assert.equal(existsSync(join(dir, "projects", "notification-deliveries.json")), false, "no delivery was queued for it");
  } finally {
    const server = dash.server as unknown as import("node:http").Server;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// ===========================================================================
// No UI
// ===========================================================================

test("the settings UI is the only place email settings are rendered", () => {
  // Milestone 4 added the settings UI, so the Milestone 3 boundary is now
  // "the browser renders what the API provides" rather than "there is no UI".
  // What must still hold: the app ships as the same single page, and the event
  // taxonomy lives in the backend rather than being copied into the markup.
  const page = readFileSync(join(process.cwd(), "src", "dashboard", "index.html"), "utf8");
  const app = readFileSync(join(process.cwd(), "src", "dashboard", "app.html"), "utf8");

  assert.equal(page.includes("email-settings"), false, "the app shell stays a shell");

  // The event list arrives from the API, so the SETTINGS SECTION must not carry
  // its own copy. Scoped to that function on purpose: the notification bell has
  // its own pre-existing grouping of the finding types, which is a different
  // concern and not a second settings taxonomy.
  const section = app.match(/function emailSettingsSection\([\s\S]*?\n}\n/);
  assert.ok(section, "the settings section must exist in the served app");
  for (const type of NOTIFICATION_TYPES) {
    assert.equal(
      section[0].includes('"' + type + '"'),
      false,
      `the settings section must not hard-code ${type} - it renders the API's eventOptions`,
    );
  }
  // And it reads that canonical list rather than inventing one.
  assert.match(section[0], /eventOptions/);
});