import sandboxRuntime from "virtual:sandbox-runtime";

import type { AppGrant } from "./domain/apps/grant.js";
import { VAULT_APP_TYPE, type AppManifest } from "./domain/apps/manifest.js";
import type { AppAssessment } from "./domain/apps/register.js";
import { AppWriter, type NewApp } from "./services/appWriter.js";
import { readTheme, type AppHostContext } from "./services/appHost.js";
import { GrantAppModal, NewAppModal, ProposeWriteModal, WedgedAppModal } from "./ui/AppModals.js";
import { findRunnableBlocks, type RunnableBlock } from "./domain/compute/block";
import { isPythonIsolation } from "./domain/compute/harness";
import { ComputeRunner, runNotice } from "./services/computeRunner";
import { BlockPicker } from "./ui/BlockPicker";
import { RunBlockModal } from "./ui/RunBlockModal";
import { registerRunButtons, registerRunMenu, activeMarkdownFile } from "./ui/runButtons";
import { AppPicker } from "./ui/AppPicker.js";

import { Notice, Plugin, TFile, debounce, type WorkspaceLeaf } from "obsidian";
import { BasesFiles } from "./data/basesFiles.js";
import { stageLabels } from "./domain/bases/config.js";
import { NoteIndex } from "./data/noteIndex.js";
import { REQUEST_TYPE, RequestIndex, type IndexEntry } from "./data/requestIndex.js";
import { buildRows, catalogueFor, type RowSourceDeps } from "./data/rows.js";
import { buildVocabulary } from "./data/vocabulary.js";
import { chipsToQuery, parseQueryText, type ParsedText } from "./domain/query/language.js";
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
import { formatList, type CitationFormat } from "./domain/publication/citation.js";
import { PublicationRefused } from "./domain/publication/stages.js";
import { PublicationWriter } from "./services/publicationWriter.js";
import { PublicationStageModal } from "./ui/PublicationStageModal.js";
import {
  noteDependencyEdges,
  parsePolicy,
  policyLabel,
  refMatchesPolicy,
  POLICY_TYPE,
  type PolicyEdge,
  type PolicyNote,
} from "./domain/policy/policy.js";
import { indexIncoming } from "./domain/policy/register.js";
import { PolicyWriter, RevisionRefused } from "./services/policyWriter.js";
import {
  CatalogueWriter,
  RevisionRefused as VariableRevisionRefused,
  type NewVariable,
} from "./services/catalogueWriter.js";
import {
  VARIABLE_TYPE,
  parseVariable,
  refMatchesVariable,
  type VariableNote,
} from "./domain/catalogue/variable.js";
import { noteCitations, type Citation } from "./domain/catalogue/dependants.js";
import { buildCatalogue, type Catalogue } from "./domain/catalogue/register.js";
import { InForceModal, NewVariableModal, ReviseVariableModal } from "./ui/VariableModals.js";
import { VariablePicker } from "./ui/VariablePicker.js";
import {
  ScriptWriter,
  RunRefused,
  type NewScript,
} from "./services/scriptWriter.js";
import {
  SCRIPT_DOC_TYPE,
  parseScriptDoc,
  scriptLabel,
  type ScriptDoc,
} from "./domain/script/scriptDoc.js";
import { RUN_TYPE, parseRunRecord, type RunRecord } from "./domain/script/runRecord.js";
import {
  RedcapWriter,
  ExportRefused,
  type NewForm,
} from "./services/redcapWriter.js";
import { REDCAP_FORM_TYPE } from "./domain/redcap/field.js";
import { buildRegister as buildFormsRegister, type FormsRegister } from "./domain/redcap/register.js";
import type { FormSpec } from "./domain/redcap/form.js";
import { STUDY_TYPE, parseStudy, type StudyNote } from "./domain/study/study.js";
import { FormsBoard } from "./ui/FormsBoard.js";
import { FormPicker } from "./ui/FormPicker.js";
import {
  ImportDictionaryModal,
  NewFormModal,
  OverrideExportModal,
} from "./ui/FormModals.js";
import { buildScriptRegister, type ScriptRegister } from "./domain/script/register.js";
import type { RunDraft } from "./domain/script/recordRun.js";
import { NewScriptModal, RecordRunModal } from "./ui/ScriptModals.js";
import { ScriptPicker } from "./ui/ScriptPicker.js";
import { PolicyRevisionModal } from "./ui/PolicyRevisionModal.js";
import { PolicyPicker } from "./ui/PolicyPicker.js";
import { governanceRisk } from "./domain/request/analytics.js";
import {
  boardRowCount,
  buildBoardDocument,
  type BoardContext,
  type BoardId,
} from "./domain/report/boards.js";
import { renderDocument } from "./domain/report/document.js";
import { toVaultDate, toVaultMinute } from "./domain/time/dates.js";
import { backupAge, formatBytes } from "./domain/backup/snapshots.js";
import { describeRestore } from "./domain/backup/restore.js";
import { MODES, defaultSettings, type Mode, type ScdbSettings } from "./domain/settings/schema.js";
import type { FieldDef, Query, Row } from "./domain/query/model.js";
import type { SavedView } from "./domain/query/savedView.js";
import { AuditLog } from "./services/auditLog.js";
import { BackupService } from "./services/backup.js";
import { collectDiagnostics } from "./services/diagnostics.js";
import { applyRepairs, collectIntegrityFindings } from "./services/integrity.js";
import { Exporter, type ExportRequest, type ExportResult } from "./services/exporter.js";
import { ReportBuilder, type ReportChoice } from "./services/reportBuilder.js";
import { ReportTemplateStore } from "./data/reportTemplates.js";
import { ReportModal } from "./ui/ReportModal.js";
import {
  RequestWriter,
  reportError,
  type MigrateRequestInput,
} from "./services/requestWriter.js";
import { ScdbSettingsTab } from "./settings/SettingsTab.js";
import { COCKPIT_VIEW_TYPE, CockpitView, type CockpitTab } from "./ui/CockpitView.js";
import { DIAGRAM_VIEW_TYPE, DiagramView } from "./ui/DiagramView.js";
import { APP_VIEW_TYPE, AppView } from "./ui/AppView.js";
import { RequestPicker } from "./ui/RequestPicker.js";
import { WorkflowPicker } from "./ui/WorkflowPicker.js";
import { DiagramWriter } from "./services/diagramWriter.js";
import { DIAGRAM_NOTE_TYPE, emptyDiagram, type DiagramSpec } from "./domain/diagram/diagram.js";
import {
  dataFlowDiagram,
  requestPathDiagram,
  workflowDiagram,
} from "./domain/diagram/generate.js";
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
import { planExtraction } from "./domain/extract/plan.js";
import { reviewExtraction } from "./ui/ExtractModal.js";
import { ExtractWriter } from "./services/extractWriter.js";
import { EmlImport } from "./services/emlImport.js";
import { reviewEmlImport, sizeLabel } from "./ui/EmlImportModal.js";
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
import { EventStore } from "./services/eventStore.js";
import { isEventType, parseEventNote, type EventNote } from "./domain/events/event.js";
import {
  alertingCount,
  describeAlerts,
  lapsed,
} from "./domain/events/schedule.js";
import { parseDate } from "./domain/events/recurrence.js";
import { parseCalendar } from "./domain/events/ics.js";
import {
  askObligation,
  emptyDraft,
  pickCalendarFile,
  type CalendarChoice,
} from "./ui/EventDialogs.js";
import { askText } from "./ui/PromptModal.js";
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
  publicationWriter!: PublicationWriter;
  policyWriter!: PolicyWriter;
  views!: SavedViewStore;
  exporter!: Exporter;
  basesFiles!: BasesFiles;
  backup!: BackupService;
  /** Captures, correspondence threads and the daily briefing (§7 B1). */
  rhythm!: RhythmWriter;
  /** Reading actions, decisions and deadlines out of minutes (§7 B6). */
  extract!: ExtractWriter;
  /** Report templates: the five built in, plus anything in `_config/reports/` (§7 B7). */
  reportTemplates!: ReportTemplateStore;
  /** Building a report from a template and the vault (§7 B7). */
  reports!: ReportBuilder;
  /** The monthly effort tables in `80 Time/` (§5.3). */
  effort!: EffortLog;
  /** The running timer (§7 B2). */
  timer!: TimerService;
  /** Events, recurring obligations and the calendar bridge (§7 B3). */
  events!: EventStore;
  /** Reading saved `.eml` and `.msg` files into correspondence threads (§5.10, Tier 1). */
  emlImport!: EmlImport;
  /** Flowchart notes, and the SVG/PNG they export to (§7 D1). */
  diagrams!: DiagramWriter;
  /** The variable catalogue and its version chain (§5.8, §7 C2). */
  catalogueWriter!: CatalogueWriter;
  scriptWriter!: ScriptWriter;
  redcap!: RedcapWriter;
  /** Vault apps: reading their notes, recording consent, exporting them (§5.13, §7 F3). */
  apps!: AppWriter;
  compute!: ComputeRunner;

  /**
   * Bumped whenever a form note changes, so the forms board reloads.
   *
   * The other boards read the metadata cache and repaint on `refreshViews`.
   * A form's fields live in the note *body* (§7 D2), which the cache does not
   * hold, so the board reads files asynchronously and needs a signal that the
   * answer it has is stale. A counter is the smallest honest one.
   */
  formsVersion = 0;

  /**
   * Bumped whenever an app note or a grant changes, so the apps board reloads.
   *
   * Same reason as `formsVersion`: an app's code lives in the note body, which
   * the metadata cache does not hold, so the board reads files and needs a
   * signal that what it is showing is stale.
   */
  appsVersion = 0;

  /** The mode HUD (§7 A3). Null until `onload` has run. */
  private statusBar: HTMLElement | null = null;
  /** The backup nag (§7 A4). A separate segment so it can be absent entirely. */
  private backupBar: HTMLElement | null = null;
  /** The effort timer (§7 B2). Hidden until a timer is running. */
  private timerBar: HTMLElement | null = null;
  /** Lapsed and imminent obligations (§7 B3). Hidden when nothing is up. */
  private deadlineBar: HTMLElement | null = null;

  /**
   * Obligations already announced this session, keyed by note path and date.
   *
   * A reminder that fires every hour is a reminder that gets dismissed without
   * reading. The badge stays up for as long as the thing is lapsed; the notice
   * is said once, and again only if the date moves.
   */
  private announced = new Set<string>();

  /** When the reminder sweep last ran, so the interval can honour the setting. */
  private lastReminderCheck = 0;

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
    this.publicationWriter = new PublicationWriter({
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      reindex: (file) => this.notes.update(file),
    });
    this.policyWriter = new PolicyWriter({
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      policiesFolder: () => this.settings.folders.policies,
      reindex: (file) => this.notes.update(file),
    });
    this.views = new SavedViewStore(this.app, this.notes, () => this.settings.folders.dashboards);
    this.exporter = new Exporter({
      app: this.app,
      audit: this.audit,
      exportsFolder: () => this.settings.folders.exports,
      actor: () => this.settings.actor,
    });

    this.diagrams = new DiagramWriter({
      app: this.app,
      exporter: this.exporter,
      diagramsFolder: () => this.settings.folders.diagrams,
    });

    this.catalogueWriter = new CatalogueWriter({
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      catalogueFolder: () => this.settings.folders.catalogue,
      reindex: (file) => this.notes.update(file),
    });

    this.scriptWriter = new ScriptWriter({
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      scriptsFolder: () => this.settings.folders.scripts,
      runsFolder: () => this.settings.folders.runs,
      reindex: (file) => this.notes.update(file),
    });

    this.redcap = new RedcapWriter({
      app: this.app,
      audit: this.audit,
      exporter: this.exporter,
      actor: () => this.settings.actor,
      formsFolder: () => this.settings.folders.forms,
      studies: () => this.studies(),
      variables: () => this.variables(),
      reindex: (file) => {
        this.notes.update(file);
        this.formsVersion += 1;
        this.refreshViews();
      },
    });

    this.apps = new AppWriter({
      app: this.app,
      notes: this.notes,
      audit: this.audit,
      exporter: this.exporter,
      actor: () => this.settings.actor,
      appsFolder: () => this.settings.folders.apps,
      grants: () => this.settings.apps.grants as Readonly<Record<string, AppGrant>>,
      saveGrant: (id, grant) => this.saveGrant(id, grant),
      rows: (types, now) => this.rowsFor(types, now),
      theme: () => readTheme(document.body),
      runtime: sandboxRuntime,
    });

    this.compute = new ComputeRunner({
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      runsFolder: () => this.settings.folders.runs,
      settings: () => ({
        rPath: this.settings.compute.rPath,
        pythonPath: this.settings.compute.pythonPath,
        pythonIsolation: isPythonIsolation(this.settings.compute.pythonIsolation)
          ? this.settings.compute.pythonIsolation
          : "isolated",
        timeoutSeconds: this.settings.compute.timeoutSeconds,
        maxOutputKb: this.settings.compute.maxOutputKb,
      }),
      reindex: (file) => this.notes.update(file),
    });

    this.reportTemplates = new ReportTemplateStore(
      this.app,
      () => this.settings.folders.config,
    );

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

    this.events = new EventStore({
      app: this.app,
      notes: this.notes,
      audit: this.audit,
      exporter: this.exporter,
      eventsFolder: () => this.settings.folders.events,
      exportsFolder: () => this.settings.folders.exports,
      calendarFile: () => this.settings.events.calendarFile,
      leadDays: () => this.settings.events.leadDays,
      horizonDays: () => this.settings.briefing.horizonDays,
      actor: () => this.settings.actor,
    });

    this.rhythm = new RhythmWriter({
      app: this.app,
      notes: this.notes,
      audit: this.audit,
      folder: (key) => this.settings.folders[key],
      actor: () => this.settings.actor,
    });

    this.extract = new ExtractWriter({
      app: this.app,
      notes: this.notes,
      audit: this.audit,
      folder: (key) => this.settings.folders[key],
      actor: () => this.settings.actor,
      people: () => this.peopleNames(),
      mode: () => this.settings.mode,
    });

    this.reports = new ReportBuilder({
      notes: this.notes,
      effort: this.effort,
      views: (now) => this.visibleRequests(now).views,
      allViews: (now) => this.index.views({ now }),
      spec: () => this.workflows.only(),
      publications: () => this.publications(),
      rows: (types, now) => this.rowsFor(types, now),
      fields: (types) => this.catalogueFor(types),
      citationFormat: () => this.settings.publications.citationFormat,
      scope: () => this.hatScope(),
    });

    this.emlImport = new EmlImport({
      app: this.app,
      notes: this.notes,
      audit: this.audit,
      correspondenceFolder: () => this.settings.folders.correspondence,
      requestIds: () => this.index.all().map((entry) => entry.request.id),
      peopleNames: () => this.peopleNames(),
      ownAddresses: () => this.settings.comms.myAddresses,
      attachmentPolicy: () => this.settings.comms.emlAttachments,
      maxAttachmentKb: () => this.settings.comms.emlMaxAttachmentKb,
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
    this.registerView(DIAGRAM_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DiagramView(leaf, this));
    this.registerView(APP_VIEW_TYPE, (leaf: WorkspaceLeaf) => new AppView(leaf, this));
    this.registerBasesViews();
    registerRunButtons(this, {
      enabled: () => this.settings.compute.showRunButtons,
      open: (file, block) => this.runBlock(file, block),
    });
    registerRunMenu(this, { open: (file, block) => this.runBlock(file, block) });

    this.addSettingTab(new ScdbSettingsTab(this.app, this));
    this.registerCommands();
    this.addRibbonIcon("layout-dashboard", "SCDB Cockpit", () => void this.activateCockpit());
    this.statusBar = this.addStatusBarItem();
    this.timerBar = this.addStatusBarItem();
    this.deadlineBar = this.addStatusBarItem();
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

    // §7 B3 asks for reminders on vault open and on an interval. In-app only:
    // this repaints the badge and may raise a notice, and never touches the OS
    // notification centre or a mailbox.
    //
    // A fixed one-minute tick that decides for itself whether enough time has
    // passed, rather than an interval sized from the setting: `setInterval` is
    // given its period once, so reading the setting here would freeze it at
    // whatever it was on load and the settings field would appear to do
    // nothing until a reload. Every other setting in this plugin is read
    // through a getter at the point of use, and this one now is too.
    this.registerInterval(
      window.setInterval(() => {
        const due = Math.max(5, this.settings.events.checkMinutes) * 60_000;
        if (Date.now() - this.lastReminderCheck < due) return;
        this.checkReminders();
      }, 60_000),
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
        .then(() => this.maybeWriteBriefing())
        .then(() => this.checkReminders(true)),
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
      id: "search-english",
      name: "Search in English",
      callback: () => void this.searchFromCommand(),
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
      id: "extract-minutes",
      name: "Extract actions from these minutes",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file === null || file.extension !== "md") return false;
        if (!checking) void this.extractMinutes(file);
        return true;
      },
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
      id: "publications",
      name: "Show publications",
      callback: () => void this.activateCockpit("publications"),
    });

    this.addCommand({
      id: "copy-publication-list",
      name: "Copy the publication list",
      callback: () =>
        void this.copyPublicationList({
          format: this.settings.publications.citationFormat,
          scdbOnly: false,
        }),
    });

    this.addCommand({
      id: "copy-scdb-publication-list",
      name: "Copy the SCDB-supported publication list",
      callback: () =>
        void this.copyPublicationList({
          format: this.settings.publications.citationFormat,
          scdbOnly: true,
        }),
    });

    this.addCommand({
      id: "policies",
      name: "Show the policy register",
      callback: () => void this.activateCockpit("policies"),
    });

    this.addCommand({
      id: "revise-policy",
      name: "Revise a policy",
      callback: () => void this.pickPolicyToRevise(),
    });

    this.addCommand({
      id: "catalogue",
      name: "Show the variable catalogue",
      callback: () => void this.activateCockpit("catalogue"),
    });

    this.addCommand({
      id: "new-variable",
      name: "New catalogue variable",
      callback: () => this.newVariable(),
    });

    this.addCommand({
      id: "revise-variable",
      name: "Revise a catalogue variable",
      callback: () => this.pickVariable((variable) => this.reviseVariable(variable)),
    });

    this.addCommand({
      id: "variable-in-force",
      name: "Which definition was in force",
      callback: () => this.pickVariable((variable) => this.askInForce(variable)),
    });

    this.addCommand({
      id: "scripts",
      name: "Show the script register",
      callback: () => void this.activateCockpit("scripts"),
    });

    this.addCommand({
      id: "new-script",
      name: "New script documentation",
      callback: () => this.newScript(),
    });

    this.addCommand({
      id: "record-run",
      name: "Record a script run",
      callback: () => this.pickScript((doc) => this.recordScriptRun(doc)),
    });

    this.addCommand({
      id: "check-script-hash",
      name: "Check a script's file hash",
      callback: () => this.pickScript((doc) => void this.checkScriptHash(doc)),
    });

    this.addCommand({
      id: "forms",
      name: "Show the REDCap forms register",
      callback: () => void this.activateCockpit("forms"),
    });

    this.addCommand({
      id: "new-form",
      name: "New REDCap form",
      callback: () => this.newForm(),
    });

    this.addCommand({
      id: "export-dictionary",
      name: "Export a REDCap data dictionary",
      callback: () => void this.pickForm((spec) => void this.exportDictionary(spec.path)),
    });

    this.addCommand({
      id: "import-dictionary",
      name: "Import a REDCap data dictionary",
      callback: () => void this.pickForm((spec) => void this.importDictionary(spec.path)),
    });

    this.addCommand({
      id: "apps",
      name: "Show the vault apps",
      callback: () => void this.activateCockpit("apps"),
    });

    this.addCommand({
      id: "new-app",
      name: "New vault app",
      callback: () => this.newApp(),
    });

    this.addCommand({
      id: "run-app",
      name: "Run a vault app",
      callback: () => void this.pickApp((entry) => void this.runApp(entry.manifest.path)),
    });

    this.addCommand({
      id: "export-app",
      name: "Export a vault app with its data",
      callback: () => void this.pickApp((entry) => void this.exportApp(entry.manifest.path)),
    });

    this.addCommand({
      id: "scratchpad",
      name: "Open the JavaScript scratchpad",
      callback: () => void this.openScratchpad(),
    });

    this.addCommand({
      id: "run-block",
      name: "Run a code block from this note",
      checkCallback: (checking: boolean) => {
        const file = activeMarkdownFile(this);
        if (file === null) return false;
        if (!checking) void this.pickBlock(file);
        return true;
      },
    });

    this.addCommand({
      id: "new-diagram",
      name: "New flowchart",
      callback: () => void this.newDiagram(),
    });

    this.addCommand({
      id: "open-diagram",
      name: "Open the flowchart editor for this note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const type = file === null ? "" : this.notes.byPath(file.path)?.type;
        if (file === null || type !== DIAGRAM_NOTE_TYPE) return false;
        if (!checking) void this.openDiagram(file);
        return true;
      },
    });

    this.addCommand({
      id: "draw-workflow",
      name: "Draw the workflow lifecycle",
      callback: () => void this.drawWorkflow(),
    });

    this.addCommand({
      id: "draw-request-path",
      name: "Draw what actually happened to a request",
      callback: () => this.pickRequestToDraw("path"),
    });

    this.addCommand({
      id: "draw-data-flow",
      name: "Draw the data flow for a request",
      callback: () => this.pickRequestToDraw("data-flow"),
    });

    this.addCommand({
      id: "generate-report",
      name: "Generate a report",
      callback: () => void this.openReportDialog(),
    });

    this.addCommand({
      id: "write-report-templates",
      name: "Write the built-in report templates to _config",
      callback: () => void this.writeReportTemplates(),
    });

    this.addCommand({
      id: "deadlines",
      name: "Show deadlines and obligations",
      callback: () => void this.activateCockpit("deadlines"),
    });

    this.addCommand({
      id: "new-deadline",
      name: "New deadline or recurring obligation",
      callback: () => void this.newObligation(),
    });

    this.addCommand({
      id: "complete-obligation",
      name: "Record this obligation as done",
      checkCallback: (checking) => {
        const note = this.currentEventNote();
        if (checking) return note !== null;
        if (note !== null) void this.completeObligation(note);
        return true;
      },
    });

    this.addCommand({
      id: "materialise-occurrences",
      name: "Materialise the next occurrence of each obligation",
      callback: () => void this.materialiseOccurrences(),
    });

    this.addCommand({
      id: "export-calendar",
      name: "Write deadlines to a calendar file",
      callback: () => void this.exportCalendar(),
    });

    this.addCommand({
      id: "import-calendar",
      name: "Import events from a calendar file",
      callback: () => void this.importCalendar(),
    });

    this.addCommand({
      id: "import-eml",
      name: "Import saved email files",
      callback: () => void this.importEml(),
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
        if (this.reportTemplates.isTemplatePath(file.path)) void this.reportTemplates.reload();
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
        if (
          this.reportTemplates.isTemplatePath(file.path) ||
          this.reportTemplates.isTemplatePath(oldPath)
        ) {
          void this.reportTemplates.reload();
        }
        refresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
        if (this.reportTemplates.isTemplatePath(file.path)) void this.reportTemplates.reload();
        this.effortFileChanged(file.path, refresh);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
        if (this.reportTemplates.isTemplatePath(file.path)) void this.reportTemplates.reload();
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
    await this.reportTemplates.reload();
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
    this.renderDeadlineBar();
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
   * The obligations badge (§7 B3).
   *
   * Absent when nothing is up, like the timer segment — a permanent "0 due"
   * chip is a chip nobody reads. When something *has* lapsed it says so in
   * words, not only in colour (§6), because that is the one state on this
   * badge that means something has already gone wrong.
   */
  private renderDeadlineBar(): void {
    const bar = this.deadlineBar;
    if (bar === null) return;
    bar.empty();

    const schedule = this.eventSchedule();
    const alerting = alertingCount(schedule);
    if (alerting === 0) {
      bar.hide();
      return;
    }

    const overdue = lapsed(schedule).length;
    bar.show();
    bar.addClass("scdb-deadlinebar");
    const button = bar.createEl("button", {
      cls:
        overdue > 0
          ? "scdb-deadlinebar__button scdb-deadlinebar__button--lapsed"
          : "scdb-deadlinebar__button",
      attr: {
        type: "button",
        "aria-label": `${describeAlerts(schedule)}. Click to open the board.`,
      },
    });
    button.createSpan({ cls: "scdb-deadlinebar__glyph", text: overdue > 0 ? "!" : "\u25D4" });
    button.createSpan({ text: overdue > 0 ? `${overdue} lapsed` : `${alerting} due` });
    button.addEventListener("click", () => void this.activateCockpit("deadlines"));
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
    const computed = this.computedDueDates();

    for (const entry of this.notes.all()) {
      if (entry.type === REQUEST_TYPE) continue;
      if (entry.type === PUBLICATION_TYPE) {
        publications.push(parsePublication(entry.file.path, entry.frontmatter));
      }
      const next = computed.get(entry.file.path);
      dated.push({
        path: entry.file.path,
        type: entry.type,
        // The recurrence engine's answer, overlaid in memory rather than
        // written to the note (§7 B3): the overview and the briefing pick up
        // the computed occurrence with no change to either, and materialising
        // it into the file stays an explicit act.
        frontmatter: next === undefined ? entry.frontmatter : { ...entry.frontmatter, due: next },
      });
    }

    return { dated, publications };
  }

  // --- policies and revisions (§5.14, §7 C1) --------------------------------

  /**
   * Every policy note in the vault.
   *
   * Parsed on demand, like publications: a vault holds dozens of policies, not
   * thousands, and a cached projection would be one more thing to invalidate.
   * Frozen copies carry `type: policy-revision`, so they are never in here.
   */
  policies(): PolicyNote[] {
    const policies: PolicyNote[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== POLICY_TYPE) continue;
      policies.push(parsePolicy(entry.file.path, entry.frontmatter));
    }
    return policies.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  }

  /**
   * Dependencies declared from the far end — `derives_from:` on any note.
   *
   * Whoever writes a local SOP is the person who knows it implements clause
   * 5.2 of something; requiring them to go and edit the institutional policy
   * note to say so is how an impact map ends up empty. Both directions fold
   * into one list in `buildImpactMap`.
   */
  policyIncomingEdges(): Map<string, PolicyEdge[]> {
    const policies = this.policies();
    const edges: PolicyEdge[] = [];
    for (const entry of this.notes.all()) {
      if (entry.frontmatter["derives_from"] === undefined) continue;
      edges.push(...noteDependencyEdges(entry.file.path, entry.type, entry.frontmatter));
    }
    return indexIncoming(policies, edges, refMatchesPolicy);
  }

  /**
   * Whether an edge points at something the vault actually holds.
   *
   * Wikilinks resolve through the metadata cache. A gate ref is
   * `workflow:stage`, so it resolves against the loaded workflow spec — which
   * is how "this policy governs the DUA gate" becomes checkable rather than
   * decorative. Anything else is left unjudged as resolved, because saying
   * "not found" about a ref we do not know how to look up would be a lie.
   */
  private resolvePolicyRef = (edge: PolicyEdge): boolean => {
    const ref = edge.ref.trim();
    const wikilink = /^\[\[([^\]|#^]+)/.exec(ref);
    if (wikilink !== null) {
      return this.app.metadataCache.getFirstLinkpathDest(wikilink[1]!.trim(), "") !== null;
    }
    if (edge.kind === "gate" || edge.kind === "workflow") {
      const [workflowId, stageId] = ref.split(":");
      const spec = this.workflows.get(workflowId?.trim() ?? "");
      if (spec === null) return false;
      if (stageId === undefined || stageId.trim() === "") return true;
      return spec.stages.some((stage: { id: string }) => stage.id === stageId.trim());
    }
    return true;
  };

  /** Ask which policy has been reissued, then open the revision dialog. */
  private async pickPolicyToRevise(): Promise<void> {
    const policies = this.policies();
    if (policies.length === 0) {
      new Notice(
        `SCDB: no policy notes in ${this.settings.folders.policies}. Add one with \`type: policy\` first.`,
        8000,
      );
      return;
    }
    new PolicyPicker(this.app, policies, (policy) => this.revisePolicy(policy)).open();
  }

  /** Freeze the current text and replace it, showing the impact map first. */
  revisePolicy(policy: PolicyNote): void {
    const file = this.app.vault.getAbstractFileByPath(policy.path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: "${policy.path}" is no longer in the vault.`, 8000);
      return;
    }

    void this.app.vault.read(file).then((currentText) => {
      const revisionsPrefix = `${this.settings.folders.policies}/_revisions/`;
      new PolicyRevisionModal(this.app, {
        policy,
        currentText,
        policiesFolder: this.settings.folders.policies,
        // Anywhere but the policy itself and the frozen copies: the incoming
        // document is usually dropped into the vault wherever it landed.
        sources: this.app.vault
          .getMarkdownFiles()
          .map((candidate) => candidate.path)
          .filter((path) => path !== policy.path && !path.startsWith(revisionsPrefix))
          .sort(),
        readSource: async (path) => {
          const source = this.app.vault.getAbstractFileByPath(path);
          if (!(source instanceof TFile)) {
            throw new Error(`There is no note at "${path}".`);
          }
          return this.app.vault.read(source);
        },
        incoming: this.policyIncomingEdges().get(policy.path) ?? [],
        resolve: this.resolvePolicyRef,
        onSubmit: async (submission) => {
          try {
            const result = await this.policyWriter.revise({
              file,
              policy,
              incomingText: submission.incomingText,
              newVersion: submission.newVersion,
              summary: submission.summary,
              effective: submission.effective,
              incoming: this.policyIncomingEdges().get(policy.path) ?? [],
              resolve: this.resolvePolicyRef,
            });
            this.refreshViews();
            const needing = result.map.counts["clause-gone"] + result.map.counts.affected;
            new Notice(
              `SCDB: ${policy.id || "policy"} → v${submission.newVersion}. ${needing} dependant${needing === 1 ? "" : "s"} affected, ${result.map.counts.review} to review. Impact map at ${result.reportPath}.`,
              12000,
            );
            // From the `TFile` the writer returned, not through `openNote`:
            // the index has not seen a file written a moment ago.
            void this.app.workspace.getLeaf(false).openFile(result.reportFile);
          } catch (error) {
            if (error instanceof RevisionRefused) {
              new Notice(`SCDB: revision refused. ${error.message}`, 12000);
            } else {
              reportError(error, "could not revise the policy.");
            }
          }
        },
      }).open();
    });
  }

  /** Snapshot a policy's current text without changing it. */
  async freezePolicyBaseline(policy: PolicyNote): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(policy.path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: "${policy.path}" is no longer in the vault.`, 8000);
      return;
    }
    try {
      const path = await this.policyWriter.freezeBaseline({ file, policy });
      this.refreshViews();
      new Notice(`SCDB: ${policyLabel(policy)} frozen at ${path}.`, 8000);
    } catch (error) {
      if (error instanceof RevisionRefused) {
        new Notice(`SCDB: cannot freeze. ${error.message}`, 10000);
      } else {
        reportError(error, "could not freeze the policy.");
      }
    }
  }

  // --- the variable catalogue (§5.8, §7 C2) ----------------------------------

  /**
   * Every variable note in the vault.
   *
   * Parsed on demand, like policies and publications. A catalogue is hundreds
   * of entries at most, and the alternative — a cached projection — is one more
   * thing that can go stale behind a governance answer.
   */
  variables(): VariableNote[] {
    const variables: VariableNote[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== VARIABLE_TYPE) continue;
      variables.push(parseVariable(entry.file.path, entry.frontmatter));
    }
    return variables.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  }

  /**
   * Every citation of a variable, from every other note.
   *
   * The far end of the join §5.8 describes. A run record names the variables
   * it consumed, a script doc the ones it reads, a form the ones it creates —
   * and none of them should have to edit the catalogue note to be counted.
   */
  variableCitations(): Citation[] {
    const citations: Citation[] = [];
    for (const entry of this.notes.all()) {
      citations.push(...noteCitations(entry.file.path, entry.type, entry.frontmatter));
    }
    return citations;
  }

  /** The catalogue board's model: rows, groups, dependants and the counts. */
  catalogue(): Catalogue {
    return buildCatalogue({ variables: this.variables(), citations: this.variableCitations() });
  }

  /**
   * Open the catalogue note a ref names, or say why it could not be found.
   *
   * A form field cites a variable as ordinary text, so the ref may be a typo
   * or point at something uncatalogued. Saying which is more useful than a
   * button that silently does nothing.
   */
  openVariable(ref: string): void {
    const match = this.variables().find((variable) => refMatchesVariable(ref, variable));
    if (match === undefined) {
      new Notice(`SCDB: nothing in ${this.settings.folders.catalogue} matches "${ref}".`, 8000);
      return;
    }
    this.openNote(match.path);
  }

  /** Create a variable note from the dialog, then open it. */
  newVariable(): void {
    new NewVariableModal(this.app, async (input: NewVariable) => {
      try {
        const file = await this.catalogueWriter.create(input);
        this.refreshViews();
        await this.app.workspace.getLeaf(true).openFile(file);
        new Notice(`SCDB: ${input.id} added to the catalogue at version 1.`, 6000);
      } catch (error) {
        reportError(error, "could not create the variable note.");
      }
    }).open();
  }

  /** Supersede a variable's definition, keeping what it used to say. */
  reviseVariable(variable: VariableNote): void {
    const file = this.app.vault.getAbstractFileByPath(variable.path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: ${variable.path} is no longer in the vault.`, 8000);
      return;
    }

    new ReviseVariableModal(this.app, variable, async ({ changes, reason }) => {
      try {
        const plan = await this.catalogueWriter.revise({ file, variable, changes, reason });
        this.refreshViews();
        new Notice(
          `SCDB: ${variable.id} is now version ${plan.toVersion}; version ${plan.fromVersion} is kept on the note.`,
          8000,
        );
      } catch (error) {
        if (error instanceof VariableRevisionRefused) {
          new Notice(`SCDB: cannot revise. ${error.message}`, 10000);
        } else {
          reportError(error, "could not revise the variable.");
        }
      }
    }).open();
  }

  /** "Which definition was in force on this date" (§5.8). */
  askInForce(variable: VariableNote): void {
    new InForceModal(this.app, variable).open();
  }

  /** Pick a variable, then ask what it meant on a date. */
  private pickVariable(onPick: (variable: VariableNote) => void): void {
    const variables = this.variables();
    if (variables.length === 0) {
      new Notice(
        `SCDB: the catalogue is empty. Add a note to ${this.settings.folders.catalogue} with \`type: variable\`.`,
        8000,
      );
      return;
    }
    new VariablePicker(this.app, variables, onPick).open();
  }

  // --- script documentation and provenance (§5.12, §5.14, §7 C3) ------------

  /** Every script documentation note in the vault. */
  scriptDocs(): ScriptDoc[] {
    const docs: ScriptDoc[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== SCRIPT_DOC_TYPE) continue;
      docs.push(parseScriptDoc(entry.file.path, entry.frontmatter));
    }
    return docs.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  }

  /**
   * Every run record in the vault.
   *
   * Found by `type: run` rather than by folder, so a record filed somewhere
   * other than `94 Runs/` still counts as evidence. Where a note lives is a
   * filing preference; what it claims is what matters.
   */
  runRecords(): RunRecord[] {
    const runs: RunRecord[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== RUN_TYPE) continue;
      runs.push(parseRunRecord(entry.file.path, entry.frontmatter));
    }
    return runs;
  }

  /** The script board's model, including the C2 join. */
  scriptRegister(): ScriptRegister {
    return buildScriptRegister({
      docs: this.scriptDocs(),
      runs: this.runRecords(),
      variables: this.variables(),
    });
  }

  /** Create a script documentation note from the dialog, then open it. */
  newScript(): void {
    new NewScriptModal(this.app, async (input: NewScript) => {
      try {
        const file = await this.scriptWriter.create(input);
        this.refreshViews();
        await this.app.workspace.getLeaf(true).openFile(file);
        new Notice(`SCDB: ${input.id} documented.`, 6000);
      } catch (error) {
        reportError(error, "could not create the script note.");
      }
    }).open();
  }

  /** Write a §5.12 provenance record for a run that has already happened. */
  recordScriptRun(doc: ScriptDoc): void {
    const file = this.app.vault.getAbstractFileByPath(doc.path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: ${doc.path} is no longer in the vault.`, 8000);
      return;
    }

    new RecordRunModal(this.app, doc, this.settings.actor, async (draft: RunDraft) => {
      try {
        const plan = await this.scriptWriter.recordRun({ file, doc, draft });
        this.refreshViews();
        new Notice(
          `SCDB: ${plan.id} recorded against ${doc.id || scriptLabel(doc)}.${plan.weaknesses.length > 0 ? ` ${plan.weaknesses.length} thing${plan.weaknesses.length === 1 ? "" : "s"} it cannot say.` : ""}`,
          8000,
        );
      } catch (error) {
        if (error instanceof RunRefused) {
          new Notice(`SCDB: cannot record the run. ${error.message}`, 10000);
        } else {
          reportError(error, "could not record the run.");
        }
      }
    }).open();
  }

  /**
   * Hash the script file and compare it with what the note documents.
   *
   * Adopting the new hash is a second, deliberate step: seeing that the code
   * moved and declaring the new version documented are different decisions,
   * and collapsing them would mean the note silently caught up with every edit.
   */
  async checkScriptHash(doc: ScriptDoc): Promise<void> {
    try {
      const check = await this.scriptWriter.checkHash(doc);
      new Notice(`SCDB: ${check.message}`, 12000);
      if (check.outcome !== "differs" && check.outcome !== "not-recorded") return;

      const file = this.app.vault.getAbstractFileByPath(doc.path);
      if (!(file instanceof TFile)) return;

      const ok = await confirm(
        this.app,
        [
          `Record ${check.observed.slice(0, 12)}… on ${doc.id || doc.path} as the current version of ${doc.file}?`,
          "Run records already written keep the hash they ran under, so the history of what produced what is unaffected.",
        ].join("\n"),
        "Record it",
      );
      if (!ok) return;

      await this.scriptWriter.adoptHash(file, check.observed);
      this.refreshViews();
      new Notice(`SCDB: ${doc.id || doc.path} now documents ${check.observed.slice(0, 12)}….`, 6000);
    } catch (error) {
      reportError(error, "could not check the script hash.");
    }
  }

  /** Pick a documented script, then act on it. */
  private pickScript(onPick: (doc: ScriptDoc) => void): void {
    const docs = this.scriptDocs();
    if (docs.length === 0) {
      new Notice(
        `SCDB: nothing is documented yet. Add a note to ${this.settings.folders.scripts} with \`type: script-doc\`.`,
        8000,
      );
      return;
    }
    new ScriptPicker(this.app, docs, onPick).open();
  }

  // --- REDCap forms (§5.14, §7 D2) -------------------------------------------

  /**
   * Every study note in the vault.
   *
   * Read for the first time here. `20 Studies/` has been in the vault contract
   * from the start and every other note type links to one, but nothing needed
   * to *read* a study until D2 had to check an identifier against the scope a
   * study was approved for.
   */
  studies(): StudyNote[] {
    const studies: StudyNote[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== STUDY_TYPE) continue;
      studies.push(parseStudy({ path: entry.file.path, frontmatter: entry.frontmatter }));
    }
    return studies.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every REDCap form note, read and assessed. */
  async formsRegister(): Promise<FormsRegister> {
    const specs = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== REDCAP_FORM_TYPE) continue;
      specs.push(await this.redcap.specFor(entry.file));
    }
    return buildFormsRegister({
      specs,
      studies: this.studies(),
      variables: this.variables(),
    });
  }

  /** Create a form note from the dialog, then open it. */
  newForm(): void {
    new NewFormModal(this.app, async (input: NewForm) => {
      try {
        const file = await this.redcap.create(input);
        await this.app.workspace.getLeaf(true).openFile(file);
        new Notice(`SCDB: ${input.id} created.`, 6000);
      } catch (error) {
        reportError(error, "could not create the form note.");
      }
    }).open();
  }

  /**
   * Write a form's data dictionary to `95 Exports/`.
   *
   * Validation errors stop it outright — REDCap would reject the file, and an
   * override that produces a broken artefact wastes the person's time twice.
   * A governance block offers the override dialog instead, which collects the
   * typed reason the ledger entry needs (§5.6).
   */
  async exportDictionary(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: "${path}" is no longer in the vault.`, 8000);
      return;
    }

    const write = async (override?: string): Promise<void> => {
      const { result, assessment } = await this.redcap.exportDictionary({ file, override });
      new Notice(
        `SCDB: ${assessment.fieldCount} field${assessment.fieldCount === 1 ? "" : "s"} → ${result.path}`,
        8000,
      );
    };

    try {
      await write();
    } catch (error) {
      if (error instanceof ExportRefused && error.overridable) {
        const assessment = await this.redcap.assess(file);
        new OverrideExportModal(this.app, assessment, async (reason) => {
          try {
            await write(reason);
          } catch (retry) {
            reportError(retry, "could not export the data dictionary.");
          }
        }).open();
        return;
      }
      if (error instanceof ExportRefused) {
        new Notice(`SCDB: ${error.reasons.join("\n")}`, 15000);
        return;
      }
      reportError(error, "could not export the data dictionary.");
    }
  }

  /** Replace a form's fields with a dictionary exported from REDCap. */
  async importDictionary(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: "${path}" is no longer in the vault.`, 8000);
      return;
    }

    const spec = await this.redcap.specFor(file);
    const existing = spec.instruments.reduce((sum, inst) => sum + inst.fields.length, 0);

    new ImportDictionaryModal(this.app, spec.id, existing, async (csv) => {
      try {
        const imported = await this.redcap.importDictionary({ file, csv });
        new Notice(
          `SCDB: ${imported.fieldCount} field${imported.fieldCount === 1 ? "" : "s"} across ${imported.instruments.length} instrument${imported.instruments.length === 1 ? "" : "s"} imported.`,
          8000,
        );
        for (const gap of imported.gaps) this.notify(gap, 12000);
      } catch (error) {
        reportError(error, "could not import that data dictionary.");
      }
    }).open();
  }

  /** Pick a form note, then act on it. */
  private async pickForm(onPick: (spec: FormSpec) => void): Promise<void> {
    const specs: FormSpec[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== REDCAP_FORM_TYPE) continue;
      specs.push(await this.redcap.specFor(entry.file));
    }
    if (specs.length === 0) {
      new Notice(
        `SCDB: no forms yet. Add a note to ${this.settings.folders.forms} with \`type: redcap-form\`, or use "New REDCap form".`,
        8000,
      );
      return;
    }
    new FormPicker(this.app, specs, onPick).open();
  }

  // --- vault apps and the scratchpad (§5.13, §7 F3) --------------------------

  /**
   * The bundled sandbox runtime, as source text.
   *
   * Built separately from `main.js` (see `esbuild.config.mjs`) because it runs
   * inside the iframe, where there is no module loader and no origin to fetch
   * a second file from.
   */
  sandboxRuntime(): string {
    return sandboxRuntime;
  }

  /** Note types the index actually holds. What the scratchpad may read. */
  indexedTypes(): string[] {
    return this.notes.types().map((entry) => entry.type);
  }

  async appsRegister(): Promise<AppAssessment[]> {
    return this.apps.register();
  }

  async assessApp(file: TFile): Promise<AppAssessment> {
    return this.apps.assess(file);
  }

  /**
   * Everything a running app is allowed to ask for.
   *
   * Note what is *not* here: `this`, `this.app`, the vault, the adapter. §5.13
   * forbids passing any of them into an app, and the way to make that true is
   * for the object the host holds to be a set of narrow functions rather than
   * a plugin. The confirmation callback is the one place a person is inserted,
   * and it is the only path by which an app changes anything.
   */
  appHostContext(): AppHostContext {
    return {
      app: this.app,
      audit: this.audit,
      actor: () => this.settings.actor,
      rows: (types, now) => this.rowsFor(types, now),
      fields: (types) => this.catalogueFor(types),
      watchdogSeconds: () => this.settings.apps.watchdogSeconds,
      confirmWrite: (manifest, proposal, changes) =>
        new Promise<boolean>((resolve) => {
          new ProposeWriteModal(this.app, manifest, proposal, changes, (ok) => {
            if (ok) {
              this.notes.rebuild();
              this.refreshViews();
            }
            resolve(ok);
          }).open();
        }),
    };
  }

  /** Store or clear one app's consent. Kept in settings, never in the note. */
  private async saveGrant(id: string, grant: AppGrant | null): Promise<void> {
    const grants = { ...this.settings.apps.grants };
    if (grant === null) delete grants[id];
    else grants[id] = grant;
    this.settings.apps = { ...this.settings.apps, grants };
    await this.saveSettings();
    this.appsVersion += 1;
    this.refreshViews();
  }

  /**
   * Run an app, asking first if it needs asking.
   *
   * The manifest is re-read here rather than taken from whatever the board is
   * showing: the board may be a minute old, and the whole point of the grant
   * hash is that the note can change between one look and the next.
   */
  async runApp(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: "${path}" is no longer in the vault.`, 8000);
      return;
    }

    try {
      const assessment = await this.apps.assess(file);
      const { manifest } = assessment;

      if (manifest.source.trim() === "") {
        new Notice(`SCDB: ${manifest.id} has no code to run.`, 8000);
        return;
      }

      if (assessment.needsConsent) {
        const allowed = await new Promise<boolean>((resolve) => {
          new GrantAppModal(this.app, manifest, assessment.check, resolve).open();
        });
        if (!allowed) return;
        await this.apps.grant(manifest, assessment.grant);
      }

      await this.openAppView((view) => view.showApp(file, manifest));
    } catch (error) {
      reportError(error, "could not run that app.");
    }
  }

  /** Withdraw an app's permission. It asks again before it next runs. */
  async revokeApp(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    try {
      const manifest = await this.apps.manifestFor(file);
      await this.apps.revoke(manifest);
      new Notice(`SCDB: ${manifest.id} can no longer run until you allow it again.`, 6000);
    } catch (error) {
      reportError(error, "could not withdraw that app's permission.");
    }
  }

  /**
   * Export an app as a self-contained page (§5.13).
   *
   * The confirmation names the row count *and* what was left out, because
   * §5.10 excludes correspondence from exports by default and a page that
   * silently lost half its data is one nobody can explain to the person they
   * sent it to.
   */
  async exportApp(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    try {
      const manifest = await this.apps.manifestFor(file);
      const snapshot = this.apps.snapshotFor(manifest);
      const planned = this.exporter.plannedPath(manifest.id, "html");

      const lines = [
        `Write ${manifest.title} and a snapshot of ${snapshot.count} note${snapshot.count === 1 ? "" : "s"} to:`,
        `• ${planned}`,
        "",
        "The file is self-contained: it opens in any browser, makes no network request, and is not live.",
      ];
      for (const exclusion of snapshot.exclusions) lines.push(`• ${exclusion}`);

      if (!(await confirm(this.app, lines.join("\n"), "Export"))) return;

      const result = await this.apps.exportApp(manifest);
      new Notice(`SCDB: ${result.rows} row${result.rows === 1 ? "" : "s"} → ${result.path}`, 8000);
    } catch (error) {
      reportError(error, "could not export that app.");
    }
  }

  /** Create an app note from the dialog, then open it for editing. */
  newApp(): void {
    new NewAppModal(this.app, this.indexedTypes(), (input: NewApp | null) => {
      if (input === null) return;
      void (async () => {
        try {
          const file = await this.apps.create(input);
          this.notes.update(file);
          this.appsVersion += 1;
          await this.app.workspace.getLeaf(true).openFile(file);
          new Notice(`SCDB: ${input.id} created. Run it from the Apps board when you are ready.`, 8000);
        } catch (error) {
          reportError(error, "could not create the app note.");
        }
      })();
    }).open();
  }

  /** Open the JavaScript scratchpad. Nothing runs until Run is pressed. */
  async openScratchpad(): Promise<void> {
    await this.openAppView((view) => view.showScratchpad());
  }

  /** Withdraw an app's permission by id, from the settings tab. */
  async withdrawGrant(id: string): Promise<void> {
    await this.saveGrant(id, null);
  }

  /** Ask whether to tear down an app that has stopped answering (§5.13). */
  async askWedged(title: string, detail: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      new WedgedAppModal(this.app, title, detail, resolve).open();
    });
  }

  /**
   * Show the app pane, reusing the one that is already open.
   *
   * **`setViewState` is only called for a leaf that is not already an app
   * pane**, and that distinction was found the hard way. Calling it on a leaf
   * that already holds this view type makes Obsidian rebuild the view: the
   * `await` resolves before the replacement is attached, so `leaf.view` is
   * sometimes the old instance and sometimes the new one. The visible symptom
   * was a pane whose title said "Scratchpad" while a watchdog behind it
   * complained about an app that had been detached — two live instances, one
   * of them orphaned with a running session.
   *
   * Reusing means reusing the instance, so the session it owns is the session
   * that gets stopped. The target is still set after the pane exists rather
   * than through view state — see the note on `DiagramView` for what carrying
   * our own key in the workspace serialisation did to that pane.
   */
  private async openAppView(setup: (view: AppView) => void): Promise<void> {
    const workspace = this.app.workspace;

    for (const leaf of workspace.getLeavesOfType(APP_VIEW_TYPE)) {
      if (leaf.view instanceof AppView) {
        workspace.revealLeaf(leaf);
        setup(leaf.view);
        return;
      }
    }

    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: APP_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof AppView) setup(view);
  }

  /** Pick an app, then act on it. */
  private async pickApp(onPick: (entry: AppAssessment) => void): Promise<void> {
    const register = await this.apps.register();
    if (register.length === 0) {
      new Notice(
        `SCDB: no vault apps yet. Add a note to ${this.settings.folders.apps} with \`type: vault-app\`, or use "New vault app".`,
        8000,
      );
      return;
    }
    new AppPicker(this.app, register, onPick).open();
  }

  // --- running code blocks (§5.12, §7 F1) -----------------------------------

  /**
   * Offer the runnable blocks in a note.
   *
   * Nothing is run here. The picker leads to the dialog, and the dialog is
   * where a person reads the code and decides (rule 12).
   */
  private async pickBlock(file: TFile): Promise<void> {
    const text = await this.app.vault.read(file);
    const blocks = findRunnableBlocks(text);
    if (blocks.length === 0) {
      new Notice("SCDB: no R or Python blocks in this note.", 6000);
      return;
    }
    if (blocks.length === 1) {
      const only = blocks[0];
      if (only !== undefined) this.runBlock(file, only);
      return;
    }
    new BlockPicker(this.app, blocks, (block) => this.runBlock(file, block)).open();
  }

  /**
   * Open the run dialog for one block.
   *
   * The provenance fields are seeded from the note when it happens to be a
   * script doc, because a person who already wrote down which extract a script
   * consumes should not retype it to run a block in the same note.
   */
  runBlock(file: TFile, block: RunnableBlock): void {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    const doc =
      frontmatter?.["type"] === "script-doc" ? parseScriptDoc(file.path, frontmatter) : null;

    new RunBlockModal(this.app, {
      runner: this.compute,
      file,
      block,
      seed: {
        request: doc?.requests[0] ?? "",
        inputs: doc?.inputs.map((entry) => ({ dataset: entry.dataset, version: entry.version })) ?? [],
        variables: doc?.variables ?? [],
      },
      onDone: (report) => {
        new Notice(`SCDB: ${runNotice(report)}`, 8000);
        this.refreshViews();
      },
    }).open();
  }

  // --- publications (§5.4, §7 B5) -------------------------------------------

  /**
   * Every publication note in the vault.
   *
   * Parsed on demand rather than cached: §5.4's numbers are all derived from
   * `history`, and a projection kept alongside the index would be one more
   * thing to invalidate for a note type measured in dozens, not thousands.
   */
  publications(): PublicationNote[] {
    const publications: PublicationNote[] = [];
    for (const entry of this.notes.all()) {
      if (entry.type !== PUBLICATION_TYPE) continue;
      publications.push(parsePublication(entry.file.path, entry.frontmatter));
    }
    return publications.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Move a manuscript to another stage, through the dialog that explains why not. */
  movePublication(publication: PublicationNote): void {
    const file = this.app.vault.getAbstractFileByPath(publication.path);
    if (!(file instanceof TFile)) {
      new Notice(`SCDB: "${publication.path}" is no longer in the vault.`, 8000);
      return;
    }

    new PublicationStageModal(this.app, {
      publication,
      onSubmit: async (submission) => {
        try {
          await this.publicationWriter.transition({
            file,
            publication,
            to: submission.to,
            ...(submission.journal === undefined ? {} : { journal: submission.journal }),
            ...(submission.decisionDue === undefined
              ? {}
              : { decisionDue: submission.decisionDue }),
          });
          this.refreshViews();
          new Notice(`SCDB: ${publication.id || "manuscript"} → ${submission.to}.`);
        } catch (error) {
          if (error instanceof PublicationRefused) {
            new Notice(`SCDB: move refused. ${error.message}`, 10000);
          } else {
            reportError(error, "could not move the manuscript.");
          }
        }
      },
    }).open();
  }

  /**
   * The formatted publication list, on the clipboard.
   *
   * Clipboard rather than a written note, deliberately: a CV lands in Word or
   * a grant portal, not in the vault, and writing a file the user then has to
   * find and copy out of is a step for nothing. B7's report engine is where a
   * list becomes a document.
   */
  async copyPublicationList(options: {
    format: CitationFormat;
    scdbOnly: boolean;
  }): Promise<void> {
    const groups = formatList(this.publications(), options);
    const total = groups.reduce((sum, group) => sum + group.citations.length, 0);
    if (total === 0) {
      new Notice("SCDB: nothing to copy — no manuscript is accepted, in press or published.", 6000);
      return;
    }

    const lines: string[] = [];
    const uncertain = new Set<string>();
    for (const group of groups) {
      lines.push(`## ${group.year ?? "Undated"}`, "");
      group.citations.forEach((citation, index) => {
        lines.push(`${index + 1}. ${citation.text}`);
        for (const name of citation.uncertain) uncertain.add(name.raw);
      });
      lines.push("");
    }

    const copied = await copyToClipboard(lines.join("\n").trimEnd());
    if (!copied) {
      new Notice("SCDB: the clipboard could not be written to.", 6000);
      return;
    }
    new Notice(
      `SCDB: ${total} reference${total === 1 ? "" : "s"} copied.` +
        (uncertain.size === 0
          ? ""
          : ` Check ${uncertain.size} author name${uncertain.size === 1 ? "" : "s"} the split was unsure about: ${[...uncertain].join(", ")}.`),
      uncertain.size === 0 ? 4000 : 10000,
    );
  }

  /** Where the recurrence engine says each rule-driven obligation falls next. */
  private computedDueDates(): Map<string, string> {
    const map = new Map<string, string>();
    for (const occurrence of this.eventSchedule()) {
      if (occurrence.source === "computed" && occurrence.date !== "") {
        map.set(occurrence.note.path, occurrence.date);
      }
    }
    return map;
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
   * Read a set of minutes, show what was found, write what survives review.
   *
   * The dialog is not a formality. Minutes are typed fast and often pasted
   * from somebody else's email, so §2 rule 5 applies to them exactly as it
   * does to a policy circular: what the parser proposes is a proposal, and it
   * reaches the vault only through a human ticking it.
   */
  private async extractMinutes(file: TFile): Promise<void> {
    try {
      const source = await this.extract.read(file);
      const choice = await reviewExtraction(this.app, {
        filename: file.basename,
        anchor: source.anchor,
        anchorFrom: source.anchorFrom,
        people: source.people,
        existing: source.existing,
        scan: (anchor) => this.extract.scan(source, anchor),
        folders: {
          events: this.settings.folders.events,
          inbox: this.settings.folders.inbox,
        },
      });
      if (choice === null) return;

      const plan = planExtraction(choice.items, choice.chosen, source.existing);
      const result = await this.extract.apply(source, plan);
      this.refreshViews();

      const parts: string[] = [];
      if (result.created.length > 0) {
        parts.push(`${result.created.length} note${result.created.length === 1 ? "" : "s"} created`);
      }
      if (result.decisions > 0) {
        parts.push(
          `${result.decisions} decision${result.decisions === 1 ? "" : "s"} recorded on the minutes`,
        );
      }
      new Notice(
        parts.length === 0
          ? "SCDB: nothing was extracted."
          : `SCDB: ${parts.join("; ")}. The minutes themselves are unchanged.`,
        6000,
      );
    } catch (error) {
      reportError(error, "could not extract from these minutes.");
    }
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

  /**
   * A phrase to a query (§7 B4). Offline, deterministic, no model involved.
   *
   * Parsed twice when the sentence names a note type, because the vocabulary
   * depends on which types are in play: "publications submitted this year"
   * has to be read against the publication catalogue, and the first pass is
   * what reveals that it is about publications at all.
   */
  searchInEnglish(text: string, base: Partial<Query>): { parsed: ParsedText; query: Query } {
    const deps = this.queryDeps();
    const first = parseQueryText(text, buildVocabulary(deps, base.types ?? []));
    const query = chipsToQuery(first.chips, base);

    const same =
      query.types.length === (base.types?.length ?? 0) &&
      query.types.every((type) => base.types?.includes(type) === true);
    if (same) return { parsed: first, query };

    const second = parseQueryText(text, buildVocabulary(deps, query.types));
    return { parsed: second, query: chipsToQuery(second.chips, base) };
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
  /** What was written, or null when the user cancelled or the write failed. */
  async exportDocument(request: ExportRequest): Promise<ExportResult | null> {
    const rows = `${request.rows} row${request.rows === 1 ? "" : "s"}`;
    let planned: string;
    try {
      planned = this.exporter.plannedPath(request.basename, request.extension);
    } catch (error) {
      // Nothing has been written, so this is a refusal rather than a failure.
      reportError(error, "could not work out where to write the export.");
      return null;
    }

    const go = await confirm(this.app, `Write ${rows} to ${planned}?`, "Export");
    if (!go) return null;

    try {
      const result = await this.exporter.write(request);
      new Notice(`SCDB: exported ${rows} to ${result.path}. Logged to the audit ledger.`, 8000);
      return result;
    } catch (error) {
      reportError(error, "could not write the export.");
      return null;
    }
  }

  /**
   * What the hat filter is hiding, in one line.
   *
   * Printed on every exported board and report. A document that shows two
   * thirds of the queue without saying so is the kind of thing somebody makes
   * a staffing decision on — §5.1's rule that nothing generated here is
   * presented as more than it is, applied to the filter rather than to the
   * system of record.
   */
  hatScope(): string {
    const { hidden, filtered } = this.visibleRequests();
    if (!filtered) return "Every hat";
    return (
      `${modeInfo(this.settings.mode).label} work only` +
      (hidden > 0
        ? `; ${hidden} request${hidden === 1 ? "" : "s"} under another hat not shown`
        : "")
    );
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
    const { views } = this.visibleRequests(now);

    const context: BoardContext = {
      views,
      allViews: this.index.views({ now }),
      spec: this.workflows.only(),
      hats: allModes().map((entry) => ({ id: entry.id, label: entry.label })),
      now,
      generatedAt: toVaultMinute(now).replace("T", " "),
      scope: this.hatScope(),
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

  // --- reports, the CV and the research profile (§7 B7) -----------------------

  /**
   * Pick a template, see what it would contain, write it.
   *
   * The dialog builds the report on every change so the row count it shows is
   * the row count the file will carry — see `ui/ReportModal`. That is cheap on
   * a vault this size and honest at any size.
   */
  async openReportDialog(): Promise<void> {
    const templates = this.reportTemplates.all();
    const problems = this.reportTemplates.problems();
    if (problems.length > 0) {
      new Notice(
        `SCDB: ${problems.length} problem${problems.length === 1 ? "" : "s"} in _config/reports/. ` +
          `First: ${problems[0]!.path} — ${problems[0]!.problem}`,
        12000,
      );
    }

    const now = Date.now();
    new ReportModal(this.app, {
      templates,
      studies: await this.reports.studies(now),
      defaultMonth: toVaultDate(now).slice(0, 7),
      defaultYear: toVaultDate(now).slice(0, 4),
      preview: (choice) => this.previewReport(choice),
      onSubmit: (choice) => this.runReport(choice),
    }).open();
  }

  /** One line saying what the current choice would produce, and where. */
  private async previewReport(choice: ReportChoice): Promise<string> {
    const template = this.reportTemplates.get(choice.templateId);
    if (template === null) return "That template is no longer available.";

    const built = await this.reports.build(template, choice);
    const where = this.exporter.plannedPath(built.document.title, built.extension);
    const size = Math.max(1, Math.round(built.content.length / 1024));

    return built.rows === 0
      ? `Nothing to report on: ${built.document.subtitle}. The file would still be written, to ${where}.`
      : `${built.rows} row${built.rows === 1 ? "" : "s"} · ${built.document.subtitle} · about ${size} KB → ${where}`;
  }

  /**
   * Build and write.
   *
   * Through `exportDocument`, so a report is guarded exactly as every other
   * export is (§7 A3): it lands in `95 Exports/`, the user confirms a line
   * naming the file and the row count, and an `export` entry goes into the
   * ledger. Nothing about a report deserves a softer path than a CSV.
   */
  async runReport(choice: ReportChoice): Promise<void> {
    const template = this.reportTemplates.get(choice.templateId);
    if (template === null) {
      new Notice(`SCDB: no report template called "${choice.templateId}".`, 8000);
      return;
    }

    let built;
    try {
      built = await this.reports.build(template, choice);
    } catch (error) {
      reportError(error, "could not build that report.");
      return;
    }

    const written = await this.exportDocument({
      basename: built.document.title,
      extension: built.extension,
      content: built.content,
      subject: `REPORT-${template.id}`,
      rows: built.rows,
    });

    // A markdown report is a note, so it opens where the user can read it. An
    // HTML file would open as a wall of markup, and Obsidian is not its reader.
    //
    // Opened from the `TFile` the exporter returned, **not** through
    // `openNote`: the note index is fed by Obsidian's asynchronous metadata
    // cache, so a file written a moment ago is not in it yet and the report
    // silently failed to open at all.
    if (written !== null && built.extension === "md") {
      void this.app.workspace.getLeaf(false).openFile(written.file);
    }
  }

  /** Copy the five built-in templates into `_config/reports/` for editing. */
  async writeReportTemplates(): Promise<void> {
    try {
      const { written, skipped } = await this.reportTemplates.writeBuiltIns();
      if (written.length === 0) {
        new Notice(
          `SCDB: every built-in template is already in ${this.reportTemplates.folder()} — nothing was overwritten.`,
          8000,
        );
        return;
      }
      new Notice(
        `SCDB: wrote ${written.length} template${written.length === 1 ? "" : "s"} to ${this.reportTemplates.folder()}.` +
          (skipped.length === 0
            ? ""
            : ` ${skipped.length} already existed and ${skipped.length === 1 ? "was" : "were"} left alone.`),
        10000,
      );
    } catch (error) {
      reportError(error, "could not write the report templates.");
    }
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

  /**
   * Ask for a phrase, then open Explore showing what it means (§7 B4).
   *
   * The dialog only collects the words; every chip it parsed into is visible
   * and removable on the board, because a search you cannot inspect is not a
   * search you can defend a number with.
   */
  private async searchFromCommand(): Promise<void> {
    const phrase = await askText(this.app, {
      title: "Search in English",
      lede: "Offline and deterministic — it knows this vault's stages, fields and names, and reports any words it could not place.",
      label: "Ask for",
      initial: "",
      submitLabel: "Search",
    });
    if (phrase === null || phrase.trim() === "") return;
    await this.activateCockpit("explore", phrase);
  }

  // ---------------------------------------------------------------- D1: diagrams

  /**
   * Open a diagram note in the editor pane.
   *
   * One pane, reused: a diagram editor per note would leave a row of tabs after
   * an afternoon, and the pane is a workbench rather than a document.
   */
  async openDiagram(file: TFile, spec?: DiagramSpec): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(DIAGRAM_VIEW_TYPE)[0];
    const leaf = existing ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: DIAGRAM_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    // After the view state, never in it — see `DiagramView.setFile`.
    if (leaf.view instanceof DiagramView) leaf.view.setFile(file, spec);
  }

  /** Create a diagram note from a spec and open it. */
  private async createDiagram(spec: DiagramSpec, basename?: string): Promise<void> {
    try {
      const file = await this.diagrams.create(spec, basename);
      this.notes.update(file);
      await this.openDiagram(file, spec);
      new Notice(`SCDB: created ${file.basename}.`, 5000);
    } catch (error) {
      new Notice(
        `SCDB: the diagram note could not be created. ${error instanceof Error ? error.message : String(error)}`,
        8000,
      );
    }
  }

  private async newDiagram(): Promise<void> {
    await this.createDiagram(emptyDiagram("Untitled flowchart"), "Untitled flowchart");
  }

  /**
   * Draw the request lifecycle from the workflow spec.
   *
   * The differentiator over a drawing tool (§7 D1): this is the process as
   * configured, not as remembered, and it carries the spec version so a copy
   * left in the vault after the spec changes is detectable rather than merely
   * wrong.
   */
  private async drawWorkflow(): Promise<void> {
    const specs = this.workflows.usable();
    if (specs.length === 0) {
      new Notice(
        `SCDB: no usable workflow spec in ${this.settings.folders.config}/workflows/. Run the diagnostics self-test to see what it could not read.`,
        8000,
      );
      return;
    }

    const draw = (spec: WorkflowSpec): void => {
      void this.createDiagram(
        workflowDiagram(spec, Date.now()),
        `${spec.id} lifecycle v${spec.version}`,
      );
    };

    const only = specs[0];
    if (specs.length === 1 && only !== undefined) draw(only);
    else new WorkflowPicker(this.app, specs, draw).open();
  }

  private pickRequestToDraw(kind: "path" | "data-flow"): void {
    const entries = this.index.all();
    if (entries.length === 0) {
      new Notice(`SCDB: no requests in ${this.settings.folders.requests}.`, 6000);
      return;
    }
    new RequestPicker(
      this.app,
      entries,
      this.workflows.only(),
      (entry: IndexEntry) => {
        const now = Date.now();
        const spec =
          kind === "path"
            ? requestPathDiagram(entry.request, this.workflows.forRequest(entry.request.workflow), now)
            : dataFlowDiagram(entry.request, now);
        const stem = `${entry.request.id || entry.request.uid} ${kind === "path" ? "path" : "data flow"}`;
        void this.createDiagram(spec, stem);
      },
      kind === "path" ? "Draw the path of which request?" : "Draw the data flow for which request?",
    ).open();
  }

  /**
   * Rebuild a generated diagram from its source.
   *
   * Returns null rather than guessing when the source cannot be found — a
   * redraw that silently produced an empty diagram would look like the process
   * had been deleted.
   */
  async redrawDiagram(spec: DiagramSpec): Promise<DiagramSpec | null> {
    const now = Date.now();
    if (spec.source === "workflow") {
      // The spec id is stamped as `id@version`, so a redraw finds the same
      // workflow even in a vault that has grown a second one.
      const workflow = this.workflows.get(spec.generatedFrom.split("@")[0] ?? "");
      if (workflow === null) return null;
      return { ...workflowDiagram(workflow, now), id: spec.id, title: spec.title };
    }

    if (spec.source === "request-path" || spec.source === "data-flow") {
      const entry = this.index
        .all()
        .find((candidate) => candidate.request.id === spec.generatedFrom || candidate.request.uid === spec.generatedFrom);
      if (entry === undefined) return null;
      const fresh =
        spec.source === "request-path"
          ? requestPathDiagram(entry.request, this.workflows.forRequest(entry.request.workflow), now)
          : dataFlowDiagram(entry.request, now);
      return { ...fresh, id: spec.id, title: spec.title };
    }

    return null;
  }

  async activateCockpit(tab?: CockpitTab, search?: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(COCKPIT_VIEW_TYPE);

    if (existing.length > 0) {
      const leaf = existing[0]!;
      await workspace.revealLeaf(leaf);
      if (tab && leaf.view instanceof CockpitView) leaf.view.focusTab(tab, search);
      return;
    }

    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: COCKPIT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    if (tab && leaf.view instanceof CockpitView) leaf.view.focusTab(tab, search);
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

  // --- deadlines and recurring obligations (§7 B3) ------------------------------

  /** The whole schedule, computed. Nothing here writes. */
  eventSchedule(now = Date.now()) {
    return this.events.schedule(now);
  }

  /** The event or obligation note in the active editor, if there is one. */
  private currentEventNote(): EventNote | null {
    const file = this.app.workspace.getActiveFile();
    if (file === null) return null;
    const entry = this.notes.byPath(file.path);
    if (entry === null || !isEventType(entry.type)) return null;
    return parseEventNote(entry.file.path, entry.frontmatter);
  }

  /**
   * Recompute reminders and repaint the badge.
   *
   * In-app only, per §7 B3 — a badge, a board and a notice. No OS notification
   * and no email: the work laptop can be relied on for neither, and a reminder
   * that silently fails to arrive is worse than one that never promised to.
   *
   * @param announce raise a notice for anything newly lapsed. False on the
   *   interval tick, so a lapsed obligation is said once rather than hourly.
   */
  checkReminders(announce = false): void {
    this.lastReminderCheck = Date.now();
    this.renderDeadlineBar();

    if (!announce || !this.settings.events.notifyOnOpen) return;

    const overdue = lapsed(this.eventSchedule());
    const fresh = overdue.filter((entry) => !this.announced.has(`${entry.note.path}@${entry.date}`));
    for (const entry of overdue) this.announced.add(`${entry.note.path}@${entry.date}`);
    if (fresh.length === 0) return;

    const first = fresh[0]!;
    const rest = fresh.length - 1;
    new Notice(
      `SCDB: ${first.note.id} lapsed ${-first.inDays} days ago` +
        (first.note.consequence === "" ? "." : ` — ${first.note.consequence}`) +
        (rest > 0 ? ` (and ${rest} more)` : ""),
      12000,
    );
  }

  /** Create an obligation or a one-off deadline from the dialog. */
  async newObligation(): Promise<void> {
    const now = Date.now();
    const draft = await askObligation(
      this.app,
      emptyDraft(toVaultDate(now), this.settings.events.leadDays),
      toVaultDate(now),
    );
    if (draft === null) return;

    try {
      const file = await this.events.createObligation({
        title: draft.title,
        due: draft.due.trim(),
        recurrence:
          draft.recurrence === null
            ? null
            : { ...draft.recurrence, anchor: draft.recurrence.anchor.trim() },
        leadDays: draft.leadDays,
        owner: draft.owner,
        study: draft.study,
        consequence: draft.consequence,
        now,
      });
      this.refreshViews();
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      reportError(error, "could not create that deadline.");
    }
  }

  /**
   * Record an obligation as done.
   *
   * The date is asked for rather than assumed: a continuing review is usually
   * recorded a few days after it happened, and dating it today would move every
   * subsequent occurrence by that much if the schedule were counted from the
   * completion. It is not — see `completion` — but the record should still say
   * when the thing actually happened.
   */
  async completeObligation(note: EventNote): Promise<void> {
    const today = toVaultDate(Date.now());
    const on = await askText(this.app, {
      title: "Record as done",
      lede:
        `${note.id}${note.title === "" ? "" : ` — ${note.title}`}. ` +
        (note.recurrence === null
          ? "This happens once, so it keeps its date and simply gains a completion."
          : "The next occurrence is counted from the rule, not from today, so recording it late does not shift the cycle."),
      label: "Completed on",
      initial: today,
      submitLabel: "Record",
      validate: (value) =>
        parseDate(value) === null ? "Give a date the calendar has, as YYYY-MM-DD." : "",
    });
    if (on === null) return;

    try {
      const { next } = await this.events.complete(note, on);
      this.refreshViews();
      this.notify(
        next === ""
          ? `${note.id} recorded as done on ${on}.`
          : `${note.id} recorded as done on ${on}. Next due ${next}.`,
        6000,
      );
    } catch (error) {
      reportError(error, "could not record that as done.");
    }
  }

  /**
   * Write each computed next occurrence into its note.
   *
   * Confirmed first, listing every change. The board already works without
   * this — the dates are computed on the fly — so the only thing it buys is a
   * `due` another tool can read, which is not worth a silent write (rule 12).
   */
  async materialiseOccurrences(): Promise<void> {
    const plans = this.events.plans();
    if (plans.length === 0) {
      this.notify(
        "Every recurring obligation already carries the date its rule computes. Nothing to write.",
        6000,
      );
      return;
    }

    const lines = plans
      .map(
        (plan) =>
          `• ${plan.note.id} — ${plan.from === "" ? "no date" : plan.from} → ${plan.to}`,
      )
      .join("\n");
    const ok = await confirm(
      this.app,
      `Write the computed next occurrence into ${plans.length} note${plans.length === 1 ? "" : "s"}?\n\n${lines}\n\nThis edits the due date in the frontmatter and is recorded in the audit ledger.`,
      "Write dates",
    );
    if (!ok) return;

    try {
      const written = await this.events.materialise(plans);
      this.refreshViews();
      this.notify(`Wrote the next occurrence into ${written} note${written === 1 ? "" : "s"}.`, 6000);
    } catch (error) {
      reportError(error, "could not write those dates.");
    }
  }

  /** Write the `.ics` file Outlook can import or subscribe to (§7 B3). */
  async exportCalendar(): Promise<void> {
    const now = Date.now();
    const { count: entries } = this.events.calendarText(now);
    const path = this.events.calendarPath();

    if (entries === 0) {
      this.notify("There is no dated event or obligation to put in a calendar yet.", 6000);
      return;
    }

    const exists = this.app.vault.getAbstractFileByPath(path) !== null;
    const ok = await confirm(
      this.app,
      `Write ${entries} deadline${entries === 1 ? "" : "s"} to ${path}?\n\n` +
        (exists ? "The existing file is replaced, so a subscription picks up the new dates.\n\n" : "") +
        "Entries carry the note id, title, date and the consequence the note states — never note content. " +
        "The file stays in the vault until you point Outlook at it.",
      exists ? "Replace" : "Write",
    );
    if (!ok) return;

    try {
      const written = await this.events.exportCalendar(now);
      this.notify(`Wrote ${written.count} deadline${written.count === 1 ? "" : "s"} to ${written.path}.`, 8000);
    } catch (error) {
      reportError(error, "could not write the calendar file.");
    }
  }

  /**
   * Read an `.ics` already saved into the vault and make event notes from it.
   *
   * Vault files only: reading an arbitrary path would mean `fs`, which rule 8
   * forbids. Saving the Outlook export into the vault first is one extra step
   * and keeps every read inside Obsidian.
   */
  async importCalendar(): Promise<void> {
    const choices: CalendarChoice[] = this.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "ics")
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .map((file) => ({
        path: file.path,
        detail: `${Math.max(1, Math.round(file.stat.size / 1024))} KB · modified ${toVaultDate(file.stat.mtime)}`,
      }));

    if (choices.length === 0) {
      this.notify(
        `No .ics file in the vault. Export one from Outlook, save it anywhere in the vault — ${this.settings.folders.exports}/ is the obvious place — and run this again.`,
        10000,
      );
      return;
    }

    const chosen = await pickCalendarFile(this.app, choices);
    if (chosen === null) return;

    const file = this.app.vault.getAbstractFileByPath(chosen.path);
    if (!(file instanceof TFile)) {
      this.notify(`${chosen.path} is no longer there.`, 6000);
      return;
    }

    try {
      const text = await this.app.vault.read(file);
      const preview = parseCalendar(text);
      if (preview.events.length === 0) {
        this.notify(
          preview.problems.length > 0
            ? `Nothing to import from ${chosen.path}: ${preview.problems[0]}`
            : `No calendar entries found in ${chosen.path}.`,
          9000,
        );
        return;
      }

      const ok = await confirm(
        this.app,
        `Create event notes from ${preview.events.length} entr${preview.events.length === 1 ? "y" : "ies"} in ${chosen.path}?\n\n` +
          `They land in ${this.settings.folders.events}/ as event notes. Anything already imported under the same calendar id is skipped, and nothing already in the vault is changed.`,
        "Import",
      );
      if (!ok) return;

      const outcome = await this.events.importCalendar(text);
      this.refreshViews();

      const parts = [`${outcome.created.length} created`];
      if (outcome.duplicates > 0) parts.push(`${outcome.duplicates} already present`);
      if (outcome.problems.length > 0) parts.push(`${outcome.problems.length} skipped`);
      this.notify(`Calendar import: ${parts.join(", ")}.`, 9000);
    } catch (error) {
      reportError(error, "could not read that calendar file.");
    }
  }

  /**
   * Person-note names, so an imported correspondent links to the note that
   * exists rather than to a near-miss of it.
   *
   * Names only, matched exactly and case-folded in `partyFor`. Nothing fuzzier
   * — attributing a governance holdup to somebody because a substring matched
   * is a guess a governance instrument must not make.
   */
  private peopleNames(): string[] {
    const prefix = `${this.settings.folders.people}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => file.basename);
  }

  /**
   * Read saved message files already in the vault into correspondence threads
   * (§5.10, email Tier 1).
   *
   * The whole vault is scanned rather than one file being picked, because the
   * working shape of this is "drag a few messages in, run the command": every
   * message already recorded is skipped on its `Message-ID`, so running it
   * again after adding three more files costs nothing and does nothing twice.
   *
   * Nothing is fetched. Nothing is sent. No mailbox is opened.
   */
  async importEml(): Promise<void> {
    if (!this.emlImport.canDetermineDirection()) {
      // Refusing rather than guessing. `awaiting` is what the whole
      // correspondence note type exists to compute, and a wrong direction
      // turns an unanswered chase-up into a closed loop.
      this.notify(
        "Add your own email addresses in SCDB Cockpit settings first. Without them the plugin " +
          "cannot tell a message you sent from one you received, and that decides who a thread " +
          "is waiting on.",
        12000,
      );
      return;
    }

    const files = this.emlImport.candidates();
    if (files.length === 0) {
      this.notify(
        `No .eml or .msg file in the vault. Drag messages out of Outlook into a folder here — ` +
          `${this.settings.folders.correspondence}/ is the obvious place — and run this again. ` +
          `Either format works: new Outlook and the web app save .eml, classic Outlook saves .msg.`,
        14000,
      );
      return;
    }

    // A cap, so a vault that has accumulated a year of saved mail does not
    // parse thousands of files behind a modal that has not opened yet. The
    // newest are the ones somebody just dragged in.
    const CAP = 300;
    const chosen = files.slice(0, CAP);

    const working = new Notice(
      `SCDB: reading ${chosen.length} email file${chosen.length === 1 ? "" : "s"}…`,
      0,
    );
    let preview;
    try {
      preview = await this.emlImport.preview(chosen);
    } catch (error) {
      working.hide();
      reportError(error, "could not read those email files.");
      return;
    }
    working.hide();

    if (preview.actions.length === 0) {
      const total = chosen.reduce((bytes, file) => bytes + file.stat.size, 0);
      this.notify(
        preview.duplicates > 0
          ? `Nothing new: all ${preview.duplicates} message${preview.duplicates === 1 ? " is" : "s are"} already on a thread.`
          : `Read ${chosen.length} file${chosen.length === 1 ? "" : "s"} (${sizeLabel(total)}) and found no message to import.`,
        9000,
      );
      return;
    }

    const choice = await reviewEmlImport(
      this.app,
      preview,
      this.emlImport.attachmentsFolder(),
    );
    if (choice === null) return;

    try {
      const outcome = await this.emlImport.apply(choice.actions);
      this.refreshViews();

      const parts = [
        `${outcome.messages} message${outcome.messages === 1 ? "" : "s"}`,
        `${outcome.threadsCreated} new thread${outcome.threadsCreated === 1 ? "" : "s"}`,
      ];
      if (outcome.threadsUpdated > 0) parts.push(`${outcome.threadsUpdated} updated`);
      if (outcome.attachments > 0) {
        parts.push(`${outcome.attachments} attachment${outcome.attachments === 1 ? "" : "s"}`);
      }
      if (files.length > CAP) {
        parts.push(`${files.length - CAP} older file${files.length - CAP === 1 ? "" : "s"} not read`);
      }
      this.notify(`Imported: ${parts.join(", ")}. The message files were left where they are.`, 10000);

      for (const problem of outcome.problems) this.notify(problem, 10000);
    } catch (error) {
      reportError(error, "could not write those threads.");
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshViews();
  }
}
