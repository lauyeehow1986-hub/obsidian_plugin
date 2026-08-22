import { Notice, Plugin, TFile, debounce, type WorkspaceLeaf } from "obsidian";
import { BasesFiles } from "./data/basesFiles.js";
import { stageLabels } from "./domain/bases/config.js";
import { NoteIndex } from "./data/noteIndex.js";
import { REQUEST_TYPE, RequestIndex } from "./data/requestIndex.js";
import { buildRows, catalogueFor, type RowSourceDeps } from "./data/rows.js";
import { SavedViewStore } from "./data/savedViewStore.js";
import { WorkflowStore } from "./data/workflowStore.js";
import { requestMetrics } from "./domain/request/dwell.js";
import { isStranded } from "./domain/request/migration.js";
import type { RequestNote } from "./domain/request/request.js";
import type { RequestView } from "./domain/request/holdup.js";
import { TransitionRefused } from "./domain/request/transition.js";
import type { WorkflowSpec } from "./domain/request/workflow.js";
import { migrateSettings } from "./domain/settings/migrate.js";
import { matchesMode, modeInfo, nextMode } from "./domain/settings/mode.js";
import { MODES, defaultSettings, type Mode, type ScdbSettings } from "./domain/settings/schema.js";
import type { FieldDef, Query, Row } from "./domain/query/model.js";
import type { SavedView } from "./domain/query/savedView.js";
import { AuditLog } from "./services/auditLog.js";
import { Exporter, type ExportRequest } from "./services/exporter.js";
import {
  RequestWriter,
  reportError,
  type MigrateRequestInput,
} from "./services/requestWriter.js";
import { ScdbSettingsTab } from "./settings/SettingsTab.js";
import { COCKPIT_VIEW_TYPE, CockpitView, type CockpitTab } from "./ui/CockpitView.js";
import { confirm } from "./ui/ConfirmModal.js";
import { IntakeModal } from "./ui/IntakeModal.js";
import { RequestDetailModal } from "./ui/RequestDetailModal.js";
import { TransitionModal } from "./ui/TransitionModal.js";
import { registerRequestBoards } from "./ui/bases/RequestBoards.js";

/** One row of a bulk migration, as the migration board hands it over. */
export interface MigrationRun {
  request: RequestNote;
  spec: WorkflowSpec;
  toStage: string;
  reason?: string;
}

export default class ScdbCockpitPlugin extends Plugin {
  // `Plugin` declares `settings?: unknown`; we narrow it to our schema.
  override settings: ScdbSettings = defaultSettings();
  migrationNotes: string[] = [];

  workflows!: WorkflowStore;
  /** Every typed note. The query engine reads this; A1's boards read `index`. */
  notes!: NoteIndex;
  index!: RequestIndex;
  audit!: AuditLog;
  writer!: RequestWriter;
  views!: SavedViewStore;
  exporter!: Exporter;
  basesFiles!: BasesFiles;

  /** The mode HUD (§7 A3). Null until `onload` has run. */
  private statusBar: HTMLElement | null = null;

  /**
   * Core Bases (Obsidian >= 1.10) is a progressive enhancement — never a
   * dependency (CLAUDE.md §2 rule 2). Probe for the API rather than checking a
   * version string, so a rename or backport does not silently disable us.
   */
  get basesAvailable(): boolean {
    if (this.settings.bases === "off") return false;
    return typeof (this as unknown as { registerBasesView?: unknown }).registerBasesView === "function";
  }

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.workflows = new WorkflowStore(this.app, () => this.settings.folders.config);
    this.notes = new NoteIndex(this.app);
    this.index = new RequestIndex(this.app, this.notes, this.workflows);
    this.audit = new AuditLog(this.app, () => this.settings.folders.audit);
    this.writer = new RequestWriter({
      app: this.app,
      index: this.index,
      audit: this.audit,
      requestsFolder: () => this.settings.folders.requests,
      actor: () => this.settings.actor,
    });
    this.views = new SavedViewStore(this.app, this.notes, () => this.settings.folders.dashboards);
    this.exporter = new Exporter({
      app: this.app,
      audit: this.audit,
      exportsFolder: () => this.settings.folders.exports,
      actor: () => this.settings.actor,
    });

    this.basesFiles = new BasesFiles(
      this.app,
      this.notes,
      () => this.settings.folders.dashboards,
      REQUEST_TYPE,
      // The spec is the only source of stage labels, and Bases cannot read it,
      // so they are compiled into the generated file at write time.
      () => stageLabels(this.workflows.usable()),
    );

