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
import { existsSync } from "node:fs";
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

const stub = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Component,
  Notice: class {},
  Setting: class {},
  App: class {},
  MarkdownRenderer: class {},
};

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

const instance = new PluginClass({}, { id: "scdb-cockpit", version: "0.0.0" });

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
];

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
