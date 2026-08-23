import { describe, expect, it } from "vitest";
import {
  addDays,
  addInterval,
  daysBetweenDates,
  daysInMonth,
  describeRecurrence,
  formatDate,
  occurrenceAfter,
  parseDate,
  parseRecurrence,
  readDateField,
  type Recurrence,
} from "./recurrence";

const yearly: Recurrence = { every: 1, unit: "year", anchor: "2026-03-31" };

describe("parseDate", () => {
  it("reads a well-formed date", () => {
    expect(parseDate("2026-03-31")).toEqual({ year: 2026, month: 3, day: 31 });
  });

  it("refuses a date the calendar does not have", () => {
    // V8 reads 2026-02-30 as 2 March. A recurrence anchored on a date that
    // silently moved is a deadline nobody can account for.
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-13-01")).toBeNull();
    expect(parseDate("2026-00-10")).toBeNull();
  });

  it("accepts 29 February in a leap year and refuses it otherwise", () => {
    expect(parseDate("2028-02-29")).not.toBeNull();
    expect(parseDate("2027-02-29")).toBeNull();
  });

  it("round-trips through formatDate", () => {
    expect(formatDate(parseDate("2026-01-05")!)).toBe("2026-01-05");
  });
});

describe("daysInMonth", () => {
  it("handles the century rule", () => {
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
  });
});

