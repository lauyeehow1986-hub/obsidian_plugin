/**
 * Query evaluation (CLAUDE.md §7 A2): filter, sort, group, aggregate.
 *
 * Comparison is **kind-directed**. The same operator means different things on
 * a date and on a link, and guessing from the runtime type of the stored value
 * is how a query engine starts lying: a `sla_days` of `"21"` typed as a string
 * would sort between 2 and 3. The catalogue says what a field is, and this
 * module coerces to that before comparing.
 *
 * Missing is not zero. A request with no `due` is not overdue, and a stage with
 * no target is not on track — nulls are excluded from aggregates and sorted
 * last rather than coerced.
 *
 * Pure module: no Obsidian, no Node.
 */

import { mean, median, percentile } from "../stats/summary";
import { DAY_MS, parseTimestamp } from "../time/dates";
import {
  type AggregateSpec,
  type Condition,
  type FieldDef,
  type FieldKind,
  type FilterGroup,
  type FilterNode,
  type GroupSpec,
  type Query,
  type Row,
  type SortSpec,
} from "./model";

export interface EvaluateOptions {
  /** Anchors every relative date token, so a result is reproducible in a test. */
  now: number;
}

/* --------------------------------------------------------------- values -- */

/** Strip wikilink syntax so `[[Dr A Tan|Tan]]` compares as `Dr A Tan`. */
export function linkTarget(value: string): string {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  const inner = match?.[1] ?? value;
  const piped = inner.split("|")[0] ?? inner;
  return piped.trim();
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Resolve a date operand.
 *
 * Saved views hold what the user typed, not a resolved instant, so
 * `due before today` still means today next month. Accepted: an ISO date, an
 * epoch number, `today`, `now`, and an offset in days or weeks (`-14d`, `+2w`).
 */
export function resolveDate(value: unknown, now: number): number | null {
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (token === "now") return now;
    if (token === "today") return startOfDay(now);
    const offset = /^([+-]?\d+)\s*([dw])$/.exec(token);
    if (offset) {
      const amount = Number(offset[1]);
      const unit = offset[2] === "w" ? 7 : 1;
      return startOfDay(now) + amount * unit * DAY_MS;
    }
  }
  return parseTimestamp(value);
}

/**
 * Durations are stored in milliseconds but written by hand as `14d`.
 *
 * A saved view is a markdown note (§5.14), and `dwell gt 1209600000` is not
 * something a person can check at a glance. Bare numbers still mean
 * milliseconds, so nothing that already works changes.
 */
export function parseDurationToken(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text === "") return null;
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] ?? "ms";
  const scale: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: DAY_MS,
    w: 7 * DAY_MS,
  };
  return amount * (scale[unit] ?? 1);
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Coerce a stored value to the comparable form its kind implies. */
export function coerce(value: unknown, kind: FieldKind, now: number): unknown {
  if (isEmptyValue(value)) return null;
  switch (kind) {
    case "duration": {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      return parseDurationToken(String(value));
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "date":
      return resolveDate(value, now);
    case "boolean":
      if (typeof value === "boolean") return value;
      return String(value).trim().toLowerCase() === "true";
    case "list":
      return (Array.isArray(value) ? value : [value]).map((item) =>
        linkTarget(String(item)).toLowerCase(),
      );
    case "link":
      return linkTarget(String(value)).toLowerCase();
    case "text":
      return String(value).trim().toLowerCase();
  }
}

function operandList(value: unknown, kind: FieldKind, now: number): unknown[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => coerce(item, kind === "list" ? "text" : kind, now));
}

function compareScalar(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/* -------------------------------------------------------------- filters -- */

export function testCondition(
  row: Row,
  condition: Condition,
  field: FieldDef,
  now: number,
): boolean {
  const raw = row.fields[condition.field];
  const value = coerce(raw, field.kind, now);
  const empty = value === null;

  switch (condition.op) {
    case "empty":
      return empty;
    case "not-empty":
      return !empty;
    case "is-true":
      return value === true;
    case "is-false":
      return value === false;
    default:
      break;
  }

  // Every remaining operator compares against something. A missing value never
  // matches: "stage is not delivered" must not sweep in notes with no stage.
  if (empty) return false;

  const operand = operandList(condition.value, field.kind, now);
  const first = operand[0] ?? null;

  switch (condition.op) {
    case "is":
      return sameValue(value, first);
    case "is-not":
      return !sameValue(value, first);
    case "contains":
      return String(value).includes(String(first));
    case "not-contains":
      return !String(value).includes(String(first));
    case "starts-with":
      return String(value).startsWith(String(first));
    case "gt":
      return first !== null && compareScalar(value, first) > 0;
    case "gte":
      return first !== null && compareScalar(value, first) >= 0;
    case "lt":
      return first !== null && compareScalar(value, first) < 0;
    case "lte":
      return first !== null && compareScalar(value, first) <= 0;
    case "between": {
      const [low, high] = operand;
      if (low === null || low === undefined || high === null || high === undefined) return false;
      return compareScalar(value, low) >= 0 && compareScalar(value, high) <= 0;
    }
    case "one-of":
      return operand.some((candidate) => sameValue(value, candidate));
    case "none-of":
      return !operand.some((candidate) => sameValue(value, candidate));
    case "has":
      return Array.isArray(value) && value.some((item) => sameValue(item, first));
    case "not-has":
      return !(Array.isArray(value) && value.some((item) => sameValue(item, first)));
    default:
      return false;
  }
}

function sameValue(value: unknown, other: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => sameValue(item, other));
  return value === other;
}

