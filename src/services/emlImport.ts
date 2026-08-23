/**
 * Importing saved email files into correspondence threads (CLAUDE.md §5.10,
 * email Tier 1).
 *
 * The vault side. Everything decided is decided in `domain/comms/eml*` and
 * `domain/comms/msg*`; this reads files through Obsidian, writes notes and
 * attachments back through Obsidian, and nothing else.
 *
 * **Two formats, one pipeline.** New Outlook and the web app save a message as
 * `.eml`; classic Outlook saves `.msg`, a compound binary with no RFC 5322 in
 * it at all. Both parsers return the same `EmlMessage`, so everything from
 * threading to the review dialog to the note writing is shared, and a
 * conversation saved half one way and half the other still lands in one thread.
 * The format is chosen by looking at the file's first bytes rather than its
 * extension, because a message renamed by hand is common and a signature is
 * not a guess.
 *
 * Four rules shape it, all of them from §2:
 *
 *  - **Vault files only.** The picker offers message files that are already in
 *    the vault. Reading an arbitrary path would mean `fs`, which rule 8 forbids
 *    — dragging the message out of Outlook into the vault first is one extra
 *    step and keeps every read inside Obsidian's own API.
 *  - **Nothing is fetched and nothing is sent.** There is no mailbox access
 *    anywhere in here. A file goes in; notes come out.
 *  - **Nothing already in the vault is modified beyond appending.**
 *    Frontmatter merges, the body is appended to, no source file is touched
 *    and nothing is deleted (rule 8).
 *  - **The actor is checked before the first write, not after the last.**
 *    Asking once the notes exist leaves the vault holding an import the ledger
 *    has no record of — the failure rule 9 exists to prevent.
 *
 * Two things the import will not do, both from rule 5: it never changes a
 * request note, and it never satisfies a gate. An email is untrusted text.
 */

import { normalizePath, TFile, type App } from "obsidian";
import type { AuditLog } from "./auditLog";
import type { NoteIndex } from "../data/noteIndex";
import { ensureFolder } from "../data/vaultPaths";
import { ulid } from "../domain/id/ulid";
import { toVaultMinute } from "../domain/time/dates";
import { parseEml, type EmlMessage } from "../domain/comms/eml";
import { isMsgFile, parseMsg } from "../domain/comms/msg";
import {
  alreadyRecorded,
  appendEmlToThread,
  messageSection,
  newThreadFromEml,
  planMessage,
  threadForMessage,
  type AttachmentPolicy,
  type EmlPlan,
  type PlanOptions,
} from "../domain/comms/emlThread";
import { nextThreadId } from "../domain/comms/threadUpdate";
import { CORRESPONDENCE_TYPE, parseThread, type Thread } from "../domain/comms/thread";

/**
 * The extensions offered for import.
 *
 * `.eml` from new Outlook and the web app, `.msg` from classic Outlook. Which
 * one a given work laptop produces is decided by which Outlook is installed,
 * not by anything the user chooses, so both have to be read.
 */
export const MAIL_EXTENSIONS = ["eml", "msg"] as const;

export interface EmlImportDeps {
  app: App;
  notes: NoteIndex;
  audit: AuditLog;
  correspondenceFolder: () => string;
  /** Request ids in the vault, so only real ones are ever linked. */
  requestIds: () => string[];
  /** Person-note names, so a matching display name links to the note. */
  peopleNames: () => string[];
  /** The user's own mailboxes. Without at least one, direction is undecidable. */
  ownAddresses: () => string[];
  attachmentPolicy: () => AttachmentPolicy;
  maxAttachmentKb: () => number;
  actor: () => string;
}

/** One thread that will be opened or extended, with the messages that do it. */
export interface ThreadAction {
  /** The note to extend, or null when this batch opens the thread. */
  existing: TFile | null;
  /** Existing label, or the one allocated for a new thread. */
  threadId: string;
  subject: string;
  /** Chronological. */
  plans: EmlPlan[];
}

export interface EmlPreview {
  actions: ThreadAction[];
  /** Messages already recorded on their thread, skipped. */
  duplicates: number;
  /** Files that could not be read as a message at all. */
  unreadable: string[];
  messageCount: number;
  attachmentCount: number;
  problems: string[];
}

