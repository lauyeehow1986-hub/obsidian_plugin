/**
 * The three things B1 writes into the vault: a capture, a correspondence
 * thread, and the daily briefing.
 *
 * They share a file because they share the same three constraints, and keeping
 * them together makes it hard to satisfy two and forget the third:
 *
 *  - **Every write goes through Obsidian's vault APIs** (rule 8). No `fs`,
 *    nothing outside the vault. Frontmatter is merged through
 *    `processFrontMatter`, so a key this plugin has never heard of survives.
 *  - **Nothing is overwritten.** A capture picks the next free filename, a
 *    briefing refuses when today's already exists, a thread is appended to.
 *  - **The ledger is written before the note** for anything consequential
 *    (rule 9), which here is composing a message and nothing else.
 */

import { TFile, type App } from "obsidian";
import { newCapture, type CaptureInput } from "../domain/capture/capture";
import { buildBriefing, type BriefingInput } from "../domain/briefing/briefing";
import { parseThread, type Thread } from "../domain/comms/thread";
import {
  appendOutbound,
  newThread,
  nextThreadId,
  type ComposedMessage,
  type ThreadPatch,
} from "../domain/comms/threadUpdate";
import { CORRESPONDENCE_TYPE } from "../domain/comms/thread";
import { ensureFolder } from "../data/vaultPaths";
import type { NoteIndex } from "../data/noteIndex";
import type { AuditLog } from "./auditLog";

export interface RhythmContext {
  app: App;
  notes: NoteIndex;
  audit: AuditLog;
  folder: (key: "inbox" | "correspondence" | "briefings") => string;
  actor: () => string;
}

export class RhythmWriter {
  constructor(private readonly ctx: RhythmContext) {}

  /* ------------------------------------------------------------ capture -- */

  /**
   * Write a quick capture. Never blocks, never asks a second question.
   *
   * The taken-filename set is read from the vault rather than the index,
   * because the index only holds notes that declare a `type:` and a stray
   * hand-written file in the inbox would still collide on disk.
   */
  async capture(input: Omit<CaptureInput, "taken">): Promise<TFile> {
    const folder = this.ctx.folder("inbox");
    const prefix = `${folder}/`;
    const taken = new Set(
      this.ctx.app.vault
        .getFiles()
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => file.name),
    );

    const capture = newCapture({ ...input, taken });
    await ensureFolder(this.ctx.app, folder);

    const file = await this.ctx.app.vault.create(`${folder}/${capture.filename}`, capture.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, capture.frontmatter);
    });

    this.ctx.notes.update(file);
    return file;
  }

  /* ------------------------------------------------------------- threads -- */

  /** Every correspondence note the index holds, parsed. */
  threads(): { thread: Thread; file: TFile; problems: string[] }[] {
    return this.ctx.notes.byType(CORRESPONDENCE_TYPE).map((entry) => {
      const parsed = parseThread(entry.frontmatter, entry.file.basename);
      return { thread: parsed.thread, file: entry.file, problems: parsed.problems };
    });
  }

  private threadFileFor(thread: Thread): TFile | null {
    // Matched on uid, not on id: §5.2 puts every machine reference on the uid
    // precisely so a renumbered human label cannot lose the note.
    const match = this.threads().find((entry) =>
      thread.uid === "" ? entry.thread.id === thread.id : entry.thread.uid === thread.uid,
    );
    return match?.file ?? null;
  }

  /**
   * Record a composed message: append to an existing thread, or open a new one.
   *
   * The ledger entry goes first (rule 9). If the note write then fails, the
   * ledger records an intent that did not complete — which is the honest
   * outcome and exactly what an append-only ledger is for.
   */
  async recordComposed(
    message: Omit<ComposedMessage, "actor">,
    existing: Thread | null,
  ): Promise<TFile> {
    const actor = this.actorOrThrow();
    const full: ComposedMessage = { ...message, actor };

    if (existing !== null) {
      const file = this.threadFileFor(existing);
      if (file !== null) {
        const patch = appendOutbound(full, existing);
        await this.ctx.audit.append(patch.audit);
        await this.applyThreadPatch(file, patch);
        return file;
      }
      // The note vanished between reading the index and writing. Opening a new
      // thread loses nothing; refusing would lose the record of the message.
    }

    const folder = this.ctx.folder("correspondence");
    const year = new Date(full.now).getFullYear();
    const created = newThread({
      ...full,
      id: nextThreadId(
        this.threads().map((entry) => entry.thread.id),
        year,
      ),
    });

    await this.ctx.audit.append(created.audit);
    await ensureFolder(this.ctx.app, folder);

    const file = await this.ctx.app.vault.create(`${folder}/${created.filename}`, created.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, created.frontmatter);
    });

    this.ctx.notes.update(file);
    return file;
  }

  /** Apply a thread patch: merge keys, append to `messages`, touch nothing else. */
  async applyThreadPatch(file: TFile, patch: ThreadPatch): Promise<void> {
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, patch.set);
      if (patch.appendMessage !== undefined) {
        const messages: unknown = frontmatter["messages"];
        frontmatter["messages"] = [
          ...(Array.isArray(messages) ? messages : []),
          patch.appendMessage,
        ];
      }
    });
    this.ctx.notes.update(file);
  }

  /* ------------------------------------------------------------ briefing -- */

  /**
   * Write today's briefing, or return the one already there.
   *
   * Never overwrites: the note is a record of a morning and may have been
   * annotated by lunchtime. `created` tells the caller which happened so the
   * notice can say so rather than implying work was done.
   */
  async briefing(input: BriefingInput): Promise<{ file: TFile; created: boolean; quiet: boolean }> {
    const built = buildBriefing(input);
    const folder = this.ctx.folder("briefings");
    const path = `${folder}/${built.date}.md`;

    const existing = this.ctx.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return { file: existing, created: false, quiet: built.quiet };
    }

    await ensureFolder(this.ctx.app, folder);
    const file = await this.ctx.app.vault.create(path, built.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, built.frontmatter);
    });

    this.ctx.notes.update(file);
    return { file, created: true, quiet: built.quiet };
  }

  private actorOrThrow(): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials as the actor in SCDB Cockpit settings first — every logged action needs to name who did it.",
      );
    }
    return actor;
  }
}
