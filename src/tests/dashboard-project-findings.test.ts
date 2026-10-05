import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyRunToLedger,
  assessRunEvidence,
  compareRunAnalyses,
  emptyFindingCounts,
  emptyLedger,
  findingMatchesSearch,
  historicalStateOf,
  projectFindingIdOf,
  sameOrigin,
  type ProjectFinding,
  type ProjectFindingLedger,
} from "../dashboard/project-findings.js";
import { startDashboard } from "../dashboard/server.js";

// ---------------------------------------------------------------------------
// Fixtures: minimal real-shaped reports, so every claim below comes from the
// same structures the engine writes.
// ---------------------------------------------------------------------------

const PRICING = "https://qa.test/pricing";

/** A real discovered element, so finding identity is anchored to the element
 *  itself rather than to the wording of a title. */
const buttonElement = (overrides: Record<string, unknown> = {}) => ({
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

const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  // Element-anchored evidence: this is what makes identity semantic. A
  // regenerated element id or a reworded title does not change it.
  evidence: [{ type: "element", index: 0, locator: "button[type=submit]", tag: "button" }],
  ...overrides,
});

/** A second, different problem on the same page. */
const labelFinding = (overrides: Record<string, unknown> = {}) => finding({
  id: "QA-F-002",
  code: "FORM",
  title: "Input has no label",
  description: "The email input has no associated label.",
  evidence: [{ type: "element", index: 1, locator: "input#email", tag: "input" }],
  ...overrides,
});

/** A real coverage item, in the shape the engine writes. */
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

/** A report with a coverage map that says the pricing page was genuinely tested. */
const analysisWith = (findingsList: unknown[], overrides: Record<string, unknown> = {}) => ({
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
      coverageItem({ relatedFindings: findingsList.map((item: any) => item.id) }),
      coverageItem({ coverageId: "COV-PAGE-002", name: "Home", url: "https://qa.test/home", pageId: "PAGE-002" }),
    ],
    testPlan: [],
    aiNotes: { gaps: [] },
  },
  flowDiscovery: { limits: {}, graph: { pages: [] }, flows: [], executions: [], summary: { pages: 2, flows: 1, executable: 1, review: 0, highRisk: 0, blocked: 0, steps: 2, executed: 1, passed: 0, reproduced: 1, notReproduced: 0, reviewRequired: 0, infrastructure: 0 } },
  summary: { overallStatus: "FAIL", headline: "problems", issueCount: findingsList.length, flowsDetected: 1, scheduled: 1, executed: 1, reproduced: findingsList.length, notReproduced: 0, pass: 0, reviewRequired: 0, infrastructureProblems: 0, unverified: 0, bySeverity: { CRITICAL: 0, HIGH: findingsList.length, MEDIUM: 0, LOW: 0, INFO: 0 } },
  history: { status: "AVAILABLE", currentRunId: "hist-1", runsAvailable: 1 },
  execution: { status: "FAIL", tests: 1, passed: 0, failed: 1, skipped: 0, failures: [] },
  verifications: [],
  ...overrides,
}) as any;

const run = (ledger: ProjectFindingLedger, current: any, previous: any, previousRunId: string | null = "web-run-1", runId = "web-run-2") =>
  applyRunToLedger({ projectId: "prj-1", runId, analysis: current, ledger, previousAnalysis: previous, previousRunId });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("a finding keeps the same project identity across runs, restarts and machines", () => {
  const a = projectFindingIdOf("prj-1", "BTN|https://qa.test/pricing|btn#submit");
  const b = projectFindingIdOf("prj-1", "BTN|https://qa.test/pricing|btn#submit");
  assert.equal(a, b, "the same project and fingerprint always produce the same id");
  assert.notEqual(a, projectFindingIdOf("prj-2", "BTN|https://qa.test/pricing|btn#submit"), "another project never shares the id");
  assert.match(a, /^prj-fnd-[0-9a-f]{16}$/);
});

