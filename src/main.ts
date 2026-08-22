import { Notice, Plugin, TFile, debounce, type WorkspaceLeaf } from "obsidian";
import { RequestIndex } from "./data/requestIndex.js";
import { WorkflowStore } from "./data/workflowStore.js";
import { requestMetrics } from "./domain/request/dwell.js";
import { isStranded } from "./domain/request/migration.js";
import type { RequestNote } from "./domain/request/request.js";
import { TransitionRefused } from "./domain/request/transition.js";
import type { WorkflowSpec } from "./domain/request/workflow.js";
import { migrateSettings } from "./domain/settings/migrate.js";
import { defaultSettings, type ScdbSettings } from "./domain/settings/schema.js";
import { AuditLog } from "./services/auditLog.js";
import {
  RequestWriter,
  reportError,
  type MigrateRequestInput,
} from "./services/requestWriter.js";
import { ScdbSettingsTab } from "./settings/SettingsTab.js";
import { COCKPIT_VIEW_TYPE, CockpitView, type CockpitTab } from "./ui/CockpitView.js";
import { IntakeModal } from "./ui/IntakeModal.js";
import { RequestDetailModal } from "./ui/RequestDetailModal.js";
import { TransitionModal } from "./ui/TransitionModal.js";

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
  index!: RequestIndex;
  audit!: AuditLog;
  writer!: RequestWriter;

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
    this.index = new RequestIndex(this.app, () => this.settings.folders.requests, this.workflows);
    this.audit = new AuditLog(this.app, () => this.settings.folders.audit);
    this.writer = new RequestWriter({
      app: this.app,
      index: this.index,
      audit: this.audit,
      requestsFolder: () => this.settings.folders.requests,
      actor: () => this.settings.actor,
    });

    this.registerView(COCKPIT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CockpitView(leaf, this));
    this.addSettingTab(new ScdbSettingsTab(this.app, this));
    this.registerCommands();
    this.addRibbonIcon("layout-dashboard", "SCDB Cockpit", () => void this.activateCockpit());

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
      id: "verify-audit-ledger",
      name: "Verify audit ledger",
      callback: () => void this.verifyLedger(),
    });

    this.addCommand({
      id: "reindex",
      name: "Rebuild the request index",
      callback: () => void this.reindex(true),
    });
  }

  private registerWatchers(): void {
    const refresh = debounce(() => this.refreshViews(), 150, true);

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.index.update(file)) refresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.index.remove(file.path)) refresh();
        if (this.workflows.isSpecPath(file.path)) void this.reloadWorkflows();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.index.rename(oldPath, file);
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
    this.index.rebuild();
    this.refreshViews();
    if (announce) {
      const ms = Math.round(performance.now() - started);
      new Notice(`SCDB: indexed ${this.index.size} requests in ${ms} ms.`);
    }
  }

  refreshViews(): void {
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
