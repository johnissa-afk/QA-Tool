import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteText } from "./atomic-write.js";
import { escapeHtml, safeHref } from "./html-escape.js";
import { Issue, IssueElement, ScanReport, Status } from "./types.js";

const escapeXml = (value: string | number | null | undefined): string =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeLog = (value: string): string => value.replace(/[\r\n]/g, " ").trim();

const descriptionField = (label: string, value: string | number | boolean | null | undefined) => (value === "" || value === null || value === undefined ? "" : `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(String(value))}</td></tr>`);
const elementDescription = (element: IssueElement) => `<table class="element-details">${descriptionField("Element", element.tag)}${descriptionField("Role", element.role)}${descriptionField("Visible text", element.text)}${descriptionField("Accessible name", element.accessibleName)}${descriptionField("Type", element.type)}${descriptionField("Name", element.name)}${descriptionField("Placeholder", element.placeholder)}${descriptionField("ID", element.id)}${descriptionField("Test ID", element.testId)}${descriptionField("Href", element.href)}${descriptionField("Alt", element.alt)}${descriptionField("Visible", element.visible)}${descriptionField("Enabled", element.enabled)}${descriptionField("Locator quality", element.locatorQuality)}<tr><td><strong>Recommended locator</strong></td><td><code>${escapeHtml(element.recommendedLocator)}</code></td></tr></table>`;
const issueExamples = (issue: Issue) => issue.examples?.map(example => example.element ? elementDescription(example.element) : `<code>${escapeHtml(example.detail)}</code>`).join("<hr>") || "—";
const issueRows = (report: ScanReport, status: Status) => report.issues.filter(issue => issue.status === status).map(issue => `<tr><td><span class="badge ${status.toLowerCase()}">${status}</span></td><td><code>${escapeHtml(issue.code)}</code></td><td>${issue.occurrences ?? issue.count ?? 1}</td><td>${escapeHtml(issue.message)}${issue.occurrences ? `<br><span class="info">Occurrences: ${issue.occurrences}</span>` : ""}</td><td>${issueExamples(issue)}</td></tr>`).join("") || `<tr><td colspan="5">None</td></tr>`;
const section = (report: ScanReport, status: Status, title: string) => `<section><h2>${title}</h2><table><thead><tr><th>Severity</th><th>Code</th><th>Count</th><th>Finding</th><th>Examples (up to 5)</th></tr></thead><tbody>${issueRows(report, status)}</tbody></table></section>`;

/**
 * An access prerequisite is an access condition, not a website defect. It is
 * rendered in its own section and is never counted in the issue-group or
 * severity totals, so "0 issue groups" and "1 access prerequisite" can never be
 * confused with each other.
 */
const accessSection = (report: ScanReport): string => {
  const ap = report.accessPrerequisite;
  if (!ap) return "";
  return `<section class="overview"><h2>Access Prerequisite</h2><p class="sub">The normal QA scan did not run for this target. An access prerequisite is an access condition, not a website defect, and is excluded from every issue-group and severity count below.</p><p><strong>Type:</strong> ${escapeHtml(ap.type)}<br><strong>Status:</strong> ${escapeHtml(ap.status)}<br><strong>Message:</strong> ${escapeHtml(ap.message)}${ap.httpStatus != null ? `<br><strong>HTTP status:</strong> ${escapeHtml(ap.httpStatus)}` : ""}${ap.challenge ? `<br><strong>Challenge:</strong> ${escapeHtml(ap.challenge)}` : ""}</p><p><strong>Website findings:</strong> ${report.summary.issueGroups} issue group(s).</p></section>`;
};

