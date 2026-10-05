import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  accessStateOf,
  buildChangeSummary,
  changeAvailability,
  changeRecordOf,
  flowStatusOf,
  highlightsOf,
  pageIdentity,
  unavailableChangeSummary,
  verificationCountsOf,
  type ChangeSummary,
} from "../dashboard/run-comparison.js";
import { applyRunToLedger, emptyLedger, type ProjectRunFindingsSnapshot } from "../dashboard/project-findings.js";
import { startDashboard } from "../dashboard/server.js";
import { flowFamilyKey } from "../regression/identity.js";

// ---------------------------------------------------------------------------
// Fixtures: reports shaped exactly like the artifacts the engine writes, so
// every assertion below is about real recorded evidence.
// ---------------------------------------------------------------------------

const SITE = "https://qa.test";
const PRICING = `${SITE}/pricing`;

/** A discovered element, in the engine's real shape. */
const element = (overrides: Record<string, unknown> = {}) => ({
  tag: "button",
  role: null,
  text: "Buy now",
  ariaLabel: null,
  placeholder: null,
  name: null,
  id: "buy-1",
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

const pageNode = (url: string, title: string) => ({
  id: `PAGE-${url}`,
  url,
  title,
  depth: 0,
  sourceReportUrl: SITE,
  navigationStatus: 200,
  brokenLinks: 0,
  controls: [],
  edges: [],
});

const flow = (overrides: Record<string, unknown> = {}) => ({
  flowId: "FLOW-001",
  category: "AUTHENTICATION",
  title: "Authentication boundary",
  description: "the login path",
  startPageId: "PAGE-1",
  startUrl: PRICING,
  steps: [
    { action: "observe", target: "the page shows a login link" },
    { action: "click-link", target: "the login page opens" },
  ],
  safety: "SAFE",
  automation: "AUTOMATED",
  boundary: null,
  executable: true,
  priority: "P1",
  priorityReason: "reason",
  confidence: "HIGH",
  occurrenceCount: 1,
  dedupeKey: "k1",
  evidence: [],
  ...overrides,
});

const execution = (status: string, overrides: Record<string, unknown> = {}) => ({
  scenarioId: "SC-1",
  flowId: "FLOW-001",
  category: "AUTHENTICATION",
  title: "Authentication boundary",
  executedAt: "2026-09-29T10:00:05.000Z",
  durationMs: 100,
  status,
  failureCategory: null,
  startedUrl: PRICING,
  finalUrl: PRICING,
  stoppedAtStep: null,
  boundary: null,
  steps: [],
  error: null,
  ...overrides,
});

/** A run report. Only the fields the comparison reads are meaningful here. */
const report = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  generatedAt: "2026-09-29T10:00:00.000Z",
  mode: "deterministic",
  aiProvider: "deterministic",
  scan: {
    scan: { url: PRICING, finalUrl: PRICING, title: "Pricing", timestamp: "2026-09-29T10:00:00.000Z", durationMs: 900 },
    elements: [element(), element({ tag: "a", type: null, hasExplicitType: false, href: `${SITE}/docs`, text: "Docs", id: "docs-1" })],
  },
  findings: [],
  accessPrerequisite: { status: "PASS", reason: null, details: [] },
  flowDiscovery: {
    limits: {},
    graph: { sourceUrl: SITE, pages: [pageNode(PRICING, "Pricing"), pageNode(`${SITE}/docs`, "Docs")] },
    flows: [flow()],
    executions: [execution("PASS")],
    summary: { pages: 2, flows: 1, executable: 1, review: 0, highRisk: 0, blocked: 0, steps: 2, executed: 1, passed: 1, reproduced: 0, notReproduced: 0, reviewRequired: 0, infrastructure: 0 },
  },
  coverage: {
    generatedAt: "2026-09-29T10:00:00.000Z",
    summary: {
      pages: { discovered: 2, tested: 2, partial: 0, untested: 0, blocked: 0, review: 0 },
      flows: { discovered: 1, executed: 1, passed: 1, reproduced: 0, notReproduced: 0, review: 0, blocked: 0 },
      interactions: { tested: 4, partial: 0, untested: 0, review: 0, notApplicable: 0 },
      findings: { analyzed: 0, verified: 0, reproduced: 0, notReproduced: 0, unverified: 0 },
      recommendations: 0,
    },
    items: [],
    testPlan: [],
    aiNotes: { gaps: [] },
  },
  summary: {
    overallStatus: "PASS", headline: "ok", sourceUrl: PRICING, issueCount: 0, flowsDetected: 1,
    scheduled: 2, executed: 2, reproduced: 0, notReproduced: 2, pass: 0, review: 0,
    skippedUnsupported: 1, skippedLocatorGuard: 2, skippedSafety: 0,
    reviewRequired: 0, infrastructureProblems: 0, infrastructureFailures: 0, unverified: 3,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  },
  execution: { status: "PASS", tests: 2, passed: 0, failed: 0, skipped: 3, failures: [] },
  verifications: [],
  ...overrides,
}) as any;

