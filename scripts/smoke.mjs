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

/**
 * The smallest thing that behaves like an Obsidian-decorated HTMLElement.
 *
 * Enough for the status-bar HUD to paint into. Obsidian adds `createEl`,
 * `createSpan` and `empty` to the DOM prototype; Node has no DOM at all, so
 * anything the plugin builds outside a view needs a stand-in here.
 */
function fakeEl() {
  const el = {
    children: [],
    classes: [],
    empty() {
      el.children = [];
    },
    addClass(name) {
      el.classes.push(name);
    },
    createEl() {
      const child = fakeEl();
      el.children.push(child);
      return child;
    },
    createSpan() {
      return el.createEl();
    },
    addEventListener() {},
    setAttribute() {},
    // The backup nag hides itself when there is nothing to nag about, so a
    // status-bar stand-in has to answer these or `onload` throws (§7 A4).
    hide() {
      el.hidden = true;
    },
    show() {
      el.hidden = false;
    },
    hidden: false,
  };
  return el;
}
class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  addCommand(command) {
    registeredCommands.push(command.id);
  }
  addRibbonIcon() {}
  addStatusBarItem() {
    return fakeEl();
  }
  addSettingTab() {}
  registerView() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}
/**
 * A stand-in for Obsidian >= 1.10's BasesView.
 *
 * Only used by the second instance below. The first one deliberately loads
 * against a stub with no Bases at all, which is what caught `class extends
 * undefined` failing the entire plugin on an older Obsidian.
 */
