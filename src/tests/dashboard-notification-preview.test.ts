import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNotificationPreview,
  notificationPreviewTypeOrder,
  type NotificationPreviewEvent,
  type NotificationPreviewInput,
} from "../dashboard/notification-preview.js";
import { buildChangeSummary, highlightsOf } from "../dashboard/run-comparison.js";
import { applyRunToLedger, emptyLedger } from "../dashboard/project-findings.js";
import { startDashboard } from "../dashboard/server.js";

import {
  analysisWith,
  crash,
  fakeSpawner,
  finding,
  getJson,
  labelFinding,
  postJson,
  PRICING,
  runOnce,
  send,
  settle,
  start,
  stop,
  waitFor,
} from "./notification-fixtures.js";

// ---------------------------------------------------------------------------
// A minimal input builder for the pure tests. Only the fields the preview reads
// are filled; everything else is left out on purpose so an extra field in the
// real record can never silently change a notification.
// ---------------------------------------------------------------------------

const previewInput = (overrides: Partial<NotificationPreviewInput> = {}): NotificationPreviewInput => ({
  project: { id: "prj-1", name: "Preview", url: PRICING },
  run: {
    runId: "web-run-2",
    status: "PASS",
    state: "COMPLETED",
    startedAt: "2026-09-29T10:00:00.000Z",
    completedAt: "2026-09-29T10:05:00.000Z",
    findingsCount: 0,
    hasResult: true,
    error: null,
  },
  analysis: null,
  snapshot: null,
  comparison: null,
  changeSummary: null,
  executions: [],
  ...overrides,
});

const typesOf = (events: readonly NotificationPreviewEvent[]): string[] => events.map(item => item.type);

// ---------------------------------------------------------------------------
// The notification vocabulary
// ---------------------------------------------------------------------------

test("the preview offers exactly the seven agreed notification types, in reporting order", () => {
  assert.deepEqual([...notificationPreviewTypeOrder()], [
    "RUN_FAILED",
    "ACCESS_CHANGED",
    "REGRESSED_FINDING",
    "NEW_FINDING",
    "RESOLVED_FINDING",
    "SCHEDULE_SKIPPED",
    "MEANINGFUL_CHANGE",
  ]);
});

test("every type is counted even when it fired zero times", () => {
  const preview = buildNotificationPreview(previewInput());
  assert.deepEqual(preview.counts, {
    RUN_FAILED: 0,
    ACCESS_CHANGED: 0,
    REGRESSED_FINDING: 0,
    NEW_FINDING: 0,
    RESOLVED_FINDING: 0,
    SCHEDULE_SKIPPED: 0,
    MEANINGFUL_CHANGE: 0,
  });
  assert.deepEqual(preview.notifications, []);
});

