/**
 * The query model (CLAUDE.md §7 A2).
 *
 * A query is plain data: it round-trips through YAML frontmatter so a saved
 * view is a note a human can read and edit (§5.14, rule 11). Nothing here
 * evaluates anything — see `evaluate.ts`.
 *
 * Why we own this at all, when core Bases exists: Bases has no FROM clause,
 * AND-only filters and no aggregation. The three things this model has that
 * Bases structurally cannot are the reason A2 is on the plan — an OR/NOT filter
 * tree, aggregates, and fields that are *computed* rather than stored (dwell,
 * bounce count, SLA state). Browsing stays Bases' job (A2b).
 *
 * Pure module: no Obsidian, no Node.
 */

/** How a field compares and formats. Drives which operators are offered. */
export type FieldKind = "text" | "number" | "duration" | "date" | "boolean" | "list" | "link";

export interface FieldDef {
  /** Stable id, also the key in a row's `fields`. Dotted for nested frontmatter. */
  id: string;
  label: string;
  kind: FieldKind;
  /** Shown in the field picker to say where a value comes from. */
  computed?: boolean;
  /** Closed vocabulary, when the field has one. Offered as a value picker. */
  options?: readonly string[];
}

/** One note, flattened. `key` is the vault path — stable within a session. */
export interface Row {
  key: string;
  type: string;
  fields: Record<string, unknown>;
}

export const OPERATORS = [
  "is",
  "is-not",
  "contains",
  "not-contains",
  "starts-with",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "one-of",
  "none-of",
  "has",
  "not-has",
  "empty",
  "not-empty",
  "is-true",
  "is-false",
] as const;
export type Operator = (typeof OPERATORS)[number];

export function isOperator(value: unknown): value is Operator {
  return typeof value === "string" && (OPERATORS as readonly string[]).includes(value);
}

/** Operators that take no value at all. */
export const NULLARY_OPERATORS: readonly Operator[] = [
  "empty",
  "not-empty",
  "is-true",
  "is-false",
];

/** Operators that take a list rather than a single value. */
export const LIST_OPERATORS: readonly Operator[] = ["one-of", "none-of", "between"];

/**
 * Which operators make sense on which kind.
 *
 * This is a usability guard, not a safety one: `evaluate.ts` still has to
 * behave sanely if a hand-edited saved view asks for something odd, because a
 * saved view is a markdown note anyone can type into.
 */
const BY_KIND: Record<FieldKind, readonly Operator[]> = {
  text: [
    "is",
    "is-not",
    "contains",
    "not-contains",
    "starts-with",
    "one-of",
    "none-of",
    "empty",
    "not-empty",
  ],
  link: ["is", "is-not", "contains", "one-of", "none-of", "empty", "not-empty"],
  number: ["is", "is-not", "gt", "gte", "lt", "lte", "between", "empty", "not-empty"],
  duration: ["gt", "gte", "lt", "lte", "between", "empty", "not-empty"],
  date: ["is", "is-not", "gt", "gte", "lt", "lte", "between", "empty", "not-empty"],
  boolean: ["is-true", "is-false", "empty", "not-empty"],
  list: ["has", "not-has", "one-of", "none-of", "empty", "not-empty"],
};

export function operatorsFor(kind: FieldKind): readonly Operator[] {
  return BY_KIND[kind];
}

export interface Condition {
  kind: "condition";
  field: string;
  op: Operator;
  /**
   * Comparison operand. A bare value for most operators, an array for
   * `one-of`/`none-of`/`between`, absent for the nullary ones.
   *
   * Dates are held as the string the user typed (`2026-07-14`, `today`,
   * `-14d`) rather than a resolved instant, so a saved view means the same
   * thing next month. Resolution happens at evaluation time.
   */
  value?: unknown;
}

export interface FilterGroup {
  kind: "group";
  combine: "and" | "or";
  /** Inverts the whole group, so NOT(a OR b) is expressible. */
  negate: boolean;
  clauses: FilterNode[];
}

export type FilterNode = Condition | FilterGroup;

