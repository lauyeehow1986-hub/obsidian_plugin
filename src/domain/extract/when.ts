/**
 * Reading a date out of a sentence somebody typed in a meeting (§7 B6).
 *
 * Minutes do not carry ISO dates. They say "by Friday", "end of the month",
 * "chase before 15 Sep". B6 is explicitly *rules and regex only*, so this
 * module is a fixed, documented set of patterns — no model, no learning, no
 * surprises — and everything it finds is shown to the user before a note is
 * written, because a date read out of prose is a reading, not a fact.
 *
 * Three rules shape all of it:
 *
 *  1. **Everything resolves against the meeting's own date, never today.**
 *     Extracting last month's minutes must not turn "by Friday" into this
 *     week. With no anchor the relative forms refuse rather than guess.
 *  2. **`03/04/2026` is refused, not parsed.** It is 3 April to the writer and
 *     4 March to an American colleague, and there is nothing in the text to
 *     settle it. A deadline that is a month wrong is worse than one the user
 *     had to type.
 *  3. **How it was read travels with the answer.** `from: "weekday"` is a
 *     different kind of claim from `from: "iso"`, and the review dialog says
 *     which, so a guess never looks like a transcription.
 *
 * Calendar arithmetic runs on `CalendarDate` strings rather than epoch
 * milliseconds: these are whole days, and a day is not always 24 hours.
 *
 * Pure module: no Obsidian, no Node.
 */

import { addDays, daysBetweenDates, daysInMonth, formatDate, parseDate } from "../events/recurrence";

/** How a date was arrived at. Ordered most to least literal. */
export type DueSource = "iso" | "written" | "weekday" | "relative";

export interface DueDate {
  /** `YYYY-MM-DD`. */
  date: string;
  from: DueSource;
  /** The words it was read out of, so the review dialog can show its working. */
  phrase: string;
}

export interface WhenResult {
  due: DueDate | null;
  /** The sentence with the date clause lifted out, so the title reads cleanly. */
  rest: string;
  /** Anything noticed but not resolved. Shown; never silently dropped. */
  problems: string[];
}

const MONTH_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|" +
  "aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const WEEKDAY_PATTERN =
  "sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?";

const ISO = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;