export function writeReports(report: ScanReport, outputPath: string): { jsonPath: string; htmlPath: string } {
  const jsonPath = resolve(outputPath);
  const htmlPath = jsonPath.slice(0, jsonPath.length - extname(jsonPath).length) + ".html";
  mkdirSync(dirname(jsonPath), { recursive: true });
  atomicWriteText(jsonPath, JSON.stringify(report, null, 2));
  const { summary, scan, authentication } = report;
  const screenshot = scan.screenshotPath ? `<a href="${pathToFileURL(scan.screenshotPath).href}"><img class="screenshot" src="${pathToFileURL(scan.screenshotPath).href}" alt="Captured page screenshot"></a>` : "Screenshot was unavailable.";
  const interactiveRows = report.elements.filter(element => element.interactive).map(element => `<tr><td>${escapeHtml(element.tag)}</td><td>${escapeHtml(element.role)}</td><td>${escapeHtml(element.accessibleName || element.text)}</td><td>${element.visible}</td><td>${element.enabled}</td><td>${escapeHtml(element.locatorQuality)}</td><td><code>${escapeHtml(element.recommendedLocator)}</code></td></tr>`).join("") || "<tr><td colspan=\"7\">None</td></tr>";
  const linkRows = report.links.map(link => `<tr><td><a href="${safeHref(link.url)}">${escapeHtml(link.url)}</a></td><td>${escapeHtml(link.status)}</td><td>${escapeHtml(link.type)}</td><td>${escapeHtml(link.error)}</td></tr>`).join("") || "<tr><td colspan=\"4\">No HTTP(S) links found.</td></tr>";
  const consoleRows = report.consoleDiagnostics.map(item => `<tr><td>${escapeHtml(item.category)}</td><td><span class="badge ${item.status.toLowerCase()}">${item.status}</span></td><td>${escapeHtml(item.message)}</td><td>${escapeHtml(item.source)}</td></tr>`).join("") || "<tr><td colspan=\"4\">None</td></tr>";
  const pageErrorRows = report.pageErrors.map(error => `<tr><td><code>${escapeHtml(error)}</code></td></tr>`).join("") || "<tr><td>None</td></tr>";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website QA report</title><style>:root{color-scheme:light}body{font:14px system-ui,sans-serif;margin:0;background:#f7f9fc;color:#17212b;line-height:1.45}main{max-width:1440px;margin:auto;padding:2rem}h1{margin:0}h2{margin:2.2rem 0 .7rem}section,.overview{background:#fff;border:1px solid #d7dee8;border-radius:10px;padding:1.2rem;margin-top:1rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem}.card{background:#fff;border:1px solid #d7dee8;border-radius:8px;padding:.85rem}.card strong{font-size:1.4rem}.fail{color:#b42318}.warning{color:#9a6700}.info{color:#175cd3}.pass{color:#067647}.badge{font-weight:700;font-size:.78rem}table{border-collapse:collapse;width:100%;background:#fff}td,th{padding:.65rem;border:1px solid #d7dee8;text-align:left;vertical-align:top;word-break:break-word}th{background:#f1f5f9}code{white-space:pre-wrap;font-size:.85em}.element-details{max-width:720px}.element-details td{padding:.35rem .6rem;border:1px solid #e6ebf2}.screenshot{max-width:100%;border:1px solid #d7dee8;border-radius:6px}hr{border:0;border-top:1px solid #d7dee8;margin:.5rem 0}</style></head><body><main><h1>Website QA report</h1>${accessSection(report)}<section class="overview"><h2>Scan Overview</h2><p><strong>URL:</strong> <a href="${safeHref(scan.url)}">${escapeHtml(scan.url)}</a><br><strong>Final URL:</strong> <a href="${safeHref(scan.finalUrl)}">${escapeHtml(scan.finalUrl)}</a><br><strong>HTTP status:</strong> ${escapeHtml(scan.navigationStatus)}<br><strong>Page title:</strong> ${escapeHtml(scan.title || "(missing)")}<br><strong>Authentication:</strong> ${escapeHtml(authentication.method)}; username present: ${authentication.usernamePresent}; password present: ${authentication.passwordPresent}; authorization header present: ${authentication.authorizationPresent}; accepted: ${escapeHtml(authentication.accepted === null ? "unverified" : String(authentication.accepted))}<br><strong>Scanned:</strong> ${escapeHtml(scan.timestamp)}<br><strong>Duration:</strong> ${scan.durationMs} ms</p></section><h2>Summary</h2><div class="grid"><div class="card">Total elements<br><strong>${summary.totalElements}</strong></div><div class="card">Interactive elements<br><strong>${summary.interactiveElements}</strong></div><div class="card">Links checked<br><strong>${summary.linksChecked}</strong></div><div class="card fail">Broken links<br><strong>${summary.brokenLinks}</strong></div><div class="card fail">Failures<br><strong>${summary.failures}</strong> (${summary.groupedIssueCounts.failures} groups)</div><div class="card warning">Warnings<br><strong>${summary.warnings}</strong> (${summary.groupedIssueCounts.warnings} groups)</div><div class="card info">Informational findings<br><strong>${summary.infos}</strong> (${summary.groupedIssueCounts.infos} groups)</div><div class="card">Console errors<br><strong>${summary.consoleErrors}</strong></div><div class="card">Page errors<br><strong>${summary.pageErrors}</strong></div><div class="card">Issue groups<br><strong>${summary.issueGroups}</strong></div></div>${section(report, "FAIL", "Failures")}${section(report, "WARNING", "Warnings")}${section(report, "INFO", "Informational Findings")}<section><h2>Interactive Elements</h2><table><thead><tr><th>Tag</th><th>Role</th><th>Accessible name / text</th><th>Visible</th><th>Enabled</th><th>Locator quality</th><th>Recommended locator</th></tr></thead><tbody>${interactiveRows}</tbody></table></section><section><h2>Links</h2><table><thead><tr><th>URL</th><th>Status</th><th>Result</th><th>Error</th></tr></thead><tbody>${linkRows}</tbody></table></section><section><h2>Console Errors</h2><table><thead><tr><th>Category</th><th>Severity</th><th>Message</th><th>Source</th></tr></thead><tbody>${consoleRows}</tbody></table></section><section><h2>Page Errors</h2><table><thead><tr><th>Error</th></tr></thead><tbody>${pageErrorRows}</tbody></table></section><section><h2>Screenshot</h2>${screenshot}</section></main></body></html>`;
  atomicWriteText(htmlPath, html);
  return { jsonPath, htmlPath };
}

export function writeJUnitReport(report: ScanReport, outputDir: string): string {
  const junitPath = resolve(outputDir, "junit.xml");
  const failureTestCases = report.issues
    .filter(issue => issue.status === "FAIL")
    .map(issue => `    <testcase name="${escapeXml(issue.code)}" classname="website-qa"><failure message="${escapeXml(issue.message)}">${escapeXml(escapeLog(JSON.stringify(issue.examples ?? "")))}</failure></testcase>`);
  const errorTestCases = report.pageErrors
    .map(error => `    <testcase name="page-error" classname="website-qa"><error message="${escapeXml(escapeLog(error))}"/></testcase>`);
  const consoleErrorTestCases = report.consoleErrors
    .map(error => `    <testcase name="console-error" classname="website-qa"><error message="${escapeXml(escapeLog(error))}"/></testcase>`);
  const passTestCases = report.issues
    .filter(issue => issue.status !== "FAIL")
    .map(issue => `    <testcase name="${escapeXml(issue.code)}" classname="website-qa"/>`);
  const allCases = [...failureTestCases, ...errorTestCases, ...consoleErrorTestCases, ...passTestCases];
  const totalTests = allCases.length;
  const totalFailures = failureTestCases.length;
  const totalErrors = errorTestCases.length + consoleErrorTestCases.length;
  const casesXml = allCases.join("\n");
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}">`,
    `  <testsuite name="${escapeXml(new URL(report.scan.url).hostname)}" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" time="${Math.round(report.scan.durationMs / 1000)}" timestamp="${escapeXml(report.scan.timestamp)}">`,
    casesXml,
    `  </testsuite>`,
    `</testsuites>`,
    "",
  ].join("\n");
  atomicWriteText(junitPath, xml);
  return junitPath;
}

