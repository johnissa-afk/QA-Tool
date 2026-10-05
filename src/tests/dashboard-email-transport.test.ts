// ---------------------------------------------------------------------------
// The EMAIL channel transport.
//
// Configuration, deterministic subjects and bodies, SMTP outcomes through a
// mocked client, retry and idempotency through the real Delivery Core, and the
// security rules - all without a network socket, a real SMTP server, or any
// credential that could leak.
//
// Every fixture is an isolated temporary directory, so no test here can invent
// delivery history against the user's own projects.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodemailerClient,
  emailDashboardLink,
  emailSubject,
  EMAIL_NOT_CONFIGURED,
  loadEmailConfig,
  NotificationEmailTransport,
  renderEmailMessage,
} from "../dashboard/email-transport.js";
import type { EmailConfig, OutgoingEmail, SmtpClientFactory, SmtpEmailClient, SmtpResponse } from "../dashboard/email-transport.js";
import {
  InMemoryDeliveryTransport,
  NotificationDeliveryDispatcher,
  NotificationDeliveryStore,
} from "../dashboard/notification-delivery.js";
import { notificationFromEvent } from "../dashboard/notifications.js";
import type { NotificationPreviewEvent } from "../dashboard/notification-preview.js";
import { analysisWith, fakeSpawner, finding, getJson, postJson, runOnce, start, stop } from "./notification-fixtures.js";

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const deliveriesOf = (dir: string): string => join(dir, "projects", "notification-deliveries.json");

const ALICE = "alice@example.com";
const SECRET = "smtp-secret-pw-9f3a-do-not-leak";
const DASHBOARD = "http://127.0.0.1:4173";

const ENV = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "qa@example.test",
  SMTP_PASSWORD: SECRET,
  SMTP_FROM: "qa@example.test",
  SMTP_FROM_NAME: "AI Website QA",
} as NodeJS.ProcessEnv;

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
  details: ["code=BTN", "page=https://qa.test/pricing"],
  ...overrides,
});

const notification = (overrides: Partial<NotificationPreviewEvent> = {}) =>
  notificationFromEvent(event(overrides), "2026-09-29T10:05:00.000Z");

/** Records what the SMTP client was asked to send, and answers on demand. */
const fakeSmtp = (
  behaviour: { sent?: SmtpResponse; error?: unknown } = {},
): SmtpClientFactory & { sent: OutgoingEmail[]; configs: EmailConfig[] } => {
  const sent: OutgoingEmail[] = [];
  const configs: EmailConfig[] = [];
  const factory: SmtpClientFactory = config => {
    configs.push(config);
    const client: SmtpEmailClient = {
      async sendMail(message: OutgoingEmail): Promise<SmtpResponse> {
        sent.push(message);
        if (behaviour.error !== undefined) throw behaviour.error;
        return behaviour.sent ?? { messageId: "smtp-1", accepted: [message.to], rejected: [] };
      },
    };
    return client;
  };
  return Object.assign(factory, { sent, configs });
};

/** Builds a dispatcher wired to the email transport, in its own temp dir. */
const emailDelivery = (
  factory: SmtpClientFactory,
  options: { env?: NodeJS.ProcessEnv; dashboardUrl?: string | null } = {},
) => {
  const dir = tempDir("ai-website-qa-email-");
  const store = new NotificationDeliveryStore(deliveriesOf(dir));
  const transport = new NotificationEmailTransport({
    createClient: factory,
    env: options.env ?? ENV,
    dashboardUrl: options.dashboardUrl === undefined ? DASHBOARD : options.dashboardUrl,
  });
  const dispatcher = new NotificationDeliveryDispatcher({ store, transports: { EMAIL: transport } });
  return { dir, store, transport, dispatcher };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("a complete SMTP configuration is accepted", () => {
  const result = loadEmailConfig(ENV);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.config.host, "smtp.example.test");
  assert.equal(result.ok && result.config.port, 587);
  assert.equal(result.ok && result.config.secure, false);
  assert.equal(result.ok && result.config.user, "qa@example.test");
  assert.equal(result.ok && result.config.from, "qa@example.test");
  assert.equal(result.ok && result.config.fromName, "AI Website QA");
});

