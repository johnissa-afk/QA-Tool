import { DiscoveredElement, Issue, IssueElement } from "./types.js";

const snapshot = (element: DiscoveredElement): IssueElement => ({ tag: element.tag, role: element.role, text: element.text, ariaLabel: element.ariaLabel, accessibleName: element.accessibleName, id: element.id, testId: element.testId, type: element.type, name: element.name, placeholder: element.placeholder, href: element.href, alt: element.alt, visible: element.visible, enabled: element.enabled, recommendedLocator: element.recommendedLocator, locatorQuality: element.locatorQuality });

// Images with an empty alt attribute or an explicitly decorative role carry no
// information and are intentionally excluded from the alt-text warning.
const isDecorativeImage = (element: DiscoveredElement): boolean => {
  if (["presentation", "none"].includes(element.role ?? "")) return true;
  return element.alt !== null && element.alt.trim() === "";
};

export function detectIssues(elements: DiscoveredElement[], metadata: { title: string; lang: string | null; viewport: string | null }): Issue[] {
  const issues: Issue[] = [];
  if (!metadata.title.trim()) issues.push({ status: "WARNING", code: "missing-page-title", message: "The document has no page title." });
  if (!metadata.lang) issues.push({ status: "WARNING", code: "missing-lang", message: "The html element has no lang attribute." });
  if (!metadata.viewport) issues.push({ status: "WARNING", code: "missing-viewport", message: "No viewport meta tag was found." });
  const ids = new Map<string, DiscoveredElement[]>();
  for (const element of elements) {
    if (element.id) { const affected = ids.get(element.id) ?? []; affected.push(element); ids.set(element.id, affected); }
    if (element.tag === "img" && element.alt === null && !isDecorativeImage(element)) issues.push({ status: "WARNING", code: "image-missing-alt", message: "Image has no meaningful alt text.", element: snapshot(element) });
    if (["button", "a"].includes(element.tag) && element.interactive && !element.accessibleName) issues.push({ status: "WARNING", code: `${element.tag}-missing-name`, message: `${element.tag === "a" ? "Link" : "Button"} has no accessible name.`, element: snapshot(element) });
    if (["input", "textarea", "select"].includes(element.tag) && !["hidden", "submit", "button", "reset"].includes(element.type ?? "") && !element.accessibleName) issues.push({ status: "WARNING", code: "input-missing-label", message: "Form control has no accessible label.", element: snapshot(element) });
    if (element.tag === "input" && !element.hasExplicitType) issues.push({ status: "INFO", code: "input-missing-type", message: "Input relies on the browser's default text type.", element: snapshot(element) });
    if (element.tag === "a" && !element.href) issues.push({ status: "WARNING", code: "empty-link", message: "Link has no href.", element: snapshot(element) });
    if (element.interactive && !element.enabled) issues.push({ status: "INFO", code: "disabled-interactive-element", message: "Interactive element is disabled.", element: snapshot(element) });
    if (element.interactive && !element.visible) issues.push({ status: "INFO", code: "hidden-interactive-element", message: "Interactive element is hidden.", element: snapshot(element) });
    if (element.interactive && element.locatorQuality === "low") issues.push({ status: "INFO", code: "fragile-locator", message: "A stable Playwright locator could not be inferred.", element: snapshot(element) });
    if (element.type === "password" && !element.accessibleName) issues.push({ status: "WARNING", code: "password-missing-label", message: "Password input has no accessible label.", element: snapshot(element) });
    if (element.type === "password" && !element.autocomplete) issues.push({ status: "INFO", code: "password-missing-autocomplete", message: "Password input has no autocomplete hint.", element: snapshot(element) });
  }
  for (const [id, affected] of ids) {
    if (affected.length < 2) continue;
    issues.push({ status: "FAIL", code: "duplicate-id", message: `The id ${JSON.stringify(id)} appears ${affected.length} times.`, occurrences: affected.length, examples: affected.map(element => ({ element: snapshot(element) })) });
  }
  return issues;
}

/** Consolidates repeated element-level findings without hiding representative evidence. */
export function groupIssues(issues: Issue[], maxExamples = 5): Issue[] {
  const groups = new Map<string, Issue>();
  for (const issue of issues) {
    const key = `${issue.status}|${issue.code}|${issue.message}`;
    const existing = groups.get(key);
    const example = issue.element ? { element: issue.element } : undefined;
    if (!existing) {
      groups.set(key, { ...issue, count: issue.count ?? 1, examples: (issue.examples ?? (example ? [example] : [])).slice(0, maxExamples) });
      continue;
    }
    existing.count = (existing.count ?? 1) + (issue.count ?? 1);
    if (example && (existing.examples?.length ?? 0) < maxExamples) existing.examples?.push(example);
    for (const extra of issue.examples ?? []) if ((existing.examples?.length ?? 0) < maxExamples) existing.examples?.push(extra);
  }
  return [...groups.values()];
}
