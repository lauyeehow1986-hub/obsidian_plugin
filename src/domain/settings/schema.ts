/**
 * Settings schema. Pure — no Obsidian imports (CLAUDE.md §4).
 *
 * Every schema change bumps CURRENT_SETTINGS_VERSION and adds a migration step.
 * An upgrade must never lose settings (CLAUDE.md §10).
 */

import type { AttachmentPolicy } from "../comms/emlThread";
import type { OutlookFolder } from "../comms/outlook";
import type { TimerState } from "../effort/timer";

export const CURRENT_SETTINGS_VERSION = 15;

/** The three hats. Mode is the organising metaphor, not a cosmetic filter (§7 A3). */
export const MODES = ["biostat", "hod", "research-core"] as const;
export type Mode = (typeof MODES)[number];

export const FOLDER_KEYS = [
  "inbox",
  "requests",
  "projects",
  "studies",
  "people",
  "policies",
  "scripts",
  "events",
  "meetings",
  "correspondence",
  "time",
  "audit",
  "profile",
  "publications",
  "catalogue",
  "forms",
  "diagrams",
  "dashboards",
  "briefings",
  "apps",
  "runs",
  "exports",
  "config",
] as const;
export type FolderKey = (typeof FOLDER_KEYS)[number];

export interface ScdbSettings {
  schemaVersion: number;
  /** Recorded as `actor` in the audit ledger and effort log. */
  actor: string;
  mode: Mode;
  folders: Record<FolderKey, string>;
  /** Core Bases is a progressive enhancement; "auto" uses it when available. */
  bases: "auto" | "off";
  /**
   * Whether the boards narrow to the hat being worn (§7 A3).
   *
   * "all" is a real setting rather than a hidden debug switch: a filter that
   * cannot be turned off is a filter that hides an overdue request from you.
   */
  hatFilter: "mode" | "all";
  backup: BackupConfig;
  comms: CommsConfig;
  briefing: BriefingConfig;
  effort: EffortConfig;
  events: EventsConfig;
  publications: PublicationsConfig;
  apps: AppsConfig;
  compute: ComputeConfig;
  sources: SourcesConfig;
  outlook: OutlookConfig;
  launchers: LaunchersConfig;
  /** Unrecognised keys are preserved verbatim — see rule 8, never destroy data. */
  [extra: string]: unknown;
}

/**
 * Composing messages (§5.11) and ageing what was composed (§5.10).
 *
 * Nothing here sends anything or reaches a network. The plugin builds a URI and
 * hands it to the OS shell; the user presses send.
 */
export interface CommsConfig {
  /**
   * Longest URI we will hand to a protocol handler.
   *
   * Handlers truncate somewhere around 2,000 characters and the exact figure
   * varies by handler and Windows build — §11 lists measuring it on the target
   * machine as an open question. Over this, the draft goes to the clipboard
   * whole rather than being launched cut off.
   */
  uriCeiling: number;
  /** Days before unanswered outreach is worth chasing. */
  chaseDays: number;
  /** What the composer opens by default. Clipboard is always offered too. */
  channel: "email" | "teams" | "clipboard";
  /**
   * Your own mailboxes, for reading saved `.eml` files (§5.10, email Tier 1).
   *
   * Empty until you fill it in, and the importer **refuses** while it is —
   * which is deliberate. Direction is what `awaiting` is computed from, and
   * `awaiting` is the whole point of a correspondence note: get it backwards
   * and an unanswered chase-up reads as a closed loop. There is no heuristic
   * that can tell your mailbox from anyone else's, so the plugin asks rather
   * than guesses. List every address you receive on, work and any alias.
   */
  myAddresses: string[];
  /**
   * Which attachments an import saves into `_attachments/`.
   *
   * "attachments" — the files the sender actually attached. "all" adds the
   * images embedded in the message body, which on institutional mail means a
   * copy of the department crest for every message ever imported. "none" keeps
   * the text and names what was left behind.
   */
  emlAttachments: AttachmentPolicy;
  /** Attachments larger than this are named in the note and not copied in. */
  emlMaxAttachmentKb: number;
}