test("identity is semantic, not run-local: renumbered findings keep their identity and order does not matter", () => {
  const firstFindings = [finding({ id: "QA-F-001" }), labelFinding({ id: "QA-F-002" })];
  const first = applyRunToLedger({
    projectId: "prj-1", runId: "web-run-1", analysis: analysisWith(firstFindings),
    ledger: emptyLedger(), previousAnalysis: null, previousRunId: null,
  });
  const second = applyRunToLedger({
    projectId: "prj-1", runId: "web-run-2",
    // The same two findings, new run-local ids, opposite array order, and a
    // regenerated DOM id on the element itself.
    analysis: analysisWith([labelFinding({ id: "QA-F-900" }), finding({ id: "QA-F-901" })], {
      scan: { scan: { url: PRICING, title: "Pricing" }, elements: [buttonElement({ id: "regenerated-77" }), buttonElement({ tag: "input", type: "email", name: "email", id: "email-88", recommendedLocator: "input#email", text: "" })] },
    }),
    ledger: first.ledger, previousAnalysis: analysisWith(firstFindings), previousRunId: "web-run-1",
  });
  const before = new Map(first.ledger.findings.map(item => [item.fingerprint, item.id]));
  for (const item of second.ledger.findings) {
    if (item.status === "RESOLVED") continue;
    assert.equal(item.id, before.get(item.fingerprint), "the project finding id survives renumbering and a regenerated element id");
  }
  assert.equal(second.snapshot.counts.new, 0, "nothing is new when only run-local ids and DOM ids changed");
  assert.equal(second.snapshot.counts.active, 2);
});

test("a reworded title is the same tracked finding, and the change is reported", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = applyRunToLedger({
    projectId: "prj-1", runId: "web-run-2",
    analysis: analysisWith([finding({ id: "QA-F-777", title: "Purchase button has no accessible name" })]),
    ledger: first.ledger, previousAnalysis: base, previousRunId: "web-run-1",
  });
  assert.equal(second.ledger.findings.length, 1, "a reworded title is still one tracked finding");
  assert.equal(second.ledger.findings[0]!.status, "ACTIVE");
  assert.equal(second.ledger.findings[0]!.title, "Purchase button has no accessible name", "the latest wording is kept");
  assert.equal(second.snapshot.counts.changed, 1, "the reworded detail is reported as changed");
  assert.equal(second.snapshot.counts.unchanged, 0);
});

test("a genuinely different problem on the same page is a separate tracked finding", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = applyRunToLedger({
    projectId: "prj-1", runId: "web-run-2",
    analysis: analysisWith([labelFinding({ id: "QA-F-002" })]),
    ledger: first.ledger, previousAnalysis: base, previousRunId: "web-run-1",
  });
  assert.equal(second.ledger.findings.length, 2);
  assert.equal(second.snapshot.counts.new, 1, "the second problem is new, not a rename");
  assert.equal(second.snapshot.counts.resolved, 1, "the first problem's page was re-tested, so it is resolved");
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("the first run records every finding as new and offers no comparison", () => {
  const result = applyRunToLedger({
    projectId: "prj-1", runId: "web-run-1", analysis: analysisWith([finding()]),
    ledger: emptyLedger(), previousAnalysis: null, previousRunId: null,
  });
  assert.equal(result.ledger.findings[0]!.status, "NEW");
  assert.equal(result.snapshot.counts.new, 1);
  assert.equal(result.snapshot.comparisonAvailable, false, "there is nothing to compare against yet");
  assert.match(result.snapshot.comparisonReason!, /no earlier completed run/);
  assert.equal(result.ledger.findings[0]!.firstSeenRunId, "web-run-1");
  assert.equal(result.ledger.findings[0]!.lastSeenRunId, "web-run-1");
  assert.equal(result.ledger.findings[0]!.occurrenceCount, 1);
});

test("a finding seen in two runs becomes active, not new again", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = run(first.ledger, analysisWith([finding()]), base);
  assert.equal(second.ledger.findings[0]!.status, "ACTIVE");
  assert.equal(second.snapshot.counts.active, 1);
  assert.equal(second.snapshot.counts.new, 0);
  assert.equal(second.snapshot.comparisonAvailable, true);
  assert.equal(second.ledger.findings[0]!.firstSeenRunId, "web-run-1", "first seen is not rewritten");
  assert.equal(second.ledger.findings[0]!.lastSeenRunId, "web-run-2");
  assert.equal(second.ledger.findings[0]!.occurrenceCount, 2);
});