test("severity is the finding's own recorded vocabulary, never a priority scale", () => {
  const preview = buildNotificationPreview(previewInput({
    comparison: {
      comparisonAvailable: true,
      reason: null,
      counts: { new: 1, active: 0, resolved: 0, regressed: 0, changed: 0, unchanged: 0 },
      new: [{ id: "prj-fnd-0123456789abcdef", fingerprint: "fp", title: "Buy button has no name", code: "BTN", severity: "CRITICAL", status: "NEW", page: PRICING, runId: "web-run-2", runFindingId: "QA-F-001" }],
      resolved: [], regressed: [], active: [], unchanged: [], changed: [],
    },
  }));
  assert.equal(preview.notifications[0]!.severity, "CRITICAL", "the finding's own severity is carried through");
  // A notification priority scale is not part of this milestone at all.
  const text = JSON.stringify(preview);
  for (const forbidden of ["priority", "urgency", "rank", "score", "\"P0\"", "\"P1\"", "\"P2\""]) {
    assert.equal(text.includes(forbidden), false, `a preview must never introduce ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// RUN_FAILED
// ---------------------------------------------------------------------------

test("a run that never completed reports RUN_FAILED with the recorded reason", () => {
  const preview = buildNotificationPreview(previewInput({
    run: { ...previewInput().run, state: "FAILED", status: null, hasResult: false, error: "QA run exited with code 1 without writing a report." },
  }));
  assert.deepEqual(typesOf(preview.notifications), ["RUN_FAILED"]);
  assert.equal(preview.notifications[0]!.source, "run-state");
  assert.match(preview.notifications[0]!.message, /exited with code 1/);
  assert.equal(preview.counts.RUN_FAILED, 1);
});

test("a completed run of a failing site is not a failed run", () => {
  // The engine finished and recorded FAIL. Its findings are findings; the run
  // itself did not fail, so RUN_FAILED must stay silent.
  const preview = buildNotificationPreview(previewInput({
    analysis: analysisWith([finding()]),
    run: { ...previewInput().run, status: "FAIL" },
  }));
  assert.deepEqual(typesOf(preview.notifications), []);
});

test("infrastructure problems are their own RUN_FAILED cause, separate from findings", () => {
  // The two recorded counters both describe the QA verification itself: finding
  // level problems from the summary, and failures the verification execution hit.
  const withFailures = analysisWith([finding()], {
    summary: { overallStatus: "FAIL", headline: "problems", issueCount: 1, flowsDetected: 1, scheduled: 1, executed: 1, reproduced: 1, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 2, infrastructureFailures: 1, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 } },
    execution: { status: "FAIL", tests: 1, passed: 0, failed: 1, skipped: 0, infrastructureFailures: 1, failures: [] },
  });
  const preview = buildNotificationPreview(previewInput({ analysis: withFailures }));
  const failures = preview.notifications.filter(item => item.type === "RUN_FAILED");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.source, "verification");
  assert.deepEqual(failures[0]!.details, ["infrastructureProblems=2", "infrastructureFailures=1"]);
});

test("flow-discovery infrastructure problems alone do not fail a completed run", () => {
  // Exploratory flows that could not run are not a failed verification: the run
  // finished and reported its findings, so RUN_FAILED stays silent.
  const analysis = analysisWith([finding()], {
    flowDiscovery: { ...analysisWith([]).flowDiscovery, executions: [{ executionId: "exec-1", failureCategory: "INFRASTRUCTURE", status: "INFRASTRUCTURE_PROBLEM" }] },
  });
  const preview = buildNotificationPreview(previewInput({ analysis }));
  assert.deepEqual(typesOf(preview.notifications), []);
});

test("a clean run with no infrastructure problem is never a RUN_FAILED", () => {
  const preview = buildNotificationPreview(previewInput({ analysis: analysisWith([]) }));
  assert.deepEqual(typesOf(preview.notifications), []);
});

// ---------------------------------------------------------------------------
// Finding lifecycle, read from the recorded comparison
// ---------------------------------------------------------------------------

const findingRef = (overrides: Record<string, unknown> = {}) => ({
  id: "prj-fnd-0123456789abcdef",
  fingerprint: "BTN|https://qa.test/pricing|btn#submit",
  title: "Button lacks an accessible name",
  code: "BTN",
  severity: "HIGH",
  status: "NEW",
  page: PRICING,
  runId: "web-run-2",
  runFindingId: "QA-F-001",
  ...overrides,
});

const comparisonInput = (overrides: {
  new?: unknown[]; resolved?: unknown[]; regressed?: unknown[];
  comparisonAvailable?: boolean;
  trustworthy?: boolean;
} & Partial<NotificationPreviewInput>) => previewInput({
  ...overrides,
  comparison: {
    comparisonAvailable: overrides.comparisonAvailable ?? true,
    reason: overrides.comparisonAvailable === false ? "no earlier completed run" : null,
    counts: { new: overrides.new?.length ?? 0, active: 0, resolved: overrides.resolved?.length ?? 0, regressed: overrides.regressed?.length ?? 0, changed: 0, unchanged: 0 },
    new: (overrides.new ?? []) as any,
    resolved: (overrides.resolved ?? []) as any,
    regressed: (overrides.regressed ?? []) as any,
    active: [], unchanged: [], changed: [],
  },
  snapshot: {
    runId: "web-run-2", projectId: "prj-1", at: "2026-09-29T10:00:00.000Z",
    comparisonAvailable: overrides.comparisonAvailable ?? true,
    comparisonReason: null,
    resolutionTrustworthy: overrides.trustworthy ?? true,
    resolutionReason: null,
    counts: { new: 0, active: 0, resolved: 0, regressed: 0, changed: 0, unchanged: 0 },
    refs: { new: [], resolved: [], regressed: [], active: [], unchanged: [], changed: [] },
    entries: [],
  } as any,
});

test("new, regressed and resolved findings each produce their own notification", () => {
  const preview = buildNotificationPreview(comparisonInput({
    new: [findingRef({ id: "prj-fnd-a", status: "NEW", severity: "HIGH" })],
    regressed: [findingRef({ id: "prj-fnd-b", status: "REGRESSED" })],
    resolved: [findingRef({ id: "prj-fnd-c", status: "RESOLVED" })],
  }));
  // Reporting order, not lifecycle order: regressions before news, news before
  // resolutions.
  assert.deepEqual(typesOf(preview.notifications), ["REGRESSED_FINDING", "NEW_FINDING", "RESOLVED_FINDING"]);
  assert.equal(preview.counts.NEW_FINDING, 1);
  assert.equal(preview.counts.REGRESSED_FINDING, 1);
  assert.equal(preview.counts.RESOLVED_FINDING, 1);
  assert.deepEqual(preview.notifications.map(item => item.findingId), ["prj-fnd-b", "prj-fnd-a", "prj-fnd-c"]);
  assert.deepEqual([...new Set(preview.notifications.map(item => item.source))], ["finding-lifecycle"]);
});

test("an explicitly new finding is reported even when there is nothing to compare against", () => {
  // A first run has no predecessor. "This finding was never seen before" is a
  // fact about the run itself, so it survives an unavailable comparison; nothing
  // about a prior state is being claimed.
  const preview = buildNotificationPreview(comparisonInput({
    comparisonAvailable: false,
    new: [findingRef({ id: "prj-fnd-a" })],
  }));
  assert.deepEqual(typesOf(preview.notifications), ["NEW_FINDING"]);
  assert.equal(preview.comparison.status, "UNAVAILABLE");
  assert.equal(preview.comparison.previousRunId, null);
});

test("without a comparison, nothing that asserts a prior state is invented", () => {
  // Hand-built input: the refs are present, but there is no comparable previous
  // run, so a regression or a resolution would be a guess.
  const preview = buildNotificationPreview(comparisonInput({
    comparisonAvailable: false,
    regressed: [findingRef({ id: "prj-fnd-b", status: "REGRESSED" })],
    resolved: [findingRef({ id: "prj-fnd-c", status: "RESOLVED" })],
  }));
  assert.deepEqual(typesOf(preview.notifications), []);
  assert.equal(preview.counts.REGRESSED_FINDING, 0);
  assert.equal(preview.counts.RESOLVED_FINDING, 0);
});

test("a run whose absences cannot be trusted resolves nothing, whatever the comparison says", () => {
  // resolutionTrustworthy false means blocked / incomplete / infrastructure-broken
  // / untested-page. The lifecycle would not have resolved anything; the preview
  // checks the recorded flag as well rather than trusting the ref list alone.
  const preview = buildNotificationPreview(comparisonInput({
    trustworthy: false,
    resolved: [findingRef({ id: "prj-fnd-c", status: "RESOLVED" })],
    new: [findingRef({ id: "prj-fnd-a" })],
  }));
  assert.deepEqual(typesOf(preview.notifications), ["NEW_FINDING"]);
  assert.equal(preview.counts.RESOLVED_FINDING, 0);
});

test("a missing comparison record produces no finding notifications at all", () => {
  const preview = buildNotificationPreview(previewInput({ comparison: null, snapshot: null }));
  assert.deepEqual(preview.notifications, []);
  assert.equal(preview.comparison.status, "UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// ACCESS_CHANGED
// ---------------------------------------------------------------------------

/**
 * Real change summaries, built by the existing comparison from real reports and
 * the real lifecycle snapshot. The preview is never handed a summary it could
 * not get from those modules themselves.
 */
const summaryOf = (
  current: any,
  previous: any | null,
  currentRunId = "web-run-2",
  previousRunId: string | null = "web-run-1",
) => {
  // The lifecycle snapshot the project store would have recorded for this pair.
  const applied = applyRunToLedger({
    projectId: "prj-1", runId: currentRunId, analysis: current,
    ledger: emptyLedger(), previousAnalysis: previous, previousRunId,
  });
  return buildChangeSummary({
    currentRunId, current, previousRunId, previous,
    snapshot: applied.snapshot,
    findingTitles: new Map(applied.ledger.findings.map(item => [item.id, { title: item.title, code: item.code, severity: item.severity, page: item.page }])),
  });
};

const blockedAnalysis = (overrides: Record<string, unknown> = {}) => analysisWith([], {
  generatedAt: "2026-09-28T10:00:00.000Z",
  accessPrerequisite: { status: "BLOCKED", reason: "login required", details: [] },
  summary: { overallStatus: "FAIL", headline: "blocked", issueCount: 0, flowsDetected: 1, scheduled: 1, executed: 0, reproduced: 0, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 0, infrastructureFailures: 0, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 } },
  ...overrides,
});

test("a recorded access transition produces ACCESS_CHANGED, and an unchanged state produces nothing", () => {
  const previous = blockedAnalysis();
  const current = analysisWith([], { generatedAt: "2026-09-29T10:00:00.000Z" });
  const summary = summaryOf(current, previous);
  assert.equal(summary.access.changed, true, "the recorded comparison is the one that decided this");

  const changed = buildNotificationPreview(previewInput({ changeSummary: summary }));
  assert.equal(changed.notifications.some(item => item.type === "ACCESS_CHANGED"), true);
  const event = changed.notifications.find(item => item.type === "ACCESS_CHANGED")!;
  assert.equal(event.source, "access-comparison");
  assert.match(event.message, /ACCESS_BLOCKED to ACCESSIBLE/);
  assert.deepEqual(event.details, ["previous=ACCESS_BLOCKED", "current=ACCESSIBLE"]);

  const same = buildNotificationPreview(previewInput({ changeSummary: summaryOf(current, current) }));
  assert.deepEqual(typesOf(same.notifications).filter(type => type === "ACCESS_CHANGED"), []);
});

test("an unknown access state on either side is never reported as a transition", () => {
  // A first run has no measured baseline: the recorded comparison labels the
  // previous side UNKNOWN, which is an unmeasured baseline rather than a state
  // the site was ever in. "We could not tell before, we can tell now" is not an
  // access change.
  const firstRun = summaryOf(analysisWith([]), null);
  assert.equal(firstRun.availability, "UNAVAILABLE");
  assert.equal(firstRun.access.previous, "UNKNOWN");
  assert.deepEqual(typesOf(buildNotificationPreview(previewInput({ changeSummary: firstRun })).notifications), []);
});

// ---------------------------------------------------------------------------
// SCHEDULE_SKIPPED
// ---------------------------------------------------------------------------

const execution = (overrides: Record<string, unknown> = {}) => ({
  executionId: "exe-1",
  scheduleId: "sch-1",
  projectId: "prj-1",
  runId: null,
  status: "SKIPPED_OVERLAPPING_RUN",
  trigger: "SCHEDULED",
  scheduledFor: "2026-09-29T10:00:00.000Z",
  startedAt: null,
  completedAt: "2026-09-29T10:02:00.000Z",
  detail: "another run was already in progress",
  ...overrides,
}) as any;

test("a skip recorded while the selected run was in flight is attributed to that run", () => {
  const preview = buildNotificationPreview(previewInput({ executions: [execution()] }));
  assert.deepEqual(typesOf(preview.notifications), ["SCHEDULE_SKIPPED"]);
  assert.equal(preview.notifications[0]!.source, "schedule-execution");
  // A skip has no run behind it, so the event points at the execution, not at a run.
  assert.equal(preview.notifications[0]!.reference, "exe-1");
  assert.match(preview.notifications[0]!.message, /another run was already in progress/);
});

test("a skip outside the run's own window belongs to no run and is not guessed at", () => {
  // Both an earlier skip and a later one: neither happened while this run ran.
  const before = buildNotificationPreview(previewInput({
    executions: [execution({ executionId: "exe-before", completedAt: "2026-09-29T09:00:00.000Z" })],
  }));
  const after = buildNotificationPreview(previewInput({
    executions: [execution({ executionId: "exe-after", completedAt: "2026-09-29T11:00:00.000Z" })],
  }));
  assert.deepEqual(typesOf(before.notifications), []);
  assert.deepEqual(typesOf(after.notifications), []);
});

test("a completed scheduled run is not a skip", () => {
  const preview = buildNotificationPreview(previewInput({
    executions: [execution({ status: "COMPLETED", runId: "web-run-2", detail: null })],
  }));
  assert.deepEqual(typesOf(preview.notifications), []);
});

test("a failed or interrupted scheduler execution is RUN_FAILED, not a skip", () => {
  for (const status of ["FAILED", "INTERRUPTED"]) {
    const preview = buildNotificationPreview(previewInput({
      executions: [execution({ status, runId: "web-run-2", detail: "the process ended without a report" })],
    }));
    assert.deepEqual(typesOf(preview.notifications), ["RUN_FAILED"], status);
    assert.equal(preview.notifications[0]!.source, "schedule-execution");
  }
});

test("a run with no recorded window cannot be matched to a skip", () => {
  const preview = buildNotificationPreview(previewInput({
    run: { ...previewInput().run, startedAt: "not-a-date", completedAt: null },
    executions: [execution()],
  }));
  assert.deepEqual(typesOf(preview.notifications), []);
});

// ---------------------------------------------------------------------------
// MEANINGFUL_CHANGE
// ---------------------------------------------------------------------------

test("meaningful change reuses the existing change-summary lines verbatim", () => {
  // Two real reports that genuinely differ, summarized by the existing module.
  const summary = summaryOf(
    analysisWith([finding(), labelFinding({ id: "QA-F-002" })], { generatedAt: "2026-09-29T10:00:00.000Z" }),
    analysisWith([], { generatedAt: "2026-09-28T10:00:00.000Z" }),
  );
  const lines = highlightsOf(summary);
  assert.ok(lines.length, "the fixture must actually record a difference");
  const preview = buildNotificationPreview(previewInput({ changeSummary: summary }));
  const meaningful = preview.notifications.filter(item => item.type === "MEANINGFUL_CHANGE");
  assert.equal(meaningful.length, 1);
  assert.equal(meaningful[0]!.source, "change-intelligence");
  assert.deepEqual(meaningful[0]!.details, lines, "the existing lines are passed through unchanged");
});

test("an unchanged run summary and an unavailable one both produce no meaningful-change event", () => {
  const same = analysisWith([], { generatedAt: "2026-09-29T10:00:00.000Z" });
  const sameSummary = summaryOf(same, analysisWith([], { generatedAt: "2026-09-28T10:00:00.000Z" }));
  assert.equal(sameSummary.availability, "AVAILABLE", "two comparable runs, however similar, are still comparable");
  assert.deepEqual(highlightsOf(sameSummary), [], "the fixture must record no difference at all");

  const unchanged = buildNotificationPreview(previewInput({ changeSummary: sameSummary }));
  assert.deepEqual(typesOf(unchanged.notifications), []);

  const firstRunSummary = summaryOf(same, null);
  assert.equal(firstRunSummary.availability, "UNAVAILABLE");
  const unavailable = buildNotificationPreview(previewInput({ changeSummary: firstRunSummary }));
  assert.equal(unavailable.comparison.status, "UNAVAILABLE");
  assert.deepEqual(typesOf(unavailable.notifications), [], "an unavailable comparison claims no change");
});

// ---------------------------------------------------------------------------
// Determinism and ordering
// ---------------------------------------------------------------------------

test("the same input always produces byte-identical output, whatever order its inputs arrive in", () => {
  const base = comparisonInput({
    new: [findingRef({ id: "prj-fnd-a" }), findingRef({ id: "prj-fnd-z", code: "LNK", title: "Link text is empty" })],
    resolved: [findingRef({ id: "prj-fnd-m", status: "RESOLVED" })],
    regressed: [findingRef({ id: "prj-fnd-r", status: "REGRESSED" })],
  });
  const first = JSON.stringify(buildNotificationPreview({
    ...base,
    executions: [execution({ executionId: "exe-1" }), execution({ executionId: "exe-2" })],
  }));
  const shuffled = JSON.stringify(buildNotificationPreview({
    ...base,
    executions: [execution({ executionId: "exe-2" }), execution({ executionId: "exe-1" })],
  }));
  assert.equal(shuffled, first, "input order must not change a single value");
  assert.equal(JSON.stringify(buildNotificationPreview({ ...base, executions: [execution({ executionId: "exe-1" }), execution({ executionId: "exe-2" })] })), first, "and repeating the call changes nothing");
});

test("every notification is ordered by the agreed type order, never by arrival", () => {
  const preview = buildNotificationPreview(comparisonInput({
    new: [findingRef({ id: "prj-fnd-new" })],
    resolved: [findingRef({ id: "prj-fnd-res", status: "RESOLVED" })],
    regressed: [findingRef({ id: "prj-fnd-reg", status: "REGRESSED" })],
    changeSummary: summaryOf(analysisWith([finding(), labelFinding()]), blockedAnalysis()),
    executions: [execution()],
    analysis: analysisWith([finding()], { summary: { overallStatus: "FAIL", headline: "p", issueCount: 1, flowsDetected: 1, scheduled: 1, executed: 1, reproduced: 1, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 1, infrastructureFailures: 0, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 } } }),
    run: { ...previewInput().run, state: "FAILED", hasResult: false, error: "engine crashed" },
  }));
  const rank = notificationPreviewTypeOrder();
  const ranks = preview.notifications.map(item => rank.indexOf(item.type));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "the list must already be in reporting order");
  assert.deepEqual(typesOf(preview.notifications), ["RUN_FAILED", "RUN_FAILED", "ACCESS_CHANGED", "REGRESSED_FINDING", "NEW_FINDING", "RESOLVED_FINDING", "SCHEDULE_SKIPPED", "MEANINGFUL_CHANGE"]);
});

test("the counts always add up to the number of notifications", () => {
  const preview = buildNotificationPreview(comparisonInput({
    new: [findingRef({ id: "prj-fnd-a" })],
    changeSummary: summaryOf(analysisWith([finding()]), analysisWith([])),
    executions: [execution()],
  }));
  const summed = Object.values(preview.counts).reduce((total, count) => total + count, 0);
  assert.equal(summed, preview.notifications.length);
  assert.deepEqual(Object.keys(preview.counts).sort(), [...notificationPreviewTypeOrder()].sort());
});

test("every notification carries the project and run it belongs to", () => {
  const preview = buildNotificationPreview(comparisonInput({ new: [findingRef()] }));
  for (const item of preview.notifications) {
    assert.equal(item.projectId, "prj-1");
    assert.equal(item.projectName, "Preview");
    assert.equal(item.runId, "web-run-2");
    assert.ok(item.reference, "every notification has something stable to link to");
  }
  assert.equal(preview.run.id, "web-run-2");
  assert.equal(preview.run.findingsCount, 0);
});

// ---------------------------------------------------------------------------
// The endpoint over real HTTP
// ---------------------------------------------------------------------------


const previewOf = (base: string, projectId: string, runId: string) =>
  getJson(`${base}/api/projects/${projectId}/notification-preview/${runId}`);

test("a first run with a new finding previews that finding over HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-new-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Preview", url: "https://qa.test/" });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const projectId = created.json.project.id as string;

    const runId = await runOnce(base, projectId, children, 0, analysisWith([finding()]));
    const preview = await previewOf(base, projectId, runId);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.ok, true);

    const body = preview.json.notificationPreview;
    assert.equal(body.project.id, projectId);
    assert.equal(body.run.id, runId);
    assert.equal(body.run.state, "COMPLETED");
    // No predecessor, so the comparison is honestly unavailable - and the new
    // finding is still reported, because that is a fact about this run.
    assert.equal(body.comparison.status, "UNAVAILABLE");
    assert.deepEqual(typesOf(body.notifications), ["NEW_FINDING"]);
    assert.equal(body.notifications[0].findingId.startsWith("prj-fnd-"), true);
    assert.equal(body.notifications[0].severity, "HIGH");
    assert.equal(body.counts.NEW_FINDING, 1);
  } finally { await stop(dash); }
});

test("resolved and regressed findings each preview their own notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-lifecycle-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Lifecycle", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;

    // Run 1: the finding exists. Run 2: it is gone and the page was tested, so
    // the lifecycle resolved it. Run 3: it is back, so it regressed.
    await runOnce(base, projectId, children, 0, analysisWith([finding()], { generatedAt: "2026-09-29T10:00:00.000Z" }));
    const resolvedRun = await runOnce(base, projectId, children, 1, analysisWith([], { generatedAt: "2026-09-29T11:00:00.000Z" }));
    const regressedRun = await runOnce(base, projectId, children, 2, analysisWith([finding({ id: "QA-F-900" })], { generatedAt: "2026-09-29T12:00:00.000Z" }));

    const resolved = await previewOf(base, projectId, resolvedRun);
    assert.equal(resolved.json.notificationPreview.comparison.status, "AVAILABLE");
    const resolvedTypes = typesOf(resolved.json.notificationPreview.notifications);
    assert.equal(resolvedTypes.includes("RESOLVED_FINDING"), true, `expected a resolution, got ${resolvedTypes.join(", ")}`);

    const regressed = await previewOf(base, projectId, regressedRun);
    const regressedTypes = typesOf(regressed.json.notificationPreview.notifications);
    assert.equal(regressedTypes.includes("REGRESSED_FINDING"), true, `expected a regression, got ${regressedTypes.join(", ")}`);
  } finally { await stop(dash); }
});

test("a second finding appearing later is a NEW finding, and the first stays untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-second-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Two", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;

    await runOnce(base, projectId, children, 0, analysisWith([finding()], { generatedAt: "2026-09-29T10:00:00.000Z" }));
    const secondRun = await runOnce(base, projectId, children, 1, analysisWith([finding({ id: "QA-F-501" }), labelFinding({ id: "QA-F-502" })], { generatedAt: "2026-09-29T11:00:00.000Z" }));

    const body = (await previewOf(base, projectId, secondRun)).json.notificationPreview;
    assert.equal(body.counts.NEW_FINDING, 1, "only the genuinely new problem is news");
    const newFinding = body.notifications.find((item: NotificationPreviewEvent) => item.type === "NEW_FINDING");
    assert.match(newFinding.message, /Input has no label/);
    // A new finding is always reported before the change summary that mentions it.
    assert.ok(typesOf(body.notifications).indexOf("NEW_FINDING") < typesOf(body.notifications).indexOf("MEANINGFUL_CHANGE"));
  } finally { await stop(dash); }
});

test("a run that could not reach the site resolves nothing and previews no resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-blocked-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Blocked", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;

    await runOnce(base, projectId, children, 0, analysisWith([finding()], { generatedAt: "2026-09-29T10:00:00.000Z" }));
    const blockedRun = await runOnce(base, projectId, children, 1, analysisWith([], {
      generatedAt: "2026-09-29T11:00:00.000Z",
      accessPrerequisite: { status: "BLOCKED", reason: "robots deny", details: [] },
    }));

    const body = (await previewOf(base, projectId, blockedRun)).json.notificationPreview;
    assert.equal(body.counts.RESOLVED_FINDING, 0, "a blocked run proves nothing about the finding");
    assert.equal(body.counts.NEW_FINDING, 0);
    // What it does report is honest: the site stopped being reachable.
    assert.deepEqual(typesOf(body.notifications), ["ACCESS_CHANGED", "MEANINGFUL_CHANGE"]);
  } finally { await stop(dash); }
});

test("a run that crashed previews RUN_FAILED and nothing it never recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-crash-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Crash", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;

    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    crash(children[0]!);
    await waitFor(() => children[0]!.exitCode !== null);
    const runId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;

    const body = (await previewOf(base, projectId, runId)).json.notificationPreview;
    assert.equal(body.run.state, "FAILED");
    assert.equal(body.run.hasResult, false);
    assert.deepEqual(typesOf(body.notifications), ["RUN_FAILED"]);
    assert.match(body.notifications[0].message, /without writing a report/);
  } finally { await stop(dash); }
});

test("an access boundary change is previewed, and an unchanged run is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-access-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Access", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;

    const blocked = analysisWith([], {
      generatedAt: "2026-09-29T10:00:00.000Z",
      accessPrerequisite: { status: "BLOCKED", reason: "login required", details: [] },
      summary: { overallStatus: "FAIL", headline: "blocked", issueCount: 0, flowsDetected: 1, scheduled: 1, executed: 0, reproduced: 0, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 0, infrastructureFailures: 0, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 } },
    });
    await runOnce(base, projectId, children, 0, blocked);
    const recovered = await runOnce(base, projectId, children, 1, analysisWith([], { generatedAt: "2026-09-29T11:00:00.000Z" }));

    const body = (await previewOf(base, projectId, recovered)).json.notificationPreview;
    assert.equal(body.counts.ACCESS_CHANGED, 1, `expected an access transition, got ${JSON.stringify(typesOf(body.notifications))}`);
    const event = body.notifications.find((item: NotificationPreviewEvent) => item.type === "ACCESS_CHANGED");
    assert.match(event.message, /ACCESS/);
    assert.deepEqual(event.details, ["previous=ACCESS_BLOCKED", "current=ACCESSIBLE"]);

    // Asking again about the same run yields the same answer, and the very first
    // (blocked) run reports no transition: there was nothing before it.
    const first = (await previewOf(base, projectId, (await getJson(`${base}/api/projects/${projectId}`)).json.runs[1].runId)).json.notificationPreview;
    assert.equal(first.counts.ACCESS_CHANGED, 0);
  } finally { await stop(dash); }
});

test("a scheduler slot skipped during a real run is previewed for that run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-skip-"));
  const { spawnImpl, children } = fakeSpawner();
  // The real clock, not a fake one: the skip's recorded instant and the run's own
  // recorded window have to sit on the same timeline for the attribution to mean
  // anything.
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Skipped", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await send("PUT", `${base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });

    // A real manual run occupies the single-run slot...
    const manual = await postJson(`${base}/api/projects/${projectId}/runs`);
    assert.equal(manual.status, 202, JSON.stringify(manual.json));
    const runId = manual.json.run.runId as string;
    await waitFor(() => children.length === 1);

    // ...so a real trigger during it is a recorded skip.
    const triggered = await postJson(`${base}/api/projects/${projectId}/schedule/run-now`);
    assert.equal(triggered.status, 200, JSON.stringify(triggered.json));
    assert.equal(triggered.json.execution.status, "SKIPPED_OVERLAPPING_RUN");

    // While the run is still in flight its own window has not closed yet, so the
    // preview declines to claim the skip rather than guessing with a clock it is
    // not allowed to read.
    const during = await previewOf(base, projectId, runId);
    assert.equal(during.json.notificationPreview.counts.SCHEDULE_SKIPPED, 0);
    assert.equal(during.json.notificationPreview.run.completedAt, null);

    // Once the run settles, its recorded start-to-complete window contains the
    // skip, so the skip is attributed to it.
    settle(children[0]!, analysisWith([finding()]));
    await waitFor(() => children[0]!.exitCode !== null);
    const after = (await previewOf(base, projectId, runId)).json.notificationPreview;
    assert.equal(after.counts.SCHEDULE_SKIPPED, 1, JSON.stringify(typesOf(after.notifications)));
    const event = after.notifications.find((item: NotificationPreviewEvent) => item.type === "SCHEDULE_SKIPPED");
    assert.equal(event.source, "schedule-execution");
    assert.match(event.message, /SKIPPED_OVERLAPPING_RUN/);
    assert.equal(after.counts.NEW_FINDING, 1, "the run's own finding is reported alongside the skip");
    // Skips come after the finding news, and access is not claimed.
    assert.deepEqual(typesOf(after.notifications), ["NEW_FINDING", "SCHEDULE_SKIPPED"]);
  } finally { await stop(dash); }
});

