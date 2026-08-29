/**
 * The data an exported app carries with it (§5.13, §7 F3).
 *
 * §5.13: *"Export produces a self-contained HTML file in `95 Exports/` — the
 * app plus a **snapshot** of the data it was granted. Same caveat as §5.10:
 * that snapshot leaves the vault, so correspondence-derived fields stay
 * excluded by default."*
 *
 * That caveat is the whole reason this module exists rather than the exporter
 * simply serialising whatever the broker would have returned. §5.10 records a
 * deliberate decision: correspondence notes hold full message bodies and
 * attachments, which makes this vault a regulated data store rather than a
 * notebook. A board is looked at on the work laptop; an export is a file that
 * travels. The two cannot carry the same fields by default.
 *
 * What is excluded, and why each:
 *
 *  - **Correspondence notes entirely.** A thread note *is* message content.
 *    There is no useful subset of it that is safe by default.
 *  - **Correspondence-derived fields on other notes.** A request's snapshot
 *    would otherwise carry the subject line of the thread blocking it.
 *  - **Free-text body-ish fields** that exist to hold quoted material.
 *
 * Everything excluded is *reported*, not silently dropped. The dialog names
 * what was left out before the file is written, because an export that quietly
 * removes half an app's data produces a page a colleague cannot read and
 * nobody can explain.
 *
 * Pure module: no Obsidian, no Node.
 */

import { CORRESPONDENCE_TYPE } from "../comms/thread";
import type { Row } from "../query/model";

/** Note types never included in an exported snapshot by default. */
export const EXCLUDED_TYPES: readonly string[] = [CORRESPONDENCE_TYPE];

/**
 * Field ids dropped from every row.
 *
 * Matched on the whole id and on a dotted prefix, so `messages` also removes
 * `messages.0.summary` if a flattened row ever carries one.
 */
export const EXCLUDED_FIELDS: readonly string[] = [
  "messages",
  "subject",
  "thread_key",
  "body",
  "excerpt",
  "quote",
];

export interface SnapshotOptions {
  /** Types the app is granted. Nothing outside this appears, granted or not. */
  types: readonly string[];
  /** Turn off the correspondence exclusions. Off by default, per §5.10. */
  includeCorrespondence?: boolean;
}

export interface SnapshotResult {
  /** Rows by note type, ready to embed. */
  rows: Record<string, Record<string, unknown>[]>;
  /** How many rows are in the snapshot. */
  count: number;
  /** Plain-English lines naming what was left out, for the confirmation. */
  exclusions: string[];
}

function excluded(fieldId: string): boolean {
  const head = fieldId.split(".")[0] ?? fieldId;
  return EXCLUDED_FIELDS.includes(head);
}

/**
 * Build the snapshot for an export.
 *
 * Values are passed through `JSON.parse(JSON.stringify(...))` at the call site
 * by virtue of being embedded as JSON — a Date from YAML becomes an ISO
 * string, which is what a standalone page can read anyway.
 */
export function buildSnapshot(
  rows: readonly Row[],
  options: SnapshotOptions,
): SnapshotResult {
  const includeCorrespondence = options.includeCorrespondence === true;
  const wanted = new Set(options.types);
  const out: Record<string, Record<string, unknown>[]> = {};
  const exclusions: string[] = [];

  let droppedTypeRows = 0;
  const droppedTypes = new Set<string>();
  const droppedFields = new Set<string>();
  let count = 0;

  for (const row of rows) {
    if (!wanted.has(row.type)) continue;

    if (!includeCorrespondence && EXCLUDED_TYPES.includes(row.type)) {
      droppedTypeRows += 1;
      droppedTypes.add(row.type);
      continue;
    }

    const fields: Record<string, unknown> = { path: row.key };
    for (const [id, value] of Object.entries(row.fields)) {
      if (!includeCorrespondence && excluded(id)) {
        droppedFields.add(id);
        continue;
      }
      fields[id] = value;
    }

    (out[row.type] ??= []).push(fields);
    count += 1;
  }

  // A granted type with no notes is worth saying: an app that renders an empty
  // table looks broken, and "there are none" is a different fact from "they
  // were removed".
  for (const type of options.types) {
    if (out[type] === undefined && !droppedTypes.has(type)) out[type] = [];
  }

  if (droppedTypeRows > 0) {
    exclusions.push(
      `${droppedTypeRows} ${[...droppedTypes].join(", ")} note${droppedTypeRows === 1 ? "" : "s"} left out — correspondence holds message content, which does not leave the vault in an export by default (§5.10).`,
    );
  }
  if (droppedFields.size > 0) {
    exclusions.push(
      `Fields left out of every row: ${[...droppedFields].sort().join(", ")} — these can carry quoted message text.`,
    );
  }

  return { rows: out, count, exclusions };
}
