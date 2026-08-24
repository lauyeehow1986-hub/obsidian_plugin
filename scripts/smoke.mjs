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
  // Obsidian clears these on unload. The harness only needs it to exist —
  // the effort timer's heartbeat is registered through it (§7 B2).
  registerInterval(id) {
    return id;
  }
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
    registeredCommands.push(command);
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
/** The person picker extends this; without it the bundle throws at load. */
class SuggestModal extends Modal {
  setPlaceholder() {}
}
class FuzzySuggestModal extends SuggestModal {}
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
  SuggestModal,
  FuzzySuggestModal,
  TAbstractFile,
  TFile,
  TFolder,
  Notice: class {},
  Setting: class {},
  App: class {},
  MarkdownRenderer: class {},
  apiVersion: "1.6.0",
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

// The effort timer's heartbeat is registered as `window.setInterval`, which is
// what Obsidian's own guidance says to use so the id is a plain number. Node
// has the timer but no `window`, so the harness supplies one — a gap in the
// stub, not in the plugin. The intervals are unref'd: a smoke run must exit.
globalThis.window ??= {
  setInterval: (...args) => {
    const id = setInterval(...args);
    if (typeof id === "object" && typeof id.unref === "function") id.unref();
    return id;
  },
  clearInterval: (id) => clearInterval(id),
};

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
const commands = [...new Set(registeredCommands.map((command) => command.id))];
const commandSpec = (id) => registeredCommands.find((command) => command.id === id);

