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
import { AgendaModal, type AgendaSend } from "./ui/AgendaModal.js";
import { CaptureModal, captureFailed } from "./ui/CaptureModal.js";
import { PersonPicker } from "./ui/PersonPicker.js";
import { RhythmWriter } from "./services/rhythmWriter.js";
import { copyToClipboard, launchUri, reportLaunch } from "./services/protocol.js";
import {
  agendaCandidates,
  type AgendaInput,
  type AgendaNote,
} from "./domain/comms/agenda.js";
import {
  DEFAULT_CHASE_TEMPLATE,
  readTemplate,
  type MessageTemplate,
} from "./domain/comms/message.js";
import { buildMailto, buildTeamsChat } from "./domain/comms/uri.js";
import {
  agedOutreach,
  CORRESPONDENCE_TYPE,
  type AgedThread,
  type Thread,
} from "./domain/comms/thread.js";
import { markAnswered, threadToContinue } from "./domain/comms/threadUpdate.js";
import { briefingDue } from "./domain/briefing/briefing.js";
import { EffortLog } from "./services/effortLog.js";
import { HEARTBEAT_MS, TimerService, type StopOutcome } from "./services/timerService.js";
import {
  DIMENSION_LABELS,
  formatMinutes,
  rollUpCsv,
  type EffortDimension,
  type RollUpBucket,
} from "./domain/effort/aggregate.js";
import { compareToEstimate } from "./domain/effort/aggregate.js";
import { activityOrFallback, defaultActivityFor } from "./domain/effort/vocabulary.js";
import {
  emptyBinding,
  timerLabel,
  type TimerBinding,
  type TimerState,
} from "./domain/effort/timer.js";
import type { TimeEntry } from "./domain/effort/entry.js";
import { askBinding, askEntry, askIdle, askRecovery } from "./ui/TimerModals.js";

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
  /** Captures, correspondence threads and the daily briefing (§7 B1). */
  rhythm!: RhythmWriter;
  /** The monthly effort tables in `80 Time/` (§5.3). */
  effort!: EffortLog;
  /** The running timer (§7 B2). */
  timer!: TimerService;

  /** The mode HUD (§7 A3). Null until `onload` has run. */
  private statusBar: HTMLElement | null = null;
  /** The backup nag (§7 A4). A separate segment so it can be absent entirely. */
  private backupBar: HTMLElement | null = null;
  /** The effort timer (§7 B2). Hidden until a timer is running. */
  private timerBar: HTMLElement | null = null;

  /**
   * Bumped whenever a month file in `80 Time/` changes on disk.
   *
   * The effort board reads whole files rather than the note index, so a
   * re-render alone does not refetch them — a Preact effect keyed on the month
   * has no reason to re-run. Without this counter the table sat on "Nothing
   * recorded" immediately after the timer wrote a row into the file it was
   * looking at, which is the one moment it has to be right.
   */
  effortVersion = 0;

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

    this.effort = new EffortLog({
      app: this.app,
      audit: this.audit,
      timeFolder: () => this.settings.folders.time,
      configFolder: () => this.settings.folders.config,
      actor: () => this.settings.actor,
    });

    this.timer = new TimerService({
      app: this.app,
      log: this.effort,
      settings: () => this.settings,
      save: () => this.saveSettings(),
      refresh: () => this.refreshViews(),
      askStop: (entry, title) =>
        askEntry(this.app, entry, {
          title,
          lede: "This is what will be written to the effort log. Fix it now while it is fresh.",
          submitLabel: "Record",
          discardLabel: "Discard",
          activities: this.effort.vocabularies().activities,
          costCentres: this.effort.vocabularies().costCentres,
        }),
      askIdle: (gap, state) => askIdle(this.app, gap, state),
      askRecovery: (recovery) => askRecovery(this.app, recovery),
    });

    this.rhythm = new RhythmWriter({
      app: this.app,
      notes: this.notes,
      audit: this.audit,
      folder: (key) => this.settings.folders[key],
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
    this.timerBar = this.addStatusBarItem();
    this.backupBar = this.addStatusBarItem();
    this.renderStatusBar();

    // The heartbeat is the crash-safety story (§7 B2): state is written on
    // every beat, so a crash costs at most one minute. It also repaints the
    // status bar, which is why it runs even when no timer is going.
    this.registerInterval(
      window.setInterval(() => {
        if (this.timer.current() === null) return;
        void this.timer.tick();
      }, HEARTBEAT_MS),
    );

    // The metadata cache is not populated until layout is ready; indexing
    // before that produces an empty board on every startup.
    this.app.workspace.onLayoutReady(() =>
      void this.reindex()
        .then(() => this.effort.loadVocabularies())
        // Recovery asks before the briefing writes: a timer left running is a
        // question about time already spent, and it should not be behind a
        // note the plugin generated on the way past.
        .then(() => this.timer.recoverOnLoad())
        .then(() => this.maybeWriteBriefing()),
    );
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

    // §7 B1 asks for one global hotkey for capture. Mod+Shift+C is free in
    // Obsidian core; if the host binds it, the hotkeys pane reassigns it in
    // two clicks. Numeric defaults are the ones that lose silently to core
    // bindings, which is why the mode commands sit on Mod+Shift.
    this.addCommand({
      id: "quick-capture",
      name: "Capture a note to the inbox",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "C" }],
      callback: () => this.quickCapture(),
    });

    this.addCommand({
      id: "daily-briefing",
      name: "Write today's briefing",
      callback: () => void this.writeBriefing(true),
    });

    this.addCommand({
      id: "meeting-agenda",
      name: "Build a meeting agenda for someone",
      callback: () => void this.openAgenda(),
    });

    this.addCommand({
      id: "chase-request",
      name: "Chase up whoever this request is waiting on",
      checkCallback: (checking) => {
        const blockedOn = this.activeRequestHoldup();
        if (blockedOn === null) return false;
        if (!checking) void this.openAgenda(blockedOn);
        return true;
      },
    });

    this.addCommand({
      id: "thread-answered",
      name: "Mark this correspondence thread answered",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file === null || this.notes.byPath(file.path)?.type !== CORRESPONDENCE_TYPE) {
          return false;
        }
        if (!checking) void this.markThreadAnswered(file);
        return true;
      },
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
      id: "start-timer",
      name: "Start the timer",
      // Not Mod+Shift+T: that is Obsidian's own "Reopen last closed tab", and
      // the core binding wins silently — verified by pressing it in 1.12.7 and
      // watching nothing happen. Same trap as Ctrl+1..3 above. The hotkeys pane
      // still lets the user take it if they would rather.
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "T" }],
      callback: () => void this.startTimer(),
    });

    this.addCommand({
      id: "toggle-timer",
      name: "Pause or resume the timer",
      checkCallback: (checking) => {
        if (this.timer.current() === null) return false;
        if (!checking) void this.timer.toggle();
        return true;
      },
    });

    this.addCommand({
      id: "stop-timer",
      name: "Stop the timer and record the time",
      checkCallback: (checking) => {
        if (this.timer.current() === null) return false;
        if (!checking) void this.timer.stop();
        return true;
      },
    });

    this.addCommand({
      id: "time-this-request",
      name: "Start the timer on this request",
      checkCallback: (checking) => {
        const entry = this.currentRequest();
        if (checking) return entry !== null && this.timer.current() === null;
        if (entry) void this.startTimer(entry.request.id, entry.request.study ?? "");
        return true;
      },
    });

    this.addCommand({
      id: "add-time-entry",
      name: "Add a time entry",
      callback: () => void this.addTimeEntry(),
    });

    this.addCommand({
      id: "open-effort",
      name: "Open the effort table",
      callback: () => void this.activateCockpit("effort"),
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
        this.effortFileChanged(file.path, refresh);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
        this.effortFileChanged(file.path, refresh);
      }),
    );
  }

  /**
   * The effort log and the vocabulary are plain files, not notes, so the
   * metadata cache never mentions them. Watched on the vault directly, and the
   * board is repainted when a month is edited by hand — the file is the record,
   * and a table showing something else is worse than no table.
   */
  private effortFileChanged(path: string, refresh: () => void): void {
    if (this.effort.isVocabularyPath(path)) {
      void this.effort.loadVocabularies().then(refresh);
      return;
    }
    if (this.effort.isEffortPath(path)) {
      this.effortVersion += 1;
      refresh();
    }
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
    this.renderTimerBar();
    this.renderBackupBar();
  }

  /**
   * The effort timer segment (§7 B2).
   *
   * Absent entirely when nothing is running: a permanent "no timer" chip is a
   * permanent reproach, and the status bar is shared with every other plugin.
   * Clicking it stops and records; the palette holds pause and resume, because
   * a single click should do the thing you most often want and never be the
   * one that loses a session.
   */
  private renderTimerBar(): void {
    const bar = this.timerBar;
    if (bar === null) return;
    bar.empty();

    const state = this.timer.current();
    if (state === null) {
      bar.hide();
      return;
    }

    bar.show();
    bar.addClass("scdb-timer");
    const label = timerLabel(state, Date.now());
    const button = bar.createEl("button", {
      cls: state.status === "paused" ? "scdb-timer__button scdb-timer__button--paused" : "scdb-timer__button",
      attr: { type: "button", "aria-label": `${label}. Click to stop and record.` },
    });
    // Glyph plus words, never colour alone (§6).
    button.createSpan({ cls: "scdb-timer__glyph", text: state.status === "paused" ? "❙❙" : "▶" });
    button.createSpan({ text: label });
    button.addEventListener("click", () => void this.timer.stop());
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
      loadEffort: async () => (await this.effortForRequest(request)).comparison,
      onStartTimer: () => void this.startTimer(request.id, request.study),
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

    const { dated, publications } = this.noteSources();

    return buildOverview(views, dated, publications, {
      now,
      withinDays: this.settings.briefing.horizonDays,
      stranded: (view) => this.needsMigration(view.request),
      governanceBlocked: (view) => blocked.has(view.request.uid),
    });
  }

  /**
   * Every non-request note, plus the publications parsed out of them.
   *
   * One walk of the index shared by the overview and the agenda. `DatedNote`
   * and `AgendaNote` are the same three fields, so a second walk would only be
   * a second chance for the two to disagree about what the vault holds.
   */
  private noteSources(): { dated: DatedNote[]; publications: PublicationNote[] } {
    const dated: DatedNote[] = [];
    const publications: PublicationNote[] = [];

    for (const entry of this.notes.all()) {
      if (entry.type === REQUEST_TYPE) continue;
      if (entry.type === PUBLICATION_TYPE) {
        publications.push(parsePublication(entry.file.path, entry.frontmatter));
      }
      dated.push({ path: entry.file.path, type: entry.type, frontmatter: entry.frontmatter });
    }

    return { dated, publications };
  }

  // --- the daily rhythm (§7 B1) ---------------------------------------------

  /** Every correspondence thread the vault holds (§5.10). */
  threads(): Thread[] {
    return this.rhythm.threads().map((entry) => entry.thread);
  }

  /** Outreach with no reply recorded, past the configured chase interval. */
  agedThreads(now = Date.now()): AgedThread[] {
    return agedOutreach(this.threads(), { now, chaseDays: this.settings.comms.chaseDays });
  }

  /** Everything the agenda joins over, gathered once. */
  private agendaSources(now: number): Omit<AgendaInput, "party"> {
    const { dated, publications } = this.noteSources();
    return {
      now,
      views: this.index.views({ now }),
      threads: this.threads(),
      publications,
      notes: dated as AgendaNote[],
      chaseDays: this.settings.comms.chaseDays,
    };
  }

  /**
   * Quick capture: one line, into the inbox, no second question.
   *
   * The write is deliberately not awaited by the dialog — it closes on Enter
   * and the note lands a moment later. A failure reports itself in a notice
   * carrying the typed line back, so nothing is lost silently (§8).
   */
  quickCapture(): void {
    new CaptureModal(this.app, this.settings.mode, (text) => {
      void (async () => {
        try {
          const file = await this.rhythm.capture({
            text,
            now: Date.now(),
            mode: this.settings.mode,
          });
          new Notice(`Captured to ${file.path}`, 4000);
        } catch (error) {
          captureFailed(text, error);
        }
      })();
    }).open();
  }

  /** Write today's briefing if it is not already there. */
  async writeBriefing(manual: boolean): Promise<void> {
    const now = Date.now();
    const views = this.index.views({ now });

    try {
      const result = await this.rhythm.briefing({
        now,
        actor: this.settings.actor,
        mode: this.settings.mode,
        overview: this.overview(views),
        outreach: this.agedThreads(now),
        views,
      });

      // Recorded whether or not we wrote it: the point of the date is "today
      // has been handled", and a briefing already on disk handles today.
      if (this.settings.briefing.lastDate !== result.file.basename) {
        this.settings.briefing.lastDate = result.file.basename;
        await this.saveSettings();
      }

      if (manual) {
        await this.app.workspace.getLeaf(false).openFile(result.file);
        if (!result.created) {
          new Notice("Today's briefing already exists; opened it rather than overwriting.", 6000);
        }
      } else if (result.created && !result.quiet) {
        new Notice(`SCDB: today's briefing is ready — ${result.file.path}`, 8000);
      }
    } catch (error) {
      reportError(error, "could not write today's briefing.");
    }
  }

  /** The automatic path: only when asked for, and only once a day. */
  private maybeWriteBriefing(): void {
    if (!this.settings.briefing.onOpen) return;
    if (!briefingDue(this.settings.briefing.lastDate, Date.now())) return;
    void this.writeBriefing(false);
  }

  /** `blocked_on` for the request in the active note, or null. */
  private activeRequestHoldup(): string | null {
    const file = this.app.workspace.getActiveFile();
    if (file === null) return null;
    const entry = this.index.byPath(file.path);
    const blockedOn = entry?.request.blockedOn ?? null;
    return blockedOn === null || blockedOn.trim() === "" ? null : blockedOn;
  }

  /**
   * The meeting agenda, and the chase-up composed from it.
   *
   * Without a person, the picker opens first; the counts it shows come from
   * the same single pass the agenda itself will use, so the number in the list
   * and the number of rows behind it cannot disagree.
   */
  async openAgenda(party?: string): Promise<void> {
    const now = Date.now();
    const sources = this.agendaSources(now);

    if (party === undefined) {
      const candidates = agendaCandidates(sources);
      if (candidates.length === 0) {
        new Notice(
          "Nobody is recorded as holding anything up. Set `blocked_on` when you move a request, and this becomes the list.",
          8000,
        );
        return;
      }
      new PersonPicker(
        this.app,
        candidates.map((entry) => ({
          party: entry.party,
          count: entry.count,
          detail: entry.detail,
        })),
        (choice) => void this.openAgenda(choice.party.raw),
      ).open();
      return;
    }

    new AgendaModal(this.app, {
      input: { ...sources, party },
      template: await this.chaseTemplate(),
      actor: this.settings.actor,
      ceiling: this.settings.comms.uriCeiling,
      knownAddress: this.addressFor(party),
      onSend: (send) => this.sendChase(send),
      onCopyAgenda: async (markdown) => {
        new Notice(
          (await copyToClipboard(markdown))
            ? "Agenda copied."
            : "SCDB: the clipboard could not be written to.",
          4000,
        );
      },
    }).open();
  }

  /**
   * The chase-up template from `_config/messages/`, or the built-in one.
   *
   * §5.11 rule 7: tone and signature are the user's. A missing file is the
   * ordinary case rather than an error, so it falls back silently.
   */
  private async chaseTemplate(): Promise<MessageTemplate> {
    const path = `${this.settings.folders.config}/messages/chase-up.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return DEFAULT_CHASE_TEMPLATE;

    try {
      const text = await this.app.vault.read(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const end = cache?.frontmatterPosition?.end.offset ?? 0;
      return readTemplate("chase-up", cache?.frontmatter ?? {}, text.slice(end));
    } catch {
      return DEFAULT_CHASE_TEMPLATE;
    }
  }

  /**
   * An address already recorded for this person, if the vault holds one.
   *
   * Read from a person note's `email`, matched on the wikilink target. Never
   * guessed from a name: a wrong address on a chase-up about a data request is
   * a disclosure, not a typo.
   */
  private addressFor(party: string): string {
    const name = party.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0] ?? party;
    const basename = (name.split("/").pop() ?? name).trim().toLowerCase();

    for (const entry of this.notes.all()) {
      if (entry.file.basename.trim().toLowerCase() !== basename) continue;
      const email = entry.frontmatter["email"];
      if (typeof email === "string" && email.trim() !== "") return email.trim();
    }
    return "";
  }

  /**
   * Hand the draft to the OS, then record what actually happened.
   *
   * The order matters. The thread is written *after* the launch, and records
   * the outcome the launch reported — `via: clipboard` when it went to the
   * clipboard, `via: mailto` when a handler opened it. Writing first would
   * claim a composition that never happened; §5.11 rule 6 already forbids
   * claiming it was sent, and claiming it was even composed would be the same
   * mistake one step earlier.
   */
  private async sendChase(send: AgendaSend): Promise<void> {
    const now = Date.now();
    const plainText = `${send.draft.subject}\n\n${send.draft.body}`;

    let via: string;
    if (send.channel === "clipboard") {
      if (!(await copyToClipboard(plainText))) {
        new Notice("SCDB: the clipboard could not be written to. Nothing was recorded.", 8000);
        return;
      }
      new Notice("Message copied. Nothing has been sent.", 5000);
      via = "clipboard";
    } else {
      const built =
        send.channel === "teams"
          ? buildTeamsChat({ users: send.addresses, message: plainText })
          : buildMailto({
              to: send.addresses,
              subject: send.draft.subject,
              body: send.draft.body,
            });

      if (!built.ok) {
        // Refused addresses are named so they can be fixed in the note they
        // came from. Nothing was opened and nothing is recorded.
        new Notice(`SCDB: ${built.problems.join(" ")}`, 12000);
        return;
      }

      const outcome = await launchUri(built.uri, {
        ceiling: this.settings.comms.uriCeiling,
        plainText,
      });
      reportLaunch(outcome);
      if (!outcome.ok) return;
      via = outcome.how === "copied" ? "clipboard" : send.channel === "teams" ? "teams" : "mailto";
    }

    try {
      const requests = send.agenda.items
        .filter((item) => item.kind === "request")
        .map((item) => item.link);
      const file = await this.rhythm.recordComposed(
        {
          now,
          channel: send.channel === "teams" ? "teams" : "email",
          with: [send.agenda.party.raw],
          requests,
          subject: send.draft.subject,
          via,
          summary: send.summary,
        },
        threadToContinue(this.threads(), [send.agenda.party.raw], requests),
      );
      this.refreshViews();
      new Notice(`Recorded on ${file.basename}. It will age until you mark it answered.`, 6000);
    } catch (error) {
      reportError(error, "the draft was prepared but could not be recorded on a thread.");
    }
  }

  /** The note behind a thread, resolved on uid rather than on the human label (§5.2). */
  private threadFile(thread: Thread): TFile | null {
    const match = this.rhythm
      .threads()
      .find((entry) =>
        thread.uid === "" ? entry.thread.id === thread.id : entry.thread.uid === thread.uid,
      );
    return match?.file ?? null;
  }

  async openThreadNote(thread: Thread): Promise<void> {
    const file = this.threadFile(thread);
    if (file === null) {
      new Notice(`SCDB: ${thread.id} is no longer in the index. Rebuild it and try again.`, 8000);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  /** Close the loop from the board rather than from inside the note. */
  async answerThread(thread: Thread): Promise<void> {
    const file = this.threadFile(thread);
    if (file === null) {
      new Notice(`SCDB: ${thread.id} is no longer in the index. Rebuild it and try again.`, 8000);
      return;
    }
    await this.markThreadAnswered(file);
  }

  /** Close the loop on a thread — one click, per §5.10. */
  async markThreadAnswered(file: TFile): Promise<void> {
    try {
      await this.rhythm.applyThreadPatch(file, markAnswered({ now: Date.now() }));
      this.refreshViews();
      new Notice(`${file.basename} marked answered.`, 4000);
    } catch (error) {
      reportError(error, "could not mark that thread answered.");
    }
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

  // --- effort and the timer (§7 B2) --------------------------------------------

  /** A plain notice. Kept on the plugin so boards do not import `Notice` themselves. */
  notify(message: string, ms = 5000): void {
    new Notice(message, ms);
  }

  /**
   * The binding a fresh timer starts from.
   *
   * The activity comes from the hat being worn (§7 A3) but is always shown and
   * always editable — mode sets a default, never a silent attribution.
   */
  private startingBinding(ref = "", study = ""): TimerBinding {
    const vocab = this.effort.vocabularies();
    return {
      ...emptyBinding(this.settings.actor),
      ref,
      study,
      activity: activityOrFallback(vocab, defaultActivityFor(this.settings.mode)),
      costCentre: this.settings.effort.costCentre,
    };
  }

  /** Live request ids, offered in the reference field. Suggestions, not a whitelist. */
  private timerSuggestions(): string[] {
    return this.index
      .views({ now: Date.now() })
      .filter((view) => !view.metrics.completed)
      .map((view) => view.request.id);
  }

  async startTimer(ref = "", study = ""): Promise<void> {
    if (this.timer.current() !== null) {
      new Notice("A timer is already running. Stop it first from the status bar.", 5000);
      return;
    }
    const binding = await askBinding(this.app, this.startingBinding(ref, study), {
      title: "Start timer",
      activities: this.effort.vocabularies().activities,
      costCentres: this.effort.vocabularies().costCentres,
      suggestions: this.timerSuggestions(),
    });
    if (binding === null) return;
    await this.timer.start(binding);
  }

  /**
   * Record time for work already done (§7 B2, retroactive editing).
   *
   * The same dialog as the stop prompt, deliberately: forgetting to start the
   * timer is the common case, and the entry it produces has to be the same
   * shape as one the timer wrote or the roll-ups would tell two stories.
   */
  async addTimeEntry(month?: string): Promise<void> {
    const vocab = this.effort.vocabularies();
    const now = new Date();
    const today = toVaultMinute(now.getTime()).slice(0, 10);
    const draft: TimeEntry = {
      // Today, unless the effort table is looking at some other month — in
      // which case the first of that month, because "add an entry to the month
      // I have open" is what the button in that toolbar means.
      date: month === undefined || month === today.slice(0, 7) ? today : `${month}-01`,
      start: "",
      end: "",
      mins: 30,
      person: this.settings.actor,
      ref: "",
      activity: activityOrFallback(vocab, defaultActivityFor(this.settings.mode)),
      study: "",
      costCentre: this.settings.effort.costCentre,
      note: "",
    };

    const outcome: StopOutcome = await askEntry(this.app, draft, {
      title: "Add time entry",
      lede: "For the timer you forgot to start. Clock times are optional; the minutes are not.",
      submitLabel: "Record",
      activities: vocab.activities,
      costCentres: vocab.costCentres,
    });
    if (outcome.kind !== "save") return;

    try {
      await this.timer.write(outcome.entry);
      this.refreshViews();
    } catch {
      // `write` has already said why in a notice, naming every reason at once.
    }
  }

  /** Time recorded against a request, and how it sits against the estimate (§5.1). */
  async effortForRequest(request: RequestNote): Promise<{
    minutes: number;
    comparison: ReturnType<typeof compareToEstimate>;
  }> {
    const entries = await this.effort.allEntries();
    const wanted = request.id.trim().toLowerCase();
    const minutes = entries
      .filter((entry) => entry.ref.trim().toLowerCase() === wanted)
      .reduce((sum, entry) => sum + entry.mins, 0);
    return { minutes, comparison: compareToEstimate(request.effortEstimateHours, minutes) };
  }

  /** Write the roll-up the board is showing to a CSV in `95 Exports/`. */
  async exportEffortRollUp(
    month: string,
    buckets: readonly RollUpBucket[],
    dimension: EffortDimension,
  ): Promise<void> {
    await this.exportDocument({
      basename: `effort ${month} by ${DIMENSION_LABELS[dimension].toLowerCase()}`,
      extension: "csv",
      content: rollUpCsv(buckets, dimension),
      subject: `EFFORT-${month}`,
      rows: buckets.length,
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshViews();
  }
}
