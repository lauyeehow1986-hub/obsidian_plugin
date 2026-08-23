import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { backupAge } from "../domain/backup/snapshots.js";
import type { AttachmentPolicy } from "../domain/comms/emlThread.js";
import { describeAlerts } from "../domain/events/schedule.js";
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
    this.emailImportSection(containerEl);
    this.briefingSection(containerEl);
    this.effortSection(containerEl);
    this.eventsSection(containerEl);
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

  /**
   * Importing saved email files (§5.10, email Tier 1).
   *
   * Its own section rather than a few more rows under Messages, because the two
   * halves of correspondence pull in opposite directions: composing sends
   * nothing and touches nothing, while importing puts full message bodies and
   * attachments into the vault. §5.10 permits that and names the consequence —
   * the vault becomes a regulated data store — and a setting with that
   * consequence deserves to be read rather than skimmed past.
   */
  private emailImportSection(containerEl: HTMLElement): void {
    const comms = this.plugin.settings.comms;
    containerEl.createEl("h3", { text: "Importing saved email" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Drag messages out of Outlook into this vault and the plugin reads them into " +
        "correspondence threads, so replies age in the same holdup view as everything " +
        "else. No mailbox is opened, nothing is fetched and nothing is sent — it reads " +
        "files that are already here. Classic Outlook saves .msg, which this cannot " +
        "read; new Outlook and the web app give .eml.",
    });

    new Setting(containerEl)
      .setName("My email addresses")
      .setDesc(
        "One per line, or comma separated. Used only to tell a message you sent from " +
          "one you received — which is what decides whether a thread is waiting on you " +
          "or on them. The import refuses to run until at least one is set, because " +
          "there is no way to guess this and getting it backwards silently closes " +
          "follow-ups that are still open.",
      )
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setPlaceholder("you@institution.edu");
        text.setValue(comms.myAddresses.join("\n")).onChange(async (value) => {
          this.plugin.settings.comms.myAddresses = [
            ...new Set(
              value
                .split(/[\n,;]+/)
                .map((entry) => entry.trim().toLowerCase())
                .filter((entry) => entry.includes("@")),
            ),
          ];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Attachments")
      .setDesc(
        "Where a message's files go. Embedded images are the crest and signature logo " +
          "on every message from a large institution, so they are left out unless you " +
          "ask for them. Whatever is left behind is named in the note.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            attachments: "Save attached files",
            all: "Save attached files and embedded images",
            none: "Save none, just name them",
          })
          .setValue(comms.emlAttachments)
          .onChange(async (value) => {
            this.plugin.settings.comms.emlAttachments = value as AttachmentPolicy;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Largest attachment to save")
      .setDesc(
        "In KB. Anything bigger is named in the note and left in the message file, so a " +
          "60 MB slide deck does not quietly land in every backup snapshot.",
      )
      .addText((text) =>
        text.setValue(String(comms.emlMaxAttachmentKb)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.comms.emlMaxAttachmentKb = Math.min(
            200 * 1024,
            Math.max(1, parsed),
          );
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "§5.10 permits full message bodies and attachments in the vault, and names the " +
        "consequence: this vault is therefore a regulated data store, not a notebook. " +
        "It stays on this machine, never enters the plugin's repository, and " +
        "correspondence fields stay out of exports by default.",
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

  /** The effort timer (§7 B2). */
  private effortSection(containerEl: HTMLElement): void {
    const effort = this.plugin.settings.effort;
    containerEl.createEl("h3", { text: "Time and effort" });

    new Setting(containerEl)
      .setName("Ask about a gap after")
      .setDesc(
        "Minutes of silence before the timer asks what happened. What this detects is the " +
          "machine sleeping or Obsidian not running — a missed heartbeat — not you being away " +
          "from the keyboard, which no API here can see. Two minutes is the floor: the timer " +
          "checks in once a minute, so anything shorter would ask on every check.",
      )
      .addText((text) =>
        text.setValue(String(effort.idleMinutes)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.effort.idleMinutes = Math.min(480, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Default cost centre")
      .setDesc("Pre-filled on new entries, so chargeback coding is not retyped every day.")
      .addText((text) =>
        text.setValue(effort.costCentre).onChange(async (value) => {
          this.plugin.settings.effort.costCentre = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    const vocab = this.plugin.effort.vocabularies();
    const problems = this.plugin.effort.vocabularyProblems();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `Activities: ${vocab.activities.join(", ")}. ` +
        (vocab.fromFile
          ? `Read from ${this.plugin.settings.folders.config}/vocabularies.yaml.`
          : `The built-in list. Write ${this.plugin.settings.folders.config}/vocabularies.yaml to change it.`),
    });
    for (const problem of problems) {
      containerEl.createEl("p", { cls: "setting-item-description", text: problem });
    }
  }

  /**
   * Recurring obligations and the calendar bridge (§5.7, §7 B3).
   *
   * Nothing here reaches a mailbox or a network. The calendar file is written
   * into the vault like any other export; pointing Outlook at it is a separate,
   * deliberate step the user takes once.
   */
  private eventsSection(containerEl: HTMLElement): void {
    const events = this.plugin.settings.events;
    containerEl.createEl("h3", { text: "Deadlines and obligations" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Reminders are in-app only \u2014 a status-bar badge, the Deadlines board and a " +
        "notice. No OS notification and no email: the work laptop can be relied on for " +
        "neither, and a reminder that silently fails to arrive is worse than one that " +
        "never promised to.",
    });

    new Setting(containerEl)
      .setName("Warn me this many days ahead")
      .setDesc(
        "Used when a note declares no lead_days of its own. Comma separated. An " +
          "obligation with no lead time stays silent until the day it falls due, which " +
          "for an IRB renewal is far too late to act on.",
      )
      .addText((text) =>
        text.setValue(events.leadDays.join(", ")).onChange(async (value) => {
          const parsed = [
            ...new Set(
              value
                .split(/[,\s]+/)
                .map((part) => Number.parseInt(part, 10))
                .filter((n) => Number.isInteger(n) && n >= 0 && n <= 3650),
            ),
          ].sort((a, b) => b - a);
          // An empty list would mean no warning ever fires for a note that
          // declares none. Ignore the keystroke rather than accept it.
          if (parsed.length === 0) return;
          this.plugin.settings.events.leadDays = parsed;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Say when something has lapsed")
      .setDesc(
        "Raise a notice on vault open for any obligation past its date. The badge and " +
          "the board are always there; this is the one that interrupts.",
      )
      .addToggle((toggle) =>
        toggle.setValue(events.notifyOnOpen).onChange(async (value) => {
          this.plugin.settings.events.notifyOnOpen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Recheck every")
      .setDesc("Minutes between recomputations while Obsidian is open. Five is the floor.")
      .addText((text) =>
        text.setValue(String(events.checkMinutes)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.events.checkMinutes = Math.min(1440, Math.max(5, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Calendar file")
      .setDesc(
        `Written to ${this.plugin.settings.folders.exports}/ and replaced each time, so a ` +
          "subscription picks up the new dates. Entries carry the note id, title, date and " +
          "the consequence the note states \u2014 never note content.",
      )
      .addText((text) =>
        text.setValue(events.calendarFile).onChange(async (value) => {
          const name = value.trim();
          if (name === "") return;
          this.plugin.settings.events.calendarFile = name;
          await this.plugin.saveSettings();
        }),
      );

    const schedule = this.plugin.eventSchedule();
    const summary = describeAlerts(schedule);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        schedule.length === 0
          ? `No event or obligation notes yet. One note in ${this.plugin.settings.folders.events}/ with a due date is enough to start.`
          : `Watching ${schedule.length} note${schedule.length === 1 ? "" : "s"}` +
            (summary === "" ? ", none of them pressing." : ` \u2014 ${summary}.`),
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
