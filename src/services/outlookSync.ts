/**
 * Populating correspondence threads from the running Outlook (§5.10 Tier 2,
 * §7 E2).
 *
 * The seam between the reader and the vault. It owns three things and delegates
 * everything else: **when a read is allowed**, **what the ledger records**, and
 * **turning COM records into the messages the import pipeline already
 * understands**. Threading, deduplication, the review dialog and note writing
 * are `EmlImport`'s, unchanged — §12 says extend an existing module rather than
 * building a parallel one, and a second implementation of a thread key would be
 * a second set of threads.
 *
 * ## Why the read is logged separately from the write
 *
 * `EmlImport.apply` logs a `bulk-edit` for the notes it writes. That is not
 * enough here. A sync that finds nothing new writes nothing, and would then
 * leave no trace of the plugin having read a mailbox at all — the silence rule
 * 9 exists to forbid. So a completed read appends `mailbox-read` whether or not
 * a single message survives to be imported, carrying counts and folder names
 * and nothing else (rule 7): no subject, no address, no body.
 *
 * A read that never reached a mailbox — Outlook not running, PowerShell absent
 * — is reported to the caller and **not** logged, on the same reasoning E1
 * applies to a request that never opened a socket. The ledger answers "what has
 * this plugin read", and an attempt that read nothing is not an answer to it.
 *
 * ## What it will not do
 *
 * Everything §5.10's Tier 1 refuses, for the same reasons, plus one more: a
 * synced message never causes anything to happen (rule 5). It does not advance
 * a stage, satisfy a gate, write an evidence record or touch a request note.
 * Mail is the untrusted text this system was built to ingest, and arriving
 * through COM rather than off the disk does not make it less so.
 */

import type { AuditLog } from "./auditLog";
import type { EmlImport, EmlPreview, ReadyMessage, ThreadAction } from "./emlImport";
import { readOutlook, type BridgeRun } from "./outlookBridge";
import {
  attachmentNotes,
  isMailClass,
  outlookItemToMessage,
  OUTLOOK_FOLDER_LABELS,
  type OutlookFolder,
  type OutlookItem,
} from "../domain/comms/outlook";
import { toVaultMinute } from "../domain/time/dates";

export interface OutlookSyncDeps {
  imports: EmlImport;
  audit: AuditLog;
  settings: () => {
    enabled: boolean;
    folders: readonly OutlookFolder[];
    sinceDays: number;
    maxMessages: number;
    timeoutSeconds: number;
  };
  actor: () => string;
  /** Persists `lastSynced`. Called only after a read that actually happened. */
  recordSync: (isoMinute: string) => Promise<void>;
}

export interface SyncPreview {
  preview: EmlPreview;
  /** Items Outlook offered, before dedupe and before the review. */
  offered: number;
  /** Items that were not mail — meeting requests, reports, calendar entries. */
  notMail: number;
  scanned: number;
  elapsedMs: number;
  outlookVersion: string;
  folders: string[];
  since: Date;
}

export type SyncOutcome = SyncPreview | { why: string };

/** Midnight, `days` ago, local. A window a person can state out loud. */
export function windowStart(now: Date, days: number): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - Math.max(0, Math.floor(days)) + 1);
  return start;
}

export class OutlookSync {
  constructor(private readonly deps: OutlookSyncDeps) {}

  enabled(): boolean {
    return this.deps.settings().enabled;
  }