describe("daysBetweenDates", () => {
  it("counts calendar days, not 24-hour periods", () => {
    // Late March in Europe is a 23-hour day. Counting in UTC keeps it one day.
    expect(daysBetweenDates("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetweenDates("2026-10-24", "2026-10-26")).toBe(2);
  });

  it("crosses a year end", () => {
    expect(daysBetweenDates("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("is negative looking backwards", () => {
    expect(daysBetweenDates("2026-08-23", "2026-08-01")).toBe(-22);
  });

  it("returns null rather than guessing at an unreadable date", () => {
    expect(daysBetweenDates("not a date", "2026-08-01")).toBeNull();
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("addInterval", () => {
  it("adds whole years", () => {
    expect(addInterval("2026-03-31", yearly, 1)).toBe("2027-03-31");
    expect(addInterval("2026-03-31", yearly, 4)).toBe("2030-03-31");
  });

  it("clamps a month end rather than rolling into the next month", () => {
    const monthly: Recurrence = { every: 1, unit: "month", anchor: "2026-01-31" };
    expect(addInterval("2026-01-31", monthly, 1)).toBe("2026-02-28");
    expect(addInterval("2026-01-31", monthly, 3)).toBe("2026-04-30");
  });

  it("does not let the clamp drift", () => {
    // The point of counting from the anchor: February pulls the date back to
    // the 28th for that occurrence only, and March returns to the 31st.
    const monthly: Recurrence = { every: 1, unit: "month", anchor: "2026-01-31" };
    expect(addInterval("2026-01-31", monthly, 2)).toBe("2026-03-31");
  });

  it("lands 29 February on 28 February in a common year", () => {
    const rule: Recurrence = { every: 1, unit: "year", anchor: "2028-02-29" };
    expect(addInterval("2028-02-29", rule, 1)).toBe("2029-02-28");
    expect(addInterval("2028-02-29", rule, 4)).toBe("2032-02-29");
  });

  it("adds days and weeks", () => {
    expect(addInterval("2026-08-23", { every: 10, unit: "day", anchor: "" }, 3)).toBe("2026-09-22");
    expect(addInterval("2026-08-23", { every: 2, unit: "week", anchor: "" }, 2)).toBe("2026-09-20");
  });

  it("returns the anchor for zero intervals", () => {
    expect(addInterval("2026-03-31", yearly, 0)).toBe("2026-03-31");
  });
});

describe("occurrenceAfter", () => {
  it("returns the anchor itself when nothing has been completed", () => {
    // §5.7: an anchor in the past with no completion recorded is overdue, and
    // saying so is the entire purpose of the obligation type.
    expect(occurrenceAfter(yearly, "")).toBe("2026-03-31");
    expect(occurrenceAfter({ every: 1, unit: "year", anchor: "2019-01-01" }, "")).toBe("2019-01-01");
  });

  it("steps past everything already completed", () => {
    expect(occurrenceAfter(yearly, "2026-03-18")).toBe("2026-03-31");
    expect(occurrenceAfter(yearly, "2026-03-31")).toBe("2027-03-31");
    expect(occurrenceAfter(yearly, "2029-06-01")).toBe("2030-03-31");
  });

  it("honours a multi-year interval", () => {
    const biennial: Recurrence = { every: 2, unit: "year", anchor: "2025-11-01" };
    expect(occurrenceAfter(biennial, "2025-11-01")).toBe("2027-11-01");
    expect(occurrenceAfter(biennial, "2028-01-01")).toBe("2029-11-01");
  });

  it("is exact for a long run of short intervals", () => {
    const weekly: Recurrence = { every: 1, unit: "week", anchor: "2020-01-06" };
    // 2020-01-06 is a Monday; 340 weeks later is still a Monday.
    expect(occurrenceAfter(weekly, "2026-07-13")).toBe("2026-07-20");
  });

  it("returns null when the anchor is unreadable", () => {
    expect(occurrenceAfter({ every: 1, unit: "year", anchor: "" }, "")).toBeNull();
    expect(occurrenceAfter({ every: 1, unit: "year", anchor: "2026-02-30" }, "")).toBeNull();
  });

  it("ignores an unreadable completion date rather than skipping the occurrence", () => {
    expect(occurrenceAfter(yearly, "last spring")).toBe("2026-03-31");
  });
});

describe("parseRecurrence", () => {
  it("reads the shape §5.7 documents", () => {
    const parsed = parseRecurrence({ every: 1, unit: "year", anchor: "2026-03-31" });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rule).toEqual({ every: 1, unit: "year", anchor: "2026-03-31" });
  });

  it("reads an anchor that YAML promoted to a Date", () => {
    // The same field arrives as a string through the metadata cache and as a
    // Date through a YAML parse. Both must give the same day.
    const parsed = parseRecurrence({ every: 1, unit: "year", anchor: new Date("2026-03-31") });
    expect(parsed.rule?.anchor).toBe("2026-03-31");
  });

  it("accepts a plural unit", () => {
    expect(parseRecurrence({ every: 2, unit: "years", anchor: "2026-01-01" }).rule?.unit).toBe("year");
  });

  it("returns no rule and no complaint when there is no recurrence", () => {
    expect(parseRecurrence(undefined)).toEqual({ rule: null, problems: [] });
    expect(parseRecurrence(null)).toEqual({ rule: null, problems: [] });
  });

  it("refuses rather than guesses", () => {
    expect(parseRecurrence({ every: 0, unit: "year" }).rule).toBeNull();
    expect(parseRecurrence({ every: 1, unit: "fortnight" }).rule).toBeNull();
    expect(parseRecurrence("every year").rule).toBeNull();
    expect(parseRecurrence({ every: 1, unit: "year", anchor: "soon" }).problems).toContain(
      "`recurrence.anchor` is not a readable date.",
    );
  });

  it("allows a rule with no anchor, so the note's own due date can seed it", () => {
    const parsed = parseRecurrence({ every: 3, unit: "month" });
    expect(parsed.problems).toEqual([]);
    expect(parsed.rule).toEqual({ every: 3, unit: "month", anchor: "" });
  });
});

describe("readDateField", () => {
  it("reads strings, Dates and timestamps down to the day", () => {
    expect(readDateField("2026-08-23")).toBe("2026-08-23");
    expect(readDateField(new Date("2026-08-23"))).toBe("2026-08-23");
    expect(readDateField("2026-08-23T09:15")).toBe("2026-08-23");
  });

  it("gives back nothing for what it cannot read", () => {
    expect(readDateField("next Tuesday")).toBe("");
    expect(readDateField(undefined)).toBe("");
    expect(readDateField(42)).toBe("");
  });
});

describe("describeRecurrence", () => {
  it("reads as a sentence", () => {
    expect(describeRecurrence({ every: 1, unit: "year", anchor: "" })).toBe("every year");
    expect(describeRecurrence({ every: 2, unit: "year", anchor: "" })).toBe("every 2 years");
    expect(describeRecurrence({ every: 6, unit: "month", anchor: "" })).toBe("every 6 months");
  });
});
