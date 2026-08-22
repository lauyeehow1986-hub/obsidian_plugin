import { App, PluginSettingTab, Setting } from "obsidian";
import { MODES } from "../domain/settings/schema.js";
import type ScdbCockpitPlugin from "../main.js";

export class ScdbSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ScdbCockpitPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Actor")
      .setDesc(
        "Recorded as the actor in the audit ledger and effort log. Use a short handle, not a full name.",
      )
      .addText((text) =>
        text
          .setPlaceholder("yh")
          .setValue(this.plugin.settings.actor)
          .onChange(async (value) => {
            this.plugin.settings.actor = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("Which hat you are wearing. Filters views and attributes effort.")
      .addDropdown((dropdown) => {
        for (const mode of MODES) dropdown.addOption(mode, mode);
        dropdown.setValue(this.plugin.settings.mode).onChange(async (value) => {
          if ((MODES as readonly string[]).includes(value)) {
            this.plugin.settings.mode = value as (typeof MODES)[number];
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName("Core Bases integration")
      .setDesc(
        `Use Obsidian's built-in Bases views when available. Currently ${
          this.plugin.basesAvailable ? "available" : "not available in this Obsidian version"
        }.`,
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "Use when available")
          .addOption("off", "Never use")
          .setValue(this.plugin.settings.bases)
          .onChange(async (value) => {
            this.plugin.settings.bases = value === "off" ? "off" : "auto";
            await this.plugin.saveSettings();
          }),
      );

    // Surfacing migration notes here rather than only in the console: on the
    // work laptop there are no dev tools to open (CLAUDE.md §7 A4).
    if (this.plugin.migrationNotes.length > 0) {
      const details = containerEl.createEl("details");
      details.createEl("summary", { text: "Settings migration notes" });
      const list = details.createEl("ul");
      for (const note of this.plugin.migrationNotes) {
        list.createEl("li", { text: note });
      }
    }
  }
}