test("a finding that disappears while its page is re-tested becomes resolved", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = run(first.ledger, analysisWith([]), base);
  assert.equal(second.ledger.findings[0]!.status, "RESOLVED");
  assert.equal(second.snapshot.counts.resolved, 1);
  assert.equal(second.ledger.findings[0]!.lastResolvedRunId, "web-run-2");
  assert.equal(second.ledger.findings[0]!.certainty, "CONFIRMED");
});

test("a finding that comes back after being resolved is regressed, with a count", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = run(first.ledger, analysisWith([]), base);
  const third = run(second.ledger, analysisWith([finding()]), analysisWith([]));
  assert.equal(third.ledger.findings[0]!.status, "REGRESSED");
  assert.equal(third.ledger.findings[0]!.regressionCount, 1);
  assert.equal(third.snapshot.counts.regressed, 1);
  assert.equal(third.ledger.findings[0]!.firstSeenRunId, "web-run-1", "the original first sighting is kept");
});

test("a regressed finding that persists becomes active again", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = run(first.ledger, analysisWith([]), base);
  const third = run(second.ledger, analysisWith([finding()]), analysisWith([]));
  const fourth = run(third.ledger, analysisWith([finding()]), analysisWith([finding()]));
  assert.equal(fourth.ledger.findings[0]!.status, "ACTIVE");
  assert.equal(fourth.ledger.findings[0]!.regressionCount, 1, "persisting does not inflate the regression count");
  assert.equal(fourth.snapshot.counts.regressed, 0);
});

test("the lifecycle states map onto the existing historical vocabulary", () => {
  assert.equal(historicalStateOf("NEW"), "NEW");
  assert.equal(historicalStateOf("ACTIVE"), "PERSISTING");
  assert.equal(historicalStateOf("REGRESSED"), "REAPPEARED");
  assert.equal(historicalStateOf("RESOLVED"), "DISAPPEARED");
});

test("each finding's history is inspectable run by run", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = run(first.ledger, analysisWith([finding()]), base);
  const third = run(second.ledger, analysisWith([]), analysisWith([finding()]), "web-run-2", "web-run-3");
  const events = third.ledger.events.filter(event => event.findingId === third.ledger.findings[0]!.id);
  assert.deepEqual(events.map(event => `${event.runId}:${event.status}`), [
    "web-run-1:NEW",
    "web-run-2:ACTIVE",
    "web-run-3:RESOLVED",
  ], "the history is the recorded sequence of what happened, in order");
  assert.equal(events[0]!.runFindingId, "QA-F-001", "observed events keep the run-local reference for evidence");
  assert.equal(events[2]!.observed, false);
});

// ---------------------------------------------------------------------------
// Uncertainty — the rule that a missing finding is not a fix
// ---------------------------------------------------------------------------

test("a blocked run resolves nothing and records why", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const blocked = analysisWith([], { accessPrerequisite: { status: "BLOCKED", reason: "robots deny", details: [] } });
  const second = run(first.ledger, blocked, base);
  assert.notEqual(second.ledger.findings[0]!.status, "RESOLVED", "a blocked run reports no fix at all");
  assert.equal(second.snapshot.counts.resolved, 0);
  assert.equal(second.ledger.findings[0]!.certainty, "ABSENCE_UNVERIFIED");
  assert.match(second.ledger.findings[0]!.reviewNote!, /could not access the site/);
  assert.equal(second.snapshot.comparisonAvailable, false, "a blocked run is not compared against an earlier run");
  assert.equal(second.snapshot.resolutionTrustworthy, false);
});

test("an authentication-walled run resolves nothing", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const walled = analysisWith([], { accessPrerequisite: { status: "REVIEW_REQUIRED", reason: "login required", details: [] } });
  const second = run(first.ledger, walled, base);
  assert.notEqual(second.ledger.findings[0]!.status, "RESOLVED");
  assert.match(second.ledger.findings[0]!.reviewNote!, /required review/);
  assert.equal(second.snapshot.counts.resolved, 0);
});

test("a run with an infrastructure failure resolves nothing", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const broken = analysisWith([], { summary: { ...analysisWith([]).summary, infrastructureProblems: 2 } });
  const second = run(first.ledger, broken, base);
  assert.notEqual(second.ledger.findings[0]!.status, "RESOLVED");
  assert.match(second.ledger.findings[0]!.reviewNote!, /infrastructure/);
});

