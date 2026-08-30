/**
 * When each obligation next falls due, and which of them are shouting
 * (CLAUDE.md §5.7, §7 B3).
 *
 * Pure module: no Obsidian, no Node. Everything is computed from date strings
 * against "today" as the caller's clock reads it — see `recurrence.ts` for why
 * this never touches epoch milliseconds.
 *
 * **The next occurrence is computed, not stored.** Same argument as dwell time
 * in §5.1: a date written into frontmatter is a date that can go stale, and an
 * obligation whose materialised `due` was satisfied months ago would sit on the
 * board claiming to be overdue. Materialising a computed date into the note is
 * a separate, explicit act (rule 12) — the board is right either way.
 */

import { OBLIGATION_TYPE, type EventNote } from "./event";
import { addDays, daysBetweenDates, occurrenceAfter } from "./recurrence";

/**
 * Ordered worst-first; the number is the sort key and never shown.
 *
 * `lapsed` outranks everything because §7 B3 says it must: an obligation past
 * its date with nothing recorded against it is the one thing on this board that
 * has already gone wrong. `unscheduled` sits second — a rule nobody can compute
 * a date from is a *silently* unwatched obligation, which is worse than one
 * that is merely late.
 */
const RANK = {
  lapsed: 0,
  unscheduled: 1,
  today: 2,
  soon: 3,
  upcoming: 4,
  far: 5,
  passed: 6,
} as const;

export type OccurrenceState = keyof typeof RANK;

export interface Occurrence {
  note: EventNote;
  /** The date this occurrence falls on, or "" when none could be worked out. */
  date: string;
  /** Where the date came from: written on the note, or derived from the rule. */
  source: "due" | "computed" | "none";
  state: OccurrenceState;
  /** Negative when the date has passed. Zero on the day. */
  inDays: number;
  /** The largest declared lead time that has been reached, or null. */
  leadFired: number | null;
  /** Lead times in force — the note's own, or the configured default. */
  leadDays: readonly number[];
  /** True when this belongs in front of the user right now. */
  alerting: boolean;
  /** False for anything beyond the configured horizon. */
  withinHorizon: boolean;
}

export interface ScheduleOptions {
  /** `YYYY-MM-DD` for the user's today, from `toVaultDate(Date.now())`. */
  today: string;
  horizonDays: number;
  /** Used when a note declares no `lead_days` of its own. */
  defaultLeadDays: readonly number[];
}

/**
 * The date an occurrence actually falls on.
 *
 * A written `due` wins, because someone typed it and may have moved it
 * deliberately — except once `last_completed` has caught up with it, at which
 * point that occurrence is done and the rule says where the next one is. That
 * ordering means the board self-corrects when the completion is recorded by
 * hand in the note rather than through the command.
 */
export function occurrenceDate(note: EventNote): { date: string; source: Occurrence["source"] } {
  const computed =
    note.recurrence === null ? null : occurrenceAfter(note.recurrence, note.lastCompleted);

  const dueSatisfied = note.due !== "" && note.lastCompleted !== "" && note.lastCompleted >= note.due;

  if (note.due !== "" && !dueSatisfied) return { date: note.due, source: "due" };
  if (computed !== null) return { date: computed, source: "computed" };
  if (note.due !== "") return { date: note.due, source: "due" };
  return { date: "", source: "none" };
}

function stateOf(
  note: EventNote,
  date: string,
  inDays: number,
  leadFired: number | null,
  horizonDays: number,
): OccurrenceState {
  if (date === "") return "unscheduled";
  if (inDays === 0) return "today";
  if (inDays < 0) return note.type === OBLIGATION_TYPE ? "lapsed" : "passed";
  if (leadFired !== null) return "soon";
  return inDays <= horizonDays ? "upcoming" : "far";
}

export function buildSchedule(
  notes: readonly EventNote[],
  options: ScheduleOptions,
): Occurrence[] {
  const occurrences: Occurrence[] = [];

  for (const note of notes) {
    const { date, source } = occurrenceDate(note);
    const leadDays = note.leadDays.length > 0 ? note.leadDays : options.defaultLeadDays;

    const inDays = date === "" ? 0 : (daysBetweenDates(options.today, date) ?? 0);
    // The *tightest* window entered, not the widest. With leads of 90/30/7 and
    // 20 days to go, the reminder that has just fired is the 30-day one; saying
    // "90 days" there would understate how close this now is.
    const leadFired =
      date === "" || inDays < 0
        ? null
        : (leadDays.filter((lead) => inDays <= lead).at(-1) ?? null);

    const state = stateOf(note, date, inDays, leadFired, options.horizonDays);

    occurrences.push({
      note,
      date,
      source,
      state,
      inDays,
      leadFired,
      leadDays,
      // A plain `event` in the past is history, not an alarm. Only obligations
      // lapse — that distinction is the point of having two note types.
      alerting: state === "lapsed" || state === "today" || state === "soon" || isBlindSpot(note, state),
      withinHorizon: state !== "far",
    });
  }

  return occurrences.sort(compare);
}

