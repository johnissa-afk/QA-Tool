import { FlowCategory, FlowFailureCategory, FlowPriority, FlowSafety, FlowAutomation, FlowStepOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Deterministic classification for flow steps, priorities, and execution
// failures. Nothing here depends on a specific website: all patterns are
// language-free or generic UI conventions. Any step that is not provably safe
// to automate is classified REVIEW / HIGH_RISK / BLOCKED by default.
// ---------------------------------------------------------------------------

export type FlowStepKind =
  | "navigate"
  | "search"
  | "language"
  | "media"
  | "auth"
  | "signup"
  | "profile"
  | "form"
  | "destructive"
  | "observe"
  | "unknown";

export type StepControl = {
  tag: string;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  href: string | null;
  type: string | null;
  /** Control belongs to a form that also contains a password field. */
  inAuthForm: boolean;
  /** Control triggers the site search (search box itself, or its submit). */
  isSearch: boolean;
  visible: boolean;
  /** Locator came from the safe locator builder (buildLocator emit shape). */
  safeLocator: boolean;
  /** href points to a different origin. */
  isExternal: boolean;
};

export type StepClassification = {
  safety: FlowSafety;
  automation: FlowAutomation;
  stepKind: FlowStepKind;
  reason: string;
};

export const DESTRUCTIVE_HREF =
  /(logout|sign.?out|\/delete|\/remove|\/cancel|checkout|paypal|\/pay\b|\/purchase|\/subscribe|unsubscribe|terminate|close.?account|deactivate)/i;
export const DESTRUCTIVE_TEXT =
  /(delete|remove|erase|pay\b|purchase|checkout|buy\b|place order|confirm order|terminate|close account|cancel subscription|refund|charge\b|unsubscribe|deactivate|end subscription)/i;
export const AUTH_TEXT = /(sign in|log in|login|sign in\/register)/i;
export const SIGNUP_TEXT = /(sign up|register|create account|create (a )?(free )?account|signup)/i;
export const PROFILE_TEXT = /(my account|profile|account settings|my profile|dashboard)/i;
export const MEDIA_TEXT = /(play|pause|mute|unmute|volume|full.?screen|captions|subtitles|watch trailer)/i;
export const SEARCH_TEXT = /search|بحث/;
export const LANGUAGE_TEXT = /^(en|ar|fr|de|es|it|pt|ru|tr|zh|中文|العربية|français|francais|deutsch|español|espanol|italiano|русский|türkçe|turkce|português|portugues|english|arabic)$/i;
export const LANGUAGE_HREF = /(\?|\&)(lang|locale|language|set.?lang|ChangeLanguageCultures?)=/i;

const SAFETY_RANK: Record<FlowSafety, number> = { SAFE: 0, REVIEW: 1, HIGH_RISK: 2, BLOCKED: 3 };
const AUTOMATION_RANK: Record<FlowAutomation, number> = { AUTOMATED: 0, REVIEW: 1, MANUAL: 2 };

export function isWorseSafety(a: FlowSafety, b: FlowSafety): boolean {
  return SAFETY_RANK[a] > SAFETY_RANK[b];
}
export function isWorseAutomation(a: FlowAutomation, b: FlowAutomation): boolean {
  return AUTOMATION_RANK[a] > AUTOMATION_RANK[b];
}

export function isExecutableStep(pick: { safety: FlowSafety; automation: FlowAutomation }): boolean {
  return pick.safety === "SAFE" && pick.automation === "AUTOMATED";
}

export function flowBoundaryReason(pick: { safety: FlowSafety; automation: FlowAutomation; reason: string }): string {
  if (pick.automation !== "AUTOMATED" && pick.safety !== "SAFE") {
    return `Not executable — ${pick.reason}`;
  }
  if (pick.automation !== "AUTOMATED") {
    return `Requires human review (${pick.automation}) — ${pick.reason}`;
  }
  return `Unsafe to automate (${pick.safety}) — ${pick.reason}`;
}

export function isAuthHref(href: string | null): boolean {
  if (!href) return false;
  return /(login|signin|sign-in|auth|logon)/i.test(href.replace(/[/?#].*$/, "")) || /login|signin|sign-in/i.test(href);
}

export function isExternalHref(href: string | null, base: string): boolean {
  if (!href) return false;
  try {
    return new URL(href, base).origin !== new URL(base).origin;
  } catch {
    return false;
  }
}

const languageLabel = (control: StepControl): boolean => {
  const text = control.accessibleName ?? control.text ?? "";
  if (LANGUAGE_TEXT.test(text.trim())) return true;
  if (control.href && LANGUAGE_HREF.test(control.href)) return true;
  return false;
};

/** Deterministic step classification. Order matters: the first rule that
 *  matches wins and later (weaker) rules never override a raised safety. */
export function classifyStep(control: StepControl): StepClassification {
  const tag = control.tag.toLowerCase();
  const type = control.type?.toLowerCase() ?? "";
  const name = control.accessibleName ?? control.text ?? "";
  const lowerName = name.toLowerCase();

  // 1. Credential fields are never touched.
  if (tag === "input" && type === "password") {
    return { safety: "HIGH_RISK", automation: "MANUAL", stepKind: "auth", reason: "credential input (password) — never auto-filled" };
  }

  // 2. Site search: typing a benign synthetic term is the safest real action.
  if (tag === "input" && (type === "search" || type === "text") && (control.isSearch || SEARCH_TEXT.test(lowerName) || control.role === "searchbox")) {
    if (control.inAuthForm) return { safety: "REVIEW", automation: "MANUAL", stepKind: "search", reason: "search control inside an authentication form — not auto-filled" };
    return { safety: "SAFE", automation: "AUTOMATED", stepKind: "search", reason: "site search box accepts a synthetic benign term (never real credentials)" };
  }

  // 3. Search submit triggers the safe search.
  if (control.isSearch && (tag === "button" || tag === "input" || tag === "a")) {
    return { safety: "SAFE", automation: "AUTOMATED", stepKind: "search", reason: "submits the site search only (no arbitrary form submission)" };
  }

  // 4. Anchors: a same-origin link is safe navigation; external stays recorded but is not auto-followed.
  if (tag === "a" && control.href) {
    if (DESTRUCTIVE_HREF.test(control.href)) {
      return { safety: "HIGH_RISK", automation: "MANUAL", stepKind: "destructive", reason: "link target matches a destructive/account-affecting pattern — never auto-followed" };
    }
    if (control.isExternal) {
      return { safety: "SAFE", automation: "REVIEW", stepKind: "navigate", reason: "external destination recorded for review; not auto-followed" };
    }
    if (!control.safeLocator) {
      return { safety: "REVIEW", automation: "MANUAL", stepKind: "navigate", reason: "same-origin link but no fragile-free unambiguous locator could be derived — reviewed manually" };
    }
    return { safety: "SAFE", automation: "AUTOMATED", stepKind: "navigate", reason: "same-origin link — safe to open" };
  }

  // 5. Language switch controls.
  if (control.role === "button" && languageLabel(control)) {
    return { safety: "SAFE", automation: "AUTOMATED", stepKind: "language", reason: "explicit language control — safe to toggle" };
  }

  // 6. Media playback controls: idempotent, but auto-play is left to review.
  if (tag === "video" || tag === "audio" || (MEDIA_TEXT.test(lowerName) && control.role === "button")) {
    return { safety: "REVIEW", automation: "MANUAL", stepKind: "media", reason: "media playback — auditable only, never auto-started" };
  }

  // 7. Authentication/signup/profile affordances.
  if (AUTH_TEXT.test(lowerName) || isAuthHref(control.href)) {
    return { safety: "REVIEW", automation: "MANUAL", stepKind: "auth", reason: "login flow discovered but credentials are never submitted automatically" };
  }
  if (SIGNUP_TEXT.test(lowerName)) {
    return { safety: "REVIEW", automation: "MANUAL", stepKind: "signup", reason: "signup flow discovered but registration is never completed automatically" };
  }
  if (PROFILE_TEXT.test(lowerName)) {
    return { safety: "REVIEW", automation: "MANUAL", stepKind: "profile", reason: "profile/account page may require a session — reviewed manually" };
  }

  // 8. Destructive text on any control.
  if (DESTRUCTIVE_TEXT.test(lowerName)) {
    return { safety: "HIGH_RISK", automation: "MANUAL", stepKind: "destructive", reason: "control label matches a destructive/payment pattern — never automated" };
  }

  // 9. Form submission (non-search) is a side-effect boundary.
  if (control.role === "button" && (type === "submit" || tag === "button" || tag === "input")) {
    if (control.inAuthForm) {
      return { safety: "BLOCKED", automation: "MANUAL", stepKind: "auth", reason: "submits the authentication/signup form — BLOCKED by default" };
    }
    return { safety: "HIGH_RISK", automation: "MANUAL", stepKind: "form", reason: "arbitrary form submission — never automated" };
  }

  // 10. Ambiguous or structureless controls stay manual.
  if (!control.safeLocator) {
    return { safety: "REVIEW", automation: "MANUAL", stepKind: "unknown", reason: "no safe/unambiguous locator could be derived for this control" };
  }
  return { safety: "REVIEW", automation: "MANUAL", stepKind: "unknown", reason: "control has unknown side effects — reviewed manually" };
}

export function priorityForFlow(category: FlowCategory): { priority: FlowPriority; reason: string } {
  switch (category) {
    case "ERROR_HANDLING":
      return { priority: "P0", reason: "P0 — broken destinations affect every user journey; verify navigation error handling first." };
    case "AUTHENTICATION":
      return { priority: "P1", reason: "P1 — the login path gates the whole site; observe the boundary safely." };
    case "SEARCH":
      return { priority: "P1", reason: "P1 — search is a primary discovery path for most sites." };
    case "NAVIGATION":
      return { priority: "P2", reason: "P2 — core navigation links underpin all other flows." };
    case "LANGUAGE_SWITCH":
      return { priority: "P2", reason: "P2 — language switching affects content reachability." };
    case "SIGNUP":
      return { priority: "P2", reason: "P2 — registration path is critical, observed without completing it." };
    case "CONTENT_DISCOVERY":
      return { priority: "P3", reason: "P3 — content detail pages are secondary to core navigation." };
    case "FORM_INTERACTION":
      return { priority: "P3", reason: "P3 — non-search forms are observed but never submitted." };
    case "MEDIA":
      return { priority: "P3", reason: "P3 — media playback is auditable by review." };
    case "PROFILE":
      return { priority: "P3", reason: "P3 — profile pages are session-dependent and reviewed manually." };
    default:
      return { priority: "P4", reason: "P4 — low-priority flow category." };
  }
}

export function classifyFlowFailure(error: unknown): { outcome: FlowStepOutcome; category: FlowFailureCategory; type: string; message: string } {
  const message = String(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();
  const redacted = message.slice(0, 1000);

  if (/(?:^|\D)4\d\d(?:$|\D)/.test(redacted) && /http status|net::|response|status|unauthorized|forbidden/i.test(lower)) {
    return { outcome: "REVIEW_REQUIRED", category: "AUTH", type: "AUTH_FAILED", message: redacted };
  }
  if (/net::|timeout|timed out|dns|getaddrinfo|certificate|ssl|tunnel|connection refus|econn|related document|navigation aborted|target closed|browser has disconnected|execution context was destroyed|page crashed/i.test(lower)) {
    return { outcome: "INFRASTRUCTURE_PROBLEM", category: "INFRASTRUCTURE", type: "NETWORK", message: redacted };
  }
  if (/strict mode violation|resolved to \d+ elements/i.test(lower)) {
    return { outcome: "REVIEW_REQUIRED", category: "LOCATOR", type: "AMBIGUOUS_LOCATOR", message: redacted };
  }
  if (/not found|waiting for|did not find|no element|not visible|is hidden/i.test(lower)) {
    return { outcome: "NOT_REPRODUCED", category: "LOCATOR", type: "ELEMENT_NOT_FOUND", message: redacted };
  }
  return { outcome: "REVIEW_REQUIRED", category: "REVIEW", type: "UNKNOWN", message: redacted };
}