import { describe, expect, it } from "vitest";
import {
  clockSpan,
  entryMonth,
  formatClock,
  parseClock,
  parseEffortLog,
  renderEffortLog,
  renderEntry,
  splitEntry,
  validateEntry,
  type TimeEntry,
} from "./entry";
import { ACTIVITIES } from "./vocabulary";

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    date: "2026-07-14",
    start: "09:12",
    end: "10:05",
    mins: 53,
    person: "yh",
    ref: "REQ-2026-014",
    activity: "scoping",
    study: "EuroHeart",
    costCentre: "RC-2026-07",
    note: "",
    ...overrides,
  };
}

describe("clock times", () => {
  it("reads and writes HH:mm", () => {
    expect(parseClock("09:12")).toBe(552);
    expect(formatClock(552)).toBe("09:12");
    expect(parseClock("9:12")).toBe(552);
  });

  it("refuses times that are not times", () => {
    for (const bad of ["", "0912", "24:00", "09:60", "nine", "09:12:30"]) {
      expect(parseClock(bad)).toBeNull();
    }
  });

  it("reads an end before a start as crossing midnight", () => {
    // A late extraction finishing at 00:20 is real. Refusing the row would lose
    // the entry rather than the ambiguity.
    expect(clockSpan("23:40", "00:20")).toBe(40);
    expect(clockSpan("09:00", "10:30")).toBe(90);
  });
});

describe("the month table", () => {
  it("round-trips an entry", () => {
    const text = renderEffortLog([entry()]);
    const { rows, problems } = parseEffortLog(text);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry).toEqual(entry());
  });

  it("survives a note containing a pipe and a newline", () => {
    // The note is free text a human typed. A raw pipe would split the row.
    const awkward = entry({ note: "asked A | B, then\nchased" });
    const { rows } = parseEffortLog(renderEffortLog([awkward]));
    expect(rows[0]!.entry.note).toBe("asked A | B, then\nchased");
  });

  it("ignores prose above and below the table", () => {
    const text = `# July\n\nBusy month.\n\n${renderEffortLog([entry()])}\nNotes: nothing else.\n`;
    expect(parseEffortLog(text).rows).toHaveLength(1);
  });

  it("does not read the header row as an entry", () => {
    expect(parseEffortLog(renderEffortLog([])).rows).toEqual([]);
  });

  it("keeps the raw line and its index, so an edit can address it", () => {
    const text = renderEffortLog([entry(), entry({ mins: 90, end: "11:00" })]);
    const rows = parseEffortLog(text).rows;
    expect(rows.map((row) => row.line)).toEqual([2, 3]);
    expect(rows[0]!.text).toBe(renderEntry(entry()));
  });

  it("skips a row with the wrong number of columns and says which line", () => {
    const text = `${renderEffortLog([entry()])}| 2026-07-15 | 09:00 |\n`;
    const { rows, problems } = parseEffortLog(text);
    expect(rows).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.line).toBe(4);
    expect(problems[0]!.message).toContain("found 2");
  });

  it("recovers unreadable minutes from the clock times rather than dropping the row", () => {
    const text = renderEffortLog([entry()]).replace("| 53 |", "|  |");
    const { rows, problems } = parseEffortLog(text);
    expect(rows[0]!.entry.mins).toBe(53);
    expect(problems[0]!.message).toContain("using 53");
  });

  it("drops a row whose minutes and clock times are both unreadable", () => {
    const text = renderEffortLog([entry({ start: "", end: "", mins: Number.NaN })]);
    const { rows, problems } = parseEffortLog(text);
    expect(rows).toEqual([]);
    expect(problems[0]!.message).toContain("unreadable");
  });

  it("counts minutes that exceed the span, but says so", () => {
    // More minutes worked than elapsed cannot happen. Counted as written — the
    // user may know something we do not — and never silently.
    const { rows, problems } = parseEffortLog(renderEffortLog([entry({ mins: 90 })]));
    expect(rows[0]!.entry.mins).toBe(90);
    expect(problems[0]!.message).toContain("53-minute span");
  });

  it("does not recompute minutes from the clock times", () => {
    // The whole reason `mins` is a column: 09:12–10:05 with a 15-minute
    // interruption is 38 minutes of work in a 53-minute span.
    const paused = entry({ mins: 38 });
    const { rows, problems } = parseEffortLog(renderEffortLog([paused]));
    expect(rows[0]!.entry.mins).toBe(38);
    expect(problems).toEqual([]);
  });

  it("names the month a row belongs to", () => {
    expect(entryMonth(entry())).toBe("2026-07");
  });
});

describe("splitEntry", () => {
  it("splits the span and apportions the minutes", () => {
    const [first, second] = splitEntry(entry({ start: "09:00", end: "11:00", mins: 120 }), "10:00");
    expect(first).toMatchObject({ start: "09:00", end: "10:00", mins: 60 });
    expect(second).toMatchObject({ start: "10:00", end: "11:00", mins: 60 });
  });

  it("keeps the total exactly, even when the timer had been paused", () => {
    // 90 minutes worked in a 120-minute span. Splitting must not invent the 30
    // minutes back: that total ends up on a chargeback line.
    const [first, second] = splitEntry(entry({ start: "09:00", end: "11:00", mins: 90 }), "10:00");
    expect(first.mins + second.mins).toBe(90);
  });

  it("refuses a split time outside the entry", () => {
    const subject = entry({ start: "09:00", end: "11:00", mins: 120 });
    expect(() => splitEntry(subject, "08:00")).toThrow(/between 09:00 and 11:00/);
    expect(() => splitEntry(subject, "11:00")).toThrow(/between/);
  });

  it("refuses to split an entry with no clock times", () => {
    expect(() => splitEntry(entry({ start: "", end: "" }), "10:00")).toThrow(/readable start/);
  });
});

describe("validateEntry", () => {
  const vocab = [...ACTIVITIES];

  it("passes a good entry", () => {
    expect(validateEntry(entry(), vocab)).toEqual([]);
  });

  it("refuses an activity outside the vocabulary", () => {
    const reasons = validateEntry(entry({ activity: "pulling data" }), vocab);
    expect(reasons.join(" ")).toContain("not in the activity vocabulary");
  });

  it("refuses an entry of no minutes", () => {
    expect(validateEntry(entry({ mins: 0 }), vocab).join(" ")).toContain("zero minutes");
  });

  it("refuses minutes that cannot fit the span", () => {
    expect(validateEntry(entry({ mins: 90 }), vocab).join(" ")).toContain("cannot fit");
  });

  it("allows an entry with no clock times at all", () => {
    // Added by hand, hours later, from memory. That is the retroactive case B2
    // exists for, and refusing it would push the user back to a spreadsheet.
    expect(validateEntry(entry({ start: "", end: "", mins: 45 }), vocab)).toEqual([]);
  });

  it("reports every reason at once", () => {
    const reasons = validateEntry(
      entry({ date: "14/07/2026", person: "", activity: "", mins: -1 }),
      vocab,
    );
    expect(reasons.length).toBeGreaterThanOrEqual(4);
  });
});
