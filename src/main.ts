import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { migrateSettings } from "./domain/settings/migrate.js";
import { defaultSettings, type ScdbSettings } from "./domain/settings/schema.js";
import { ScdbSettingsTab } from "./settings/SettingsTab.js";
import { COCKPIT_VIEW_TYPE, CockpitView } from "./ui/CockpitView.js";

export default class ScdbCockpitPlugin extends Plugin {
  // `Plugin` declares `settings?: unknown`; we narrow it to our schema.
  override settings: ScdbSettings = defaultSettings();
  migrationNotes: string[] = [];

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

    this.registerView(COCKPIT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CockpitView(leaf, this));
    this.addSettingTab(new ScdbSettingsTab(this.app, this));

    this.addCommand({
      id: "open-cockpit",
      name: "Open cockpit",
      callback: () => void this.activateCockpit(),
    });

    this.addRibbonIcon("layout-dashboard", "SCDB Cockpit", () => void this.activateCockpit());

    // Migration notes are shown once on load. On the work laptop there is no
    // console to check, so anything the user needs to know must reach the UI.
    if (this.migrationNotes.length > 0) {
      new Notice(`SCDB Cockpit: settings updated. See plugin settings for details.`, 8000);
    }
  }

  async activateCockpit(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(COCKPIT_VIEW_TYPE);

    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]!);
      return;
    }

    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: COCKPIT_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
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
  }
}
