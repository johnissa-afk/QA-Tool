import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Single-run lock for the shared scratch space.
//
// Specs, outcome files and Playwright output are per-run (run-workspace.ts), but
// two runs writing to the SAME output directory still share the report file,
// qa-execution.json and the stage-event sidecar. The lock (one per output
// directory) makes the second such run fail fast with a clear message instead
// of silently overwriting the first run's files.
//
//  - A lock whose process is gone (crash, kill -9) is stale and taken over.
//  - A lock older than MAX_LOCK_AGE_MS is treated as stale even if the pid is
//    alive (pid reuse after a reboot).
//  - QA_FORCE_RUN=1 overrides a live lock (use only if you know it is stuck).
// ---------------------------------------------------------------------------

export const RUN_LOCK_FILE = "reports/.qa-run.lock";
export const MAX_LOCK_AGE_MS = 12 * 60 * 60 * 1000;

export type RunLockInfo = { pid: number; startedAt: string; target: string };

export type RunLockOptions = {
  target: string;
  /** Lock file path; defaults to <cwd>/reports/.qa-run.lock. */
  file?: string;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
};

export type RunLock = { file: string; release(): void };

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): RunLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RunLockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt, target: typeof parsed.target === "string" ? parsed.target : "unknown" };
  } catch {
    return null;
  }
}

export function acquireRunLock(options: RunLockOptions): RunLock {
  const file = options.file ?? join(process.cwd(), RUN_LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const env = options.env ?? process.env;
  const info: RunLockInfo = { pid, startedAt: new Date(now()).toISOString(), target: options.target };

  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify(info), { flag: "wx" });
      return {
        file,
        release() {
          // Only remove a lock we still own.
          const current = readLock(file);
          if (current && current.pid === pid) rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readLock(file);
    const age = holder ? now() - Date.parse(holder.startedAt) : Infinity;
    const live = holder !== null && holder.pid !== pid && isAlive(holder.pid) && age < MAX_LOCK_AGE_MS;
    if (live && env.QA_FORCE_RUN !== "1") {
      throw new Error(
        `Another QA run is already in progress (pid ${holder!.pid}, started ${holder!.startedAt}, target ${holder!.target}). ` +
          `Runs writing to the same output directory share the report, qa-execution.json and stage-event files and cannot overlap. ` +
          `Wait for it to finish, use a different --output directory to run in parallel, ` +
          `or (if it is stuck) stop that process or set QA_FORCE_RUN=1 to override.`,
      );
    }
    // Stale, corrupt, our own, or forced: remove and retry.
    rmSync(file, { force: true });
  }
  throw new Error(`Could not acquire the QA run lock at ${file}.`);
}

/** Acquire the lock for this process and release it on every normal exit path. */
export function acquireRunLockForProcess(target: string, file?: string): RunLock {
  const lock = acquireRunLock({ target, file });
  process.on("exit", () => lock.release());
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    // Do not override a handler someone else installed.
    if (process.listenerCount(signal) === 0) process.on(signal, () => { lock.release(); process.exit(code); });
  }
  return lock;
}