/** A recorded lifecycle snapshot, so findings can be read rather than recomputed. */
const snapshotFor = (analysis: any, previousAnalysis: any | null, runId = "web-run-2", previousRunId: string | null = "web-run-1") => {
  const applied = applyRunToLedger({
    projectId: "prj-1", runId, analysis, ledger: emptyLedger(), previousAnalysis, previousRunId,
  });
  return { snapshot: applied.snapshot, ledger: applied.ledger };
};

const compare = (current: any, previous: any | null, snapshot: ProjectRunFindingsSnapshot | null = null, titles = new Map()): ChangeSummary =>
  buildChangeSummary({
    currentRunId: "web-run-2",
    current,
    previousRunId: previous ? "web-run-1" : null,
    previous,
    snapshot,
    findingTitles: titles,
  });

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("the same two reports always produce the same summary, whatever order their arrays are in", () => {
  const current = report();
  const previous = report({ generatedAt: "2026-09-28T10:00:00.000Z" });
  const first = compare(current, previous);

  // Same evidence, reversed array order everywhere it could matter.
  const shuffled = report({
    scan: { ...current.scan, elements: [...current.scan.elements].reverse() },
    flowDiscovery: {
      ...current.flowDiscovery,
      graph: { ...current.flowDiscovery.graph, pages: [...current.flowDiscovery.graph.pages].reverse() },
      flows: [...current.flowDiscovery.flows].reverse(),
      executions: [...current.flowDiscovery.executions].reverse(),
    },
  });
  const reversed = compare(shuffled, previous);

  assert.deepEqual(reversed, first, "input order is not allowed to change a single output value");
  assert.deepEqual(compare(current, previous), first, "and repeating the call changes nothing");
});

