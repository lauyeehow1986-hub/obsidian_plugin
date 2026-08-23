/**
 * Recurring obligations (CLAUDE.md §5.7) — the next-occurrence computation.
 *
 * Pure module: no Obsidian, no Node.
 *
 * **Everything here works on `YYYY-MM-DD` strings, never on epoch
 * milliseconds.** An annual review due on 31 March is due on 31 March in every
 * timezone; routing it through a timestamp would let a UTC-midnight parse and a
 * local-midnight format disagree by a day, and a governance deadline that moves
 * by a day depending on where the laptop is sitting is not a deadline. Date
 * strings in this format also compare correctly with `<`, so ordering is free.
 *
 * **Occurrences are always counted from the anchor, never from the previous
 * result.** Stepping forward from each computed date would let a clamped month
 * end drift permanently: 31 January + 1 month = 28 February, and the next step
 * from *there* would give 28 March, so an obligation anchored to month end
 * would wander to the 28th and stay there. Counting `anchor + k × interval`
 * from the anchor each time means the clamp applies to that occurrence only.
 */

export const RECURRENCE_UNITS = ["day", "week", "month", "year"] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

export interface Recurrence {
  every: number;
  unit: RecurrenceUnit;
  /** `YYYY-MM-DD` the sequence counts from, or "" when the note gave none. */
  anchor: string;
}

/** How far ahead the search will look before giving up. */
const MAX_STEPS = 4000;

/* ------------------------------------------------------------ calendar -- */