test("the same run always previews the same thing, and previewing changes nothing on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-readonly-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "ReadOnly", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await send("PUT", `${base}/api/projects/${projectId}/schedule`, { frequency: "HOURLY", timezone: "UTC" });
    const firstRun = await runOnce(base, projectId, children, 0, analysisWith([finding(), labelFinding()], { generatedAt: "2026-09-29T10:00:00.000Z" }));
    const secondRun = await runOnce(base, projectId, children, 1, analysisWith([finding()], { generatedAt: "2026-09-29T11:00:00.000Z" }));

    const hashTree = (root: string): string => {
      const files: string[] = [];
      const collect = (path: string): void => {
        for (const entry of readdirSync(path).sort()) {
          const full = join(path, entry);
          if (statSync(full).isDirectory()) collect(full);
          else files.push(`${full.slice(root.length)}=${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
        }
      };
      collect(root);
      return createHash("sha256").update(files.join("\n")).digest("hex");
    };

    const before = hashTree(dir);
    const firstAnswer = await getJson(`${base}/api/projects/${projectId}/notification-preview/${firstRun}`);
    const againAnswer = await getJson(`${base}/api/projects/${projectId}/notification-preview/${firstRun}`);
    const secondAnswer = await getJson(`${base}/api/projects/${projectId}/notification-preview/${secondRun}`);
    const after = hashTree(dir);

    assert.equal(after, before, "reading the preview must not write anything");
    assert.deepEqual(againAnswer.json, firstAnswer.json, "the same run must preview identically every time");
    assert.deepEqual(Object.keys(againAnswer.json.notificationPreview.counts).sort(), [...notificationPreviewTypeOrder()].sort());
    assert.notDeepEqual(secondAnswer.json, firstAnswer.json, "two different runs may of course differ");
  } finally { await stop(dash); }
});

test("a preview is refused for a run that is not this project's, and for a run that does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-404-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const a = await postJson(`${base}/api/projects`, { name: "A", url: "https://qa.test/a" });
    const b = await postJson(`${base}/api/projects`, { name: "B", url: "https://qa.test/b" });
    const projectA = a.json.project.id as string;
    const projectB = b.json.project.id as string;

    const runA = await runOnce(base, projectA, children, 0, analysisWith([finding()]));
    const runB = await runOnce(base, projectB, children, 1, analysisWith([finding()], { generatedAt: "2026-09-29T11:00:00.000Z" }));

    // Each project's own run previews.
    assert.equal((await previewOf(base, projectA, runA)).status, 200);
    assert.equal((await previewOf(base, projectB, runB)).status, 200);
    // A real run belonging to another project is refused rather than guessed at.
    const crossed = await previewOf(base, projectA, runB);
    assert.equal(crossed.status, 404);
    assert.equal(crossed.json.ok, false);
    const backwards = await previewOf(base, projectB, runA);
    assert.equal(backwards.status, 404);

    // Unknown project, unknown run.
    assert.equal((await previewOf(base, "prj-nope", runA)).status, 404);
    assert.equal((await previewOf(base, projectA, "web-nope")).status, 404);
  } finally { await stop(dash); }
});

test("the preview endpoint is read-only over HTTP: bad input and wrong methods are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-notify-methods-"));
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Methods", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    assert.equal((await getJson(`${base}/api/projects/${projectId}/notification-preview/${encodeURIComponent("bad id")}`)).status, 400);
    assert.equal((await getJson(`${base}/api/projects/${encodeURIComponent("bad id")}/notification-preview/web-1`)).status, 400);
    assert.equal((await postJson(`${base}/api/projects/${projectId}/notification-preview/web-1`)).status, 405);
  } finally { await stop(dash); }
});
