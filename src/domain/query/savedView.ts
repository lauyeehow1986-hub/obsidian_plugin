/**
 * Saved views as notes (§5.14, §7 A2).
 *
 * A saved view is `type: scdb-view` frontmatter — no database, no plugin-local
 * store. Uninstall the plugin and the views are still readable YAML; that is
 * rule 11 doing its job.
 *
 * The on-disk shape is written for a human, not for a serialiser. Filter groups
 * are `all:` / `any:` / `not:` rather than `{ combine: "and", negate: false }`,
 * because someone will hand-edit one of these and the file has to say what it
 * means. Parsing is forgiving and reports what it could not read; writing is
 * canonical.
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  isAggregateFn,
  isOperator,
  type AggregateSpec,
  type Bucket,
  type Condition,
  type FilterGroup,
  type FilterNode,
  type GroupSpec,
  type Query,
  type SortSpec,
  emptyQuery,
} from "./model";

export const VIEW_TYPE = "scdb-view";

export interface SavedView {
  /** Human label, `VIEW-...`. The note path is the durable reference. */
  id: string;
  title: string;
  description: string;
  /** Which hat this view belongs to, or null for all three (§7 A3). */
  hat: string | null;
  query: Query;
}

export interface ParsedSavedView {
  view: SavedView;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value);
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/* --------------------------------------------------------------- reading -- */

function parseCondition(raw: Record<string, unknown>, problems: string[]): Condition | null {
  const field = str(raw["field"]);
  if (field === "") {
    problems.push("A filter clause has no `field`.");
    return null;
  }
  const op = raw["op"];
  if (!isOperator(op)) {
    problems.push(`Filter on "${field}" has an unrecognised operator "${str(op)}".`);
    return null;
  }
  return "value" in raw
    ? { kind: "condition", field, op, value: raw["value"] }
    : { kind: "condition", field, op };
}

function parseNode(raw: unknown, problems: string[]): FilterNode | null {
  if (!isRecord(raw)) {
    problems.push("A filter clause is not a mapping and was ignored.");
    return null;
  }
  if ("not" in raw) {
    const inner = parseNode(raw["not"], problems);
    if (!inner) return null;
    return inner.kind === "group"
      ? { ...inner, negate: !inner.negate }
      : { kind: "group", combine: "and", negate: true, clauses: [inner] };
  }
  for (const [key, combine] of [
    ["all", "and"],
    ["any", "or"],
  ] as const) {
    if (key in raw) {
      const clauses = list(raw[key])
        .map((clause) => parseNode(clause, problems))
        .filter((clause): clause is FilterNode => clause !== null);
      return { kind: "group", combine, negate: false, clauses };
    }
  }
  return parseCondition(raw, problems);
}

function parseSort(raw: unknown, problems: string[]): SortSpec[] {
  return list(raw)
    .map((entry): SortSpec | null => {
      if (!isRecord(entry)) {
        problems.push("A sort entry is not a mapping and was ignored.");
        return null;
      }
      const field = str(entry["field"]);
      if (field === "") {
        problems.push("A sort entry has no `field`.");
        return null;
      }
      return { field, direction: str(entry["direction"]) === "desc" ? "desc" : "asc" };
    })
    .filter((entry): entry is SortSpec => entry !== null);
}

function parseGroup(raw: unknown, problems: string[]): GroupSpec | null {
  if (raw === undefined || raw === null) return null;
  const source = isRecord(raw) ? raw : { field: raw };
  const field = str(source["field"]);
  if (field === "") {
    problems.push("`group` has no `field`.");
    return null;
  }
  const bucket = str(source["bucket"]);
  const group: GroupSpec = {
    field,
    direction: str(source["direction"]) === "desc" ? "desc" : "asc",
  };
  if (bucket === "day" || bucket === "month" || bucket === "year") {
    group.bucket = bucket as Bucket;
  } else if (bucket !== "") {
    problems.push(`Unrecognised group bucket "${bucket}"; grouping on the raw value.`);
  }
  return group;
}