test("the summary contains no score, rank, or verdict of improvement", () => {
  const summary = compare(report(), report({ generatedAt: "2026-09-28T10:00:00.000Z" }));
  const text = JSON.stringify(summary);
  for (const forbidden of ["healthScore", "qualityScore", "overallScore", "findingScore", "riskScore", "stabilityScore", "grade", "rank", "improved", "worse", "better"]) {
    assert.equal(text.includes(forbidden), false, `"${forbidden}" must never appear in a change summary`);
  }
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test("a run with no predecessor says so, and claims nothing", () => {
  const summary = compare(report(), null);
  assert.equal(summary.comparisonAvailable, false);
  assert.equal(summary.availability, "UNAVAILABLE");
  assert.equal(summary.reason, "NO_PREVIOUS_RUN");
  assert.equal(summary.previousRunId, null);
  for (const dimension of [summary.pages, summary.elements, summary.flows, summary.findings] as const) {
    assert.equal(dimension.available, false, "no dimension is presented as compared");
  }
  // Verification keeps this run's own counts, but there is no baseline.
  assert.equal(summary.verification.previous.scheduled, null, "an unmeasured baseline is null, never zero");
  assert.equal(summary.verification.delta.scheduled, null, "so there is no delta to claim");
  assert.equal(summary.verification.current.scheduled, 2, "this run's own recorded counts are still real");
});

test("a previous run that never exercised the site blocks the comparison", () => {
  // The previous run REACHED the site - access is fine - but then tested
  // nothing: no page was tested and no flow was executed. That is an
  // incomplete run, not an access boundary, and the two must not be confused.
  const previous = report({
    generatedAt: "2026-09-28T10:00:00.000Z",
    coverage: { generatedAt: "x", summary: { pages: { discovered: 1, tested: 0, partial: 0, untested: 1, blocked: 1, review: 0 } }, items: [], testPlan: [], aiNotes: { gaps: [] } },
    flowDiscovery: { ...report().flowDiscovery, executions: [] },
  });
  const summary = compare(report(), previous);
  assert.equal(summary.reason, "PREVIOUS_RUN_INCOMPLETE");
  assert.equal(summary.comparisonAvailable, false);
  assert.equal(summary.pages.available, false);
  assert.equal(summary.flows.available, false);
  assert.equal(summary.access.changed, false, "no access boundary was crossed");
  assert.match(summary.reasonDetail!, /review|authentication|tested/i);
});

test("a current run that never exercised the site blocks the comparison", () => {
  const previous = report({ generatedAt: "2026-09-28T10:00:00.000Z" });
  const current = report({
    coverage: { generatedAt: "x", summary: { pages: { discovered: 1, tested: 0, partial: 0, untested: 1, blocked: 1, review: 0 } }, items: [], testPlan: [], aiNotes: { gaps: [] } },
  });
  const summary = compare(current, previous);
  assert.equal(summary.reason, "CURRENT_RUN_INCOMPLETE");
  assert.equal(summary.comparisonAvailable, false);
  assert.equal(summary.elements.available, false);
});

test("an access transition is reported as a transition, never as a resolution", () => {
  // The previous run hit a login wall. The current run got in. That is a real
  // change, and the only thing that may honestly be claimed.
  const previous = report({
    generatedAt: "2026-09-28T10:00:00.000Z",
    accessPrerequisite: { type: "authentication-required", status: "REVIEW_REQUIRED", reason: "login required", details: [] },
    coverage: { generatedAt: "x", summary: { pages: { discovered: 1, tested: 0, partial: 0, untested: 1, blocked: 1, review: 0 } }, items: [], testPlan: [], aiNotes: { gaps: [] } },
  });
  const summary = compare(report(), previous);

  assert.equal(summary.availability, "PARTIAL");
  assert.equal(summary.reason, "ACCESS_BOUNDARY");
  assert.equal(summary.comparisonAvailable, true, "the transition itself is presentable");
  assert.equal(summary.access.previous, "AUTHENTICATION_REQUIRED");
  assert.equal(summary.access.current, "ACCESSIBLE");
  assert.equal(summary.access.changed, true);
  assert.match(summary.access.transition!, /AUTHENTICATION_REQUIRED -> ACCESSIBLE/);

  // And nothing is concluded from the side that never loaded.
  assert.equal(summary.pages.available, false);
  assert.equal(summary.flows.available, false);
  assert.equal(summary.elements.available, false);
  assert.equal(summary.findings.available, false, "no finding can be called resolved across an access boundary");
  assert.equal(summary.verification.available, false, "no delta across a boundary the run could not cross");
  assert.match(summary.reasonDetail!, /not compared across that boundary/);
});

test("runs against different sites are never compared", () => {
  const previous = report({ scan: { ...report().scan, scan: { url: "https://other.test/", finalUrl: "https://other.test/", title: "Other", timestamp: "x", durationMs: 1 } } });
  const summary = compare(report(), previous);
  assert.equal(summary.reason, "INSUFFICIENT_EVIDENCE");
  assert.equal(summary.comparisonAvailable, false);
});

test("a report with no readable evidence at all still returns a structured, honest answer", () => {
  const summary = unavailableChangeSummary("web-run-9", "INSUFFICIENT_EVIDENCE", "the report artifact could not be read");
  assert.equal(summary.comparisonAvailable, false);
  assert.equal(summary.reason, "INSUFFICIENT_EVIDENCE");
  assert.equal(summary.pages.added.length, 0);
  assert.equal(summary.verification.current.scheduled, null);
  assert.equal(summary.coverage.delta.pagesTested, null);
  assert.equal(summary.findings.available, false);
});

test("a run that recorded only a review status, with no reason, is not given a specific one", () => {
  // Real artifacts do record a status without a type. Saying "authentication
  // required" here would be a guess: the artifact never said which wall it hit.
  const state = accessStateOf(report({ accessPrerequisite: { status: "REVIEW_REQUIRED", reason: null, details: [] } }));
  assert.equal(state, "UNKNOWN", "no specific cause is invented from a bare status");

  // A recorded PASS still means the run reached the site.
  assert.equal(accessStateOf(report({ accessPrerequisite: { status: "PASS", reason: null, details: [] } })), "ACCESSIBLE");
  // A recorded BLOCK still means it did not.
  assert.equal(accessStateOf(report({ accessPrerequisite: { status: "BLOCKED", reason: null, details: [] } })), "ACCESS_BLOCKED");
  // And a report with no access block at all falls back to its own positive
  // evidence, because that is a record too.
  assert.equal(accessStateOf(report({ accessPrerequisite: null })), "ACCESSIBLE");
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test("page identity is strict: unparseable and non-http URLs are excluded, not guessed at", () => {
  assert.equal(pageIdentity(`${SITE}/pricing?b=2&a=1`), pageIdentity(`${SITE}/pricing?a=1&b=2`), "query order is not a different page");
  assert.equal(pageIdentity(`${SITE}/pricing/`), pageIdentity(`${SITE}/pricing`), "a trailing slash is the same page");
  assert.equal(pageIdentity("not a url"), null);
  assert.equal(pageIdentity(""), null);
  assert.equal(pageIdentity(null), null);
  assert.equal(pageIdentity("mailto:hi@qa.test"), null, "a mailto link is not a page");
  assert.equal(pageIdentity("javascript:void(0)"), null);
  assert.equal(pageIdentity("ftp://qa.test/file"), null, "only http(s) is a page");
});

test("pages are compared by identity, and removals are stated only against a comparable run", () => {
  const previous = report();
  const current = report({
    flowDiscovery: {
      ...report().flowDiscovery,
      // The docs page is gone; a junk URL appears that must be ignored.
      graph: { sourceUrl: SITE, pages: [pageNode(PRICING, "Pricing"), pageNode("not a url", "Broken")] },
    },
  });
  const summary = compare(current, previous);
  assert.equal(summary.pages.available, true);
  assert.deepEqual(summary.pages.added.map(page => page.id), [], "a junk URL never becomes a new page");
  assert.deepEqual(summary.pages.removed.map(page => page.url), [`${SITE}/docs`]);
  assert.deepEqual(summary.pages.unchanged.map(page => page.url), [PRICING]);
});

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

test("element changes follow the element itself, not its position in the array", () => {
  const previous = report();
  // Same two elements, reversed, with regenerated DOM ids: nothing changed.
  const same = report({
    scan: {
      ...report().scan,
      elements: [
        element({ tag: "a", type: null, hasExplicitType: false, href: `${SITE}/docs`, text: "Docs", id: "regenerated-9" }),
        element({ id: "regenerated-8" }),
      ],
    },
  });
  const unchanged = compare(same, previous);
  assert.equal(unchanged.elements.added.length, 0);
  assert.equal(unchanged.elements.removed.length, 0);
  assert.equal(unchanged.elements.unmatched.length, 0);

  // A genuinely new interactive control appears.
  const changed = report({
    scan: { ...report().scan, elements: [...report().scan.elements, element({ tag: "a", type: null, hasExplicitType: false, href: `${SITE}/news`, text: "News", id: "news-1" })] },
  });
  const added = compare(changed, previous);
  assert.equal(added.elements.added.length, 1);
  assert.equal(added.elements.added[0]!.text, "News");
  assert.equal(added.elements.interactiveAdded, 1, "and it is counted as interactive");

  // The same control removed.
  const removed = compare(report({ scan: { ...report().scan, elements: [element()] } }), previous);
  assert.equal(removed.elements.removed.length, 1);
  assert.equal(removed.elements.removed[0]!.text, "Docs");
  assert.equal(removed.elements.interactiveRemoved, 1);
});

test("elements that cannot be paired one-to-one are unmatched, never added or removed", () => {
  const previous = report();
  // Two controls with the same semantic fingerprint: the run cannot say which
  // is which, so no claim is made about them.
  const current = report({
    scan: { ...report().scan, elements: [element(), element({ id: "buy-2" }), element({ tag: "a", type: null, hasExplicitType: false, href: `${SITE}/docs`, text: "Docs", id: "docs-2" })] },
  });
  const summary = compare(current, previous);
  assert.equal(summary.elements.unmatched.length, 1, "the duplicated fingerprint is reported as unmatched");
  assert.equal(summary.elements.added.length, 0, "and is not passed off as a new element");
  assert.match(summary.elements.note!, /unmatched rather than added or removed/);
});

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

test("flow status comes from recorded evidence, not from the plan", () => {
  const withExecution = report();
  assert.equal(flowStatusOf(withExecution, withExecution.flowDiscovery.flows[0]), "PASS", "a recorded execution outcome wins");
  const withoutExecution = report({ flowDiscovery: { ...report().flowDiscovery, executions: [] } });
  assert.equal(flowStatusOf(withoutExecution, withoutExecution.flowDiscovery.flows[0]), "EXECUTABLE", "with no execution the recorded plan state is used");
  const blocked = report({ flowDiscovery: { ...report().flowDiscovery, executions: [], flows: [flow({ safety: "BLOCKED", executable: false })] } });
  assert.equal(flowStatusOf(blocked, blocked.flowDiscovery.flows[0]), "BLOCKED");
});

test("a flow that stops being executable is a descriptive status change", () => {
  const previous = report();
  const current = report({
    flowDiscovery: {
      ...report().flowDiscovery,
      executions: [execution("BLOCKED", { failureCategory: "SAFETY_BLOCK", stoppedAtStep: 1, boundary: "stopped before an unsafe step" })],
    },
  });
  const summary = compare(current, previous);
  assert.equal(summary.flows.statusChanged.length, 1);
  const change = summary.flows.statusChanged[0]!;
  assert.equal(change.from, "PASS");
  assert.equal(change.to, "BLOCKED");
  assert.equal(change.transition, "PASS -> BLOCKED");
  assert.equal(change.reason, "STATUS_CHANGE");
  assert.equal(change.evidenceBacked, true, "both sides are recorded execution outcomes");
  assert.equal(summary.flows.added.length, 0, "the same flow is not also reported as new");
  assert.equal(summary.flows.removed.length, 0);
});

test("a flow whose steps change is the same family, not a new flow", () => {
  const previous = report();
  const current = report({
    flowDiscovery: {
      ...report().flowDiscovery,
      flows: [flow({ steps: [{ action: "observe", target: "the page shows a login link" }, { action: "click-link", target: "the login page opens" }, { action: "submit", target: "the form submits" }] })],
      executions: [execution("BLOCKED", { failureCategory: "SAFETY_BLOCK" })],
    },
  });
  const summary = compare(current, previous);
  assert.equal(summary.flows.added.length, 0, "a changed step sequence is not a new flow");
  assert.equal(summary.flows.removed.length, 0);
  assert.equal(summary.flows.stepsChanged, 1);
  assert.equal(summary.flows.statusChanged[0]!.reason, "STEPS_CHANGED");
});

test("many flows sharing one signature never invent status changes", () => {
  // A real crawl can contain near-duplicate flows. Pairing them one-to-one would
  // be arbitrary, and an arbitrary pairing manufactures transitions.
  const many = (status: string, count: number) => report({
    flowDiscovery: {
      ...report().flowDiscovery,
      // Every flow has the same category, start page and steps, so all of them
      // collapse onto one signature.
      flows: Array.from({ length: count }, (_, index) => flow({ flowId: `FLOW-${index}`, title: "Navigate" })),
      executions: Array.from({ length: count }, (_, index) => execution(status, { flowId: `FLOW-${index}` })),
    },
  });
  const summary = compare(many("PASS", 16), many("PASS", 16));
  assert.equal(summary.flows.statusChanged.length, 0, "identical evidence produces no transition");
  assert.equal(summary.flows.added.length, 0);
  assert.equal(summary.flows.removed.length, 0);
  assert.equal(summary.flows.unchanged.length, 1, "the whole group is one comparable signature");
  assert.equal(summary.flows.unchanged[0]!.count, 16, "and the group keeps its true size");

  // A real change inside the group is still reported, with a count.
  const changed = compare(many("BLOCKED", 16), many("PASS", 16));
  assert.equal(changed.flows.statusChanged.length, 1);
  assert.equal(changed.flows.statusChanged[0]!.transition, "PASS -> BLOCKED");
  assert.equal(changed.flows.statusChanged[0]!.count, 16);
});

test("a flow family that appears where none existed is reported as added", () => {
  const previous = report();
  const current = report({
    flowDiscovery: {
      ...report().flowDiscovery,
      flows: [...previous.flowDiscovery.flows, flow({ flowId: "FLOW-002", category: "SEARCH", title: "Site search", steps: [{ action: "type", target: "term" }] })],
      executions: [...previous.flowDiscovery.executions, execution("PASS", { flowId: "FLOW-002" })],
    },
  });
  const summary = compare(current, previous);
  assert.equal(summary.flows.added.length, 1);
  assert.equal(summary.flows.added[0]!.title, "Site search");
  assert.equal(summary.flows.added[0]!.count, 1);
});

// ---------------------------------------------------------------------------
// Verification and coverage
// ---------------------------------------------------------------------------

test("a skipped verification is counted as skipped and never as a pass", () => {
  const counts = verificationCountsOf(report());
  assert.equal(counts.scheduled, 2);
  assert.equal(counts.executed, 2);
  assert.equal(counts.reproduced, 0);
  assert.equal(counts.notReproduced, 2);
  assert.equal(counts.skipped, 3, "the three recorded skip guards are summed");
  assert.equal(counts.unverified, 3);
  assert.equal(counts.infrastructureProblems, 0);
});

test("infrastructure failures are counted separately from anything the website did", () => {
  const counts = verificationCountsOf(report({
    flowDiscovery: { ...report().flowDiscovery, executions: [execution("INFRASTRUCTURE_PROBLEM", { failureCategory: "INFRASTRUCTURE" })] },
  }));
  assert.equal(counts.infrastructureFailures, 1, "a runner timeout is an infrastructure failure");
  assert.equal(counts.reproduced, 0, "and it is never a reproduced website defect");
});

test("a report that recorded no summary measures nothing, rather than zero", () => {
  // No summary block and no run-execution block: the summary-derived measures
  // were never recorded, so they are null and not zero.
  const unrecorded = verificationCountsOf(report({ summary: null, execution: null }));
  for (const key of ["scheduled", "executed", "reproduced", "notReproduced", "reviewRequired", "unverified", "infrastructureProblems"] as const) {
    assert.equal(unrecorded[key], null, `${key} was never recorded, so it is null`);
  }

  // The run-execution block is itself a record of skips, so it is read rather
  // than discarded just because the summary is missing.
  const executionOnly = verificationCountsOf(report({ summary: null }));
  assert.equal(executionOnly.skipped, 3, "the skip count the execution block recorded");
  assert.equal(executionOnly.scheduled, null, "a measure the execution block does not record stays null");
  assert.equal(executionOnly.reproduced, null);

  // Skips are summed across the three recorded guards, and never folded into a
  // pass: 1 unsupported + 2 locator-guard + 0 safety.
  assert.equal(verificationCountsOf(report()).skipped, 3);
});

test("coverage deltas are the recorded difference, and are null when a side is missing", () => {
  const previous = report({
    generatedAt: "2026-09-28T10:00:00.000Z",
    coverage: {
      ...report().coverage,
      summary: {
        ...report().coverage.summary,
        pages: { discovered: 2, tested: 1, partial: 1, untested: 0, blocked: 0, review: 0 },
        interactions: { tested: 2, partial: 1, untested: 1, review: 0, notApplicable: 0 },
      },
    },
  });
  const summary = compare(report(), previous);
  assert.equal(summary.coverage.delta.pagesTested, 1, "2 tested now against 1 before");
  assert.equal(summary.coverage.delta.pagesPartial, -1);
  assert.equal(summary.coverage.delta.interactionsTested, 2);
  assert.equal(summary.coverage.current.pagesTested, 2);
  assert.equal(summary.coverage.previous.pagesTested, 1);

  const noPreviousCoverage = compare(report(), report({ generatedAt: "2026-09-28T10:00:00.000Z", coverage: null }));
  assert.equal(noPreviousCoverage.coverage.previous.pagesTested, null);
  assert.equal(noPreviousCoverage.coverage.delta.pagesTested, null, "no delta without a baseline");
});

// ---------------------------------------------------------------------------
// Findings and existing historical intelligence
// ---------------------------------------------------------------------------

test("finding changes are read from the recorded lifecycle, never re-derived", () => {
  const previous = report();
  const current = report({ generatedAt: "2026-09-29T11:00:00.000Z" });
  const { snapshot } = snapshotFor(current, previous);
  const summary = compare(current, previous, snapshot);

  assert.equal(summary.findings.available, true);
  assert.equal(summary.findings.reason, null);
  // Both runs report the same (empty) finding set, so nothing is claimed.
  assert.equal(summary.findings.new.length, 0);
  assert.equal(summary.findings.resolved.length, 0);
});

test("a run with no recorded snapshot reports finding changes as unavailable", () => {
  const previous = report();
  const current = report({ generatedAt: "2026-09-29T11:00:00.000Z" });
  const summary = compare(current, previous, null);
  assert.equal(summary.findings.available, false);
  assert.equal(summary.findings.reason, "INSUFFICIENT_EVIDENCE");
  assert.match(summary.findings.note!, /no recorded project finding snapshot/);
  // The other dimensions are unaffected: they come from the artifacts.
  assert.equal(summary.pages.available, true);
});

test("existing historical intelligence is exposed as recorded, never recalculated", () => {
  const previous = report();
  // The flow that is new in the current run, and whose family therefore has to
  // be looked up in the existing historical record.
  const newFlow = flow({ flowId: "FLOW-002", category: "SEARCH", title: "Site search", startUrl: `${SITE}/search` });
  // The family key is the existing module's own key, read from the fixture
  // rather than retyped, so this test cannot drift from the identity code.
  const familyKey = flowFamilyKey(newFlow as any);
  const current = report({
    generatedAt: "2026-09-29T11:00:00.000Z",
    flowDiscovery: {
      ...report().flowDiscovery,
      flows: [report().flowDiscovery.flows[0], newFlow],
    },
    historicalIntelligence: {
      status: "AVAILABLE",
      schemaVersion: 1,
      generatedAt: "2026-09-29T11:00:00.000Z",
      summary: {},
      findings: [{ key: "LNK|https://qa.test/docs", lifecycle: "UNCHANGED", confidence: "HIGH", runIds: ["r1", "r2"], firstSeenRunId: "r1", lastSeenRunId: "r2" }],
      flows: [{ familyKey, stability: "STABLE", confidence: "HIGH", runIds: ["r1", "r2"] }],
      coverage: [],
      infrastructure: [],
    },
  });
  const summary = compare(current, previous);
  assert.equal(summary.history.status, "AVAILABLE");
  assert.equal(summary.flows.added.length, 1, "the new flow is a real addition");
  // The reference is attached verbatim from the existing record.
  assert.deepEqual(summary.history.flowReferences[familyKey], {
    stability: "STABLE", confidence: "HIGH", runIds: ["r1", "r2"],
  });
  // And a family with no recorded intelligence simply has no reference: the
  // layer does not invent one.
  assert.deepEqual(Object.keys(summary.history.flowReferences), [familyKey]);
});

// ---------------------------------------------------------------------------
// Compact record
// ---------------------------------------------------------------------------

test("the compact highlights are deduplicated, sorted, and describe differences only", () => {
  const previous = report();
  const summary = compare(report(), previous);
  const lines = highlightsOf(summary);
  assert.deepEqual(lines, [...lines].sort(), "highlight lines are in a stable order");
  assert.equal(lines.some(line => /better|worse|improv/i.test(line)), false, "a difference is not a verdict");
  assert.equal(new Set(lines).size, lines.length, "repeated lines collapse");

  // With nothing changed, the highlights are empty, which is what lets the UI
  // state that no material changes were detected.
  assert.equal(lines.length, 0);
});

// ---------------------------------------------------------------------------
// HTTP: the real endpoints
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; args: string[]; exitCode: number | null };

const fakeSpawner = () => {
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

const settle = (child: FakeChild, fixture: unknown): string => {
  const index = child.args.indexOf("--output");
  const output = child.args[index + 1]!;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(fixture), "utf8");
  child.exitCode = 0;
  child.emit("close", 0);
  return output;
};

const start = async (dir: string, spawnImpl: typeof import("node:child_process").spawn) => {
  const dash = await startDashboard({
    reportDir: dir, historyDir: join(dir, "history"), host: "127.0.0.1", port: 0,
    pagePath: join(process.cwd(), "src", "dashboard", "index.html"), projectRoot: process.cwd(), spawnImpl,
  });
  return { dash, base: `http://127.0.0.1:${dash.port}` };
};

const stop = async (dash: Awaited<ReturnType<typeof startDashboard>>): Promise<void> => {
  const server = dash.server as unknown as import("node:http").Server;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
};

const getJson = async (url: string) => {
  const res = await fetch(url);
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const postJson = async (url: string, body: unknown = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: any = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

const waitFor = async (check: () => boolean, ms = 4000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for the run to settle");
};

test("two real project runs produce a change summary over HTTP, and the old endpoint still answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-change-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Changes", url: `${SITE}/` });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const projectId = created.json.project.id as string;

    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    settle(children[0]!, report({ generatedAt: "2026-09-29T10:00:00.000Z" }));
    await waitFor(() => children[0]!.exitCode !== null);

    const firstRunId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;
    const first = await getJson(`${base}/api/projects/${projectId}/runs/${firstRunId}/change-summary`);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.ok, true);
    assert.equal(first.json.changeSummary.reason, "NO_PREVIOUS_RUN", "the first run has nothing to compare against");
    assert.equal(first.json.changeSummary.comparisonAvailable, false);

    // A second run, in which a page and a flow appear.
    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 2);
    const second = report({
      generatedAt: "2026-09-29T11:00:00.000Z",
      flowDiscovery: {
        ...report().flowDiscovery,
        graph: { sourceUrl: SITE, pages: [pageNode(PRICING, "Pricing"), pageNode(`${SITE}/docs`, "Docs"), pageNode(`${SITE}/news`, "News")] },
        flows: [report().flowDiscovery.flows[0], flow({ flowId: "FLOW-002", category: "SEARCH", title: "Site search", steps: [{ action: "type", target: "term" }] })],
        executions: [execution("PASS"), execution("BLOCKED", { flowId: "FLOW-002", failureCategory: "SAFETY_BLOCK" })],
      },
    });
    settle(children[1]!, second);
    await waitFor(() => children[1]!.exitCode !== null);

    const secondRunId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;
    const summary = await getJson(`${base}/api/projects/${projectId}/runs/${secondRunId}/change-summary`);
    assert.equal(summary.status, 200, JSON.stringify(summary.json));
    const change = summary.json.changeSummary;
    assert.equal(change.availability, "AVAILABLE");
    assert.equal(change.previousRunId, firstRunId, "the predecessor is the run before it, by persisted completion time");
    assert.deepEqual(change.pages.added.map((page: any) => page.url), [`${SITE}/news`]);
    assert.equal(change.flows.added.length, 1);
    assert.equal(change.flows.added[0].title, "Site search");
    assert.equal(change.pages.available, true);
    assert.equal(change.verification.available, true);

    // The existing findings endpoint is untouched by this feature.
    const legacy = await getJson(`${base}/api/projects/${projectId}/runs/${secondRunId}/comparison`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.json.comparison.comparisonAvailable, true);

    // The Results Experience carries the comparison, and the project page the
    // compact record for the history columns.
    const results = await getJson(`${base}/api/qa/runs/${secondRunId}/results`);
    assert.equal(results.json.projectId, projectId);
    assert.equal(results.json.whatChanged.availability, "AVAILABLE");

    const project = await getJson(`${base}/api/projects/${projectId}`);
    assert.equal(project.json.changes.length, 2, "one recorded comparison per settled run");
    const latest = project.json.changes[0];
    assert.equal(latest.currentRunId, secondRunId, "newest first");
    assert.equal(latest.pagesAdded, 1);
    assert.equal(latest.flowsAdded, 1);
    assert.ok(Array.isArray(latest.highlights));
    assert.ok(latest.highlights.some((line: string) => line.includes("1 page added")));

    // A run id that does not belong to the project is a 404, not a guess.
    const foreign = await getJson(`${base}/api/projects/${projectId}/runs/web-does-not-exist/change-summary`);
    assert.equal(foreign.status, 404);
  } finally {
    await stop(dash);
  }
});

