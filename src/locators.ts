import { DiscoveredElement, LocatorQuality } from "./types.js";

const quote = (value: string) => JSON.stringify(value);
const stableId = (id: string | null) => Boolean(id && !/^(?:[a-f0-9]{8,}|[a-z]+[-_]?\d{4,})$/i.test(id));

export function buildLocator(element: Omit<DiscoveredElement, "recommendedLocator" | "locatorQuality">): { recommendedLocator: string; locatorQuality: LocatorQuality } {
  const name = element.accessibleName;
  const role = element.role;
  if (role && name) return { recommendedLocator: `page.getByRole(${quote(role)}, { name: ${quote(name)} })`, locatorQuality: "high" };
  if (element.tag === "input" && element.ariaLabel) return { recommendedLocator: `page.getByLabel(${quote(element.ariaLabel)})`, locatorQuality: "high" };
  if (element.placeholder) return { recommendedLocator: `page.getByPlaceholder(${quote(element.placeholder)})`, locatorQuality: "high" };
  if (element.text && ["button", "link", "heading"].includes(role ?? "")) return { recommendedLocator: `page.getByText(${quote(element.text)}, { exact: true })`, locatorQuality: "medium" };
  if (element.testId) return { recommendedLocator: `page.getByTestId(${quote(element.testId)})`, locatorQuality: "high" };
  if (element.name) return { recommendedLocator: `page.locator(${quote(`${element.tag}[name=${quote(element.name)}]`)})`, locatorQuality: "medium" };
  if (stableId(element.id)) return { recommendedLocator: `page.locator(${quote(`#${element.id}`)})`, locatorQuality: "medium" };
  if (element.type) return { recommendedLocator: `page.locator(${quote(`${element.tag}[type=${quote(element.type)}]`)})`, locatorQuality: "low" };
  return { recommendedLocator: `page.locator(${quote(element.tag)})`, locatorQuality: "low" };
}
