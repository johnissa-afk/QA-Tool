import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tool = resolve(process.cwd(), "tools", "accuracy-review.js");
const run = (args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });

const element = (over: object = {}) => ({
  element: { tag: "a", role: "link", text: "", ariaLabel: null, accessibleName: null, id: null, href: "https://a.test/x", alt: null, placeholder: null, visible: true, recommendedLocator: 'page.locator("a")', ...over },
});

function fixtureReport(dir: string): string {
  const report = {
    scan: { scan: { url: "https://a.test/", finalUrl: "https://a.test/" } },
    findings: [
      { id: "QA-F-001", code: "a-missing-name", severity: "HIGH", confidence: "high", title: "Link without an accessible name, really", examples: Array.from({ length: 5 }, (_, i) => element({ href: `https://a.test/p${i}`, text: i === 0 ? 'بحث "quoted", comma' : "" })) },
      { id: "QA-F-002", code: "missing-h1", severity: "LOW", confidence: "high", title: "Missing primary heading", description: "The document has no h1 heading.", examples: [] },
      { id: "QA-F-003", code: "fragile-locator", severity: "LOW", confidence: "high", title: "internal note", examples: [element()] },
    ],
  };
  const file = join(dir, "report.json");
  writeFileSync(file, JSON.stringify(report));
  return file;
}

test("sampling is reproducible, keeps awkward text intact, and skips tool-internal codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-acc-"));
  const report = fixtureReport(dir);
  const a = run(["sample", report, "--per-code", "3", "--seed", "5", "--out", join(dir, "a.csv")]);
  const b = run(["sample", report, "--per-code", "3", "--seed", "5", "--out", join(dir, "b.csv")]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(readFileSync(join(dir, "a.csv"), "utf8"), readFileSync(join(dir, "b.csv"), "utf8"), "same seed, same sample");
  const csv = readFileSync(join(dir, "a.csv"), "utf8");
  assert.ok(csv.startsWith("\ufeff"), "BOM so Excel reads Arabic correctly");
  assert.ok(!csv.includes("fragile-locator"), "tool-internal codes are not sampled by default");
  assert.equal(csv.split("\r\n").filter(Boolean).length, 1 + 3 + 1, "header + 3 capped rows + 1 page-level row");
  assert.ok(run(["sample", report, "--include-internal", "--out", join(dir, "c.csv")]).status === 0);
  assert.ok(readFileSync(join(dir, "c.csv"), "utf8").includes("fragile-locator"));
});

test("scoring reports precision per finding type and gates on the target", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-acc-"));
  const csv = (delimiter: string) => [
    ["code", "verdict"], ["a-missing-name", "CORRECT"], ["a-missing-name", "c"], ["a-missing-name", "Y"], ["a-missing-name", "WRONG"],
    ["image-missing-alt", "w"], ["image-missing-alt", "w"], ["image-missing-alt", "w"], ["image-missing-alt", "correct"],
    ["missing-h1", "unsure"], ["missing-h1", ""], ["missing-h1", "banana"],
  ].map(row => row.join(delimiter)).join("\r\n");
  for (const [name, delimiter] of [["comma.csv", ","], ["semicolon.csv", ";"]] as const) {
    writeFileSync(join(dir, name), csv(delimiter));
    const out = run(["score", join(dir, name), "--min-reviewed", "4", "--json", join(dir, `${name}.json`)]);
    assert.equal(out.status, 1, `${name}: image-missing-alt is below target\n${out.stdout}`);
    const summary = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
    const byCode = Object.fromEntries(summary.results.map((r: { code: string }) => [r.code, r]));
    assert.equal(byCode["a-missing-name"].correct, 3);
    assert.equal(byCode["a-missing-name"].precision, 0.75);
    assert.equal(byCode["a-missing-name"].meetsTarget, false, "75% is under the default 80% target");
    assert.equal(byCode["image-missing-alt"].precision, 0.25);
    assert.equal(byCode["missing-h1"].decided, 0, "unsure and invalid rows never count as decided");
    assert.equal(byCode["missing-h1"].meetsTarget, null, "too few decided rows to judge");
    assert.equal(summary.unreviewed, 1);
    assert.equal(summary.invalid, 1);
  }
});

test("a finding type that meets the target passes, and bad input exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-acc-"));
  writeFileSync(join(dir, "good.csv"), ["code,verdict", ...Array.from({ length: 5 }, () => "input-missing-label,CORRECT")].join("\n"));
  assert.equal(run(["score", join(dir, "good.csv")]).status, 0);
  assert.equal(run(["score", join(dir, "missing.csv")]).status, 2);
  assert.equal(run(["sample"]).status, 2);
  assert.equal(run(["unknown-command"]).status, 2);
  assert.equal(run(["sample", "x.json", "--per-code", "0"]).status, 2);
});

test("a folder argument finds the reports inside it and ignores other JSON files", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-acc-"));
  mkdirSync(join(dir, "reports", "site-a"), { recursive: true });
  mkdirSync(join(dir, "reports", "site-b"), { recursive: true });
  fixtureReport(join(dir, "reports", "site-a"));
  fixtureReport(join(dir, "reports", "site-b"));
  writeFileSync(join(dir, "reports", "site-a", "qa-execution.json"), JSON.stringify({ status: "passed" }));
  mkdirSync(join(dir, "reports", "history", "runs"), { recursive: true });
  fixtureReport(join(dir, "reports", "history", "runs"));
  const out = run(["sample", join(dir, "reports"), "--out", join(dir, "folder.csv")]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /from 2 report\(s\)/);
  const empty = mkdtempSync(join(tmpdir(), "qa-acc-empty-"));
  writeFileSync(join(empty, "other.json"), "{}");
  assert.equal(run(["sample", empty, "--out", join(dir, "none.csv")]).status, 2, "no report with findings is an input error");
});