export interface BriefingConfig {
  /** Generate on the first vault open of the day. Off until you ask for it. */
  onOpen: boolean;
  /** `YYYY-MM-DD` of the last one written; empty means never. */
  lastDate: string;
  /** How far ahead the "coming up" section looks. */
  horizonDays: number;
}

/**
 * The effort timer and what it writes (§7 B2).
 *
 * The running timer lives here rather than in a file of its own because it has
 * to survive a crash, and `data.json` is already written on every settings
 * change. Persisting it is the whole crash-safety story: the alternative is a
 * timer that exists only in memory, which is the one place a crash reaches.
 */
export interface EffortConfig {
  /**
   * Minutes of silence before the timer asks what happened.
   *
   * What this actually detects is the machine sleeping or Obsidian not running
   * — a missed heartbeat — **not** the user staring out of the window. Real
   * user-idle detection needs Electron APIs a plugin cannot reach, and claiming
   * to measure attention would be a lie the numbers could not support.
   */
  idleMinutes: number;
  /** Pre-filled on new entries, so chargeback coding is not retyped daily. */
  costCentre: string;
  /** The running timer, or null. Never invented on load; see the migration. */
  timer: TimerState | null;
}

export function defaultEffort(): EffortConfig {
  return { idleMinutes: 10, costCentre: "", timer: null };
}

/**
 * Recurring obligations and the calendar bridge (§5.7, §7 B3).
 *
 * Nothing here reaches a network or a mailbox. The calendar file is written
 * inside the vault like every other export (rule 8); pointing Outlook at it is
 * the user's own, deliberate step.
 */
export interface EventsConfig {
  /**
   * Lead times used when a note declares no `lead_days` of its own.
   *
   * A default matters: §5.7 makes `consequence` required but not `lead_days`,
   * and an obligation with no lead time would sit silent until the day it fell
   * due — which for an IRB renewal is far too late to act on.
   */
  leadDays: number[];
  /** File name inside the exports folder. Overwritten so a subscription updates. */
  calendarFile: string;
  /**
   * Whether a lapsed obligation raises a notice on vault open.
   *
   * On by default, unlike everything else on a fresh install: this is the one
   * alarm §7 B3 says must outrank the rest of the UI, and a governance deadline
   * that only shows up if you go looking is not a reminder. It is in-app only —
   * a notice and a status-bar badge, never an OS notification or an email.
   */
  notifyOnOpen: boolean;
  /** Minutes between recomputations while Obsidian is open. */
  checkMinutes: number;
}

export function defaultEvents(): EventsConfig {
  return {
    leadDays: [30, 7, 1],
    calendarFile: "scdb-deadlines.ics",
    notifyOnOpen: true,
    checkMinutes: 60,
  };
}

export function defaultComms(): CommsConfig {
  return {
    uriCeiling: 1800,
    chaseDays: 7,
    channel: "email",
    // Nothing is enabled on first install (rule 3). An empty address list is
    // also what makes the `.eml` importer refuse until it is told who you are.
    myAddresses: [],
    emlAttachments: "attachments",
    emlMaxAttachmentKb: 10 * 1024,
  };
}

/**
 * The publications tracker (§5.4, §7 B5).
 *
 * Only the citation style is configurable. §5.4 asks for that explicitly and
 * for nothing else; how far ahead a decision counts as due, and which stages
 * belong on a CV, are properties of the data rather than preferences, and a
 * setting for each would be four ways for two people to disagree about what
 * "published" means.
 */
export interface PublicationsConfig {
  citationFormat: CitationFormatSetting;
}

/**
 * Duplicated rather than imported from `domain/publication/citation`.
 *
 * The settings schema is the one module every other one loads, and pointing it
 * at a feature module would make the whole publication engine a load-time
 * dependency of reading `data.json`. `repairPublications` in `migrate.ts` is
 * where the two are held to each other.
 */
