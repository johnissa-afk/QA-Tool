import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Per-run workspace.
//
// Every executing QA run gets its own generated specs, outcome files and
// Playwright output directory, so concurrent runs (several terminals, the
// dashboard plus a terminal) can no longer overwrite each other's files:
//
//   generated/run-<id>/qa-verification.spec.ts   generated spec   (removed on exit)
//   generated/run-<id>/qa-flows.spec.ts          generated spec   (removed on exit)
//   reports/run-artifacts/<id>/verification/     outcome + evidence files (kept)
//   reports/run-artifacts/<id>/flows/            outcome files             (kept)
//   reports/run-artifacts/<id>/pw-output/        Playwright outputDir      (removed on exit)
//
// Playwright wipes its output directory at the start of every run, so a shared
// one would let one run delete another run's attachments mid-flight.
// Set QA_KEEP_WORK=1 to keep the generated specs and Playwright output.
// ---------------------------------------------------------------------------

export const SPEC_ROOT = "generated";
export const ARTIFACT_ROOT = "reports/run-artifacts";
export const STALE_SPEC_DIR_MS = 24 * 60 * 60 * 1000;

export type RunWorkspace = {
  id: string;
  specDir: string;
  verificationSpec: string;
  flowSpec: string;
  verificationDir: string;
  flowsDir: string;
  outputDir: string;
  cleanup(): void;
};

const posix = (value: string): string => value.split(sep).join("/");

export function newWorkspaceId(): string {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Remove generated/run-* directories left behind by crashed runs. */
export function pruneStaleSpecDirs(cwd = process.cwd(), maxAgeMs = STALE_SPEC_DIR_MS, now = Date.now()): string[] {
  const root = join(cwd, SPEC_ROOT);
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith("run-")) continue;
    const full = join(root, name);
    try {
      if (statSync(full).isDirectory() && now - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
    } catch { /* another run may be removing it */ }
  }
  return removed;
}

export function createRunWorkspace(options: { cwd?: string; id?: string; env?: NodeJS.ProcessEnv; registerExitCleanup?: boolean } = {}): RunWorkspace {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const id = options.id ?? newWorkspaceId();
  pruneStaleSpecDirs(cwd);

  const specDir = `${SPEC_ROOT}/run-${id}`;
  const artifactDir = `${ARTIFACT_ROOT}/${id}`;
  const workspace: RunWorkspace = {
    id,
    specDir,
    verificationSpec: `${specDir}/qa-verification.spec.ts`,
    flowSpec: `${specDir}/qa-flows.spec.ts`,
    verificationDir: `${artifactDir}/verification`,
    flowsDir: `${artifactDir}/flows`,
    outputDir: `${artifactDir}/pw-output`,
    cleanup() {
      if (env.QA_KEEP_WORK === "1") return;
      rmSync(join(cwd, specDir), { recursive: true, force: true });
      rmSync(join(cwd, artifactDir, "pw-output"), { recursive: true, force: true });
    },
  };
  if (options.registerExitCleanup !== false) process.on("exit", () => workspace.cleanup());
  return workspace;
}

/** Import prefix from a generated spec to the compiled output: "../dist" for generated/x.spec.ts,
 *  "../../dist" for generated/run-<id>/x.spec.ts. */
export function distImportPrefix(specAbsolutePath: string, cwd = process.cwd()): string {
  const rel = posix(relative(dirname(resolve(specAbsolutePath)), join(cwd, "dist")));
  return rel.startsWith(".") ? rel : `./${rel}`;
}