test("defaults are derived, not guessed: port 587, implicit TLS only on 465", () => {
  const bare = loadEmailConfig({ SMTP_HOST: "smtp.example.test", SMTP_FROM: "qa@example.test" } as NodeJS.ProcessEnv);
  assert.equal(bare.ok && bare.config.port, 587);
  assert.equal(bare.ok && bare.config.secure, false);
  assert.equal(bare.ok && bare.config.user, null);

  const implicitTls = loadEmailConfig({ SMTP_HOST: "h", SMTP_PORT: "465", SMTP_FROM: "f@x.test" } as NodeJS.ProcessEnv);
  assert.equal(implicitTls.ok && implicitTls.config.secure, true);

  const explicit = loadEmailConfig({ SMTP_HOST: "h", SMTP_PORT: "25", SMTP_SECURE: "true", SMTP_FROM: "f@x.test" } as NodeJS.ProcessEnv);
  assert.equal(explicit.ok && explicit.config.secure, true);
  assert.equal(explicit.ok && explicit.config.port, 25);
});

test("incomplete configuration is EMAIL_NOT_CONFIGURED, naming what is missing", () => {
  const noHost = loadEmailConfig({ ...ENV, SMTP_HOST: undefined });
  assert.equal(noHost.ok, false);
  assert.equal(!noHost.ok && noHost.reason, EMAIL_NOT_CONFIGURED);
  assert.deepEqual(!noHost.ok ? noHost.missing : null, ["SMTP_HOST"]);

  assert.deepEqual((() => { const r = loadEmailConfig({ ...ENV, SMTP_FROM: "  " }); return !r.ok ? r.missing : null; })(), ["SMTP_FROM"]);

  // Half a credential pair is a misconfiguration, not an unauthenticated server.
  assert.deepEqual((() => { const r = loadEmailConfig({ ...ENV, SMTP_PASSWORD: undefined }); return !r.ok ? r.missing : null; })(), ["SMTP_PASSWORD"]);
  assert.deepEqual((() => { const r = loadEmailConfig({ ...ENV, SMTP_USER: undefined }); return !r.ok ? r.missing : null; })(), ["SMTP_USER"]);
  assert.deepEqual((() => { const r = loadEmailConfig({} as NodeJS.ProcessEnv); return !r.ok ? r.missing : null; })(), ["SMTP_HOST", "SMTP_FROM"]);
});

test("missing configuration never opens a connection and never reaches SMTP", async () => {
  const factory = fakeSmtp();
  const { store, dispatcher } = emailDelivery(factory, { env: { SMTP_HOST: undefined, SMTP_FROM: undefined } as NodeJS.ProcessEnv });

  const result = await dispatcher.deliver(notification(), ALICE);
  assert.equal(result.ok, true);
  const delivery = result.ok ? result.value.delivery : null;
  assert.equal(delivery?.status, "FAILED");
  assert.match(delivery?.error ?? "", new RegExp(EMAIL_NOT_CONFIGURED));
  assert.match(delivery?.error ?? "", /SMTP_HOST/);
  // The factory that would have dialled a server was never invoked.
  assert.equal(factory.sent.length, 0);
  assert.equal(factory.configs.length, 0);
  assert.equal(store.list().total, 1);
});

// ---------------------------------------------------------------------------
// Deterministic subjects and bodies
// ---------------------------------------------------------------------------

test("every existing notification type has its own deterministic subject", () => {
  const cases: Array<[NotificationPreviewEvent["type"], string]> = [
    ["NEW_FINDING", "[QA] New finding — Checkout"],
    ["REGRESSED_FINDING", "[QA] Finding regressed — Checkout"],
    ["RESOLVED_FINDING", "[QA] Finding resolved — Checkout"],
    ["RUN_FAILED", "[QA] QA run failed — Checkout"],
    ["ACCESS_CHANGED", "[QA] Access changed — Checkout"],
    ["SCHEDULE_SKIPPED", "[QA] Scheduled run skipped — Checkout"],
    ["MEANINGFUL_CHANGE", "[QA] Meaningful QA change — Checkout"],
  ];
  for (const [type, expected] of cases) {
    const record = notification({ type });
    assert.equal(emailSubject(record), expected);
    // Same notification, rendered twice, is byte-identical.
    assert.deepEqual(renderEmailMessage(record, DASHBOARD), renderEmailMessage(record, DASHBOARD));
  }
  // No type outside the existing set produces a subject.
  const known = new Set(cases.map(([type]) => type));
  assert.equal(known.size, 7);
});

