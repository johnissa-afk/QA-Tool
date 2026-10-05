// ---------------------------------------------------------------------------
// Milestone 4: the dashboard email settings UI and its test-email endpoint.
//
// Two layers of evidence, matching how this repo already tests its UI:
//
//   1. API behaviour over real HTTP against a real dashboard server, with an
//      injected fake transport so no test can reach a mail server.
//   2. The served application file itself - the bytes a browser would receive -
//      asserted for the structure the API tests cannot see: labels, endpoints,
//      and the rule that success is never claimed before the API answers.
//
// Real browser validation (responsive layout, focus, keyboard) lives in
// tools/email-settings-browser.ts, because it needs a real Chromium.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSpawner, getJson, send } from "./notification-fixtures.js";
import { startDashboard } from "../dashboard/server.js";
import { renderTestEmailMessage } from "../dashboard/email-transport.js";
import type { EmailMessage, TestEmailOutcome, TestEmailSender } from "../dashboard/email-transport.js";
import { emailEventOptions } from "../dashboard/project-email-preferences.js";

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
};

const APP_HTML = readFileSync(join(process.cwd(), "src", "dashboard", "app.html"), "utf8");
const settingsSection = APP_HTML.match(/function emailSettingsSection\([\s\S]*?\n}\n/);

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
 * A fake SMTP transport.
 *
 * Records every message it is handed, so a test can prove WHICH recipient got
 * WHICH content - and never opens a socket. `outcome` decides what the server
 * will observe, including a failure that quotes the password back.
 */
const fakeTransport = (outcome: TestEmailOutcome | ((message: EmailMessage, recipient: string) => TestEmailOutcome) = { status: "SENT" }) => {
  const sent: Array<{ message: EmailMessage; recipient: string }> = [];
  return {
    sent,
    transport: {
      sendTestMessage: async (message: EmailMessage, recipient: string): Promise<TestEmailOutcome> => {
        sent.push({ message, recipient });
        return typeof outcome === "function" ? outcome(message, recipient) : outcome;
      },
    } satisfies TestEmailSender,
  };
};

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

const close = async (dash: Awaited<ReturnType<typeof boot>>) => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
};

/**
 * A dashboard with one real project.
 *
 * The project is created through the public API, so it exists in the document
 * exactly the way the dashboard itself would create it.
 */
const withProject = async (
  body: (ctx: { base: string; dir: string; dash: Awaited<ReturnType<typeof boot>>; projectId: string }) => Promise<void>,
  options: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
) => {
  const dir = tempDir("m4-ui-");
  const dash = await boot(dir, { emailTransport: fakeTransport().transport, ...options });
  const base = `http://127.0.0.1:${dash.port}`;
  const created = await send("POST", `${base}/api/projects`, { name: "Checkout", url: "https://qa.test/checkout" });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body({ base, dir, dash, projectId: created.json.project.id as string });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await close(dash);
  }
};

// ===========================================================================
// The served application
// ===========================================================================

test("the app still ships as one page and its inline script parses", async () => {
  const dir = tempDir("m4-shell-");
  const dash = await boot(dir);
  try {
    const html = await (await fetch(`http://127.0.0.1:${dash.port}/`)).text();
    assert.equal(html, APP_HTML, "the served app is the file on disk");
    const script = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script, "the app must ship an inline script");
    assert.doesNotThrow(() => new Function(script![1]), "the inline script must parse");
  } finally {
    await close(dash);
  }
});