function parseAggregates(raw: unknown, problems: string[]): AggregateSpec[] {
  return list(raw)
    .map((entry): AggregateSpec | null => {
      const source = isRecord(entry) ? entry : { fn: entry };
      const fn = source["fn"];
      if (!isAggregateFn(fn)) {
        problems.push(`Unrecognised aggregate "${str(fn)}".`);
        return null;
      }
      const spec: AggregateSpec = { fn };
      const field = str(source["field"]);
      if (field !== "") spec.field = field;
      const label = str(source["label"]);
      if (label !== "") spec.label = label;
      return spec;
    })
    .filter((entry): entry is AggregateSpec => entry !== null);
}

export function parseQuery(raw: unknown, problems: string[]): Query {
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) problems.push("`query` is not a mapping.");
    return emptyQuery();
  }
  const query = emptyQuery(list(raw["types"]).map(str).filter((type) => type !== ""));

  const where = raw["where"];
  if (where !== undefined && where !== null) {
    const node = parseNode(where, problems);
    if (node) {
      query.where =
        node.kind === "group" ? node : { kind: "group", combine: "and", negate: false, clauses: [node] };
    }
  }

  query.sort = parseSort(raw["sort"], problems);
  query.group = parseGroup(raw["group"], problems);
  query.aggregates = parseAggregates(raw["aggregates"], problems);
  query.columns = list(raw["columns"]).map(str).filter((column) => column !== "");

  const limit = raw["limit"];
  if (limit !== undefined && limit !== null) {
    const n = Number(limit);
    if (Number.isInteger(n) && n > 0) query.limit = n;
    else problems.push(`\`limit: ${str(limit)}\` is not a whole number of rows; ignoring it.`);
  }

  return query;
}

export function parseSavedView(frontmatter: Record<string, unknown>): ParsedSavedView {
  const problems: string[] = [];
  const query = parseQuery(frontmatter["query"], problems);
  const hat = str(frontmatter["hat"]);
  return {
    view: {
      id: str(frontmatter["id"]),
      title: str(frontmatter["title"]),
      description: str(frontmatter["description"]),
      hat: hat === "" ? null : hat,
      query,
    },
    problems,
  };
}

/* --------------------------------------------------------------- writing -- */

function nodeToPlain(node: FilterNode): Record<string, unknown> {
  if (node.kind === "condition") {
    const out: Record<string, unknown> = { field: node.field, op: node.op };
    if (node.value !== undefined) out["value"] = node.value;
    return out;
  }
  const body: Record<string, unknown> = {
    [node.combine === "and" ? "all" : "any"]: node.clauses.map(nodeToPlain),
  };
  return node.negate ? { not: body } : body;
}

export function queryToPlain(query: Query): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (query.types.length > 0) out["types"] = [...query.types];
  if (query.where && query.where.clauses.length > 0) {
    const plain = nodeToPlain(query.where);
    // An unnegated top-level `all` needs no wrapper key of its own.
    out["where"] = plain;
  }
  if (query.sort.length > 0) {
    out["sort"] = query.sort.map((sort) => ({ field: sort.field, direction: sort.direction }));
  }
  if (query.group) {
    const group: Record<string, unknown> = {
      field: query.group.field,
      direction: query.group.direction,
    };
    if (query.group.bucket !== undefined) group["bucket"] = query.group.bucket;
    out["group"] = group;
  }
  if (query.aggregates.length > 0) {
    out["aggregates"] = query.aggregates.map((aggregate) => {
      const plain: Record<string, unknown> = { fn: aggregate.fn };
      if (aggregate.field !== undefined) plain["field"] = aggregate.field;
      if (aggregate.label !== undefined) plain["label"] = aggregate.label;
      return plain;
    });
  }
  if (query.columns.length > 0) out["columns"] = [...query.columns];
  if (query.limit !== null) out["limit"] = query.limit;
  return out;
}

/**
 * Frontmatter for a saved view.
 *
 * Only the keys this module owns. The caller merges into the existing note so
 * anything else a human put there survives (rule 8).
 */
export function savedViewFrontmatter(view: SavedView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: VIEW_TYPE,
    id: view.id,
    title: view.title,
  };
  if (view.description !== "") out["description"] = view.description;
  if (view.hat !== null) out["hat"] = view.hat;
  out["query"] = queryToPlain(view.query);
  return out;
}
