/**
 * Load the built bundle against a stubbed `obsidian` module.
 *
 * Catches syntax errors, bad imports, module-format mistakes and anything that
 * throws at class-definition time — without opening Obsidian. It does not
 * exercise the Obsidian API; that still needs a real vault. Think of it as the
 * cheapest possible gate before a build travels to the work laptop, and the
 * seed of the A4 diagnostics command.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const bundle = resolve("dist", "scdb-cockpit", "main.js");
if (!existsSync(bundle)) {
  console.error(`No bundle at ${bundle}. Run "npm run build" first.`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const Module = require("node:module");

class Component {
  registerEvent() {}
}
class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  addCommand() {}
  addRibbonIcon() {}
  addSettingTab() {}
  registerView() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}
class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
  }
}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}
class Modal {
  constructor(app) {
    this.app = app;
  }
}
class TAbstractFile {}
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}

const stub = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Component,
  Modal,
  TAbstractFile,
  TFile,
  TFolder,
  Notice: class {},
  Setting: class {},
  App: class {},
  MarkdownRenderer: class {},
  normalizePath: (path) => path,
  debounce: (fn) => fn,
  parseYaml: () => ({}),
  stringifyYaml: () => "",
};

/**
 * The smallest App that lets `onload` run to completion. It exercises the
 * wiring — view registration, commands, watchers, the first index build —
 * which is where a broken import or a bad call order actually shows up.
 */
function stubApp() {
  const ref = {};
  return {
    workspace: {
      onLayoutReady: (callback) => callback(),
      getLeavesOfType: () => [],
      getActiveFile: () => null,
      on: () => ref,
    },
    vault: {
      on: () => ref,
      getFiles: () => [],
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
    },
    metadataCache: { on: () => ref, getFileCache: () => null },
    fileManager: {},
  };
}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return stub;
  return originalLoad.call(this, request, ...rest);
};

const loaded = require(bundle);
const PluginClass = loaded.default ?? loaded;

if (typeof PluginClass !== "function") {
  console.error("Bundle did not export a plugin class.");
  process.exit(1);
}

const instance = new PluginClass(stubApp(), { id: "scdb-cockpit", version: "0.0.0" });

let loadError = null;
try {
  await instance.onload();
} catch (error) {
  loadError = error;
}

const checks = [
  // Assert behaviour, not the class name: production builds are minified, so
  // the name is whatever esbuild chose.
  ["extends Obsidian's Plugin", instance instanceof Plugin],
  ["implements onload", typeof instance.onload === "function"],
  ["settings default to a known mode", instance.settings.mode === "hod"],
  ["settings carry a schema version", instance.settings.schemaVersion === 1],
  ["folder map is populated", instance.settings.folders.requests === "10 Requests"],
  ["Bases probe does not throw", typeof instance.basesAvailable === "boolean"],
  ["Bases absent without the API", instance.basesAvailable === false],
  ["onload completes", loadError === null || (console.error(loadError), false)],
  ["workflow store is wired", instance.workflows?.all().length === 0],
  ["request index is wired", instance.index?.size === 0],
  ["audit log is wired", typeof instance.audit?.verify === "function"],
  ["writer is wired", typeof instance.writer?.create === "function"],
  ["bulk migration is wired", typeof instance.writer?.migrate === "function"],
  ["migration quarantine is reachable", instance.needsMigration({ workflow: "", stage: "x" }) === false],
];

/*
 * Every button in `src/ui` must declare whether it is a control.
 *
 * Obsidian styles a bare `<button>` as a fixed-height control, which silently
 * destroys any button holding more than one line — see the long comment in
 * `styles.css`. The stylesheet resets that by default and lets real controls
 * opt back in, so the failure mode is now cosmetic rather than catastrophic.
 * This check closes the other half: a button carrying no class at all has not
 * made the decision, and the author probably did not know there was one.
 */
const CONTROL = ["mod-cta", "mod-warning", "scdb-control"];
const uiDir = resolve("src", "ui");
const undeclared = [];
for (const name of readdirSync(uiDir).filter((f) => f.endsWith(".tsx"))) {
  const source = readFileSync(resolve(uiDir, name), "utf8");
  // Each `<button` up to the `>` that ends its opening tag. Attribute values
  // here never contain `>`, so this stays honest without a JSX parser.
  for (const match of source.matchAll(/<button\b[^>]*>/g)) {
    const tag = match[0];
    const cls = /class=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag);
    const declared =
      cls !== null && CONTROL.concat("scdb-").some((token) => (cls[1] ?? cls[2]).includes(token));
    if (!declared) {
      const line = source.slice(0, match.index).split("\n").length;
      undeclared.push(`src/ui/${name}:${line}`);
    }
  }
}

checks.push([
  undeclared.length === 0
    ? "every UI button declares control or not"
    : `buttons with no class: ${undeclared.join(", ")}`,
  undeclared.length === 0,
]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nSmoke test passed: bundle loads and initialises.");
