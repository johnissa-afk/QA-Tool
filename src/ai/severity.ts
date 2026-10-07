import { Issue } from "../types.js";
import { PERF_METRIC_LABELS, isPerfBudgetCode, perfBudgetMetricOf } from "../perf-budgets.js";
import { Confidence, Severity } from "./types.js";

// ---------------------------------------------------------------------------
// Deterministic severity rubric.
//
// Every finding gets a severity, confidence, rationale, recommendation, and
// user impact computed purely from scanner evidence. The rubric is an ordered
// rule list (first match wins) so each decision is explainable and stable.
//
// AI enhancement may only move a severity one adjacent step from here and may
// never invent evidence — the deterministic verdict is the safety baseline.
// ---------------------------------------------------------------------------
export type SeverityContext = {
  navigationStatus: number | null;
  authenticationAccepted: boolean;
  interactiveElementCount: number;
  brokenLinkCount: number;
};

export type SeverityVerdict = {
  severity: Severity;
  confidence: Confidence;
  rationale: string;
  recommendation: string;
  userImpact: string;
};

export const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

export const isLikelyInteractive = (tag: string | undefined): boolean =>
  Boolean(tag && ["input", "textarea", "select", "button", "a"].includes(tag));

const NAME_CODES = ["button-missing-name", "a-missing-name", "input-missing-label", "password-missing-label"] as const;

const rec = { missingLabel: "Add an accessible name (an associated <label>, aria-label, or visible text) so assistive technology and Playwright can target the control reliably." };

const NAME_RECOMMENDATIONS: Record<string, string> = {
  "button-missing-name": "Add visible text or aria-label to the button so screen readers announce its purpose.",
  "a-missing-name": "Add link text or an aria-label describing the link destination.",
  "input-missing-label": "Associate a <label> element (or aria-label) with the input so its purpose is exposed to assistive technology.",
  "password-missing-label": rec.missingLabel,
};

const NAME_IMPACT = "Users relying on a screen reader cannot tell what this control does, and automation cannot target it reliably.";
const NAME_RATIONALE = { visible: (label: string) => `${label} was visible on the page without an accessible name.`, hidden: (label: string) => `${label} was hidden or disabled at scan time, so the accessibility impact is deferred until it becomes usable.` };