export const CITATION_FORMAT_SETTINGS = ["vancouver", "apa"] as const;
export type CitationFormatSetting = (typeof CITATION_FORMAT_SETTINGS)[number];

export function defaultPublications(): PublicationsConfig {
  // §5.4 names Vancouver as the default.
  return { citationFormat: "vancouver" };
}

export function defaultBriefing(): BriefingConfig {
  // `onOpen` is false on a fresh install for the same reason nothing else is
  // enabled (rule 3): a plugin that writes a note into your vault the first
  // time you open it has made a decision that was yours to make.
  return { onOpen: false, lastDate: "", horizonDays: 60 };
}

/**
 * Encrypted snapshots (§7 A4).
 *
 * `destination` is empty until the user sets it, and every backup command
 * refuses until then. Guessing a folder would mean the plugin writing the whole
 * vault to a path nobody chose — the opposite of rule 3's "nothing is enabled
 * on first install", applied to the filesystem rather than the network.
 *
 * The passphrase is **not here and never will be**. It is asked for on every
 * operation and held only for the length of one call.
 */
export interface BackupConfig {
  /** Absolute path to a folder OUTSIDE the vault. Empty means not configured. */
  destination: string;
  /** How many snapshots to keep. Only files this plugin named are ever removed. */
  keep: number;
  /** Days before the status bar starts saying the backup is old. */
  intervalDays: number;
  /** ISO 8601 UTC of the last successful snapshot; empty means never. */
  lastAt: string;
  /** File name of the last snapshot, for the diagnostics report. No path. */
  lastName: string;
}

export function defaultBackup(): BackupConfig {
  return { destination: "", keep: 7, intervalDays: 7, lastAt: "", lastName: "" };
}

export const DEFAULT_FOLDERS: Record<FolderKey, string> = {
  inbox: "00 Inbox",
  requests: "10 Requests",
  projects: "15 Projects",
  studies: "20 Studies",
  people: "30 People",
  policies: "40 Policies",
  scripts: "50 Scripts",
  events: "60 Events",
  meetings: "70 Meetings",
  correspondence: "75 Correspondence",
  time: "80 Time",
  audit: "82 Audit",
  profile: "84 Profile",
  publications: "85 Publications",
  catalogue: "87 Catalogue",
  forms: "88 Forms",
  diagrams: "89 Diagrams",
  dashboards: "90 Dashboards",
  // B1's daily briefing has to land somewhere, and §5 names no folder for it.
  // Under Dashboards rather than beside them: a briefing is a dated record of
  // one morning, not a saved view, and a year of them would swamp the folder
  // the saved views live in.
  briefings: "90 Dashboards/Briefings",
  apps: "92 Apps",
  runs: "94 Runs",
  exports: "95 Exports",
  config: "_config",
};

/**
 * Vault apps (§5.13, §7 F3).
 *
 * `grants` is the record of what you agreed each app could reach. It lives in
 * settings rather than in the app's own note for the obvious reason: a consent
 * stored next to the thing it authorises is not a consent. Anyone who can edit
 * the note could edit the grant, which is exactly the attack §5.13's manifest
 * hash exists to make visible.
 *
 * There is deliberately no "trust all apps" switch. It would be one click, it
 * would be taken on a busy morning, and it would turn every later manifest
 * edit into something that happens silently.
 */
export interface AppsConfig {
  /** Keyed by the app's `id`. See `domain/apps/grant.ts`. */
  grants: Record<string, AppGrantSetting>;
  /**
   * How long the host waits for an app to answer a ping before offering to
   * tear it down (§5.13's watchdog).
   *
   * Configurable because the honest answer to "how long is too long" depends
   * on the machine: a locked-down laptop mid-antivirus-sweep is slow in ways a
   * dev machine never is, and a watchdog that fires on a healthy app is a
   * watchdog that gets turned off.
   */
  watchdogSeconds: number;
}

