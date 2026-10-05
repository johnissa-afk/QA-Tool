// --------------------------------------------------------------------------
// Milestone 4 real-browser validation. Not part of the build.
//
// Runs: npx tsx tools/email-settings-browser.ts
//
// The automated suite proves the settings API and the bytes the browser would
// receive. This drives a REAL Chromium against a REAL dashboard server to prove
// the things only a layout engine can answer: the controls really appear and
// respond, nothing overflows on a phone, focus stays visible, and the test-email
// button reports the server's own wording.
//
// Safety: it boots an isolated dashboard over a THROWAWAY report directory with
// the scheduler disabled, so reports/projects/ is never read or written. SMTP is
// cleared from the environment, which is the honest state of this deployment -
// so the test-email button is expected to report that SMTP is not configured and
// is never allowed to reach a mail server.
// --------------------------------------------------------------------------
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.js";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_SECURE", "SMTP_REJECT_UNAUTHORIZED"];

const failures: string[] = [];
let checks = 0;

const check = (ok: boolean, label: string, detail = ""): void => {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures.push(label + (detail ? ` -- ${detail}` : ""));
  console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
};

const equal = (actual: unknown, expected: unknown, label: string): void =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

/** The settings API, read straight from Node so the UI's claims are cross-checked. */
const readSettings = async (base: string, projectId: string): Promise<any> =>
  (await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/email-settings`)).json();

/**
 * Reads what the page is currently showing, from the DOM a user would see.
 *
 * NOTE: this callback is serialized into the browser, so it must not declare any
 * named function expressions - the esbuild `keepNames` helper that wraps them does
 * not exist on the page side. Everything here is inline.
 */
const screenState = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector("#project-email-settings");
    if (!root) return { missing: true } as const;
    const projectId = root.getAttribute("data-project-id") ?? "";
    let recipientsHidden = false;
    let eventsHidden = false;
    for (const fieldset of Array.from(root.querySelectorAll("fieldset"))) {
      const legend = fieldset.querySelector("legend")?.textContent ?? "";
      if (legend === "Email recipients") recipientsHidden = fieldset.hasAttribute("hidden");
      if (legend === "Notification events") eventsHidden = fieldset.hasAttribute("hidden");
    }
    const toggle = root.querySelector<HTMLInputElement>(`#email-enabled-${projectId}`);
    const save = root.querySelector<HTMLButtonElement>("#email-save-btn");
    const test = root.querySelector<HTMLButtonElement>("#email-test-btn");
    const status = root.querySelector("#email-status");
    const banner = root.querySelector(".banner.UNKNOWN");
    const addField = root.querySelector<HTMLInputElement>(`#email-recipient-${projectId}`);
    return {
      missing: false,
      enabled: toggle?.checked ?? false,
      toggleLabel: root.querySelector(".toggle-state")?.textContent ?? "",
      recipients: Array.from(root.querySelectorAll(".recipientrow .addr")).map(n => n.textContent),
      events: Array.from(root.querySelectorAll(".eventlist input[type=checkbox]"))
        .filter(n => (n as HTMLInputElement).checked)
        .map(n => (n as HTMLInputElement).value),
      eventCount: root.querySelectorAll(".eventlist input[type=checkbox]").length,
      testDisabled: test?.disabled ?? false,
      saveDisabled: save?.disabled ?? false,
      status: status?.textContent ?? "",
      statusVisible: status?.classList.contains("show") ?? false,
      statusIsError: status?.classList.contains("error") ?? false,
      smtpBannerHidden: (banner as HTMLElement | null)?.hidden ?? false,
      smtpBannerText: banner?.textContent ?? "",
      metrics: Array.from(root.querySelectorAll(".metric")).map(n => n.textContent),
      recipientsHidden,
      eventsHidden,
      recipientError: root.querySelector(`#email-recipient-error-${projectId}`)?.textContent ?? "",
      recipientInvalid: addField?.getAttribute("aria-invalid"),
    };
  });