export function classifyIssue(issue: Issue, ctx: SeverityContext): SeverityVerdict {
  const code = issue.code;
  const element = issue.element;
  const visible = element?.visible !== false && element?.enabled !== false;

  // Phase 13: a performance-budget breach violates a threshold the team wrote
  // down. Exceeding it is a release-blocking requirement violation, so it is
  // CRITICAL and the run reads FAIL under the default --fail-on failed policy:
  // a budget that could pass silently would not be a gate.
  if (isPerfBudgetCode(code)) {
    const metric = PERF_METRIC_LABELS[perfBudgetMetricOf(code) ?? "lcp"];
    return {
      severity: "CRITICAL",
      confidence: "high",
      rationale: `${issue.message}. The ${metric} was compared against a performance budget declared for this QA target and exceeded it.`,
      recommendation: `Bring ${metric} back within its declared budget, or raise the threshold in the performance budgets file as an explicit, reviewed decision - never by ignoring the breach.`,
      userImpact: `Users experience a ${metric} worse than the level the team agreed to ship.`,
    };
  }

  switch (code) {
    case "access-prerequisite":
      return {
        severity: "INFO",
        confidence: "high",
        rationale: "Access detection found an authentication, login, access-control, or bot-protection prerequisite before normal scanning.",
        recommendation: "Provide an approved authenticated session or review the access policy before scanning the target.",
        userImpact: "Automated QA cannot inspect the application until the access prerequisite is resolved.",
      };
    case "page-http-error": {
      const status = ctx.navigationStatus;
      return {
        severity: "CRITICAL",
        confidence: "high",
        rationale: status ? `The page navigation itself failed with HTTP ${status}, so the entire QA result is unreliable.` : "The page navigation returned an HTTP error status.",
        recommendation: "Investigate the server, routing, and deployment immediately; the page cannot be used until navigation succeeds.",
        userImpact: "Users attempting to reach the site receive an error page; every feature is affected.",
      };
    }
    case "authentication-failed": {
      return {
        severity: "CRITICAL",
        confidence: "high",
        rationale: "Navigation returned HTTP 401 and authentication was not accepted, blocking access to the QA target.",
        recommendation: "Confirm the configured credentials are valid and accepted by the environment before any further QA.",
        userImpact: "The whole application may be gated behind a login the scanner could not satisfy.",
      };
    }
    case "unhealthy-link": {
      const count = ctx.brokenLinkCount;
      return {
        severity: count >= 3 ? "HIGH" : "MEDIUM",
        confidence: "high",
        rationale: `The scanner received an error response (or none) for ${count} of the checked URLs, so user navigation to those destinations will fail.`,
        recommendation: `Verify and repair the ${count} failing link(s); correct the destination URL or restore the target resource.`,
        userImpact: "Users following these links hit error pages or dead ends.",
      };
    }
    case "duplicate-id": {
      const interactive = (issue.examples ?? []).some(example => isLikelyInteractive(example.element?.tag));
      return {
        severity: interactive ? "HIGH" : "MEDIUM",
        confidence: "high",
        rationale: `The id ${JSON.stringify(issue.message.match(/"[^"]+"/)?.[0] ?? "")} appears multiple times in the DOM.${interactive ? " Affected elements are interactive, increasing the chance that scripts and labels resolve to the wrong node." : ""}`,
        recommendation: "Give each element a unique id; duplicate ids break label/id associations and DOM lookups.",
        userImpact: interactive ? "Labels, scripts, and in-page links may target the wrong element." : "Semantic ambiguity and brittle selectors; assistive tools may mis-identify nodes.",
      };
    }
  }

  if ((issue.element || (issue.examples?.length ?? 0) > 0) && NAME_CODES.includes(code as (typeof NAME_CODES)[number])) {
    const password = code === "password-missing-label";
    const label = code === "button-missing-name" ? "Button" : code === "a-missing-name" ? "Link" : password ? "Password field" : "Form control";
    if (visible && (ctx.authenticationAccepted || password)) {
      return {
        severity: "HIGH",
        confidence: "high",
        rationale: `${label} without an accessible name was visible in a ${password ? "credential" : "protected"} context, blocking screen-reader users and reliable automation of a core interaction.`,
        recommendation: NAME_RECOMMENDATIONS[code],
        userImpact: NAME_IMPACT,
      };
    }
    if (visible) {
      return {
        severity: "MEDIUM",
        confidence: "high",
        rationale: NAME_RATIONALE.visible(label),
        recommendation: NAME_RECOMMENDATIONS[code],
        userImpact: NAME_IMPACT,
      };
    }
    return {
      severity: "LOW",
      confidence: "medium",
      rationale: NAME_RATIONALE.hidden(label),
      recommendation: NAME_RECOMMENDATIONS[code],
      userImpact: "Deferred until the control is shown.",
    };
  }

  if (code === "image-missing-alt") {
    if (!visible) {
      return {
        severity: "LOW",
        confidence: "medium",
        rationale: "The image without alt text was hidden or decorative at scan time.",
        recommendation: "Add meaningful alt text describing the image purpose, or an empty alt for decorative images.",
        userImpact: "Screen-reader users may miss content the image conveys.",
      };
    }
    return {
      severity: "MEDIUM",
      confidence: "high",
      rationale: "A visible image carries no meaningful alt text.",
      recommendation: "Add meaningful alt text describing the image purpose, or an empty alt for decorative images.",
      userImpact: "Screen-reader users cannot understand the image content.",
    };
  }

  switch (code) {
    case "missing-page-title":
      return {
        severity: ctx.interactiveElementCount > 0 ? "MEDIUM" : "LOW",
        confidence: "high",
        rationale: "The document has no page title.",
        recommendation: "Add a unique, descriptive <title> for browser tabs, bookmarks, and screen-reader orientation.",
        userImpact: "Users and assistive tech cannot identify or switch between pages.",
      };
    case "missing-lang":
      return {
        severity: "LOW",
        confidence: "high",
        rationale: "The html element has no lang attribute, so assistive technology cannot choose the correct pronunciation rules.",
        recommendation: "Set a lang attribute (e.g., lang=\"en\") on the html element.",
        userImpact: "Screen readers may mispronounce content and auto-translation may misbehave.",
      };
    case "missing-viewport":
      return {
        severity: ctx.interactiveElementCount >= 5 ? "MEDIUM" : "LOW",
        confidence: "high",
        rationale: `No viewport meta tag was found${ctx.interactiveElementCount >= 5 ? ", and the page has a significant number of interactive controls to validate at mobile widths" : ""}.`,
        recommendation: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.",
        userImpact: "Mobile users get a zoomed-out desktop layout; responsive QA at small widths is unreliable.",
      };
    case "empty-link":
      return {
        severity: visible ? "MEDIUM" : "LOW",
        confidence: "high",
        rationale: "A link exists without an href, so it cannot navigate.",
        recommendation: "Provide an href or convert the element to a button that performs the intended action.",
        userImpact: "Users cannot follow the link; keyboard users are stranded.",
      };
    case "input-missing-type":
      return {
        severity: "LOW",
        confidence: "high",
        rationale: "The input relies on the browser default text type instead of declaring one.",
        recommendation: "Declare an explicit input type (email, tel, url, number...) so the correct keyboard and validation are used.",
        userImpact: "Mobile keyboards and validation behave generically for the wrong data format.",
      };
    case "fragile-locator":
      return {
        severity: "LOW",
        confidence: "high",
        rationale: "A stable locator could not be inferred, so automation cannot reliably target this element.",
        recommendation: "Add an id, aria-label, or data-testid so a stable automation reference exists.",
        userImpact: "Limited; documented so manual QA can provide a stable hook if the element matters.",
      };
    case "console-first-party-error": {
      return {
        severity: "MEDIUM",
        confidence: "medium",
        rationale: "A first-party console or resource error was emitted from the site under test, indicating an application defect.",
        recommendation: "Open the console reproduced, fix the emitting module, and re-verify.",
        userImpact: "May indicate broken features or blocked resources users will also hit.",
      };
    }
    case "console-network-error":
      return {
        severity: "LOW",
        confidence: "medium",
        rationale: "A network or resource error was observed in the console.",
        recommendation: "Verify the failing resource URL and its HTTP response.",
        userImpact: "Some resources may fail for end users depending on environment.",
      };
    case "console-third-party-error":
      return {
        severity: "INFO",
        confidence: "medium",
        rationale: "A third-party integration logged an error; it is outside the QA target's control but worth awareness.",
        recommendation: "Monitor third-party status; suppress or handle known benign errors.",
        userImpact: "None observed within the QA target.",
      };
    case "page-error":
      return {
        severity: "MEDIUM",
        confidence: "high",
        rationale: "An uncaught error was thrown during page load/interaction, which can break the application state.",
        recommendation: "Reproduce the uncaught error and fix the throwing code path.",
        userImpact: "Broken behavior or dead UI following the error.",
      };
    case "password-missing-autocomplete":
      return {
        severity: "LOW",
        confidence: "medium",
        rationale: "The password input has no autocomplete hint, so password managers and browser autofill cannot help reliably.",
        recommendation: "Add autocomplete=\"current-password\" (or \"new-password\" for registration) to the password input.",
        userImpact: "Users must type credentials manually on every session.",
      };
    case "screenshot-unavailable":
      return {
        severity: "INFO",
        confidence: "high",
        rationale: "The scanner could not capture a screenshot; the HTML report has no visual snapshot.",
        recommendation: "Re-run the scan in headed mode or check the output directory permissions.",
        userImpact: "No visual verification artifact for humans.",
      };
    case "screenshot-diff-error":
      return {
        severity: "INFO",
        confidence: "high",
        rationale: issue.message,
        recommendation: "Verify the baseline screenshot is readable and has the same dimensions.",
        userImpact: "Visual regression comparison could not be performed.",
      };
    case "visual-regression":
      return {
        severity: "HIGH",
        confidence: "high",
        rationale: issue.message,
        recommendation: "Review the visual difference and either fix the regression or update the baseline screenshot if the change is intentional.",
        userImpact: "The rendered page differs visually from the approved baseline.",
      };
  }

  // Hidden/disabled interactive elements and any future INFO codes default here.
  const hidden = code === "hidden-interactive-element";
  const disabled = code === "disabled-interactive-element";
  return {
    severity: hidden || disabled || code.startsWith("console-") ? "INFO" : "LOW",
    confidence: hidden || disabled ? "medium" : "low",
    rationale: hidden
      ? "An interactive element is hidden at scan time; treat it as conditional UI until a reveal interaction is identified."
      : disabled
        ? "An interactive element is disabled at scan time; the disabled state may be intentional."
        : "No specific severity rule matched; reviewed as informational.",
    recommendation: hidden
      ? "Confirm the conditional UI is intentional and label it once revealed."
      : disabled
        ? "Confirm the disabled state is intentional and that a reason is communicated to users."
        : "Review manually against the QA target.",
    userImpact: hidden ? "Conditional controls are not automatable against the initial load." : "Users cannot interact with the element while it is disabled.",
  };
}

export const prettyPercent = (value: number): string => `${Math.round(value * 100)}%`;