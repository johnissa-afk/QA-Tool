// ---------------------------------------------------------------------------
// The notification bell and panel, as a browser would actually receive them.
//
// The app's own functions are pulled out of the served page and run against a
// minimal DOM, so these assertions are about the shipped code rather than about
// a re-implementation of it.
// ---------------------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSpawner, start, stop } from "./notification-fixtures.js";

const APP_HTML = readFileSync(join(process.cwd(), "src", "dashboard", "app.html"), "utf8");

type Node = {
  tagName: string;
  className: string;
  textContent: string;
  id: string;
  type: string;
  hidden: boolean;
  disabled: boolean;
  href: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: Node[];
  listeners: Array<(event?: unknown) => void | Promise<void>>;
  appendChild(child: Node): Node;
  removeChild(child: Node): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, handler: (event?: unknown) => void | Promise<void>): void;
  click(): Promise<void>;
  querySelectorAll(): Node[];
  find(predicate: (node: Node) => boolean): Node | null;
  texts(): string[];
};

const makeDocument = () => {
  const create = (tagName: string): Node => {
    const node: Node = {
      tagName,
      className: "",
      textContent: "",
      id: "",
      type: "",
      hidden: false,
      disabled: false,
      href: "",
      dataset: {},
      attributes: {},
      children: [],
      listeners: [],
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter(item => item !== child); },
      remove() { this.children = []; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(_type, handler) { this.listeners.push(handler); },
      async click() { for (const handler of [...this.listeners]) await handler({}); },
      querySelectorAll() { return []; },
      find(predicate) {
        for (const child of this.children) {
          if (predicate(child)) return child;
          const nested = child.find(predicate);
          if (nested) return nested;
        }
        return null;
      },
      texts() {
        return this.textContent ? [this.textContent] : this.children.flatMap(child => child.texts());
      },
    };
    return node;
  };
  return {
    createElement: (tag: string) => create(tag),
    createDocumentFragment: () => create("#fragment"),
    createTextNode: (text: string) => { const node = create("#text"); node.textContent = text; return node; },
    getElementById: () => null,
  };
};

/**
 * Evaluates the app's own notification code against the stub DOM, so the
 * assertions below exercise the shipped functions.
 */
const loadNotificationUi = (html: string) => {
  const grab = (pattern: RegExp, label: string) => {
    const found = pattern.exec(html);
    assert.ok(found, `the served page must still contain ${label}`);
    return found[0];
  };
  const source = [
    grab(/const NOT_AVAILABLE = "not available";/, "the not-available placeholder"),
    grab(/const el = \(tag, cls, text\) => \{[^\n]*\};/, "the element helper"),
    grab(/const num = \(v\) => \(typeof v === "number" && isFinite\(v\) \? v : 0\);/, "the number helper"),
    grab(/const arr = \(v\) => \(Array\.isArray\(v\) \? v : \[\]\);/, "the array helper"),
    grab(/const chip = \(text, cls\) =>[^;]+;/, "the chip helper"),
    grab(/const severityChip = \(severity\) =>[^;]+;/, "the severity chip"),
    grab(/const SEVERITY_CLASS = \{[^}]*\};/, "the severity classes"),
    grab(/const formatTime = \(iso\) => \{[\s\S]*?\n\};/, "the time formatter"),
    grab(/const NOTIFICATION_LABEL = \{[\s\S]*?\n\};/, "the notification labels"),
    grab(/const FINDING_NOTIFICATION_TYPES = \[[^\]]*\];/, "the finding types"),
    grab(/const notificationAgo = \(iso\) => \{[\s\S]*?\n\};/, "the relative time"),
    grab(/const notificationDestination = \(n\) => \{[\s\S]*?\n\};/, "the destination resolver"),
    grab(/const notificationItem = \(n, onChanged\) => \{[\s\S]*?\n  return item;\n\};/, "the notification row"),
    grab(/const notificationPanelBody = \(data, onChanged\) => \{[\s\S]*?\n  return frag;\n\};/, "the panel body"),
  ].join("\n\n");

  const document = makeDocument();
  const api = new Function("document", "fetch", "apiJson", "navigate", "openHistoricalRun", `
    ${source}
    return { notificationPanelBody, notificationDestination, notificationAgo, notificationItem };
  `) as (
    doc: unknown,
    fetchImpl: unknown,
    apiJson: unknown,
    navigate: unknown,
    openRun: unknown,
  ) => { notificationPanelBody: Function; notificationDestination: Function; notificationAgo: Function; notificationItem: Function };
  return api(document, () => {}, async () => ({ ok: true, body: {} }), () => {}, () => {});
};

const notification = (overrides: Record<string, unknown> = {}) => ({
  id: "ntf-0123456789abcdef0123456789abcdef",
  projectId: "prj-1",
  projectName: "Checkout",
  type: "NEW_FINDING",
  title: "New finding",
  message: "Button lacks an accessible name (BTN) is new.",
  createdAt: new Date().toISOString(),
  read: false,
  runId: "web-run-2",
  findingId: "prj-fnd-1",
  severity: "HIGH",
  source: "finding-lifecycle",
  ...overrides,
});