test("a run that tested nothing resolves nothing", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const empty = analysisWith([], { coverage: { ...analysisWith([]).coverage, summary: { ...analysisWith([]).coverage.summary, pages: { discovered: 2, tested: 0, partial: 0, untested: 2, blocked: 0, review: 0 } } } });  const second = run(first.ledger, empty, base);
  assert.notEqual(second.ledger.findings[0]!.status, "RESOLVED");
  assert.match(second.ledger.findings[0]!.reviewNote!, /no page was meaningfully tested/);
  assert.equal(assessRunEvidence(empty).resolutionTrustworthy, false);
});

test("a page that was not re-tested cannot resolve the finding that lived there", () => {
  const base = analysisWith([finding()]);
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: base, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  // The run is healthy, but only the home page was exercised; pricing was not.
  const partial = analysisWith([], { coverage: { ...analysisWith([]).coverage, items: [coverageItem({ coverageId: "COV-PAGE-002", name: "Home", url: "https://qa.test/home", pageId: "PAGE-002" })] } });
  const second = run(first.ledger, partial, base);
  assert.notEqual(second.ledger.findings[0]!.status, "RESOLVED", "absence on an untested page is not a fix");
  assert.equal(second.ledger.findings[0]!.certainty, "ABSENCE_UNVERIFIED");
  assert.match(second.ledger.findings[0]!.reviewNote!, /not meaningfully re-tested/);
  assert.equal(second.snapshot.counts.resolved, 0);
});

test("an untrustworthy run is still recorded, and says so instead of claiming a comparison", () => {
  const blocked = analysisWith([finding()], { accessPrerequisite: { status: "BLOCKED", reason: "robots deny", details: [] } });
  const result = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: blocked, ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  assert.equal(result.snapshot.resolutionTrustworthy, false);
  assert.equal(result.snapshot.comparisonAvailable, false);
  assert.match(result.snapshot.resolutionReason!, /could not access the site/);
  assert.equal(result.snapshot.counts.new, 0, "a run that could not access the site counts no changes");
  assert.equal(result.ledger.findings.length, 1, "but the sighting itself is still tracked");
  assert.equal(result.ledger.findings[0]!.status, "NEW");

  // A finding already known to the project keeps its status when a later run
  // cannot be compared, and the finding itself says why.
  const known = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: analysisWith([finding()]), ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const later = applyRunToLedger({
    projectId: "prj-1", runId: "web-run-2",
    analysis: analysisWith([finding({ id: "QA-F-050" })], { generatedAt: "2026-09-29T12:00:00.000Z", accessPrerequisite: { status: "REVIEW_REQUIRED", reason: "login", details: [] } }),
    ledger: known.ledger, previousAnalysis: analysisWith([finding()]), previousRunId: "web-run-1",
  });
  assert.equal(later.ledger.findings[0]!.status, "NEW", "the recorded status stands unchanged");
  assert.match(later.ledger.findings[0]!.reviewNote!, /could not be compared/);
  assert.equal(later.ledger.findings[0]!.occurrenceCount, 1, "an uncomparable run does not add an occurrence");
});

// ---------------------------------------------------------------------------
// Comparability
// ---------------------------------------------------------------------------

test("a project's first run has nothing to compare against, and says so", () => {
  const result = compareRunAnalyses(analysisWith([]), null);
  assert.equal(result.comparable, false);
  assert.match(result.reason!, /no earlier completed run/);
});

test("runs from different origins are never compared", () => {
  const here = analysisWith([finding()]);
  const elsewhere = analysisWith([finding()], { scan: { scan: { url: "https://other.test/en", title: "Other" } } });
  const result = compareRunAnalyses(here, elsewhere);
  assert.equal(result.comparable, false);
  assert.equal(sameOrigin(here, elsewhere), false);
  assert.equal(sameOrigin(here, analysisWith([finding()])), true);
});

test("the same project's runs are comparable", () => {
  const result = compareRunAnalyses(analysisWith([finding()]), analysisWith([]));
  assert.equal(result.comparable, true);
  assert.equal(result.reason, null);
});

test("a first run's counts are still recorded even though no comparison exists", () => {
  const result = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: analysisWith([finding()]), ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  assert.deepEqual(result.snapshot.counts, { new: 1, active: 0, regressed: 0, resolved: 0, unchanged: 0, changed: 0 });
  assert.deepEqual(emptyFindingCounts(), { new: 0, active: 0, regressed: 0, resolved: 0, unchanged: 0, changed: 0 });
});

