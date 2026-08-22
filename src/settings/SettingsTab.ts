import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { backupAge } from "../domain/backup/snapshots.js";
import { allModes, modeInfo } from "../domain/settings/mode.js";
import { MODES } from "../domain/settings/schema.js";
import { buildMailto, buildTeamsChat, MIN_URI_CEILING } from "../domain/comms/uri.js";
import { probeHandler, reportLaunch } from "../services/protocol.js";
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

    this.messagesSection(containerEl);
    this.briefingSection(containerEl);
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
   * Composing messages (§5.11).
   *
   * The two "Test" buttons are §11's open question made answerable in ten
   * seconds on the machine that matters: is Outlook actually registered for
   * `mailto:`, and does the Teams deep link open a chat? Neither can be
   * detected from inside Obsidian — the only honest answer is to open one and
   * let the user look.
   */
  private messagesSection(containerEl: HTMLElement): void {
    const comms = this.plugin.settings.comms;
    containerEl.createEl("h3", { text: "Messages" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The plugin composes; it never sends. A draft is handed to Outlook or Teams and " +
        "you press send. No credentials, no mailbox access, nothing leaves the machine " +
        "until you do it yourself. Every composed message is logged as composed — not " +
        "as sent, because we cannot know that.",
    });

    new Setting(containerEl)
      .setName("Longest link to open")
      .setDesc(
        "Protocol handlers truncate somewhere around 2,000 characters and the exact " +
          "figure varies. Over this, the draft goes to the clipboard whole rather than " +
          "opening with the end cut off. Lower it if a draft ever arrives truncated.",
      )
      .addText((text) =>
        text.setValue(String(comms.uriCeiling)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.comms.uriCeiling = Math.min(
            8000,
            Math.max(MIN_URI_CEILING, parsed),
          );
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Chase after")
      .setDesc(
        "Days before a composed message with no reply recorded shows up in the holdup " +
          "board. A list that nags after 72 hours stops being read.",
      )
      .addText((text) =>
        text.setValue(String(comms.chaseDays)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.comms.chaseDays = Math.min(365, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Test the handlers")
      .setDesc(
        "Opens a trivial draft so you can see whether this machine has a mail client " +
          "and a Teams client registered. Nothing is addressed to anybody real and " +
          "nothing is sent.",
      )
      .addButton((button) =>
        button.setButtonText("Test mailto:").onClick(async () => {
          const built = buildMailto({
            // A documented example domain, so a mis-click cannot reach a person.
            to: ["test@example.com"],
            subject: "SCDB Cockpit handler test",
            body: "If you can read this in a mail client, mailto: works on this machine.",
          });
          if (!built.ok) {
            new Notice(`SCDB: ${built.problems.join(" ")}`, 8000);
            return;
          }
          reportLaunch(await probeHandler(built.uri));
        }),
      )
      .addButton((button) =>
        button.setButtonText("Test Teams").onClick(async () => {
          const built = buildTeamsChat({
            users: ["test@example.com"],
            message: "SCDB Cockpit handler test.",
          });
          if (!built.ok) {
            new Notice(`SCDB: ${built.problems.join(" ")}`, 8000);
            return;
          }
          reportLaunch(await probeHandler(built.uri));
        }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `Templates live in ${this.plugin.settings.folders.config}/messages/. Drop a ` +
        "`chase-up.md` there with a `subject:` in its frontmatter and the message in its " +
        "body to make the tone yours. Available placeholders: {{name}}, {{date}}, " +
        "{{count}}, {{summary}}, {{items}}, {{actor}} — and deliberately nothing that " +
        "could reach note content into a link.",
    });
  }

  /** The daily briefing (§7 B1). Off until asked for, like everything else. */
  private briefingSection(containerEl: HTMLElement): void {
    const briefing = this.plugin.settings.briefing;
    containerEl.createEl("h3", { text: "Daily briefing" });

    new Setting(containerEl)
      .setName("Write one on the first open each day")
      .setDesc(
        `A dated note in ${this.plugin.settings.folders.briefings}: what is due, what is ` +
          "breaching, what is stuck and with whom. It never overwrites one that already " +
          "exists. Off by default — a plugin that writes into your vault uninvited has " +
          "made a decision that was yours.",
      )
      .addToggle((toggle) =>
        toggle.setValue(briefing.onOpen).onChange(async (value) => {
          this.plugin.settings.briefing.onOpen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Look ahead")
      .setDesc("Days of upcoming deadlines and obligations the briefing and overview include.")
      .addText((text) =>
        text.setValue(String(briefing.horizonDays)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.briefing.horizonDays = Math.min(730, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        briefing.lastDate === ""
          ? "No briefing has been written yet. \"Write today's briefing\" in the command palette makes one now."
          : `Last briefing: ${briefing.lastDate}.`,
    });
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