/** The stored shape of a grant. Mirrors `AppGrant` without importing it. */
export interface AppGrantSetting {
  hash: string;
  at: string;
  capabilities: { query: string[]; write: string; network: boolean };
}

export function defaultApps(): AppsConfig {
  return { grants: {}, watchdogSeconds: 10 };
}

/**
 * Running R and Python blocks (§5.12, §7 F1).
 *
 * **Both paths start empty, and that is the safe default rather than an
 * oversight.** §7 F1 is explicit that discovery never assumes `PATH`: on the
 * target machine the interpreters are a portable R build and a miniconda
 * environment, neither of which is on `PATH`, and a plugin that guessed would
 * either find nothing or find the wrong one. Empty means the Run action
 * explains what to fill in, which is the honest failure.
 *
 * Nothing here can be triggered by a note. Rule 12: a block runs on an
 * explicit action, after a dialog showing exactly what will run.
 */
export interface ComputeConfig {
  /** Absolute path to `Rscript`. Empty until you point at one. */
  rPath: string;
  /** Absolute path to `python`. Empty until you point at one. */
  pythonPath: string;
  /**
   * How much of its environment a Python run may see.
   *
   * "isolated" is §7 F1's `-I` and ships as the default. It also hides
   * anything installed with `pip install --user`, which on a machine that
   * installs that way means no matplotlib and therefore no plots — found by
   * running it here, not by reading the flag. "user-site" keeps the working
   * directory off `sys.path` and still ignores `PYTHONPATH`; it gives up only
   * the exclusion of the per-user site directory.
   */
  pythonIsolation: string;
  /** Seconds before a run is killed. Every run is out-of-process and killable. */
  timeoutSeconds: number;
  /** Per stream, in KB. A loop that prints would otherwise fill a note. */
  maxOutputKb: number;
  /**
   * Whether reading view offers a Run button under R and Python blocks.
   *
   * A button is an affordance, not an execution — nothing runs until it is
   * pressed and the dialog is confirmed. Off is for anyone who would rather
   * reach every run through the command palette.
   */
  showRunButtons: boolean;
}

export function defaultCompute(): ComputeConfig {
  return {
    rPath: "",
    pythonPath: "",
    pythonIsolation: "isolated",
    timeoutSeconds: 120,
    maxOutputKb: 64,
    showRunButtons: true,
  };
}

/**
 * External sources (§7 E1). **The only part of this plugin that reaches a
 * network, and it is off.**
 *
 * Rule 3 in three parts, and all three live here:
 *
 * - *"off unless that specific module is enabled"* — one switch per source, not
 *   one switch for "the internet". Turning PubMed on says nothing about
 *   ClinicalTrials.gov.
 * - *"targets an allowlisted host"* — **not represented here at all**, and its
 *   absence is the design. The hosts are a constant in `domain/sources/gateway`
 *   because a host the user can type is a host a note can suggest. Settings
 *   choose between sources that already exist; they cannot invent one.
 * - *"nothing is enabled on first install"* — `defaultSources()` returns every
 *   switch false.
 *
 * Nothing here makes a request. Every fetch is one explicit action with the
 * literal URL shown first (rule 4).
 */
export interface SourcesConfig {
  /** PubMed via NCBI E-utilities. */
  pubmed: boolean;
  /** ClinicalTrials.gov API v2. */
  ctgov: boolean;
  /**
   * The EACTS clinical practice guidelines feed, and the ESC sitemap.
   *
   * Separate switches rather than one "guidelines" switch, because they are
   * separate hosts and the point of a per-source switch is that turning one on
   * says nothing about the other. See `domain/sources/guidelines` for why the
   * other two societies the user named are not here.
   */
  eacts: boolean;
  esc: boolean;
  /**
   * An address sent to NCBI so they can contact whoever is overloading them,
   * which their usage policy asks for.
   *
   * **Empty unless the user types one in, and never filled in from anywhere
   * the plugin happens to know an address.** It is the one field in this whole
   * schema whose value leaves the machine, so it is the user's to give.
   */
  contactEmail: string;
  /** How long a request may take before it is abandoned. */
  timeoutSeconds: number;
  /** Results asked for per search. Capped again in `domain/sources/gateway`. */
  maxResults: number;
}