test("the bell lives in the nav of every page and reads only the notification API", async () => {
  const { dash, base } = await start(
    // The served page is what a browser receives, so the file on disk and the
    // route are both checked through the real server.
    mkdtempSync(join(tmpdir(), "ai-website-qa-notify-ui-")),
    fakeSpawner().spawnImpl,
    () => Date.now(),
    { pagePath: join(process.cwd(), "src", "dashboard", "app.html") },
  );
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('bar.appendChild(notificationBell());'), "the bell must be part of the shared nav");
    assert.ok(html.includes('id = "notification-bell"'));
    assert.ok(html.includes('id = "notification-badge"'));
    // The panel is fed by the server's inbox, never by a local sample list.
    assert.ok(html.includes('apiJson("/api/notifications?limit=50")'));
    assert.ok(html.includes('apiJson("/api/notifications/unread-count")'));
    assert.ok(html.includes('"/api/notifications/read-all"'));
    assert.ok(html.includes('"/api/notifications/" + encodeURIComponent(n.id) + "/read"'));
    // No static or demo rows of any kind.
    assert.equal(/notificationPreview|sampleNotification|demoNotifications/.test(html), false);
  } finally { await stop(dash); }
});

test("an empty inbox says so, and shows nothing else", () => {
  const ui = loadNotificationUi(APP_HTML);
  const panel = (ui as any).notificationPanelBody({ notifications: [], unreadCount: 0, total: 0 }, () => {});
  const texts = panel.texts();
  assert.deepEqual(texts, ["Notifications", "No unread notifications", "Mark all as read", "No notifications yet."]);
  // Nothing to mark read, so the button is disabled rather than a no-op.
  const markAll = panel.find((node: Node) => node.id === "notif-mark-all");
  assert.equal(markAll!.disabled, true);
  assert.equal(panel.children.length, 2, "a header and the empty message, and nothing else");
});

test("an unread notification is marked as unread and labelled with its own type", () => {
  const ui = loadNotificationUi(APP_HTML) as any;
  const panel = ui.notificationPanelBody({ notifications: [notification()], unreadCount: 1, total: 1 }, () => {});
  const row = panel.find((node: Node) => node.dataset.notificationId);
  assert.ok(row, "the notification must render a row");
  assert.equal(row!.dataset.read, "0");
  assert.equal(row!.dataset.unread, "1");
  assert.ok(row!.className.includes("unread"));
  assert.equal(row!.dataset.notificationType, "NEW_FINDING");
  const texts = row!.texts();
  assert.ok(texts.includes("New finding"), "the type is labelled, never shown as a raw enum");
  assert.ok(texts.includes("Button lacks an accessible name (BTN) is new."), "the server's own message");
  assert.ok(texts.includes("HIGH"), "the finding's own severity");
  assert.ok(texts.includes("Checkout"), "the project it belongs to");
  const markAll = panel.find((node: Node) => node.id === "notif-mark-all");
  assert.equal(markAll!.disabled, false);
});

test("a read notification is not styled as unread", () => {
  const ui = loadNotificationUi(APP_HTML) as any;
  const panel = ui.notificationPanelBody({ notifications: [notification({ read: true })], unreadCount: 0, total: 1 }, () => {});
  const row = panel.find((node: Node) => node.dataset.notificationId);
  assert.equal(row!.dataset.read, "1");
  assert.equal(row!.dataset.unread, undefined);
  assert.equal(row!.className.includes("unread"), false);
});

test("a zero unread count never shows a badge", () => {
  const ui = loadNotificationUi(APP_HTML) as any;
  const row = ui.notificationItem(notification({ read: true }), () => {});
  // The badge is only ever driven by applyBadge, which hides it at zero.
  const source = APP_HTML.slice(APP_HTML.indexOf("const applyBadge"), APP_HTML.indexOf("const applyBadge") + 320);
  assert.match(source, /if \(count > 0\)/);
  assert.match(source, /badge\.hidden = false/);
  assert.match(source, /badge\.hidden = true/);
  assert.ok(row, "a read notification still renders");
});

test("a notification leads to a route that already exists", () => {
  const ui = loadNotificationUi(APP_HTML) as any;
  // A finding leads to that finding on its project page.
  const finding = ui.notificationDestination(notification());
  assert.deepEqual(finding, { path: "/projects/prj-1?finding=prj-fnd-1", runId: null });
  // A run's news leads to the run's own results on the console.
  const run = ui.notificationDestination(notification({ type: "MEANINGFUL_CHANGE", findingId: null, runId: "web-run-7" }));
  assert.deepEqual(run, { path: "/", runId: "web-run-7" });
  // A scheduler skip belongs to no run, so it leads to the project.
  const skip = ui.notificationDestination(notification({ type: "SCHEDULE_SKIPPED", findingId: null, runId: null }));
  assert.deepEqual(skip, { path: "/projects/prj-1", runId: null });
  // A failure without a run is still honest about where it can be seen.
  const failure = ui.notificationDestination(notification({ type: "RUN_FAILED", findingId: null, runId: null }));
  assert.deepEqual(failure, { path: "/projects/prj-1", runId: null });
});

test("a relative time falls back to the real timestamp for anything old", () => {
  const ui = loadNotificationUi(APP_HTML) as any;
  assert.match(ui.notificationAgo(new Date().toISOString()), /s ago|m ago/);
  assert.equal(ui.notificationAgo(""), "not available");
  // An event older than a month is dated, not summarised as "a while ago".
  assert.equal(ui.notificationAgo("2026-01-02T03:04:05.000Z"), new Date("2026-01-02T03:04:05.000Z").toLocaleString());
});