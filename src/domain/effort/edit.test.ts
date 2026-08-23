import { describe, expect, it } from "vitest";
import { applyEffortEdits, describeEdits, StaleEffortEdit, touchesExisting } from "./edit";
import { parseEffortLog, renderEffortLog, renderEntry, type TimeEntry } from "./entry";

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

const twoRows = renderEffortLog([entry(), entry({ start: "14:00", end: "15:30", mins: 90 })]);

/** The parsed row at `index`, with the line number and text an edit needs. */
function rowAt(text: string, index: number) {
  return parseEffortLog(text).rows[index]!;
}

describe("adding", () => {
  it("appends a row after the last one", () => {
    const out = applyEffortEdits(twoRows, [{ kind: "add", entry: entry({ mins: 15 }) }]);
    expect(out.added).toBe(1);
    expect(parseEffortLog(out.text).rows).toHaveLength(3);
    expect(parseEffortLog(out.text).rows[2]!.entry.mins).toBe(15);
  });

  it("keeps prose below the table below the table", () => {
    const annotated = `${twoRows}\nAudit week — expect the QC hours to be high.\n`;
    const out = applyEffortEdits(annotated, [{ kind: "add", entry: entry({ mins: 15 }) }]);
    expect(out.text.trim().endsWith("Audit week — expect the QC hours to be high.")).toBe(true);
    expect(parseEffortLog(out.text).rows).toHaveLength(3);
  });

  it("gives an empty file a header rather than an orphan row", () => {
    const out = applyEffortEdits("", [{ kind: "add", entry: entry() }]);
    expect(parseEffortLog(out.text).rows).toHaveLength(1);
    expect(out.text.startsWith("| date |")).toBe(true);
  });
});

describe("changing and removing", () => {
  it("replaces one row and leaves the other alone", () => {
    const row = rowAt(twoRows, 0);
    const out = applyEffortEdits(twoRows, [
      { kind: "replace", line: row.line, was: row.text, entry: { ...row.entry, mins: 45 } },
    ]);
    expect(out.replaced).toBe(1);
    const rows = parseEffortLog(out.text).rows;
    expect(rows.map((r) => r.entry.mins)).toEqual([45, 90]);
  });

  it("removes a row", () => {
    const row = rowAt(twoRows, 1);
    const out = applyEffortEdits(twoRows, [{ kind: "remove", line: row.line, was: row.text }]);
    expect(out.removed).toBe(1);
    expect(parseEffortLog(out.text).rows).toHaveLength(1);
  });

  it("refuses when the line is not what it was, and changes nothing", () => {
    // The user may have the month open in the editor. Writing to a line number
    // read thirty seconds ago would overwrite a row nobody meant to touch.
    const row = rowAt(twoRows, 0);
    expect(() =>
      applyEffortEdits(twoRows, [
        { kind: "remove", line: row.line, was: renderEntry(entry({ mins: 999 })) },
      ]),
    ).toThrow(StaleEffortEdit);
  });

  it("applies nothing at all when one edit in a batch is stale", () => {
    const good = rowAt(twoRows, 0);
    const stale = rowAt(twoRows, 1);
    expect(() =>
      applyEffortEdits(twoRows, [
        { kind: "remove", line: good.line, was: good.text },
        { kind: "remove", line: stale.line, was: "| nonsense |" },
      ]),
    ).toThrow(StaleEffortEdit);
  });

  it("refuses two edits to the same line", () => {
    const row = rowAt(twoRows, 0);
    expect(() =>
      applyEffortEdits(twoRows, [
        { kind: "remove", line: row.line, was: row.text },
        { kind: "replace", line: row.line, was: row.text, entry: row.entry },
      ]),
    ).toThrow(/one at a time/);
  });
});

describe("what must survive a rewrite", () => {
  it("passes through a row it cannot parse, untouched", () => {
    // Rule 8: we rewrite the whole file, so anything we do not understand has
    // to come out the other side verbatim.
    const handWritten = "| 2026-07-16 | something someone typed |";
    const messy = `${twoRows}${handWritten}\n`;
    const row = rowAt(messy, 0);
    const out = applyEffortEdits(messy, [{ kind: "remove", line: row.line, was: row.text }]);
    expect(out.text).toContain(handWritten);
  });

  it("keeps a heading and a blank line above the table", () => {
    const withHeading = `# July 2026\n\n${twoRows}`;
    const row = rowAt(withHeading, 1);
    const out = applyEffortEdits(withHeading, [{ kind: "remove", line: row.line, was: row.text }]);
    expect(out.text.startsWith("# July 2026\n\n| date |")).toBe(true);
  });
});

describe("splitting a past entry", () => {
  it("turns one row into two without changing the total", () => {
    const row = rowAt(twoRows, 1); // 14:00–15:30, 90 minutes
    const out = applyEffortEdits(twoRows, [
      { kind: "split", line: row.line, was: row.text, at: "14:30" },
    ]);
    const rows = parseEffortLog(out.text).rows;
    expect(rows).toHaveLength(3);
    expect(rows[1]!.entry).toMatchObject({ start: "14:00", end: "14:30", mins: 30 });
    expect(rows[2]!.entry).toMatchObject({ start: "14:30", end: "15:30", mins: 60 });
  });

  it("refuses a split time outside the entry", () => {
    const row = rowAt(twoRows, 1);
    expect(() =>
      applyEffortEdits(twoRows, [{ kind: "split", line: row.line, was: row.text, at: "09:00" }]),
    ).toThrow(/must fall between/);
  });
});

describe("what gets logged", () => {
  it("knows an append from a rewrite", () => {
    // A new row is the tool doing its job; rewriting recorded hours is
    // consequential, and §5.6 does not allow silent consequential actions.
    expect(touchesExisting([{ kind: "add", entry: entry() }])).toBe(false);
    expect(touchesExisting([{ kind: "remove", line: 2, was: "x" }])).toBe(true);
  });

  it("describes an edit in counts, never content", () => {
    const detail = describeEdits({ text: "", added: 1, replaced: 2, removed: 0 }, "2026-07");
    expect(detail).toBe("2026-07: 1 added, 2 changed");
    expect(detail).not.toContain("REQ-");
  });
});
