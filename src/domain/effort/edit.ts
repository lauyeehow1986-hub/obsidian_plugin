/**
 * Retroactive editing of the effort log (CLAUDE.md §7 B2).
 *
 * **Why this exists at all, given §5.3 calls the log append-only.** Those two
 * are in genuine tension and the tension is worth naming rather than papering
 * over. §5.3's "append-only" is about how the *timer* writes: it adds a row and
 * never rewrites the month, which is what keeps the file diffable and keeps
 * request notes from churning. It is not a claim that the log is evidentiary —
 * that is the audit ledger's job, and the ledger has a hash chain precisely
 * because it makes that claim and this file does not. B2 is explicit that
 * "everyone forgets to stop a timer" and that fixing it afterwards is a
 * first-class feature. A log you cannot correct is a log that gets abandoned
 * the first week, and an abandoned log justifies no posts at all.
 *
 * So editing is allowed, and three things keep it honest:
 *
 *  1. **An edit names the line it thinks it is changing, and refuses if the
 *     file has moved on.** The user may have opened the month in the editor;
 *     writing to a line number read thirty seconds ago would overwrite a row
 *     nobody meant to touch (rule 8).
 *  2. **Anything that is not a row this module understands is passed through
 *     untouched** — prose, comments, hand-written tables, rows with the wrong
 *     column count. We rewrite the file, so everything we do not understand has
 *     to survive verbatim.
 *  3. **Changing or removing existing rows is logged** (see the service). A new
 *     row is the tool doing its job; rewriting hours that may later justify a
 *     post or a chargeback line is consequential, and §5.6 does not allow
 *     silent consequential actions.
 *
 * Pure module: no Obsidian, no Node.
 */

import { isTableRow } from "../table/cells";
import {
  EFFORT_HEADER,
  parseEffortLog,
  renderEntry,
  splitEntry,
  type TimeEntry,
} from "./entry";

export type EffortEdit =
  | { kind: "add"; entry: TimeEntry }
  | { kind: "replace"; line: number; was: string; entry: TimeEntry }
  | { kind: "remove"; line: number; was: string }
  /** Break one entry in two at a clock time, apportioning its minutes. */
  | { kind: "split"; line: number; was: string; at: string };

/** The file changed under us. Never merged, never guessed at — re-read and retry. */
export class StaleEffortEdit extends Error {
  constructor(readonly line: number) {
    super(
      `Line ${line + 1} of this month's effort log is not what it was when you opened it. ` +
        "Nothing was changed. Close and reopen the effort table, then make the change again.",
    );
    this.name = "StaleEffortEdit";
  }
}

export interface EditOutcome {
  text: string;
  added: number;
  replaced: number;
  removed: number;
}

/** True when the edit rewrites history rather than adding to it. */
export function touchesExisting(edits: readonly EffortEdit[]): boolean {
  return edits.some((edit) => edit.kind !== "add");
}

/** Counts only — the detail string for the audit ledger carries no content (rule 7). */
export function describeEdits(outcome: EditOutcome, month: string): string {
  const parts: string[] = [];
  if (outcome.added > 0) parts.push(`${outcome.added} added`);
  if (outcome.replaced > 0) parts.push(`${outcome.replaced} changed`);
  if (outcome.removed > 0) parts.push(`${outcome.removed} removed`);
  return `${month}: ${parts.length === 0 ? "no change" : parts.join(", ")}`;
}

/**
 * Apply edits to a month file's text.
 *
 * All-or-nothing: a stale line throws before anything is written, so a batch
 * never half-applies. New rows land after the last table row rather than at the
 * end of the file, so a month annotated with prose at the bottom keeps its
 * shape.
 */
export function applyEffortEdits(text: string, edits: readonly EffortEdit[]): EditOutcome {
  // A blank file starts from nothing rather than from one empty line, so the
  // first month of the year does not open with a stray newline above its table.
  const lines = text.trim() === "" ? [] : text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();

  // Line index to its replacement lines. Absent means untouched; empty removes.
  const replacements = new Map<number, string[]>();
  const additions: string[] = [];
  let added = 0;
  let replaced = 0;
  let removed = 0;

  for (const edit of edits) {
    if (edit.kind === "add") {
      additions.push(renderEntry(edit.entry));
      added += 1;
      continue;
    }

    const current = lines[edit.line];
    if (current === undefined || current.trim() !== edit.was.trim()) {
      throw new StaleEffortEdit(edit.line);
    }
    if (replacements.has(edit.line)) {
      throw new Error("Two edits target the same line. Apply them one at a time.");
    }

    if (edit.kind === "remove") {
      replacements.set(edit.line, []);
      removed += 1;
    } else if (edit.kind === "replace") {
      replacements.set(edit.line, [renderEntry(edit.entry)]);
      replaced += 1;
    } else {
      const parsed = parseRowForSplit(current);
      const [first, second] = splitEntry(parsed, edit.at);
      replacements.set(edit.line, [renderEntry(first), renderEntry(second)]);
      replaced += 1;
      added += 1;
    }
  }

  const out: string[] = [];
  lines.forEach((line, index) => {
    const replacement = replacements.get(index);
    if (replacement === undefined) out.push(line);
    else out.push(...replacement);
  });

  if (additions.length > 0) {
    let insertAt = out.length;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (isTableRow(out[i]!.trim())) {
        insertAt = i + 1;
        break;
      }
    }
    // No table at all: the file is new or was emptied. Give it a header rather
    // than appending orphan rows nothing can parse.
    if (insertAt === out.length && !out.some((line) => isTableRow(line.trim()))) {
      out.push(...EFFORT_HEADER.split("\n"));
      insertAt = out.length;
    }
    out.splice(insertAt, 0, ...additions);
  }

  return { text: out.join("\n") + (out.length > 0 ? "\n" : ""), added, replaced, removed };
}

/**
 * Re-read the row being split from the file rather than trusting the caller's
 * copy. The `was` check has already proved the line is unchanged, so this is
 * the authoritative version of the entry the split applies to.
 */
function parseRowForSplit(line: string): TimeEntry {
  const row = parseEffortLog(`${EFFORT_HEADER}\n${line}`).rows[0];
  if (row === undefined) {
    throw new Error("That row cannot be read as a time entry, so it cannot be split.");
  }
  return row.entry;
}
