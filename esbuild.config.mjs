import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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

/**
 * The vault-app sandbox runtime (§5.13, §7 F3).
 *
 * `src/sandbox/runtime.ts` runs on the *other side* of a security boundary: it
 * is injected into a sandboxed iframe's `srcdoc`, where there is no module
 * loader, no Obsidian and no origin to fetch a second file from. So it cannot
 * be linked into `main.js` — it has to arrive as a string. This builds it into
 * one self-contained IIFE (Preact, hooks and htm included) and exposes it as
 * the module `virtual:sandbox-runtime`, whose default export is that text.
 *
 * The size is reported separately from the bundle because it is carried
 * *inside* it: every byte here is a byte of main.js too.
 */
const sandboxRuntime = {
  name: "sandbox-runtime",
  setup(build) {
    build.onResolve({ filter: /^virtual:sandbox-runtime$/ }, () => ({
      path: "sandbox-runtime",
      namespace: "scdb-virtual",
    }));

    build.onLoad({ filter: /.*/, namespace: "scdb-virtual" }, async () => {
      const entry = resolve("src", "sandbox", "runtime.ts");
      const built = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "iife",
        target: "es2022",
        platform: "browser",
        jsx: "automatic",
        jsxImportSource: "preact",
        // Always minified, in dev too: this is embedded in an HTML attribute
        // and the point of reading it is never to debug it there.
        minify: true,
        legalComments: "none",
        write: false,
        logLevel: "silent",
      });
      const text = built.outputFiles[0].text;
      console.log(`[scdb-cockpit] sandbox runtime ${(text.length / 1024).toFixed(1)} KB (inside main.js)`);
      return {
        contents: `export default ${JSON.stringify(text)};`,
        loader: "js",
        // Enough for the dev watch loop to notice an edit to the runtime.
        watchFiles: [entry],
      };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian loads plugins as CommonJS regardless of our source module format.
  format: "cjs",
  target: "es2022",
  platform: "browser",
  // Anything Obsidian or Electron already provides must not be bundled.
  // `builtin-modules` lists bare names ("fs/promises"); the source imports the
  // prefixed form ("node:fs/promises"), which esbuild matches literally, so
  // both spellings have to be here or the backup service pulls Node into the
  // bundle and the build fails.
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtins,
    ...builtins.map((name) => `node:${name}`),
  ],
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  logLevel: "info",
  outfile: join(OUT_DIR, "main.js"),
  plugins: [
    sandboxRuntime,
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