export function testNode(
  row: Row,
  node: FilterNode,
  fields: Map<string, FieldDef>,
  now: number,
): boolean {
  if (node.kind === "condition") {
    const field = fields.get(node.field);
    // An unknown field matches nothing, and `validateQuery` has already said so
    // in the view. Silently matching everything would be worse.
    if (!field) return false;
    return testCondition(row, node, field, now);
  }
  const results = node.clauses.map((clause) => testNode(row, clause, fields, now));
  // An empty group is a no-op rather than a wall: a half-built filter in the UI
  // should show everything, not nothing.
  const combined =
    results.length === 0 ? true : node.combine === "and" ? results.every(Boolean) : results.some(Boolean);
  return node.negate ? !combined : combined;
}

/* -------------------------------------------------------- sort and group -- */

export function comparator(
  sorts: readonly SortSpec[],
  fields: Map<string, FieldDef>,
  now: number,
): (a: Row, b: Row) => number {
  return (a, b) => {
    for (const sort of sorts) {
      const field = fields.get(sort.field);
      if (!field) continue;
      const left = coerce(a.fields[sort.field], field.kind, now);
      const right = coerce(b.fields[sort.field], field.kind, now);
      // Missing values sort last in both directions. A request with no due date
      // is not the most urgent thing on the board.
      if (left === null && right === null) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      const order = compareScalar(left, right);
      if (order !== 0) return sort.direction === "desc" ? -order : order;
    }
    return a.key.localeCompare(b.key);
  };
}

/**
 * How a bucket is labelled on screen and in an export.
 *
 * Deliberately not the bucket key. The key is the *coerced* value, which is
 * lower-cased so that "Dr A Tan" and "dr a tan" land in one group — correct for
 * bucketing, wrong on a report heading. The label comes from the raw value of
 * the first row in the bucket, so it reads the way the note wrote it. Rows that
 * differ only in case therefore take the first one's spelling; that is the
 * right trade, and the alternative is two groups for one person.
 */
export function groupLabel(row: Row, group: GroupSpec, field: FieldDef, now: number): string {
  if (field.kind === "date") return groupKey(row, group, field, now);
  const raw = row.fields[group.field];
  if (isEmptyValue(raw)) return "";
  if (Array.isArray(raw)) return raw.map((item) => linkTarget(String(item))).join(", ");
  // Wikilink brackets come off: the same label goes into a CSV "Group" column,
  // where `[[Dr A Tan]]` is not a name.
  return field.kind === "link" ? linkTarget(String(raw)) : String(raw).trim();
}

