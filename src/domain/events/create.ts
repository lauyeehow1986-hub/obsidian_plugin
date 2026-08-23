/**
 * Making event and obligation notes (CLAUDE.md §5.7) — by hand, and from an
 * imported calendar.
 *
 * Both paths land on the same frontmatter, so an obligation typed into the
 * dialog and one that arrived from Outlook are the same kind of note
 * afterwards. Pure module: no Obsidian, no Node.
 */

import { ulid } from "../id/ulid";
import { EVENT_TYPE, OBLIGATION_TYPE } from "./event";
import type { ParsedIcsEvent } from "./ics";
import { parseDate, type Recurrence } from "./recurrence";

export const DEFAULT_EVENT_PREFIX = "EVT";
export const DEFAULT_OBLIGATION_PREFIX = "OBL";

export interface NewEventNote {
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Next free `PREFIX-YYYY-NNN`, from the ids already in the vault. */
export function nextEventId(
  existingIds: readonly string[],
  year: number,
  prefix: string,
): string {
  const pattern = new RegExp(`^${prefix}-${year}-(\\d+)$`, "i");
  let highest = 0;
  for (const id of existingIds) {
    const match = pattern.exec(id.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${year}-${String(highest + 1).padStart(3, "0")}`;
}

/** Anything a vault filename cannot carry. Mirrors the exporter's rule. */
export function safeFilename(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? fallback : cleaned.slice(0, 80);
}

export interface ObligationInput {
  id: string;
  title: string;
  /** `YYYY-MM-DD`, or "" to let the recurrence anchor supply it. */
  due: string;
  recurrence: Recurrence | null;
  leadDays: readonly number[];
  owner: string;
  study: string;
  consequence: string;
  now: number;
  uid?: string;
}

/**
 * A new obligation.
 *
 * `consequence` is written even when empty so the field is visibly there to be
 * filled in — §5.7 requires it, and a required field that is simply absent from
 * the template is a field nobody knows they were supposed to write.
 */
export function newObligation(input: ObligationInput): NewEventNote {
  const recurring = input.recurrence !== null;
  const frontmatter: Record<string, unknown> = {
    type: recurring ? OBLIGATION_TYPE : EVENT_TYPE,
    uid: input.uid ?? ulid(input.now),
    id: input.id,
    title: input.title.trim(),
    due: input.due === "" ? null : input.due,
    owner: input.owner.trim(),
    study: input.study.trim(),
  };

  if (input.recurrence !== null) {
    frontmatter["recurrence"] = {
      every: input.recurrence.every,
      unit: input.recurrence.unit,
      anchor: input.recurrence.anchor === "" ? input.due : input.recurrence.anchor,
    };
    frontmatter["lead_days"] = [...input.leadDays];
    frontmatter["consequence"] = input.consequence.trim();
    frontmatter["last_completed"] = null;
  }

  return {
    filename: `${safeFilename(input.id, "event")}.md`,
    frontmatter,
    body: eventBody(input.title, recurring),
  };
}

function eventBody(title: string, recurring: boolean): string {
  return [
    `# ${title.trim() === "" ? "Event" : title.trim()}`,
    "",
    recurring
      ? "The plugin reads the frontmatter above and computes the next occurrence" +
        " from the recurrence rule. Everything below is yours."
      : "The plugin reads the frontmatter above. Everything below is yours.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------- import -- */

export interface ImportedEvent {
  note: NewEventNote;
  /** The calendar UID this came from, for dedupe on a later re-import. */
  icsUid: string;
}

export interface ImportOptions {
  now: number;
  /** Ids already taken, so the allocator does not collide. */
  existingIds: readonly string[];
  prefix?: string;
  uid?: string;
}

/**
 * One imported VEVENT as an event note.
 *
 * Type is always `event`, never `obligation`. An Outlook recurrence is a
 * different model from §5.7's, and guessing a rule from `RRULE` would produce
 * an obligation whose "next occurrence" the plugin computed from an assumption
 * nobody checked. A recurring meeting can be turned into an obligation by hand
 * in a few seconds; a wrong one lapses silently.
 */
export function eventFromCalendar(
  parsed: ParsedIcsEvent,
  options: ImportOptions,
): ImportedEvent | null {
  if (parseDate(parsed.date) === null) return null;

  const year = Number(parsed.date.slice(0, 4));
  const id = nextEventId(options.existingIds, year, options.prefix ?? DEFAULT_EVENT_PREFIX);
  const title = parsed.summary === "" ? "(untitled calendar entry)" : parsed.summary;

  const frontmatter: Record<string, unknown> = {
    type: EVENT_TYPE,
    uid: options.uid ?? ulid(options.now),
    id,
    title,
    due: parsed.date,
    ics_uid: parsed.uid,
    // Says where this came from without claiming it is authoritative: the
    // mailbox is the record for a meeting, the vault is a working tracker.
    source: "calendar-import",
    imported: isoDate(options.now),
  };

  if (!parsed.allDay && parsed.startTime !== "") {
    frontmatter["starts"] = `${parsed.date}T${parsed.startTime}`;
    if (parsed.endTime !== "") frontmatter["ends"] = `${parsed.date}T${parsed.endTime}`;
  }
  if (parsed.location !== "") frontmatter["location"] = parsed.location;

  return {
    icsUid: parsed.uid,
    note: {
      filename: `${safeFilename(`${id} ${title}`, id)}.md`,
      frontmatter,
      body: importedBody(title, parsed),
    },
  };
}

function isoDate(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The imported note's body.
 *
 * The calendar entry's own description goes into the body, not the
 * frontmatter — it is prose the plugin will never read again, and frontmatter
 * is the machine-readable half of the contract (§5.1).
 */
function importedBody(title: string, parsed: ParsedIcsEvent): string {
  const lines = [`# ${title}`, ""];
  if (parsed.description !== "") {
    lines.push("## From the calendar entry", "", parsed.description, "");
  }
  lines.push("Imported from a calendar file. Nothing was sent or fetched.", "");
  return lines.join("\n");
}