test("a standalone run gets no comparison at all, rather than an empty one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-change-standalone-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    // The standalone start endpoint is /api/qa/run and answers 202 with the
    // run it started; /api/qa/runs is the read-only list.
    const started = await postJson(`${base}/api/qa/run`, { url: `${SITE}/` });
    assert.equal(started.status, 202, JSON.stringify(started.json));
    const runId = started.json.run.runId as string;
    await waitFor(() => children.length === 1);
    settle(children[0]!, report());
    await waitFor(() => children[0]!.exitCode !== null);

    const results = await getJson(`${base}/api/qa/runs/${runId}/results`);
    assert.equal(results.status, 200);
    assert.equal(results.json.projectId, null);
    assert.equal(results.json.whatChanged, null, "no project means no invented comparison");
    assert.equal(results.json.findingsChanges, null);
  } finally {
    await stop(dash);
  }
});

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

test("the console shows What Changed, Latest Changes, and the honest empty state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-change-ui-"));
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const page = await (await fetch(`${base}/projects`)).text();

    // The primary section on a project run's Results Experience.
    assert.match(page, /function renderWhatChanged\(summary, run, projectId\)/);
    assert.match(page, /if \(whatChanged\) panel\.appendChild\(renderWhatChanged\(whatChanged, run, projectId\)\)/, "no comparison means no section at all");
    assert.match(page, /section\("What Changed", "what-changed"/);

    // The exact wording required when nothing material changed.
    assert.match(page, /No material changes detected between the comparable runs\./);

    // The exact machine-readable reasons, surfaced rather than hidden.
    for (const reason of ["NO_PREVIOUS_RUN", "PREVIOUS_RUN_INCOMPLETE", "CURRENT_RUN_INCOMPLETE", "ACCESS_BOUNDARY", "INSUFFICIENT_EVIDENCE"]) {
      assert.ok(page.includes(reason), `the console states ${reason}`);
    }
    assert.match(page, /const CHANGE_REASON_TEXT = \{/, "the reason wording lives in one place");

    // The project page's compact section and its full-comparison action.
    assert.match(page, /card\("Latest Changes"\)/);
    assert.match(page, /"View full comparison"/);
    assert.match(page, /viewFull\.addEventListener\("click", \(\) => openHistoricalRun\(latestChange\.currentRunId, runPanel, resultPanel\)\)/, "View full comparison opens the complete change summary for that run");

    // Run history gained the page and flow columns.
    assert.match(page, /\["Date", "Status", "Findings", "New", "Resolved", "Regressed", "Active", "Pages", "Flows", "Coverage", "Run"\]/);
    assert.match(page, /const changeAvailable = Boolean\(change && \(change\.availability === "AVAILABLE" \|\| change\.availability === "PARTIAL"\)\)/, "change columns are blank unless a valid comparison exists");

    // The comparison JSON stays reachable.
    assert.match(page, /\/change-summary", "Change summary JSON"/);

    // Still no score anywhere in the console.
    assert.doesNotMatch(page, /healthScore|qualityScore|overallScore|findingScore|riskScore|stabilityScore/);
  } finally {
    await stop(dash);
  }
});

