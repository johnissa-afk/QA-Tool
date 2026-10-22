import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Per-run result directory hygiene.
//
// Scenario IDs (SC-VER-001, SC-FLOW-001, ...) are sequential and therefore
// IDENTICAL across different target sites. If a result directory is reused,
// the loaders cannot tell a previous site's SC-VER-001.json from this run's.
// Clearing the directory immediately before a run guarantees that anything the
// loaders find was written by the current run (or is reported as missing).
// ---------------------------------------------------------------------------
export function resetResultsDir(dir: string): void {
  const target = join(process.cwd(), dir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}