    this.registerView(COCKPIT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CockpitView(leaf, this));
    this.registerBasesViews();
    this.addSettingTab(new ScdbSettingsTab(this.app, this));
    this.registerCommands();
    this.addRibbonIcon("layout-dashboard", "SCDB Cockpit", () => void this.activateCockpit());
    this.statusBar = this.addStatusBarItem();
    this.renderStatusBar();

    // The metadata cache is not populated until layout is ready; indexing
    // before that produces an empty board on every startup.
    this.app.workspace.onLayoutReady(() => void this.reindex());
    this.registerWatchers();

    // Migration notes are shown once on load. On the work laptop there is no
    // console to check, so anything the user needs to know must reach the UI.
    if (this.migrationNotes.length > 0) {
      new Notice("SCDB Cockpit: settings updated. See plugin settings for details.", 8000);
    }
  }

  /**
   * Offer our boards as Bases view types, when Bases exists (§7 A2b).
   *
   * Two gates, because they fail differently. Before Obsidian 1.10 the method
   * does not exist and calling it would throw on load; from 1.10 it returns
   * false when the user has the Bases core plugin switched off. Neither is an
   * error — the cockpit's own boards are unaffected either way — so this is
   * silent. Announcing "Bases not found" on every start of an older Obsidian
   * would be noise about a feature the user never asked for.
   */
  private registerBasesViews(): void {
    if (!this.basesAvailable) return;
    registerRequestBoards(this);
  }

  /**
   * Write the browsable `.base` dashboards.
   *
   * A command rather than something that happens on load: these are files in
   * the user's vault, and rule 12's principle — nothing happens by surprise —
   * applies to writes as much as to code. Existing files are never overwritten.
   */
  async createBasesDashboards(): Promise<void> {
    if (!this.basesAvailable) {
      new Notice(
        "Bases is not available in this Obsidian. The cockpit and Explore views work without it.",
        6000,
      );
      return;
    }

    const plan = await this.basesFiles.plan();
    const toWrite = plan.filter((entry) => entry.written);
    const stale = plan.filter((entry) => entry.stale);

    // Stage labels are compiled into the file because Bases cannot read the
    // workflow spec. We do not overwrite, so a stage rename leaves the old
    // label showing — say so plainly and name the remedy rather than let a
    // wrong heading pass for a right one.
    const drift =
      stale.length === 0
        ? ""
        : `\n\nOut of date with the workflow spec — stage labels will be wrong:\n${stale
            .map((entry) => `• ${entry.path}`)
            .join("\n")}\nDelete these and run this command again to regenerate them.`;

    if (toWrite.length === 0) {
      new Notice(
        stale.length === 0
          ? "Every Bases dashboard already exists. Nothing was changed."
          : `Every Bases dashboard already exists, but ${stale.length} no longer ${
              stale.length === 1 ? "matches" : "match"
            } the workflow spec. Delete and regenerate to refresh the stage labels.`,
        stale.length === 0 ? 5000 : 9000,
      );
      return;
    }

    const lines = toWrite
      .map((entry) => `• ${entry.path} — ${entry.matches} note${entry.matches === 1 ? "" : "s"}`)
      .join("\n");
    const skipped = plan.length - toWrite.length;
    const detail = skipped > 0 ? `\n\n${skipped} already exist and will be left alone.` : "";
    const ok = await confirm(
      this.app,
      `Create ${toWrite.length} Bases dashboard${toWrite.length === 1 ? "" : "s"}?\n\n${lines}${detail}${drift}`,
      "Create",
    );
    if (!ok) return;

    const results = await this.basesFiles.write();
    const written = results.filter((entry) => entry.written).length;
    new Notice(`Created ${written} Bases dashboard${written === 1 ? "" : "s"}.`, 5000);
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-cockpit",
      name: "Open cockpit",
      callback: () => void this.activateCockpit(),
    });

    this.addCommand({
      id: "new-request",
      name: "New request",
      callback: () => this.startIntake(),
    });

    this.addCommand({
      id: "move-request",
      name: "Move this request to another stage",
      checkCallback: (checking) => {
        const entry = this.currentRequest();
        if (checking) return entry !== null;
        if (entry) this.moveRequest(entry.request);
        return true;
      },
    });

    this.addCommand({
      id: "migrate-requests",
      name: "Migrate requests to the current workflow version",
      callback: () => void this.activateCockpit("migration"),
    });

    this.addCommand({
      id: "explore",
      name: "Explore notes with a query",
      callback: () => void this.activateCockpit("explore"),
    });

    this.addCommand({
      id: "create-bases-dashboards",
      name: "Create Bases dashboards",
      callback: () => void this.createBasesDashboards(),
    });

    this.addCommand({
      id: "verify-audit-ledger",
      name: "Verify audit ledger",
      callback: () => void this.verifyLedger(),
    });

    // Ctrl/Cmd+1..3 as CLAUDE.md §7 A3 asks. Obsidian shows a conflict in its
    // hotkeys pane if the user has bound these elsewhere, and they can rebind;
    // shipping no default at all would leave the documented shortcut unwired.
    MODES.forEach((mode, index) => {
      const info = modeInfo(mode);
      this.addCommand({
        id: `mode-${mode}`,
        name: `Wear the ${info.label} hat`,
        hotkeys: [{ modifiers: ["Mod"], key: String(index + 1) }],
        callback: () => void this.setMode(mode),
      });
    });

    this.addCommand({
      id: "cycle-mode",
      name: "Switch to the next hat",
      callback: () => void this.setMode(nextMode(this.settings.mode)),
    });

    this.addCommand({
      id: "toggle-hat-filter",
      name: "Show every hat, or only the one you are wearing",
      callback: () => void this.setHatFilter(this.settings.hatFilter === "mode" ? "all" : "mode"),
    });

    this.addCommand({
      id: "reindex",
      name: "Rebuild the note index",
      callback: () => void this.reindex(true),
    });
  }

  private registerWatchers(): void {
    const refresh = debounce(() => this.refreshViews(), 150, true);

    // Order matters: the request projection reads the note index, so the note
    // index has to have seen the change first.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const touched = this.notes.update(file);
        if (this.index.update(file) || touched) refresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const touched = this.notes.remove(file.path);
        if (this.index.remove(file.path) || touched) refresh();
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.notes.rename(oldPath, file);
          this.index.rename(oldPath, file);
        }
        if (this.workflows.isSpecPath(file.path) || this.workflows.isSpecPath(oldPath)) {
          void this.reloadWorkflows();
        }
        refresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
      }),
    );
  }

  private async reloadWorkflows(): Promise<void> {
    await this.workflows.reload();
    this.refreshViews();
  }

  /** Reload the workflow specs and rebuild the index from the metadata cache. */
  async reindex(announce = false): Promise<void> {
    const started = performance.now();
    await this.workflows.reload();
    this.notes.rebuild();
    this.index.rebuild();
    this.refreshViews();
    if (announce) {
      const ms = Math.round(performance.now() - started);
      new Notice(
        `SCDB: indexed ${this.notes.size} notes (${this.index.size} requests) in ${ms} ms.`,
      );
    }
  }

  // --- the mode HUD (§7 A3) ---------------------------------------------------

  /**
   * Paint the status-bar segment.
   *
   * Built with `createEl` rather than markup: the label is ours, but the rule
   * against `innerHTML` is worth keeping unconditional (§8). Glyph plus word,
   * never colour alone (§6) — and the status bar is monochrome anyway.
   */
  private renderStatusBar(): void {
    const bar = this.statusBar;
    if (bar === null) return;
    bar.empty();
    bar.addClass("scdb-mode");

    const info = modeInfo(this.settings.mode);
    const filtered = this.settings.hatFilter === "mode";
    const button = bar.createEl("button", {
      cls: "scdb-mode__button",
      attr: {
        type: "button",
        "aria-label": `Wearing the ${info.label} hat${filtered ? "" : " (showing every hat)"}. Click for ${modeInfo(nextMode(this.settings.mode)).label}.`,
      },
    });
    button.createSpan({ cls: "scdb-mode__glyph", text: info.glyph });
    button.createSpan({ cls: "scdb-mode__label", text: info.short });
    if (!filtered) {
      // The filter being off changes what every board shows, so it has to be
      // visible from the status bar — otherwise "why am I seeing this?" has no
      // answer on screen.
      button.createSpan({ cls: "scdb-mode__all", text: "all" });
    }
    button.addEventListener("click", () => void this.setMode(nextMode(this.settings.mode)));
  }

  async setMode(mode: Mode): Promise<void> {
    if (this.settings.mode === mode) return;
    this.settings.mode = mode;
    await this.saveSettings();
    new Notice(`SCDB: ${modeInfo(mode).label}. ${modeInfo(mode).blurb}`, 4000);
  }

  async setHatFilter(filter: "mode" | "all"): Promise<void> {
    if (this.settings.hatFilter === filter) return;
    this.settings.hatFilter = filter;
    await this.saveSettings();
  }

  /**
   * The requests the current hat should see, and how many it is holding back.
   *
   * The hidden count travels with the rows on purpose. Mode filtering is the
   * point of the HUD, but a filter that silently removes an overdue request is
   * a way to miss one, so every board states what it is not showing (§6).
   */
  visibleRequests(now = Date.now()): {
    views: RequestView[];
    total: number;
    hidden: number;
    filtered: boolean;
  } {
    const all = this.index.views({ now });
    if (this.settings.hatFilter === "all") {
      return { views: all, total: all.length, hidden: 0, filtered: false };
    }
    const views = all.filter((view) => matchesMode(view.request.hat, this.settings.mode));
    return { views, total: all.length, hidden: all.length - views.length, filtered: true };
  }

  refreshViews(): void {
    this.renderStatusBar();
    for (const leaf of this.app.workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof CockpitView) view.refresh();
    }
  }

  /** The request note in the active editor, if there is one. */
  private currentRequest() {
    const file = this.app.workspace.getActiveFile();
    return file ? this.index.byPath(file.path) : null;
  }

  // --- actions the UI calls ---------------------------------------------------

  startIntake(): void {
    const spec = this.workflows.only();
    if (!spec) {
      new Notice(
        this.workflows.usable().length === 0
          ? `SCDB: no usable workflow in ${this.settings.folders.config}/workflows/. Add one, then try again.`
          : "SCDB: more than one workflow is installed. Intake needs exactly one until workflow choice is added.",
        10000,
      );
      return;
    }

    new IntakeModal(this.app, {
      spec,
      existingIds: this.index.ids(),
      mode: this.settings.mode,
      onSubmit: async (submission) => {
        try {
          const file = await this.writer.create({ spec, ...submission });
          this.refreshViews();
          await this.app.workspace.getLeaf(false).openFile(file);
        } catch (error) {
          reportError(error, "could not create the request.");
        }
      },
    }).open();
  }

  moveRequest(request: RequestNote): void {
    const entry = this.index.byUid(request.uid);
    const spec = this.workflows.forRequest(request.workflow);
    if (!entry || !spec) {
      new Notice(
        `SCDB: no workflow specification for "${request.workflow || "(unset)"}", so this request cannot be moved.`,
        8000,
      );
      return;
    }

    new TransitionModal(this.app, {
      spec,
      request,
      file: entry.file,
      onSubmit: async (submission) => {
        try {
          const effect = await this.writer.transition({
            file: entry.file,
            request,
            spec,
            to: submission.to,
            ...(submission.blockedOn !== undefined ? { blockedOn: submission.blockedOn } : {}),
            ...(submission.override ? { override: submission.override } : {}),
          });
          this.refreshViews();
          new Notice(
            `SCDB: ${request.id} → ${submission.to}${effect.decision.allowed ? "" : " (gate overridden, logged)"}.`,
          );
        } catch (error) {
          if (error instanceof TransitionRefused) {
            new Notice(`SCDB: move refused. ${error.message}`, 10000);
          } else {
            reportError(error, "could not move the request.");
          }
        }
      },
    }).open();
  }

  showRequest(request: RequestNote): void {
    const entry = this.index.byUid(request.uid);
    if (!entry) return;
    const spec = this.workflows.forRequest(request.workflow);

    new RequestDetailModal(this.app, {
      request,
      metrics: requestMetrics(request, spec, { now: Date.now() }),
      spec,
      onOpenNote: () => void this.app.workspace.getLeaf(false).openFile(entry.file),
      onMove: () => this.moveRequest(request),
    }).open();
  }

  /**
   * True when a request is quarantined from stage actions by §5.2. The queue
   * boards flag these so a stranded note is visible where the work happens,
   * not only on the migration board.
   */
  needsMigration(request: RequestNote): boolean {
    const spec = this.workflows.forRequest(request.workflow);
    return spec !== null && isStranded(request, spec);
  }

  /** Apply a batch from the migration board and report what actually happened. */
  async migrateRequests(runs: readonly MigrationRun[]): Promise<void> {
    const inputs: MigrateRequestInput[] = [];
    const missing: string[] = [];

    for (const run of runs) {
      const entry = this.index.byUid(run.request.uid);
      if (entry === null) {
        missing.push(run.request.id || run.request.uid);
        continue;
      }
      inputs.push({
        file: entry.file,
        request: run.request,
        spec: run.spec,
        toStage: run.toStage,
        ...(run.reason === undefined ? {} : { reason: run.reason }),
      });
    }

    let outcomes;
    try {
      outcomes = await this.writer.migrate(inputs);
    } catch (error) {
      // Thrown before any note was touched — a missing actor, for instance.
      reportError(error, "could not migrate these requests.");
      return;
    }

    this.refreshViews();

    const migrated = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok);
    const parts = [`migrated ${migrated.length} of ${outcomes.length}`];
    if (missing.length > 0) parts.push(`${missing.length} no longer in the index`);
    if (failed.length > 0) {
      parts.push(`${failed.length} refused: ${failed[0]!.error ?? "no reason given"}`);
    }
    new Notice(`SCDB: ${parts.join("; ")}.`, failed.length > 0 ? 0 : 6000);
  }

  // --- the query surface (§7 A2) ---------------------------------------------

  private queryDeps(): RowSourceDeps {
    return { notes: this.notes, requests: this.index, workflows: this.workflows };
  }

  /** Rows for the given note types. Never cached — dwell depends on `now` (§5.1). */
  rowsFor(types: readonly string[], now: number): Row[] {
    return buildRows(this.queryDeps(), types, now);
  }

  catalogueFor(types: readonly string[]): FieldDef[] {
    return catalogueFor(this.queryDeps(), types);
  }

  openNote(path: string): void {
    const entry = this.notes.byPath(path);
    if (entry) void this.app.workspace.getLeaf(false).openFile(entry.file);
  }

  /**
   * Write a saved view, updating the note the board is currently showing or
   * creating a new one. Returns the path so the board can keep pointing at it.
   */
  async saveCurrentView(query: Query, existingPath: string): Promise<string> {
    const stored = existingPath === "" ? null : this.views.byPath(existingPath);
    const view: SavedView = stored
      ? { ...stored.view, query }
      : {
          id: "",
          title: `Saved view ${new Date().toISOString().slice(0, 10)}`,
          description: "",
          hat: this.settings.mode,
          query,
        };
    try {
      const file = await this.views.save(view, stored?.file);
      new Notice(`SCDB: saved "${view.title}" to ${file.path}.`);
      return file.path;
    } catch (error) {
      reportError(error, "could not save this view.");
      return existingPath;
    }
  }

  /**
   * Export a result, after confirming it.
   *
   * The confirmation names the file and the row count before anything is
   * written (§7 A3), because an export is the moment vault content becomes a
   * file that can travel.
   */
  async exportQuery(request: ExportRequest): Promise<void> {
    const planned = this.exporter.plannedPath(request.basename, request.extension);
    const rows = `${request.rows} row${request.rows === 1 ? "" : "s"}`;
    const go = await confirm(this.app, `Write ${rows} to ${planned}?`, "Export");
    if (!go) return;

    try {
      const result = await this.exporter.write(request);
      new Notice(`SCDB: exported ${rows} to ${result.path}. Logged to the audit ledger.`, 8000);
    } catch (error) {
      reportError(error, "could not write the export.");
    }
  }

  async verifyLedger(): Promise<void> {
    try {
      const result = await this.audit.verify();
      new Notice(`SCDB: ${AuditLog.describe(result)}`, result.ok ? 8000 : 0);
    } catch (error) {
      reportError(error, "could not verify the audit ledger.");
    }
  }

  async activateCockpit(tab?: CockpitTab): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(COCKPIT_VIEW_TYPE);

    if (existing.length > 0) {
      const leaf = existing[0]!;
      await workspace.revealLeaf(leaf);
      if (tab && leaf.view instanceof CockpitView) leaf.view.focusTab(tab);
      return;
    }

    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: COCKPIT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    if (tab && leaf.view instanceof CockpitView) leaf.view.focusTab(tab);
  }

  async loadSettings(): Promise<void> {
    const result = migrateSettings(await this.loadData());
    this.settings = result.settings;
    this.migrationNotes = result.notes;

    if (result.fromFuture) {
      // Do not persist. Writing our older shape over a newer one is exactly the
      // data loss rule 8 exists to prevent.
      new Notice(
        "SCDB Cockpit: this vault's settings were written by a newer version. Running read-only on settings to avoid data loss.",
        10000,
      );
      return;
    }

    if (result.changed) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshViews();
  }
}
