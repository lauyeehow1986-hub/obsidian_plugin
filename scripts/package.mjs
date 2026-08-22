/**
 * Build a release zip for sneakernet transfer to the work laptop (CLAUDE.md §3).
 *
 * Uses PowerShell's Compress-Archive rather than a zip library: the target is
 * Windows-only, and this avoids a dependency for something the OS already does.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const source = resolve("dist", "scdb-cockpit");

const REQUIRED = ["main.js", "manifest.json", "styles.css"];
const missing = REQUIRED.filter((f) => !existsSync(join(source, f)));
if (missing.length > 0) {
  console.error(`Cannot package: missing ${missing.join(", ")} in ${source}. Run "npm run build" first.`);
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
const target = resolve("dist", `scdb-cockpit-${manifest.version}.zip`);
if (existsSync(target)) rmSync(target);

execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path '${source}' -DestinationPath '${target}' -CompressionLevel Optimal`,
  ],
  { stdio: "inherit" },
);

console.log(`\nPackaged v${manifest.version} -> ${target}`);
console.log(`Copy the scdb-cockpit folder from this zip into:`);
console.log(`  <vault>\\.obsidian\\plugins\\scdb-cockpit\\`);