test("run-to-run change intelligence stays out of the QA engine and the exit contract", () => {
  // The comparison is a reporting layer over artifacts the engine already
  // wrote. Importing it must not change how QA is executed or gated.
  const gate = readFileSync(join(process.cwd(), "src", "qa", "ci-contract.ts"), "utf8");
  assert.doesNotMatch(gate, /run-comparison/, "the gate must not depend on the change comparison");
  const engine = readFileSync(join(process.cwd(), "src", "ai", "types.ts"), "utf8");
  assert.doesNotMatch(engine, /run-comparison/, "the analysis schema must not depend on the change comparison");
  // And the comparison layer must not reach into the engine.
  const comparison = readFileSync(join(process.cwd(), "src", "dashboard", "run-comparison.ts"), "utf8");
  assert.doesNotMatch(comparison, /node:fs|node:path|child_process/, "comparison is pure: it reads artifacts handed to it, never the disk");
});

// ---------------------------------------------------------------------------
// The compact record
// ---------------------------------------------------------------------------

test("the persisted record carries the same highlights the console shows", () => {
  const summary = compare(report(), report({ generatedAt: "2026-09-28T10:00:00.000Z" }));
  const record = changeRecordOf(summary);
  assert.deepEqual(record.highlights, highlightsOf(summary), "one wording, computed once");
  assert.equal(record.currentRunId, "web-run-2");
  assert.equal(record.availability, "AVAILABLE");
  // A record must never contain a clock reading: the same pair of runs has to
  // produce a byte-identical record every time.
  assert.equal(Object.keys(record).some(key => /at$|time|date/i.test(key)), false, "no timestamp is recorded");
  assert.deepEqual(changeRecordOf(compare(report(), report({ generatedAt: "2026-09-28T10:00:00.000Z" }))), record);
});