export interface SortSpec {
  field: string;
  direction: "asc" | "desc";
}

/** Date grouping buckets. Anything else groups on the raw value. */
export const BUCKETS = ["day", "month", "year"] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface GroupSpec {
  field: string;
  direction: "asc" | "desc";
  /** Only meaningful on a date field. */
  bucket?: Bucket;
}

export const AGGREGATE_FNS = [
  "count",
  "count-distinct",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "p90",
] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export function isAggregateFn(value: unknown): value is AggregateFn {
  return typeof value === "string" && (AGGREGATE_FNS as readonly string[]).includes(value);
}

export interface AggregateSpec {
  fn: AggregateFn;
  /** Ignored by `count`, required by every other function. */
  field?: string;
  label?: string;
}

export interface Query {
  /** Note types to read. Empty means every indexed type. */
  types: string[];
  where: FilterGroup | null;
  sort: SortSpec[];
  group: GroupSpec | null;
  aggregates: AggregateSpec[];
  /** Field ids in display order. Empty means the catalogue's default set. */
  columns: string[];
  /** Rows returned, after sorting. Null means everything. */
  limit: number | null;
}

export function emptyQuery(types: string[] = []): Query {
  return { types, where: null, sort: [], group: null, aggregates: [], columns: [], limit: null };
}

export function andGroup(clauses: FilterNode[] = []): FilterGroup {
  return { kind: "group", combine: "and", negate: false, clauses };
}

export function condition(field: string, op: Operator, value?: unknown): Condition {
  return value === undefined
    ? { kind: "condition", field, op }
    : { kind: "condition", field, op, value };
}

/** Every field id a query touches, for validating against a catalogue. */
export function fieldsUsed(query: Query): string[] {
  const seen = new Set<string>();
  const walk = (node: FilterNode): void => {
    if (node.kind === "condition") seen.add(node.field);
    else for (const clause of node.clauses) walk(clause);
  };
  if (query.where) walk(query.where);
  for (const sort of query.sort) seen.add(sort.field);
  if (query.group) seen.add(query.group.field);
  for (const aggregate of query.aggregates) {
    if (aggregate.field !== undefined) seen.add(aggregate.field);
  }
  for (const column of query.columns) seen.add(column);
  return [...seen];
}

/**
 * Report what a query asks for that the catalogue cannot answer.
 *
 * Returns reasons rather than throwing: a saved view whose field was renamed
 * should say so in the view, not break the plugin (§8, silent failure is a bug).
 */
export function validateQuery(query: Query, fields: readonly FieldDef[]): string[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const problems: string[] = [];

  for (const id of fieldsUsed(query)) {
    if (!byId.has(id)) problems.push(`Unknown field "${id}".`);
  }

  const walk = (node: FilterNode): void => {
    if (node.kind === "group") {
      for (const clause of node.clauses) walk(clause);
      return;
    }
    const field = byId.get(node.field);
    if (!field) return; // already reported
    if (!operatorsFor(field.kind).includes(node.op)) {
      problems.push(`"${field.label}" is a ${field.kind} field and cannot use "${node.op}".`);
    }
    if (NULLARY_OPERATORS.includes(node.op)) return;
    if (node.value === undefined || node.value === null || node.value === "") {
      problems.push(`"${field.label}" ${node.op} needs a value.`);
      return;
    }
    if (LIST_OPERATORS.includes(node.op) && !Array.isArray(node.value)) {
      problems.push(`"${field.label}" ${node.op} needs a list of values.`);
    }
    if (node.op === "between" && Array.isArray(node.value) && node.value.length !== 2) {
      problems.push(`"${field.label}" between needs exactly two values.`);
    }
  };
  if (query.where) walk(query.where);

  for (const aggregate of query.aggregates) {
    if (aggregate.fn !== "count" && aggregate.field === undefined) {
      problems.push(`Aggregate "${aggregate.fn}" needs a field.`);
    }
  }

  if (query.limit !== null && (!Number.isInteger(query.limit) || query.limit < 1)) {
    problems.push("Limit must be a whole number of rows, or unset.");
  }

  return problems;
}