  /**
   * Read the mailbox and work out what would happen. Writes no notes.
   *
   * The one write it does make is `lastSynced`, and only after a read that
   * reached a mailbox — so "last read at" means what it says even when the user
   * closes the review without importing anything.
   */
  async preview(now = new Date()): Promise<SyncOutcome> {
    const config = this.deps.settings();

    if (!config.enabled) {
      return {
        why:
          "Reading Outlook is switched off. Turn it on in SCDB Cockpit settings first — it reads " +
          "the Outlook session you already have open, and never starts one.",
      };
    }
    if (config.folders.length === 0) {
      return { why: "No Outlook folder is selected, so there is nothing to read." };
    }
    if (!this.deps.imports.canDetermineDirection()) {
      // The same refusal Tier 1 makes, for the same reason: `awaiting` is the
      // point of a correspondence note and a guessed direction inverts it.
      return {
        why:
          "Add your own email addresses in SCDB Cockpit settings first. Without them the plugin " +
          "cannot tell a message you sent from one you received, and that decides who a thread " +
          "is waiting on.",
      };
    }

    const since = windowStart(now, config.sinceDays);
    const run: BridgeRun = await readOutlook({
      folders: config.folders,
      since,
      max: config.maxMessages,
      timeoutMs: config.timeoutSeconds * 1000,
    });

    if ("why" in run.outcome) {
      // A timeout means Outlook was reached and then stopped answering, so a
      // read was genuinely in flight and the ledger says so. Everything else
      // never got as far as a mailbox.
      if (run.timedOut) {
        await this.log(
          `read of ${labels(config.folders)} stopped after ${Math.round(run.elapsedMs / 1000)}s with no reply`,
        );
      }
      return { why: run.outcome.why };
    }

    const report = run.outcome;
    const mail = report.items.filter((item) => isMailClass(item.messageClass));
    const notMail = report.items.length - mail.length + report.skipped;

    const sources = mail.map((item) => toReady(item, since));
    const preview = this.deps.imports.previewMessages(sources);
    preview.problems.push(...report.problems);

    // Counts, folder names, timing and Outlook's version — no subject, no
    // address, no body (rule 7). The version is here on purpose: this feature
    // is verified on a machine nobody developing it can see, and "which
    // Outlook was it" is the first question any report of odd behaviour needs
    // answered. It is a build number, not content.
    await this.log(
      `read ${labels(config.folders)} back to ${dateOnly(since)}: ` +
        `${report.scanned} item${report.scanned === 1 ? "" : "s"} looked at, ` +
        `${mail.length} message${mail.length === 1 ? "" : "s"} offered, ` +
        `${preview.duplicates} already recorded, in ${(run.elapsedMs / 1000).toFixed(1)}s` +
        `${report.outlookVersion === "" ? "" : ` (Outlook ${report.outlookVersion})`}`,
    );
    await this.deps.recordSync(toVaultMinute(Date.now()));

    return {
      preview,
      offered: mail.length,
      notMail,
      scanned: report.scanned,
      elapsedMs: run.elapsedMs,
      outlookVersion: report.outlookVersion,
      folders: config.folders.map((folder) => OUTLOOK_FOLDER_LABELS[folder]),
      since,
    };
  }

  /** Write the approved threads. The pipeline is Tier 1's, entire. */
  apply(actions: readonly ThreadAction[]) {
    return this.deps.imports.apply(actions, "sync");
  }

  private async log(detail: string): Promise<void> {
    const actor = this.deps.actor().trim();
    await this.deps.audit.append([
      {
        ts: toVaultMinute(Date.now()),
        // An unset actor is recorded as unknown rather than blocking a read
        // that has already happened — refusing here would leave the mailbox
        // read with no row at all, which is the worse failure.
        actor: actor === "" ? "unknown" : actor,
        action: "mailbox-read",
        subject: "outlook",
        detail,
      },
    ]);
  }
}

/** One COM record as the import pipeline's input. */
function toReady(item: OutlookItem, fallback: Date): ReadyMessage {
  const label = item.folder === "" ? "Outlook" : `Outlook · ${item.folder}`;
  return {
    message: outlookItemToMessage(item),
    sourcePath: `${label} · ${item.entryId.slice(0, 12)}`,
    label,
    fallbackAt: fallback.getTime(),
    skipped: attachmentNotes(item),
  };
}

/**
 * One line naming what the read actually did, for the review dialog.
 *
 * Every number here is a count or a version — nothing from a message. It
 * exists because this feature is used on a machine with no console: when
 * something looks wrong, this is the sentence a person can repeat back, and
 * it is the difference between a bug that can be described and one that
 * cannot.
 */
export function readSummary(result: SyncPreview): string {
  const parts = [
    `${result.scanned} item${result.scanned === 1 ? "" : "s"} looked at in ${result.folders.join(" and ")}`,
    `${result.offered} message${result.offered === 1 ? "" : "s"} offered`,
  ];
  if (result.notMail > 0) parts.push(`${result.notMail} not mail`);
  parts.push(`${(result.elapsedMs / 1000).toFixed(1)}s`);
  if (result.outlookVersion !== "") parts.push(`Outlook ${result.outlookVersion}`);
  return parts.join(" · ");
}

function labels(folders: readonly OutlookFolder[]): string {
  return folders.map((folder) => OUTLOOK_FOLDER_LABELS[folder]).join(" and ");
}

function dateOnly(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
