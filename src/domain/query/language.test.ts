import { describe, expect, it } from "vitest";
import { runQuery } from "./evaluate";
import {
  chipsToQuery,
  parseQueryText,
  textWithoutChip,
  type Chip,
  type Vocabulary,
} from "./language";
import { andGroup, condition, type Query, type Row } from "./model";
import { REQUEST_FIELDS } from "../request/queryFields";

const STAGES = [
  { id: "intake", label: "Intake" },
  { id: "triage", label: "SCDB triage" },
  { id: "awaiting-approval", label: "Awaiting approval" },
  { id: "approved", label: "Approved" },
  { id: "extraction", label: "Extraction" },
  { id: "qc", label: "QC" },
  { id: "delivered", label: "Delivered" },
  { id: "on-hold", label: "On hold" },
];

function vocabulary(overrides: Partial<Vocabulary> = {}): Vocabulary {
  return {
    fields: REQUEST_FIELDS,
    types: ["scdb-request", "publication", "person"],
    stages: STAGES,
    values: {
      requester: ["Dr A Tan", "Prof B Lim"],
      blocked_on: ["Dr A Tan"],
      assignee: ["Coordinator B"],
      study: ["EuroHeart"],
    },
    ...overrides,
  };
}

function parse(text: string, vocab: Vocabulary = vocabulary()) {
  return parseQueryText(text, vocab);
}

function labels(chips: readonly Chip[]): string[] {
  return chips.map((chip) => chip.label);
}

describe("the sentence B4 is specified with", () => {
  const text = "requests stuck in approval more than 2 weeks for Dr Tan";

  it("reads every part of it and leaves nothing over", () => {
    const parsed = parse(text);
    expect(parsed.ignored).toEqual([]);
    expect(labels(parsed.chips)).toEqual([
      "scdb-request",
      "stage is Awaiting approval",
      "In stage more than 2 weeks",
      "Waiting on or Requester is Dr A Tan",
    ]);
  });

  it("builds the query the Explore board would have been clicked into", () => {
    const query = chipsToQuery(parse(text).chips);
    expect(query.types).toEqual(["scdb-request"]);
    expect(query.where?.clauses).toEqual([
      { kind: "condition", field: "stage", op: "is", value: "awaiting-approval" },
      { kind: "condition", field: "dwell", op: "gt", value: "14d" },
      {
        kind: "group",
        combine: "or",
        negate: false,
        clauses: [
          { kind: "condition", field: "blocked_on", op: "is", value: "Dr A Tan" },
          { kind: "condition", field: "requester", op: "is", value: "Dr A Tan" },
        ],
      },
    ]);
  });

  it("returns the rows it says it will", () => {
    const now = Date.parse("2026-08-22T09:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const rows: Row[] = [
      row("stuck", { stage: "awaiting-approval", dwell: 20 * day, blocked_on: "[[Dr A Tan]]" }),
      row("fresh", { stage: "awaiting-approval", dwell: 3 * day, blocked_on: "[[Dr A Tan]]" }),
      row("elsewhere", { stage: "extraction", dwell: 40 * day, blocked_on: "[[Dr A Tan]]" }),
      row("other-person", { stage: "awaiting-approval", dwell: 20 * day, blocked_on: "[[Prof B Lim]]" }),
    ];

    const result = runQuery(rows, chipsToQuery(parse(text).chips), REQUEST_FIELDS, { now });
    expect(result.groups[0]?.rows.map((entry) => entry.key)).toEqual(["stuck"]);
  });

  it("is not case sensitive, and hyphens read the same as spaces", () => {
    const spelled = parse("requests in awaiting-approval");
    const shouted = parse("REQUESTS IN Awaiting Approval");
    expect(labels(spelled.chips)).toEqual(labels(shouted.chips));
  });
});

function row(key: string, fields: Record<string, unknown>): Row {
  return { key, type: "scdb-request", fields };
}

