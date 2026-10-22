import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, MAX_LOCK_AGE_MS } from "../qa/run-lock.js";

const lockFile = () => join(mkdtempSync(join(tmpdir(), "qa-lock-")), "reports", ".qa-run.lock");

test("a second run is refused while the first is alive, and the message names the holder", () => {
  const file = lockFile();
  const first = acquireRunLock({ file, pid: 100, target: "https://a.test/", isAlive: () => true });
  assert.ok(existsSync(file));
  assert.throws(
    () => acquireRunLock({ file, pid: 200, target: "https://b.test/", isAlive: () => true }),
    /Another QA run is already in progress \(pid 100.*https:\/\/a\.test\//,
  );
  first.release();
  assert.equal(existsSync(file), false);
});

test("a lock left by a dead process is taken over", () => {
  const file = lockFile();
  acquireRunLock({ file, pid: 100, target: "https://a.test/", isAlive: () => true });
  const second = acquireRunLock({ file, pid: 200, target: "https://b.test/", isAlive: () => false });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 200);
  second.release();
});

test("a corrupt lock file and a very old lock are treated as stale", () => {
  const file = lockFile();
  acquireRunLock({ file, pid: 100, target: "x", isAlive: () => true }).release();
  writeFileSync(file, "not json");
  acquireRunLock({ file, pid: 300, target: "x", isAlive: () => true }).release();

  const t0 = Date.parse("2026-10-22T00:00:00.000Z");
  acquireRunLock({ file, pid: 100, target: "x", isAlive: () => true, now: () => t0 });
  const later = acquireRunLock({ file, pid: 400, target: "x", isAlive: () => true, now: () => t0 + MAX_LOCK_AGE_MS + 1 });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 400);
  later.release();
});

test("release never removes a lock owned by another run, and QA_FORCE_RUN overrides a live lock", () => {
  const file = lockFile();
  const first = acquireRunLock({ file, pid: 100, target: "x", isAlive: () => true });
  const forced = acquireRunLock({ file, pid: 200, target: "x", isAlive: () => true, env: { QA_FORCE_RUN: "1" } });
  first.release(); // not the owner any more: must leave run 200's lock alone
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 200);
  forced.release();
  assert.equal(existsSync(file), false);
});
