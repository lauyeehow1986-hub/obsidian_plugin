import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const prod = process.argv.includes("--prod");

/**
 * Dev builds go straight into the synthetic test vault so the reload loop is
 * one keypress. Prod builds go to dist/, which is what gets zipped and carried
 * to the work laptop on a USB stick (see CLAUDE.md §3 — deployment is sneakernet).
 */
const OUT_DIR = prod
  ? join("dist", "scdb-cockpit")
  : join("test-vault", ".obsidian", "plugins", "scdb-cockpit");

mkdirSync(OUT_DIR, { recursive: true });

/** The release is exactly three files. Keep it that way. */
function copyStaticAssets() {
  for (const file of ["manifest.json", "styles.css"]) {
    copyFileSync(file, join(OUT_DIR, file));
  }
}

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian loads plugins as CommonJS regardless of our source module format.
  format: "cjs",
  target: "es2022",
  platform: "browser",
  // Anything Obsidian or Electron already provides must not be bundled.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  logLevel: "info",
  outfile: join(OUT_DIR, "main.js"),
  plugins: [
    {
      name: "copy-assets-and-report",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          copyStaticAssets();
          const bundle = join(OUT_DIR, "main.js");
          if (existsSync(bundle)) {
            const kb = (statSync(bundle).size / 1024).toFixed(1);
            // CLAUDE.md §3 sets a ~1.5 MB ceiling. Surface it every build so it
            // is noticed while it is still cheap to fix.
            console.log(`[scdb-cockpit] main.js ${kb} KB  ->  ${OUT_DIR}`);
          }
        });
      },
    },
  ],
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log(`[scdb-cockpit] watching; output -> ${OUT_DIR}`);
}
