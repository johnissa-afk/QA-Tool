import { DiscoveredElement, GeneratedScenario, ScanReport } from "../types.js";
import { EvidenceRef, FlowKind, FlowStatus, UserFlow } from "./types.js";

// ---------------------------------------------------------------------------
// Deterministic user-flow detection.
//
// Flows are derived purely from scanner evidence (roles, types, controls, hrefs,
// console diagnostics, broken links). No intent is invented: a flow exists only
// when concrete DOM/user signals support it. Confidence reflects how direct the
// signal is (role/type matches beat term matches in placeholder text).
// ---------------------------------------------------------------------------
type Match = { element: DiscoveredElement; index: number };

const elementMatch = (report: ScanReport, index: number): Match => ({ element: report.elements[index]!, index });

const TEXTPATTERNS = [
  /search|بحث|ابحث|search box/i,
  /sign up|register|join now|create an account|create account|subscribe|start free|get started/i,
  /my account|my profile|account|profile|avatar|watchlist|favorites|history|settings/i,
  /episode|load more|show more|read more|see all|watch|series|season|movie/i,
  /player|volume|fullscreen|play|pause|captions?|subtitles/i,
  /عربي|العربية|english|français|french|language|اللغة/i,
] as const;

const matchesAny = (element: DiscoveredElement, pattern: RegExp): boolean =>
  [element.accessibleName, element.name, element.placeholder, element.text].some(value => Boolean(value && pattern.test(value)));

const hasHrefPattern = (element: DiscoveredElement, pattern: RegExp): boolean =>
  Boolean(element.href && pattern.test(element.href));

const collect = (matches: Match[], flow: Omit<UserFlow, "elements" | "evidence">): UserFlow => ({
  ...flow,
  elements: matches.slice(0, 4).map(match => ({
    locator: match.element.recommendedLocator,
    accessibleName: match.element.accessibleName,
    role: match.element.role,
    visible: match.element.visible,
  })),
  evidence: matches.slice(0, 4).map(match => elementRef(match.index, match.element)),
});

const elementRef = (index: number, element: DiscoveredElement): EvidenceRef =>
  ({ type: "element", index, locator: element.recommendedLocator, accessibleName: element.accessibleName ?? undefined, tag: element.tag });

