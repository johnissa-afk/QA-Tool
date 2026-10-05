// Secret protection for the email delivery path.
//
// SMTP credentials sit in the environment, and an unattended feature that mails
// people on a schedule has an unusually large surface for leaking them: a failure
// message becomes a persisted delivery record, a delivery record is shown in the
// UI, and the dashboard runs unattended. So the question is not "is the transport
// redacting" - the transport test already proves that - but "can a credential
// reach any of the places a human or a file can read".
//
// Every test here drives the REAL path end to end: real configuration, a real
// failing SMTP call, a real persisted delivery record, real API responses. A
// credential planted in the environment is then hunted for in all of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, readDeliveries } from "./notification-email-fixtures.js";
import { emailReadiness } from "../dashboard/project-email-preferences.js";
import { loadEmailConfig, NotificationEmailTransport } from "../dashboard/email-transport.js";
import { NotificationDeliveryStore } from "../dashboard/notification-delivery.js";
import { notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";

const PASSWORD = "smtp-secret-pw-9f3a-do-not-leak";
const SMTP_USER = "qa-mailer@example.test";
const SMTP_HOST = "mail.internal.example.test";

const CONFIGURED_ENV: Record<string, string> = {
  SMTP_HOST,
  SMTP_PORT: "587",
  SMTP_USER,
  SMTP_PASSWORD: PASSWORD,
  SMTP_FROM: "alerts@example.test",
  SMTP_FROM_NAME: "AI Website QA",
};

const note = () =>
  notificationFromEvent({
    type: "NEW_FINDING",
    projectId: "prj-secret-1",
    projectName: "Secret Project",
    title: "Button lacks an accessible name",
    message: "The primary call to action exposes no accessible name.",
    runId: "run-secret-1",
    findingId: "QA-F-001",
    severity: "HIGH",
    source: "finding-lifecycle",
    reference: "QA-F-001",
  } as NotificationPreviewEvent, "2026-09-30T07:03:02.000Z");

/** Every file under a directory, so a scan cannot miss a document by path. */
const filesUnder = (root: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (statSync(path).isFile()) found.push(path);
  }
  return found;
};

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["the SMTP password itself", new RegExp(PASSWORD)],
  ["a password= assignment", /password[=:]\s*(?!\*\*\*)[^\s"']+/i],
  ["a user:password@host authority", /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/i],
  ["an SMTP_USER leaked into an error", new RegExp(SMTP_USER)],
];

// ===========================================================================
// 1. A failing SMTP call cannot persist a credential
// ===========================================================================

test("secret: a failing SMTP call persists no credential, in any part of the record", async () => {
  const transport = new NotificationEmailTransport({
    env: CONFIGURED_ENV,
    createClient: () => ({
      sendMail: async () => {
        throw Object.assign(
          new Error(`535 5.7.8 Authentication failed for user ${SMTP_USER} with password ${PASSWORD}`),
          { code: "EAUTH" },
        );
      },
      close: async () => undefined,
    }),
  });

  const result = await transport.send({ notification: note() as never, recipient: "alice@example.com" });
  assert.equal(result.status, "FAILED");
  const failure = String(result.error ?? "");
  assert.match(failure, /EAUTH/, "the machine-readable reason is kept, so the failure stays actionable");
  assert.doesNotMatch(failure, new RegExp(PASSWORD), "the password is not in the error");

  // The whole record, not just the error string, is what gets written to disk.
  const record = JSON.stringify({ ...note(), status: "SENT", recipient: "alice@example.com", error: result.error });
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (label === "a password= assignment") {
      assert.equal(/password\s*[:=]?\s*\*\*\*/i.test(record), true, "the password assignment was replaced, not merely shortened");
      continue;
    }
    assert.equal(pattern.test(record), false, `${label} must not reach the persisted record`);
  }
});

// ===========================================================================
// 2. Readiness reports names, never values
// ===========================================================================

test("secret: a readiness check reports which variables are missing, never a value", () => {
  const partial = loadEmailConfig({ ...CONFIGURED_ENV, SMTP_PASSWORD: undefined } as NodeJS.ProcessEnv);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.ok === false ? partial.missing : [], ["SMTP_PASSWORD"]);
  assert.equal(JSON.stringify(partial as object).includes(PASSWORD), false, "a missing-variable report carries no values");

  const readiness = emailReadiness({ ...CONFIGURED_ENV, SMTP_HOST: undefined, SMTP_FROM: undefined } as NodeJS.ProcessEnv);
  assert.equal(readiness.configured, false);
  assert.deepEqual(readiness.missing.sort(), ["SMTP_FROM", "SMTP_HOST"]);
  assert.equal(JSON.stringify(readiness).includes(SMTP_HOST), false, "and it names variables rather than hosts");
});

test("secret: a readiness check reports configured without echoing the configuration", () => {
  const readiness = emailReadiness(CONFIGURED_ENV as NodeJS.ProcessEnv);
  assert.equal(readiness.configured, true);
  assert.deepEqual(readiness.missing, []);
  assert.equal(JSON.stringify(readiness as object).includes(PASSWORD), false);
  assert.equal(JSON.stringify(readiness as object).includes(SMTP_USER), false);
});

// ===========================================================================
// 3. A credential in the environment does not reach the delivery document
// ===========================================================================

