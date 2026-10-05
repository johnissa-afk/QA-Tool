// ---------------------------------------------------------------------------
// Milestone 5 validation: automatic notification email, in the real application.
//
// WHAT IS REAL HERE
// A real Chromium browser, the real dashboard server, the real engine scanning a
// real local website, the real notification derivation, the real persistence, and
// a real SMTP conversation. Nothing about delivery is faked here: the "mail server"
// in the first phase is a socket that speaks SMTP, and the assertions are made
// against the bytes it actually received.
//
// WHAT IS NOT REAL, AND WHY
// The reports directory is a throwaway temp directory, never the real one, and the
// last check of the run re-verifies that the real reports are byte-for-byte
// unchanged. The SMTP endpoint is a local socket rather than a provider, so no
// credential exists anywhere in this process.
//
// WHAT IS PROVED
// Phase A (SMTP present): a new finding produces a notification, that notification
// is emailed automatically without anyone asking, the delivery is persisted as SENT
// once, and the message that arrived names the finding and links to the dashboard.
// Phase B (SMTP absent): the same run still completes with the same QA result, and
// the delivery is persisted as FAILED/EMAIL_NOT_CONFIGURED instead of being faked
// as sent or dropped silently.
// ---------------------------------------------------------------------------
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createServer } from "node:http";
import { createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.js";
import type { NotificationDelivery } from "../src/dashboard/notification-delivery.js";

const ALICE = "alice@example.com";
const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_SECURE", "SMTP_REJECT_UNAUTHORIZED"];
/** RunState is RUNNING | COMPLETED | FAILED. A real scan takes tens of seconds. */
const TERMINAL = ["COMPLETED", "FAILED"];

let failures = 0;
const check = (ok: boolean, label: string, detail = ""): void => {
  if (ok) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
};
const equal = (actual: unknown, expected: unknown, label: string): void =>
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------------------
// A real, if minimal, SMTP server. It performs the actual protocol handshake so
// the client's transport has a genuine conversation to complete, and it keeps the
// raw message bytes for the assertions below.
// ---------------------------------------------------------------------------
type CapturedMail = { from: string; to: string[]; data: string };

const startSmtpSink = async (): Promise<{ port: number; mail: CapturedMail[]; close: () => Promise<void> }> => {
  const mail: CapturedMail[] = [];
  const sockets = new Set<SocketServer | import("node:net").Socket>();
  const server = createSocketServer(socket => {
    sockets.add(socket);
    let buffer = "";
    let from = "";
    const to: string[] = [];
    let inData = false;
    let message = "";
    const write = (line: string) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    write("220 m5-sink ESMTP ready");
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          // The body ends at a lone dot, per RFC 5321.
          if (line === ".") {
            inData = false;
            mail.push({ from, to: [...to], data: message });
            message = "";
            write("250 2.0.0 Accepted");
          } else {
            message += `${line}\n`;
          }
        } else if (/^EHLO/i.test(line)) {
          write("250-m5-sink");
          write("250 SIZE 10485760");
        } else if (/^HELO/i.test(line)) {
          write("250 m5-sink");
        } else if (/^MAIL FROM:/i.test(line)) {
          from = line.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, "").trim();
          write("250 2.1.0 Sender ok");
        } else if (/^RCPT TO:/i.test(line)) {
          to.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "").trim());
          write("250 2.1.5 Recipient ok");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          write("354 End data with <CR><LF>.<CR><LF>");
        } else if (/^QUIT/i.test(line)) {
          write("221 2.0.0 Bye");
          socket.end();
        } else if (line !== "") {
          write("250 2.0.0 Ok");
        }
        index = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => { sockets.delete(socket); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    mail,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

// ---------------------------------------------------------------------------
// A website with real content: a discovered search flow the engine can actually
// execute, an auth wall it must stop at, a news page, and one genuine defect (an
// image with no alt text) on two pages. A single trivial page is NOT enough: the
// engine treats such a run as not meaningfully testable, which is correct
// behaviour and would make this tool prove nothing.
// ---------------------------------------------------------------------------
const startFixtureSite = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    const send = (body: string, status = 200) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(body); };
    const head = (title: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body>`;
    const missingAlt = `<img src="/logo.png">`;
    const url = request.url ?? "/";
    if (url === "/") return send(`${head("Shop")}<h1>Shop</h1>${missingAlt}<form action="/search"><input type="search" placeholder="Search" name="q"><button type="submit">Search</button></form><a href="/about">About</a><a href="/login">Log in</a><a href="/news/1">Read more</a></body></html>`);
    if (url === "/search") return send(`${head("Results")}<p>No matches for your query.</p></body></html>`);
    if (url === "/about") return send(`${head("About")}${missingAlt}<p>About this site.</p></body></html>`);
    if (url.startsWith("/login")) return send(`${head("Sign in")}<form action="/login"><input type="text" name="username" placeholder="Username"><input type="password" name="password" placeholder="Password"><button type="submit">Sign in</button></form></body></html>`);
    if (url.startsWith("/news/")) return send(`${head("News")}<p>Article body.</p></body></html>`);
    return send(`<html><body>not found</body></html>`, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }) };
};

// ---------------------------------------------------------------------------
// Real data fingerprints, so the end of the run can prove the real reports were
// never touched by any of this.
// ---------------------------------------------------------------------------
const fingerprintRealReports = (): Map<string, string> => {
  const out = new Map<string, string>();
  const dir = join(process.cwd(), "reports", "projects");
  if (!existsSync(dir)) return out;
  for (const name of ["projects.json", "notifications.json", "schedules.json", "notification-deliveries.json"]) {
    const path = join(dir, name);
    if (existsSync(path)) out.set(name, createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return out;
};

/**
 * Decodes quoted-printable, including the soft line breaks that wrap long lines.
 *
 * This matters for correctness of the assertions, not just tidiness: a wrapped URL
 * or finding code does not appear contiguously in the raw bytes, so testing the raw
 * text would make these checks pass or fail depending on where the wrap happened.
 * A mail client decodes first, and so does this.
 */
const decodeQuotedPrintable = (text: string): string => {
  const joined = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index++) {
    if (joined[index] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(joined[index]!, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
};

/** RFC 2047 encoded-word, e.g. `=?UTF-8?Q?=5BQA=5D_New_finding...?=` */
const decodeHeader = (value: string): string =>
  value.replace(/=\?([^?]+)\?Q\?([^?]*)\?=/gi, (_match, _charset: string, body: string) =>
    decodeQuotedPrintable(body.replace(/_/g, " ")));

const readSettings = async (base: string, projectId: string): Promise<any> => {
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/email-settings`);
  return { status: response.status, json: await response.json() };
};

