/**
 * Effort roll-ups and estimate-vs-actual (CLAUDE.md §7 B2, §5.3).
 *
 * One schema, four purposes: `person` + `activity` gives FTE justification,
 * `ref` against the estimate gives better quoting, `study` + `cost_centre`
 * gives chargeback, and the daily roll-up gives personal focus. All four are
 * the same group-and-sum over the same rows, which is why this module is small
 * and why the effort log has the columns it has.
 *
 * Pure module: no Obsidian, no Node.
 */

import { csvCell } from "../query/format";
import { entryMonth, type TimeEntry } from "./entry";

export const EFFORT_DIMENSIONS = [
  "person",
  "activity",
  "study",
  "cost_centre",
  "ref",
  "date",
  "month",
] as const;
export type EffortDimension = (typeof EFFORT_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<EffortDimension, string> = {
  person: "Person",
  activity: "Activity",
  study: "Study",
  cost_centre: "Cost centre",
  ref: "Reference",
  date: "Day",
  month: "Month",
};

/** The bucket an entry falls in. Blank cells are named rather than dropped. */
export function dimensionValue(entry: TimeEntry, dimension: EffortDimension): string {
  switch (dimension) {
    case "person":
      return entry.person;
    case "activity":
      return entry.activity;
    case "study":
      return entry.study;
    case "cost_centre":
      return entry.costCentre;
    case "ref":
      return entry.ref;
    case "date":
      return entry.date;
    case "month":
      return entryMonth(entry);
  }
}

/**
 * The label for an empty bucket.
 *
 * Named, never silently merged into a neighbour and never dropped: "38 hours
 * against no cost centre" is a finding about the log, and a roll-up whose
 * columns do not sum to the total is a roll-up nobody can check.
 */
export const UNSET_LABEL = "(unset)";

export interface RollUpBucket {
  /** The raw value, or "" for the unset bucket. */
  key: string;
  label: string;
  mins: number;
  /** How many entries went into it. A 6-hour bucket from one entry reads differently. */
  count: number;
}

export function totalMins(entries: readonly TimeEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.mins, 0);
}

/**
 * Group and sum.
 *
 * Sorted by minutes descending — the question is always "where did the time
 * go", and the answer should be the first row — except for `date` and `month`,
 * which are chronological because a time series sorted by size is unreadable.
 */
export function rollUp(
  entries: readonly TimeEntry[],
  dimension: EffortDimension,
): RollUpBucket[] {
  const buckets = new Map<string, RollUpBucket>();

  for (const entry of entries) {
    const key = dimensionValue(entry, dimension).trim();
    const existing = buckets.get(key);
    if (existing) {
      existing.mins += entry.mins;
      existing.count += 1;
    } else {
      buckets.set(key, {
        key,
        label: key === "" ? UNSET_LABEL : key,
        mins: entry.mins,
        count: 1,
      });
    }
  }

  const rows = [...buckets.values()];
  if (dimension === "date" || dimension === "month") {
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  return rows.sort((a, b) => b.mins - a.mins || a.label.localeCompare(b.label));
}

export interface EffortFilter {
  /** Inclusive `YYYY-MM-DD` bounds. */
  from?: string;
  to?: string;
  person?: string;
  study?: string;
  activity?: string;
  /** Matched case-insensitively against `ref`, whole value. */
  ref?: string;
}

export function filterEntries(
  entries: readonly TimeEntry[],
  filter: EffortFilter,
): TimeEntry[] {
  const same = (a: string, b: string | undefined) =>
    b === undefined || b === "" || a.trim().toLowerCase() === b.trim().toLowerCase();

  return entries.filter(
    (entry) =>
      (filter.from === undefined || entry.date >= filter.from) &&
      (filter.to === undefined || entry.date <= filter.to) &&
      same(entry.person, filter.person) &&
      same(entry.study, filter.study) &&
      same(entry.activity, filter.activity) &&
      same(entry.ref, filter.ref),
  );
}

/** Minutes as a person would say them: `45m`, `6h`, `6h 30m`. */
export function formatMinutes(mins: number): string {
  const whole = Math.round(mins);
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
}

/** Hours to two decimals, for a CSV that goes into a spreadsheet. */
export function hoursOf(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

/* --------------------------------------------------- estimate vs actual -- */

export type EstimateState = "no-estimate" | "under" | "at-risk" | "over";

export interface EstimateComparison {
  estimateMins: number | null;
  actualMins: number;
  /** Minutes past the estimate. Negative means there is headroom. */
  overBy: number | null;
  state: EstimateState;
  /** One sentence for a request card. Never accusatory — it is an estimate. */
  text: string;
}

/**
 * Where the actual sits against `effort_estimate_hours` (§5.1).
 *
 * `at-risk` at four fifths, because the useful moment is *before* the overrun,
 * not after: B2 asks for this on the request "the moment it exceeds the
 * estimate", and the moment it exceeds is the moment it is too late to say so
 * to the requester.
 *
 * The wording is deliberately flat. An estimate that turned out low is
 * information about the estimate as often as about the work, and a tool that
 * reads as a reprimand is a tool whose timer stops being started.
 */
export function compareToEstimate(
  estimateHours: number | null,
  actualMins: number,
): EstimateComparison {
  if (estimateHours === null || !Number.isFinite(estimateHours) || estimateHours <= 0) {
    return {
      estimateMins: null,
      actualMins,
      overBy: null,
      state: "no-estimate",
      text:
        actualMins === 0
          ? "No time recorded, and no estimate to compare it against."
          : `${formatMinutes(actualMins)} recorded. No estimate to compare it against.`,
    };
  }

  const estimateMins = Math.round(estimateHours * 60);
  const overBy = actualMins - estimateMins;
  const state: EstimateState =
    overBy > 0 ? "over" : actualMins >= estimateMins * 0.8 ? "at-risk" : "under";

  const of = `of ${formatMinutes(estimateMins)} estimated`;
  const text =
    state === "over"
      ? `${formatMinutes(actualMins)} recorded, ${formatMinutes(overBy)} over the ${formatMinutes(estimateMins)} estimated.`
      : state === "at-risk"
        ? `${formatMinutes(actualMins)} ${of} — close to the estimate.`
        : `${formatMinutes(actualMins)} ${of}.`;

  return { estimateMins, actualMins, overBy, state, text };
}

/* --------------------------------------------------------------- export -- */

/**
 * A roll-up as CSV, for the spreadsheet a finance office will ask for.
 *
 * Both minutes and hours are emitted. Minutes are what was recorded and hours
 * are what a chargeback line is quoted in; deriving one from the other in a
 * spreadsheet is where a rounding argument starts.
 */
export function rollUpCsv(buckets: readonly RollUpBucket[], dimension: EffortDimension): string {
  const header = [DIMENSION_LABELS[dimension], "entries", "minutes", "hours"].join(",");
  const rows = buckets.map((bucket) =>
    [csvCell(bucket.label), String(bucket.count), String(bucket.mins), String(hoursOf(bucket.mins))].join(
      ",",
    ),
  );
  const total = buckets.reduce(
    (acc, bucket) => ({ count: acc.count + bucket.count, mins: acc.mins + bucket.mins }),
    { count: 0, mins: 0 },
  );
  rows.push([csvCell("Total"), String(total.count), String(total.mins), String(hoursOf(total.mins))].join(","));
  return [header, ...rows].join("\n") + "\n";
}