export function detectFlows(report: ScanReport): UserFlow[] {
  const flowing: UserFlow[] = [];
  const elements = report.elements.map((element, index) => ({ element, index })).filter(item => item.element.interactive);
  const indexed = (list: typeof elements): Match[] => list.map(item => elementMatch(report, item.index));

  // Search ------------------------------------------------------------------
  const search = indexed(elements.filter(item => item.element.role === "searchbox" || item.element.type === "search" || matchesAny(item.element, TEXTPATTERNS[0])));
  if (search.length > 0) {
    const direct = search.some(match => match.element.role === "searchbox" || match.element.type === "search");
    flowing.push(collect(search, {
      id: "UF-SEARCH-001",
      kind: "search",
      title: "Search for content",
      description: "The page exposes a search control. Verify that a search for a benign query returns relevant results and responds without errors.",
      confidence: direct ? "high" : "medium",
      status: "identified",
      trigger: search[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Login -------------------------------------------------------------------
  const login = indexed(elements.filter(item => item.element.type === "password"));
  if (login.length > 0) {
    flowing.push(collect(login, {
      id: "UF-LOGIN-001",
      kind: "login",
      title: "Sign in",
      description: "A password field is present, indicating an authentication flow. Verify sign-in with valid credentials and graceful handling of invalid credentials.",
      confidence: "high",
      status: "identified",
      trigger: login[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Signup ------------------------------------------------------------------
  const signup = indexed(elements.filter(item => matchesAny(item.element, TEXTPATTERNS[1]) || (item.element.autocomplete ?? "").startsWith("new-password-")));
  if (signup.length > 0) {
    flowing.push(collect(signup, {
      id: "UF-SIGNUP-001",
      kind: "signup",
      title: "Registration / sign up",
      description: "A registration affordance is present. Verify account creation, input validation, and confirmation guidance manually with test accounts.",
      confidence: "medium",
      status: "identified",
      trigger: signup[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Form --------------------------------------------------------------------
  const controls = elements.filter(item => ["input", "select", "textarea"].includes(item.element.tag) && item.element.type !== "hidden");
  const forms = report.page.forms ?? 0;
  if (forms > 0 && controls.length >= 2) {
    flowing.push(collect(controls, {
      id: "UF-FORM-001",
      kind: "form",
      title: "Complete a form",
      description: `The page contains ${forms} form(s) with ${controls.length} interactive control(s). Verify validation rules and submission behavior manually; generated tests never submit forms.`,
      confidence: "high",
      status: "identified",
      trigger: controls[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Language ----------------------------------------------------------------
  const language = indexed(elements.filter(item => hasHrefPattern(item.element, /set-lang|\/(ar|en|fr|de|es|it|pt|ru|tr|zh|hi|nl)\b/i) || matchesAny(item.element, TEXTPATTERNS[5])));
  if (language.length > 0) {
    const direct = language.some(match => hasHrefPattern(match.element, /set-lang/i));
    flowing.push(collect(language, {
      id: "UF-LANG-001",
      kind: "language",
      title: "Switch language",
      description: "Language-switching controls are present. Verify locale switching updates the document language, direction, and surrounding copy.",
      confidence: direct ? "high" : "medium",
      status: "identified",
      trigger: language[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Media -------------------------------------------------------------------
  const media = indexed(elements.filter(item => ["video", "audio"].includes(item.element.tag) || matchesAny(item.element, TEXTPATTERNS[4])));
  if (media.length > 0 || (report.page.media ?? 0) > 0) {
    const direct = media.some(match => ["video", "audio"].includes(match.element.tag));
    flowing.push(collect(media, {
      id: "UF-MEDIA-001",
      kind: "media",
      title: "Watch / play media",
      description: "Media controls are present. Verify playback starts, volume and fullscreen work, and captions are available where expected.",
      confidence: direct ? "high" : "medium",
      status: "identified",
      trigger: media[0]?.element.recommendedLocator ?? "media elements",
      relatedScenarios: [],
    }));
  }

  // Content -----------------------------------------------------------------
  const content = indexed(elements.filter(item => matchesAny(item.element, TEXTPATTERNS[3])));
  if (content.length > 0) {
    flowing.push(collect(content, {
      id: "UF-CONTENT-001",
      kind: "content",
      title: "Browse content",
      description: "Content-browsing affordances (episodes, paging, load-more, listings) are present. Verify listings render and pagination behaves.",
      confidence: "medium",
      status: "identified",
      trigger: content[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Profile -----------------------------------------------------------------
  const profile = indexed(elements.filter(item => matchesAny(item.element, TEXTPATTERNS[2])));
  if (profile.length > 0) {
    flowing.push(collect(profile, {
      id: "UF-PROFILE-001",
      kind: "profile",
      title: "Manage profile",
      description: "Account/profile affordances are present. Verify profile viewing and, under review, account actions.",
      confidence: "medium",
      status: "identified",
      trigger: profile[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Navigation --------------------------------------------------------------
  const nav = indexed(elements.filter(item => item.element.tag === "a" && item.element.href && /^https?:/i.test(item.element.href)));
  if (nav.length > 0) {
    flowing.push(collect(nav, {
      id: "UF-NAV-001",
      kind: "navigation",
      title: "Primary navigation",
      description: `The page exposes ${nav.length} HTTP link(s). Verify the main navigation resolves without errors (coverage is captured by SC-NAV-INTEGRITY).`,
      confidence: "high",
      status: "identified",
      trigger: nav[0]!.element.recommendedLocator,
      relatedScenarios: [],
    }));
  }

  // Error handling ----------------------------------------------------------
  const pageErrors = report.pageErrors.length;
  const broken = report.summary.brokenLinks;
  const firstParty = report.consoleDiagnostics.filter(item => item.category === "first-party").length;
  if (pageErrors > 0 || broken > 0 || firstParty > 0) {
    const reasons: string[] = [];
    if (broken > 0) reasons.push(`${broken} broken link(s)`);
    if (pageErrors > 0) reasons.push(`${pageErrors} uncaught page error(s)`);
    if (firstParty > 0) reasons.push(`${firstParty} first-party console error(s)`);
    let blockReason: string | undefined;
    let status: FlowStatus = "identified";
    if (pageErrors > 0) {
      status = "blocked";
      blockReason = "Uncaught page errors may indicate unstable application state; investigate before relying on this environment.";
    }
    flowing.push({
      id: "UF-ERR-001",
      kind: "error",
      title: "Handle errors gracefully",
      description: `${reasons.join(", ")} were detected. Verify the product shows helpful errors rather than blank or broken states.`,
      confidence: pageErrors > 0 ? "high" : "medium",
      status,
      blockReason,
      trigger: reasons.join("; "),
      elements: [],
      evidence: [{ type: "page", index: pageErrors > 0 ? 0 : null }],
      relatedScenarios: [],
    });
  }

  return flowing;
}

export function relateFlows(flows: UserFlow[], elementScenarios: GeneratedScenario[]): UserFlow[] {
  const byName = new Map<string, string[]>();
  for (const scenario of elementScenarios) {
    const name = scenario.sourceElement.accessibleName?.trim();
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(scenario.id);
    byName.set(name, list);
  }
  return flows.map(flow => {
    const related = new Set<string>();
    for (const item of flow.elements) {
      if (item.accessibleName) for (const id of byName.get(item.accessibleName.trim()) ?? []) related.add(id);
      if (item.locator) {
        const byLocator = elementScenarios.filter(scenario => scenario.locator === item.locator).map(scenario => scenario.id);
        for (const id of byLocator) related.add(id);
      }
    }
    return { ...flow, relatedScenarios: [...related].slice(0, 8) };
  });
}