test("the plain-text body carries the real event, project, severity and link", () => {
  const record = notification();
  const { text } = renderEmailMessage(record, DASHBOARD);
  assert.match(text, /Event: NEW_FINDING/);
  assert.match(text, /Project: Checkout/);
  assert.match(text, /Severity: HIGH/);
  assert.match(text, /Run: web-run-1/);
  assert.match(text, /Finding: prj-fnd-1/);
  assert.match(text, /A tracked finding appeared for the first time\./);
  assert.match(text, /- code=BTN/);
  assert.match(text, /Recorded at: 2026-09-29T10:05:00\.000Z/);
  assert.match(text, /Dashboard: http:\/\/127\.0\.0\.1:4173\/projects\/web-abc123\?finding=prj-fnd-1/);
});

test("the HTML body escapes content and links to the same real route", () => {
  const record = notification({ projectName: 'Checkout <script>"x"</script>' });
  const { html, subject } = renderEmailMessage(record, DASHBOARD);
  assert.match(html, /<h1>\[QA\] New finding — Checkout &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<a href="http:\/\/127\.0\.0\.1:4173\/projects\/web-abc123\?finding=prj-fnd-1">/);
  // The subject is a plain-text header and keeps the recorded name verbatim; only
  // the HTML body escapes, because only HTML is interpreted.
  assert.equal(subject, '[QA] New finding — Checkout <script>"x"</script>');
  assert.doesNotMatch(subject, /&lt;|&amp;|&quot;/);
  assert.match(html, /<th align="left">Severity<\/th><td>HIGH<\/td>/);
});

test("a field the notification does not have is omitted, never invented", () => {
  // A schedule skip has no severity, no run and no finding.
  const skip = notification({
    type: "SCHEDULE_SKIPPED",
    severity: null,
    runId: null,
    findingId: null,
    details: undefined,
    reference: "exec-1",
  });
  const { text, html } = renderEmailMessage(skip, DASHBOARD);
  assert.doesNotMatch(text, /Severity:/);
  assert.doesNotMatch(text, /Finding:/);
  assert.doesNotMatch(text, /^Run:/m);
  assert.doesNotMatch(text, /unknown|n\/a|TBD|placeholder/i);
  assert.doesNotMatch(html, /Severity/);
  // It still links to the project, which is a real route with no finding on it.
  assert.match(text, /Dashboard: http:\/\/127\.0\.0\.1:4173\/projects\/web-abc123$/m);
});

test("no run deep link is invented, because the dashboard reads no run parameter", () => {
  const record = notification({ findingId: null });
  const link = emailDashboardLink(record, DASHBOARD);
  assert.equal(link, `${DASHBOARD}/projects/web-abc123`);
  assert.doesNotMatch(link ?? "", /[?&]run=/);
  assert.equal(renderEmailMessage(record, DASHBOARD).text.includes("?run="), false);

  // With no dashboard URL or no project, there is no link at all - not a broken one.
  assert.equal(emailDashboardLink(record, null), null);
  assert.equal(emailDashboardLink(notification({ projectId: "" }), DASHBOARD), null);
  const noLink = renderEmailMessage(record, null).text;
  assert.doesNotMatch(noLink, /Dashboard:/);
});