class BasesView extends Component {
  constructor(controller) {
    super();
    this.controller = controller;
  }
  onunload() {}
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
  BasesView,
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
const created = [];
const registeredCommands = [];

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
      create: (path, data) => {
        created.push({ path, data });
        return Promise.resolve({ path });
      },
      createFolder: () => Promise.resolve(),
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

/**
 * A second load, this time against an Obsidian that HAS Bases.
 *
 * `registerBasesView` is an own property, which is exactly what the plugin
 * probes for. This is as close as we get to the A2b acceptance criterion
 * without launching Obsidian: it proves both boards are offered as view types,
 * and that defining classes derived from BasesView does not throw.
 */
const withBases = new PluginClass(stubApp(), { id: "scdb-cockpit", version: "0.0.0" });
const registeredViews = [];
withBases.registerBasesView = (id, registration) => {
  registeredViews.push({ id, ...registration });
  return true;
};
let basesLoadError = null;
try {
  await withBases.onload();
} catch (error) {
  basesLoadError = error;
}

// `plan()` reads existing files to spot formulas that have drifted from the
// workflow spec, so it is async. Resolve it once rather than in each check.
const basesPlan = (await instance.basesFiles?.plan()) ?? [];
// Both instances register the same commands, so dedupe before counting.
const commands = [...new Set(registeredCommands)];

const checks = [
  // Assert behaviour, not the class name: production builds are minified, so
  // the name is whatever esbuild chose.
  ["extends Obsidian's Plugin", instance instanceof Plugin],
  ["implements onload", typeof instance.onload === "function"],
  ["settings default to a known mode", instance.settings.mode === "hod"],
  ["settings carry a schema version", instance.settings.schemaVersion === 3],
  ["the hat filter defaults to the mode you are wearing", instance.settings.hatFilter === "mode"],
  [
    // Mode is the organising metaphor (§7 A3): every hat needs a command, or
    // two of the three are only reachable by mouse.
    "every hat has a command",
    commands.filter((id) => id.startsWith("mode-")).length === 3,
  ],
  [
    "the hat filter can be turned off from the palette",
    commands.includes("toggle-hat-filter"),
  ],
  ["the analytics board has a command", commands.includes("analytics")],
  ["the overview has a command", commands.includes("needs-attention")],
  [
    // The overview reads three sources; on an empty vault it must be three
    // empty lists rather than a throw during the first paint.
    "the overview builds on an empty vault",
    (() => {
      const overview = instance.overview([]);
      return (
        overview.attention.length === 0 &&
        overview.deadlines.length === 0 &&
        overview.publications.length === 0
      );
    })(),
  ],
  [
    // The static HTML export must never write outside 95 Exports/ (§7 A3).
    "board exports land in the exports folder",
    instance.exporter?.plannedPath("Queue analytics", "html").startsWith("95 Exports/"),
  ],
  ["folder map is populated", instance.settings.folders.requests === "10 Requests"],
  [
    // §7 A4. Three commands, because verify and restore are separate acts:
    // one proves the file, the other changes the vault.
    "backup, verify and restore each have a command",
    ["backup-now", "verify-backup", "restore-backup"].every((id) => commands.includes(id)),
  ],
  [
    // Rule 3's principle applied to the filesystem: nothing is configured on
    // install, so nothing is written to a folder nobody chose.
    "no backup destination on a fresh install",
    instance.settings.backup.destination === "" && instance.settings.backup.keep === 7,
  ],
  [
    "the backup commands refuse until a destination is set",
    (await instance.backup.destinationProblem())?.includes("No backup destination is set") === true,
  ],
  [
    // A relative path would resolve against whatever the process CWD happens
    // to be — which on Windows is wherever Obsidian was launched from.
    "a relative destination is refused",
    await (async () => {
      instance.settings.backup.destination = "backups";
      const problem = await instance.backup.destinationProblem();
      instance.settings.backup.destination = "";
      return typeof problem === "string" && problem.includes("full path");
    })(),
  ],
  [
    // Node builtins must stay external or the bundle stops loading in Obsidian
    // and the 1.5 MB budget goes with it (§3).
    "node builtins are required, not bundled",
    /require\("node:(crypto|zlib|fs\/promises)"\)/.test(readFileSync(bundle, "utf8")),
  ],
  ["Bases probe does not throw", typeof instance.basesAvailable === "boolean"],
  ["Bases absent without the API", instance.basesAvailable === false],
  ["onload completes", loadError === null || (console.error(loadError), false)],
  ["workflow store is wired", instance.workflows?.all().length === 0],
  ["request index is wired", instance.index?.size === 0],
  ["audit log is wired", typeof instance.audit?.verify === "function"],
  ["writer is wired", typeof instance.writer?.create === "function"],
  ["bulk migration is wired", typeof instance.writer?.migrate === "function"],
  ["migration quarantine is reachable", instance.needsMigration({ workflow: "", stage: "x" }) === false],
  ["note index is wired", instance.notes?.size === 0],
  ["note index reports no types on an empty vault", instance.notes?.types().length === 0],
  ["saved view store is wired", Array.isArray(instance.views?.all())],
  ["exporter is wired", typeof instance.exporter?.write === "function"],
  ["bases file writer is wired", typeof instance.basesFiles?.plan === "function"],
  [
    "loads against an Obsidian that has Bases",
    basesLoadError === null || (console.error(basesLoadError), false),
  ],
  ["Bases detected when the API is present", withBases.basesAvailable === true],
  [
    "registers both SCDB board view types",
    registeredViews.map((view) => view.id).sort().join(",") === "scdb-ageing,scdb-holdup",
  ],
  [
    "every registered board has a name, icon and factory",
    registeredViews.length > 0 &&
      registeredViews.every(
        (view) =>
          typeof view.name === "string" &&
          view.name.length > 0 &&
          typeof view.icon === "string" &&
          typeof view.factory === "function",
      ),
  ],
  ["plans the four browse dashboards", basesPlan.length === 4],
  [
    "every planned base lands in the dashboards folder",
    basesPlan.every(
      (entry) => entry.path.startsWith("90 Dashboards/") && entry.path.endsWith(".base"),
    ),
  ],
  [
    "reports nothing as stale when there is nothing on disk",
    basesPlan.every((entry) => entry.stale === false),
  ],
  [
    "no dashboard is written while Bases is absent",
    (await (async () => {
      // The command must be a no-op, not a throw, on an Obsidian without Bases.
      let threw = false;
      const before = created.length;
      try {
        await instance.createBasesDashboards();
      } catch {
        threw = true;
      }
      return !threw && created.length === before;
    })()),
  ],
  [
    "export path lands in the exports folder",
    instance.exporter?.plannedPath("queue", "csv").startsWith("95 Exports/queue-"),
  ],
  ["query rows build on an empty vault", instance.rowsFor([], Date.now()).length === 0],
  [
    "the request catalogue exposes computed fields",
    instance.catalogueFor(["scdb-request"]).some((field) => field.id === "dwell" && field.computed),
  ],
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

/** Every .tsx under src/ui, subdirectories included — boards live in them too. */
function tsxFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...tsxFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".tsx")) out.push(`${prefix}${entry.name}`);
  }
  return out;
}

const undeclared = [];
for (const name of tsxFiles(uiDir)) {
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