/** The bucket key a row groups into, plus a stable sort key for the bucket. */
export function groupKey(row: Row, group: GroupSpec, field: FieldDef, now: number): string {
  const value = coerce(row.fields[group.field], field.kind, now);
  if (value === null) return "";
  if (field.kind === "date" && typeof value === "number") {
    const date = new Date(value);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    if (group.bucket === "year") return year;
    if (group.bucket === "month") return `${year}-${month}`;
    return `${year}-${month}-${day}`;
  }
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/* ----------------------------------------------------------- aggregates -- */

export interface AggregateValue {
  label: string;
  fn: AggregateSpec["fn"];
  /** Null when nothing in the group carried a usable value. */
  value: number | null;
  /** The field's kind, so the UI knows whether to render a duration. */
  kind: FieldKind | null;
}

export function aggregateLabel(spec: AggregateSpec, field: FieldDef | undefined): string {
  if (spec.label !== undefined && spec.label !== "") return spec.label;
  if (spec.fn === "count") return "Count";
  const name = field?.label ?? spec.field ?? "";
  const verb: Record<AggregateSpec["fn"], string> = {
    count: "Count",
    "count-distinct": "Distinct",
    sum: "Total",
    avg: "Mean",
    min: "Min",
    max: "Max",
    median: "Median",
    p90: "90th pct",
  };
  return `${verb[spec.fn]} ${name}`.trim();
}

export function computeAggregate(
  rows: readonly Row[],
  spec: AggregateSpec,
  fields: Map<string, FieldDef>,
  now: number,
): AggregateValue {
  const field = spec.field === undefined ? undefined : fields.get(spec.field);
  const label = aggregateLabel(spec, field);

  if (spec.fn === "count") return { label, fn: spec.fn, value: rows.length, kind: null };
  if (!field || spec.field === undefined) {
    return { label, fn: spec.fn, value: null, kind: null };
  }

  const raw = rows.map((row) => coerce(row.fields[spec.field as string], field.kind, now));
  const present = raw.filter((value) => value !== null);

  if (spec.fn === "count-distinct") {
    const seen = new Set(present.map((value) => (Array.isArray(value) ? value.join(",") : value)));
    return { label, fn: spec.fn, value: seen.size, kind: field.kind };
  }

  const numbers = present.filter((value): value is number => typeof value === "number");
  const value =
    numbers.length === 0
      ? null
      : spec.fn === "sum"
        ? numbers.reduce((sum, n) => sum + n, 0)
        : spec.fn === "avg"
          ? mean(numbers)
          : spec.fn === "min"
            ? Math.min(...numbers)
            : spec.fn === "max"
              ? Math.max(...numbers)
              : spec.fn === "median"
                ? median(numbers)
                : percentile(numbers, 0.9);

  return { label, fn: spec.fn, value, kind: field.kind };
}

/* ------------------------------------------------------------- the query -- */

export interface ResultGroup {
  /** Empty string for the ungrouped case and for rows with no value. */
  key: string;
  label: string;
  rows: Row[];
  aggregates: AggregateValue[];
}

export interface QueryResult {
  columns: FieldDef[];
  groups: ResultGroup[];
  /** Aggregates over every matching row, before the limit. */
  totals: AggregateValue[];
  /** Rows that matched the filter, before the limit. */
  matched: number;
  /** Rows actually returned. */
  returned: number;
  truncated: boolean;
  problems: string[];
}

const DEFAULT_COLUMN_LIMIT = 8;

export function runQuery(
  rows: readonly Row[],
  query: Query,
  catalogue: readonly FieldDef[],
  options: EvaluateOptions,
): QueryResult {
  const { now } = options;
  const fields = new Map(catalogue.map((field) => [field.id, field]));
  const problems: string[] = [];

  const typed =
    query.types.length === 0 ? [...rows] : rows.filter((row) => query.types.includes(row.type));

  const matching = query.where
    ? typed.filter((row) => testNode(row, query.where as FilterGroup, fields, now))
    : typed;

  const sorted = query.sort.length === 0 ? matching : [...matching].sort(comparator(query.sort, fields, now));

  const limited = query.limit === null ? sorted : sorted.slice(0, query.limit);

  const columns =
    query.columns.length === 0
      ? catalogue.slice(0, DEFAULT_COLUMN_LIMIT)
      : query.columns.map((id) => fields.get(id)).filter((field): field is FieldDef => !!field);

  const groups: ResultGroup[] = [];
  if (query.group === null) {
    groups.push({
      key: "",
      label: "",
      rows: limited,
      aggregates: query.aggregates.map((spec) => computeAggregate(limited, spec, fields, now)),
    });
  } else {
    const field = fields.get(query.group.field);
    if (!field) {
      problems.push(`Cannot group by unknown field "${query.group.field}".`);
      groups.push({
        key: "",
        label: "",
        rows: limited,
        aggregates: query.aggregates.map((spec) => computeAggregate(limited, spec, fields, now)),
      });
    } else {
      const buckets = new Map<string, Row[]>();
      const labels = new Map<string, string>();
      for (const row of limited) {
        const key = groupKey(row, query.group, field, now);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(row);
        else {
          buckets.set(key, [row]);
          labels.set(key, groupLabel(row, query.group, field, now));
        }
      }
      const keys = [...buckets.keys()].sort((a, b) => {
        // The no-value bucket always sits at the end, whichever way we sort.
        if (a === "") return 1;
        if (b === "") return -1;
        const order = a.localeCompare(b, undefined, { numeric: true });
        return query.group?.direction === "desc" ? -order : order;
      });
      for (const key of keys) {
        const bucketRows = buckets.get(key) ?? [];
        groups.push({
          key,
          label: key === "" ? `No ${field.label.toLowerCase()}` : (labels.get(key) ?? key),
          rows: bucketRows,
          aggregates: query.aggregates.map((spec) => computeAggregate(bucketRows, spec, fields, now)),
        });
      }
    }
  }

  return {
    columns,
    groups,
    totals: query.aggregates.map((spec) => computeAggregate(matching, spec, fields, now)),
    matched: matching.length,
    returned: limited.length,
    truncated: limited.length < matching.length,
    problems,
  };
}
