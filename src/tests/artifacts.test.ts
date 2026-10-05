// ---------------------------------------------------------------------------
// Phase 11B — deterministic artifact inventory (pure unit tests).
//
// Covers `src/qa/artifacts.ts`: the inventory builder is deterministic, uses
// relative paths only, never exposes the base directory itself, orders entries
// by role then path, de-duplicates, and renders a stable diagnostic block.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildArtifactInventory,
  classifyArtifactFilename,
  renderArtifactInventory,
  type ArtifactInventory,
} from "../qa/artifacts.js";

const w = "C:\\repo";
const fixture = {
  baseDir: w,
  report: [join(w, "reports", "qa-analysis.json"), join(w, "reports", "qa-analysis.html")],
  execution: [join(w, "reports", "qa-execution.json")],
  baseline: [join(w, "reports", "qa-baseline.json"), join(w, "reports", "qa-baseline.json.meta.json")],
  history: [join(w, "reports", "history", "index.json"), join(w, "reports", "history", "runs", "2026-09-22T09-30-12-123Z-8f3a1c02.json")],
};

test("inventory entries are relative, deduplicated, and never contain the base itself", () => {
  const inventory = buildArtifactInventory(fixture);
  const rels = inventory.entries.map(e => e.path);
  assert.ok(rels.every(p => !p.startsWith("C:") && !p.startsWith("/") && p !== "."), "every path is relative and non-empty");
  assert.ok(rels.every(p => !p.includes("\\")), "windows separators are normalized");
  assert.ok(rels.every(p => !/^[a-zA-Z]:/.test(p)), "no drive letter leaks");
  assert.equal(new Set(rels).size, rels.length, "paths are unique");
});

test("entries are ordered by role then path, and the summary counts kinds", () => {
  const inventory = buildArtifactInventory(fixture);
  const order = inventory.entries.map(e => e.kind);
  assert.deepEqual(order, ["baseline", "baseline-meta", "report", "report", "execution", "history", "history"], "role order: baseline → baseline-meta → report → execution → history");
  for (const p of inventory.entries.map(e => e.path)) {
    assert.ok(p.endsWith(".json") || p.endsWith(".html"), p);
  }
  assert.equal(inventory.summary.report, 2);
  assert.equal(inventory.summary.baseline, 1);
  assert.equal(inventory.summary["baseline-meta"], 1);
  assert.equal(inventory.summary.execution, 1);
  assert.equal(inventory.summary.history, 2);
  assert.equal(inventory.summary.temporary, 0);
  assert.equal(inventory.summary.other, 0);
  assert.equal(inventory.entries.length, 7);
});

test("duplicate paths across roles are de-duplicated by relative path", () => {
  const inventory = buildArtifactInventory({
    baseDir: w,
    report: [join(w, "report.json")],
    other: [join(w, "report.json"), join(w, ".", "report.json")],
  });
  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.entries[0]!.kind, "report");
});

test("render is deterministic and never emits an absolute path", () => {
  const a = renderArtifactInventory(buildArtifactInventory(fixture));
  const b = renderArtifactInventory(buildArtifactInventory(fixture));
  assert.equal(a, b, "identical input renders identically");
  assert.ok(!a.includes("C:") && !a.includes("\\"), "the rendered block leaks no absolute path");
  assert.ok(a.includes("[baseline]"), "role tag present");
  assert.ok(a.includes("summary: baseline 1"), "summary line present");
});

test("an empty inventory renders a stable (none) block", () => {
  const rendered = renderArtifactInventory(buildArtifactInventory({ baseDir: w }));
  assert.ok(rendered.includes("Artifacts (0):"), "header present");
  assert.ok(rendered.includes("(none)"), "empty state present");
  assert.ok(!/(?<![A-Za-z])[A-Za-z]:[\\/]/.test(rendered), "no drive path or absolute path leaks");
});

test("classifyArtifactFilename heuristic handles the documented filename shapes", () => {
  assert.equal(classifyArtifactFilename("qa-baseline.json"), "baseline");
  assert.equal(classifyArtifactFilename("qa-baseline.json.meta.json"), "baseline-meta");
  assert.equal(classifyArtifactFilename("qa-execution.json"), "execution");
  assert.equal(classifyArtifactFilename("qa-analysis.json"), "report");
  assert.equal(classifyArtifactFilename("qa-analysis.html"), "report");
  assert.equal(classifyArtifactFilename(".scratch.tmp"), "temporary");
  assert.equal(classifyArtifactFilename("something-else"), "other");
});

test("buildArtifactInventory is a pure function producing a typed inventory", () => {
  const inventory: ArtifactInventory = buildArtifactInventory(fixture);
  assert.equal(typeof inventory.baseDir, "string");
  assert.ok(Array.isArray(inventory.entries));
  assert.ok(typeof inventory.summary === "object");
});