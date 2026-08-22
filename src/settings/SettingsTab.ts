import { App, PluginSettingTab, Setting } from "obsidian";
import { allModes, modeInfo } from "../domain/settings/mode.js";
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
      .setDesc(
        `Which hat you are wearing. ${modeInfo(this.plugin.settings.mode).blurb} ` +
          "Also on the status bar — click it to cycle, or press Ctrl+Shift+1/2/3. " +
          "(Ctrl+1/2/3 is Obsidian's own tab switcher; rebind in Hotkeys if you want it.)",
      )
      .addDropdown((dropdown) => {
        for (const info of allModes()) dropdown.addOption(info.id, info.label);
        dropdown.setValue(this.plugin.settings.mode).onChange(async (value) => {
          if ((MODES as readonly string[]).includes(value)) {
            await this.plugin.setMode(value as (typeof MODES)[number]);
            this.display();
          }
        });
      });

    new Setting(containerEl)
      .setName("Hat filter")
      .setDesc(
        "Whether the boards narrow to the hat you are wearing. Notes with no `hat` " +
          "always show, and every board states how many it is holding back.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("mode", "Show only the current hat")
          .addOption("all", "Show every hat")
          .setValue(this.plugin.settings.hatFilter)
          .onChange(async (value) => {
            await this.plugin.setHatFilter(value === "all" ? "all" : "mode");
          }),
      );

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