test("the settings section is mounted on the project page", () => {
  assert.ok(settingsSection, "the settings section exists in the served app");
  // Mounted for the project it is given, without disturbing the existing page.
  assert.match(APP_HTML, /emailMount\.appendChild\(emailSettingsSection\(projectId\)\)/);
  assert.match(APP_HTML, /project-email-mount/);
  // The project's own page, reached through the router that already existed.
  assert.match(APP_HTML, /const projectMatch = location\.pathname\.match\(\/\^\\\/projects\\\/\(\[\^\/\]\+\)/);
  assert.match(APP_HTML, /if \(projectMatch\) return renderProjectPage\(mount, decodeURIComponent\(projectMatch\[1\]\)\)/);
});

test("the UI reads and writes the documented endpoints and invents none", () => {
  const section = settingsSection![0];
  // The path is built by one shared helper, so the two calls cannot drift apart.
  assert.match(
    APP_HTML,
    /const emailSettingsPath = \(projectId\) => "\/api\/projects\/" \+ encodeURIComponent\(projectId\) \+ "\/email-settings";/,
    "the settings path must be built from the documented route",
  );
  assert.match(section, /apiJson\(emailSettingsPath\(projectId\), \{\s*method: "PUT"/, "saving must be a PUT to the settings endpoint");
  assert.ok(section.includes('emailSettingsPath(projectId) + "/test"'), "the test-email call must use the documented route");
  assert.ok(section.includes('method: "POST"'), "the test email must be a POST");
  assert.ok(section.includes('apiJson(emailSettingsPath(projectId)).then(res =>'), "loading must read the same settings endpoint");
  // No other mail-ish endpoint is invented.
  for (const invented of ["/email-settings/send", "/email/test", "/smtp/test", "/email-settings/verify"]) {
    assert.equal(section.includes(invented), false, `${invented} is not an endpoint this app has`);
  }
});

test("the UI never claims success before the API answers", () => {
  const section = settingsSection![0];
  // "Saved" is only reachable on a resolved response that carried settings back.
  assert.match(section, /if \(!res\.ok \|\| !res\.body \|\| !res\.body\.settings\) \{[\s\S]*?error/);
  const savedIndex = section.indexOf('say("Saved"');
  const guardIndex = section.indexOf("if (!res.ok || !res.body || !res.body.settings)");
  assert.ok(guardIndex !== -1 && savedIndex > guardIndex, '"Saved" must come after the response is checked');
  // And the button is busy for the whole round trip.
  assert.match(section, /saveBtn\.textContent = "Saving\.\.\."/);
});

test("the UI renders the backend's event list instead of its own taxonomy", () => {
  const section = settingsSection![0];
  assert.match(section, /arr\(res\.body\.eventOptions\)/, "the event options must come from the API");
  for (const option of emailEventOptions()) {
    assert.equal(section.includes(option.type), false, `${option.type} must not be hard-coded`);
    assert.equal(section.includes(option.label), false, `the label for ${option.type} must not be hard-coded`);
  }
});

test("every event the backend offers has a label and a description", () => {
  const options = emailEventOptions();
  assert.equal(options.length, 7);
  for (const option of options) {
    assert.ok(option.label.trim().length > 0, `${option.type} needs a label`);
    assert.ok(option.description.trim().length > 0, `${option.type} needs a description`);
    assert.match(option.description, /\.$/, `${option.type} description should be a sentence`);
  }
  // The wording the milestone asked for, on the two examples it gave.
  assert.equal(options.find(o => o.type === "NEW_FINDING")?.label, "New finding");
  assert.equal(options.find(o => o.type === "REGRESSED_FINDING")?.label, "Finding regressed");
});

test("the settings API serves the event options the UI renders", async () => {
  await withProject(async ({ base, projectId }) => {
    const { status, json } = await getJson(`${base}/api/projects/${projectId}/email-settings`);
    assert.equal(status, 200);
    assert.deepEqual(json.eventOptions, emailEventOptions());
  });
});

test("the controls carry accessible names and states", () => {
  const section = settingsSection![0];
  // Every checkbox is a real input with a label bound by id.
  assert.match(section, /box\.type = "checkbox"/);
  assert.match(section, /label\.setAttribute\("for", id\)/);
  assert.match(section, /toggleLabel\.appendChild\(el\("span", null, "Email notifications"\)\)/);
  // The recipient input is labelled and its error is associated with it.
  assert.match(section, /addLabel\.setAttribute\("for", "email-recipient-" \+ projectId\)/);
  assert.match(section, /addInput\.setAttribute\("aria-describedby", "email-recipient-error-" \+ projectId\)/);
  assert.match(section, /addError\.setAttribute\("role", "alert"\)/);
  assert.match(section, /addInput\.setAttribute\("aria-invalid", "true"\)/);
  // Several "Remove" buttons stay distinguishable.
  assert.match(section, /remove\.setAttribute\("aria-label", "Remove " \+ address\)/);
  // Grouped and announced.
  assert.match(section, /el\("legend", null, "Email recipients"\)/);
  assert.match(section, /el\("legend", null, "Notification events"\)/);
  assert.match(section, /status\.setAttribute\("aria-live", "polite"\)/);
  // Loading and disabled states are communicated, not just styled.
  assert.match(section, /testBtn\.disabled = !state\.enabled/);
  assert.match(section, /saveBtn\.disabled = true/);
});

test("the UI carries no SMTP secret material", () => {
  const section = settingsSection![0];
  assert.equal(section.includes("SMTP_HOST"), false, "the UI must not read a variable the API does not return");
  assert.equal(section.includes("SMTP_PASSWORD"), false);
  assert.equal(section.includes("password"), false, "no password may appear anywhere in the settings UI");
  // Only the server-provided missing-variable NAMES are ever displayed.
  assert.match(section, /missingSmtpVariables/);
});

test("the UI's inline address check does not reject a valid address", () => {
  // The UI mirrors the server's rule so it can catch a typo inline. It must not be
  // stricter than the server: regression guard for a delimiter set that contained
  // "@", which rejected EVERY address and silently emptied the recipient list.
  const normalizer = APP_HTML.match(/const normalizeTypedEmail[\s\S]*?\n};/);
  assert.ok(normalizer, "the UI has its own inline address check");
  const delimiters = normalizer![0].match(/\/\[([^\]]*)\]\/\.test/);
  assert.ok(delimiters, "the check rejects a delimiter set");
  assert.equal(delimiters![1]!.includes("@"), false, "'@' must not be a forbidden delimiter");
  // A single '@' is required instead of merely allowed.
  assert.match(normalizer![0], /at !== lower\.lastIndexOf\("@"\)/, "exactly one '@' is enforced");
  // And the same function is what the Add control calls.
  assert.match(APP_HTML, /const normalized = normalizeTypedEmail\(addInput\.value\)/);
});

test("an unreachable API is reported, never replaced with invented settings", () => {
  const section = settingsSection![0];
  // On failure the section is replaced by an explicit error, not defaulted.
  assert.match(section, /if \(!res\.ok \|\| !res\.body \|\| !res\.body\.settings\) \{[\s\S]*?shell\.innerHTML = ""/);
  assert.match(section, /Email settings could not be loaded\./);
  // No catch that would quietly render defaults.
  assert.equal(section.includes('state = { enabled: false, recipients: [], events: [] };\n    draw();'), false);
});

test("recipients and events are hidden while email is off", () => {
  const section = settingsSection![0];
  assert.match(section, /recipientFieldset\.hidden = !state\.enabled/);
  assert.match(section, /eventFieldset\.hidden = !state\.enabled/);
});

test("the layout stays usable on small viewports", () => {
  // The design system already wraps every row; the event grid and the recipient
  // row collapse rather than overflowing.
  assert.match(APP_HTML, /@media \(max-width: 520px\)/);
  assert.match(APP_HTML, /\.eventlist \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(230px, 1fr\)\)/);
  assert.match(APP_HTML, /word-break: break-all/, "a long address must wrap, not overflow");
  assert.match(APP_HTML, /:focus-visible \{ outline: 2px solid var\(--accent\)/, "focus must stay visible");
});

// ===========================================================================
// Loading settings
// ===========================================================================

test("a project with no email configuration renders the defaults", async () => {
  await withProject(async ({ base, projectId }) => {
    const { json } = await getJson(`${base}/api/projects/${projectId}/email-settings`);
    assert.deepEqual(json.settings, { enabled: false, recipients: [], events: [] });
    assert.equal(json.emailConfigured, false, "with no SMTP in the environment, readiness says so");
    assert.deepEqual(json.missingSmtpVariables, ["SMTP_HOST", "SMTP_FROM"]);
  });
});

test("a configured project loads exactly what was persisted", async () => {
  await withProject(async ({ base, projectId }) => {
    await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
      enabled: true,
      recipients: [BOB, ALICE],
      events: ["RUN_FAILED", "NEW_FINDING"],
    });
    const { json } = await getJson(`${base}/api/projects/${projectId}/email-settings`);
    assert.deepEqual(json.settings, {
      enabled: true,
      recipients: [ALICE, BOB],
      events: ["NEW_FINDING", "RUN_FAILED"],
    });
  });
});

test("settings survive a dashboard restart", async () => {
  const dir = tempDir("m4-reload-");
  const first = await boot(dir);
  const base = `http://127.0.0.1:${first.port}`;
  const created = await send("POST", `${base}/api/projects`, { name: "Checkout", url: "https://qa.test/checkout" });
  const projectId = created.json.project.id as string;
  await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
    enabled: true,
    recipients: [ALICE, BOB],
    events: ["MEANINGFUL_CHANGE", "ACCESS_CHANGED"],
  });
  await close(first);

  const second = await boot(dir);
  try {
    const { json } = await getJson(`http://127.0.0.1:${second.port}/api/projects/${projectId}/email-settings`);
    assert.deepEqual(json.settings, {
      enabled: true,
      recipients: [ALICE, BOB],
      events: ["ACCESS_CHANGED", "MEANINGFUL_CHANGE"],
    });
  } finally {
    await close(second);
  }
});

