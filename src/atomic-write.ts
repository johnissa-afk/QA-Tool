// ---------------------------------------------------------------------------
// Atomic text file writes shared by every report/spec writer.
//
// A crash or a full disk mid-write previously left a truncated JSON artifact
// behind, which the dashboard then surfaced as a malformed-artifact error. Every
// generated file is now written to a temp file in the same directory and then
// renamed into place, so a reader never observes a partial file.
//
// The rename-over-existing retry handles Windows, where renameSync fails with
// EPERM/EEXIST when the destination is held open by another process.
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function atomicWriteText(filePath: string, contents: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
  writeFileSync(tmp, contents, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST" || code === "ENOENT") {
      try { unlinkSync(filePath); } catch { /* destination did not exist */ }
      renameSync(tmp, filePath);
    } else {
      try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
      throw error;
    }
  }
}
