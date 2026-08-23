/**
 * Writing what extraction found into the vault (CLAUDE.md §7 B6).
 *
 * The rules are the ones every writer in this plugin follows, and one that is
 * particular to this feature:
 *
 *  - **The ledger goes first** (rule 9). Extraction creates several notes in
 *    one action; a crash halfway leaves a recorded intent and a `correction`
 *    saying it did not complete, rather than a handful of orphan notes nobody
 *    can account for.
 *  - **Frontmatter merges, prose is untouched** (rule 8, §5.1). The meeting
 *    note gains a manifest of what came out of it and loses nothing. Not one
 *    character of the minutes themselves is rewritten.
 *  - **The manifest is written last.** It is the record that these items have
 *    been dealt with, so it must not claim a note exists before it does — a
 *    failed run has to be safe to re-run.
 *
 * The anchor date deserves its own note. It comes from the note's own
 * frontmatter or its filename, never from the clock: extracting minutes from
 * six weeks ago must resolve "by Friday" to that Friday, not this one. When
 * neither source has a date the anchor is empty, relative deadlines refuse,
 * and the dialog offers a field to supply it.
 */

import { TFile, type App } from "obsidian";
import { correctionEntry, type AuditEntry } from "../domain/audit/ledger";
import { newCapture } from "../domain/capture/capture";
import { nextEventId, newObligation, DEFAULT_EVENT_PREFIX } from "../domain/events/create";
import { scanMinutes, type MinutesScan } from "../domain/extract/minutes";
import {
  auditDetail,
  readExtractions,
  recordFor,
  EXTRACTED_AT_KEY,
  EXTRACTIONS_KEY,
  type ExtractionPlan,
  type ExtractionRecord,
  type PlannedWrite,
} from "../domain/extract/plan";
import { toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { NoteIndex } from "../data/noteIndex";
import type { AuditLog } from "./auditLog";

export interface ExtractContext {
  app: App;
  notes: NoteIndex;
  audit: AuditLog;
  folder: (key: "inbox" | "events") => string;
  actor: () => string;
  /** Every person the vault knows, for owner resolution. */
  people: () => string[];
  /** The hat being worn, recorded on captures exactly as quick capture does. */
  mode: () => string;
}

/** A set of minutes, read and ready to scan. */
export interface MeetingSource {
  file: TFile;
  content: string;
  /** `YYYY-MM-DD` from the note, or "" when it does not say. */
  anchor: string;
  /** Where the anchor came from, so the dialog can say whether to trust it. */
  anchorFrom: "frontmatter" | "filename" | "none";
  /** What previous runs took out of this note. */
  existing: ExtractionRecord[];
  /** Everyone the vault knows, for owner resolution. */
  people: string[];
}

export interface ApplyResult {
  /** Paths of the notes created, in the order they were written. */
  created: string[];
  decisions: number;
}

const DATE_IN_NAME = /(\d{4}-\d{2}-\d{2})/;

/**
 * A vault path as a link.
 *
 * The extension goes: Obsidian resolves `[[a/b.md]]` but renders the `.md`,
 * and every link a person writes by hand in this vault is without it. A note
 * full of links that look different from the ones beside them reads as machine
 * output, which is the opposite of rule 11.
 */
function wikilink(path: string): string {
  const trimmed = path.trim();
  return trimmed === "" ? "" : `[[${trimmed.replace(/\.md$/i, "")}]]`;
}

export class ExtractWriter {
  constructor(private readonly ctx: ExtractContext) {}

  /** Read a set of minutes and everything needed to scan it. */
  async read(file: TFile): Promise<MeetingSource> {
    const content = await this.ctx.app.vault.read(file);
    const frontmatter = this.ctx.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

    const declared = this.dateField(frontmatter);
    const fromName = DATE_IN_NAME.exec(file.basename)?.[1] ?? "";
    const anchor = declared !== "" ? declared : fromName;

    return {
      file,
      content,
      anchor,
      anchorFrom: declared !== "" ? "frontmatter" : fromName !== "" ? "filename" : "none",
      existing: readExtractions(frontmatter[EXTRACTIONS_KEY]),
      people: this.ctx.people(),
    };
  }

  /**
   * The meeting's own date.
   *
   * `date` first, then `on` and `due`: the vault contract does not fix a key
   * for a meeting note, and all three turn up in minutes people actually write.
   */
  private dateField(frontmatter: Record<string, unknown>): string {
    for (const key of ["date", "on", "due", "held"]) {
      const value = frontmatter[key];
      const text =
        value instanceof Date
          ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
          : typeof value === "string"
            ? value.trim()
            : "";
      const match = DATE_IN_NAME.exec(text);
      if (match) return match[1]!;
    }
    return "";
  }

  /** Read a set of minutes with a given anchor. Writes nothing. */
  scan(source: MeetingSource, anchor?: string): MinutesScan {
    return scanMinutes({
      content: source.content,
      anchor: anchor ?? source.anchor,
      people: source.people,
    });
  }

  /**
   * Write a plan out.
   *
   * The manifest is appended to rather than replaced, so two runs a month
   * apart both stay legible, and the ledger entry names counts only — the
   * words live on the meeting note, where a reader can see the line they came
   * from (rule 7).
   */
  async apply(source: MeetingSource, plan: ExtractionPlan, now = Date.now()): Promise<ApplyResult> {
    const actor = this.actorOrThrow();
    const subject = source.file.path;

    const entry: AuditEntry = {
      ts: toVaultMinute(now),
      actor,
      action: "bulk-edit",
      subject,
      detail: `extracted from minutes: ${auditDetail(plan.writes)}`,
    };
    await this.ctx.audit.append([entry]);

    const created: string[] = [];
    const records: ExtractionRecord[] = [];

    try {
      for (const write of plan.writes) {
        const link = await this.write(write, source, now);
        if (link !== "") created.push(link);
        records.push(recordFor(write, wikilink(link), now));
      }
      await this.stamp(source.file, records, now);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `extraction stopped after ${created.length} of ${plan.writes.length}: ${reason}`,
        }),
      ]);
      throw error;
    }

    this.ctx.notes.update(source.file);
    return {
      created,
      decisions: plan.writes.filter((write) => write.destination === "decision").length,
    };
  }

  /** One item. Returns the path of the note it became, or "" for a decision. */
  private async write(write: PlannedWrite, source: MeetingSource, now: number): Promise<string> {
    if (write.destination === "decision") return "";
    return write.destination === "event"
      ? this.writeEvent(write, source, now)
      : this.writeCapture(write, source, now);
  }

  /** A dated item becomes an event, so the deadline board and reminders see it. */
  private async writeEvent(
    write: PlannedWrite,
    source: MeetingSource,
    now: number,
  ): Promise<string> {
    const folder = this.ctx.folder("events");
    const note = newObligation({
      id: nextEventId(this.existingEventIds(), new Date(now).getFullYear(), DEFAULT_EVENT_PREFIX),
      title: write.title,
      due: write.item.due?.date ?? "",
      recurrence: null,
      leadDays: [],
      owner: write.item.owner?.ref ?? "",
      study: "",
      consequence: "",
      now,
    });

    await ensureFolder(this.ctx.app, folder);
    const file = await this.ctx.app.vault.create(`${folder}/${note.filename}`, note.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, note.frontmatter, this.provenance(write, source));
    });

    this.ctx.notes.update(file);
    return file.path;
  }

  /** An undated item becomes a capture, awaiting triage exactly like any other. */
  private async writeCapture(
    write: PlannedWrite,
    source: MeetingSource,
    now: number,
  ): Promise<string> {
    const folder = this.ctx.folder("inbox");
    const prefix = `${folder}/`;
    const taken = new Set(
      this.ctx.app.vault
        .getFiles()
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => file.name),
    );

    const capture = newCapture({
      text: write.title,
      now,
      mode: this.ctx.mode(),
      taken,
    });

    await ensureFolder(this.ctx.app, folder);
    const file = await this.ctx.app.vault.create(`${folder}/${capture.filename}`, capture.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, capture.frontmatter, this.provenance(write, source));
    });

    this.ctx.notes.update(file);
    return file.path;
  }

  /**
   * Where the item came from, on the note it became.
   *
   * B6's requirement is that every item links back to its source note *and
   * line*, and this is it. `source_line` counts from the first line of the
   * minutes' **body**, not of the file — see `ExtractedItem.line`: the
   * manifest this same run appends to the meeting's frontmatter would
   * otherwise invalidate every number it just wrote.
   */
  private provenance(write: PlannedWrite, source: MeetingSource): Record<string, unknown> {
    return {
      source: wikilink(source.file.path),
      source_line: write.item.line,
      ...(write.item.owner === null ? {} : { owner: write.item.owner.ref }),
    };
  }

  /** Basenames, which for a note this plugin created are exactly its id. */
  private existingEventIds(): string[] {
    const prefix = `${this.ctx.folder("events")}/`;
    return this.ctx.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => file.basename);
  }

  /**
   * Record on the meeting note what this run took out of it.
   *
   * Appends to the manifest rather than replacing it, so two runs a month
   * apart both stay visible; `extracted` is overwritten because it means "last
   * looked at", and the manifest rows carry the individual timestamps.
   */
  private async stamp(file: TFile, records: readonly ExtractionRecord[], now: number): Promise<void> {
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const existing: unknown = frontmatter[EXTRACTIONS_KEY];
      frontmatter[EXTRACTIONS_KEY] = [
        ...(Array.isArray(existing) ? existing : []),
        ...records.map((record) => ({ ...record })),
      ];
      frontmatter[EXTRACTED_AT_KEY] = toVaultMinute(now);
    });
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