test("an unknown project is a 404 on both settings routes", async () => {
  await withProject(async ({ base }) => {
    assert.equal((await getJson(`${base}/api/projects/prj-nope/email-settings`)).status, 404);
    assert.equal((await send("POST", `${base}/api/projects/prj-nope/email-settings/test`)).status, 404);
  });
});

// ===========================================================================
// Saving
// ===========================================================================

test("a valid save is persisted to the project document", async () => {
  await withProject(async ({ base, dir, projectId }) => {
    const saved = await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
      enabled: true,
      recipients: [" Developer@Example.com ", "qa@example.com", "developer@example.com"],
      events: ["NEW_FINDING", "REGRESSED_FINDING", "RUN_FAILED"],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.settings, {
      enabled: true,
      recipients: ["developer@example.com", "qa@example.com"],
      events: ["NEW_FINDING", "REGRESSED_FINDING", "RUN_FAILED"],
    });
    const onDisk = JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8")) as any;
    assert.deepEqual(onDisk.projects[0].emailNotifications, saved.json.settings);
  });
});

test("an invalid save is rejected and nothing is written", async () => {
  await withProject(async ({ base, dir, projectId }) => {
    const file = join(dir, "projects", "projects.json");
    const before = readFileSync(file, "utf8");
    const rejected = await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
      enabled: true,
      recipients: ["not-an-email"],
      events: ["PASSWORD_RESET"],
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.json.error, /valid email address/);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("saving does not start a run or touch findings, schedules or history", async () => {
  await withProject(async ({ base, dir, projectId }) => {
    await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
      enabled: true,
      recipients: [ALICE],
      events: ["NEW_FINDING"],
    });
    const onDisk = JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8")) as any;
    assert.deepEqual(onDisk.runs, [], "no run was created");
    assert.deepEqual(onDisk.findings, []);
    assert.deepEqual(onDisk.findingEvents, []);
    assert.deepEqual(onDisk.changeRecords, []);
    assert.equal(existsSync(join(dir, "projects", "schedules.json")), false, "no schedule was invented");
    assert.equal(existsSync(join(dir, "projects", "notifications.json")), false, "no notification was created");
    assert.equal(existsSync(join(dir, "projects", "notification-deliveries.json")), false, "no delivery was recorded");
  });
});

// ===========================================================================
// The test email
// ===========================================================================

test("the test email needs email switched on", async () => {
  await withProject(async ({ base, projectId }) => {
    const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
    assert.equal(status, 400);
    assert.equal(json.code, "EMAIL_DISABLED");
  });
});

test("the test email needs at least one recipient", async () => {
  await withProject(async ({ base, projectId }) => {
    await send("PUT", `${base}/api/projects/${projectId}/email-settings`, { enabled: true, recipients: [], events: ["NEW_FINDING"] });
    const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
    assert.equal(status, 400);
    assert.equal(json.code, "NO_RECIPIENTS");
  });
});

test("with no SMTP configuration the answer is reported without sending", async () => {
  const fake = fakeTransport();
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
      assert.equal(status, 400);
      assert.equal(json.code, "EMAIL_NOT_CONFIGURED");
      assert.equal(json.error, "Email could not be sent because SMTP is not configured.");
      assert.deepEqual(json.missingSmtpVariables, ["SMTP_HOST", "SMTP_FROM"]);
    },
    { emailTransport: fake.transport },
    { SMTP_HOST: undefined, SMTP_FROM: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined },
  );
  assert.deepEqual(fake.sent, [], "the transport is never called when SMTP is absent");
});

