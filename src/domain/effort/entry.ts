/**
 * The effort log (CLAUDE.md §5.3) — one monthly markdown table of time entries.
 *
 *     | date       | start | end   | mins | person | ref          | activity | ... |
 *     | 2026-07-14 | 09:12 | 10:05 |   53 | yh     | REQ-2026-014 | scoping  | ... |
 *
 * Kept out of the request notes so those do not churn, and so a month of effort
 * is one readable, diffable file.
 *
 * **`mins` is stored, not derived, and that is deliberate.** With a timer that
 * pauses, the minutes worked are not the minutes between the clock times: 09:12
 * to 10:05 with a fifteen-minute interruption is 38 minutes of work in a
 * 53-minute span. Recomputing `mins` from `start` and `end` would silently
 * inflate every interrupted entry, and entries do get interrupted. So all three
 * columns are recorded, `mins` is the number that gets summed, and `mins`
 * *exceeding* the span is reported as a problem, because that one cannot happen.
 *
 * Pure module: no Obsidian, no Node.
 */

import { isTableRow, renderCells, splitCells, tableHeader, unescapeCell } from "../table/cells";

export const EFFORT_COLUMNS = [
  "date",
  "start",
  "end",
  "mins",
  "person",
  "ref",
  "activity",
  "study",
  "cost_centre",
  "note",
] as const;

export const EFFORT_HEADER = tableHeader(EFFORT_COLUMNS);

export interface TimeEntry {
  /** `YYYY-MM-DD`, local. The day the work is attributed to. */
  date: string;
  /** `HH:mm` local, or "" for an entry added by hand with only a duration. */
  start: string;
  end: string;
  /** Minutes worked. Not `end - start` when the timer was paused. */
  mins: number;
  person: string;
  /** A request id, a study, or free text. Plain text — this is a table, not a note. */
  ref: string;
  activity: string;
  study: string;
  costCentre: string;
  note: string;
}

/** One row as it sits in a file, with enough context to edit it in place. */
export interface EffortRow {
  entry: TimeEntry;
  /** 0-based index into the file's lines. */
  line: number;
  /** The line exactly as read, so an edit can refuse a file that has moved on. */
  text: string;
}

export interface EffortProblem {
  /** 1-based, to match what an editor's gutter shows. */
  line: number;
  message: string;
}

