// ---------------------------------------------------------------------------
// Phase 11B — deterministic artifact inventory.
//
// A small, PURE diagnostic helper that reports what a QA run produced. It
// classifies artifacts by role (report / execution / baseline / baseline-meta /
// history / temporary / other), renders them with RELATIVE paths only, in a
// stable kind-then-path order, and never exposes machine-specific absolute
// paths. Designed for CI diagnostics and the Phase 11B artifact-isolation
// tests; it builds no dashboard and reads no files.
//
// `buildArtifactInventory` is authoritative: the caller declares the roles of
// the paths it produced. `classifyArtifactFilename` is a diagnostic-grade
// filename heuristic for ad-hoc inventories.
// ---------------------------------------------------------------------------
import { basename, relative, resolve } from "node:path";

export type ArtifactKind = "baseline" | "baseline-meta" | "report" | "execution" | "history" | "temporary" | "other";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "baseline",
  "baseline-meta",
  "report",
  "execution",
  "history",
  "temporary",
  "other",
] as const;

export type ArtifactInventoryEntry = {
  /** Path relative to the inventory base directory. Never absolute. */
  path: string;
  kind: ArtifactKind;
};

export type ArtifactInventory = {
  /** Paths are relativized against this reference; it is NOT itself emitted. */
  baseDir: string;
  entries: ArtifactInventoryEntry[];
  summary: Record<ArtifactKind, number>;
};

export type ArtifactInventoryInput = {
  /** Directory every emitted path is relativized against (e.g. the run cwd). */
  baseDir: string;
  /** QA analysis report artifacts (the JSON report, its HTML twin, …). */
  report?: string[];
  /** The execution artifact (qa-execution.json) when the executor ran. */
  execution?: string[];
  /** Baseline artifacts (the baseline JSON and its .meta.json sidecar). */
  baseline?: string[];
  /** History artifacts (index.json, runs/<id>.json, …). */
  history?: string[];
  /** Scratch/temporary artifacts (locks, *.tmp, …). */
  temporary?: string[];
  /** Anything else worth reporting. */
  other?: string[];
};

const KIND_ORDER = new Map<ArtifactKind, number>(ARTIFACT_KINDS.map((kind, index) => [kind, index]));

/** Diagnostic-grade filename heuristic. Authoritative roles come from
 *  `buildArtifactInventory`; this is only for ad-hoc inventories. */
export function classifyArtifactFilename(name: string): ArtifactKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".meta.json")) return "baseline-meta";
  if (lower.includes("baseline")) return "baseline";
  if (lower === "qa-execution.json") return "execution";
  if (lower.startsWith(".") || lower.endsWith(".tmp")) return "temporary";
  if (lower.endsWith(".json") || lower.endsWith(".html")) return "report";
  return "other";
}

/** Builds a deterministic, relative-path artifact inventory. Pure: performs no
 *  filesystem access; the caller supplies the paths it knows about. */
export function buildArtifactInventory(input: ArtifactInventoryInput): ArtifactInventory {
  const baseDir = resolve(input.baseDir);
  const grouped: Array<[ArtifactKind, string[]]> = [
    ["baseline", input.baseline ?? []],
    ["baseline-meta", []],
    ["report", input.report ?? []],
    ["execution", input.execution ?? []],
    ["history", input.history ?? []],
    ["temporary", input.temporary ?? []],
    ["other", input.other ?? []],
  ];
  if (input.baseline) {
    grouped[0]![1] = input.baseline.filter(path => !basename(path).toLowerCase().endsWith(".meta.json"));
    grouped[1]![1] = input.baseline.filter(path => basename(path).toLowerCase().endsWith(".meta.json"));
  }

  const seen = new Set<string>();
  const entries: ArtifactInventoryEntry[] = [];
  for (const [kind, paths] of grouped) {
    for (const raw of paths) {
      const rel = toRelative(baseDir, raw);
      if (rel === "" || seen.has(rel)) continue;
      seen.add(rel);
      entries.push({ path: rel, kind });
    }
  }
  entries.sort((a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const summary = Object.fromEntries(ARTIFACT_KINDS.map(kind => [kind, 0])) as Record<ArtifactKind, number>;
  for (const entry of entries) summary[entry.kind]! += 1;
  return { baseDir, entries, summary };
}

function toRelative(baseDir: string, path: string): string {
  const resolved = resolve(path);
  const rel = relative(baseDir, resolved);
  return rel === "" ? "." : rel.replace(/\\/g, "/");
}

/** Compact, deterministic rendering for CI diagnostics. Never emits an
 *  absolute path; entries are relative to the inventory base directory. */
export function renderArtifactInventory(inventory: ArtifactInventory): string {
  const lines = inventory.entries.length
    ? inventory.entries.map(entry => `  [${entry.kind}] ${entry.path}`)
    : ["  (none)"];
  const summary = ARTIFACT_KINDS
    .filter(kind => inventory.summary[kind] > 0)
    .map(kind => `${kind} ${inventory.summary[kind]}`)
    .join(" · ");
  return [`Artifacts (${inventory.entries.length}):`, ...lines, `  summary: ${summary || "none"}`].join("\n");
}