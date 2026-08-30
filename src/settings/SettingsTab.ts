import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { backupAge } from "../domain/backup/snapshots.js";
import type { AttachmentPolicy } from "../domain/comms/emlThread.js";
import { OUTLOOK_FOLDERS, type OutlookFolder } from "../domain/comms/outlook.js";
import { describeAlerts } from "../domain/events/schedule.js";
import { allModes, modeInfo } from "../domain/settings/mode.js";
import {
  CITATION_FORMAT_SETTINGS,
  MODES,
  type CitationFormatSetting,
} from "../domain/settings/schema.js";
import { buildMailto, buildTeamsChat, MIN_URI_CEILING } from "../domain/comms/uri.js";
import { probeHandler, reportLaunch } from "../services/protocol.js";
import { probeOutlook } from "../services/outlookBridge.js";
import { OutlookScriptModal } from "../ui/OutlookScriptModal.js";
import { LANGUAGE_LABELS, type RunLanguage } from "../domain/compute/block.js";
import {
  DECLINED_NOTE,
  MAX_RESULTS,
  SOURCES,
  SOURCE_IDS,
} from "../domain/sources/gateway.js";
import { DECLINED_SOURCES } from "../domain/sources/guidelines.js";
import {
  interpreterLabel,
  isPythonIsolation,
  ISOLATION_LABELS,
  PYTHON_ISOLATION,
} from "../domain/compute/harness.js";
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
    this.outlookSection(containerEl);
    this.briefingSection(containerEl);
    this.effortSection(containerEl);
    this.publicationsSection(containerEl);
    this.reportsSection(containerEl);
    this.eventsSection(containerEl);
    this.appsSection(containerEl);
    this.computeSection(containerEl);
    this.sourcesSection(containerEl);
    this.launchersSection(containerEl);
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
        "files that are already here. Both formats are read: new Outlook and the web app " +
        "save .eml, classic Outlook saves .msg.",
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

  /**
   * Reading the running Outlook (§5.10 Tier 2, §7 E2).
   *
   * The screen's job is to make three things unmissable before the switch is
   * flipped: it reads a mailbox, it never starts Outlook, and it changes
   * nothing in Outlook. A person turning this on is granting a plugin sight of
   * their mail, and a one-line toggle label is not enough to grant that on.
   */
  private outlookSection(containerEl: HTMLElement): void {
    const outlook = this.plugin.settings.outlook;
    containerEl.createEl("h3", { text: "Reading Outlook directly" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Reads new mail out of the Outlook you already have open, so threads fill " +
        "themselves in without dragging files about. There are no credentials, no API and " +
        "nothing over a network — it talks to the copy of Outlook running on this machine. " +
        "It never starts Outlook, never sends, moves, deletes or marks anything as read, " +
        "and it always shows you every message before a single note is written. " +
        "Attachments stay in the mailbox; drag a message into the vault when you need one.",
    });

    new Setting(containerEl)
      .setName("Read the running Outlook")
      .setDesc(
        "Off until you turn it on, and nothing runs on its own even then — only when you " +
          "run the command yourself. Needs classic Outlook: the new Outlook and the web " +
          "app cannot be read this way.",
      )
      .addToggle((toggle) =>
        toggle.setValue(outlook.enabled).onChange(async (value) => {
          this.plugin.settings.outlook.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    // Offered whether or not the reader is switched on: §11's whole point is
    // that the target machine answers this in ten seconds rather than being
    // guessed at from here, and someone deciding whether to enable it at all
    // should be able to find out first. It reads no mail — it asks Outlook its
    // version and lets go.
    new Setting(containerEl)
      .setName("Check this machine")
      .setDesc(
        "Asks the running Outlook for its version and nothing else. No folder is opened and " +
          "no message is read. Tells you in one press whether reading directly can work here.",
      )
      .addButton((button) =>
        button.setButtonText("Check Outlook").onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Checking…");
          try {
            const probe = await probeOutlook();
            new Notice(`SCDB: ${probe.detail}`, 12000);
          } finally {
            button.setDisabled(false);
            button.setButtonText("Check Outlook");
          }
        }),
      );

    new Setting(containerEl)
      .setName("Show what runs")
      .setDesc(
        "The exact PowerShell this plugin would start, in full, with nothing hidden. Reads no " +
          "mail. If your machine flags Obsidian for starting PowerShell, this is the answer to " +
          "the question — copy it and hand it over.",
      )
      .addButton((button) =>
        button.setButtonText("Show what runs").onClick(() => {
          new OutlookScriptModal(this.app).open();
        }),
      );

    if (!outlook.enabled) return;

    new Setting(containerEl)
      .setName("Folders")
      .setDesc(
        "Sent Items matters as much as the Inbox: a thread you are waiting on is only " +
          "visibly unanswered if the plugin can see that you wrote.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "inbox,sent": "Inbox and Sent Items",
            inbox: "Inbox only",
            sent: "Sent Items only",
          })
          .setValue(outlook.folders.join(","))
          .onChange(async (value) => {
            this.plugin.settings.outlook.folders = value
              .split(",")
              .filter((entry): entry is OutlookFolder =>
                (OUTLOOK_FOLDERS as readonly string[]).includes(entry),
              );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("How far back to look")
      .setDesc(
        "In days, counted from midnight. Messages already on a thread are skipped however " +
          "far back you reach, so a wide window costs time rather than duplicates.",
      )
      .addText((text) =>
        text.setValue(String(outlook.sinceDays)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.outlook.sinceDays = Math.min(365, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Most messages to read at once")
      .setDesc("A ceiling, so a quiet fortnight and a busy one take a similar amount of time.")
      .addText((text) =>
        text.setValue(String(outlook.maxMessages)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.outlook.maxMessages = Math.min(2000, Math.max(1, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Give up after")
      .setDesc(
        "In seconds. Outlook can stop answering for minutes at a time when it is showing a " +
          "dialog behind another window, so the reader is a separate process and is stopped " +
          "when it runs out of time. This is what keeps Obsidian responsive; raise it only " +
          "if a genuinely large mailbox needs longer.",
      )
      .addText((text) =>
        text.setValue(String(outlook.timeoutSeconds)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;
          this.plugin.settings.outlook.timeoutSeconds = Math.min(600, Math.max(5, parsed));
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Last read")
      .setDesc(
        outlook.lastSynced === ""
          ? "Outlook has not been read yet."
          : `Outlook was last read at ${outlook.lastSynced}. Every read is in the audit ledger.`,
      )
      .addButton((button) =>
        button.setButtonText("Read Outlook now").onClick(() => {
          void this.plugin.syncOutlook();
        }),
      );
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
   * Publications (§5.4, §7 B5).
   *
   * One setting, which is the whole point: §5.4 asks for a configurable
   * citation format and for nothing else to be a preference.
   */
  private publicationsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Publications" });

    new Setting(containerEl)
      .setName("Citation format")
      .setDesc(
        "Used by the publication list and the copy commands. The list itself can be " +
          "switched per view; this is what it opens as.",
      )
      .addDropdown((dropdown) => {
        for (const format of CITATION_FORMAT_SETTINGS) {
          dropdown.addOption(format, format === "vancouver" ? "Vancouver" : "APA");
        }
        dropdown
          .setValue(this.plugin.settings.publications.citationFormat)
          .onChange(async (value) => {
            if (!(CITATION_FORMAT_SETTINGS as readonly string[]).includes(value)) return;
            this.plugin.settings.publications.citationFormat =
              value as CitationFormatSetting;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Author names are split into surname and initials from what the note writes " +
        "(“Dr A Tan” becomes “Tan A”). Where that split is a guess — a name " +
        "written out in full, or a single word — the list says so rather than " +
        "renaming a collaborator silently.",
    });
  }

  /**
   * Vault apps (§5.13, §7 F3).
   *
   * The one screen that answers "what have I allowed to run against my notes",
   * which is a question you cannot answer by reading the app notes themselves
   * — a manifest says what an app *asks* for, and this says what it was
   * *given*. Withdrawing is here rather than only on the board because the
   * moment you want to revoke something is rarely the moment you are browsing
   * apps.
   */
  private appsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Vault apps" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "An app runs in a sandbox with no access to the vault, the filesystem or the network. " +
        "Everything it reads comes back through the plugin, and only the note types you allowed. " +
        "It can never change a note by itself: it proposes, you confirm.",
    });

    const grants = Object.entries(this.plugin.settings.apps.grants);
    if (grants.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No app is allowed to run. Nothing is granted on install, and nothing grants itself.",
      });
    } else {
      for (const [id, grant] of grants.sort((a, b) => a[0].localeCompare(b[0]))) {
        const types = grant.capabilities.query;
        new Setting(containerEl)
          .setName(id)
          .setDesc(
            [
              types.length === 0 ? "Reads nothing" : `Reads ${types.join(", ")}`,
              grant.capabilities.write === "propose"
                ? "may propose changes you confirm"
                : "cannot write",
              grant.at === "" ? "" : `allowed ${grant.at}`,
            ]
              .filter((part) => part !== "")
              .join(" · "),
          )
          .addButton((button) =>
            button
              .setButtonText("Withdraw")
              .setTooltip("The app will ask again before it next runs.")
              .onClick(async () => {
                await this.plugin.withdrawGrant(id);
                this.display();
              }),
          );
      }
    }

    new Setting(containerEl)
      .setName("Wait before reporting an app as stuck")
      .setDesc(
        "Seconds of silence before the plugin offers to close a running app. A watchdog that " +
          "fires on a healthy app is a watchdog you turn off, so this is longer than it looks " +
          "like it needs to be. It detects an app that has stopped answering; it cannot rescue " +
          "one that is holding the whole window.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.apps.watchdogSeconds))
          .onChange(async (value) => {
            const seconds = Number.parseInt(value, 10);
            if (!Number.isFinite(seconds)) return;
            this.plugin.settings.apps.watchdogSeconds = Math.min(120, Math.max(2, seconds));
            await this.plugin.saveSettings();
          }),
      );
  }


  /**
   * External sources (§7 E1). **The only screen in this plugin that can let
   * anything reach a network.**
   *
   * What is deliberately absent is a host field. Rule 3 says every request
   * "targets an allowlisted host", and an allowlist the user can add to is not
   * one — a colleague, a circular or a note could talk somebody into pasting an
   * address in. The hosts are a constant in the source; these switches only
   * choose between sources that already exist.
   *
   * Each source is its own switch, because "the internet" is not a permission
   * anyone can reason about.
   */
  private sourcesSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "External sources" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Everything else in this plugin works with the network cable pulled, and this is the " +
        "one exception. Off until you switch a source on, read-only, and never automatic: " +
        "every request is one action that first shows you the exact address it would ask for. " +
        "Each one is recorded in the audit ledger, whether it succeeds or not.",
    });

    for (const id of SOURCE_IDS) {
      const spec = SOURCES[id];
      new Setting(containerEl)
        .setName(spec.label)
        .setDesc(`Read-only searches against ${spec.host} (${spec.operator}).`)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.sources[id] === true).onChange(async (value) => {
            this.plugin.settings.sources[id] = value;
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Contact address for NCBI")
      .setDesc(
        "Optional, and the only value in these settings that leaves the machine. NCBI ask " +
          "callers to identify themselves so they can get in touch about heavy use; without " +
          "one they simply apply a lower rate limit. Left empty unless you type one — it is " +
          "never taken from anywhere else.",
      )
      .addText((text) =>
        text
          .setPlaceholder("you@example.org")
          .setValue(this.plugin.settings.sources.contactEmail)
          .onChange(async (value) => {
            this.plugin.settings.sources.contactEmail = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Results per search")
      .setDesc(`How many records to ask for. At most ${MAX_RESULTS}.`)
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.sources.maxResults))
          .onChange(async (value) => {
            const count = Number(value);
            if (!Number.isFinite(count)) return;
            this.plugin.settings.sources.maxResults = Math.min(
              MAX_RESULTS,
              Math.max(1, Math.round(count)),
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Timeout")
      .setDesc("Seconds to wait for a reply before giving up.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.sources.timeoutSeconds))
          .onChange(async (value) => {
            const seconds = Number(value);
            if (!Number.isFinite(seconds)) return;
            this.plugin.settings.sources.timeoutSeconds = Math.min(
              120,
              Math.max(5, Math.round(seconds)),
            );
            await this.plugin.saveSettings();
          }),
      );

    // The two societies that were asked for and cannot be delivered. Named
    // here rather than left out: the user asked for four by name, and a screen
    // showing two would read as the feature simply working.
    containerEl.createEl("h4", { text: "Not available, and why" });
    containerEl.createEl("p", { cls: "setting-item-description", text: DECLINED_NOTE });
    const list = containerEl.createEl("ul", { cls: "setting-item-description" });
    for (const declined of DECLINED_SOURCES) {
      const item = list.createEl("li");
      item.createEl("strong", { text: `${declined.society}. ` });
      item.appendText(declined.why);
    }
  }

  /** Report templates (§7 B7). Nothing to configure until you want to edit one. */
  /**
   * Running R and Python blocks (§7 F1).
   *
   * The "test interpreter" button is the whole reason this screen is worth
   * more than two text fields. §7 F1 asks for it by name, and running it on
   * this machine showed why: the default isolation found Python 3.14 and *no*
   * matplotlib, because the packages were installed with `pip install --user`
   * and `-I` excludes that directory. Without a probe that reports packages as
   * well as a version, that is a green tick followed by a failed plot and no
   * hint connecting the two.
   */
  private computeSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Running code" });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Runs an R or Python block from a note, out of process, in a temporary folder outside " +
        "the vault, and writes a provenance record naming the interpreter, a hash of the code " +
        "that ran and the data version. Nothing runs on its own: a block runs when you press " +
        "Run and confirm a dialog showing the code.",
    });

    this.interpreterSetting(containerEl, "r");
    this.interpreterSetting(containerEl, "python");

    new Setting(containerEl)
      .setName("Python isolation")
      .setDesc(
        "Isolated (-I) is the hardened default: the working directory stays off sys.path and " +
          "PYTHONPATH is ignored. It also hides anything installed with “pip install --user”, " +
          "which on some machines means no matplotlib and therefore no plots. The second option " +
          "keeps both of those defences and gives up only that exclusion.",
      )
      .addDropdown((dropdown) => {
        for (const option of PYTHON_ISOLATION) dropdown.addOption(option, ISOLATION_LABELS[option]);
        dropdown
          .setValue(
            isPythonIsolation(this.plugin.settings.compute.pythonIsolation)
              ? this.plugin.settings.compute.pythonIsolation
              : "isolated",
          )
          .onChange(async (value) => {
            this.plugin.settings.compute.pythonIsolation = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Timeout")
      .setDesc("Seconds before a run is killed. Every run is killable from the dialog too.")
      .addText((text) =>
        text
          .setPlaceholder("120")
          .setValue(String(this.plugin.settings.compute.timeoutSeconds))
          .onChange(async (value) => {
            const seconds = Number(value);
            if (!Number.isFinite(seconds)) return;
            this.plugin.settings.compute.timeoutSeconds = Math.min(3600, Math.max(5, Math.round(seconds)));
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Keep at most")
      .setDesc(
        "KB of output per stream. Past this the middle is dropped and the note says so — a " +
          "loop that prints would otherwise fill the note, the index and every export of it.",
      )
      .addText((text) =>
        text
          .setPlaceholder("64")
          .setValue(String(this.plugin.settings.compute.maxOutputKb))
          .onChange(async (value) => {
            const kb = Number(value);
            if (!Number.isFinite(kb)) return;
            this.plugin.settings.compute.maxOutputKb = Math.min(4096, Math.max(1, Math.round(kb)));
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show a Run button on code blocks")
      .setDesc(
        "In reading view, under R and Python blocks. A button is an affordance, not an " +
          "execution — it opens the dialog. Turn it off to reach every run through the palette.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.compute.showRunButtons).onChange(async (value) => {
          this.plugin.settings.compute.showRunButtons = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  private interpreterSetting(containerEl: HTMLElement, language: RunLanguage): void {
    const key = language === "r" ? "rPath" : "pythonPath";
    const name = LANGUAGE_LABELS[language];
    const example =
      language === "r"
        ? "C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe"
        : "C:\\Users\\you\\miniconda3\\envs\\scdb\\python.exe";

    const setting = new Setting(containerEl)
      .setName(`${name} interpreter`)
      .setDesc(
        `Full path to the executable. Not a bare command: the target machine has neither ` +
          `interpreter on PATH, so “${language === "r" ? "Rscript" : "python"}” would work here ` +
          `and fail there.`,
      )
      .addText((text) =>
        text
          .setPlaceholder(example)
          .setValue(this.plugin.settings.compute[key])
          .onChange(async (value) => {
            this.plugin.settings.compute[key] = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    const report = containerEl.createEl("p", { cls: "setting-item-description scdb-probe" });

    setting.addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        report.setText("Asking…");
        const { reading, error } = await this.plugin.compute.probe(language);
        if (error !== "") {
          report.setText(`${name}: ${error}`);
          return;
        }
        const packages =
          language === "python"
            ? reading.packages.length === 0
              ? " · no matplotlib, pandas or numpy visible — plots will not work"
              : ` · ${reading.packages.join(", ")}`
            : "";
        report.setText(`${interpreterLabel(language, reading)}${packages}`);
      }),
    );
  }

  private reportsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Reports" });

    const folder = this.plugin.reportTemplates.folder();
    const problems = this.plugin.reportTemplates.problems();

    new Setting(containerEl)
      .setName("Report templates")
      .setDesc(
        `${this.plugin.reportTemplates.all().length} available. Five ship with the plugin; ` +
          `a file in ${folder} replaces the built-in with the same id, or adds a new one. ` +
          "Existing files are never overwritten.",
      )
      .addButton((button) =>
        button.setButtonText("Write the built-in templates").onClick(async () => {
          await this.plugin.writeReportTemplates();
          this.display();
        }),
      );

    if (problems.length > 0) {
      // Surfaced here as well as in the diagnostics report, because this is
      // where somebody lands after editing a template and wondering why
      // nothing changed.
      const list = containerEl.createEl("ul", { cls: "setting-item-description" });
      for (const entry of problems) {
        list.createEl("li", { text: `${entry.path}: ${entry.problem}` });
      }
    }

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The CV and the research profile are queries over 84 Profile/ and 85 Publications/ — " +
        "add a note per grant, role, course, trainee, talk and award and they stay current " +
        "by themselves. Which sections a CV carries, and in what order, is the `cv` template.",
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
  /**
   * Opening the systems and documents beside the vault (§5.16, §7 B9).
   *
   * The two switches live here; **what** may be opened does not. That list is
   * `_config/launchers.yaml` in the vault, where it is readable, diffable and
   * survives uninstalling the plugin — an allowlist buried in a settings blob
   * is one nobody reviews. What this section adds is the part settings is
   * actually good at: saying whether the file was understood, and naming every
   * line of it that was not.
   */
  private launchersSection(containerEl: HTMLElement): void {
    const launchers = this.plugin.settings.launchers;
    containerEl.createEl("h3", { text: "Opening things outside the vault" });

    new Setting(containerEl)
      .setName("Allow opening external systems and documents")
      .setDesc(
        "Adds \u201cOpen this note externally\u201d, which opens the record a note is about \u2014 " +
          "the request in its portal, a document on a share, or the folder it lives in. " +
          "Destinations come only from the config file, never from note text, and " +
          "executables never open. Off until you switch it on.",
      )
      .addToggle((toggle) =>
        toggle.setValue(launchers.enabled).onChange(async (value) => {
          this.plugin.settings.launchers.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (!launchers.enabled) return;

    new Setting(containerEl)
      .setName("Show the destination before opening")
      .setDesc(
        "Shows the resolved path or URL and waits for a press. Worth keeping on: a " +
          "resolved path is often not the one written in the note, and that difference is " +
          "exactly what is worth seeing. Either way the ledger records what happened.",
      )
      .addToggle((toggle) =>
        toggle.setValue(launchers.confirmBeforeOpening).onChange(async (value) => {
          this.plugin.settings.launchers.confirmBeforeOpening = value;
          await this.plugin.saveSettings();
        }),
      );

    const path = this.plugin.launcherStore.path();
    const targets = this.plugin.launcherStore.all();
    const problems = this.plugin.launcherStore.allProblems();

    new Setting(containerEl)
      .setName("Launch targets")
      .setDesc(
        targets.length === 0
          ? `Nothing is configured. Targets live in ${path}.`
          : `${String(targets.length)} target${targets.length === 1 ? "" : "s"} from ${path}: ` +
            targets.map((t) => `${t.label} (${t.kind})`).join(", "),
      )
      .addButton((button) =>
        button
          .setButtonText(targets.length === 0 ? "Create a starter file" : "Reload")
          .onClick(async () => {
            if (targets.length === 0) await this.writeStarterLaunchers(path);
            await this.plugin.launcherStore.reload();
            this.display();
          }),
      );

    // Problems are surfaced, never swallowed: a target that quietly stopped
    // offering itself is a bug the user would otherwise diagnose by guessing.
    for (const problem of problems) {
      containerEl.createEl("p", {
        cls: "setting-item-description scdb-settings__problem",
        text: `${problem.severity === "error" ? "Error" : "Warning"} in ${problem.at}: ${problem.message}`,
      });
    }
  }

  /**
   * Write a commented example, so the first target is an edit rather than a
   * blank page. Never overwrites: rule 8, and this file is an allowlist.
   */
  private async writeStarterLaunchers(path: string): Promise<void> {
    if (this.app.vault.getFileByPath(path) !== null) {
      new Notice(`SCDB: ${path} already exists and was left alone.`, 6000);
      return;
    }
    const folder = path.slice(0, path.lastIndexOf("/"));
    if (this.app.vault.getFolderByPath(folder) === null) {
      await this.app.vault.createFolder(folder);
    }
    await this.app.vault.create(path, STARTER_LAUNCHERS);
    new Notice(`SCDB: wrote ${path}. Edit it to point at your own systems.`, 6000);
  }

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

/**
 * The example written by "Create a starter file".
 *
 * Every entry is commented out. A launcher config that worked on first write
 * would be one nobody read, and the whole safety argument here rests on a
 * person having chosen each destination deliberately.
 */
const STARTER_LAUNCHERS = `# What this plugin may open outside the vault (CLAUDE.md 5.16).
#
# Nothing here is active until you uncomment it and put your own values in.
# The destination always comes from this file. A note supplies at most one
# field, and only if it matches the pattern you set.
#
# targets:
#   - id: edata
#     label: Open in eData
#     kind: url
#     applies_to: scdb-request
#     template: "https://edata.example.org/request/{external_ref}"
#     field: external_ref
#     pattern: "^[A-Za-z0-9-]{3,40}$"
#
#   - id: sop-library
#     label: Open SOP
#     kind: file
#     root: 'C:\\SOPs'
#     field: artefact_path        # a path relative to root, from the note
#     extensions: [pdf, docx]     # executables are refused whatever is listed
#
#   - id: sop-folder
#     label: Reveal the SOP folder
#     kind: folder                # opens the file manager; runs nothing
#     root: 'C:\\SOPs'
`;
