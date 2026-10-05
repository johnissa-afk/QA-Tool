// ---------------------------------------------------------------------------
// Shared fixtures and harness for the notification tests.
//
// These are the same real-shaped reports the engine writes, plus the same fake
// child-process harness, so BOTH the read-only preview tests and the production
// notification tests are driven by identical data and an identical settlement
// path. There is deliberately no fixture of my own invention here: a field the
// real engine does not write must not be able to create a notification.
// ---------------------------------------------------------------------------
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startDashboard } from "../dashboard/server.js";

export const PRICING = "https://qa.test/pricing";

export const buttonElement = (overrides: Record<string, unknown> = {}) => ({
  tag: "button",
  role: null,
  text: "Buy now",
  ariaLabel: null,
  placeholder: null,
  name: null,
  id: "buy-now-3f9",
  testId: null,
  type: "submit",
  hasExplicitType: true,
  autocomplete: null,
  href: null,
  alt: null,
  visible: true,
  enabled: true,
  boundingBox: null,
  interactive: true,
  accessibleName: null,
  recommendedLocator: "button[type=submit]",
  locatorQuality: "WEAK",
  ...overrides,
});

export const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "QA-F-001",
  code: "BTN",
  severity: "HIGH",
  status: "FAIL",
  lifecycle: "TEST_EXECUTED",
  title: "Button lacks an accessible name",
  description: "The buy button exposes no accessible name.",
  recommendation: "Add a label",
  userImpact: "Screen reader users cannot activate the purchase flow.",
  rationale: "why",
  count: 2,
  domain: "Accessibility",
  confidence: "HIGH_CONFIDENCE",
  relatedScenarioIds: [],
  verification: { disposition: "REPRODUCED", status: "REPRODUCED", category: "WEBSITE", verdict: "CONFIRMED", reason: "seen", safety: "safe", locator: "button[type=submit]", executedAt: null, durationMs: 12, error: null },
  evidence: [{ type: "element", index: 0, locator: "button[type=submit]", tag: "button" }],
  ...overrides,
});

/** A second, different problem on the same page. */
export const labelFinding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => finding({
  id: "QA-F-002",
  code: "FORM",
  title: "Input has no label",
  description: "The email input has no associated label.",
  evidence: [{ type: "element", index: 1, locator: "input#email", tag: "input" }],
  ...overrides,
});

const coverageItem = (overrides: Record<string, unknown> = {}) => ({
  coverageId: "COV-PAGE-001",
  category: "PAGE",
  name: "Pricing",
  status: "TESTED",
  reason: "the page was loaded and its interactive elements exercised",
  safety: "NOT_APPLICABLE",
  executionStatus: null,
  pageId: "PAGE-001",
  url: PRICING,
  relatedFlows: [],
  relatedScenarios: [],
  relatedFindings: [],
  evidence: [],
  ...overrides,
});

/**
 * A report whose coverage map says the pricing page was genuinely tested, so
 * absences on that page are real absences rather than untested ground.
 */
export const analysisWith = (findingsList: unknown[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: "2026-09-29T10:00:00.000Z",
  scan: {
    scan: { url: PRICING, title: "Pricing" },
    elements: [buttonElement(), buttonElement({ tag: "input", type: "email", name: "email", id: "email", recommendedLocator: "input#email", text: "" })],
  },
  findings: findingsList,
  accessPrerequisite: { status: "PASS", reason: null, details: [] },
  coverage: {
    generatedAt: "2026-09-29T10:00:00.000Z",
    summary: { pages: { discovered: 2, tested: 2, partial: 0, untested: 0, blocked: 0, review: 0 }, flows: { discovered: 1, executed: 1, passed: 0, reproduced: 1, notReproduced: 0, review: 0, blocked: 0 }, interactions: { tested: 4, partial: 0, untested: 0, review: 0, notApplicable: 0 }, findings: { analyzed: findingsList.length, verified: findingsList.length, reproduced: findingsList.length, notReproduced: 0, unverified: 0 }, recommendations: findingsList.length },
    items: [
      coverageItem({ relatedFindings: findingsList.map(item => (item as { id?: unknown }).id) }),
      coverageItem({ coverageId: "COV-PAGE-002", name: "Home", url: "https://qa.test/home", pageId: "PAGE-002" }),
    ],
    testPlan: [],
    aiNotes: { gaps: [] },
  },
  flowDiscovery: { limits: {}, graph: { pages: [] }, flows: [], executions: [], summary: { pages: 2, flows: 1, executable: 1, review: 0, highRisk: 0, blocked: 0, steps: 2, executed: 1, passed: 0, reproduced: findingsList.length, notReproduced: 0, reviewRequired: 0, infrastructure: 0 } },
  summary: { overallStatus: "FAIL", headline: "problems", issueCount: findingsList.length, flowsDetected: 1, scheduled: 1, executed: 1, reproduced: findingsList.length, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 0, infrastructureFailures: 0, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: findingsList.length, MEDIUM: 0, LOW: 0, INFO: 0 } },
  history: { status: "AVAILABLE", currentRunId: "hist-1", runsAvailable: 1 },
  execution: { status: "FAIL", tests: 1, passed: 0, failed: 1, skipped: 0, failures: [] },
  verifications: [],
  ...overrides,
}) as any;

// ---------------------------------------------------------------------------
// The harness: a fake child process the dashboard settles exactly as it settles
// a real one, writing a real report artifact to disk.
// ---------------------------------------------------------------------------

export type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[]; exitCode: number | null };

export const fakeSpawner = () => {
  const children: FakeChild[] = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.args = args;
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, children };
};

export const settle = (child: FakeChild, fixture: unknown): string => {
  const index = child.args.indexOf("--output");
  const output = child.args[index + 1]!;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(fixture), "utf8");
  child.exitCode = 0;
  child.emit("close", 0);
  return output;
};

/** Fails the run without ever writing a report, as a crashed engine would. */
export const crash = (child: FakeChild): void => {
  child.exitCode = 1;
  child.stderr.emit("data", "engine crashed\n");
  child.emit("close", 1);
};

export const start = async (dir: string, spawnImpl: typeof import("node:child_process").spawn, now = () => Date.now(), options: Record<string, unknown> = {}) => {
  const dash = await startDashboard({
    reportDir: dir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(), spawnImpl,
    now, scheduleTickMs: 60_000, scheduleEnabled: false,
    ...options,
  });
  return { dash, base: `http://127.0.0.1:${dash.port}` };
};

export const stop = async (dash: Awaited<ReturnType<typeof startDashboard>>): Promise<void> => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

export const getJson = async (url: string) => {
  const res = await fetch(url);
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

export const send = async (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body: unknown = {}) => {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

export const postJson = async (url: string, body: unknown = {}) => send("POST", url, body);

// Accepts an async check as well as a sync one: waiting on an HTTP route is
// asynchronous, and callers should not have to hand-roll a second poll loop.
export const waitFor = async (check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for the run to settle");
};

/** Runs one real project run, settled from a real report artifact. */
export const runOnce = async (base: string, projectId: string, children: FakeChild[], index: number, fixture: unknown) => {
  await postJson(`${base}/api/projects/${projectId}/runs`);
  await waitFor(() => children.length === index + 1);
  settle(children[index]!, fixture);
  await waitFor(() => children[index]!.exitCode !== null);
  const detail = await getJson(`${base}/api/projects/${projectId}`);
  return detail.json.runs[0].runId as string;
};