import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import { runQuery } from "./evaluate";
import { csvCell, formatCell, markdownCell, toCsv, toMarkdownTable } from "./format";
import { emptyQuery, type FieldDef, type Query, type Row } from "./model";

const NOW = Date.UTC(2026, 6, 24);

const FIELDS: FieldDef[] = [
  { id: "id", label: "ID", kind: "text" },
  { id: "title", label: "Title", kind: "text" },
  { id: "blocked_on", label: "Waiting on", kind: "link" },
  { id: "dwell", label: "In stage", kind: "duration" },
  { id: "due", label: "Due", kind: "date" },
];

const ROWS: Row[] = [
  {
    key: "a.md",
    type: "scdb-request",
    fields: {
      id: "REQ-001",
      title: 'Cohort, "readmission" | 30-day',
      blocked_on: "[[Dr A Tan]]",
      dwell: 26 * DAY_MS,
      due: "2026-07-20",
    },
  },
  {
    key: "b.md",
    type: "scdb-request",
    fields: { id: "REQ-002", title: "Baseline pull", blocked_on: null, dwell: null, due: null },
  },
];

const QUERY: Query = { ...emptyQuery(), columns: ["id", "title", "blocked_on", "dwell", "due"] };

describe("cells", () => {
  it("renders durations for a human and dates as ISO", () => {
    expect(formatCell(26 * DAY_MS, "duration", NOW)).toBe("26 days");
    expect(formatCell("2026-07-20", "date", NOW)).toBe("2026-07-20");
  });

  it("shows a link as the note wrote it, not lower-cased", () => {
    expect(formatCell("[[Dr A Tan]]", "link", NOW)).toBe("[[Dr A Tan]]");
  });

  it("renders missing as blank, never as 0 or false", () => {
    expect(formatCell(null, "duration", NOW)).toBe("");
    expect(formatCell(null, "number", NOW)).toBe("");
    expect(formatCell(undefined, "boolean", NOW)).toBe("");
  });
});

describe("CSV", () => {
  it("quotes to RFC 4180 and doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", now')).toBe('"say ""hi"", now"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("writes a header and CRLF line endings", () => {
    const csv = toCsv(runQuery(ROWS, QUERY, FIELDS, { now: NOW }), { now: NOW });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("ID,Title,Waiting on,In stage,Due");
    expect(lines[1]).toBe('REQ-001,"Cohort, ""readmission"" | 30-day",[[Dr A Tan]],26 days,2026-07-20');
    expect(lines[2]).toBe("REQ-002,Baseline pull,,,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("can carry a machine-readable duration beside the human one", () => {
    const csv = toCsv(runQuery(ROWS, QUERY, FIELDS, { now: NOW }), { now: NOW, rawDurations: true });
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("In stage,In stage (ms)");
    expect(lines[1]).toContain(`26 days,${26 * DAY_MS}`);
    // A missing duration stays missing in both columns rather than becoming 0.
    expect(lines[2]).toBe("REQ-002,Baseline pull,,,,");
  });

  it("adds a group column only when the result is grouped", () => {
    const grouped: Query = { ...QUERY, group: { field: "blocked_on", direction: "asc" } };
    const csv = toCsv(runQuery(ROWS, grouped, FIELDS, { now: NOW }), { now: NOW });
    expect(csv.split("\r\n")[0]).toBe("Group,ID,Title,Waiting on,In stage,Due");
  });
});

describe("markdown", () => {
  it("escapes a pipe rather than breaking the row", () => {
    expect(markdownCell("a | b")).toBe("a \\| b");
    const table = toMarkdownTable(runQuery(ROWS, QUERY, FIELDS, { now: NOW }), { now: NOW });
    expect(table).toContain("Cohort, \"readmission\" \\| 30-day");
  });

  it("right-aligns the numeric kinds", () => {
    const table = toMarkdownTable(runQuery(ROWS, QUERY, FIELDS, { now: NOW }), { now: NOW });
    expect(table.split("\n")[1]).toBe("| --- | --- | --- | ---: | --- |");
  });

  it("writes a heading per group and a totals line", () => {
    const grouped: Query = {
      ...QUERY,
      group: { field: "blocked_on", direction: "asc" },
      aggregates: [{ fn: "count" }],
    };
    const table = toMarkdownTable(runQuery(ROWS, grouped, FIELDS, { now: NOW }), { now: NOW });
    expect(table).toContain("### Dr A Tan");
    expect(table).toContain("### No waiting on");
    expect(table).toContain("Count: 1");
    expect(table).toContain("**All rows** — Count: 2");
  });

  it("says when it is showing only part of the result", () => {
    const limited: Query = { ...QUERY, limit: 1, sort: [{ field: "id", direction: "asc" }] };
    const table = toMarkdownTable(runQuery(ROWS, limited, FIELDS, { now: NOW }), { now: NOW });
    expect(table).toContain("_Showing 1 of 2 matching notes._");
  });
});