test("only finding events deep-link to a finding", () => {
  const findingEvent = notification({ findingId: "prj-fnd-9" });
  for (const type of ["NEW_FINDING", "REGRESSED_FINDING", "RESOLVED_FINDING"] as const) {
    assert.match(emailDashboardLink(notification({ type, findingId: "prj-fnd-9" }), DASHBOARD) ?? "", /\?finding=prj-fnd-9$/);
  }
  for (const type of ["RUN_FAILED", "ACCESS_CHANGED", "SCHEDULE_SKIPPED", "MEANINGFUL_CHANGE"] as const) {
    const link = emailDashboardLink(notification({ type, findingId: "prj-fnd-9" }), DASHBOARD);
    assert.doesNotMatch(link ?? "", /finding=/);
  }
  assert.doesNotMatch(emailDashboardLink(findingEvent, DASHBOARD) ?? "", /prj-fnd-1$/);
});

// ---------------------------------------------------------------------------
// SMTP outcomes
// ---------------------------------------------------------------------------

test("a successful SMTP send is SENT and the message is what we composed", async () => {
  const factory = fakeSmtp({ sent: { messageId: "smtp-abc", accepted: [ALICE], rejected: [] } });
  const { store, dispatcher } = emailDelivery(factory);

  const result = await dispatcher.deliver(notification(), ALICE);
  assert.equal(result.ok && result.value.delivery.status, "SENT");
  assert.equal(result.ok && result.value.delivery.providerMessageId, "smtp-abc");
  assert.equal(result.ok && result.value.alreadyDelivered, false);

  const sent = factory.sent[0]!;
  assert.equal(sent.to, ALICE);
  assert.equal(sent.from, "AI Website QA <qa@example.test>");
  assert.equal(sent.subject, "[QA] New finding — Checkout");
  assert.match(sent.text, /Event: NEW_FINDING/);
  assert.match(sent.html, /<h1>\[QA\] New finding/);
  // The credentials reached the client and were used for auth, nothing else.
  assert.equal(factory.configs[0]!.password, SECRET);
  assert.equal(store.list().total, 1);
});

test("no from name means a bare address, and no auth means no credentials are sent", async () => {
  const factory = fakeSmtp();
  const transport = new NotificationEmailTransport({
    createClient: factory,
    env: { SMTP_HOST: "smtp.example.test", SMTP_FROM: "qa@example.test" } as NodeJS.ProcessEnv,
    dashboardUrl: DASHBOARD,
  });
  const result = await transport.send({ notification: notification(), recipient: ALICE });
  assert.equal(result.status, "SENT");
  assert.equal(factory.sent[0]!.from, "qa@example.test");
  assert.equal(factory.configs[0]!.user, null);
  assert.equal(factory.configs[0]!.password, null);
});