export interface CalendarDate {
  year: number;
  /** 1–12, not the 0–11 that `Date` uses. */
  month: number;
  day: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Read `YYYY-MM-DD`, rejecting a date the calendar does not have. */
export function parseDate(value: string): CalendarDate | null {
  const match = DATE_RE.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function formatDate(date: CalendarDate): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;
}

/** Days since the epoch. Only ever used for differences, never for display. */
function dayNumber(date: CalendarDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier.
 *
 * Calendar days, computed in UTC so no daylight-saving transition can make a
 * day 23 or 25 hours long and round the answer away.
 */
export function daysBetweenDates(from: string, to: string): number | null {
  const a = parseDate(from);
  const b = parseDate(to);
  if (a === null || b === null) return null;
  return dayNumber(b) - dayNumber(a);
}

/** `date` shifted by `days`, as a date string. */
export function addDays(date: string, days: number): string | null {
  const parsed = parseDate(date);
  if (parsed === null) return null;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return formatDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/* ---------------------------------------------------------- the rule -- */

export interface RecurrenceParse {
  rule: Recurrence | null;
  problems: string[];
}

function readDateish(value: unknown): string {
  // The same field arrives as a string through Obsidian's metadata cache and as
  // a `Date` through a YAML parse, because YAML promotes an unquoted date.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ""
      : formatDate({
          year: value.getUTCFullYear(),
          month: value.getUTCMonth() + 1,
          day: value.getUTCDate(),
        });
  }
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  // A YAML timestamp may carry a time; the day is all a recurrence needs.
  const head = trimmed.slice(0, 10);
  return parseDate(head) === null ? "" : head;
}

/** The `YYYY-MM-DD` a frontmatter date field means, or "" when unreadable. */
export function readDateField(value: unknown): string {
  return readDateish(value);
}

/**
 * Read a `recurrence:` mapping.
 *
 * Refuses rather than guesses. A rule the plugin half-understood would produce
 * a next date nobody could account for, and §5.7 exists because a missed
 * obligation has consequences the note itself is required to state.
 */
export function parseRecurrence(value: unknown): RecurrenceParse {
  if (value === undefined || value === null) return { rule: null, problems: [] };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { rule: null, problems: ["`recurrence` is not a mapping like { every: 1, unit: year }."] };
  }

  const raw = value as Record<string, unknown>;
  const problems: string[] = [];

  const everyRaw = raw["every"];
  const every =
    typeof everyRaw === "number"
      ? everyRaw
      : typeof everyRaw === "string"
        ? Number.parseInt(everyRaw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(every) || every < 1) {
    problems.push("`recurrence.every` must be a whole number of one or more.");
  }

  const unitRaw = typeof raw["unit"] === "string" ? raw["unit"].trim().toLowerCase() : "";
  // "years" reads naturally and costs nothing to accept.
  const unit = (unitRaw.endsWith("s") ? unitRaw.slice(0, -1) : unitRaw) as RecurrenceUnit;
  if (!(RECURRENCE_UNITS as readonly string[]).includes(unit)) {
    problems.push(`\`recurrence.unit\` must be one of ${RECURRENCE_UNITS.join(", ")}.`);
  }

  const anchor = readDateish(raw["anchor"]);
  if (raw["anchor"] !== undefined && anchor === "") {
    problems.push("`recurrence.anchor` is not a readable date.");
  }

  if (problems.length > 0) return { rule: null, problems };
  return { rule: { every, unit, anchor }, problems };
}

/* ------------------------------------------------------ the next date -- */

/** `anchor` advanced by `times` whole intervals. Month ends clamp, never roll. */
export function addInterval(anchor: string, rule: Recurrence, times: number): string | null {
  const base = parseDate(anchor);
  if (base === null) return null;
  if (times === 0) return formatDate(base);

  if (rule.unit === "day" || rule.unit === "week") {
    const step = rule.every * (rule.unit === "week" ? 7 : 1);
    return addDays(anchor, step * times);
  }

  const stepMonths = rule.every * (rule.unit === "year" ? 12 : 1);
  const total = base.year * 12 + (base.month - 1) + stepMonths * times;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  // 31 January + 1 month is 28 February, not 3 March. Rolling over would move
  // a month-end obligation into the following month and quietly change which
  // month it belongs to.
  return formatDate({ year, month, day: Math.min(base.day, daysInMonth(year, month)) });
}

/**
 * The first occurrence strictly after `after`, or the anchor itself when
 * nothing has been completed yet.
 *
 * An anchor in the past with no completion recorded therefore returns a date in
 * the past, and that is the intended answer — §5.7's whole point is that the
 * lapsed obligation is the one that must never be silently dropped.
 */
export function occurrenceAfter(rule: Recurrence, after: string): string | null {
  if (parseDate(rule.anchor) === null) return null;
  if (after === "" || parseDate(after) === null) return rule.anchor;

  const first = estimateSteps(rule, after);
  // The estimate is exact for days and weeks and within a step or two for
  // months and years, where clamping makes the arithmetic non-uniform. Walk
  // from just below it rather than trusting it.
  for (let k = Math.max(0, first - 2); k < Math.max(0, first) + MAX_STEPS; k++) {
    const candidate = addInterval(rule.anchor, rule, k);
    if (candidate === null) return null;
    if (candidate > after) return candidate;
  }
  return null;
}

/** Roughly how many intervals separate the anchor from `after`. Never exact. */
function estimateSteps(rule: Recurrence, after: string): number {
  const anchor = parseDate(rule.anchor)!;
  const target = parseDate(after)!;

  if (rule.unit === "day" || rule.unit === "week") {
    const step = rule.every * (rule.unit === "week" ? 7 : 1);
    return Math.floor((dayNumber(target) - dayNumber(anchor)) / step);
  }

  const stepMonths = rule.every * (rule.unit === "year" ? 12 : 1);
  const months = (target.year - anchor.year) * 12 + (target.month - anchor.month);
  return Math.floor(months / stepMonths);
}

/** How the recurrence reads in a sentence: "every 2 years". */
export function describeRecurrence(rule: Recurrence): string {
  const unit = rule.every === 1 ? rule.unit : `${rule.unit}s`;
  return rule.every === 1 ? `every ${rule.unit}` : `every ${rule.every} ${unit}`;
}