export interface EmlOutcome {
  threadsCreated: number;
  threadsUpdated: number;
  messages: number;
  attachments: number;
  problems: string[];
}

export class EmlImport {
  constructor(private readonly deps: EmlImportDeps) {}

  /** Where attachments land — §5 names this folder. */
  attachmentsFolder(): string {
    return normalizePath(`${this.deps.correspondenceFolder()}/_attachments`);
  }

  /** Every saved message file in the vault, newest first. */
  candidates(): TFile[] {
    const wanted = new Set<string>(MAIL_EXTENSIONS);
    return this.deps.app.vault
      .getFiles()
      .filter((file) => wanted.has(file.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  /** Every correspondence note the index holds, parsed. */
  private threads(): { thread: Thread; file: TFile }[] {
    return this.deps.notes.byType(CORRESPONDENCE_TYPE).map((entry) => ({
      thread: parseThread(entry.frontmatter, entry.file.basename).thread,
      file: entry.file,
    }));
  }

  /**
   * True when direction can be worked out at all.
   *
   * The importer refuses rather than guessing when this is false. `awaiting` is
   * the whole point of §5.10, and a wrong direction inverts it — an unanswered
   * chase-up would read as a closed loop, which is precisely the failure the
   * note type exists to prevent.
   */
  canDetermineDirection(): boolean {
    return this.ownAddressSet().size > 0;
  }

  private ownAddressSet(): Set<string> {
    return new Set(
      this.deps
        .ownAddresses()
        .map((address) => address.trim().toLowerCase())
        .filter((address) => address.includes("@")),
    );
  }

  private planOptions(fallbackAt: number): PlanOptions {
    return {
      ownAddresses: this.ownAddressSet(),
      knownRequestIds: this.deps.requestIds(),
      knownPeople: this.deps.peopleNames(),
      attachments: this.deps.attachmentPolicy(),
      maxAttachmentKb: this.deps.maxAttachmentKb(),
      fallbackAt,
    };
  }

  /**
   * Read the chosen files and work out what would happen. Writes nothing.
   *
   * §2 rule 5 in its literal form: the payload is shown before anything acts on
   * it. Everything the apply step will do is decided here, so the review the
   * user approves is the work that runs.
   */
  async preview(files: readonly TFile[]): Promise<EmlPreview> {
    const preview: EmlPreview = {
      actions: [],
      duplicates: 0,
      unreadable: [],
      messageCount: 0,
      attachmentCount: 0,
      problems: [],
    };

    const existing = this.threads();
    const byThreadKey = new Map<string, ThreadAction>();
    // Ids taken across the vault *and* across this batch, so two new
    // conversations in one import do not both claim THR-2026-0005.
    const takenIds = existing.map((entry) => entry.thread.id);
    const year = new Date().getFullYear();

    for (const file of files) {
      const message = await this.read(file);
      if (message === null) {
        preview.unreadable.push(file.path);
        continue;
      }

      const plan = planMessage(message, file.path, this.planOptions(file.stat.mtime));
      preview.problems.push(...plan.problems.map((problem) => `${file.name}: ${problem}`));

      const match = threadForMessage(
        existing.map((entry) => entry.thread),
        plan,
      );

      if (match !== null && alreadyRecorded(match, plan)) {
        preview.duplicates += 1;
        continue;
      }

      // Group on the thread key so a chain of replies imported together lands
      // in one note rather than opening a thread per message.
      const key = plan.threadKey === "" ? `file:${file.path}` : plan.threadKey;
      const grouped = byThreadKey.get(key);

      if (grouped !== undefined) {
        // Two files can be the same message — the same reply saved twice, or a
        // sent copy and its Cc. Recorded once.
        if (
          plan.message.messageId !== "" &&
          grouped.plans.some((other) => other.message.messageId === plan.message.messageId)
        ) {
          preview.duplicates += 1;
          continue;
        }
        grouped.plans.push(plan);
        continue;
      }

      const found = match === null ? null : existing.find((entry) => entry.thread === match);
      const threadId = found?.thread.id ?? nextThreadId(takenIds, year);
      if (found === undefined || found === null) takenIds.push(threadId);

      byThreadKey.set(key, {
        existing: found?.file ?? null,
        threadId,
        subject: plan.message.subject === "" ? "(no subject)" : plan.message.subject,
        plans: [plan],
      });
    }

    for (const action of byThreadKey.values()) {
      action.plans.sort((a, b) => a.at - b.at);
      preview.messageCount += action.plans.length;
      preview.attachmentCount += action.plans.reduce((n, p) => n + p.attachments.length, 0);
      preview.actions.push(action);
    }
    preview.actions.sort((a, b) => (a.plans[0]?.at ?? 0) - (b.plans[0]?.at ?? 0));

    return preview;
  }

  /**
   * Parse one file, or null when it is not a message.
   *
   * The parser is chosen by the file's own first bytes — a compound file starts
   * with a fixed eight-byte signature — not by its extension. A message saved
   * with the wrong suffix, or renamed on the way through a shared drive, is
   * common enough that trusting the name would fail for no good reason.
   */
  private async read(file: TFile): Promise<EmlMessage | null> {
    try {
      const bytes = new Uint8Array(await this.deps.app.vault.readBinary(file));
      const message = isMsgFile(bytes) ? parseMsg(bytes) : parseEml(bytes);
      // No sender and no subject and no body is not a message, it is a file
      // that happens to carry a message file's extension.
      if (message.from.length === 0 && message.subject === "" && message.body === "") return null;
      return message;
    } catch {
      return null;
    }
  }

  /**
   * Carry out an approved preview.
   *
   * Attachments are written before the note that links them, so a link never
   * points at a file that is not there yet.
   */
  async apply(actions: readonly ThreadAction[]): Promise<EmlOutcome> {
    const outcome: EmlOutcome = {
      threadsCreated: 0,
      threadsUpdated: 0,
      messages: 0,
      attachments: 0,
      problems: [],
    };
    if (actions.length === 0) return outcome;

    // Before the first write. See the header.
    const actor = this.actorOrThrow();

    const folder = this.deps.correspondenceFolder();
    await ensureFolder(this.deps.app, folder);

    for (const action of actions) {
      if (action.plans.length === 0) continue;
      try {
        const written = await this.applyOne(action, folder);
        outcome.attachments += written.attachments;
        outcome.messages += action.plans.length;
        if (written.created) outcome.threadsCreated += 1;
        else outcome.threadsUpdated += 1;
      } catch (error) {
        // One bad thread must not lose the rest of the batch. The failure is
        // reported by id, never with content (rule 7).
        outcome.problems.push(
          `${action.threadId} could not be written: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    if (outcome.messages > 0) {
      await this.deps.audit.append([
        {
          ts: toVaultMinute(Date.now()),
          actor,
          action: "bulk-edit",
          subject: "correspondence-import",
          // Counts and ids only — never a subject, an address or a body.
          detail:
            `${outcome.messages} message${outcome.messages === 1 ? "" : "s"} imported from saved mail ` +
            `into ${outcome.threadsCreated} new and ${outcome.threadsUpdated} existing thread` +
            `${outcome.threadsUpdated === 1 ? "" : "s"}, ${outcome.attachments} attachment` +
            `${outcome.attachments === 1 ? "" : "s"} saved`,
        },
      ]);
    }

    return outcome;
  }

  private async applyOne(
    action: ThreadAction,
    folder: string,
  ): Promise<{ created: boolean; attachments: number }> {
    let attachments = 0;
    // Named per message so the link in each section resolves to its own file.
    const renamed = new Map<EmlPlan, string[]>();
    for (const plan of action.plans) {
      renamed.set(plan, await this.writeAttachments(action.threadId, plan));
      attachments += renamed.get(plan)?.length ?? 0;
    }

    if (action.existing === null) {
      const first = action.plans[0]!;
      const note = newThreadFromEml(withNames(first, renamed), action.threadId, ulid(Date.now()));
      const path = this.freePath(folder, note.filename);
      const file = await this.deps.app.vault.create(path, note.body);
      await this.patch(file, note.frontmatter);

      for (const plan of action.plans.slice(1)) {
        await this.appendTo(file, withNames(plan, renamed));
      }
      return { created: true, attachments };
    }

    for (const plan of action.plans) {
      await this.appendTo(action.existing, withNames(plan, renamed));
    }
    return { created: false, attachments };
  }

  /**
   * Append one message to a thread note: body first, then the frontmatter.
   *
   * The patch is computed **inside** `processFrontMatter`, from the frontmatter
   * it hands over, rather than from the note index. That is not tidiness. The
   * index is fed by Obsidian's metadata cache, which updates asynchronously, so
   * a thread this batch created moments ago still reads as empty — and
   * `appendEmlToThread` merges against what it is given. Merging against
   * nothing produces a `with:` list holding only the latest message's parties,
   * which silently drops everyone the *first* message was addressed to. Found
   * by importing two real messages and reading the note: the Cc'd coordinator
   * had vanished.
   *
   * The callback's frontmatter is the file as it actually is, so the merge is
   * correct and atomic with the write.
   */
  private async appendTo(file: TFile, plan: EmlPlan): Promise<void> {
    await this.deps.app.vault.process(file, (current) => {
      const body = messageSection(plan);
      return current.endsWith("\n") ? current + body : `${current}\n${body}`;
    });

    await this.deps.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const thread = parseThread(frontmatter, file.basename).thread;
      const patch = appendEmlToThread(plan, thread);

      Object.assign(frontmatter, patch.set);
      const messages: unknown = frontmatter["messages"];
      frontmatter["messages"] = [
        ...(Array.isArray(messages) ? messages : []),
        patch.appendMessage,
      ];
    });
    this.deps.notes.update(file);
  }

  /**
   * Save a message's attachments and return the names they were written under.
   *
   * Prefixed with the thread id and deduplicated, because "scan.pdf" arrives
   * from four different people in a year and `_attachments/` is one flat
   * folder. Nothing is ever overwritten (rule 8).
   */
  private async writeAttachments(threadId: string, plan: EmlPlan): Promise<string[]> {
    if (plan.attachments.length === 0) return [];

    const folder = this.attachmentsFolder();
    await ensureFolder(this.deps.app, folder);

    const names: string[] = [];
    for (const attachment of plan.attachments) {
      const path = this.freePath(folder, `${threadId} — ${attachment.filename}`);
      const file = await this.deps.app.vault.createBinary(
        path,
        // A fresh buffer: the parsed bytes may be a view onto a larger array,
        // and handing that to `createBinary` would write the whole message.
        attachment.bytes.slice().buffer as ArrayBuffer,
      );
      names.push(file.name);
    }
    return names;
  }

  /** First free `name`, then `name 2`. Never overwrites (rule 8). */
  private freePath(folder: string, filename: string): string {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const suffix = dot > 0 ? filename.slice(dot) : ".md";

    for (let counter = 1; counter < 100; counter++) {
      const candidate = normalizePath(
        `${folder}/${stem}${counter === 1 ? "" : ` ${counter}`}${suffix}`,
      );
      if (this.deps.app.vault.getAbstractFileByPath(candidate) === null) return candidate;
    }
    throw new Error(`There are already 99 files named "${stem}" in ${folder}.`);
  }

  private async patch(file: TFile, set: Record<string, unknown>): Promise<void> {
    await this.deps.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, set);
    });
    this.deps.notes.update(file);
  }

  private actorOrThrow(): string {
    const actor = this.deps.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials in SCDB Cockpit settings first — this import is recorded in the audit ledger against an actor.",
      );
    }
    return actor;
  }
}

/**
 * Rewrite a plan's attachment names to the ones actually written.
 *
 * Dedupe happens at write time, so `scan.pdf` may land as `THR-2026-0004 —
 * scan 2.pdf`. The link in the note body has to say that, or it points at a
 * different person's file with the same name.
 */
function withNames(plan: EmlPlan, renamed: ReadonlyMap<EmlPlan, string[]>): EmlPlan {
  const names = renamed.get(plan);
  if (names === undefined || names.length !== plan.attachments.length) return plan;
  return {
    ...plan,
    attachments: plan.attachments.map((attachment, index) => ({
      ...attachment,
      filename: names[index]!,
    })),
  };
}
