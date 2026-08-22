import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import {
  coerce,
  comparator,
  computeAggregate,
  groupKey,
  linkTarget,
  parseDurationToken,
  resolveDate,
  runQuery,
  testNode,
} from "./evaluate";
import {
  andGroup,
  condition,
  emptyQuery,
  operatorsFor,
  validateQuery,
  type FieldDef,
  type Query,
  type Row,
} from "./model";

const NOW = Date.UTC(2026, 6, 24, 9, 0, 0); // 2026-07-24T09:00Z

const FIELDS: FieldDef[] = [
  { id: "id", label: "ID", kind: "text" },
  { id: "stage", label: "Stage", kind: "text" },
  { id: "blocked_on", label: "Waiting on", kind: "link" },
  { id: "studies", label: "Studies", kind: "list" },
  { id: "due", label: "Due", kind: "date" },
  { id: "dwell", label: "In stage", kind: "duration" },
  { id: "sla_days", label: "SLA days", kind: "number" },
  { id: "completed", label: "Complete", kind: "boolean" },
];

const CATALOGUE = new Map(FIELDS.map((field) => [field.id, field]));

function row(key: string, fields: Record<string, unknown>): Row {
  return { key, type: "scdb-request", fields };
}

const ROWS: Row[] = [
  row("a.md", {
    id: "REQ-001",
    stage: "awaiting-approval",
    blocked_on: "[[Dr A Tan]]",
    studies: ["[[EuroHeart]]", "[[Registry X]]"],
    due: "2026-07-20",
    dwell: 26 * DAY_MS,
    sla_days: 14,
    completed: false,
  }),
  row("b.md", {
    id: "REQ-002",
    stage: "triage",
    blocked_on: null,
    studies: ["[[EuroHeart]]"],
    due: "2026-08-30",
    dwell: 2 * DAY_MS,
    sla_days: 3,
    completed: false,
  }),
  row("c.md", {
    id: "REQ-003",
    stage: "delivered",
    blocked_on: "",
    studies: [],
    due: null,
    dwell: null,
    sla_days: null,
    completed: true,
  }),
];

describe("value coercion", () => {
  it("reads a wikilink as its target, alias and all", () => {
    expect(linkTarget("[[Dr A Tan|Tan]]")).toBe("Dr A Tan");
    expect(linkTarget("  [[EuroHeart]] ")).toBe("EuroHeart");
    expect(linkTarget("plain text")).toBe("plain text");
  });

  it("treats a numeric string as a number, not a string", () => {
    // The bug this prevents: "21" sorting between 2 and 3.
    expect(coerce("21", "number", NOW)).toBe(21);
    expect(coerce(21, "number", NOW)).toBe(21);
  });

  it("keeps missing distinct from zero", () => {
    expect(coerce(null, "number", NOW)).toBeNull();
    expect(coerce("", "text", NOW)).toBeNull();
    expect(coerce([], "list", NOW)).toBeNull();
    expect(coerce(0, "number", NOW)).toBe(0);
  });

  it("reads durations written by hand", () => {
    expect(parseDurationToken("14d")).toBe(14 * DAY_MS);
    expect(parseDurationToken("2w")).toBe(14 * DAY_MS);
    expect(parseDurationToken("36h")).toBe(36 * 3_600_000);
    expect(parseDurationToken("1209600000")).toBe(14 * DAY_MS);
    expect(parseDurationToken("soonish")).toBeNull();
  });

  it("resolves relative dates against now, so a saved view keeps meaning", () => {
    expect(resolveDate("today", NOW)).toBe(Date.UTC(2026, 6, 24));
    expect(resolveDate("now", NOW)).toBe(NOW);
    expect(resolveDate("-14d", NOW)).toBe(Date.UTC(2026, 6, 10));
    expect(resolveDate("+2w", NOW)).toBe(Date.UTC(2026, 7, 7));
    expect(resolveDate("2026-01-02", NOW)).toBe(Date.UTC(2026, 0, 2));
    expect(resolveDate("never", NOW)).toBeNull();
  });
});

