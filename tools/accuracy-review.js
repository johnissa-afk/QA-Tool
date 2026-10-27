#!/usr/bin/env node
/*
 * Accuracy review for AI Website QA findings.
 *
 * A QA tool is only as useful as its findings are true. This script measures
 * that by hand-checking a sample:
 *
 *   1. sample  - draw a reproducible sample of findings from one or more QA
 *                reports and write a CSV a person can review in Excel.
 *   2. score   - read the CSV back after the verdict column was filled in and
 *                report precision per finding type.
 *
 *   node tools/accuracy-review.js sample <report.json|folder>... [--per-code 8] [--seed 1] [--out reports/accuracy-review.csv] [--include-internal]
 *   node tools/accuracy-review.js score  <review.csv> [--min-precision 0.8] [--min-reviewed 5] [--json <file>]
 *
 * Verdict column (case-insensitive): CORRECT (c / y), WRONG (w / n), UNSURE (u / ?).
 *   CORRECT = the page really has the problem the finding describes.
 *   WRONG   = false positive (the element is fine, decorative, hidden on purpose, ...).
 *   UNSURE  = you cannot tell; excluded from precision.
 * Check each row in the browser (DevTools) or with an independent tool such as
 * axe DevTools or Lighthouse, not by trusting this tool's own wording.
 *
 * Exit code of `score`: 0 when every finding type with enough reviewed rows
 * meets --min-precision, 1 when one does not, 2 on a usage or input error.
 *
 * Note on bias: a report keeps at most five examples per finding, in document
 * order (usually header and navigation first). The sample is therefore not
 * uniform over all occurrences; review several sites to dilute that.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Observational / tool-internal codes: they do not claim the website is defective.
const INTERNAL_CODES = new Set(["fragile-locator", "hidden-interactive-element", "page-scanned"]);

const COLUMNS = [
  "site", "report", "findingId", "code", "severity", "confidence", "title",
  "tag", "role", "text", "ariaLabel", "accessibleName", "id", "href", "placeholder", "alt", "visible",
  "locator", "detail", "verdict", "notes",
];

function fail(message) {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------- csv helpers

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // Excel saves "CSV" with ";" in many regional settings (e.g. Arabic, most of Europe).
  // The header row never contains quotes, so counting separators in it is reliable.
  const headerLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

// ------------------------------------------------------------------- sampling

// Small seeded PRNG (mulberry32) so the same inputs and seed give the same sample.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const clip = (value, max) => {
  const text = value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function hostOf(report, file) {
  const scan = report && report.scan && report.scan.scan;
  const url = scan && (scan.finalUrl || scan.url);
  try { return new URL(url).host; } catch { return path.basename(file); }
}

function rowsOfReport(report, file, includeInternal) {
  const site = hostOf(report, file);
  const rows = [];
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    if (!includeInternal && INTERNAL_CODES.has(finding.code)) continue;
    const base = {
      site, report: path.basename(file), findingId: finding.id, code: finding.code,
      severity: finding.severity, confidence: finding.confidence, title: finding.title,
    };
    const examples = Array.isArray(finding.examples) ? finding.examples : [];
    if (examples.length === 0) {
      // Page-level findings (missing h1, CSP, ...) have no element: one row per finding.
      rows.push({ ...base, detail: clip(finding.description || finding.rationale, 200) });
      continue;
    }
    for (const example of examples) {
      const el = example && example.element;
      if (el) {
        rows.push({
          ...base, tag: el.tag, role: el.role, text: clip(el.text, 80), ariaLabel: clip(el.ariaLabel, 80),
          accessibleName: clip(el.accessibleName, 80), id: el.id, href: clip(el.href, 120),
          placeholder: clip(el.placeholder, 60), alt: el.alt === null || el.alt === undefined ? "" : clip(el.alt, 60),
          visible: el.visible, locator: clip(el.recommendedLocator, 120), detail: "",
        });
      } else {
        rows.push({ ...base, detail: clip(JSON.stringify(example), 200) });
      }
    }
  }
  return rows;
}

// A folder argument means "every .json report inside it" (PowerShell does not expand
// wildcards for node, so `reports/acc/*/qa.json` would arrive unexpanded).
function expandInputs(inputs) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      // History snapshots and per-run evidence repeat earlier runs and would skew the sample.
      if (entry.isDirectory()) { if (entry.name !== "history" && entry.name !== "run-artifacts") walk(full); }
      else if (entry.name.toLowerCase().endsWith(".json")) files.push(full);
    }
  };
  for (const input of inputs) {
    let stat;
    try { stat = fs.statSync(input); } catch (error) { fail(`sample: cannot read ${input}: ${error.message}`); }
    if (stat.isDirectory()) walk(input);
    else files.push(input);
  }
  return files;
}

function sample(inputs, options) {
  if (inputs.length === 0) fail("sample: give at least one report JSON or a folder containing reports.");
  const all = [];
  let reportsUsed = 0;
  for (const file of expandInputs(inputs)) {
    let report;
    try { report = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { fail(`sample: cannot read ${file}: ${error.message}`); }
    // Folders also hold qa-execution.json, baselines, etc.: only QA analyses have findings.
    if (!report || !Array.isArray(report.findings)) continue;
    reportsUsed += 1;
    all.push(...rowsOfReport(report, file, options.includeInternal));
  }
  if (reportsUsed === 0) fail("sample: no QA report with findings was found in the given inputs.");
  const random = prng(options.seed);
  const byCode = new Map();
  for (const row of all) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push(row);
  }
  const chosen = [];
  for (const code of [...byCode.keys()].sort()) {
    chosen.push(...shuffled(byCode.get(code), random).slice(0, options.perCode));
  }
  chosen.sort((a, b) => a.code.localeCompare(b.code) || a.site.localeCompare(b.site) || String(a.findingId).localeCompare(String(b.findingId)));

  const lines = [COLUMNS.join(",")];
  for (const row of chosen) lines.push(COLUMNS.map(column => csvCell(row[column])).join(","));
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  // BOM so Excel opens Arabic and other non-ASCII text correctly.
  fs.writeFileSync(options.out, `\ufeff${lines.join("\r\n")}\r\n`, "utf8");

  console.log(`Wrote ${chosen.length} rows to ${options.out} (${byCode.size} finding types from ${reportsUsed} report(s), seed ${options.seed}).`);
  for (const code of [...byCode.keys()].sort()) {
    console.log(`  ${code.padEnd(34)} ${String(Math.min(options.perCode, byCode.get(code).length)).padStart(3)} of ${byCode.get(code).length} available`);
  }
  console.log("\nNext: open the CSV, fill the `verdict` column with CORRECT / WRONG / UNSURE for every row\n(check each one in the browser or with axe), save as CSV, then run:\n  node tools/accuracy-review.js score " + options.out);
}

// -------------------------------------------------------------------- scoring

function normalizeVerdict(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["correct", "c", "y", "yes", "true", "tp"].includes(value)) return "CORRECT";
  if (["wrong", "w", "n", "no", "false", "fp"].includes(value)) return "WRONG";
  if (["unsure", "u", "?", "unknown"].includes(value)) return "UNSURE";
  return value === "" ? "" : "INVALID";
}

// Lower bound of the 95% Wilson interval: an honest precision for small samples.
function wilsonLower(correct, total) {
  if (total === 0) return 0;
  const z = 1.96;
  const p = correct / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (centre - margin) / denominator);
}

function score(file, options) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { fail(`score: cannot read ${file}: ${error.message}`); }
  const table = parseCsv(raw);
  if (table.length < 2) fail("score: the CSV has no data rows.");
  const header = table[0].map(name => name.trim());
  const col = name => header.indexOf(name);
  for (const needed of ["code", "verdict"]) if (col(needed) < 0) fail(`score: the CSV has no "${needed}" column.`);

  const stats = new Map();
  let unreviewed = 0;
  let invalid = 0;
  for (const cells of table.slice(1)) {
    const code = (cells[col("code")] || "").trim();
    if (!code) continue;
    const verdict = normalizeVerdict(cells[col("verdict")]);
    if (!stats.has(code)) stats.set(code, { code, correct: 0, wrong: 0, unsure: 0 });
    const entry = stats.get(code);
    if (verdict === "CORRECT") entry.correct += 1;
    else if (verdict === "WRONG") entry.wrong += 1;
    else if (verdict === "UNSURE") entry.unsure += 1;
    else if (verdict === "INVALID") invalid += 1;
    else unreviewed += 1;
  }

  const results = [...stats.values()].sort((a, b) => a.code.localeCompare(b.code)).map(entry => {
    const decided = entry.correct + entry.wrong;
    const precision = decided === 0 ? null : entry.correct / decided;
    const lower = wilsonLower(entry.correct, decided);
    const enough = decided >= options.minReviewed;
    return {
      ...entry, decided, precision, precisionLow95: decided === 0 ? null : lower, enough,
      meetsTarget: enough ? precision >= options.minPrecision : null,
    };
  });

  console.log(`${"finding type".padEnd(34)} ${"ok".padStart(4)} ${"wrong".padStart(6)} ${"unsure".padStart(7)} ${"precision".padStart(10)} ${"95% low".padStart(8)}  verdict`);
  for (const r of results) {
    const pct = value => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);
    const status = !r.enough ? `need ${options.minReviewed}+ decided rows` : r.meetsTarget ? "meets target" : "BELOW TARGET";
    console.log(`${r.code.padEnd(34)} ${String(r.correct).padStart(4)} ${String(r.wrong).padStart(6)} ${String(r.unsure).padStart(7)} ${pct(r.precision).padStart(10)} ${pct(r.precisionLow95).padStart(8)}  ${status}`);
  }
  const totalCorrect = results.reduce((sum, r) => sum + r.correct, 0);
  const totalDecided = results.reduce((sum, r) => sum + r.decided, 0);
  console.log(`\nOverall: ${totalCorrect}/${totalDecided} correct${totalDecided ? ` (${((totalCorrect / totalDecided) * 100).toFixed(0)}%)` : ""}; target ${(options.minPrecision * 100).toFixed(0)}% per finding type with ${options.minReviewed}+ decided rows.`);
  if (unreviewed) console.log(`${unreviewed} row(s) still have no verdict.`);
  if (invalid) console.log(`${invalid} row(s) have a verdict that is not CORRECT / WRONG / UNSURE and were ignored.`);

  if (options.json) {
    fs.writeFileSync(options.json, `${JSON.stringify({ target: options.minPrecision, minReviewed: options.minReviewed, results, unreviewed, invalid }, null, 2)}\n`, "utf8");
    console.log(`Summary written to ${options.json}`);
  }
  const failing = results.filter(r => r.meetsTarget === false);
  if (failing.length) {
    console.log(`\nBelow target: ${failing.map(r => r.code).join(", ")}. Fix those checks before relying on them.`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------------ cli

function parseArgs(argv) {
  const options = { perCode: 8, seed: 1, out: "reports/accuracy-review.csv", includeInternal: false, minPrecision: 0.8, minReviewed: 5, json: null };
  const positional = [];
  const number = (name, value, check) => {
    const parsed = Number(value);
    if (value === undefined || !check(parsed)) fail(`${name} needs a valid value.`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--per-code") options.perCode = number(arg, argv[++i], v => Number.isInteger(v) && v >= 1);
    else if (arg === "--seed") options.seed = number(arg, argv[++i], v => Number.isInteger(v));
    else if (arg === "--min-precision") options.minPrecision = number(arg, argv[++i], v => v > 0 && v <= 1);
    else if (arg === "--min-reviewed") options.minReviewed = number(arg, argv[++i], v => Number.isInteger(v) && v >= 1);
    else if (arg === "--out") { options.out = argv[++i]; if (!options.out) fail("--out needs a path."); }
    else if (arg === "--json") { options.json = argv[++i]; if (!options.json) fail("--json needs a path."); }
    else if (arg === "--include-internal") options.includeInternal = true;
    else if (arg.startsWith("--")) fail(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { options, positional };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { options, positional } = parseArgs(rest);
  if (command === "sample") return sample(positional, options);
  if (command === "score") {
    if (positional.length !== 1) fail("score: give exactly one review CSV.");
    return score(positional[0], options);
  }
  fail("Usage:\n  node tools/accuracy-review.js sample <report.json|folder>... [--per-code 8] [--seed 1] [--out file.csv] [--include-internal]\n  node tools/accuracy-review.js score <review.csv> [--min-precision 0.8] [--min-reviewed 5] [--json file]");
}

main();