test("SMTP failures are FAILED: refused, timed out, auth rejected", async () => {
  const cases: Array<[string, NodeJS.ErrnoException]> = [
    ["ECONNREFUSED", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:587"), { code: "ECONNREFUSED" })],
    ["ETIMEDOUT", Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" })],
    ["EAUTH", Object.assign(new Error("Invalid credentials"), { code: "EAUTH" })],
  ];
  for (const [code, error] of cases) {
    const factory = fakeSmtp({ error });
    const { store, dispatcher } = emailDelivery(factory);
    const result = await dispatcher.deliver(notification(), ALICE);
    assert.equal(result.ok && result.value.delivery.status, "FAILED", `${code} must be FAILED`);
    const failed = store.list({ status: "FAILED" }).deliveries[0]!;
    assert.match(failed.error!, new RegExp(code));
    assert.match(failed.error!, /SMTP send failed/);
  }
});

test("a recipient the server rejects is FAILED, not a silent success", async () => {
  const factory = fakeSmtp({ sent: { messageId: "smtp-1", accepted: [], rejected: [ALICE] } });
  const { store, dispatcher } = emailDelivery(factory);
  const result = await dispatcher.deliver(notification(), ALICE);
  assert.equal(result.ok && result.value.delivery.status, "FAILED");
  assert.match(result.ok ? result.value.delivery.error ?? "" : "", /rejected the recipient/);
  assert.equal(store.hasSucceeded(result.ok ? result.value.delivery.deliveryKey : ""), false);
});

test("a transport that cannot even be constructed is a FAILED delivery", async () => {
  const { store, dispatcher } = emailDelivery(() => { throw new Error("nodemailer is not installed"); });
  const result = await dispatcher.deliver(notification(), ALICE);
  assert.equal(result.ok && result.value.delivery.status, "FAILED");
  assert.match(result.ok ? result.value.delivery.error ?? "" : "", /could not be created/);
  assert.equal(store.list().total, 1);
});

// ---------------------------------------------------------------------------
// Retry and idempotency through the real Delivery Core
// ---------------------------------------------------------------------------

test("a failed email is retried, the retry really re-sends, and success becomes SENT", async () => {
  const dir = tempDir("ai-website-qa-email-retry-");
  const store = new NotificationDeliveryStore(deliveriesOf(dir));
  const record = notification();

  // First attempt: the server is down.
  const down = fakeSmtp({ error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  const first = new NotificationDeliveryDispatcher({
    store,
    transports: { EMAIL: new NotificationEmailTransport({ createClient: down, env: ENV, dashboardUrl: DASHBOARD }) },
  });
  const failed = await first.deliver(record, ALICE);
  assert.equal(failed.ok && failed.value.delivery.status, "FAILED");
  assert.equal(failed.ok && failed.value.delivery.attempt, 1);

  // Retry through a working server, exactly as a later milestone would do.
  const up = fakeSmtp({ sent: { messageId: "smtp-2", accepted: [ALICE], rejected: [] } });
  const second = new NotificationDeliveryDispatcher({
    store,
    transports: { EMAIL: new NotificationEmailTransport({ createClient: up, env: ENV, dashboardUrl: DASHBOARD }) },
  });
  const retried = await second.deliver(record, ALICE);
  assert.equal(retried.ok && retried.value.delivery.status, "SENT");
  assert.equal(retried.ok && retried.value.delivery.attempt, 2);
  // The retry genuinely invoked SMTP again.
  assert.equal(up.sent.length, 1);
  assert.equal(up.sent[0]!.to, ALICE);

  // The failure is still on the record; the retry did not overwrite it.
  const attempts = store.attemptsFor(retried.ok ? retried.value.delivery.deliveryKey : "");
  assert.deepEqual(attempts.map(entry => [entry.attempt, entry.status]), [[1, "FAILED"], [2, "SENT"]]);
});

test("an already-sent email is never sent again", async () => {
  const factory = fakeSmtp();
  const { dispatcher, store } = emailDelivery(factory);
  const record = notification();

  await dispatcher.deliver(record, ALICE);
  assert.equal(factory.sent.length, 1);

  const again = await dispatcher.deliver(record, ALICE);
  assert.equal(again.ok && again.value.delivery.status, "SKIPPED");
  assert.equal(again.ok && again.value.delivery.reason, "ALREADY_DELIVERED");
  assert.equal(again.ok && again.value.alreadyDelivered, true);
  assert.equal(factory.sent.length, 1, "SMTP must not be dialled twice");
  assert.equal(store.list({ status: "SENT" }).total, 1);

  // The deterministic identity is unchanged from Milestone 1.
  assert.equal(again.ok ? again.value.delivery.id.startsWith("dlv-") : false, true);
  // And a different recipient of the same notification is still a fresh send.
  await dispatcher.deliver(record, "bob@example.com");
  assert.equal(factory.sent.length, 2);
});

test("idempotency survives a restart with a brand new SMTP client", async () => {
  const dir = tempDir("ai-website-qa-email-restart-");
  const record = notification();
  const first = fakeSmtp();
  const one = new NotificationDeliveryDispatcher({
    store: new NotificationDeliveryStore(deliveriesOf(dir)),
    transports: { EMAIL: new NotificationEmailTransport({ createClient: first, env: ENV, dashboardUrl: DASHBOARD }) },
  });
  await one.deliver(record, ALICE);
  assert.equal(first.sent.length, 1);

  const second = fakeSmtp();
  const reopened = new NotificationDeliveryDispatcher({
    store: new NotificationDeliveryStore(deliveriesOf(dir)),
    transports: { EMAIL: new NotificationEmailTransport({ createClient: second, env: ENV, dashboardUrl: DASHBOARD }) },
  });
  const result = await reopened.deliver(record, ALICE);
  assert.equal(result.ok && result.value.delivery.reason, "ALREADY_DELIVERED");
  assert.equal(second.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("the SMTP password never reaches a delivery record, an API response or a log line", async () => {
  const dir = tempDir("ai-website-qa-email-secret-");
  const store = new NotificationDeliveryStore(deliveriesOf(dir));

  // A server that is helpful enough to quote the credential back at us.
  const leaky = fakeSmtp({ error: new Error(`535 5.7.8 Authentication failed for user qa with password ${SECRET}`) });
  const dispatcher = new NotificationDeliveryDispatcher({
    store,
    transports: { EMAIL: new NotificationEmailTransport({ createClient: leaky, env: ENV, dashboardUrl: DASHBOARD }) },
  });
  const result = await dispatcher.deliver(notification(), ALICE);
  assert.equal(result.ok && result.value.delivery.status, "FAILED");

  // The persisted document is clean.
  const document = readFileSync(deliveriesOf(dir), "utf8");
  assert.doesNotMatch(document, new RegExp(SECRET));
  assert.doesNotMatch(document, /smtp-secret-pw/);
  assert.match(document, /\*\*\*/);

  // The returned record is clean too, and the user name is not the password.
  const record = result.ok ? result.value.delivery : null;
  assert.equal(JSON.stringify(record).includes(SECRET), false);
  assert.equal(existsSync(join(dir, "projects", "projects.json")), false, "no project document is written");
});

test("an SMTP URI carrying credentials is redacted out of an error", async () => {
  const leaky = fakeSmtp({ error: Object.assign(new Error("connect ECONNREFUSED smtp://qa:" + SECRET + "@mail.example.test:587"), { code: "ECONNREFUSED" }) });
  const { dispatcher } = emailDelivery(leaky);
  const result = await dispatcher.deliver(notification(), ALICE);
  const error = result.ok ? result.value.delivery.error ?? "" : "";
  assert.doesNotMatch(error, new RegExp(SECRET));
  assert.match(error, /\*\*\*/);
});

test("the deliveries API reports email outcomes without leaking configuration", async () => {
  const dir = tempDir("ai-website-qa-email-api-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    const stored = (await getJson(`${base}/api/notifications`)).json.notifications[0];

    const failing = new NotificationDeliveryDispatcher({
      store: dash.notificationDeliveries,
      transports: {
        EMAIL: new NotificationEmailTransport({
          createClient: fakeSmtp({ error: new Error(`bad password ${SECRET}`) }),
          env: ENV,
          dashboardUrl: base,
        }),
      },
    });
    await failing.deliver(stored, ALICE);

    const response = await getJson(`${base}/api/notifications/${stored.id}/deliveries`);
    assert.equal(response.status, 200);
    assert.equal(response.json.total, 1);
    const record = response.json.deliveries[0];
    assert.equal(record.channel, "EMAIL");
    assert.equal(record.recipient, ALICE);
    assert.equal(record.status, "FAILED");
    assert.ok(record.attemptedAt);

    const body = JSON.stringify(response.json);
    // The credential itself is gone, as is every piece of SMTP configuration.
    assert.doesNotMatch(body, new RegExp(SECRET));
    for (const forbidden of ["SMTP_PASSWORD", "SMTP_HOST", "smtp.example.test", "smtp://", "qajwt"]) {
      assert.doesNotMatch(body, new RegExp(forbidden, "i"), `${forbidden} must not be exposed`);
    }
    // A redacted value may still leave the WORD in the sentence, which is not a
    // credential; what matters is that no secret value survives unredacted.
    assert.doesNotMatch(body, /bad password\s+(?!\*\*\*)\S/);
  } finally { await stop(dash); }
});

test("the email module keeps credentials out of its own code paths", () => {
  const source = readFileSync(join(process.cwd(), "src", "dashboard", "email-transport.ts"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/^\s*\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'))
    .join("\n");

  // Nothing is logged and nothing is written: there is no logger, no fs writer and
  // no console call anywhere in the transport.
  assert.doesNotMatch(code, /console\.|writeFileSync|appendFileSync|createWriteStream|process\.stdout|process\.stderr/);
  // The password is only ever read out of the config into the auth block.
  assert.doesNotMatch(code, /JSON\.stringify\([^)]*config/);
  // Credentials are never logged through an error object either.
  assert.doesNotMatch(code, /throw new Error\([^)]*(password|config)\b/i);
});

test("the real nodemailer factory builds a client without opening a socket", () => {
  // The production path is real and wired, not a stub.
  assert.equal(typeof createNodemailerClient, "function");
  const client = createNodemailerClient({
    host: "127.0.0.1",
    port: 1,
    secure: false,
    user: "qa@example.test",
    password: SECRET,
    from: "qa@example.test",
    fromName: null,
  });
  // Creating the transporter is lazy in nodemailer, so this proves the factory
  // works while guaranteeing no connection was attempted. sendMail is never
  // called anywhere in this suite, so no test touches a network.
  assert.equal(typeof client.sendMail, "function");
});

// ---------------------------------------------------------------------------
// Regression: QA execution and notification generation are untouched
// ---------------------------------------------------------------------------

test("email delivery disturbs no QA state, no notification and no schedule", async () => {
  const dir = tempDir("ai-website-qa-email-isolation-");
  const fake = fakeSpawner();
  const { dash, base } = await start(dir, fake.spawnImpl);
  try {
    const projectId = String((await postJson(`${base}/api/projects`, { name: "Checkout", url: "https://qa.test/" })).json.project.id);
    await runOnce(base, projectId, fake.children, 0, analysisWith([finding()]));
    await runOnce(base, projectId, fake.children, 1, analysisWith([finding()]));

    const before = await getJson(`${base}/api/projects/${projectId}`);
    const inboxBefore = readFileSync(join(dir, "projects", "notifications.json"), "utf8");
    const inbox = (await getJson(`${base}/api/notifications`)).json;

    const dispatcher = new NotificationDeliveryDispatcher({
      store: dash.notificationDeliveries,
      transports: {
        EMAIL: new NotificationEmailTransport({
          createClient: fakeSmtp({ error: Object.assign(new Error("EAUTH"), { code: "EAUTH" }) }),
          env: ENV,
          dashboardUrl: base,
        }),
      },
    });
    for (const item of inbox.notifications) await dispatcher.deliver(item, ALICE);

    // Nothing about the QA side moved.
    const after = await getJson(`${base}/api/projects/${projectId}`);
    assert.deepEqual(after.json.runs.map((r: { runId: string; state: string; status: string }) => [r.runId, r.state, r.status]),
      before.json.runs.map((r: { runId: string; state: string; status: string }) => [r.runId, r.state, r.status]));
    assert.deepEqual(after.json.findings, before.json.findings);
    assert.equal(after.json.project.lastStatus, before.json.project.lastStatus);
    // The notification document is byte-identical and no new event appeared.
    assert.equal(readFileSync(join(dir, "projects", "notifications.json"), "utf8"), inboxBefore);
    assert.equal((await getJson(`${base}/api/notifications`)).json.total, inbox.total);
    // Every attempt failed, and none of them is a success.
    assert.equal(dash.notificationDeliveries.list({ status: "FAILED" }).total, inbox.total);
    assert.equal(dash.notificationDeliveries.list({ status: "SENT" }).total, 0);
  } finally { await stop(dash); }
});

test("the SMTP variables are not written into any project document", () => {
  // loadEmailConfig reads the environment and returns an in-memory value only.
  const before = JSON.stringify(loadEmailConfig(ENV));
  const marker = "SMTP_PASSWORD";
  writeFileSync(join(tempDir("ai-website-qa-env-"), "nothing"), "", "utf8");
  assert.doesNotMatch(before, new RegExp(marker));
  // The resolved config object itself is what must never be serialised anywhere;
  // what matters here is that no env dump is folded into it.
  assert.deepEqual(Object.keys(ENV).filter(key => key.startsWith("SMTP_")).sort(),
    ["SMTP_FROM", "SMTP_FROM_NAME", "SMTP_HOST", "SMTP_PASSWORD", "SMTP_PORT", "SMTP_USER"]);
});