import { GeneratedScenario, GeneratedTestSuite, IntentCategory, Priority, RiskLevel, ScanReport } from "../types.js";
import { AutomationStatus, FlowKind, IntentScenario, QaFinding, UserFlow } from "./types.js";

// ---------------------------------------------------------------------------
// Intent + priority decoration for element scenarios.
//
// These annotations are additive metadata: they never change how the scenario
// was generated, only how the QA report groups and prioritizes it. Priorities
// rank business intent; a P1 means "attend to this before release", never an
// arbitrary score.
// ---------------------------------------------------------------------------
const LANG = /عربي|العربية|english|français|french|language|اللغة|set-lang/i;
const SEARCH = /search|بحث|ابحث/i;
const AUTH_BUTTON = /sign in|log in|login|submit|send|confirm|continue/i;
const PROFILE = /my account|my profile|account|profile|avatar|watchlist|favorites|history/i;
const MEDIA = /player|volume|fullscreen|episode|video|audio|watch|play/i;

const INTENT_PRIORITY: Record<IntentCategory, Priority> = {
  NAVIGATION: "P2",
  ACCESSIBILITY: "P2",
  SEARCH: "P2",
  AUTHENTICATION: "P1",
  FORM: "P2",
  MEDIA: "P3",
  LANGUAGE: "P2",
  PROFILE: "P2",
  CONTENT: "P3",
  VALIDATION: "P2",
  RESPONSIVE: "P3",
  ERROR_HANDLING: "P1",
};

const joinedName = (scenario: GeneratedScenario): string =>
  [scenario.sourceElement.accessibleName, scenario.sourceElement.name, scenario.sourceElement.placeholder, scenario.sourceElement.text].filter(Boolean).join(" ");

export function intentFor(scenario: GeneratedScenario): IntentCategory {
  if (scenario.id === "SC-NAV-INTEGRITY") return "NAVIGATION";
  if (/accessible name|accessible label/i.test(scenario.title)) return "ACCESSIBILITY";
  const element = scenario.sourceElement;
  const name = joinedName(scenario);
  if (element.href && /set-lang|\/(ar|en|fr|de|es|it|pt|ru|tr|zh|hi|nl)\b/i.test(element.href)) return "LANGUAGE";
  if (LANG.test(name)) return "LANGUAGE";
  if (element.type === "password") return "AUTHENTICATION";
  if (AUTH_BUTTON.test(name) && scenario.category === "button") return "AUTHENTICATION";
  if (element.type === "search" || element.role === "searchbox" || SEARCH.test(name)) return "SEARCH";
  if (PROFILE.test(name)) return "PROFILE";
  if (element.tag === "video" || element.tag === "audio" || MEDIA.test(name)) return "MEDIA";
  switch (scenario.category) {
    case "navigation": return "NAVIGATION";
    case "form": return "FORM";
    case "validation": return "VALIDATION";
    case "input": return "FORM";
    case "button": return "CONTENT";
    default: return "CONTENT";
  }
}

export function priorityFor(scenario: GeneratedScenario, intent?: IntentCategory): Priority {
  if (scenario.risk === "high-risk") return "P1";
  const base = INTENT_PRIORITY[intent ?? intentFor(scenario)];
  if (scenario.sourceElement.visible === false) return "P4";
  return base;
}

export function decorateScenarios(suite: GeneratedTestSuite): GeneratedScenario[] {
  return suite.scenarios.map(scenario => {
    const intent = intentFor(scenario);
    return { ...scenario, intent, priority: priorityFor(scenario, intent) };
  });
}

// ---------------------------------------------------------------------------
// Intent scenarios built from detected flows + fixed QA gates.
// ---------------------------------------------------------------------------
type FlowTemplate = {
  intent: IntentCategory;
  automation: AutomationStatus;
  automationReason: string;
  risk: RiskLevel;
  preconditions: (flow: UserFlow) => string[];
  steps: (flow: UserFlow) => string[];
  expected: string[];
  safetyNote?: string;
};

