import { atomicWriteText } from "./atomic-write.js";
import { extname, resolve } from "node:path";
import { DiscoveredElement, GeneratedCounts, GeneratedScenario, GeneratedTestSuite, ScanReport, SourceElementSnapshot, TestCategory } from "./types.js";
import { escapeHtml, safeHref } from "./html-escape.js";

export const GENERATOR_NAME = "ai-website-qa";
export const GENERATOR_VERSION = "3.1.0";

// ---------------------------------------------------------------------------
// Source-element snapshot (compact, no bounding box, no full DOM)
// ---------------------------------------------------------------------------
const sourceElementOf = (element: DiscoveredElement, occurrences = 1): SourceElementSnapshot => ({
  tag: element.tag, role: element.role, id: element.id, name: element.name,
  text: element.text, type: element.type, href: element.href,
  placeholder: element.placeholder, accessibleName: element.accessibleName,
  locatorQuality: element.locatorQuality, visible: element.visible === true, occurrences,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const locator = (element: DiscoveredElement): string | null => element.recommendedLocator?.trim() || null;
const isLowQuality = (element: DiscoveredElement): boolean => element.locatorQuality === "low";

const label = (element: DiscoveredElement, fallback = "element"): string => {
  const raw = element.accessibleName?.trim() || element.placeholder?.trim() || element.name || element.text?.trim() || element.id;
  return (raw ?? fallback).slice(0, 80);
};

// ---------------------------------------------------------------------------
// Locator ambiguity detection.
//
// Playwright's `getByRole(role, { name })` matches by case-insensitive
// substring. A recorded element is ambiguous when another interactive element
// with the same role carries an accessible name that contains this element's
// name (e.g. an "Episode 2" link that is also matched by links named
// "Episode 20"...) or shares an identical name with a different control
// (e.g. two "Load more" links). Ambiguous controls are documented but are not
// reliably automatable and must go through manual review.
// ---------------------------------------------------------------------------
const nameForAmbiguity = (element: DiscoveredElement): string => (element.accessibleName ?? element.text ?? "").trim();

const nameKey = (element: DiscoveredElement): string => `${element.role ?? ""}::${nameForAmbiguity(element).toLowerCase()}`;

const ambiguousNameKeys = (elements: DiscoveredElement[]): Set<string> => {
  const items = elements.filter(element => element.interactive && nameForAmbiguity(element).length > 0);
  const flagged = new Set<string>();
  for (const a of items) {
    const na = nameForAmbiguity(a).toLowerCase();
    for (const b of items) {
      if (a === b) continue;
      if ((a.role ?? "") !== (b.role ?? "")) continue;
      const nb = nameForAmbiguity(b).toLowerCase();
      if (nb === na || nb.includes(na)) flagged.add(nameKey(a));
    }
  }
  return flagged;
};

type ScenarioInput = Omit<GeneratedScenario, "id"> & { locator?: string | null };

// ---------------------------------------------------------------------------
// Element grouping / deduplication.
//
// The scanner can discover the same control template multiple times (for
// example a video player overlay rendered per carousel item, or responsive
// clones). Elements that share a stable identity — locator plus the source
// attributes that would change a locator — should produce one scenario set.
// The representative is the first visible instance so visibility checks are
// created only when at least one instance is actually visible.
// ---------------------------------------------------------------------------
type ElementGroup = { key: string; occurrences: number; representative: DiscoveredElement };

const dedupKey = (element: DiscoveredElement): string =>
  [element.recommendedLocator, element.tag, element.role, element.accessibleName, element.name, element.id, element.type, element.href]
    .map(value => value ?? "")
    .join("::");

const groupElements = (elements: DiscoveredElement[]): ElementGroup[] => {
  const byKey = new Map<string, DiscoveredElement[]>();
  for (const element of elements) {
    const key = dedupKey(element);
    const list = byKey.get(key);
    if (list) list.push(element);
    else byKey.set(key, [element]);
  }
  return Array.from(byKey.entries()).map(([key, list]) => ({
    key, occurrences: list.length,
    representative: list.find(element => element.visible === true) ?? list[0],
  }));
};

// ---------------------------------------------------------------------------
// Conditional / transient control review scenario.
//
// Elements that are hidden at scan time (player controls, language menus,
// dialogs that open on interaction, responsive navs...) are NOT automatable
// against the initial page load. They produce a single REVIEW scenario that
// documents the finding instead of an unconditional "is visible" test.
// ---------------------------------------------------------------------------
const conditionalReviewScenario = (element: DiscoveredElement, category: TestCategory, occurrences: number): ScenarioInput => {
  const name = label(element);
  const src = sourceElementOf(element, occurrences);
  return {
    category, locator: locator(element), risk: "review",
    riskReason: "The element is not visible on initial page load, so it is treated as conditional or transient UI (for example a player control, a menu, or an overlay opened by interaction).",
    scenarioType: "behavioral", automated: false, requiresSetup: true,
    setupNote: "Identify the user interaction that reveals this control before attempting to automate it.",
    sourceElement: src,
    title: `Conditional control "${name}" is hidden at scan time — review`,
    description: `The ${element.tag} "${name}" was discovered in the DOM${occurrences > 1 ? ` ${occurrences} time(s)` : ""} but is hidden at scan time. No unconditional visibility assertion is generated; a QA engineer must confirm whether it is intentionally conditional or a defect.`,
    preconditions: ["The control depends on user interaction or a specific page state."],
    steps: [
      "Confirm the control exists in the DOM but is hidden at initial load.",
      "Identify the interaction (e.g., open the player, open the menu) that reveals it.",
      "Verify it is correctly labeled and usable once revealed.",
      "Review whether the hidden state is intentional conditional UI or a defect.",
    ],
    expected: ["The control's conditional behavior is confirmed, or the hidden state is reported as a defect by QA."],
    safetyNote: "Not executed automatically. The control may only appear in the accessibility tree after user interaction.",
  };
};

// ---------------------------------------------------------------------------
// Scenario builders
// ---------------------------------------------------------------------------

const buildLinkScenarios = (element: DiscoveredElement, occurrences = 1, ambiguous = false): ScenarioInput[] => {
  if (!element.interactive || element.tag !== "a") return [];
  const loc = locator(element);
  if (!loc) return [];
  if (element.visible === false) return [conditionalReviewScenario(element, "navigation", occurrences)];
  const name = label(element);
  const src = sourceElementOf(element, occurrences);
  const auto = !isLowQuality(element) && !ambiguous;
  const href = element.href || null;
  const preconditions = ["The page is loaded."];
  const out: ScenarioInput[] = [];
  const structuralRisk = auto ? "safe" : "review";
  const riskReasonStruct = ambiguous
    ? "The recorded locator is ambiguous and resolves to more than one element at runtime; manual disambiguation required."
    : "Structural check; no state change.";
  const riskReasonNav = ambiguous
    ? "The recorded locator is ambiguous and the click may target the wrong element; manual disambiguation required."
    : "Clicking navigates away from the current page; destination must be verified.";

  out.push({
    category: "navigation", locator: loc, risk: structuralRisk, riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
    title: `Link "${name}" is visible`, description: `Verifies the link labeled "${name}" is rendered and visible to the user.`,
    preconditions, steps: ["Locate the link.", "Verify the link is visible."], expected: ["The link is visible on the page."],
  });
  if (element.accessibleName) {
    out.push({
      category: "navigation", locator: loc, risk: structuralRisk, riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
      title: `Link "${name}" has an accessible name`, description: `Ensures the link exposes the accessible name "${name}" for screen readers.`,
      preconditions, steps: ["Locate the link.", "Verify the link exposes an accessible name via its role."],
      expected: ["The link exposes a non-empty accessible name."],
    });
  }
  if (href && /^https?:\/\//i.test(href)) {
    out.push({
      category: "navigation", locator: loc, risk: "review", riskReason: riskReasonNav, scenarioType: "behavioral", automated: false, sourceElement: src,
      title: `Clicking link "${name}" navigates without an HTTP error`,
      description: `Clicks the link and verifies the page navigates successfully without a client or server error.`,
      preconditions: [...preconditions, "The target URL is reachable from the QA environment."],
      steps: ["Locate the link.", "Record the current page URL.", "Click the link.", "Wait for navigation to settle.", "Confirm navigation completed without a client or server error."],
      expected: ["The page navigates and the response has a non-error status."],
      safetyNote: "Navigates away from the current page; confirm the destination before automated execution.",
    });
  }
  return out;
};

const buildButtonScenarios = (element: DiscoveredElement, occurrences = 1, ambiguous = false): ScenarioInput[] => {
  if (!element.interactive || element.tag !== "button") return [];
  const loc = locator(element);
  if (!loc) return [];
  if (element.visible === false) return [conditionalReviewScenario(element, "button", occurrences)];
  const name = label(element);
  const src = sourceElementOf(element, occurrences);
  const auto = !isLowQuality(element) && !ambiguous;
  const preconditions = ["The page is loaded."];
  const out: ScenarioInput[] = [];
  const riskReason = ambiguous
    ? "The recorded locator is ambiguous and resolves to more than one element at runtime; manual disambiguation required."
    : "Structural check; no state change.";

  out.push({
    category: "button", locator: loc, risk: auto ? "safe" : "review", riskReason, scenarioType: "structural", automated: auto, sourceElement: src,
    title: `Button "${name}" is visible`, description: `Verifies the button labeled "${name}" is rendered and visible.`,
    preconditions, steps: ["Locate the button.", "Verify the button is visible."], expected: ["The button is visible on the page."],
  });
  if (element.accessibleName) {
    out.push({
      category: "button", locator: loc, risk: auto ? "safe" : "review", riskReason, scenarioType: "structural", automated: auto, sourceElement: src,
      title: `Button "${name}" has an accessible name`, description: `Ensures the button exposes the accessible name "${name}" for assistive technology.`,
      preconditions, steps: ["Locate the button.", "Verify the button exposes an accessible name via its role."],
      expected: ["The button exposes a non-empty accessible name."],
    });
  }
  out.push({
    category: "button", locator: loc, risk: auto ? "safe" : "review", riskReason, scenarioType: "structural", automated: auto, sourceElement: src,
    title: `Button "${name}" is ${element.enabled ? "enabled" : "disabled"}`,
    description: `Confirms the button's enabled/disabled state matches the DOM: ${element.enabled ? "enabled" : "disabled"}.`,
    preconditions, steps: ["Locate the button.", `Verify the button is ${element.enabled ? "enabled" : "disabled"}.`],
    expected: [`The button is ${element.enabled ? "enabled and clickable" : "disabled and not clickable"}.`],
  });
  if (element.type === "submit") {
    out.push({
      category: "button", locator: loc, risk: "high-risk", riskReason: "Submit buttons trigger form submission; automatic execution may create or modify data.",
      scenarioType: "behavioral", automated: false, sourceElement: src,
      title: `Submit button "${name}" — form submission requires manual review`,
      description: "Submit buttons trigger form submission. Automatic execution is disabled; a QA engineer must review before clicking.",
      preconditions: [...preconditions, "The associated form must not be submitted automatically."],
      steps: ["Locate the submit button.", "Confirm it is the submission control for its form.", "Review validation, duplicate-submission, and destructive-action risk.", "Do not click the button automatically."],
      expected: ["Form submission behavior is verified manually by a QA engineer."],
      safetyNote: "Generated tests never click submit buttons automatically. Execution requires explicit QA opt-in.",
    });
  } else if (element.enabled) {
    out.push({
      category: "button", locator: loc, risk: "review", riskReason: "Button clicks may trigger state changes or API calls; review required.",
      scenarioType: "behavioral", automated: false, sourceElement: src,
      title: `Clicking button "${name}" is safe to review`,
      description: "Clicks the button and verifies it responds without an uncaught error; review for unintended side effects.",
      preconditions, steps: ["Locate the button.", "Review the button's click handler for side effects.", "Click the button and verify no uncaught page error occurs.", "Confirm the button's resulting state is unchanged unless intended."],
      expected: ["The button responds without an uncaught error and without unintended state change."],
      safetyNote: "Buttons may trigger state changes or API calls; review before automated execution.",
    });
  }
  return out;
};

const TEXT_LIKE_TYPES = new Set(["text", "email", "password", "tel", "url", "search", "number"]);

const isTextLikeInput = (element: DiscoveredElement): boolean => element.tag === "textarea" || (element.tag === "input" && TEXT_LIKE_TYPES.has(element.type ?? ""));

const buildInputScenarios = (element: DiscoveredElement, occurrences = 1): ScenarioInput[] => {
  if (!element.interactive) return [];
  if (element.tag === "input" && element.type === "hidden") return [];
  if (element.tag !== "input" && element.tag !== "textarea") return [];
  const loc = locator(element);
  if (!loc) return [];
  const isCheckbox = element.tag === "input" && ["checkbox", "radio"].includes(element.type ?? "");
  if (!isCheckbox && !isTextLikeInput(element)) return [];
  if (element.visible === false) return [conditionalReviewScenario(element, "input", occurrences)];
  const name = label(element);
  const src = sourceElementOf(element, occurrences);
  const auto = !isLowQuality(element);
  const preconditions = ["The page is loaded."];
  const out: ScenarioInput[] = [];
  const riskReasonStruct = "Structural check; no state change.";

  if (isCheckbox) {
    out.push({
      category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
      title: `Check control "${name}" is visible`, description: `Verifies the ${element.type} control labeled "${name}" is visible.`,
      preconditions, steps: ["Locate the control.", "Verify the control is visible."], expected: ["The control is visible on the page."],
    });
    if (element.accessibleName) {
      out.push({
        category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
        title: `Check control "${name}" has an accessible label`, description: `Ensures the control exposes the accessible name "${name}".`,
        preconditions, steps: ["Locate the control.", "Verify the control exposes an accessible name."],
        expected: ["The control exposes a non-empty accessible name."],
      });
    }
    if (element.enabled) {
      out.push({
        category: "input", locator: loc, risk: "review", riskReason: "Toggling may fire change handlers; review required.", scenarioType: "behavioral", automated: false, sourceElement: src,
        title: `Toggling check control "${name}" — review required`, description: "Clicks the control to toggle its checked state and verifies the state changes.",
        preconditions, steps: ["Locate the control.", "Record its current checked state.", "Click the control to toggle it.", "Verify the checked state changed."],
        expected: ["The control toggles between checked and unchecked states."],
        safetyNote: "Toggling may fire change handlers; review before automated execution.",
      });
    }
    return out;
  }

  // Text-like input / textarea
  out.push({
    category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
    title: `Field "${name}" is visible`, description: `Verifies the ${element.tag} field "${name}" is rendered and visible.`,
    preconditions, steps: ["Locate the field.", "Verify the field is visible."], expected: ["The field is visible on the page."],
  });
  const nameHint = element.accessibleName || element.name || element.placeholder || element.text || null;
  if (nameHint) {
    out.push({
      category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
      title: `Field "${name}" has an accessible label`, description: `Ensures the field exposes an accessible name for assistive technology (name hint: "${nameHint}").`,
      preconditions, steps: ["Locate the field.", "Verify the field exposes a non-empty accessible name."],
      expected: ["The field exposes a non-empty accessible name."],
    });
  }
  if (element.placeholder) {
    out.push({
      category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
      title: `Field "${name}" shows placeholder "${element.placeholder}"`, description: `Verifies the field's placeholder text matches the recorded value.`,
      preconditions, steps: ["Locate the field.", "Verify the field's placeholder matches the recorded value."],
      expected: [`The field shows the placeholder "${element.placeholder}".`],
    });
  }
  if (element.enabled) {
    out.push({
      category: "validation", locator: loc, risk: "review", riskReason: "Empty-value tests touch the field; review for unintended side effects.", scenarioType: "behavioral", automated: false, sourceElement: src,
      title: `Field "${name}" accepts an empty value without errors`, description: "Clears the field and verifies no uncaught page error occurs.",
      preconditions, steps: ["Locate the field.", "Clear the field.", "Move focus away (blur).", "Confirm no uncaught page error occurs."],
      expected: ["The field accepts an empty value without unexpected errors."],
    });
    const sample = safeSample(element);
    if (sample) {
      out.push({
        category: "validation", locator: loc, risk: "review", riskReason: "Entering data may trigger validation or API calls; review required.", scenarioType: "behavioral", automated: false, sourceElement: src,
        title: `Field "${name}" accepts a valid ${element.type ?? "text"} value`,
        description: `Enters the sample value "${sample}" and verifies the field accepts it without errors.`,
        preconditions: [...preconditions, "Field constraints (server-side or JS) are considered during review."],
        steps: ["Locate the field.", `Enter a generic valid value (${sample}).`, "Verify the entered value is accepted.", "Confirm no uncaught page error occurs."],
        expected: [`The field accepts the valid value "${sample}" without errors.`],
        safetyNote: "Enters a dummy value; review against real field constraints before automated execution.",
      });
    }
  }
  return out;
};

const buildSelectScenarios = (element: DiscoveredElement, occurrences = 1): ScenarioInput[] => {
  if (!element.interactive || element.tag !== "select") return [];
  const loc = locator(element);
  if (!loc) return [];
  if (element.visible === false) return [conditionalReviewScenario(element, "input", occurrences)];
  const name = label(element);
  const src = sourceElementOf(element, occurrences);
  const auto = !isLowQuality(element);
  const preconditions = ["The page is loaded."];
  const out: ScenarioInput[] = [];
  const riskReasonStruct = "Structural check; no state change.";

  out.push({
    category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
    title: `Dropdown "${name}" is visible`, description: `Verifies the dropdown control "${name}" is rendered and visible.`,
    preconditions, steps: ["Locate the dropdown.", "Verify the dropdown is visible."], expected: ["The dropdown is visible on the page."],
  });
  if (element.accessibleName) {
    out.push({
      category: "input", locator: loc, risk: "safe", riskReason: riskReasonStruct, scenarioType: "structural", automated: auto, sourceElement: src,
      title: `Dropdown "${name}" has an accessible label`, description: `Ensures the dropdown exposes the accessible name "${name}".`,
      preconditions, steps: ["Locate the dropdown.", "Verify the dropdown exposes an accessible name."],
      expected: ["The dropdown exposes a non-empty accessible name."],
    });
  }
  if (element.enabled) {
    out.push({
      category: "input", locator: loc, risk: "review", riskReason: "Selection may fire change handlers; review required.", scenarioType: "behavioral", automated: false, sourceElement: src,
      title: `Selecting an option in dropdown "${name}" — review required`, description: "Opens the dropdown and selects the first available option; review for side effects.",
      preconditions, steps: ["Locate the dropdown.", "Expand the dropdown.", "Choose the first non-empty option.", "Verify a value is selected."],
      expected: ["A dropdown option becomes selected."],
      safetyNote: "Change handlers may fire on selection; review before automated execution.",
    });
  }
  return out;
};

const safeSample = (element: DiscoveredElement): string | null => {
  const type = element.type ?? "";
  if (type === "password") return null;
  if (element.tag === "textarea") return "QA automation test value";
  switch (type) {
    case "email": return "qa.automation@example.com";
    case "url": return "https://example.com/";
    case "tel": return "+15551234567";
    case "number": return null;
    default: return "QA automation test value";
  }
};

// ---------------------------------------------------------------------------
// Form scenarios
// ---------------------------------------------------------------------------
const buildFormScenarios = (elements: DiscoveredElement[]): ScenarioInput[] => {
  const scenarios: ScenarioInput[] = [];
  const forms = elements.filter(element => element.tag === "form");
  const grouped = new Map<number, DiscoveredElement[]>();
  for (const element of elements) {
    if (element.formIndex === undefined || element.formIndex === null || !element.interactive) continue;
    const controls = grouped.get(element.formIndex) ?? [];
    controls.push(element);
    grouped.set(element.formIndex, controls);
  }
  for (const [index, controls] of grouped) {
    if (controls.length === 0) continue;
    const formElement = forms[index];
    if (!formElement) continue;
    const formLocator = formElement.id ? `page.locator("#${formElement.id}")` : formElement.recommendedLocator?.trim() || null;
    const src = sourceElementOf(formElement);
    scenarios.push({
      category: "form", locator: formLocator, risk: "high-risk",
      riskReason: "Form submission may create, modify, or delete data; automatic execution is disabled.",
      scenarioType: "behavioral", automated: false, sourceElement: src,
      title: `Form ${index + 1} — ${controls.length} control(s) discoverable, no automatic submission`,
      description: `Verifies all ${controls.length} interactive controls in form ${index + 1} are locatable. Form submission is never automated.`,
      preconditions: [`The form contains ${controls.length} interactive control(s).`, "Form submission is never automated in generated tests."],
      steps: [
        "Locate the form and its declared controls.",
        ...controls.map(control => `Verify control is discoverable: ${control.recommendedLocator || `<${control.tag}>`}.`),
        "Review validation behavior (required fields, formats, cross-field rules) manually.",
        "Do not submit the form automatically.",
      ],
      expected: ["All form controls are discoverable with locators.", "No automatic form submission is performed."],
      safetyNote: "Generated tests never submit forms automatically. Execution requires explicit QA opt-in and review.",
    });
  }
  return scenarios;
};

// ---------------------------------------------------------------------------
// Navigation integrity
// ---------------------------------------------------------------------------
const buildNavigationIntegrityScenario = (report: ScanReport): GeneratedScenario | null => {
  const broken = (report.links ?? []).filter(link => link.type === "BROKEN" || link.type === "ERROR");
  const checked = report.links?.length ?? 0;
  return {
    id: "SC-NAV-INTEGRITY", category: "navigation",
    title: "Discovered links resolve without HTTP errors",
    description: broken.length === 0
      ? "Confirms the scan found no broken or errored links among the checked URLs."
      : `Reports ${broken.length} broken or errored link(s) found by the scanner (out of ${checked} checked).`,
    preconditions: ["The scan checked link responses."],
    steps: ["Confirm the scanner checked external and internal links.", `Review the ${broken.length} broken/error link(s) found.`],
    expected: broken.length === 0
      ? ["All discovered links returned healthy responses."]
      : [`The scan found ${broken.length} link(s) needing review (out of ${checked} checked).`],
    locator: null, risk: broken.length > 0 ? "review" : "safe",
    riskReason: broken.length > 0
      ? "Broken links may indicate routing or deployment issues requiring investigation."
      : "Summary check; no state change.",
    scenarioType: "structural", automated: true,
    sourceElement: { tag: "nav", role: "navigation", id: null, name: null, text: "link integrity summary", type: null, href: null, placeholder: null, accessibleName: "link integrity summary", locatorQuality: "high", visible: true, occurrences: 1 },
    safetyNote: broken.length > 0 ? "Failing links pre-date test generation; investigate before automation." : undefined,
  };
};

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------
const countScenarios = (scenarios: GeneratedScenario[]): GeneratedCounts => {
  const by = (predicate: (s: GeneratedScenario) => boolean) => scenarios.filter(predicate).length;
  return {
    total: scenarios.length,
    navigation: by(s => s.category === "navigation"),
    button: by(s => s.category === "button"),
    input: by(s => s.category === "input"),
    form: by(s => s.category === "form"),
    validation: by(s => s.category === "validation"),
    highRisk: by(s => s.risk === "high-risk"),
    safe: by(s => s.risk === "safe"),
    review: by(s => s.risk === "review"),
    automated: by(s => s.automated),
    manual: by(s => !s.automated),
    conditional: by(s => s.requiresSetup === true),
  };
};

// ---------------------------------------------------------------------------
// Public: generate suite
// ---------------------------------------------------------------------------
export function generateTestSuite(report: ScanReport, options: { sourcePath?: string } = {}): GeneratedTestSuite {
  const elements = report.elements ?? [];
  const groups = groupElements(elements);
  const ambiguous = ambiguousNameKeys(elements);
  const isAmbiguous = (element: DiscoveredElement): boolean => ambiguous.has(nameKey(element));
  const scenarioInputs: ScenarioInput[] = [];
  for (const builder of [buildLinkScenarios, buildButtonScenarios]) {
    for (const group of groups) scenarioInputs.push(...builder(group.representative, group.occurrences, isAmbiguous(group.representative)));
  }
  for (const builder of [buildInputScenarios, buildSelectScenarios]) {
    for (const group of groups) scenarioInputs.push(...builder(group.representative, group.occurrences));
  }
  scenarioInputs.push(...buildFormScenarios(elements));
  const scenarios: GeneratedScenario[] = [];
  let sequence = 0;
  for (const scenario of scenarioInputs) scenarios.push({ ...scenario, id: `SC-${String(++sequence).padStart(3, "0")}` });
  const integrity = buildNavigationIntegrityScenario(report);
  if (integrity) scenarios.push(integrity);
  return {
    generator: GENERATOR_NAME, version: GENERATOR_VERSION,
    sourceUrl: report.scan?.url ?? "", sourceReport: options.sourcePath ?? "report",
    generatedAt: new Date().toISOString(),
    scanSummary: {
      totalElements: report.summary?.totalElements ?? elements.length,
      interactiveElements: report.summary?.interactiveElements ?? 0,
      passes: report.summary?.passes ?? 0, warnings: report.summary?.warnings ?? 0,
      failures: report.summary?.failures ?? 0, infos: report.summary?.infos ?? 0,
      linksChecked: report.summary?.linksChecked ?? 0, brokenLinks: report.summary?.brokenLinks ?? 0,
    },
    scenarios, counts: countScenarios(scenarios),
  };
}

// ---------------------------------------------------------------------------
// Public: write JSON + HTML reports
// ---------------------------------------------------------------------------
export function writeGeneratedTests(suite: GeneratedTestSuite, outputPath: string): { jsonPath: string; htmlPath: string } {
  const jsonPath = resolve(outputPath);
  const htmlPath = jsonPath.slice(0, jsonPath.length - extname(jsonPath).length) + ".html";
  atomicWriteText(jsonPath, JSON.stringify(suite, null, 2));
  const c = suite.counts;
  const rows = suite.scenarios.map(s => {
    const src = s.sourceElement;
    const srcParts = [src.tag, src.type ? `type=${src.type}` : "", src.name ? `name=${src.name}` : "", src.placeholder ? `ph=${src.placeholder}` : "", src.id ? `id=${src.id}` : "", src.href ? `href=${src.href}` : "", src.visible ? "visible" : "hidden", src.occurrences > 1 ? `×${src.occurrences}` : ""].filter(Boolean).join(" ");
    const stateBadge = `<span class="badge ${src.visible ? "badge-stable" : "badge-conditional"}">${src.visible ? "stable" : "conditional"}</span>`;
    const setupCell = s.requiresSetup ? `<span class="badge badge-setup">setup</span> ${escapeHtml(s.setupNote ?? "")}` : "—";
    return `<tr data-cat="${escapeHtml(s.category)}" data-risk="${escapeHtml(s.risk)}" data-auto="${s.automated ? "1" : "0"}" data-state="${src.visible ? "stable" : "conditional"}" data-search="${escapeHtml((s.title + " " + s.description + " " + srcParts + " " + (s.locator ?? "") + " " + (s.setupNote ?? "")).toLowerCase())}">` +
      `<td>${escapeHtml(s.id)}</td>` +
      `<td>${escapeHtml(s.category)}</td>` +
      `<td><span class="badge badge-${s.risk}">${escapeHtml(s.risk)}</span></td>` +
      `<td>${s.automated ? '<span class="badge badge-auto">auto</span>' : '<span class="badge badge-manual">manual</span>'}</td>` +
      `<td>${stateBadge}</td>` +
      `<td>${escapeHtml(s.title)}</td>` +
      `<td class="desc">${escapeHtml(s.description)}</td>` +
      `<td class="src">${escapeHtml(srcParts)}</td>` +
      `<td class="setup">${setupCell}</td>` +
      `<td><ol>${s.steps.map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol></td>` +
      `<td><ul>${s.expected.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></td>` +
      (s.locator ? `<td><code>${escapeHtml(s.locator)}</code></td>` : "<td>—</td>") +
      `<td class="risk-reason">${escapeHtml(s.riskReason)}</td>` +
      `<td>${escapeHtml(s.safetyNote ?? "")}</td></tr>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated QA tests</title><style>:root{color-scheme:light}body{font:14px system-ui,sans-serif;margin:0;background:#f7f9fc;color:#17212b;line-height:1.45}main{max-width:1600px;margin:auto;padding:1.5rem}h1{margin:0 0 .2rem}p{margin:.2rem 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.6rem;margin:1rem 0}.card{background:#fff;border:1px solid #d7dee8;border-radius:8px;padding:.7rem}.card strong{font-size:1.2rem;display:block}.controls{background:#fff;border:1px solid #d7dee8;border-radius:8px;padding:.8rem;margin:1rem 0;display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}.controls label{font-weight:600;font-size:.85rem}.controls select,.controls input{padding:.3rem .5rem;border:1px solid #d7dee8;border-radius:6px;font-size:.85rem}table{border-collapse:collapse;width:100%;background:#fff;margin-top:.8rem}td,th{padding:.5rem;border:1px solid #d7dee8;text-align:left;vertical-align:top;word-break:break-word;font-size:.82rem}th{background:#f1f5f9;position:sticky;top:0}.badge{font-weight:700;font-size:.72rem;padding:.12rem .45rem;border-radius:99px;white-space:nowrap}.badge-safe{background:#e6f4ea;color:#067647}.badge-review{background:#fef3c7;color:#9a6700}.badge-high-risk{background:#fde8e8;color:#b42318}.badge-auto{background:#e0edff;color:#175cd3}.badge-manual{background:#f1f5f9;color:#475569}.badge-stable{background:#e6f4ea;color:#067647}.badge-conditional{background:#fef3c7;color:#9a6700}.badge-setup{background:#ede9fe;color:#6d28d9}code{white-space:pre-wrap;font-size:.82em}ol,ul{margin:.15rem 0;padding-left:1.1rem}.desc{color:#475569}.src{color:#64748b;font-family:monospace;font-size:.78rem}.setup{max-width:280px}.risk-reason{font-style:italic;color:#475569}tr.hidden{display:none}</style></head><body><main><h1>Generated QA tests</h1><p><strong>Source:</strong> <a href="${safeHref(suite.sourceUrl)}">${escapeHtml(suite.sourceUrl)}</a> from ${escapeHtml(suite.sourceReport)}</p><section class="cards"><div class="card"><strong>${c.total}</strong>Total</div><div class="card"><strong>${c.safe}</strong>Safe</div><div class="card"><strong>${c.review}</strong>Review</div><div class="card"><strong>${c.highRisk}</strong>High-risk</div><div class="card"><strong>${c.automated}</strong>Automated</div><div class="card"><strong>${c.manual}</strong>Manual</div><div class="card"><strong>${c.conditional}</strong>Conditional</div><div class="card"><strong>${c.navigation}</strong>Navigation</div><div class="card"><strong>${c.button}</strong>Button</div><div class="card"><strong>${c.input}</strong>Input</div><div class="card"><strong>${c.form}</strong>Form</div><div class="card"><strong>${c.validation}</strong>Validation</div></section><div class="controls"><label>Risk:</label><select id="fRisk"><option value="">All</option><option value="safe">Safe</option><option value="review">Review</option><option value="high-risk">High-risk</option></select><label>Category:</label><select id="fCat"><option value="">All</option><option value="navigation">Navigation</option><option value="button">Button</option><option value="input">Input</option><option value="form">Form</option><option value="validation">Validation</option></select><label>Automation:</label><select id="fAuto"><option value="">All</option><option value="1">Automated</option><option value="0">Manual</option></select><label>State:</label><select id="fState"><option value="">All</option><option value="stable">Stable</option><option value="conditional">Conditional</option></select><label>Search:</label><input type="text" id="fSearch" placeholder="id, title, locator, source, setup…" style="flex:1;min-width:200px"></div><table><thead><tr><th>ID</th><th>Category</th><th>Risk</th><th>Auto</th><th>State</th><th>Scenario</th><th>Description</th><th>Source element</th><th>Setup</th><th>Steps</th><th>Expected</th><th>Locator</th><th>Risk reason</th><th>Safety note</th></tr></thead><tbody id="tbody">${rows}</tbody></table></main><script>(function(){var tbody=document.getElementById("tbody");var rows=Array.from(tbody.querySelectorAll("tr"));function apply(){var rv=document.getElementById("fRisk").value;var cv=document.getElementById("fCat").value;var av=document.getElementById("fAuto").value;var sv=document.getElementById("fState").value;var q=document.getElementById("fSearch").value.toLowerCase();rows.forEach(function(r){var show=true;if(rv&&r.dataset.risk!==rv)show=false;if(cv&&r.dataset.cat!==cv)show=false;if(av&&r.dataset.auto!==av)show=false;if(sv&&r.dataset.state!==sv)show=false;if(q&&r.dataset.search.indexOf(q)===-1)show=false;r.className=show?"":"hidden";});}document.getElementById("fRisk").onchange=apply;document.getElementById("fCat").onchange=apply;document.getElementById("fAuto").onchange=apply;document.getElementById("fState").onchange=apply;document.getElementById("fSearch").oninput=apply;})();</script></body></html>`;
  atomicWriteText(htmlPath, html);
  return { jsonPath, htmlPath };
}