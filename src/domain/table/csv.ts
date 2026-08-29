/**
 * RFC 4180 CSV, both directions (§7 A2 export, §7 D2 import).
 *
 * Quoting lived in `query/format.ts` while CSV was write-only. D2 has to read
 * one back — a REDCap data dictionary exported from a live instance — and a
 * parser that does not obey exactly the rule the emitter obeys is a
 * round-trip that corrupts a branching-logic expression the first time one
 * contains a comma. They belong in one file for the same reason `cells.ts`
 * exists: the escaping is the file format, and two implementations of a file
 * format are one drift away from a silently mangled row.
 *
 * What this deliberately does **not** do is guess. A quote in the middle of an
 * unquoted field, a stray `"` inside a quoted one, a row with the wrong number
 * of cells — each is reported rather than repaired. A data dictionary is
 * something a person will hand-edit in Excel, and the failure that matters is
 * not the file that fails to parse, it is the one that parses into something
 * subtly different from what they meant.
 *
 * Pure module: no Obsidian, no Node.
 */

/** RFC 4180: quote anything containing a comma, quote, CR or LF; double the quotes. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row, plus where it started, so a problem can name a line. */
export interface CsvRow {
  cells: string[];
  /** 1-based line the row began on. Not the row number: a quoted cell spans lines. */
  line: number;
}

export interface CsvParse {
  rows: CsvRow[];
  problems: string[];
}

/**
 * Parse CSV text into rows.
 *
 * CRLF, LF and a bare CR all end a record — Excel writes one, a hand-edit in a
 * text editor writes another, and a file that has been through both writes
 * whichever it felt like. A trailing newline does not produce an empty final
 * row; a genuinely blank line in the middle does, because dropping it would
 * shift every line number after it and the problems here are quoted by line.
 */
export function parseCsv(text: string): CsvParse {
  const rows: CsvRow[] = [];
  const problems: string[] = [];

  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  let line = 1;
  let rowLine = 1;

  const endCell = (): void => {
    cells.push(cell);
    cell = "";
  };
  const endRow = (): void => {
    endCell();
    rows.push({ cells, line: rowLine });
    cells = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!started) {
      rowLine = line;
      started = true;
    }

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (cell === "") {
        quoted = true;
      } else {
        // A quote after text in an unquoted field. Excel would keep it; so do
        // we, but say so, because the usual cause is a hand-edit that meant to
        // quote the whole cell and started one character late.
        problems.push(`Line ${line}: a quote inside an unquoted field was kept as text.`);
        cell += ch;
      }
      continue;
    }

    if (ch === ",") {
      endCell();
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      continue;
    }

    cell += ch;
  }

  if (quoted) {
    problems.push(`Line ${rowLine}: a quoted value was never closed, so the rest of the file was read as one cell.`);
  }
  if (started) endRow();

  return { rows, problems };
}

/**
 * Rows keyed by the header row, tolerating column order and extra columns.
 *
 * REDCap's dictionary column order is stable but its column *set* is not
 * across versions, and a file that has been opened in Excel may have gained a
 * trailing empty column. Reading by header name rather than by position is
 * what makes an import survive both. A row with fewer cells than the header is
 * reported and its missing columns read as empty rather than shifting.
 */
export interface KeyedCsv {
  header: string[];
  rows: { values: Record<string, string>; line: number }[];
  problems: string[];
}

export function parseKeyedCsv(text: string): KeyedCsv {
  const parsed = parseCsv(text);
  const problems = [...parsed.problems];
  const meaningful = parsed.rows.filter((row) => row.cells.some((c) => c.trim() !== ""));
  const headerRow = meaningful[0];
  if (headerRow === undefined) {
    return { header: [], rows: [], problems: [...problems, "The file has no rows."] };
  }

  // A UTF-8 BOM on the first header cell is what Excel leaves behind, and it
  // would otherwise make the first column name match nothing at all.
  const header = headerRow.cells.map((c, index) =>
    (index === 0 ? c.replace(/^﻿/, "") : c).trim().toLowerCase(),
  );

  const rows: KeyedCsv["rows"] = [];
  for (const row of meaningful.slice(1)) {
    if (row.cells.length !== header.length) {
      problems.push(
        `Line ${row.line}: ${row.cells.length} value${row.cells.length === 1 ? "" : "s"} for ${header.length} columns.`,
      );
    }
    const values: Record<string, string> = {};
    header.forEach((name, index) => {
      if (name === "") return;
      values[name] = (row.cells[index] ?? "").trim();
    });
    rows.push({ values, line: row.line });
  }

  return { header, rows, problems };
}

/** Emit rows with a header, CRLF-terminated. Excel on a Windows laptop is the consumer. */
export function toCsvText(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