test("a successful test email reaches every configured recipient once", async () => {
  const fake = fakeTransport({ status: "SENT", providerMessageId: "<test@mail>" });
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE, BOB],
        events: ["NEW_FINDING"],
      });
      const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
      assert.equal(status, 200);
      assert.equal(json.code, "EMAIL_SENT");
      assert.equal(json.message, "Email sent successfully.");
      assert.equal(json.sent, 2);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
  assert.deepEqual(fake.sent.map(entry => entry.recipient), [ALICE, BOB]);
  assert.equal(new Set(fake.sent.map(entry => entry.recipient)).size, 2, "each recipient is mailed once");
});

test("the test email goes only to explicitly configured recipients", async () => {
  const fake = fakeTransport({ status: "SENT" });
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING", "RUN_FAILED"],
      });
      await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
  assert.deepEqual(fake.sent.map(entry => entry.recipient), [ALICE], "no address beyond the configured list is contacted");
});

test("the test message is a delivery test and not a QA event", async () => {
  const fake = fakeTransport({ status: "SENT" });
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
  const message = fake.sent[0]!.message;
  // No notification type anywhere: it is not dressed up as a finding or a run.
  for (const type of ["NEW_FINDING", "REGRESSED_FINDING", "RESOLVED_FINDING", "RUN_FAILED", "ACCESS_CHANGED", "SCHEDULE_SKIPPED", "MEANINGFUL_CHANGE"]) {
    assert.equal(message.subject.includes(type), false, `${type} must not appear in a test subject`);
    assert.equal(message.text.includes(type), false);
  }
  assert.match(message.subject, /test email/i);
  // And it says so in the body, because the recipient cannot otherwise tell.
  assert.match(message.text, /not a QA notification/i);
  assert.match(message.html, /not<\/strong> a QA notification/i);
  assert.match(message.text, new RegExp(`Sent to: ${ALICE}`));
});