describe("filtering", () => {
  const match = (node: Parameters<typeof testNode>[1]): string[] =>
    ROWS.filter((r) => testNode(r, node, CATALOGUE, NOW)).map((r) => String(r.fields["id"]));

  it("matches text case-insensitively", () => {
    expect(match(andGroup([condition("stage", "is", "AWAITING-APPROVAL")]))).toEqual(["REQ-001"]);
  });

  it("matches a link by its target", () => {
    expect(match(andGroup([condition("blocked_on", "is", "Dr A Tan")]))).toEqual(["REQ-001"]);
  });

  it("treats an empty string and a null the same way", () => {
    expect(match(andGroup([condition("blocked_on", "empty")]))).toEqual(["REQ-002", "REQ-003"]);
  });

  it("never matches a missing value with a comparison operator", () => {
    // REQ-003 has no due date. It is not "due before today"; it is unknown.
    expect(match(andGroup([condition("due", "lt", "today")]))).toEqual(["REQ-001"]);
    // And "is not delivered" must not sweep in notes with no stage at all.
    const noStage = row("d.md", { id: "REQ-004" });
    expect(testNode(noStage, andGroup([condition("stage", "is-not", "delivered")]), CATALOGUE, NOW)).toBe(
      false,
    );
  });

  it("compares durations written as tokens", () => {
    expect(match(andGroup([condition("dwell", "gt", "2w")]))).toEqual(["REQ-001"]);
  });

  it("searches inside a list", () => {
    expect(match(andGroup([condition("studies", "has", "Registry X")]))).toEqual(["REQ-001"]);
    expect(match(andGroup([condition("studies", "has", "EuroHeart")]))).toEqual([
      "REQ-001",
      "REQ-002",
    ]);
  });

  it("combines with OR, which is the thing Bases cannot do", () => {
    const node = andGroup([
      {
        kind: "group",
        combine: "or",
        negate: false,
        clauses: [condition("stage", "is", "triage"), condition("dwell", "gt", "3w")],
      },
    ]);
    expect(match(node)).toEqual(["REQ-001", "REQ-002"]);
  });

  it("negates a whole group", () => {
    const node: Parameters<typeof testNode>[1] = {
      kind: "group",
      combine: "or",
      negate: true,
      clauses: [condition("stage", "is", "triage")],
    };
    expect(match(node)).toEqual(["REQ-001", "REQ-003"]);
  });

  it("treats an empty group as no filter, so a half-built UI shows everything", () => {
    expect(match(andGroup([]))).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });

  it("matches nothing on an unknown field rather than everything", () => {
    expect(match(andGroup([condition("nonesuch", "is", "x")]))).toEqual([]);
  });
});

describe("sorting", () => {
  it("sorts missing values last in both directions", () => {
    const asc = [...ROWS].sort(comparator([{ field: "dwell", direction: "asc" }], CATALOGUE, NOW));
    expect(asc.map((r) => r.fields["id"])).toEqual(["REQ-002", "REQ-001", "REQ-003"]);

    const desc = [...ROWS].sort(comparator([{ field: "dwell", direction: "desc" }], CATALOGUE, NOW));
    expect(desc.map((r) => r.fields["id"])).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });

  it("falls through to the next sort key", () => {
    const sorted = [...ROWS].sort(
      comparator(
        [
          { field: "completed", direction: "asc" },
          { field: "dwell", direction: "desc" },
        ],
        CATALOGUE,
        NOW,
      ),
    );
    expect(sorted.map((r) => r.fields["id"])).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
  });
});

describe("grouping", () => {
  const dueField = FIELDS.find((f) => f.id === "due")!;

  it("buckets dates by month and year", () => {
    const target = ROWS[0]!;
    expect(groupKey(target, { field: "due", direction: "asc", bucket: "month" }, dueField, NOW)).toBe(
      "2026-07",
    );
    expect(groupKey(target, { field: "due", direction: "asc", bucket: "year" }, dueField, NOW)).toBe(
      "2026",
    );
    expect(groupKey(target, { field: "due", direction: "asc", bucket: "day" }, dueField, NOW)).toBe(
      "2026-07-20",
    );
  });

  it("puts the no-value bucket last whichever way it sorts", () => {
    for (const direction of ["asc", "desc"] as const) {
      const query: Query = {
        ...emptyQuery(),
        group: { field: "blocked_on", direction },
      };
      const result = runQuery(ROWS, query, FIELDS, { now: NOW });
      expect(result.groups[result.groups.length - 1]?.key).toBe("");
      expect(result.groups[result.groups.length - 1]?.label).toBe("No waiting on");
    }
  });
});