describe("which duration a quantity attaches to", () => {
  it("means time in the current stage after a stage phrase", () => {
    const parsed = parse("in triage for more than 3 days");
    expect(chipsToQuery(parsed.chips).where?.clauses[1]).toEqual({
      kind: "condition",
      field: "dwell",
      op: "gt",
      value: "3d",
    });
  });

  it("means the whole age when the word is `older`, with no comparator needed", () => {
    const parsed = parse("requests older than 2 weeks");
    expect(labels(parsed.chips)).toEqual(["scdb-request", "Age more than 2 weeks"]);
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "age",
      op: "gt",
      value: "14d",
    });
  });

  it("means how long someone has been the holdup after `blocked`", () => {
    const parsed = parse("blocked for over a fortnight");
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "blocked_for",
      op: "gt",
      value: "14d",
    });
  });

  it("counts a day-counting field in plain days rather than a duration token", () => {
    const parsed = parse("unreconciled for more than 90 days");
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "unreconciled_days",
      op: "gt",
      value: 90,
    });
  });

  it("says which duration it chose when the sentence never said", () => {
    expect(labels(parse("more than 5 days").chips)).toEqual(["In stage more than 5 days"]);
  });
});

describe("dates", () => {
  it("reads a named window as a range of offsets, not of dates", () => {
    const parsed = parse("due this week");
    expect(labels(parsed.chips)).toEqual(["Due within 7 days"]);
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "due",
      op: "between",
      value: ["today", "+7d"],
    });
  });

  it("reads a window backwards", () => {
    const parsed = parse("received in the last 2 weeks");
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "received",
      op: "between",
      value: ["-14d", "today"],
    });
  });

  it("reads a written-out date", () => {
    const parsed = parse("due before 2026-09-01");
    expect(labels(parsed.chips)).toEqual(["Due before 2026-09-01"]);
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "due",
      op: "lt",
      value: "2026-09-01",
    });
  });

  it("refuses a window with no field to attach it to", () => {
    expect(parse("this week").chips).toEqual([]);
    expect(parse("this week").ignored).toEqual(["this week"]);
  });
});

describe("people and studies come from the vault, never from a guess", () => {
  it("binds to who the holdup is when the words say so", () => {
    const parsed = parse("waiting on Dr A Tan");
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "blocked_on",
      op: "is",
      value: "Dr A Tan",
    });
  });

  it("honours the preposition even where that name has never appeared", () => {
    const parsed = parse("assigned to Dr A Tan");
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "condition",
      field: "assignee",
      op: "is",
      value: "Dr A Tan",
    });
  });

  it("looks wherever the name actually appears when nothing says which", () => {
    const parsed = parse("EuroHeart");
    expect(labels(parsed.chips)).toEqual(["Study is EuroHeart"]);
  });

  it("refuses a surname two people answer to, rather than picking one", () => {
    const vocab = vocabulary({
      values: { requester: ["Dr A Tan", "Dr C Tan"], blocked_on: [], assignee: [], study: [] },
    });
    expect(parse("waiting on Tan", vocab).chips).toEqual([]);
    expect(parse("waiting on Tan", vocab).ignored).toEqual(["waiting on Tan"]);
    // The full name is still unambiguous, so it still works.
    expect(labels(parse("waiting on Dr C Tan", vocab).chips)).toEqual(["Waiting on is Dr C Tan"]);
  });

  it("says nothing it could not place, rather than searching for it as text", () => {
    const parsed = parse("requests for Dr Nobody");
    expect(labels(parsed.chips)).toEqual(["scdb-request"]);
    expect(parsed.ignored).toEqual(["for Dr Nobody"]);
  });
});

describe("the phrases that stand for a whole filter", () => {
  it("expands overdue into both halves of what it means", () => {
    const parsed = parse("overdue");
    expect(labels(parsed.chips)).toEqual(["overdue and not finished"]);
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toMatchObject({
      kind: "group",
      clauses: [
        { field: "due", op: "lt", value: "today" },
        { field: "completed", op: "is-false" },
      ],
    });
  });

  it("offers a governance phrase only where the field exists", () => {
    const withoutGovernance = vocabulary({
      fields: REQUEST_FIELDS.filter((field) => field.id !== "identifiers"),
    });
    expect(parse("identifiable", withoutGovernance).chips).toEqual([]);
    expect(labels(parse("identifiable").chips)).toEqual(["carries identifiers"]);
  });

  it("inverts what follows a negation, keeping the words together", () => {
    const parsed = parse("not delivered");
    expect(labels(parsed.chips)).toEqual(["not stage is Delivered"]);
    expect(parsed.chips[0]?.source).toBe("not delivered");
    expect(chipsToQuery(parsed.chips).where?.clauses[0]).toEqual({
      kind: "group",
      combine: "and",
      negate: true,
      clauses: [{ kind: "condition", field: "stage", op: "is", value: "delivered" }],
    });
  });
});