test("the test message is deterministic", () => {
  const project = { id: "prj-1", name: "Checkout", url: "https://qa.test/checkout" };
  const first = renderTestEmailMessage(project, [ALICE], "http://127.0.0.1:4173");
  const second = renderTestEmailMessage(project, [ALICE], "http://127.0.0.1:4173");
  assert.deepEqual(first, second, "the same configuration produces the same bytes");
  // With no dashboard base URL there is no dead link, rather than a broken one.
  const noLink = renderTestEmailMessage(project, [ALICE], null);
  assert.equal(noLink.text.includes("Dashboard:"), false);
});

test("a test email creates no notification, delivery or QA record of any kind", async () => {
  const fake = fakeTransport({ status: "SENT" });
  await withProject(
    async ({ base, dir, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      const projectDocBefore = readFileSync(join(dir, "projects", "projects.json"), "utf8");
      await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);

      // No notification history and no delivery history were invented.
      assert.equal(existsSync(join(dir, "projects", "notifications.json")), false, "no QA notification was created");
      assert.equal(existsSync(join(dir, "projects", "notification-deliveries.json")), false, "no delivery record was written");
      const inbox = await getJson(`${base}/api/notifications`);
      assert.deepEqual(inbox.json.notifications, [], "the inbox stays empty");
      // And the project document itself is untouched by the send.
      assert.equal(readFileSync(join(dir, "projects", "projects.json"), "utf8"), projectDocBefore);
      const onDisk = JSON.parse(projectDocBefore) as any;
      assert.deepEqual(onDisk.runs, []);
      assert.deepEqual(onDisk.findings, []);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
});

test("an SMTP failure is reported without exposing the server's error", async () => {
  const fake = fakeTransport({ status: "FAILED", error: `SMTP send failed: EAUTH: password rejected for bad password ${SECRET}@smtp.example.test` });
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
      assert.equal(status, 502);
      assert.equal(json.code, "EMAIL_SEND_FAILED");
      assert.equal(json.error, "Email could not be sent. Check the email configuration and try again.");
      // Nothing that identifies the deployment or the account.
      const serialized = JSON.stringify(json);
      assert.equal(serialized.includes(SECRET), false, "a password must never be returned");
      assert.equal(serialized.includes("EAUTH"), false, "the raw SMTP code must not be returned");
      assert.equal(serialized.includes("smtp.example.test"), false, "the SMTP host must not be returned");
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
  assert.equal(fake.sent.length, 1, "the send was genuinely attempted");
});

test("a partial failure is reported as a failure", async () => {
  const fake = fakeTransport((_message, recipient) =>
    recipient === ALICE ? { status: "SENT" } : { status: "FAILED", error: "ETIMEDOUT" },
  );
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE, BOB],
        events: ["NEW_FINDING"],
      });
      const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
      assert.equal(status, 502, "one undelivered recipient means the test did not fully pass");
      assert.equal(json.code, "EMAIL_SEND_FAILED");
      assert.equal(json.sent, 1, "the count of what did arrive is still reported");
      assert.deepEqual(json.results, [
        { recipient: ALICE, status: "SENT" },
        { recipient: BOB, status: "FAILED" },
      ]);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
});