describe("aggregates", () => {
  it("counts rows, including ones with no value", () => {
    expect(computeAggregate(ROWS, { fn: "count" }, CATALOGUE, NOW).value).toBe(3);
  });

  it("excludes missing values from a mean rather than treating them as zero", () => {
    // Two rows have a dwell; the third has none. The mean is over two.
    const avg = computeAggregate(ROWS, { fn: "avg", field: "dwell" }, CATALOGUE, NOW);
    expect(avg.value).toBe(14 * DAY_MS);
    expect(avg.kind).toBe("duration");
  });

  it("computes median and p90 with the standard interpolated definition", () => {
    const rows = [1, 2, 3, 4, 10].map((n, i) => row(`${i}.md`, { sla_days: n }));
    expect(computeAggregate(rows, { fn: "median", field: "sla_days" }, CATALOGUE, NOW).value).toBe(3);
    // R: quantile(c(1,2,3,4,10), 0.9, type = 7) == 7.6
    expect(computeAggregate(rows, { fn: "p90", field: "sla_days" }, CATALOGUE, NOW).value).toBeCloseTo(
      7.6,
      10,
    );
  });

  it("returns null rather than zero when nothing has a value", () => {
    const rows = [row("x.md", { dwell: null })];
    expect(computeAggregate(rows, { fn: "sum", field: "dwell" }, CATALOGUE, NOW).value).toBeNull();
  });

  it("names itself when no label is given", () => {
    expect(computeAggregate(ROWS, { fn: "median", field: "dwell" }, CATALOGUE, NOW).label).toBe(
      "Median In stage",
    );
    expect(
      computeAggregate(ROWS, { fn: "median", field: "dwell", label: "Typical wait" }, CATALOGUE, NOW)
        .label,
    ).toBe("Typical wait");
  });
});

describe("runQuery", () => {
  it("reports matched separately from returned when limited", () => {
    const query: Query = { ...emptyQuery(), limit: 1, sort: [{ field: "id", direction: "asc" }] };
    const result = runQuery(ROWS, query, FIELDS, { now: NOW });
    expect(result.matched).toBe(3);
    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("aggregates over every match, not only the page shown", () => {
    const query: Query = {
      ...emptyQuery(),
      limit: 1,
      aggregates: [{ fn: "count" }],
      sort: [{ field: "id", direction: "asc" }],
    };
    const result = runQuery(ROWS, query, FIELDS, { now: NOW });
    expect(result.totals[0]?.value).toBe(3);
    expect(result.groups[0]?.aggregates[0]?.value).toBe(1);
  });

  it("filters by note type", () => {
    const other = { ...row("p.md", { id: "PUB-1" }), type: "publication" };
    const query: Query = { ...emptyQuery(["publication"]) };
    const result = runQuery([...ROWS, other], query, FIELDS, { now: NOW });
    expect(result.matched).toBe(1);
  });

  it("reports an unknown group field instead of dropping the rows", () => {
    const query: Query = { ...emptyQuery(), group: { field: "nonesuch", direction: "asc" } };
    const result = runQuery(ROWS, query, FIELDS, { now: NOW });
    expect(result.problems).toHaveLength(1);
    expect(result.groups[0]?.rows).toHaveLength(3);
  });
});

describe("validation", () => {
  it("refuses an operator the field kind cannot use", () => {
    const query: Query = { ...emptyQuery(), where: andGroup([condition("due", "contains", "x")]) };
    expect(validateQuery(query, FIELDS)).toEqual([
      '"Due" is a date field and cannot use "contains".',
    ]);
  });

  it("names an unknown field", () => {
    const query: Query = { ...emptyQuery(), columns: ["nope"] };
    expect(validateQuery(query, FIELDS)).toEqual(['Unknown field "nope".']);
  });

  it("wants a value for an operator that needs one, and none for one that does not", () => {
    const missing: Query = { ...emptyQuery(), where: andGroup([condition("stage", "is", "")]) };
    expect(validateQuery(missing, FIELDS)).toEqual(['"Stage" is needs a value.']);

    const nullary: Query = { ...emptyQuery(), where: andGroup([condition("stage", "empty")]) };
    expect(validateQuery(nullary, FIELDS)).toEqual([]);
  });

  it("wants two values for between", () => {
    const query: Query = {
      ...emptyQuery(),
      where: andGroup([condition("sla_days", "between", [1])]),
    };
    expect(validateQuery(query, FIELDS)).toEqual(['"SLA days" between needs exactly two values.']);
  });

  it("offers only sensible operators per kind", () => {
    expect(operatorsFor("boolean")).toEqual(["is-true", "is-false", "empty", "not-empty"]);
    expect(operatorsFor("duration")).not.toContain("contains");
  });
});
