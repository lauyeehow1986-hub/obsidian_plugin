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
import {
  migrateSettings,
  settingsReadState,
  unreadableSettingsMessage,
  type SettingsReadState,
} from "./domain/settings/migrate.js";
import { allModes, matchesMode, modeInfo, nextMode } from "./domain/settings/mode.js";
import {
  buildOverview,
  type DatedNote,
  type Overview,
} from "./domain/overview/overview.js";
import {
  PUBLICATION_TYPE,
  parsePublication,
  type PublicationNote,
} from "./domain/publication/publication.js";
import { governanceRisk } from "./domain/request/analytics.js";
import {
  boardRowCount,
  buildBoardDocument,
  type BoardContext,
  type BoardId,
} from "./domain/report/boards.js";
import { renderDocument } from "./domain/report/document.js";
import { toVaultMinute } from "./domain/time/dates.js";
import { backupAge, formatBytes } from "./domain/backup/snapshots.js";
import { describeRestore } from "./domain/backup/restore.js";
import { MODES, defaultSettings, type Mode, type ScdbSettings } from "./domain/settings/schema.js";
import type { FieldDef, Query, Row } from "./domain/query/model.js";
import type { SavedView } from "./domain/query/savedView.js";
import { AuditLog } from "./services/auditLog.js";
import { BackupService } from "./services/backup.js";
import { collectDiagnostics } from "./services/diagnostics.js";
import { applyRepairs, collectIntegrityFindings } from "./services/integrity.js";
import { Exporter, type ExportRequest } from "./services/exporter.js";
import {
  RequestWriter,
  reportError,
  type MigrateRequestInput,
} from "./services/requestWriter.js";
import { ScdbSettingsTab } from "./settings/SettingsTab.js";
import { COCKPIT_VIEW_TYPE, CockpitView, type CockpitTab } from "./ui/CockpitView.js";
import { askPassphrase, pickSnapshot } from "./ui/BackupModals.js";
import { DiagnosticsModal } from "./ui/DiagnosticsModal.js";
import { IntegrityModal } from "./ui/IntegrityModal.js";
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
  /** How the last settings read went. Surfaced in diagnostics (A4). */
  settingsRead: SettingsReadState = "loaded";

  workflows!: WorkflowStore;
  /** Every typed note. The query engine reads this; A1's boards read `index`. */
  notes!: NoteIndex;
  index!: RequestIndex;
  audit!: AuditLog;
  writer!: RequestWriter;
  views!: SavedViewStore;
  exporter!: Exporter;
  basesFiles!: BasesFiles;
  backup!: BackupService;

  /** The mode HUD (§7 A3). Null until `onload` has run. */
  private statusBar: HTMLElement | null = null;
  /** The backup nag (§7 A4). A separate segment so it can be absent entirely. */
  private backupBar: HTMLElement | null = null;

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

    this.backup = new BackupService({
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      settings: () => this.settings.backup,
      pluginVersion: () => this.manifest.version,
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
    this.backupBar = this.addStatusBarItem();
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
      id: "needs-attention",
      name: "Show what needs attention",
      callback: () => void this.activateCockpit("overview"),
    });

    this.addCommand({
      id: "analytics",
      name: "Show queue analytics",
      callback: () => void this.activateCockpit("analytics"),
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

    this.addCommand({
      id: "backup-now",
      name: "Take an encrypted backup snapshot",
      callback: () => void this.takeSnapshot(),
    });

    this.addCommand({
      id: "verify-backup",
      name: "Verify a backup snapshot",
      callback: () => void this.verifySnapshot(),
    });

    this.addCommand({
      id: "restore-backup",
      name: "Restore from a backup snapshot",
      callback: () => void this.restoreSnapshot(),
    });

    this.addCommand({
      id: "diagnostics",
      name: "Run diagnostics self-test",
      callback: () => void this.runDiagnostics(),
    });

    this.addCommand({
      id: "integrity",
      name: "Check link and reference integrity",
      callback: () => void this.checkIntegrity(),
    });

    // CLAUDE.md §7 A3 asks for Ctrl+1/2/3. Obsidian core already binds Ctrl+1..8
    // to "Go to tab #N" — verified in 1.12.7, where the core binding wins and
    // ours never fires — so the default is one modifier along. A shortcut that
    // silently loses to a core binding is worse than a working one next door;
    // the hotkeys pane still lets the user take Ctrl+1..3 if they prefer.
    MODES.forEach((mode, index) => {
      const info = modeInfo(mode);
      this.addCommand({
        id: `mode-${mode}`,
        name: `Wear the ${info.label} hat`,
        hotkeys: [{ modifiers: ["Mod", "Shift"], key: String(index + 1) }],
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
    this.renderBackupBar();
  }

  /**
   * The backup nag (§7 A4).
   *
   * Shown only once a destination has been configured. Nagging about a feature
   * nobody has switched on is noise, and the place to notice that backups are
   * off entirely is the diagnostics report, which says so in as many words.
   * Once it *is* on, "never" counts as stale — that is the state A4 exists for.
   */
  private renderBackupBar(): void {
    const bar = this.backupBar;
    if (bar === null) return;
    bar.empty();

    const config = this.settings.backup;
    if (config.destination.trim() === "") {
      bar.hide();
      return;
    }

    const last = config.lastAt === "" ? null : Date.parse(config.lastAt);
    const age = backupAge(
      last === null || Number.isNaN(last) ? null : last,
      config.intervalDays,
      Date.now(),
    );
    if (!age.stale) {
      bar.hide();
      return;
    }

    bar.show();
    bar.addClass("scdb-backupnag");
    const button = bar.createEl("button", {
      cls: "scdb-backupnag__button",
      attr: { type: "button", "aria-label": `${age.text} Click to take one now.` },
    });
    // Glyph plus words, never colour alone (§6).
    button.createSpan({ cls: "scdb-backupnag__glyph", text: "⛨" });
    button.createSpan({
      text: age.days === null ? "No backup" : `Backup ${age.days}d old`,
    });
    button.addEventListener("click", () => void this.takeSnapshot());
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

  /**
   * The overview pane's three lists (§7 A3).
   *
   * Assembled here because it is the only place that can see all three sources
   * — the request projection, the generic note index and the publication
   * notes. The ordering and the "what counts as needing attention" rules are in
   * `domain/overview`, where they are testable.
   */
  overview(views: readonly RequestView[]): Overview {
    const now = Date.now();
    const spec = this.workflows.only();

    // One gate evaluation for the whole board rather than one per request:
    // `governanceRisk` already walks every allowed transition, and doing it
    // twice would double the most expensive thing on the pane.
    const blocked = new Set(
      governanceRisk(views, spec, now).blocked.map((view) => view.request.uid),
    );

    const dated: DatedNote[] = [];
    const publications: PublicationNote[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type === REQUEST_TYPE) continue;
      if (entry.type === PUBLICATION_TYPE) {
        publications.push(parsePublication(entry.file.path, entry.frontmatter));
      }
      dated.push({ path: entry.file.path, type: entry.type, frontmatter: entry.frontmatter });
    }

    return buildOverview(views, dated, publications, {
      now,
      stranded: (view) => this.needsMigration(view.request),
      governanceBlocked: (view) => blocked.has(view.request.uid),
    });
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
  async exportDocument(request: ExportRequest): Promise<void> {
    const rows = `${request.rows} row${request.rows === 1 ? "" : "s"}`;
    let planned: string;
    try {
      planned = this.exporter.plannedPath(request.basename, request.extension);
    } catch (error) {
      // Nothing has been written, so this is a refusal rather than a failure.
      reportError(error, "could not work out where to write the export.");
      return;
    }

    const go = await confirm(this.app, `Write ${rows} to ${planned}?`, "Export");
    if (!go) return;

    try {
      const result = await this.exporter.write(request);
      new Notice(`SCDB: exported ${rows} to ${result.path}. Logged to the audit ledger.`, 8000);
    } catch (error) {
      reportError(error, "could not write the export.");
    }
  }

  /**
   * Write a board out as a self-contained HTML file (§7 A3).
   *
   * The snapshot carries exactly what the board shows, including the hat
   * filter — so the document states its own scope rather than leaving a reader
   * to assume it is the whole queue.
   */
  async exportBoard(board: BoardId): Promise<void> {
    const now = Date.now();
    const { views, hidden, filtered } = this.visibleRequests(now);
    const info = modeInfo(this.settings.mode);

    const context: BoardContext = {
      views,
      allViews: this.index.views({ now }),
      spec: this.workflows.only(),
      hats: allModes().map((entry) => ({ id: entry.id, label: entry.label })),
      now,
      generatedAt: toVaultMinute(now).replace("T", " "),
      scope: filtered
        ? `${info.label} work only` +
          (hidden > 0 ? `; ${hidden} request${hidden === 1 ? "" : "s"} under another hat not shown` : "")
        : "Every hat",
    };

    const document = buildBoardDocument(board, context);
    await this.exportDocument({
      basename: document.title,
      extension: "html",
      content: renderDocument(document),
      subject: `BOARD-${board}`,
      rows: boardRowCount(board, context),
    });
  }

  // --- encrypted snapshots (§7 A4) --------------------------------------------

  /**
   * Take a snapshot, after confirming what goes in and what comes out.
   *
   * The confirmation is not a formality. It names the destination folder, the
   * file about to be written, how many files and how much data are going into
   * it, and — the part that matters — every older snapshot the retention limit
   * is about to delete, by name. Deleting a backup is the most consequential
   * thing this plugin does to a file it cannot recreate.
   */
  async takeSnapshot(): Promise<void> {
    const problem = await this.backup.destinationProblem();
    if (problem !== null) {
      new Notice(`SCDB: ${problem}`, 12000);
      return;
    }

    const plan = await this.backup.plan();
    if (plan.files === 0) {
      new Notice("SCDB: this vault has no files to back up.", 6000);
      return;
    }

    const lines = [
      `Write an encrypted snapshot of ${plan.files} file${plan.files === 1 ? "" : "s"} (${formatBytes(plan.bytes)})?`,
      "",
      `• Into ${plan.destination}`,
      `• As ${plan.name}`,
      // Said every time, because it is the line people forget: what is NOT in
      // the file matters as much as what is.
      "• Notes and attachments only — Obsidian settings, themes and plugins are not included",
    ];
    if (plan.retention.remove.length > 0) {
      lines.push("");
      lines.push(`Keeping the newest ${this.settings.backup.keep}, so these will be deleted:`);
      for (const name of plan.retention.remove) lines.push(`• ${name}`);
    }
    if (plan.retention.foreign.length > 0) {
      const n = plan.retention.foreign.length;
      lines.push("");
      lines.push(
        `${n} other file${n === 1 ? "" : "s"} in that folder ${n === 1 ? "is" : "are"} not a snapshot and will not be touched.`,
      );
    }

    if (!(await confirm(this.app, lines.join("\n"), "Take snapshot"))) return;

    const passphrase = await askPassphrase(this.app, {
      title: "Passphrase for this snapshot",
      lede: `Encrypts ${plan.name} with AES-256-GCM. Each snapshot carries its own salt, so a passphrase you change later still opens the older files it was used for.`,
      confirm: true,
      actionLabel: "Encrypt and write",
    });
    if (passphrase === null) return;

    const working = new Notice("SCDB: writing snapshot…", 0);
    try {
      const result = await this.backup.create(passphrase);
      this.settings.backup.lastAt = new Date(result.at).toISOString();
      this.settings.backup.lastName = result.name;
      await this.saveSettings();

      const removed =
        result.removed.length > 0
          ? ` ${result.removed.length} older snapshot${result.removed.length === 1 ? "" : "s"} removed.`
          : "";
      new Notice(
        `SCDB: wrote ${result.name} — ${result.files} files, ${formatBytes(result.bytes)}.${removed} ` +
          "Run “Verify a backup snapshot” now: a backup nobody has ever opened is not a backup.",
        0,
      );
    } catch (error) {
      reportError(error, "could not write the snapshot.");
    } finally {
      working.hide();
    }
  }

  /** Pick a snapshot from the destination, or say why there is nothing to pick. */
  private async chooseSnapshot(lede: string): Promise<string | null> {
    const problem = await this.backup.destinationProblem();
    if (problem !== null) {
      new Notice(`SCDB: ${problem}`, 12000);
      return null;
    }
    const snapshots = await this.backup.list();
    if (snapshots.length === 0) {
      new Notice(`SCDB: no snapshots in ${this.settings.backup.destination}. Take one first.`, 8000);
      return null;
    }
    return pickSnapshot(this.app, snapshots, lede);
  }

  /**
   * Decrypt a snapshot and check every file against its recorded hash.
   *
   * Writes nothing. "A backup that has never been restored is not a backup"
   * (§7 A4) — this is the half of that you can run every week without a spare
   * vault to restore into.
   */
  async verifySnapshot(): Promise<void> {
    const name = await this.chooseSnapshot(
      "Decrypts it and checks every file. Nothing is written.",
    );
    if (name === null) return;

    const passphrase = await askPassphrase(this.app, {
      title: `Passphrase for ${name}`,
      lede: "The passphrase you set when this snapshot was written.",
      confirm: false,
      actionLabel: "Verify",
    });
    if (passphrase === null) return;

    const working = new Notice("SCDB: verifying snapshot…", 0);
    try {
      const result = await this.backup.verify(name, passphrase);
      const taken = new Date(result.header.created).toLocaleString();
      if (result.faults.length === 0) {
        new Notice(
          `SCDB: ${name} verified. ${result.files} files, ${formatBytes(result.bytes)}, taken ${taken} by plugin v${result.header.plugin}. Every file matches the hash recorded when it was written.`,
          0,
        );
      } else {
        new Notice(
          `SCDB: ${name} decrypted, but ${result.faults.length} file${result.faults.length === 1 ? " does" : "s do"} not match the hash recorded when it was written. First: ${result.faults[0]!.path}. Take a fresh snapshot, and keep this one until you have.`,
          0,
        );
      }
    } catch (error) {
      reportError(error, "could not verify the snapshot.");
    } finally {
      working.hide();
    }
  }

  /**
   * Restore missing files from a snapshot.
   *
   * Creates only, never overwrites (see `domain/backup/restore.ts`). Into an
   * empty vault that restores everything; into this one it fills the gaps and
   * reports what it left alone.
   */
  async restoreSnapshot(): Promise<void> {
    const name = await this.chooseSnapshot(
      "Files missing from this vault are created. Files already here are never overwritten.",
    );
    if (name === null) return;

    const passphrase = await askPassphrase(this.app, {
      title: `Passphrase for ${name}`,
      lede: "Needed to read the snapshot. Nothing is written until you have seen what it contains.",
      confirm: false,
      actionLabel: "Read snapshot",
    });
    if (passphrase === null) return;

    const working = new Notice("SCDB: reading snapshot…", 0);
    let plan;
    try {
      plan = await this.backup.planRestoreFrom(name, passphrase);
    } catch (error) {
      reportError(error, "could not read the snapshot.");
      return;
    } finally {
      working.hide();
    }

    if (plan.create.length === 0) {
      new Notice(
        `SCDB: nothing to restore from ${name} — all ${plan.existing.length} of its files are already in this vault.`,
        8000,
      );
      return;
    }

    const lines = [
      `Restore from ${name}, taken ${new Date(plan.manifest.created).toLocaleString()} from a vault named "${plan.manifest.vault}"?`,
      "",
      ...describeRestore(plan).map((line) => `• ${line}`),
    ];
    if (!(await confirm(this.app, lines.join("\n"), "Restore"))) return;

    try {
      const result = await this.backup.applyRestore(plan);
      await this.reindex();
      const failed =
        result.failed.length > 0
          ? ` ${result.failed.length} could not be written; the first was ${result.failed[0]!}.`
          : "";
      new Notice(
        `SCDB: restored ${result.created} file${result.created === 1 ? "" : "s"}.${failed}`,
        0,
      );
    } catch (error) {
      reportError(error, "could not finish the restore.");
    }
  }

  /**
   * Run the self-test and show it (§7 A4).
   *
   * It rebuilds the index, walks the ledger chain and renders a Mermaid
   * diagram, so it is slow enough to need a notice while it works — and slow
   * for the right reason: none of those answers would mean anything if they
   * were read from a cache instead of measured.
   */
  async runDiagnostics(): Promise<void> {
    const working = new Notice("SCDB: running diagnostics…", 0);
    try {
      const report = await collectDiagnostics(this);
      new DiagnosticsModal(this.app, report, {
        onSave: async (markdown, checks) => {
          await this.exportDocument({
            basename: "Diagnostics",
            extension: "md",
            content: markdown,
            subject: "DIAGNOSTICS",
            rows: checks,
          });
        },
      }).open();
    } catch (error) {
      reportError(error, "could not finish the diagnostics run.");
    } finally {
      working.hide();
    }
  }

  /**
   * Reconcile the two naming systems (§7 A4).
   *
   * §5.2 has machine references pointing at `uid` and human links staying
   * ordinary wikilinks, on purpose — this is the check that says where the two
   * have drifted. Reports everything; the only thing it offers to change is
   * creating a note that something already links to.
   */
  async checkIntegrity(): Promise<void> {
    const working = new Notice("SCDB: checking links and references…", 0);
    try {
      let subjects: string[] = [];
      try {
        subjects = await this.audit.subjects();
      } catch (error) {
        // A ledger we cannot read is a finding of its own, reported by the
        // diagnostics command. It must not stop the link check running.
        new Notice(
          `SCDB: could not read the audit ledger, so its entries were not reconciled. ${
            error instanceof Error ? error.message : String(error)
          }`,
          8000,
        );
      }

      const findings = collectIntegrityFindings(this, subjects);
      new IntegrityModal(this.app, findings, {
        onOpenNote: (path) => this.openNote(path),
        onRepair: async (repairs) => {
          const outcome = await applyRepairs(this.app, repairs, (path) =>
            path.startsWith(`${this.settings.folders.people}/`)
              ? "people"
              : path.startsWith(`${this.settings.folders.studies}/`)
                ? "studies"
                : "",
          );
          await this.reindex();
          const parts = [`created ${outcome.created.length}`];
          if (outcome.skipped.length > 0) parts.push(`${outcome.skipped.length} already existed`);
          if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} failed`);
          new Notice(`SCDB: ${parts.join(", ")}.`, 8000);
        },
      }).open();
    } catch (error) {
      reportError(error, "could not finish the integrity check.");
    } finally {
      working.hide();
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

    if (result.fromNothing) {
      // Nothing was read, so there is nothing to bring forward — and writing
      // defaults now would overwrite settings that a failed read did not
      // return. The first real change persists them.
      //
      // Which of the two this is decides whether the user hears about it: a
      // first install is normal and silent, an unreadable file is a fault and
      // must say so rather than quietly running on the wrong actor.
      this.settingsRead = settingsReadState(true, await this.settingsFileExists());
      if (this.settingsRead === "unreadable") {
        new Notice(unreadableSettingsMessage(this.settingsFilePath()), 15000);
      }
      return;
    }

    if (result.changed) await this.saveData(this.settings);
  }

  /** Where Obsidian keeps this plugin's settings. Named in diagnostics and notices. */
  settingsFilePath(): string {
    return `${this.manifest.dir ?? ".obsidian/plugins/scdb-cockpit"}/data.json`;
  }

  /**
   * False when there is no settings file — and also when we cannot tell.
   *
   * The adapter is desktop API surface we do not control; if it is absent or
   * throws, the honest answer is "no evidence of a file", which keeps us quiet
   * rather than raising an alarm we cannot stand behind.
   */
  private async settingsFileExists(): Promise<boolean> {
    try {
      const adapter = this.app.vault.adapter as { exists?: (p: string) => Promise<boolean> } | undefined;
      if (typeof adapter?.exists !== "function") return false;
      return await adapter.exists(this.settingsFilePath());
    } catch {
      return false;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshViews();
  }
}
