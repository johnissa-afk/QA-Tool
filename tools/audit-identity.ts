// --------------------------------------------------------------------------
// Repo-audit helper (Phase 7A handoff). Not part of the build.
// Runs: tsx tools/audit-identity.ts
// Prints a checksum-proof inventory of the identity exports the history layer
// relies on, so a human or agent can verify "facade == phase5/6" WITHOUT
// reading glyphs — compare sha1 of each export line across the two files.
// --------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

const grab = (src: string, name: string): string | null => {
  const re = new RegExp(
    `export\\s+(?:function|const)\\s+${name}\\s*\\([^]*?\\n\\}|export\\s+type\\s+${name}[^;]*?;`,
  );
  const m = src.match(re);
  return m?.[0] ?? null;
};

const inventory = async (path: string) => {
  const src = await readFile(path, "utf8");
  const names = [...src.matchAll(/export (?:function|const|type)\s+([A-Za-z0-9_]+)\b/g)]
    .map((m) => m[1]);
  return { src, names };
};

const main = async (): Promise<void> => {
  const phase5 = resolve("src/regression/identity.ts");
  const facade = resolve("src/history/identity.ts");
  const left = await inventory(phase5);
  const right = await inventory(facade);

  const names = [...new Set([...left.names, ...right.names])].sort();
  console.log("name\t\tphase5sha\tfacade?");
  for (const n of names) {
    const a = left.names.includes(n) ? sha1(grab(left.src, n) ?? "") : "-";
    const b = right.names.includes(n) ? "*facade owns*" : "-";
    console.log(`${n}\t\t${a}\t${b}`);
  }
};

main().catch((error: unknown) => {
  console.error("identity audit failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});