/**
 * Rendering a query result to text: CSV and a markdown table (§7 A2).
 *
 * Both are exports in the governance sense — they leave the vault, or at least
 * become a file someone can send on — so the caller logs an `export` entry
 * (§5.6). Nothing here writes anything or decides anything about redaction.
 *
 * Durations are rendered human ("23 days") per §6, with a machine-readable
 * companion column in CSV so a spreadsheet can still do arithmetic. A report
 * that only says "1987200" is unreadable; one that only says "23 days" cannot
 * be summed.
 *
 * Pure module: no Obsidian, no Node.
 */

import { csvCell } from "../table/csv";
import { formatDuration, toVaultDate } from "../time/dates";
import { coerce, type AggregateValue, type QueryResult, type ResultGroup } from "./evaluate";
import type { FieldDef, FieldKind, Row } from "./model";

export interface FormatOptions {
  now: number;
  /** Adds a machine-readable column beside every duration. CSV only. */
  rawDurations?: boolean;
}

/** One cell, as a human reads it. */
export function formatCell(value: unknown, kind: FieldKind, now: number): string {
  const coerced = coerce(value, kind, now);
  if (coerced === null) return "";
  switch (kind) {
    case "duration":
      return typeof coerced === "number" ? formatDuration(coerced) : "";
    case "date":
      return typeof coerced === "number" ? toVaultDate(coerced) : "";
    case "boolean":
      return coerced === true ? "yes" : "no";
    case "list":
      return Array.isArray(coerced) ? coerced.join("; ") : String(coerced);
    default:
      // Text and links are lower-cased for comparison; show what the note says.
      return String(value ?? "").trim();
  }
}

export function formatAggregate(aggregate: AggregateValue): string {
  if (aggregate.value === null) return "—";
  if (aggregate.kind === "duration") return formatDuration(aggregate.value);
  if (aggregate.kind === "date") return toVaultDate(aggregate.value);
  return Number.isInteger(aggregate.value)
    ? String(aggregate.value)
    : aggregate.value.toFixed(1);
}

/* ------------------------------------------------------------------ CSV -- */

// Quoting lives in `table/csv.ts` beside the parser D2 reads dictionaries with,
// so an emitter and a reader of the same file format cannot drift apart.
// Re-exported because callers have always imported it from here.
export { csvCell };

export function toCsv(result: QueryResult, options: FormatOptions): string {
  const grouped = result.groups.length > 1 || result.groups[0]?.key !== "";
  const header: string[] = [];
  if (grouped) header.push("Group");
  for (const column of result.columns) {
    header.push(column.label);
    if (options.rawDurations === true && column.kind === "duration") {
      header.push(`${column.label} (ms)`);
    }
  }

  const lines = [header.map(csvCell).join(",")];
  for (const group of result.groups) {
    for (const row of group.rows) {
      const cells: string[] = [];
      if (grouped) cells.push(group.label);
      for (const column of result.columns) {
        cells.push(formatCell(row.fields[column.id], column.kind, options.now));
        if (options.rawDurations === true && column.kind === "duration") {
          const raw = coerce(row.fields[column.id], "duration", options.now);
          cells.push(typeof raw === "number" ? String(raw) : "");
        }
      }
      lines.push(cells.map(csvCell).join(","));
    }
  }

  // CRLF: Excel on a Windows work laptop is the consumer, and RFC 4180 says so.
  return `${lines.join("\r\n")}\r\n`;
}

/* -------------------------------------------------------------- markdown -- */

/** Pipes and newlines break a markdown table row; escape rather than drop. */
export function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tableRows(columns: readonly FieldDef[], rows: readonly Row[], now: number): string[] {
  return rows.map(
    (row) =>
      `| ${columns
        .map((column) => markdownCell(formatCell(row.fields[column.id], column.kind, now)))
        .join(" | ")} |`,
  );
}

function aggregateLine(aggregates: readonly AggregateValue[]): string {
  return aggregates.map((a) => `${a.label}: ${formatAggregate(a)}`).join(" · ");
}

export function toMarkdownTable(result: QueryResult, options: FormatOptions): string {
  if (result.columns.length === 0) return "_No columns selected._";

  const header = `| ${result.columns.map((c) => markdownCell(c.label)).join(" | ")} |`;
  // Right-align the numeric kinds, per §6 (tabular figures, numbers right).
  const rule = `| ${result.columns
    .map((c) => (c.kind === "number" || c.kind === "duration" ? "---:" : "---"))
    .join(" | ")} |`;

  const out: string[] = [];
  const ungrouped = result.groups.length === 1 && result.groups[0]?.key === "";

  for (const group of result.groups) {
    if (!ungrouped) {
      out.push("", `### ${group.label}`, "");
    }
    out.push(header, rule, ...tableRows(result.columns, group.rows, options.now));
    if (group.aggregates.length > 0) out.push("", aggregateLine(group.aggregates));
  }

  if (result.totals.length > 0) {
    out.push("", `**All rows** — ${aggregateLine(result.totals)}`);
  }
  if (result.truncated) {
    out.push("", `_Showing ${result.returned} of ${result.matched} matching notes._`);
  }

  return out.join("\n").replace(/^\n+/, "");
}

/** A one-line description of what a result contains, for a confirm dialog. */
export function describeResult(result: QueryResult, groups?: readonly ResultGroup[]): string {
  const count = result.returned;
  const shown = groups ?? result.groups;
  const noun = count === 1 ? "row" : "rows";
  const grouping = shown.length > 1 ? ` in ${shown.length} groups` : "";
  const of = result.truncated ? ` of ${result.matched} matching` : "";
  return `${count} ${noun}${of}${grouping}`;
}
