/**
 * The sandbox runtime, as a string.
 *
 * `src/sandbox/runtime.ts` is bundled separately at build time (see
 * `esbuild.config.mjs`) and the result is handed to the plugin as source text,
 * because it has to be *injected into a page*, not linked into `main.js`. This
 * declaration is what lets `tsc --noEmit` see the import that esbuild
 * synthesises.
 */
declare module "virtual:sandbox-runtime" {
  const source: string;
  export default source;
}