/**
 * An obligation the engine cannot date at all.
 *
 * Reported as an alarm rather than dropped: §5.7 exists because a lapsed
 * obligation must never be missed, and one nobody can even schedule is missed
 * the most quietly of all.
 */
function isBlindSpot(note: EventNote, state: OccurrenceState): boolean {
  return state === "unscheduled" && note.type === OBLIGATION_TYPE;
}

function compare(a: Occurrence, b: Occurrence): number {
  const rank = RANK[a.state] - RANK[b.state];
  if (rank !== 0) return rank;
  // Within "passed" the most recent is the interesting one; everywhere else
  // the earliest date is.
  if (a.date !== b.date) {
    return a.state === "passed" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
  }
  return a.note.id.localeCompare(b.note.id);
}

/** The lapsed ones — what §7 B3 calls the alarm that outranks everything. */
export function lapsed(schedule: readonly Occurrence[]): Occurrence[] {
  return schedule.filter((entry) => entry.state === "lapsed");
}

/** How many things want attention today. The status-bar badge count. */
export function alertingCount(schedule: readonly Occurrence[]): number {
  return schedule.filter((entry) => entry.alerting).length;
}

/** A one-line summary for a notice or the status bar's tooltip. */
export function describeAlerts(schedule: readonly Occurrence[]): string {
  const counts = { lapsed: 0, unscheduled: 0, today: 0, soon: 0 };
  for (const entry of schedule) {
    if (entry.state === "lapsed") counts.lapsed += 1;
    else if (entry.state === "unscheduled" && entry.note.type === OBLIGATION_TYPE) {
      counts.unscheduled += 1;
    } else if (entry.state === "today") counts.today += 1;
    else if (entry.state === "soon") counts.soon += 1;
  }

  const parts: string[] = [];
  if (counts.lapsed > 0) parts.push(`${counts.lapsed} lapsed`);
  if (counts.unscheduled > 0) parts.push(`${counts.unscheduled} with no date`);
  if (counts.today > 0) parts.push(`${counts.today} due today`);
  if (counts.soon > 0) parts.push(`${counts.soon} coming up`);
  return parts.join(", ");
}

/**
 * When each lead time for an occurrence falls, soonest last.
 *
 * Empty for anything already lapsed. An alarm dated in the past fires the
 * moment the calendar file is imported and keeps firing, which trains the user
 * to dismiss exactly the reminders §5.7 exists to make them read.
 */
export function activeLeads(occurrence: Occurrence): number[] {
  if (occurrence.date === "" || occurrence.state === "lapsed" || occurrence.state === "passed") {
    return [];
  }
  return [...occurrence.leadDays];
}

export function leadDates(occurrence: Occurrence): string[] {
  return activeLeads(occurrence)
    .map((lead) => addDays(occurrence.date, -lead))
    .filter((date): date is string => date !== null);
}

/* -------------------------------------------------------- materialising -- */

export interface MaterialisePlan {
  note: EventNote;
  /** What the note says now — "" when it carries no date. */
  from: string;
  /** What the rule computes. */
  to: string;
}

/**
 * Notes whose written `due` disagrees with the rule, and those carrying no date
 * at all.
 *
 * Offered, never applied on load. §5.7 asks the scheduler to materialise the
 * next occurrence; rule 12's principle — nothing happens by surprise — decides
 * *when*. The board already shows the computed date without writing anything,
 * so the only thing materialising adds is a date another tool can read, and
 * that is worth one confirmation.
 */
export function materialisePlan(notes: readonly EventNote[]): MaterialisePlan[] {
  const plans: MaterialisePlan[] = [];

  for (const note of notes) {
    // A derived occurrence has no file of its own; materialising one would
    // write a computed date into the note it lives inside. It has no
    // recurrence either, so the next line already excludes it — this is the
    // line that says why, and keeps saying it if recurrence ever changes.
    if (note.derivedFrom !== undefined) continue;
    if (note.recurrence === null) continue;
    const { date, source } = occurrenceDate(note);
    if (date === "" || source !== "computed") continue;
    if (date === note.due) continue;
    plans.push({ note, from: note.due, to: date });
  }

  return plans.sort((a, b) => a.to.localeCompare(b.to) || a.note.id.localeCompare(b.note.id));
}

/**
 * What completing an obligation today writes: the completion date, and the
 * occurrence after it.
 *
 * Returns `next: ""` for a one-off, which is correct — an event that has
 * happened does not get a new date, and inventing one would put a ghost on the
 * board forever.
 */
export function completion(note: EventNote, on: string): { lastCompleted: string; next: string } {
  if (note.recurrence === null) return { lastCompleted: on, next: "" };

  // Completing satisfies the occurrence currently in view, whenever it was
  // actually done. Counting only from the completion date would hand back the
  // same date again whenever a review is finished a few days early — and a
  // "next" that is the one just completed is how a year gets skipped.
  const current = occurrenceDate(note).date;
  const after = current !== "" && current > on ? current : on;

  return { lastCompleted: on, next: occurrenceAfter(note.recurrence, after) ?? "" };
}
