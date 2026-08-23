/**
 * Event and obligation notes (CLAUDE.md §5.7, §5.14) — the reader.
 *
 * Two note types, one shape. An `event` happens once and then it is history; an
 * `obligation` recurs and **lapses**, which is the whole reason §5.7 exists.
 * Keeping them in one parser keeps the deadline board honest: everything in
 * `60 Events/` carrying a date is watched, whichever word the note used.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseRecurrence, readDateField, type Recurrence } from "./recurrence";

export const EVENT_TYPE = "event";
export const OBLIGATION_TYPE = "obligation";
export const EVENT_TYPES: readonly string[] = [EVENT_TYPE, OBLIGATION_TYPE];

export interface EventNote {
  path: string;
  /** `event` or `obligation`, as written. */
  type: string;
  recurring: boolean;
  uid: string;
  /** Human label. Falls back to the file's basename so a row always has one. */
  id: string;
  title: string;
  /** `YYYY-MM-DD` as written, or "" when absent. Unreadable becomes a problem. */
  due: string;
  /** Clock times, only ever set by an imported calendar entry. */
  starts: string;
  ends: string;
  recurrence: Recurrence | null;
  /** Days before the date a reminder is wanted, largest first. */
  leadDays: number[];
  owner: string;
  study: string;
  /** §5.7 makes this required: a reminder that does not say what breaks gets ignored. */
  consequence: string;
  lastCompleted: string;
  /** `UID` of the calendar entry this came from, for dedupe on re-import. */
  icsUid: string;
  problems: string[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/**
 * Read `lead_days`.
 *
 * Sorted largest first because that is the order they fire in, and duplicates
 * are dropped: `[30, 30, 7]` is one reminder at 30 days, not two.
 */
function readLeadDays(value: unknown, problems: string[]): number[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const days: number[] = [];

  for (const item of list) {
    const n = typeof item === "number" ? item : Number.parseInt(str(item), 10);
    if (!Number.isInteger(n) || n < 0) {
      problems.push("`lead_days` must be a list of whole numbers of days.");
      return [];
    }
    if (!days.includes(n)) days.push(n);
  }

  return days.sort((a, b) => b - a);
}

export function parseEventNote(path: string, raw: Record<string, unknown>): EventNote {
  const problems: string[] = [];

  const type = str(raw["type"]);
  const recurrence = parseRecurrence(raw["recurrence"]);
  problems.push(...recurrence.problems);

  const dueRaw = raw["due"];
  const due = readDateField(dueRaw);
  if (dueRaw !== undefined && dueRaw !== null && due === "") {
    problems.push("`due` is not a readable date, so this is not being watched.");
  }

  const lastCompletedRaw = raw["last_completed"];
  const lastCompleted = readDateField(lastCompletedRaw);
  if (lastCompletedRaw !== undefined && lastCompletedRaw !== null && lastCompleted === "") {
    problems.push("`last_completed` is not a readable date and is being ignored.");
  }

  const rule = recurrence.rule;
  if (rule !== null && rule.anchor === "" && due === "") {
    // Without either there is nothing to count from, and an obligation nobody
    // is counting is exactly the failure §5.7 names.
    problems.push("`recurrence` has no `anchor` and the note has no `due`, so no date can be computed.");
  }

  const consequence = str(raw["consequence"]);
  if (type === OBLIGATION_TYPE && consequence === "") {
    problems.push("§5.7 requires `consequence` — say what breaks if this lapses.");
  }

  const id = str(raw["id"]);

  return {
    path,
    type,
    recurring: rule !== null,
    uid: str(raw["uid"]),
    id: id === "" ? basename(path) : id,
    title: str(raw["title"]),
    due,
    starts: str(raw["starts"]),
    ends: str(raw["ends"]),
    recurrence: rule,
    leadDays: readLeadDays(raw["lead_days"], problems),
    owner: str(raw["owner"]),
    study: str(raw["study"]),
    consequence,
    lastCompleted,
    icsUid: str(raw["ics_uid"]),
    problems,
  };
}

/** True when this note type belongs on the deadline board. */
export function isEventType(type: string): boolean {
  return EVENT_TYPES.includes(type);
}