/** "15 Sep", "15th September 2026". */
const DAY_FIRST = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})\.?(?:,?\s+(\d{4}))?\b`,
  "i",
);

/** "Sep 15", "September 15th, 2026". */
const MONTH_FIRST = new RegExp(
  String.raw`\b(${MONTH_PATTERN})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`,
  "i",
);

/**
 * A weekday only counts when a preposition makes it a deadline.
 *
 * "Discussed on Tuesday" and "Tuesday's minutes" are not due dates, and a
 * parser that treats every weekday as one produces a deadline per paragraph.
 */
const WEEKDAY = new RegExp(
  String.raw`\b(?:by|before|due(?:\s+by)?|on|no\s+later\s+than)\s+(?:next\s+|this\s+|the\s+)?(${WEEKDAY_PATTERN})\b`,
  "i",
);

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
};

const IN_N = new RegExp(
  String.raw`\b(?:in|within)\s+(\d{1,2}|a|an|one|two|three|four|five|six)\s+(day|week|month)s?\b`,
  "i",
);

/** Numeric slash dates, which this refuses on purpose. See rule 2 above. */
const SLASHED = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;

/** Words that introduce a date and are left behind once the date is lifted out. */
const TRAILING_PREPOSITION =
  /(?:\s*[—–\-,(]\s*)?\b(?:by|before|due(?:\s+by)?|deadline|target(?:ed)?(?:\s+for)?|no\s+later\s+than|on|for)\b\s*$/i;

interface Hit {
  index: number;
  length: number;
  date: string;
  from: DueSource;
}

function monthNumber(word: string): number {
  return MONTH_INDEX[word.slice(0, 3).toLowerCase()] ?? 0;
}

function build(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return formatDate({ year, month, day });
}

/**
 * The year for a date written without one.
 *
 * Assume the meeting's year; if that lands the date more than 60 days before
 * the meeting, it meant the year after. The slack is deliberate — an action
 * about something that happened a fortnight ago is ordinary, an action due
 * eleven months in the past is a misread year.
 */
function inferYear(anchor: string, month: number, day: number): string | null {
  const anchorDate = parseDate(anchor);
  if (anchorDate === null) return null;

  const sameYear = build(anchorDate.year, month, day);
  if (sameYear === null) {
    // 29 February in a non-leap year: try the following year before giving up.
    return build(anchorDate.year + 1, month, day);
  }
  const offset = daysBetweenDates(anchor, sameYear);
  if (offset !== null && offset < -60) return build(anchorDate.year + 1, month, day);
  return sameYear;
}

function weekdayOf(date: string): number {
  const parsed = parseDate(date);
  if (parsed === null) return -1;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

/**
 * The next named weekday strictly after the anchor.
 *
 * Strictly: "by Friday" said in a Friday meeting means the Friday coming, not
 * the one you are sitting in. Erring later leaves an action that is merely
 * early; erring earlier creates one that is overdue the moment it is written.
 */
function nextWeekday(anchor: string, target: number): string | null {
  const current = weekdayOf(anchor);
  if (current < 0) return null;
  const ahead = ((target - current + 7) % 7) || 7;
  return addDays(anchor, ahead);
}

function endOfWeek(anchor: string): string | null {
  const current = weekdayOf(anchor);
  if (current < 0) return null;
  // Friday on or after the anchor. A Saturday or Sunday "end of the week"
  // belongs to the week that has not finished starting, so it rolls forward.
  const ahead = current === 5 ? 0 : ((5 - current + 7) % 7) || 7;
  return addDays(anchor, ahead);
}

function endOfMonth(anchor: string): string | null {
  const parsed = parseDate(anchor);
  if (parsed === null) return null;
  return build(parsed.year, parsed.month, daysInMonth(parsed.year, parsed.month));
}

/** Matchers that need no anchor, tried first because they say the most. */
function absoluteHit(text: string, anchor: string | null, problems: string[]): Hit | null {
  const iso = ISO.exec(text);
  if (iso) {
    const date = build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (date === null) problems.push(`"${iso[0]}" is not a real date, so no deadline was set.`);
    else return { index: iso.index, length: iso[0].length, date, from: "iso" };
  }

  for (const [pattern, dayAt, monthAt] of [
    [DAY_FIRST, 1, 2],
    [MONTH_FIRST, 2, 1],
  ] as const) {
    const match = pattern.exec(text);
    if (!match) continue;
    const month = monthNumber(match[monthAt]!);
    const day = Number(match[dayAt]);
    const written = match[3];
    const date =
      written !== undefined
        ? build(Number(written), month, day)
        : anchor === null
          ? null
          : inferYear(anchor, month, day);

    if (date === null) {
      problems.push(
        written === undefined && anchor === null
          ? `"${match[0]}" has no year and these minutes carry no date, so the year could not be worked out.`
          : `"${match[0]}" is not a real date, so no deadline was set.`,
      );
      continue;
    }
    return { index: match.index, length: match[0].length, date, from: "written" };
  }

  return null;
}

/** Matchers that only mean something relative to the meeting's own date. */
function relativeHit(text: string, anchor: string): Hit | null {
  const weekday = WEEKDAY.exec(text);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]!.slice(0, 3).toLowerCase()];
    const date = target === undefined ? null : nextWeekday(anchor, target);
    if (date !== null) {
      return { index: weekday.index, length: weekday[0].length, date, from: "weekday" };
    }
  }

  const phrases: [RegExp, () => string | null][] = [
    [/\btomorrow\b/i, () => addDays(anchor, 1)],
    [/\btoday\b/i, () => anchor],
    [/\bend of (?:the )?week\b/i, () => endOfWeek(anchor)],
    [/\bend of (?:the |this )?month\b/i, () => endOfMonth(anchor)],
    [/\bnext week\b/i, () => addDays(anchor, 7)],
    [/\bthis week\b/i, () => endOfWeek(anchor)],
  ];

  for (const [pattern, resolve] of phrases) {
    const match = pattern.exec(text);
    if (!match) continue;
    const date = resolve();
    if (date !== null) {
      return { index: match.index, length: match[0].length, date, from: "relative" };
    }
  }

  const inN = IN_N.exec(text);
  if (inN) {
    const word = inN[1]!.toLowerCase();
    const count = NUMBER_WORDS[word] ?? Number(word);
    const unit = inN[2]!.toLowerCase();
    const days = unit === "day" ? count : unit === "week" ? count * 7 : count * 30;
    const date = Number.isFinite(days) ? addDays(anchor, days) : null;
    if (date !== null) {
      return { index: inN.index, length: inN[0].length, date, from: "relative" };
    }
  }

  return null;
}

/** True when the text uses a form that would have resolved had there been an anchor. */
function wantsAnchor(text: string): boolean {
  return (
    WEEKDAY.test(text) ||
    IN_N.test(text) ||
    /\b(?:tomorrow|today|end of (?:the )?(?:week|month)|next week|this week)\b/i.test(text)
  );
}

function tidy(text: string): string {
  return text
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
}

/** Lift the matched phrase, and the preposition that introduced it, out of the text. */
function without(text: string, hit: Hit): string {
  const before = text.slice(0, hit.index).replace(TRAILING_PREPOSITION, "");
  return tidy(`${before} ${text.slice(hit.index + hit.length)}`);
}

/**
 * Read a due date out of one line.
 *
 * `anchor` is the meeting's date as `YYYY-MM-DD`, or null when the note does
 * not say. Absolute dates still resolve without it; everything relative
 * refuses and says why.
 */
export function readWhen(text: string, anchor: string | null): WhenResult {
  const problems: string[] = [];
  const hit =
    absoluteHit(text, anchor, problems) ?? (anchor === null ? null : relativeHit(text, anchor));

  if (hit !== null) {
    return {
      due: { date: hit.date, from: hit.from, phrase: text.slice(hit.index, hit.index + hit.length) },
      rest: without(text, hit),
      problems,
    };
  }

  if (anchor === null && wantsAnchor(text)) {
    problems.push(
      "This line sets a deadline relative to the meeting, but the minutes carry no date. " +
        "Add `date: YYYY-MM-DD` to the note, or set the deadline by hand below.",
    );
  }

  const slashed = SLASHED.exec(text);
  if (slashed) {
    problems.push(
      `"${slashed[0]}" could be either day-first or month-first, so no deadline was set. ` +
        "Write it as YYYY-MM-DD, or set it by hand below.",
    );
  }

  return { due: null, rest: tidy(text), problems };
}
