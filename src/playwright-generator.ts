import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GeneratedScenario, GeneratedTestSuite } from "./types.js";

const q = (value: string) => JSON.stringify(value);
const quoteName = (value: string) => value.replace(/"/g, `\\"`);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns a valid Playwright locator expression referencing the `page` fixture. */
export function locatorExpression(scenario: GeneratedScenario): string | null {
  const raw = scenario.locator;
  if (!raw) return null;
  if (raw.startsWith("page.")) return raw;
  if (raw.startsWith("locator(")) return `page.${raw}`;
  if (raw.startsWith("[")) return `page.locator(${q(raw)})`;
  return `page.locator(${q(raw)})`;
}

/** Deterministic assertions derived from the scenario title/type. */
export function assertionsFor(scenario: GeneratedScenario, locatorExpr: string | null): string[] {
  if (scenario.id === "SC-NAV-INTEGRITY") {
    return [
      `const response = await page.goto(TARGET_URL, { waitUntil: "load" });`,
      `expect(response?.status() ?? 0).toBeLessThan(400);`,
    ];
  }
  if (!locatorExpr) return [];
  const title = scenario.title;
  if (title.includes("is visible")) return [`await expect(${locatorExpr}).toBeVisible();`];
  if (title.includes("has an accessible name") || title.includes("has an accessible label")) {
    const expectedName = scenario.sourceElement.accessibleName || scenario.sourceElement.name || scenario.sourceElement.placeholder || scenario.sourceElement.text;
    if (expectedName) {
      // Playwright's getByRole(name:) resolution uses case-insensitive substring
      // matching; assert the same way. The runtime computed accessible name may
      // legitimately include surrounding content (for example "Episode 8 Episode 8").
      return [`await expect(${locatorExpr}).toHaveAccessibleName(/${escapeRegExp(expectedName)}/i);`];
    }
    return [`throw new Error("An accessible name was not recorded for this element at scan time.");`];
  }
  if (title.includes("is enabled")) return [`await expect(${locatorExpr}).toBeEnabled();`];
  if (title.includes("is disabled")) return [`await expect(${locatorExpr}).toBeDisabled();`];
  if (title.includes("shows placeholder") && scenario.sourceElement.placeholder) return [`await expect(${locatorExpr}).toHaveAttribute("placeholder", ${q(scenario.sourceElement.placeholder)});`];
  return [`await expect(${locatorExpr}).toBeVisible();`];
}

const groupBlock = (category: string, bodyLines: string[], indent = "  ") => bodyLines.map(line => (line ? `${indent}${line}` : `${indent}`)).join("\n");

function blankBody(comments: string[], steps: string[], path: string) {
  const lines: string[] = [];
  for (const comment of comments) lines.push(`// ${comment}`);
  for (const step of steps) lines.push(`// ${step}`);
  lines.push(`await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });`);
  if (path) lines.push(path);
  return lines;
}

export function generatePlaywrightSpec(suite: GeneratedTestSuite, outputPath: string): string {
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  const safe = suite.scenarios.filter(scenario => scenario.automated && scenario.risk !== "high-risk");
  // REVIEW scenarios whose source element is stable (visible at scan time) become
  // test.fixme placeholders. Hidden/conditional controls and HIGH-risk scenarios are
  // excluded from the executable suite entirely and remain available in the report.
  const review = suite.scenarios.filter(scenario => !scenario.automated && scenario.risk !== "high-risk" && scenario.sourceElement.visible === true);
  const excluded = suite.scenarios.length - safe.length - review.length;
  const blocks: string[] = [];
  for (const category of ["navigation", "button", "input", "form", "validation"] as const) {
    const lines: string[] = [];
    for (const scenario of safe.filter(item => item.category === category)) {
      const locatorExpr = locatorExpression(scenario);
      const goto = ["await page.goto(TARGET_URL, { waitUntil: \"domcontentloaded\" });"];
      const asserts = assertionsFor(scenario, locatorExpr);
      const body = [...goto, ...asserts];
      lines.push(`test(${q(`${scenario.id}: ${scenario.title}`)}, async ({ page }) => {`);
      body.forEach(line => lines.push(`  ${line}`));
      lines.push(`});`);
      lines.push(``);
    }
    for (const scenario of review.filter(item => item.category === category)) {
      const locatorExpr = locatorExpression(scenario);
      const body = blankBody(
        [`Manual review required before automation.`, `Risk: ${scenario.risk}. ${scenario.riskReason}`, `Do not enable until a QA engineer has reviewed the steps.`],
        scenario.steps,
        locatorExpr ? `await expect(${locatorExpr}).toBeVisible();` : "await page.goto(TARGET_URL, { waitUntil: \"domcontentloaded\" });"
      );
      lines.push(`test.fixme(${q(`${scenario.id}: ${scenario.title}`)}, async ({ page }) => {`);
      body.forEach(line => lines.push(`  ${line}`));
      lines.push(`});`);
      lines.push(``);
    }
    if (lines.length) blocks.push(`test.describe(${q(category)}, () => {\n${groupBlock(category, lines)}});`);
  }
  const header = [
    `import { test, expect } from "@playwright/test";`,
    `import "dotenv/config";`,
    ``,
    `// Auto-generated by ${suite.generator} (${suite.version}). Do not edit.`,
    `// Source: ${suite.sourceUrl} report: ${suite.sourceReport} generated: ${suite.generatedAt}`,
    `// Regenerate with: npm run generate`,
    ``,
    `const TARGET_URL = ${q(suite.sourceUrl)};`,
    ``,
    `// HTTP Basic credentials are read from the environment only. Never hard-code them.`,
    `test.use({`,
    `  httpCredentials: (process.env.QA_BASIC_AUTH_USER || process.env.QA_USERNAME) && (process.env.QA_BASIC_AUTH_PASSWORD || process.env.QA_PASSWORD) ? { username: process.env.QA_BASIC_AUTH_USER || process.env.QA_USERNAME, password: process.env.QA_BASIC_AUTH_PASSWORD || process.env.QA_PASSWORD } : undefined,`,
    `});`,
    ``,
  ].join("\n");
  const body = blocks.length ? blocks.join("\n\n") + "\n" : "// No automatically executed scenarios in this suite — review the HTML report for manual scenarios.\n";
  const summary = [
    `// Execution model:`,
    `//   ${safe.length} automated (SAFE) scenario(s) run as active tests.`,
    `//   ${review.length} review scenario(s) are marked test.fixme (skipped until QA review).`,
    `//   ${excluded} scenario(s) are excluded from generated automation entirely (HIGH-risk or hidden/conditional controls).`,
    ``,
  ].join("\n");
  writeFileSync(output, `${header}${summary}${body}`, "utf8");
  return output;
}