test("a transport that throws is contained and reported safely", async () => {
  const throwing = {
    sendTestMessage: async (): Promise<TestEmailOutcome> => {
      throw new Error(`connect failed with ${SECRET}`);
    },
  } satisfies TestEmailSender;
  await withProject(
    async ({ base, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      const { status, json } = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
      assert.equal(status, 502);
      assert.equal(json.code, "EMAIL_SEND_FAILED");
      assert.equal(JSON.stringify(json).includes(SECRET), false, "a thrown error must not leak either");
    },
    { emailTransport: throwing },
    WITH_SMTP,
  );
});

test("the test route rejects the wrong method", async () => {
  await withProject(async ({ base, projectId }) => {
    const res = await fetch(`${base}/api/projects/${projectId}/email-settings/test`);
    assert.equal(res.status, 405);
  });
});

test("the test route rejects a malformed project id before doing anything", async () => {
  const fake = fakeTransport();
  await withProject(
    async ({ base }) => {
      const { status } = await send("POST", `${base}/api/projects/${encodeURIComponent("../../etc")}/email-settings/test`);
      assert.equal(status, 400);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
  assert.deepEqual(fake.sent, []);
});

// ===========================================================================
// Security
// ===========================================================================

test("no settings response carries SMTP credentials", async () => {
  const fake = fakeTransport({ status: "SENT" });
  await withProject(
    async ({ base, projectId }) => {
      const saved = await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      const read = await getJson(`${base}/api/projects/${projectId}/email-settings`);
      const tested = await send("POST", `${base}/api/projects/${projectId}/email-settings/test`);
      for (const payload of [saved.json, read.json, tested.json]) {
        const serialized = JSON.stringify(payload);
        assert.equal(serialized.includes(SECRET), false, "the SMTP password must never be returned");
        assert.equal(serialized.includes("smtp.example.test"), false, "the SMTP host must never be returned");
        assert.equal(serialized.includes("qa@example.test"), false, "the SMTP username must never be returned");
      }
      // Readiness is a boolean plus variable names.
      assert.equal(read.json.emailConfigured, true);
      assert.deepEqual(read.json.missingSmtpVariables, []);
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
});

test("SMTP credentials are never stored in project settings", async () => {
  await withProject(
    async ({ base, dir, projectId }) => {
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING"],
      });
      const document = readFileSync(join(dir, "projects", "projects.json"), "utf8");
      assert.equal(document.includes(SECRET), false);
      // Only the three configured fields exist on the project.
      const stored = (JSON.parse(document) as any).projects[0].emailNotifications;
      assert.deepEqual(Object.keys(stored).sort(), ["enabled", "events", "recipients"]);
    },
    {},
    WITH_SMTP,
  );
});

// ===========================================================================
// Scope boundary
// ===========================================================================

test("no automatic delivery is wired to notification or run creation", () => {
  // Milestone 5 territory. The delivery seam and the test sender both exist, but
  // nothing that creates a notification, a run or a schedule may reach them. The
  // two modules that DEFINE those symbols own them and are checked separately.
  const consumers = ["notifications.ts", "notification-preview.ts", "notification-delivery.ts", "scheduler.ts", "run-manager.ts"];
  for (const name of consumers) {
    const text = readFileSync(join(process.cwd(), "src", "dashboard", name), "utf8");
    assert.equal(text.includes("sendTestMessage"), false, `${name} must not send a test email`);
    assert.equal(text.includes("deliverEligibleProjectEmail"), false, `${name} must not auto-deliver`);
  }
  // The preferences module owns the eligibility seam, but still never sends mail.
  const preferences = readFileSync(join(process.cwd(), "src", "dashboard", "project-email-preferences.ts"), "utf8");
  assert.equal(preferences.includes("sendTestMessage"), false, "project-email-preferences.ts must not send a test email");
  // The transport owns the test sender, but still never auto-delivers.
  const transport = readFileSync(join(process.cwd(), "src", "dashboard", "email-transport.ts"), "utf8");
  assert.equal(transport.includes("deliverEligibleProjectEmail"), false, "email-transport.ts must not auto-deliver");
  // The test-email route is the single place the injected transport is called.
  const server = readFileSync(join(process.cwd(), "src", "dashboard", "server.ts"), "utf8");
  assert.equal((server.match(/await emailTransport\.sendTestMessage\(/g) ?? []).length, 1, "exactly one dispatch site");
});

test("a saved configuration with email enabled sends nothing on its own", async () => {
  const fake = fakeTransport({ status: "SENT" });
  await withProject(
    async ({ base, dir, projectId }) => {
      // Enabled, a recipient, events selected - the configuration production
      // delivery would act on. Nothing may be sent by having saved it.
      await send("PUT", `${base}/api/projects/${projectId}/email-settings`, {
        enabled: true,
        recipients: [ALICE],
        events: ["NEW_FINDING", "RUN_FAILED"],
      });
      const projectDoc = readFileSync(join(dir, "projects", "projects.json"), "utf8");
      assert.equal(projectDoc.includes("@example.com"), true, "the recipient really is configured");
    },
    { emailTransport: fake.transport },
    WITH_SMTP,
  );
  assert.deepEqual(fake.sent, [], "saving an enabled configuration sends nothing");
});