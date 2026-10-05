import { QaFinding, VerificationDisposition, VerificationStrategy } from "../ai/types.js";
import { IssueElement, ScanReport } from "../types.js";

// ---------------------------------------------------------------------------
// Verification task building (EXECUTOR scheduling).
//
// A verification task pairs one QA finding with the exact Playwright locator
// that can re-check the suspected problem on the live page. Tasks are only
// created for SAFE, non-interactive DOM checks. Findings whose locator cannot
// be reliably targeted (low quality or suspicious) are left unverified rather
// than forced into a brittle test — this is the false-positive guard.
// ---------------------------------------------------------------------------
export type VerificationTask = {
  scenarioId: string;
  findingId: string;
  strategy: VerificationStrategy;
  code: string;
  title: string;
  locator: string | null;
  elementIndex: number | null;
  expectation: string;
};

const STRATEGY_BY_CODE: Record<string, VerificationStrategy> = {
  "button-missing-name": "accessible-name",
  "a-missing-name": "accessible-name",
  "input-missing-label": "accessible-name",
  "password-missing-label": "accessible-name",
  "image-missing-alt": "image-alt",
  "duplicate-id": "duplicate-id",
  "missing-page-title": "document-title",
  "missing-lang": "language",
  "missing-viewport": "viewport",
  "empty-link": "empty-link",
  "input-missing-type": "input-type",
  "hidden-interactive-element": "visibility",
};

export const EXPECTATION_BY_STRATEGY: Record<VerificationStrategy, string> = {
  "accessible-name": "The element must expose an accessible name via aria-label, aria-labelledby, an associated label, img alt text, visible text, or a title attribute.",
  "image-alt": "The image must carry alt text or be explicitly decorative (role=presentation/none or alt=\"\").",
  "duplicate-id": "Every element id must be unique within the document.",
  "document-title": "The document must declare a non-empty <title> in <head>.",
  language: "The <html> element must declare a non-empty lang attribute.",
  viewport: "The document must declare a viewport meta tag.",
  "empty-link": "The link must have a destination href.",
  "input-type": "The input must declare an explicit type attribute.",
  visibility: "The interactive element must be visible in the rendered page (a hidden interactive control is conditional, not a confirmed defect).",
};

export function codesForStrategy(strategy: VerificationStrategy): string[] {
  return Object.entries(STRATEGY_BY_CODE).filter(([, value]) => value === strategy).map(([code]) => code);
}

const PAGE_LEVEL_STRATEGIES = new Set<VerificationStrategy>(["document-title", "language", "viewport"]);

export function isPageLevelStrategy(strategy: VerificationStrategy): boolean {
  return PAGE_LEVEL_STRATEGIES.has(strategy);
}