export function defaultSources(): SourcesConfig {
  return {
    pubmed: false,
    ctgov: false,
    eacts: false,
    esc: false,
    contactEmail: "",
    timeoutSeconds: 20,
    maxResults: 20,
  };
}

/**
 * Reading the live Outlook session (§5.10 Tier 2, §7 E2).
 *
 * **Off, and it stays off until the user turns it on** — the same stance every
 * other module that reaches outside the vault takes, for the same reason.
 * Nothing here touches a network; what it touches is a mailbox, which on this
 * project is the more sensitive of the two.
 */
export interface OutlookConfig {
  /** Nothing runs while this is false. Not set by any migration, ever. */
  enabled: boolean;
  /** Which default folders are read. Empty means nothing is read. */
  folders: OutlookFolder[];
  /** How far back a sync looks. Days, from midnight local. */
  sinceDays: number;
  /** Hard cap on messages one sync will bring back. */
  maxMessages: number;
  /**
   * How long Outlook gets to answer before the reader is killed.
   *
   * §7 E2's hard requirement. Outlook COM blocks for minutes behind a modal
   * dialog, so this is not a nicety — it is what keeps Obsidian responsive
   * when Outlook is sitting on a password prompt nobody has noticed.
   */
  timeoutSeconds: number;
  /**
   * When the last sync completed, as an ISO minute. Written by the sync.
   *
   * Advisory only: the window is what bounds a read, and dedupe is on
   * `message_id`. This exists so the settings tab and the diagnostics report
   * can say when the mailbox was last looked at.
   */
  lastSynced: string;
}

/**
 * Opening the systems and documents beside the vault (§5.16, §7 B9).
 *
 * There is deliberately very little here. *What* may be opened lives in
 * `_config/launchers.yaml`, in the vault, where it is readable and diffable
 * and survives the plugin being uninstalled — a settings blob would put the
 * allowlist somewhere a human cannot review. These two switches are the only
 * decisions that are not about a particular target.
 */
export interface LaunchersConfig {
  /**
   * Off until asked for, like everything else that reaches outside the vault.
   *
   * An absent config file already offers nothing, so this exists for the other
   * case: a config that is written and working, switched off for a while
   * without deleting it.
   */
  enabled: boolean;
  /**
   * Show the resolved destination and wait for a press before opening.
   *
   * On by default and separately settable, because §5.16 rule 7 is about
   * *seeing* what will open, and someone who opens the same SOP forty times a
   * day will otherwise learn to dismiss the dialog without reading it — which
   * is worse than not having it. Turning it off is a real choice, and the
   * ledger row is written either way.
   */
  confirmBeforeOpening: boolean;
}

export function defaultLaunchers(): LaunchersConfig {
  return { enabled: false, confirmBeforeOpening: true };
}

export function defaultOutlook(): OutlookConfig {
  return {
    enabled: false,
    folders: ["inbox", "sent"],
    sinceDays: 14,
    maxMessages: 200,
    timeoutSeconds: 60,
    lastSynced: "",
  };
}

export function defaultSettings(): ScdbSettings {
  return {
    schemaVersion: CURRENT_SETTINGS_VERSION,
    actor: "",
    mode: "hod",
    folders: { ...DEFAULT_FOLDERS },
    bases: "auto",
    hatFilter: "mode",
    backup: defaultBackup(),
    comms: defaultComms(),
    briefing: defaultBriefing(),
    effort: defaultEffort(),
    events: defaultEvents(),
    publications: defaultPublications(),
    apps: defaultApps(),
    compute: defaultCompute(),
    sources: defaultSources(),
    outlook: defaultOutlook(),
    launchers: defaultLaunchers(),
  };
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}