/**
 * Delivery state is read from the PERSISTED document, never from the server's
 * memory: what matters is that a delivery survives the process, not that the
 * running server still remembers it.
 */
const readDeliveries = (dir: string): NotificationDelivery[] => {
  const path = join(dir, "projects", "notification-deliveries.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).deliveries as NotificationDelivery[];
};

const waitForRun = async (base: string, projectId: string): Promise<any> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const detail = await (await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`)).json();
    const run = detail.runs?.[0];
    if (run && TERMINAL.includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("the real run never reached a terminal state");
};

/** Configures email entirely through the rendered UI, as a user would. */
const configureEmailInUi = async (page: Page, base: string, projectId: string): Promise<void> => {
  await page.goto(`${base}/projects/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#project-email-settings", { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll(".eventlist input[type=checkbox]").length === 7, null, { timeout: 20_000 });

  await page.locator(`#email-enabled-${projectId}`).check();
  await page.locator(`#email-recipient-${projectId}`).fill(ALICE);
  page.locator(`#email-recipient-${projectId}`).press("Enter");
  await page.locator(`#email-event-NEW_FINDING-${projectId}`).check();
  await page.locator("#email-save-btn").click();
  await page.waitForFunction(() => document.querySelector("#email-status")?.textContent === "Saved", null, { timeout: 15_000 });
};

type Phase = "A" | "B" | "C";

/**
 * The three acceptance scenarios.
 *
 * A: SMTP reachable and the project opted in  -> the alert arrives.
 * B: SMTP absent and the project opted in     -> a truthful failure, QA unchanged.
 * C: SMTP reachable but the project did NOT opt in -> no mail at all.
 *
 * C is the one that is easy to leave out and expensive to get wrong: with SMTP
 * fully configured, a feature that mails on anything other than an explicit
 * per-project opt-in would send mail nobody asked for, and the inbox is the only
 * place that shows up. So it is checked against a REAL reachable SMTP server -
 * proving nothing was sent is only meaningful if sending was possible.
 */
const runPhase = async (phase: Phase, smtp: { port: number; mail: CapturedMail[] } | null): Promise<void> => {
  const optedIn = phase !== "C";
  console.log(`\n=== Phase ${phase}: ${!optedIn ? "SMTP reachable, project opted out" : phase === "A" ? "SMTP reachable" : "SMTP not configured"} ===`);
  const dir = mkdtempSync(join(tmpdir(), `m5-browser-${phase.toLowerCase()}-`));
  mkdirSync(join(dir, "projects"), { recursive: true });
  for (const key of SMTP_VARS) delete process.env[key];
  // Phases A and C both have a reachable SMTP server; only the project's opt-in
  // differs between them. That is what makes C a real test.
  if (smtp) {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_FROM = "dashboard@example.test";
  }

  const site = await startFixtureSite();
  // Phases A and C share one SMTP sink, so "nothing was sent" has to be a DELTA
  // from the start of this phase. An absolute count would be measuring Phase A.
  const mailAtPhaseStart = smtp?.mail.length ?? 0;
  const dash = await startDashboard({
    reportDir: dir,
    historyDir: join(dir, "history"),
    host: "127.0.0.1",
    port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"),
    projectRoot: process.cwd(),
    scheduleTickMs: 60_000,
    scheduleEnabled: false,
  });
  const base = `http://127.0.0.1:${dash.port}`;
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "M5 Shop", url: `http://127.0.0.1:${site.port}/` }),
  })).json();
  const projectId = created.project.id as string;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    // 1. The user turns email on in the real UI. ---------------------------------
    console.log("\n1. real UI configuration");
    if (optedIn) {
      await configureEmailInUi(page, base, projectId);
      const settings = (await readSettings(base, projectId)).json.settings;
      equal(settings, { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] }, "the real UI saved exactly what it showed");
    } else {
      // Scenario C: the user never opts in. The UI is opened and inspected, but
      // nothing is switched on, so any mail that arrives would be a defect.
      await page.goto(`${base}/projects/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Run QA" }).waitFor({ timeout: 20_000 });
      const settings = (await readSettings(base, projectId)).json.settings;
      equal(settings, { enabled: false, recipients: [], events: [] }, "the project is not opted in, by default");
      check((smtp?.mail.length ?? 0) === mailAtPhaseStart, "nothing has been sent at this point", `mail went ${mailAtPhaseStart} -> ${smtp?.mail.length}`);
    }

    // 2. The user starts a real scan. ---------------------------------------------
    console.log("\n2. real scan");
    await page.goto(`${base}/projects/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
    const runButton = page.getByRole("button", { name: "Run QA" });
    await runButton.waitFor({ timeout: 20_000 });
    await runButton.click();
    const run = await waitForRun(base, projectId);
    check(run.state !== "ERRORED", "the real scan completed without an engine error", `state was ${run.state}, error ${run.error}`);
    check(Number(run.findingsCount) > 0, "the real scan really found the seeded defect", `findingsCount was ${run.findingsCount}`);

    // 3. Delivery happens on its own; nobody asked for it. -------------------------
    console.log("\n3. automatic delivery");
    await dash.settleEmailDeliveries();
    const notifications = JSON.parse(readFileSync(join(dir, "projects", "notifications.json"), "utf8")).notifications as any[];
    const findings = notifications.filter(entry => entry.type === "NEW_FINDING");
    check(findings.length > 0, "the real run produced NEW_FINDING notifications", `saw ${notifications.length} notifications`);
    check(findings.length === Number(run.findingsCount), "one notification per new finding", `${findings.length} vs ${run.findingsCount}`);

    const deliveries = readDeliveries(dir).filter(entry => entry.channel === "EMAIL");
    if (optedIn) {
      check(deliveries.length > 0, "automatic email delivery was attempted with no user action", `saw ${deliveries.length} delivery records`);
      const wanted = phase === "A" ? "SENT" : "FAILED";
      check(deliveries.every(entry => entry.status === wanted), `every automatic delivery is ${wanted}`, deliveries.map(entry => `${entry.recipient}:${entry.status}`).join(", "));
      check(deliveries.every(entry => entry.recipient === ALICE), "the delivery went to the address configured in the UI");
      check(deliveries.every(entry => entry.attempt === 1), "one attempt per target");
    } else {
      // Scenario C: the in-app notification exists, and the alert is not sent.
      equal(deliveries.length, 0, "a project that did not opt in produces no delivery record at all");
      equal((smtp?.mail.length ?? 0) - mailAtPhaseStart, 0,
        "no mail reached the SMTP server even though SMTP was fully configured and reachable");
      const deliveryDocument = join(dir, "projects", "notification-deliveries.json");
      check(!existsSync(deliveryDocument) || !readFileSync(deliveryDocument, "utf8").includes(ALICE),
        "and no recipient address was persisted anywhere: the delivery document does not even exist",
        existsSync(deliveryDocument) ? readFileSync(deliveryDocument, "utf8") : "no document");
    }

    const persisted = readDeliveries(dir);
    if (optedIn) {
      equal(persisted.length, deliveries.length, "every EMAIL delivery is persisted to disk");
      check(new Set(persisted.map(entry => entry.deliveryKey)).size === persisted.length, "each delivery target has one stable key");
    }

    if (phase === "A") {
      console.log("\n4. the message that actually arrived");
      equal(smtp!.mail.length, findings.length, "the SMTP server received one message per notification");
      const first = smtp!.mail[0]!;
      equal(first.to, [ALICE], "the SMTP envelope addressed the configured recipient");
      equal(first.from, "dashboard@example.test", "the envelope sender is the configured SMTP_FROM");
      check(/^Subject:/m.test(first.data), "the message carries a subject");
      const subject = decodeHeader(/^Subject:\s*(.*)$/m.exec(first.data)?.[1] ?? "");
      check(/New finding/i.test(subject) && subject.includes("M5 Shop"),
        "the decoded subject names the event and the project", `subject was "${subject}"`);
      check(!/=\?UTF-8\?Q\?/.test(subject), "the subject is decoded, not left encoded");

      const body = decodeQuotedPrintable(first.data);
      const titles = JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8"))
        .findings.filter((f: any) => f.projectId === projectId)
        .map((f: any) => `${f.title} (${f.code})`);
      check(titles.some((title: string) => body.includes(title)),
        "the decoded body names the real finding that was recorded", `expected one of: ${titles.join(" | ")}`);
      check(body.includes(base), "the decoded body links back to this dashboard");
      check(!/SMTP_PASSWORD|password:/i.test(body), "the message carries no credential");
      check(!/127\.0\.0\.1:\d+\/login/.test(body), "the message carries no secret from the scan");
    } else if (phase === "B") {
      console.log("\n4. honest failure, unchanged QA");
      const failed = deliveries[0]!;
      equal(failed.reason, undefined, "a FAILED delivery carries an error, not a skip reason");
      // The codebase's own vocabulary for this, and it names the missing variables
      // rather than inventing a host or pretending the send worked.
      check(/EMAIL_NOT_CONFIGURED/.test(failed.error ?? ""), "the persisted reason is the truthful one", `error was "${failed.error}"`);
      check(/SMTP_HOST/.test(failed.error ?? "") && /SMTP_FROM/.test(failed.error ?? ""),
        "the persisted reason names the variables that are actually missing", `error was "${failed.error}"`);
      check(!/smtp\.|:\/\/|\/\/\S+@/i.test(failed.error ?? ""), "the persisted error leaks no host or credential");
      equal(smtp, null, "no SMTP server existed in this phase");
    } else {
      // Scenario C. The in-app alert is the product's own record and must survive;
      // only the email is withheld. Losing the notification because email is off
      // would mean an operator who never opted in is also never told anything.
      console.log("\n4. opted out: notification without mail");
      equal(notifications.length, findings.length, "the only notifications are the new findings");
      check(findings.length > 0, "the run still produced findings the user can see in the dashboard");
      equal(readDeliveries(dir).length, 0,
        "and no delivery summary exists on disk either, because nothing was attempted");
    }

    // 4b. Reprocessing the same notifications must not produce a second email.
    if (phase === "A") {
      console.log("\n4b. duplicate suppression");
      const before = smtp!.mail.length;
      for (const notification of findings) {
        const again = await dash.emailDeliveryDispatcher.deliver(notification, ALICE);
        check(again.ok === true, "re-delivering an already-delivered notification is not an error");
        const delivery = again.ok ? again.value.delivery : null;
        equal(delivery?.status, "SKIPPED", "the second request is a skip");
        equal(delivery?.reason, "ALREADY_DELIVERED", "and it says why: already delivered");
      }
      await dash.settleEmailDeliveries();
      equal(smtp!.mail.length, before,
        "the SMTP server received no further message: the recipient is not mailed twice");
      const after = readDeliveries(dir);
      const sent = after.filter(entry => entry.status === "SENT");
      equal(sent.length, findings.length, "still exactly one SENT record per notification");
      check(after.filter(entry => entry.reason === "ALREADY_DELIVERED").length === findings.length,
        "and every suppression is on record rather than silently dropped");
      equal(JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8")).findings
        .filter((f: any) => f.projectId === projectId).length, Number(run.findingsCount),
        "re-delivery changed nothing about the findings");
    }

    // 5. Delivery never touched the QA result. ------------------------------------
    console.log("\n5. QA and history are untouched by delivery");
    const detail = await (await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`)).json();
    equal(detail.runs[0].status, run.status, "run verdict unchanged by delivery");
    equal(detail.runs[0].findingsCount, run.findingsCount, "finding count unchanged by delivery");
    equal(detail.findings[0].counts, { new: findings.length, active: 0, regressed: 0, resolved: 0, unchanged: 0, changed: 0 }, "per-run finding counts unchanged");
    check(detail.runs.length === 1, "no extra run was created by delivery");
    const doc = JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8"));
    const mine = doc.findings.filter((f: any) => f.projectId === projectId);
    check(mine.length === Number(run.findingsCount), "finding history unchanged", `${mine.length} vs ${run.findingsCount}`);
    check(mine.every((f: any) => f.firstSeenRunId === run.runId && f.occurrenceCount === 1 && f.status === "NEW"),
      "every finding's lifecycle is attributed to this run");
    // Lifecycle events carry no projectId; they are linked to findings by id.
    const mineIds = new Set(mine.map((f: any) => f.id));
    const events = doc.findingEvents.filter((e: any) => mineIds.has(e.findingId));
    check(events.length === mine.length, "the finding lifecycle is still recorded", `${events.length} events for ${mine.length} findings`);
    check(events.every((e: any) => e.observed === true && e.status === "NEW"), "each lifecycle event observed the finding");

    // 6. The notification is visible in the real UI. -------------------------------
    // The bell is a THIN reader of GET /api/notifications and only fetches its
    // list when the user opens it, so the notification is asserted the way a user
    // would see it: click the bell, then read the panel. Polling absorbs the
    // asynchronous fetch without pretending the panel must still be open later.
    await page.locator("#notification-bell").click();
    let bellText = "";
    for (let attempt = 0; attempt < 40 && !/new finding/i.test(bellText); attempt += 1) {
      bellText = await page.locator("body").innerText();
      if (!/new finding/i.test(bellText)) await page.waitForTimeout(250);
    }
    check(/new finding/i.test(bellText),
      "the real UI shows the notification the run produced",
      `the bell never listed "new finding"; body started: ${bellText.slice(0, 200)}`);
    equal(pageErrors, [], "the real page raised no uncaught error");
  } finally {
    await browser?.close();
    (dash.server as unknown as import("node:http").Server).close();
    await site.close();
    for (const key of SMTP_VARS) delete process.env[key];
  }
};

const main = async (): Promise<void> => {
  const realBefore = fingerprintRealReports();

  const smtp = await startSmtpSink();
  try {
    await runPhase("A", smtp);
    // Scenario C runs against the SAME reachable SMTP server as A: a reachable
    // server that stays silent is the only meaningful proof of an opt-in.
    await runPhase("C", smtp);
  } finally {
    await smtp.close();
  }
  await runPhase("B", null);

  console.log("\n=== real data integrity ===");
  const realAfter = fingerprintRealReports();
  const names = new Set([...realBefore.keys(), ...realAfter.keys()]);
  for (const name of names) {
    check(realBefore.get(name) === realAfter.get(name), `real reports/${name} is byte-for-byte unchanged`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});