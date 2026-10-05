import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const help = `Usage: npm run report [-- <path>]

Opens the generated tests HTML report (default: reports/generated-tests.html).`;

function main(): void {
  const target = resolve(process.argv[2] ?? "reports/generated-tests.html");
  if (!existsSync(target)) {
    console.error(`Report not found: ${target}`);
    console.error("Generate it first with: npm run generate");
    process.exitCode = 1;
    return;
  }
  const url = pathToFileURL(target).href;
  console.log(`Opening report: ${url}`);
  // `cmd /c start` would re-parse the URL as a shell command line, so a path
  // containing `&`, `|`, or `^` could execute. explorer.exe takes the path
  // verbatim with no shell involved.
  if (process.platform === "win32") {
    spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  } else {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

if (require.main === module) {
  main();
}