describe("shaping the answer, not just filtering it", () => {
  it("reads an aggregate and a grouping", () => {
    const parsed = parse("median dwell by stage");
    expect(labels(parsed.chips)).toEqual(["median of In stage", "grouped by Stage"]);
    const query = chipsToQuery(parsed.chips);
    expect(query.aggregates).toEqual([{ fn: "median", field: "dwell" }]);
    expect(query.group).toEqual({ field: "stage_label", direction: "asc" });
  });

  it("reads a count with nothing to count", () => {
    expect(chipsToQuery(parse("count requests per stage").chips).aggregates).toEqual([
      { fn: "count" },
    ]);
  });

  it("reads a limit and a named sort", () => {
    const query = chipsToQuery(parse("top 5 longest waiting").chips);
    expect(query.limit).toBe(5);
    expect(query.sort).toEqual([{ field: "dwell", direction: "desc" }]);
  });

  it("reads a sort by a field name, with a direction", () => {
    expect(chipsToQuery(parse("sorted by bounces descending").chips).sort).toEqual([
      { field: "bounces", direction: "desc" },
    ]);
  });
});

describe("what the box hands back to the board", () => {
  it("keeps the columns and types the board already had", () => {
    const base: Partial<Query> = { types: ["publication"], columns: ["title", "stage"] };
    const query = chipsToQuery(parse("overdue").chips, base);
    expect(query.types).toEqual(["publication"]);
    expect(query.columns).toEqual(["title", "stage"]);
  });

  it("keeps the board's sort, so searching does not silently reorder it", () => {
    // The Explore board opens sorted by dwell. Losing that on the first
    // keystroke reorders the answer without saying so.
    const base: Partial<Query> = { sort: [{ field: "dwell", direction: "desc" }] };
    expect(chipsToQuery(parse("overdue").chips, base).sort).toEqual([
      { field: "dwell", direction: "desc" },
    ]);
  });

  it("lets the sentence override the board's sort", () => {
    const base: Partial<Query> = { sort: [{ field: "dwell", direction: "desc" }] };
    expect(chipsToQuery(parse("sorted by bounces").chips, base).sort).toEqual([
      { field: "bounces", direction: "asc" },
    ]);
  });

  it("builds the filter from the chips alone, never merged with the board's", () => {
    // Deleting a word has to be able to remove a condition, which it could not
    // if the sentence's filter accumulated onto one already there.
    const base: Partial<Query> = { where: andGroup([condition("study", "is", "EuroHeart")]) };
    const query = chipsToQuery(parse("overdue").chips, base);
    expect(query.where?.clauses.length).toBe(1);
    expect(chipsToQuery([], base).where).toBeNull();
  });

  it("lets the sentence override the board's types", () => {
    const query = chipsToQuery(parse("publications").chips, { types: ["scdb-request"] });
    expect(query.types).toEqual(["publication"]);
  });

  it("deletes exactly the words a chip came from", () => {
    const text = "requests in triage waiting on Dr A Tan";
    const parsed = parse(text);
    const stage = parsed.chips[1];
    expect(stage?.source).toBe("in triage");
    expect(stage && textWithoutChip(text, stage)).toBe("requests waiting on Dr A Tan");
  });

  it("reports unread words as the runs they were typed in", () => {
    const parsed = parse("requests about badgers in triage and also penguins");
    expect(labels(parsed.chips)).toEqual(["scdb-request", "stage is SCDB triage"]);
    expect(parsed.ignored).toEqual(["about badgers", "also penguins"]);
  });

  it("finds nothing in an empty box, and says nothing about it", () => {
    expect(parse("")).toEqual({ chips: [], ignored: [] });
    expect(chipsToQuery([]).where).toBeNull();
  });
});