// buildLocator only ever emits these shapes; anything else is not inlinable.
const SAFE_LOCATOR = /^page\.(getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|locator)\(/;

export function isSafeLocator(locator: string | null): boolean {
  if (!locator) return false;
  if (locator.includes("?")) return false;
  return SAFE_LOCATOR.test(locator);
}

/** Why a finding was not executed. Recorded on every skip so the reason is
 *  traceable in JSON and HTML, not inferred. */
export type TaskSkipCause = "unsupported" | "unsafe-locator" | "ambiguous-locator" | "fragile-locator" | "no-reliable-locator";

export type TaskSkip = {
  findingId: string;
  code: string;
  scenarioId: string | null;
  disposition: VerificationDisposition;
  cause: TaskSkipCause;
  /** Human-readable explanation shown in reports. */
  reason: string;
  /** Safety classification of the would-be check: "safe" (non-interactive
   *  DOM probe) or "n/a" (no strategy exists at all). */
  safety: "safe" | "n/a";
  locator: string | null;
  elementIndex: number | null;
  /** Set only if an execution attempt was made (currently never for skips). */
  executedAt: string | null;
};

const DISPOSITION_BY_CAUSE: Record<TaskSkipCause, VerificationDisposition> = {
  unsupported: "SKIPPED_UNSUPPORTED",
  "unsafe-locator": "SKIPPED_LOCATOR_GUARD",
  "ambiguous-locator": "SKIPPED_LOCATOR_GUARD",
  "fragile-locator": "SKIPPED_LOCATOR_GUARD",
  "no-reliable-locator": "SKIPPED_LOCATOR_GUARD",
};

const makeSkip = (finding: QaFinding, cause: TaskSkipCause, reason: string, locator: string | null, elementIndex: number | null): TaskSkip => ({
  findingId: finding.id,
  code: finding.code,
  scenarioId: null,
  disposition: DISPOSITION_BY_CAUSE[cause],
  cause,
  reason,
  safety: cause === "unsupported" ? "n/a" : "safe",
  locator,
  elementIndex,
  executedAt: null,
});

const STABLE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Builds `page.locator(...)` from a stable scanned attribute (href/id) so a
 *  finding whose recommended locator is too brittle can still be checked. Only
 *  references that are UNIQUE within the scanned snapshot are used — an
 *  ambiguous reference is never executed. */
export function uniqueReferenceLocator(finding: QaFinding, report: ScanReport): { locator: string; elementIndex: number } | null {
  const candidates: { tag: string; href: string | null; id: string | null }[] = [];
  const primary = finding.evidence.find(ref => ref.type === "element");
  const uniq = (elements: IssueElement[], field: "href" | "id", value: string): boolean => elements.filter(element => element[field] === value).length === 1;

  if (primary?.index != null) {
    const element = report.elements[primary.index];
    if (element) candidates.push({ tag: element.tag, href: element.href, id: element.id });
  }
  for (const example of finding.examples ?? []) {
    if (example.element) candidates.push({ tag: example.element.tag, href: example.element.href, id: example.element.id });
  }

  for (const candidate of candidates) {
    if (candidate.tag === "a" && candidate.href) {
      const index = report.elements.findIndex(element => element.tag === "a" && element.href === candidate.href);
      if (index >= 0 && uniq(report.elements, "href", candidate.href)) {
        const selector = `a[href="${candidate.href.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
        return { locator: `page.locator(${JSON.stringify(selector)})`, elementIndex: index };
      }
    }
    if (candidate.id && STABLE_ID.test(candidate.id)) {
      const index = report.elements.findIndex(element => element.id === candidate.id);
      if (index >= 0 && uniq(report.elements, "id", candidate.id)) {
        return { locator: `page.locator("#${candidate.id}")`, elementIndex: index };
      }
    }
  }
  return null;
}

export function buildVerificationTasks(findings: QaFinding[], report: ScanReport): { tasks: VerificationTask[]; skipped: TaskSkip[] } {
  const tasks: VerificationTask[] = [];
  const skipped: TaskSkip[] = [];
  let sequence = 0;

  for (const finding of findings) {
    const strategy = STRATEGY_BY_CODE[finding.code];
    if (!strategy) {
      skipped.push(makeSkip(finding, "unsupported", `No safe verification strategy exists for the "${finding.code}" finding code — it is a signal for human review, not an executable DOM check.`, null, null));
      continue;
    }
    const elementRef = finding.evidence.find(ref => ref.type === "element");
    let locator: string | null = elementRef?.locator ?? null;
    let elementIndex: number | null = elementRef?.index ?? null;
    if (elementRef && elementIndex === null && locator) {
      elementIndex = report.elements.findIndex(element => element.recommendedLocator === locator);
      if (elementIndex >= 0) locator = report.elements[elementIndex].recommendedLocator;
    }

    if (isPageLevelStrategy(strategy)) {
      locator = null;
      elementIndex = null;
    } else {
      let cause: TaskSkipCause | null = null;
      let detail = "";
      if (locator?.includes("?")) { cause = "ambiguous-locator"; detail = "The scanner emitted an ambiguous placeholder locator (\"?\", no real name/text to target)."; }
      else if (!isSafeLocator(locator)) { cause = "unsafe-locator"; detail = "The locator is not emitted by the safe locator builder (it may call unsafe actions or use unquotable selectors)."; }
      else if (elementIndex !== null && report.elements[elementIndex]?.locatorQuality === "low") { cause = "fragile-locator"; detail = "The scanned locator has low quality and is too brittle to automate without turning a scanner signal into a flaky failure."; }

      if (cause) {
        const reference = uniqueReferenceLocator(finding, report);
        if (reference) {
          locator = reference.locator;
          elementIndex = reference.elementIndex;
          cause = null;
        }
      }
      if (cause) {
        skipped.push(makeSkip(finding, cause, `${detail} No unique attribute-based reference (href/id) could be derived from the scanned evidence, so the check stays manual.`, locator, elementIndex));
        continue;
      }
    }

    tasks.push({
      scenarioId: `SC-VER-${String(++sequence).padStart(3, "0")}`,
      findingId: finding.id,
      strategy,
      code: finding.code,
      title: finding.title,
      locator,
      elementIndex,
      expectation: EXPECTATION_BY_STRATEGY[strategy],
    });
  }

  return { tasks, skipped };
}