test("the snapshot records which findings fell into which outcome, so it can be served as recorded", () => {
  const firstFindings = [finding(), labelFinding()];
  const first = applyRunToLedger({ projectId: "prj-1", runId: "web-run-1", analysis: analysisWith(firstFindings), ledger: emptyLedger(), previousAnalysis: null, previousRunId: null });
  const second = run(first.ledger, analysisWith([finding({ id: "QA-F-050" })]), analysisWith(firstFindings));
  assert.equal(second.snapshot.refs.resolved.length, 1, "the absent finding has an outcome in this run");
  assert.equal(second.snapshot.refs.active.length, 1, "and so does the one that is still there");
  assert.equal(second.snapshot.refs.resolved[0], first.ledger.findings.find(item => item.code === "FORM")!.id);
  assert.deepEqual([...second.snapshot.refs.resolved], [...second.snapshot.refs.resolved].sort(), "grouped ids are ordered, never insertion-ordered");
  assert.equal(second.snapshot.counts.resolved, 1);
  assert.equal(second.snapshot.counts.active, 1);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("finding search matches title, code and page", () => {
  const item: ProjectFinding = {
    id: "prj-fnd-1", projectId: "prj-1", fingerprint: "f", family: "f", page: "https://qa.test/pricing",
    title: "Button lacks an accessible name", code: "BTN", domain: "Accessibility", severity: "HIGH",
    firstSeenRunId: "web-run-1", firstSeenAt: "2026-09-29T10:00:00.000Z", lastSeenRunId: "web-run-1", lastSeenAt: "2026-09-29T10:00:00.000Z",
    occurrenceCount: 1, status: "NEW", certainty: "CONFIRMED", reviewNote: null, lastResolvedRunId: null, lastResolvedAt: null, regressionCount: 0,
  };
  assert.equal(findingMatchesSearch(item, "accessible"), true);
  assert.equal(findingMatchesSearch(item, "btn"), true);
  assert.equal(findingMatchesSearch(item, "pricing"), true);
  assert.equal(findingMatchesSearch(item, "checkout"), false);
  assert.equal(findingMatchesSearch(item, ""), true, "an empty filter matches everything");
});

// ---------------------------------------------------------------------------
// The store and the API over real HTTP
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

test("two project runs produce a real NEW -> ACTIVE history over HTTP, and the API serves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Lifecycle", url: "https://qa.test/" });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const projectId = created.json.project.id as string;

    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    settle(children[0]!, analysisWith([finding()], { generatedAt: "2026-09-29T10:00:00.000Z" }));
    await waitFor(() => children[0]!.exitCode !== null);

    // The first run has nothing to compare against.
    const firstRunId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;
    const first = await getJson(`${base}/api/projects/${projectId}/runs/${firstRunId}/comparison`);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.comparison.comparisonAvailable, false);
    assert.match(first.json.comparison.reason, /no earlier completed run/);
    assert.equal(first.json.comparison.counts.new, 1, "the run's own counts are still recorded");
    assert.equal(first.json.comparison.counts.resolved, 0);

    // The tracked finding exists after the first run.
    const listed = await getJson(`${base}/api/projects/${projectId}/findings`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.findings.length, 1);
    assert.equal(listed.json.findings[0].status, "NEW");
    assert.equal(listed.json.countsByStatus.NEW, 1);

    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 2);
    settle(children[1]!, analysisWith([finding({ id: "QA-F-042" })], { generatedAt: "2026-09-29T11:00:00.000Z" }));
    await waitFor(() => children[1]!.exitCode !== null);

    const secondRunId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;
    const second = await getJson(`${base}/api/projects/${projectId}/runs/${secondRunId}/comparison`);
    assert.equal(second.json.comparison.comparisonAvailable, true, JSON.stringify(second.json));
    assert.equal(second.json.comparison.counts.active, 1);
    assert.equal(second.json.comparison.counts.new, 0);
    assert.equal(second.json.comparison.active.length, 1);
    assert.equal(second.json.comparison.active[0].runFindingId, "QA-F-042", "the entry links to the run-local evidence");
    assert.equal(second.json.comparison.active[0].title, "Button lacks an accessible name");

    // Detail and history are inspectable.
    const findingId = second.json.comparison.active[0].id as string;
    const detail = await getJson(`${base}/api/projects/${projectId}/findings/${findingId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json.finding.status, "ACTIVE");
    assert.equal(detail.json.finding.firstSeenRunId, firstRunId);
    assert.equal(detail.json.finding.lastSeenRunId, secondRunId);
    assert.equal(detail.json.evidenceReferences.runFindingId, "QA-F-042");
    assert.equal(detail.json.history.length, 2);

    const history = await getJson(`${base}/api/projects/${projectId}/findings/${findingId}/history`);
    assert.equal(history.status, 200);
    assert.deepEqual(history.json.events.map((event: any) => event.status), ["NEW", "ACTIVE"], "chronological, oldest first");

    // The Results Experience carries the comparison only for this project run.
    const results = await getJson(`${base}/api/qa/runs/${secondRunId}/results`);
    assert.equal(results.json.projectId, projectId);
    assert.equal(results.json.findingsChanges.comparisonAvailable, true);
  } finally {
    await stop(dash);
  }
});

test("a finding list can be filtered by status, severity and search", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-filter-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Filter", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    settle(children[0]!, analysisWith([
      finding({ id: "QA-F-001" }),
      finding({ id: "QA-F-002", code: "LNK", severity: "LOW", title: "Link text is empty" }),
    ]));
    await waitFor(() => children[0]!.exitCode !== null);

    const all = await getJson(`${base}/api/projects/${projectId}/findings`);
    assert.equal(all.json.total, 2);
    const bySeverity = await getJson(`${base}/api/projects/${projectId}/findings?severity=HIGH`);
    assert.equal(bySeverity.json.total, 1);
    assert.equal(bySeverity.json.findings[0].severity, "HIGH");
    const bySearch = await getJson(`${base}/api/projects/${projectId}/findings?search=link%20text`);
    assert.equal(bySearch.json.total, 1);
    const byStatus = await getJson(`${base}/api/projects/${projectId}/findings?status=NEW`);
    assert.equal(byStatus.json.total, 2);
    const none = await getJson(`${base}/api/projects/${projectId}/findings?status=RESOLVED`);
    assert.equal(none.json.total, 0, "an empty bucket is empty, not unknown");
  } finally {
    await stop(dash);
  }
});

test("a blocked project run records its findings but resolves nothing and offers no comparison", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-blocked-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Blocked", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    settle(children[0]!, analysisWith([finding()]));
    await waitFor(() => children[0]!.exitCode !== null);

    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 2);
    settle(children[1]!, analysisWith([], { generatedAt: "2026-09-29T11:00:00.000Z", accessPrerequisite: { status: "BLOCKED", reason: "robots deny", details: [] } }));
    await waitFor(() => children[1]!.exitCode !== null);

    const runId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;
    const listed = await getJson(`${base}/api/projects/${projectId}/findings`);
    assert.equal(listed.json.findings.length, 1);
    assert.notEqual(listed.json.findings[0].status, "RESOLVED", "a blocked run never reports a fix");
    assert.equal(listed.json.findings[0].certainty, "ABSENCE_UNVERIFIED");
    assert.match(listed.json.findings[0].reviewNote, /could not access the site/);

    const comparison = await getJson(`${base}/api/projects/${projectId}/runs/${runId}/comparison`);
    assert.equal(comparison.json.comparison.comparisonAvailable, false);
    assert.equal(comparison.json.snapshot.resolutionTrustworthy, false);
    assert.deepEqual(comparison.json.comparison.counts.resolved, 0);
  } finally {
    await stop(dash);
  }
});

test("an old run with no recorded snapshot reports the comparison as unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-old-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Old", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    settle(children[0]!, analysisWith([finding()]));
    await waitFor(() => children[0]!.exitCode !== null);
    const runId = (await getJson(`${base}/api/projects/${projectId}`)).json.runs[0].runId as string;

    // A run that is not part of any project has no project comparison at all.
    const results = await getJson(`${base}/api/qa/runs/${runId}/results`);
    assert.equal(results.json.projectId, projectId);
    assert.equal(results.json.findingsChanges, null, "a first run shows no Findings Changes block rather than an empty one");
  } finally {
    await stop(dash);
  }
});

test("finding routes reject an unsafe project or finding id and a missing project is a 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-guard-"));
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const bad = await getJson(`${base}/api/projects/${encodeURIComponent("../secrets")}/findings`);
    assert.equal(bad.status, 400);
    const missing = await getJson(`${base}/api/projects/prj-does-not-exist/findings`);
    assert.equal(missing.status, 404);
    const badFinding = await getJson(`${base}/api/projects/prj-does-not-exist/findings/${encodeURIComponent("x/y")}`);
    assert.equal(badFinding.status, 400);
    const badComparison = await getJson(`${base}/api/projects/prj-x/runs/${encodeURIComponent("a/b")}/comparison`);
    assert.equal(badComparison.status, 400);
  } finally {
    await stop(dash);
  }
});

test("deleting a project removes its tracked findings too, and never any QA artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-delete-"));
  const { spawnImpl, children } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const created = await postJson(`${base}/api/projects`, { name: "Delete", url: "https://qa.test/" });
    const projectId = created.json.project.id as string;
    await postJson(`${base}/api/projects/${projectId}/runs`);
    await waitFor(() => children.length === 1);
    const output = settle(children[0]!, analysisWith([finding()]));
    await waitFor(() => children[0]!.exitCode !== null);

    const res = await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const gone = await getJson(`${base}/api/projects/${projectId}`);
    assert.equal(gone.status, 404);
    assert.ok(existsSync(output), "the QA artifact survives a project deletion");
  } finally {
    await stop(dash);
  }
});

// ---------------------------------------------------------------------------
// The console: rendered from recorded data, and never a score
// ---------------------------------------------------------------------------

test("the console renders Findings Changes only from a real comparison, and never a score", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-website-qa-findings-ui-"));
  const { spawnImpl } = fakeSpawner();
  const { dash, base } = await start(dir, spawnImpl);
  try {
    const page = await (await fetch(`${base}/projects`)).text();
    // The Results Experience gains a Findings Changes block, driven entirely by
    // whatever comparison the server recorded for that run.
    assert.match(page, /function renderFindingsChanges\(changes, run, projectId\)/);
    assert.match(page, /if \(changes\) panel\.appendChild\(renderFindingsChanges\(changes, run, projectId\)\)/, "no comparison means no block at all");
    assert.match(page, /const LIFECYCLE_LABEL = \{ NEW: "New", ACTIVE: "Still active", REGRESSED: "Regressed", RESOLVED: "Resolved" \}/);
    // Counts, not a score: there is no health number or ranking anywhere.
    assert.doesNotMatch(page, /healthScore|qualityScore|overallScore|findingScore/);
    // The project page keeps the lifecycle buckets and per-run columns. Run-to-run
    // change intelligence extends the history with Pages and Flows columns, which
    // show NOT_AVAILABLE unless a valid comparison was recorded.
    assert.match(page, /\["REGRESSED", "Regressed", "fail"\]/);
    assert.match(page, /for \(const heading of \["Date", "Status", "Findings", "New", "Resolved", "Regressed", "Active", "Pages", "Flows", "Coverage", "Run"\]\)/);
    assert.match(page, /\/api\/projects\/" \+ encodeURIComponent\(projectId\) \+ "\/findings"/, "the project page reads the real findings API");
    // A first run's columns are honest about having nothing to compare.
    assert.match(page, /if \(!available\) return NOT_AVAILABLE;/);
  } finally {
    await stop(dash);
  }
});

test("the project finding lifecycle is separate from the regression gate's policy decision", () => {
  // The gate still owns the CLI exit contract. A lifecycle regression is a
  // recorded fact about a finding, not a gate outcome, and importing the
  // project lifecycle must not change any exit code.
  const gateSource = readFileSync(join(process.cwd(), "src", "qa", "ci-contract.ts"), "utf8");
  assert.doesNotMatch(gateSource, /project-findings/, "the gate must not depend on project lifecycle");
  const contractSource = readFileSync(join(process.cwd(), "src", "qa", "ci-contract.ts"), "utf8");
  for (const code of ["0", "1", "2"]) assert.match(contractSource, new RegExp(`\\b${code}\\b`), `exit code ${code} is still part of the contract`);
  const findingsSource = readFileSync(join(process.cwd(), "src", "dashboard", "project-findings.ts"), "utf8");
  assert.doesNotMatch(findingsSource, /exitCode|process\.exit/, "project lifecycle never decides a process exit code");
});