const FLOW_TEMPLATES: Record<FlowKind, (flow: UserFlow) => FlowTemplate> = {
  navigation: () => ({
    intent: "NAVIGATION", automation: "AUTOMATED", risk: "safe",
    automationReason: "Verification-only scenario; it inspects link responses without changing state or entering data.",
    preconditions: () => ["The page is loaded."],
    steps: flow => ["Invoke the navigation trigger.", "Wait for navigation to settle.", "Confirm the response is not an HTTP error."].map(step => (step === "Invoke the navigation trigger." ? `Navigate via ${flow.trigger || "the primary menu"}.` : step)),
    expected: ["Navigation resolves without HTTP errors.", "No new browser or page errors are thrown."],
  }),
  search: () => ({
    intent: "SEARCH", automation: "REVIEW", risk: "review",
    automationReason: "Requires typing a query and asserting on results; outcome depends on backend state and must be reviewed before automation.",
    preconditions: () => ["The page is loaded.", "A benign, non-credential search query is safe to enter."],
    steps: flow => ["Focus the search control.", "Enter a benign query.", "Submit the search.", "Verify results update without an uncaught error."].map(step => (step === "Focus the search control." ? `Focus the search control ${flow.trigger || ""}.` : step)),
    expected: ["Search returns relevant results.", "The page does not throw uncaught errors.", "Results are reachable and linkable."],
    safetyNote: "Enter only a benign query; never route credentials through a search flow.",
  }),
  login: () => ({
    intent: "AUTHENTICATION", automation: "REVIEW", risk: "review",
    automationReason: "Sign-in writes session state and may trigger rate limiting; automation requires a dedicated test account and explicit QA opt-in.",
    preconditions: () => ["A dedicated test account is provisioned.", "Sign-in is never automated with production credentials."],
    steps: flow => ["Open the sign-in form.", "Enter the test username and password.", "Submit the form.", "Verify the authenticated state.", "Repeat with an invalid password and verify a graceful error."].map(step => (step === "Open the sign-in form." ? `Open the sign-in trigger ${flow.trigger || ""}.` : step)),
    expected: ["Valid credentials authenticate.", "Invalid credentials produce a clear error message.", "No sensitive error detail is exposed."],
    safetyNote: "Never auto-execute sign-in with real credentials; automation must use a dedicated test account.",
  }),
  signup: () => ({
    intent: "AUTHENTICATION", automation: "MANUAL", risk: "review",
    automationReason: "Registration may create real accounts, send email, or trigger payments; it must be executed manually by QA.",
    preconditions: () => ["QA has a disposable test identity ready."],
    steps: flow => ["Open the registration trigger.", "Fill the form with disposable test data.", "Submit and observe validation.", "Complete any confirmation step (email/SMS/captcha)."].map(step => (step === "Open the registration trigger." ? `Open the registration trigger ${flow.trigger || ""}.` : step)),
    expected: ["Registration validates inputs and completes confirmation.", "No duplicate or cross-user data issues are observed."],
    safetyNote: "May create real accounts or send email; manual only.",
  }),
  form: () => ({
    intent: "FORM", automation: "REVIEW", risk: "review",
    automationReason: "Form submission may create or modify data; generated tests never submit forms automatically.",
    preconditions: () => ["The form is reviewed field-by-field."],
    steps: flow => ["Open the form.", "Verify each control is locatable and labeled.", "Review validation rules (required, format, cross-field)."].map(step => (step === "Open the form." ? `Open the form ${flow.trigger || ""}.` : step)),
    expected: ["Every control is usable and labeled.", "Validation rules are confirmed by QA."],
    safetyNote: "Never auto-submit; fabricated submissions can create bad data.",
  }),
  language: () => ({
    intent: "LANGUAGE", automation: "REVIEW", risk: "review",
    automationReason: "Switching locale changes the entire page; assertion rules depend on the destination copy and must be reviewed.",
    preconditions: () => ["The destination locale is supported."],
    steps: flow => ["Locate the language control.", "Switch to the alternate locale.", "Verify the document lang/direction changes.", "Verify key navigation still resolves."].map(step => (step === "Locate the language control." ? `Locate the language control ${flow.trigger || ""}.` : step)),
    expected: ["Language and direction attributes update.", "Copy changes consistently without dead links."],
    safetyNote: "Locale switching persists globally; review before automation.",
  }),
  media: () => ({
    intent: "MEDIA", automation: "REVIEW", risk: "review",
    automationReason: "Playback behavior depends on the media source and entitlements; automated assertions require reviewing the exact asset.",
    preconditions: () => ["A known playable asset is available."],
    steps: flow => ["Open the player.", "Start playback.", "Adjust volume and fullscreen.", "Verify captions if available."].map(step => (step === "Open the player." ? `Open the player ${flow.trigger || ""}.` : step)),
    expected: ["Playback starts without autoplay-block errors.", "Volume, fullscreen, and caption controls respond."],
    safetyNote: "Player controls are often conditional UI; verify a reveal interaction exists.",
  }),
  content: () => ({
    intent: "CONTENT", automation: "REVIEW", risk: "review",
    automationReason: "Listing and pagination behavior depends on backend data state; assertions must be reviewed.",
    preconditions: () => ["A populated listing exists."],
    steps: flow => ["Open the content listing.", "Scroll or page through items.", "Verify items render and links resolve."].map(step => (step === "Open the content listing." ? `Open the listing ${flow.trigger || ""}.` : step)),
    expected: ["Items render completely.", "Paging/load-more updates content without an uncaught error."],
  }),
  profile: () => ({
    intent: "PROFILE", automation: "REVIEW", risk: "review",
    automationReason: "Profile actions can read and write account state; automation requires a test account and review.",
    preconditions: () => ["A test account is available."],
    steps: flow => ["Open the profile trigger.", "Verify profile data renders.", "Under review: exercise safe, non-destructive account actions."].map(step => (step === "Open the profile trigger." ? `Open the profile trigger ${flow.trigger || ""}.` : step)),
    expected: ["Profile data renders correctly.", "Non-destructive actions behave predictably."],
    safetyNote: "Do not automate destructive account or payment actions.",
  }),
  error: () => ({
    intent: "ERROR_HANDLING", automation: "MANUAL", risk: "review",
    automationReason: "Error handling requires human investigation of the root cause and the product's user-facing messaging.",
    preconditions: () => ["The failing condition is reproduced."],
    steps: flow => ["Reproduce the failure.", "Confirm the user-visible error message.", "Trace the root cause in the console/page logs."].map(step => (step === "Reproduce the failure." ? `Reproduce the failure (${flow.trigger || "see evidence"}).` : step)),
    expected: ["Users receive a helpful error message.", "The root cause is identified and tracked."],
    safetyNote: "Errors may indicate environment-specific failures; confirm before reporting as product defects.",
  }),
};

