import { describe, expect, it } from "vitest";
import { andGroup, condition, emptyQuery, type Query } from "./model";
import { parseQuery, parseSavedView, queryToPlain, savedViewFrontmatter } from "./savedView";

describe("reading a saved view someone typed by hand", () => {
  it("reads all / any / not as and / or / negate", () => {
    const problems: string[] = [];
    const query = parseQuery(
      {
        types: ["scdb-request"],
        where: {
          all: [
            { field: "blocked_on", op: "not-empty" },
            { any: [{ field: "sla_state", op: "is", value: "breached" }, { field: "dwell", op: "gt", value: "2w" }] },
            { not: { any: [{ field: "stage", op: "is", value: "delivered" }] } },
          ],
        },
      },
      problems,
    );

    expect(problems).toEqual([]);
    expect(query.where?.combine).toBe("and");
    expect(query.where?.clauses).toHaveLength(3);
    expect(query.where?.clauses[1]).toMatchObject({ kind: "group", combine: "or", negate: false });
    expect(query.where?.clauses[2]).toMatchObject({ kind: "group", combine: "or", negate: true });
  });

  it("wraps a bare condition so `where` need not be a group", () => {
    const problems: string[] = [];
    const query = parseQuery({ where: { field: "hat", op: "is", value: "hod" } }, problems);
    expect(problems).toEqual([]);
    expect(query.where?.combine).toBe("and");
    expect(query.where?.clauses[0]).toMatchObject({ kind: "condition", field: "hat" });
  });

  it("names what it could not read instead of throwing", () => {
    const problems: string[] = [];
    const query = parseQuery(
      {
        where: { all: [{ field: "stage", op: "sort-of-is", value: "x" }, { op: "is", value: "y" }] },
        sort: [{ direction: "desc" }],
        group: { field: "received", bucket: "fortnight" },
        aggregates: [{ fn: "stddev", field: "dwell" }],
        limit: "lots",
      },
      problems,
    );

    expect(problems).toEqual([
      'Filter on "stage" has an unrecognised operator "sort-of-is".',
      "A filter clause has no `field`.",
      "A sort entry has no `field`.",
      'Unrecognised group bucket "fortnight"; grouping on the raw value.',
      'Unrecognised aggregate "stddev".',
      "`limit: lots` is not a whole number of rows; ignoring it.",
    ]);
    // Everything readable still came through.
    expect(query.where?.clauses).toHaveLength(0);
    expect(query.group).toMatchObject({ field: "received", direction: "asc" });
    expect(query.group?.bucket).toBeUndefined();
    expect(query.limit).toBeNull();
  });

  it("keeps a date operand as written, so the view means the same next month", () => {
    const query = parseQuery({ where: { field: "due", op: "lt", value: "today" } }, []);
    expect(query.where?.clauses[0]).toMatchObject({ value: "today" });
  });
});

describe("round trip", () => {
  const query: Query = {
    types: ["scdb-request"],
    where: andGroup([
      condition("blocked_on", "not-empty"),
      {
        kind: "group",
        combine: "or",
        negate: true,
        clauses: [condition("stage", "one-of", ["delivered", "withdrawn"])],
      },
    ]),
    sort: [{ field: "dwell", direction: "desc" }],
    group: { field: "blocked_on", direction: "asc" },
    aggregates: [{ fn: "count" }, { fn: "median", field: "dwell", label: "Typical wait" }],
    columns: ["id", "title", "dwell"],
    limit: 50,
  };

  it("survives write then read unchanged", () => {
    const problems: string[] = [];
    expect(parseQuery(queryToPlain(query), problems)).toEqual(query);
    expect(problems).toEqual([]);
  });

  it("writes only the keys that carry something", () => {
    expect(queryToPlain(emptyQuery())).toEqual({});
  });

  it("produces frontmatter a person can read", () => {
    const frontmatter = savedViewFrontmatter({
      id: "VIEW-holdup",
      title: "Waiting on someone",
      description: "",
      hat: "hod",
      query,
    });
    expect(frontmatter["type"]).toBe("scdb-view");
    expect(frontmatter["hat"]).toBe("hod");
    expect(frontmatter).not.toHaveProperty("description");
    expect(queryToPlain(query)["where"]).toEqual({
      all: [
        { field: "blocked_on", op: "not-empty" },
        { not: { any: [{ field: "stage", op: "one-of", value: ["delivered", "withdrawn"] }] } },
      ],
    });
  });

  it("reads a whole view note", () => {
    const { view, problems } = parseSavedView({
      type: "scdb-view",
      id: "VIEW-queue",
      title: "Live queue",
      query: { types: ["scdb-request"], sort: [{ field: "due", direction: "asc" }] },
    });
    expect(problems).toEqual([]);
    expect(view.title).toBe("Live queue");
    expect(view.hat).toBeNull();
    expect(view.query.sort).toEqual([{ field: "due", direction: "asc" }]);
  });
});