export function emitGithubAnnotations(report: ScanReport): void {
  for (const issue of report.issues.filter(issue => issue.status === "FAIL")) {
    console.log(`::error title=${escapeLog(issue.code)}::${escapeLog(issue.message)}`);
  }
  for (const issue of report.issues.filter(issue => issue.status === "WARNING")) {
    console.log(`::warning title=${escapeLog(issue.code)}::${escapeLog(issue.message)}`);
  }
  for (const error of report.pageErrors) {
    console.log(`::error title=page-error::${escapeLog(error)}`);
  }
  for (const error of report.consoleErrors) {
    console.log(`::error title=console-error::${escapeLog(error)}`);
  }
}

export function printJsonSummary(report: ScanReport): void {
  const ap = report.accessPrerequisite ?? null;
  const summary = {
    url: report.scan.url,
    finalUrl: report.scan.finalUrl,
    title: report.scan.title,
    navigationStatus: report.scan.navigationStatus,
    // A blocked run performed no QA, so it must not report a clean exit code.
    exitCode: ap ? 2 : report.summary.failures > 0 ? 1 : 0,
    // Kept separate from the finding counts below so a consumer can never
    // mistake an access condition for a website defect.
    accessPrerequisite: ap ? { type: ap.type, status: ap.status, message: ap.message, httpStatus: ap.httpStatus ?? null } : null,
    normalScanRun: !ap,
    failures: report.summary.failures,
    warnings: report.summary.warnings,
    passes: report.summary.passes,
    infos: report.summary.infos,
    totalElements: report.summary.totalElements,
    brokenLinks: report.summary.brokenLinks,
    durationMs: report.scan.durationMs,
    timestamp: report.scan.timestamp,
  };
  console.log(JSON.stringify(summary));
}