const intentScenario = (id: string, flow: UserFlow, template: FlowTemplate, related: string[]): IntentScenario => ({
  id,
  intent: template.intent,
  priority: INTENT_PRIORITY[template.intent],
  title: flow.title,
  description: flow.description,
  preconditions: template.preconditions(flow),
  steps: template.steps(flow),
  expected: template.expected,
  automation: template.automation,
  automationReason: template.automationReason,
  risk: template.risk,
  safetyNote: template.safetyNote,
  evidence: flow.evidence,
  relatedScenarios: related.slice(0, 8),
});

export function buildIntentScenarios(report: ScanReport, flows: UserFlow[], findings: QaFinding[], elementScenarios: GeneratedScenario[] = []): IntentScenario[] {
  const byIntent = new Map<IntentCategory, string[]>();
  for (const scenario of elementScenarios) {
    const intent = scenario.intent ?? intentFor(scenario);
    const list = byIntent.get(intent) ?? [];
    list.push(scenario.id);
    byIntent.set(intent, list);
  }
  const relatedFor = (flow: UserFlow, intent: IntentCategory): string[] => {
    const related = new Set(flow.relatedScenarios);
    for (const id of byIntent.get(intent) ?? []) related.add(id);
    return [...related];
  };

  const scenarios: IntentScenario[] = flows.map(flow => intentScenario(`SC-${flow.kind.toUpperCase()}-001`, flow, FLOW_TEMPLATES[flow.kind](flow), relatedFor(flow, FLOW_TEMPLATES[flow.kind](flow).intent)));

  // Fixed quality gates.
  const hasAccessibility = findings.some(finding => finding.domain === "accessibility");
  if (hasAccessibility) {
    scenarios.push({
      id: "SC-ACC-001", intent: "ACCESSIBILITY", priority: "P2",
      title: "Assistive technology can identify all interactive controls",
      description: "Accessibility findings exist. Verify every interactive control exposes a meaningful accessible name and that keyboard navigation reaches it.",
      preconditions: ["The page is loaded."],
      steps: ["Open the QA report's Accessibility section.", "Spot-check the failing controls with a screen reader / keyboard.", "Verify focus order and announced names."],
      expected: ["Every interactive control is announced meaningfully.", "Keyboard focus order is logical."],
      automation: "REVIEW", automationReason: "Screen-reader and keyboard verification is inherently manual.",
      risk: "review",
      evidence: [],
      relatedScenarios: [...(byIntent.get("ACCESSIBILITY") ?? [])].slice(0, 8),
    });
  }
  const hasForms = (report.page.forms ?? 0) > 0;
  if (hasForms) {
    scenarios.push({
      id: "SC-VAL-001", intent: "VALIDATION", priority: "P2",
      title: "Form fields validate user input",
      description: "The page contains forms. Verify required fields, format constraints, and cross-field rules present clear validation messages.",
      preconditions: ["The form is filled with invalid then valid values."],
      steps: ["Submit an empty form and record validation messages.", "Enter invalid formats and verify messages.", "Enter valid values and verify submission path."],
      expected: ["Invalid input shows clear, accessible validation messages.", "Valid input proceeds without unexpected errors."],
      automation: "REVIEW", automationReason: "Validation messages and constraints must be reviewed field-by-field.",
      risk: "review",
      evidence: (flows.find(flow => flow.kind === "form")?.evidence ?? []),
      relatedScenarios: [...(byIntent.get("VALIDATION") ?? [])].slice(0, 8),
    });
  }
  const responsive = report.page.viewport !== null && (report.summary.interactiveElements ?? 0) >= 5;
  if (responsive) {
    scenarios.push({
      id: "SC-RESP-001", intent: "RESPONSIVE", priority: "P3",
      title: "Layout remains usable at mobile width",
      description: "The page declares a responsive viewport and has enough interactive controls to matter. Verify no horizontal overflow or unreachable controls at a phone width.",
      preconditions: ["A mobile-width viewport (≈375px) is emulated."],
      steps: ["Resize/emulate a phone width.", "Scan for horizontal overflow and clipped controls.", "Verify tap targets remain reachable."],
      expected: ["No horizontal overflow.", "All primary controls reachable at mobile width."],
      automation: "REVIEW", automationReason: "Visual responsive QA requires human judgment.",
      risk: "review",
      evidence: [],
      relatedScenarios: [],
    });
  }
  return scenarios;
}