export interface ParsedEffortLog {
  rows: EffortRow[];
  problems: EffortProblem[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

/** `09:12` to 552 minutes past midnight, or null when it is not a clock time. */
export function parseClock(value: string): number | null {
  const match = CLOCK_RE.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 552 back to `09:12`. Minutes past midnight, wrapping at a day. */
export function formatClock(minutesPastMidnight: number): string {
  const wrapped = ((Math.round(minutesPastMidnight) % 1440) + 1440) % 1440;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/**
 * Minutes from `start` to `end`, or null when either is unreadable.
 *
 * An `end` earlier than `start` is read as crossing midnight rather than as an
 * error. A late extraction that finishes at 00:20 is real, and the alternative
 * — refusing the row — loses the entry rather than the ambiguity.
 */
export function clockSpan(start: string, end: string): number | null {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null) return null;
  return to >= from ? to - from : to + 1440 - from;
}

/** The month file an entry belongs in: `2026-07`. */
export function entryMonth(entry: TimeEntry): string {
  return entry.date.slice(0, 7);
}

export function renderEntry(entry: TimeEntry): string {
  return renderCells([
    entry.date,
    entry.start,
    entry.end,
    String(entry.mins),
    entry.person,
    entry.ref,
    entry.activity,
    entry.study,
    entry.costCentre,
    entry.note,
  ]);
}

/** A whole file body, for creating a month that does not exist yet. */
export function renderEffortLog(entries: readonly TimeEntry[]): string {
  return [EFFORT_HEADER, ...entries.map(renderEntry)].join("\n") + "\n";
}

function cellsToEntry(cells: readonly string[]): TimeEntry {
  const [date, start, end, mins, person, ref, activity, study, costCentre, note] = cells;
  return {
    date: date ?? "",
    start: start ?? "",
    end: end ?? "",
    mins: Number.parseInt(mins ?? "", 10),
    person: person ?? "",
    ref: ref ?? "",
    activity: activity ?? "",
    study: study ?? "",
    costCentre: costCentre ?? "",
    note: note ?? "",
  };
}

/**
 * Read a month file.
 *
 * Prose above or below the table is ignored, so a human can annotate a month.
 * A row that cannot be read is **reported and skipped, never rewritten**: this
 * is a file the user may have typed into, and rule 8 says we do not destroy
 * what we did not write. It keeps its line number so the problem can name it
 * and the edit machinery can leave it alone.
 */
export function parseEffortLog(text: string): ParsedEffortLog {
  const rows: EffortRow[] = [];
  const problems: EffortProblem[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!isTableRow(line)) return;

    const cells = splitCells(line).map(unescapeCell);
    if (cells[0] === "date" && cells[1] === "start") return; // the header row

    if (cells.length !== EFFORT_COLUMNS.length) {
      problems.push({
        line: index + 1,
        message: `Expected ${EFFORT_COLUMNS.length} columns, found ${cells.length}. Row skipped.`,
      });
      return;
    }

    const entry = cellsToEntry(cells);
    const span = clockSpan(entry.start, entry.end);

    if (!DATE_RE.test(entry.date)) {
      problems.push({ line: index + 1, message: `"${entry.date}" is not a date. Row skipped.` });
      return;
    }
    if (!Number.isFinite(entry.mins) || entry.mins < 0) {
      if (span === null) {
        problems.push({
          line: index + 1,
          message: "Minutes are unreadable and there are no clock times to derive them from. Row skipped.",
        });
        return;
      }
      // Recoverable: the clock times say what the minutes should have been.
      entry.mins = span;
      problems.push({
        line: index + 1,
        message: `Minutes were unreadable; using ${span} from the clock times. Counted, but worth fixing.`,
      });
    } else if (span !== null && entry.mins > span) {
      // Counted anyway — the user may know something we do not — but said out
      // loud, because more minutes worked than elapsed is not possible.
      problems.push({
        line: index + 1,
        message: `${entry.mins} minutes recorded in a ${span}-minute span. Counted as written.`,
      });
    }

    rows.push({ entry, line: index, text: line });
  });

  return { rows, problems };
}

/**
 * Split an entry at a clock time, apportioning the recorded minutes.
 *
 * `mins` is apportioned by span rather than recomputed, so **the total does not
 * change**. Splitting a 90-minute entry must not turn it into 120 minutes
 * because the timer had been paused: that total is the number that ends up in a
 * chargeback statement, and a UI action that quietly changes it is a way to
 * bill for time nobody worked.
 */
export function splitEntry(entry: TimeEntry, at: string): [TimeEntry, TimeEntry] {
  const start = parseClock(entry.start);
  const cut = parseClock(at);
  const total = clockSpan(entry.start, entry.end);

  if (start === null || cut === null || total === null) {
    throw new Error("An entry can only be split when it has readable start and end times.");
  }
  const offset = cut >= start ? cut - start : cut + 1440 - start;
  if (offset <= 0 || offset >= total) {
    throw new Error(`The split time must fall between ${entry.start} and ${entry.end}.`);
  }

  const firstMins = Math.round((entry.mins * offset) / total);
  return [
    { ...entry, end: at, mins: firstMins },
    { ...entry, start: at, mins: entry.mins - firstMins },
  ];
}

/**
 * Everything wrong with an entry, in plain English, before it is written.
 *
 * Returns reasons rather than throwing, so the dialog shows them all at once
 * instead of one per attempt.
 */
export function validateEntry(entry: TimeEntry, knownActivities: readonly string[]): string[] {
  const reasons: string[] = [];

  if (!DATE_RE.test(entry.date)) reasons.push(`"${entry.date}" is not a date (YYYY-MM-DD).`);
  if (entry.start !== "" && parseClock(entry.start) === null) {
    reasons.push(`"${entry.start}" is not a time (HH:mm).`);
  }
  if (entry.end !== "" && parseClock(entry.end) === null) {
    reasons.push(`"${entry.end}" is not a time (HH:mm).`);
  }
  if (!Number.isInteger(entry.mins) || entry.mins < 0) {
    reasons.push("Minutes must be a whole number, and not negative.");
  } else if (entry.mins === 0) {
    reasons.push("An entry of zero minutes records nothing. Discard it instead.");
  }

  const span = clockSpan(entry.start, entry.end);
  if (span !== null && Number.isInteger(entry.mins) && entry.mins > span) {
    reasons.push(
      `${entry.mins} minutes cannot fit in the ${span} minutes from ${entry.start} to ${entry.end}.`,
    );
  }
  if (entry.activity.trim() === "") {
    reasons.push("An activity is required — an uncategorised hour cannot be rolled up.");
  } else if (knownActivities.length > 0 && !knownActivities.includes(entry.activity)) {
    reasons.push(
      `"${entry.activity}" is not in the activity vocabulary (${knownActivities.join(", ")}).`,
    );
  }
  if (entry.person.trim() === "") reasons.push("A person is required.");

  return reasons;
}
