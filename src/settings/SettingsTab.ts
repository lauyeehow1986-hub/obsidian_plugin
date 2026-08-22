import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { backupAge } from "../domain/backup/snapshots.js";
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

    this.backupSection(containerEl);

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

  /**
   * Encrypted snapshots (§7 A4).
   *
   * The destination is a plain text field rather than a folder picker: Obsidian
   * has no dialog for a path outside the vault, and Electron's would be a
   * dependency on API surface the minAppVersion does not promise. A "Test"
   * button next to the field is the ten-second answer instead — the same
   * argument §11 makes for the protocol-handler link test.
   */
  private backupSection(containerEl: HTMLElement): void {
    const backup = this.plugin.settings.backup;
    containerEl.createEl("h3", { text: "Encrypted backup" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "A dated, AES-256-GCM encrypted archive of every note and attachment, written " +
        "outside the vault. Obsidian settings, themes and plugins are not included. " +
        "The passphrase is asked for each time and is never stored — losing it means " +
        "losing the archive.",
    });

    new Setting(containerEl)
      .setName("Destination folder")
      .setDesc(
        "Full path to a folder outside the vault. A folder on this machine protects " +
          "against an edited or deleted note, not against losing the laptop — if this is " +
          "the only copy of the vault, point it at a drive that is backed up elsewhere.",
      )
      .addText((text) =>
        text
          .setPlaceholder("C:\\Users\\you\\Downloads")
          .setValue(backup.destination)
          .onChange(async (value) => {
            this.plugin.settings.backup.destination = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          const problem = await this.plugin.backup.destinationProblem();
          if (problem !== null) {
            new Notice(`SCDB: ${problem}`, 12000);
            return;
          }
          const snapshots = await this.plugin.backup.list();
          new Notice(
            `SCDB: destination is usable. ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} there now.`,
            8000,
          );
        }),
      );

    new Setting(containerEl)
      .setName("Snapshots to keep")
      .setDesc(
        "Older snapshots are deleted after a successful new one. Only files this plugin " +
          "named are ever removed — nothing else in that folder is touched.",
      )
      .addText((text) =>
        text.setValue(String(backup.keep)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.backup.keep = Math.min(365, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Remind me after")
      .setDesc("Days before the status bar says the backup is getting old.")
      .addText((text) =>
        text.setValue(String(backup.intervalDays)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.backup.intervalDays = Math.min(365, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    const last = backup.lastAt === "" ? NaN : Date.parse(backup.lastAt);
    const age = backupAge(
      Number.isNaN(last) ? null : last,
      backup.intervalDays,
      Date.now(),
    );
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        backup.lastName === ""
          ? age.text
          : `${age.text} (${backup.lastName}). Verify it from the command palette — a backup nobody has ever opened is not a backup.`,
    });
  }
}
