import { describe, expect, it } from "vitest";
import {
  compareToEstimate,
  filterEntries,
  formatMinutes,
  hoursOf,
  rollUp,
  rollUpCsv,
  totalMins,
  UNSET_LABEL,
} from "./aggregate";
import type { TimeEntry } from "./entry";

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    date: "2026-07-14",
    start: "09:00",
    end: "10:00",
    mins: 60,
    person: "yh",
    ref: "REQ-2026-014",
    activity: "extraction",
    study: "EuroHeart",
    costCentre: "RC-2026-07",
    note: "",
    ...overrides,
  };
}

const month = [
  entry({ mins: 53, activity: "scoping" }),
  entry({ mins: 90, activity: "extraction" }),
  entry({ mins: 30, activity: "extraction", person: "coord-b" }),
  entry({ mins: 45, activity: "rework", date: "2026-07-15", study: "", costCentre: "" }),
];

describe("rollUp", () => {
  it("sums minutes into buckets, biggest first", () => {
    expect(rollUp(month, "activity")).toEqual([
      { key: "extraction", label: "extraction", mins: 120, count: 2 },
      { key: "scoping", label: "scoping", mins: 53, count: 1 },
      { key: "rework", label: "rework", mins: 45, count: 1 },
    ]);
  });

  it("names the empty bucket rather than dropping it", () => {
    // A roll-up whose columns do not sum to the total is one nobody can check,
    // and "45 minutes against no cost centre" is a finding about the log.
    const centres = rollUp(month, "cost_centre");
    expect(centres.map((bucket) => bucket.label)).toContain(UNSET_LABEL);
    expect(centres.reduce((sum, bucket) => sum + bucket.mins, 0)).toBe(totalMins(month));
  });

  it("keeps a time series in date order, not size order", () => {
    expect(rollUp(month, "date").map((bucket) => bucket.key)).toEqual(["2026-07-14", "2026-07-15"]);
    expect(rollUp(month, "month").map((bucket) => bucket.key)).toEqual(["2026-07"]);
  });

  it("counts entries as well as minutes", () => {
    // Six hours from one entry reads differently from six hours from twelve.
    expect(rollUp(month, "person").find((b) => b.key === "yh")).toMatchObject({
      mins: 188,
      count: 3,
    });
  });

  it("returns nothing for no entries rather than failing", () => {
    expect(rollUp([], "activity")).toEqual([]);
    expect(totalMins([])).toBe(0);
  });
});

describe("filterEntries", () => {
  it("filters on an inclusive date range", () => {
    expect(filterEntries(month, { from: "2026-07-15" })).toHaveLength(1);
    expect(filterEntries(month, { to: "2026-07-14" })).toHaveLength(3);
    expect(filterEntries(month, { from: "2026-07-14", to: "2026-07-15" })).toHaveLength(4);
  });

  it("matches a reference regardless of case, and ignores blank filters", () => {
    expect(filterEntries(month, { ref: "req-2026-014" })).toHaveLength(4);
    expect(filterEntries(month, { person: "", study: "" })).toHaveLength(4);
  });
});

describe("compareToEstimate", () => {
  it("says how far over the estimate the work has run", () => {
    const over = compareToEstimate(6, 8 * 60);
    expect(over.state).toBe("over");
    expect(over.overBy).toBe(120);
    expect(over.text).toContain("2h over");
  });

  it("warns before the overrun, not after it", () => {
    // The useful moment is while you can still tell the requester.
    expect(compareToEstimate(6, 5 * 60).state).toBe("at-risk");
    expect(compareToEstimate(6, 2 * 60).state).toBe("under");
  });

  it("says plainly when there is nothing to compare against", () => {
    const none = compareToEstimate(null, 120);
    expect(none.state).toBe("no-estimate");
    expect(none.overBy).toBeNull();
    expect(none.text).toContain("No estimate");
  });

  it("treats a zero or nonsense estimate as no estimate", () => {
    expect(compareToEstimate(0, 60).state).toBe("no-estimate");
    expect(compareToEstimate(Number.NaN, 60).state).toBe("no-estimate");
  });

  it("does not read as a reprimand", () => {
    // A tool that scolds is a tool whose timer stops being started.
    const text = compareToEstimate(6, 12 * 60).text;
    expect(text).not.toMatch(/late|overrun|failed|too (long|slow)/i);
  });
});

describe("formatting and export", () => {
  it("says minutes the way a person would", () => {
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(390)).toBe("6h 30m");
    expect(hoursOf(390)).toBe(6.5);
  });

  it("emits both minutes and hours, and a total row", () => {
    // Deriving one from the other in a spreadsheet is where a rounding
    // argument with a finance office starts.
    const csv = rollUpCsv(rollUp(month, "activity"), "activity");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Activity,entries,minutes,hours");
    expect(lines[1]).toBe("extraction,2,120,2");
    expect(lines[lines.length - 1]).toBe("Total,4,218,3.63");
  });
});