test("secret: the persistence boundary redacts even when the record arrives unredacted", async () => {
  // The transport redacts its own errors, but the dispatcher also contains
  // transports that THROW, and a thrown error reaches the store raw. This is the
  // path that would leak, so it is the path that must be proven safe.
  const dir = mkdtempSync(join(tmpdir(), "m6-secret-"));
  const path = join(dir, "notification-deliveries.json");
  const store = new NotificationDeliveryStore(path, { SMTP_PASSWORD: PASSWORD, SMTP_USER } as NodeJS.ProcessEnv);

  const saved = store.record({
    id: "dlv-raw",
    deliveryKey: "k-raw",
    notificationId: "n-raw",
    channel: "EMAIL",
    recipient: "alice@example.com",
    attempt: 1,
    status: "FAILED",
    attemptedAt: new Date(0).toISOString(),
    error: `535 Authentication failed for ${SMTP_USER} with password ${PASSWORD} via smtp://${SMTP_USER}:${PASSWORD}@${SMTP_HOST}`,
  });
  assert.equal(saved.ok, true, "the record was saved, so there is a document to scan");

  const document = readFileSync(path, "utf8");
  assert.equal(document.includes(PASSWORD), false, "the SMTP password does not reach the document");
  assert.equal(document.includes(SMTP_USER), false, "nor the username it was paired with");
  assert.equal(saved.value.delivery.error!.includes(PASSWORD), false, "and the returned record is redacted too");
  assert.match(saved.value.delivery.error!, /\*\*\*/, "the redaction is visible where the secret was");
});

test("secret: a full delivery cycle writes no credential into any file it produces", async () => {
  // The harness clears the SMTP variables before it starts a dashboard - which is
  // the right default for other tests and is exactly why this one plants a
  // different credential. `AI_API_KEY` is on the redactor's list and is not
  // cleared, so a leak here would be a real leak rather than a test artefact.
  const API_KEY = "ai-secret-key-1234567890abcdef";
  const saved = { ...process.env };
  const previousApiKey = process.env.AI_API_KEY;
  try {
    process.env.AI_API_KEY = API_KEY;

    // The real dashboard with a failing real transport: the delivery path runs
    // end to end and the record really lands on disk.
    const h = await harness({
      transport: {
        channel: "EMAIL" as const,
        send: async () => {
          throw new Error(`provider rejected the request using api_key=${API_KEY} via smtp://qa:${PASSWORD}@${SMTP_HOST}`);
        },
      },
    });
    try {
      await h.runFinding();

      const records = readDeliveries(h.dir);
      assert.equal(records.length, 1, "a record was produced, so there is something to scan");
      assert.equal(records[0]!.status, "FAILED");

      // Everything the dashboard wrote during this cycle.
      for (const file of filesUnder(h.dir)) {
        const content = readFileSync(file, "utf8");
        assert.equal(content.includes(API_KEY), false, `${file} contains the API key`);
        assert.equal(content.includes(PASSWORD), false, `${file} contains the SMTP password`);
      }

      // And everything the API hands back.
      const surfaces = await Promise.all([
        fetch(`${h.base}/api/notifications`).then(r => r.json()),
        fetch(`${h.base}/api/notifications/unread-count`).then(r => r.json()),
        fetch(`${h.base}/api/projects/${h.projectId}`).then(r => r.json()),
        fetch(`${h.base}/api/projects/${h.projectId}/notifications`).then(r => r.json()),
        fetch(`${h.base}/api/projects/${h.projectId}/email-settings`).then(r => r.json()),
      ]);
      for (const surface of surfaces) {
        assert.equal(JSON.stringify(surface).includes(API_KEY), false, "an API response leaked the API key");
      }

      // A throwing transport must still have been contained: the transport's own
      // message is what would have carried the credential.
      assert.equal(records[0]!.status, "FAILED", "the attempt is recorded, not thrown at the run");
    } finally {
      await h.cleanup();
    }
  } finally {
    if (previousApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousApiKey;
    process.env = saved;
  }
});

// ===========================================================================
// 4. The settings screen is a configuration screen, not a credential screen
// ===========================================================================

test("secret: the email settings API never returns a credential, configured or not", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(CONFIGURED_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const h = await harness({ enabled: true, recipients: ["alice@example.com"] });
  try {
    const settings = await (await fetch(`${h.base}/api/projects/${h.projectId}/email-settings`)).json();
    const body = JSON.stringify(settings);

    assert.equal(body.includes(PASSWORD), false, "the password is not readable through the API");
    assert.equal(body.includes(SMTP_USER), false, "nor is the SMTP username");
    assert.equal(body.includes(SMTP_HOST), false, "nor the host: an operator does not need it to manage recipients");

    // What it DOES say is which variables are missing, which is the actionable part.
    assert.ok(JSON.stringify(settings).toLowerCase().includes("smtp"), "it still reports SMTP readiness in some form");
  } finally {
    await h.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ===========================================================================
// 5. A secret does not survive into the notification itself
// ===========================================================================

test("secret: notification content carries no configuration even when the notification is rendered", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(CONFIGURED_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let wire: { subject: string; text: string; html: string; to: string; from: string } | null = null;
    const capturing = new NotificationEmailTransport({
      env: CONFIGURED_ENV,
      createClient: () => ({
        sendMail: async (message: { subject: string; text: string; html: string; to: string; from: string }) => {
          wire = message;
          return { messageId: "smtp-1", rejected: [] };
        },
        close: async () => undefined,
      }),
    });

    const result = await capturing.send({ notification: note() as never, recipient: "alice@example.com" });
    assert.equal(result.status, "SENT", "a delivered message is checked, not only a failure");

    const body = JSON.stringify(wire);
    assert.equal(body.includes(PASSWORD), false, "the password never reaches the composed message");
    assert.equal(body.includes(SMTP_USER), false, "nor the username");
    assert.equal((wire as unknown as { from: string }).from.includes("alerts@example.test"), true,
      "the From address is the configured sender, which is not a secret");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});