/** Tabs from the top of the document and reports whether focus is visibly drawn. */
const focusIsVisible = (page: Page, selector: string): Promise<{ reached: boolean; outline: string }> =>
  page.evaluate(target => {
    const wanted = document.querySelector(target);
    document.body.focus();
    let reached = false;
    let outline = "not reached";
    for (let i = 0; i < 60 && !reached; i++) {
      const active = document.activeElement as HTMLElement | null;
      if (active === wanted) {
        reached = true;
        const style = getComputedStyle(active);
        // :focus-visible must draw something, not just move the caret.
        outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? `${style.outlineWidth} ${style.outlineStyle}` : "none";
        break;
      }
      const focusable = [
        ...document.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'),
      ].filter(n => n.offsetParent !== null || n === active);
      const current = focusable.indexOf(active as HTMLElement);
      (focusable[current + 1] ?? focusable[0])?.focus();
    }
    return { reached, outline };
  }, selector);

const main = async (): Promise<void> => {
  // A throwaway dashboard. Never the real reports directory.
  const dir = mkdtempSync(join(tmpdir(), "m4-browser-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  const savedEnv = new Map<string, string | undefined>();
  for (const key of SMTP_VARS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }

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
    body: JSON.stringify({ name: "Browser Checkout", url: "https://qa.test/checkout" }),
  })).json();
  const projectId = created.project.id as string;
  console.log(`dashboard ${base}  project ${projectId}  reportdir ${dir}\n`);

  const server = dash.server as unknown as import("node:http").Server;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", e => pageErrors.push(e.message));
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await page.goto(`${base}/projects/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-email-settings", { timeout: 15_000 });
    // The section renders immediately, before the settings API answers. Waiting for
    // the API's event list is what makes the first assertions meaningful.
    await page.waitForFunction(() => document.querySelectorAll(".eventlist input[type=checkbox]").length === 7, null, { timeout: 15_000 });

    const root = page.locator("#project-email-settings");
    const pid = projectId;
    const toggle = page.locator(`#email-enabled-${pid}`);
    const addInput = page.locator(`#email-recipient-${pid}`);
    const addBtn = root.getByRole("button", { name: "Add recipient" });
    const saveBtn = page.locator("#email-save-btn");
    const testBtn = page.locator("#email-test-btn");
    const eventBox = (type: string) => page.locator(`#email-event-${type}-${pid}`);

    // --- 1. A fresh project renders the backend's defaults -------------------------
    console.log("1. first load");
    let state = await screenState(page);
    equal(state.enabled, false, "email starts switched off");
    equal(state.toggleLabel, "OFF", "the toggle announces OFF");
    equal(state.recipientsHidden, true, "recipients are hidden while email is off");
    equal(state.eventsHidden, true, "events are hidden while email is off");
    equal(state.testDisabled, true, "the test-email button is disabled while email is off");
    equal(state.statusVisible, false, "nothing is claimed before the user acts");
    check(state.eventCount === 7, `all 7 backend events are offered`, `saw ${state.eventCount}`);
    check(state.smtpBannerHidden === false, "the missing-SMTP banner is shown");
    check(/SMTP_HOST/.test(state.smtpBannerText), "the banner names the missing variables");
    check(!/smtp\.|\/\/\S+@|@smtp/.test(state.smtpBannerText), "the banner carries no host or credentials");
    check(state.metrics.some(m => /Disabled/.test(m)) && state.metrics.some(m => /0 configured/.test(m)),
      "the status strip reflects an unconfigured project");

    // --- 2. Focus stays visible (keyboard, not mouse) -----------------------------
    console.log("\n2. keyboard focus");
    const focus = await focusIsVisible(page, `#email-enabled-${pid}`);
    check(focus.reached, "the email toggle is reachable by Tab");
    check(focus.outline !== "none" && focus.outline !== "not reached", "focus is visibly outlined", `outline was ${focus.outline}`);

    // --- 3. Inline validation, then adding recipients ------------------------------
    console.log("\n3. recipients");
    await toggle.check();
    state = await screenState(page);
    equal(state.enabled, true, "checking the toggle reveals the controls");
    equal(state.recipientsHidden, false, "recipients are revealed");
    equal(state.eventsHidden, false, "events are revealed");
    equal(state.testDisabled, false, "the test-email button becomes available");

    await addBtn.click();
    state = await screenState(page);
    equal(state.recipientError, "Enter a valid email address.", "a bad address is rejected inline");
    equal(state.recipientInvalid, "true", "the input is marked invalid for assistive tech");

    await addInput.fill(`  ${ALICE.toUpperCase()}  `);
    await addBtn.click();
    await addInput.fill(BOB);
    await addInput.press("Enter");
    state = await screenState(page);
    equal(state.recipients, [ALICE, BOB], "addresses are trimmed, lowercased and sorted");

    await addInput.fill(ALICE);
    await addBtn.click();
    state = await screenState(page);
    check(/already a recipient/.test(state.recipientError), "a duplicate address is refused");

    equal((await readSettings(base, projectId)).settings.recipients, [], "nothing is persisted before Save");

    // --- 4. Selecting events keeps canonical order ---------------------------------
    console.log("\n4. events");
    await eventBox("RUN_FAILED").check();
    await eventBox("NEW_FINDING").check();
    state = await screenState(page);
    equal(state.events, ["NEW_FINDING", "RUN_FAILED"], "ticking keeps canonical event order regardless of click order");
    check(state.metrics.some(m => /2 selected/.test(m)), "the strip counts the selected events");

    // --- 5. Save, then prove the UI matches the API -------------------------------
    console.log("\n5. save");
    await saveBtn.click();
    await page.waitForFunction(() => document.querySelector("#email-status")?.textContent === "Saved", null, { timeout: 10_000 });
    const afterSave = await readSettings(base, projectId);
    equal(afterSave.settings, { enabled: true, recipients: [ALICE, BOB], events: ["NEW_FINDING", "RUN_FAILED"] },
      "the server persisted exactly what the screen showed");
    state = await screenState(page);
    equal(state.saveDisabled, false, "the save button is re-enabled after the round trip");

    // --- 6. A reload restores the configuration ------------------------------------
    console.log("\n6. reload");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-email-settings");
    await page.waitForFunction((n) => document.querySelectorAll(".recipientrow .addr").length === n, 2, { timeout: 10_000 });
    state = await screenState(page);
    equal(state.enabled, true, "enabled survives a reload");
    equal(state.recipients, [ALICE, BOB], "recipients survive a reload");
    equal(state.events, ["NEW_FINDING", "RUN_FAILED"], "events survive a reload");

    // --- 7. Editing and saving again ----------------------------------------------
    console.log("\n7. edit and re-save");
    await page.locator(`#email-event-RUN_FAILED-${pid}`).uncheck();
    await root.getByRole("button", { name: `Remove ${BOB}` }).click();
    state = await screenState(page);
    equal(state.events, ["NEW_FINDING"], "unticking an event drops it");
    equal(state.recipients, [ALICE], "removing a recipient drops it");
    check(/Select Save settings/.test(state.status), "an unsaved change is called out rather than implied to be saved");
    equal((await readSettings(base, projectId)).settings.events, ["NEW_FINDING", "RUN_FAILED"], "the edit is not persisted until Save");
    await saveBtn.click();
    await page.waitForFunction(() => document.querySelector("#email-status")?.textContent === "Saved", null, { timeout: 10_000 });
    equal((await readSettings(base, projectId)).settings, { enabled: true, recipients: [ALICE], events: ["NEW_FINDING"] },
      "the second save persists the edit");

    // --- 8. Test email reports the server's own wording ---------------------------
    console.log("\n8. test email (no SMTP configured, so nothing is sent)");
    await testBtn.click();
    // The handler only speaks once the round trip is over, and SMTP is deliberately
    // absent here, so this exact outcome is what a real user must see.
    await page.waitForFunction(() => /not configured/i.test(document.querySelector("#email-status")?.textContent ?? ""), null, { timeout: 15_000 });
    state = await screenState(page);
    check(/not configured/i.test(state.status), "the button reports SMTP is not configured", `said "${state.status}"`);
    equal(state.statusIsError, true, "the outcome is styled as an error, not a success");
    check(!/EAUTH|ECONN|smtp\./i.test(state.status), "no raw SMTP detail reaches the screen", `said "${state.status}"`);
    equal((await readSettings(base, projectId)).settings.enabled, true, "a failed test leaves the saved configuration intact");

    // --- 9. Desktop, tablet and phone viewports ------------------------------------
console.log("\n9. responsive");
    const VIEWPORTS = [
      { name: "desktop 1280", width: 1280, height: 900, minColumns: 2 },
      { name: "tablet 768", width: 768, height: 1024, minColumns: 2 },
      { name: "phone 375", width: 375, height: 667, minColumns: 1 },
    ];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(200);
      const measured = await page.evaluate(() => {
        const list = document.querySelector(".eventlist")!;
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          columns: getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length,
          controlsInside: Array.from(document.querySelectorAll("#project-email-settings input, #project-email-settings button"))
            .every(n => n.getBoundingClientRect().right <= window.innerWidth + 1),
        };
      });
      check(measured.scrollWidth <= measured.clientWidth + 1, `no horizontal overflow at ${viewport.name}`,
        `scrollWidth ${measured.scrollWidth} vs clientWidth ${measured.clientWidth}`);
      check(measured.controlsInside, `every control fits inside the viewport at ${viewport.name}`);
      check(measured.columns >= viewport.minColumns,
        `the event list reflows for ${viewport.name} (${measured.columns} column(s))`);
      if (viewport.name === "phone 375") equal(measured.columns, 1, "the event list is one column on a phone");
    }
    // Every breakpoint the stylesheet declares is measured, not assumed.
    for (const breakpoint of await page.evaluate(() =>
      Array.from(document.styleSheets)
        .flatMap(sheet => { try { return Array.from(sheet.cssRules); } catch { return []; } })
        .map(rule => rule.conditionText ?? "")
        .filter(text => text.includes("max-width")))) {
      const width = Number(breakpoint.match(/(\d+)px/)?.[1] ?? NaN);
      if (!Number.isFinite(width)) continue;
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const fits = await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      check(fits, `no horizontal overflow at the declared ${width}px breakpoint`);
    }

    // --- 10. Nothing errored, and no record was invented ---------------------------
    console.log("\n10. hygiene");
    equal(pageErrors, [], "the page raised no uncaught errors");
    // Chromium logs a resource notice for every non-2xx response. This flow
    // deliberately provokes two 400s (a malformed save is never sent, but the
    // test-email route answers 400 while SMTP is absent), so those notices are
    // expected; anything else on the console is not.
    const expectedNoise = /Failed to load resource: the server responded with a status of 400 \(Bad Request\)/;
    equal(consoleErrors.filter(m => !expectedNoise.test(m)), [], "the console holds no unexpected errors");
    check(consoleErrors.every(m => expectedNoise.test(m)), "the only console noise is the deliberate 400", consoleErrors.join(" | "));
    const onDisk = JSON.parse(readFileSync(join(dir, "projects", "projects.json"), "utf8")) as any;
    equal(onDisk.runs, [], "no run was started");
    equal(onDisk.findings, [], "no finding was created");
    equal(onDisk.findingEvents, [], "no finding event was created");
    check(!existsSync(join(dir, "projects", "schedules.json")), "no schedule was invented");
    check(!existsSync(join(dir, "projects", "notifications.json")), "the test email created no QA notification");
    check(!existsSync(join(dir, "projects", "notification-deliveries.json")), "the test email recorded no delivery");
  } finally {
    await browser?.close();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.error(`\n${failures.length} FAILED:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("real-browser validation passed");
};

main().catch((error: unknown) => {
  console.error("email settings browser validation crashed:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});