/**
 * What extraction will do, decided before anything is written (§7 B6).
 *
 * Two jobs, both pure so both are testable without a vault:
 *
 *  - **Where each item goes.** Not a choice in the dialog — a consequence of
 *    what the line says. An item with a date becomes an event, because the
 *    deadline board and the lead-time reminders already watch `60 Events/`;
 *    without one it becomes a capture, because "work, not yet decided about"
 *    is precisely what `00 Inbox/` is for (§5.14). One rule, visible in the
 *    dialog, so adding a date is the whole of how you promote something.
 *  - **What has already been extracted.** Running this twice on the same
 *    minutes must not produce a second set of notes. The meeting note carries
 *    a manifest of what came out of it, keyed on the *words* rather than the
 *    line number, so editing the paragraph above does not resurrect the lot.
 *
 * Decisions get no note of their own. A decision is a record, not work, and
 * one note per decision buries the vault in files nobody opens. It is recorded
 * on the meeting note, where the body remains the authority — the manifest row
 * says "this was read out of line 12", not "this is what was decided".
 *
 * The meeting's **body is never touched** (rule 8, and §5.1's rule that the
 * plugin never rewrites prose). Everything extraction records about a set of
 * minutes lives in its frontmatter.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultMinute } from "../time/dates";
import { ITEM_KINDS, type ExtractedItem, type ItemKind } from "./minutes";

/** Frontmatter keys extraction owns on a meeting note. */
export const EXTRACTED_AT_KEY = "extracted";
export const EXTRACTIONS_KEY = "extractions";

export type Destination = "event" | "capture" | "decision";

/** One row of the manifest a meeting note carries after extraction. */
export interface ExtractionRecord {
  key: string;
  kind: ItemKind;
  /** Where it was read from, for a human reading the manifest later. */
  line: number;
  /** `YYYY-MM-DDTHH:mm` of the run that took it. */
  at: string;
  text: string;
  /** Wikilink to the note it became. Absent for a decision, which becomes none. */
  to?: string;
}

export interface PlannedWrite {
  item: ExtractedItem;
  destination: Destination;
  /** The event title, or the line a capture note carries as its body. */
  title: string;
}

export interface AlreadyDone {
  item: ExtractedItem;
  record: ExtractionRecord;
}

export interface ExtractionPlan {
  writes: PlannedWrite[];
  /** Items this note has been through before, and where they went. */
  duplicates: AlreadyDone[];
}

/**
 * Where an item lands.
 *
 * Derived, never chosen: two controls that can disagree ("kind: deadline" and
 * "destination: inbox") is a way to file a deadline somewhere nothing watches.
 */
export function destinationFor(item: ExtractedItem): Destination {
  if (item.kind === "decision") return "decision";
  return item.due === null ? "capture" : "event";
}

/**
 * The title an item carries into the note it becomes.
 *
 * The owner is appended rather than left in the sentence: an event's `owner`
 * field is what the holdup and agenda views read, and a title that also says
 * "Dr A Tan" reads as a duplicate on every board that shows both.
 */
export function titleFor(item: ExtractedItem): string {
  const text = item.text.trim();
  return text === "" ? item.raw.trim() : text;
}

function isKind(value: unknown): value is ItemKind {
  return typeof value === "string" && (ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * Read the manifest off a meeting note.
 *
 * Tolerant on purpose: this is a hand-editable markdown file, and a row
 * somebody mangled should cost that one row, not the whole dedupe check.
 */
export function readExtractions(value: unknown): ExtractionRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ExtractionRecord[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const key = typeof row["key"] === "string" ? row["key"].trim() : "";
    if (key === "") continue;

    const line = typeof row["line"] === "number" ? row["line"] : 0;
    const to = typeof row["to"] === "string" ? row["to"].trim() : "";
    records.push({
      key,
      kind: isKind(row["kind"]) ? row["kind"] : "action",
      line,
      at: typeof row["at"] === "string" ? row["at"] : "",
      text: typeof row["text"] === "string" ? row["text"] : "",
      ...(to === "" ? {} : { to }),
    });
  }

  return records;
}

/**
 * Split what was found into what would be written and what already has been.
 *
 * `chosen` is the set of keys the user left ticked. Anything already in the
 * manifest is held back whether or not it is ticked — the dialog shows those
 * separately and unticked, and honouring a tick would defeat the check.
 */
export function planExtraction(
  items: readonly ExtractedItem[],
  chosen: ReadonlySet<string>,
  existing: readonly ExtractionRecord[],
): ExtractionPlan {
  const done = new Map(existing.map((record) => [record.key, record]));
  const writes: PlannedWrite[] = [];
  const duplicates: AlreadyDone[] = [];

  for (const item of items) {
    const record = done.get(item.key);
    if (record !== undefined) {
      duplicates.push({ item, record });
      continue;
    }
    if (!chosen.has(item.key)) continue;
    writes.push({ item, destination: destinationFor(item), title: titleFor(item) });
  }

  return { writes, duplicates };
}

/** The manifest row for something that has just been written. */
export function recordFor(write: PlannedWrite, link: string, now: number): ExtractionRecord {
  const to = link.trim();
  return {
    key: write.item.key,
    kind: write.item.kind,
    line: write.item.line,
    at: toVaultMinute(now),
    text: write.title,
    ...(to === "" ? {} : { to }),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The ledger detail line: counts by destination, and nothing else.
 *
 * Rule 7 — no note content in a log. The manifest on the meeting note is
 * where the words live; the ledger records that a run happened and how big it
 * was, which is what a later reader needs to know to go and look.
 */
export function auditDetail(writes: readonly PlannedWrite[]): string {
  const events = writes.filter((write) => write.destination === "event").length;
  const captures = writes.filter((write) => write.destination === "capture").length;
  const decisions = writes.filter((write) => write.destination === "decision").length;

  const parts: string[] = [];
  if (events > 0) parts.push(plural(events, "deadline"));
  if (captures > 0) parts.push(`${plural(captures, "action")} to inbox`);
  if (decisions > 0) parts.push(plural(decisions, "decision"));
  return parts.length === 0 ? "nothing extracted" : parts.join(", ");
}