const checks = [
  // Assert behaviour, not the class name: production builds are minified, so
  // the name is whatever esbuild chose.
  ["extends Obsidian's Plugin", instance instanceof Plugin],
  ["implements onload", typeof instance.onload === "function"],
  ["settings default to a known mode", instance.settings.mode === "hod"],
  // Pinned deliberately: this line failing means the schema moved, which is
  // the moment to check a migration step went with it (§10 — an upgrade must
  // never lose settings). Bump it only after writing that step.
  ["settings carry a schema version", instance.settings.schemaVersion === 8],
  ["the hat filter defaults to the mode you are wearing", instance.settings.hatFilter === "mode"],
  // §7 B2. No timer on a fresh install, and every timer action reachable from
  // the keyboard — the status-bar segment is a shortcut, not the only door.
  ["no timer is running on a fresh install", instance.settings.effort.timer === null],
  [
    "the timer can be started, paused and stopped from the palette",
    ["start-timer", "toggle-timer", "stop-timer", "add-time-entry"].every((id) =>
      commands.includes(id),
    ),
  ],
  ["the effort log is wired", typeof instance.effort?.months === "function"],
  ["the effort log reads no months on an empty vault", instance.effort.months().length === 0],
  [
    "the activity vocabulary falls back to the built-in list",
    instance.effort.vocabularies().activities.includes("rework"),
  ],
  // §7 B3. Reminders are in-app only, and nothing about a deadline is written
  // to a note or a calendar without the user asking for it.
  ["the obligation schedule builds on an empty vault", instance.eventSchedule().length === 0],
  [
    "deadlines are reachable from the palette",
    ["deadlines", "new-deadline", "materialise-occurrences", "export-calendar", "import-calendar"].every(
      (id) => commands.includes(id),
    ),
  ],
  [
    "the calendar file lands inside the exports folder",
    instance.events.calendarPath() === "95 Exports/scdb-deadlines.ics",
  ],
  [
    "lead reminders have a default, so an obligation is never silent until the day",
    instance.settings.events.leadDays.length > 0,
  ],
  [
    "nothing is materialised on an empty vault",
    instance.events.plans().length === 0,
  ],
  // §7 B5. The publications tracker reads notes and writes nothing until a
  // stage is moved by hand; the citation format is the one thing configurable.
  ["publications are reachable from the palette", commands.includes("publications")],
  [
    "the publication list can be copied, whole or SCDB-supported only",
    ["copy-publication-list", "copy-scdb-publication-list"].every((id) => commands.includes(id)),
  ],
  ["no publication notes on an empty vault", instance.publications().length === 0],
  [
    "citations default to Vancouver, as §5.4 names it",
    instance.settings.publications.citationFormat === "vancouver",
  ],
  ["the publication writer is wired", typeof instance.publicationWriter?.transition === "function"],
  // §7 B6. Extraction reads a note and proposes; nothing is written until the
  // review dialog is confirmed, so the smoke check is that the command is
  // reachable and the writer is wired, not that anything happened.
  ["extraction from minutes is reachable from the palette", commands.includes("extract-minutes")],
  ["the extract writer is wired", typeof instance.extract?.apply === "function"],
  [
    "extraction refuses to run without an active note",
    registeredCommands
      .filter((command) => command.id === "extract-minutes")
      .every((command) => command.checkCallback?.(true) === false),
  ],
  // §7 B7. The five templates ship compiled in, so a report can be generated
  // in a vault where `_config/reports/` does not exist — and nothing is
  // written there until the user asks (rule 3).
  ["generating a report is reachable from the palette", commands.includes("generate-report")],
  [
    "the built-in templates can be written out on request",
    commands.includes("write-report-templates"),
  ],
  [
    "five templates are available with no config in the vault",
    instance.reportTemplates.all().length === 5,
  ],
  [
    "and every one of them builds a document from an empty vault",
    await (async () => {
      for (const template of instance.reportTemplates.all()) {
        const built = await instance.reports.build(template, {
          templateId: template.id,
          period: "",
          study: "",
          format: "md",
        });
        if (!built.content.includes("not an official record")) return false;
        if (built.rows !== 0) return false;
      }
      return true;
    })(),
  ],
  [
    "a markdown report carries frontmatter the index can read",
    (
      await instance.reports.build(instance.reportTemplates.get("cv"), {
        templateId: "cv",
        period: "",
        study: "",
        format: "md",
      })
    ).content.startsWith("---\ntype: scdb-report\n"),
  ],
  // §5.10 email Tier 1. The importer reads files that are already in the vault
  // and refuses until it knows which mailboxes are yours — a wrong direction
  // inverts every follow-up, so it asks rather than guesses.
  ["importing saved email is reachable from the palette", commands.includes("import-eml")],
  [
    "no addresses of your own on a fresh install",
    instance.settings.comms.myAddresses.length === 0,
  ],
  [
    "so the importer refuses rather than guessing which way a message went",
    instance.emlImport.canDetermineDirection() === false,
  ],
  [
    "and starts working the moment it is told who you are",
    (() => {
      instance.settings.comms.myAddresses = ["yh@example.org"];
      const ready = instance.emlImport.canDetermineDirection();
      instance.settings.comms.myAddresses = [];
      return ready === true;
    })(),
  ],
  [
    "attachments land in the folder §5 names",
    instance.emlImport.attachmentsFolder() === "75 Correspondence/_attachments",
  ],
  [
    "there is nothing to import from an empty vault",
    instance.emlImport.candidates().length === 0,
  ],
  [
    // Which format the work laptop produces is decided by which Outlook is
    // installed, not by anything the user picks, so both have to be offered.
    "both saved-mail formats are offered, newest first, whatever the case",
    (() => {
      const original = instance.app.vault.getFiles;
      instance.app.vault.getFiles = () => [
        { extension: "md", stat: { mtime: 9 } },
        { extension: "eml", stat: { mtime: 2 } },
        { extension: "MSG", stat: { mtime: 3 } },
      ];
      const found = instance.emlImport.candidates().map((file) => file.extension.toLowerCase());
      instance.app.vault.getFiles = original;
      return found.length === 2 && found[0] === "msg" && found[1] === "eml";
    })(),
  ],
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
    // The stub's loadData() returns null and its vault has no adapter, so we
    // cannot tell whether a file is there — which must read as a first install,
    // not as an alarm we cannot substantiate.
    "an unverifiable empty read is treated as a first install",
    instance.settingsRead === "first-install",
  ],
  [
    // The case this exists for: loadData() returns null for a data.json it
    // could not parse exactly as for one that is absent. Running on defaults
    // silently would show up only as a wrong actor in the ledger.
    "an empty read with a file present is reported as unreadable",
    await (async () => {
      const notices = [];
      const realNotice = stub.Notice;
      stub.Notice = class {
        constructor(message) {
          notices.push(String(message));
        }
      };
      instance.app.vault.adapter = { exists: async () => true };
      try {
        await instance.loadSettings();
      } finally {
        stub.Notice = realNotice;
        delete instance.app.vault.adapter;
      }
      const told = notices.some((text) => /could not read its settings/i.test(text));
      return instance.settingsRead === "unreadable" && told;
    })(),
  ],
  [
    // Rule 8: an unreadable file is the one case where writing defaults would
    // destroy settings we simply failed to read.
    "nothing is written back when the settings file could not be read",
    await (async () => {
      let wrote = false;
      const realSave = instance.saveData.bind(instance);
      instance.saveData = async (...args) => {
        wrote = true;
        return realSave(...args);
      };
      instance.app.vault.adapter = { exists: async () => true };
      try {
        await instance.loadSettings();
      } finally {
        instance.saveData = realSave;
        delete instance.app.vault.adapter;
      }
      return wrote === false;
    })(),
  ],
  [
    // A4: the two unglamorous commands. On a laptop with no dev tools these are
    // the difference between a bug you can describe and one you cannot.
    "diagnostics and integrity each have a command",
    ["diagnostics", "integrity"].every((id) => commands.includes(id)),
  ],
  [
    // B1 ships five surfaces; four reach the palette and the fifth (the
    // chase-up itself) is a button inside the agenda dialog.
    "the daily rhythm commands are registered",
    ["quick-capture", "daily-briefing", "meeting-agenda", "chase-request", "thread-answered"].every(
      (id) => commands.includes(id),
    ),
  ],
  [
    // §7 B1 asks for one global hotkey. Left unbound it is a command nobody
    // reaches in the two seconds this feature exists to fit inside.
    "quick capture ships with a hotkey bound",
    (commandSpec("quick-capture")?.hotkeys ?? []).length === 1,
  ],
  [
    // Numeric hotkeys lose silently to Obsidian's own "go to tab #N" — learned
    // the hard way on the mode commands. Nothing here may take one.
    "no plugin hotkey is a bare number",
    registeredCommands
      .flatMap((command) => command.hotkeys ?? [])
      .every((hotkey) => !/^[1-9]$/.test(hotkey.key) || hotkey.modifiers.includes("Shift")),
  ],
  [
    // Rule 3 applied to the vault: a plugin that writes a note into somebody's
    // vault the first time they open it has made a decision that was theirs.
    "the briefing is off on a fresh install",
    instance.settings.briefing.onOpen === false && instance.settings.briefing.lastDate === "",
  ],
  [
    // §5.11 rule 1: the shipped ceiling sits under the ~2,000 where handlers cut.
    "the URI ceiling ships conservative",
    instance.settings.comms.uriCeiling > 0 && instance.settings.comms.uriCeiling <= 2000,
  ],
  [
    "the rhythm writer is wired",
    typeof instance.rhythm?.capture === "function" &&
      typeof instance.rhythm?.recordComposed === "function" &&
      Array.isArray(instance.threads()),
  ],
  ["outreach ageing runs on an empty vault", instance.agedThreads(Date.now()).length === 0],
  [
    // §5.11 rule 1, asserted on what actually ships: there must be no code path
    // that shortens a URI. Over the ceiling it is copied whole.
    "the bundle never truncates a URI",
    !/\buri\.(slice|substring|substr)\(/.test(readFileSync(bundle, "utf8")),
  ],
  [
    // Rule 4's allowlist has to survive minification — if the host name were
    // dropped, an https URL from anywhere would pass.
    "the scheme allowlist is in the bundle",
    ["mailto:", "msteams:", "teams.microsoft.com"].every((token) =>
      readFileSync(bundle, "utf8").includes(token),
    ),
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
