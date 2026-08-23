/**
 * Markdown table cells, escaped reversibly.
 *
 * Two of the vault's records are markdown tables rather than notes — the audit
 * ledger (§5.6) and the effort log (§5.3) — because a month of rows is one
 * readable, diffable file. Both have to survive a cell containing a pipe: a
 * gate-override reason and a time-entry note are both free text a human typed,
 * and a raw `|` would split the row while a newline would end it.
 *
 * So this is shared rather than duplicated. The escaping is part of the file
 * format both records commit to; two implementations of it would be two things
 * to keep in step, and the one that drifted would corrupt a row nobody reads
 * until an auditor does.
 *
 * Pure module: no Obsidian, no Node.
 */

/** Escape a value for a table cell. Reversible via {@link unescapeCell}. */
export function escapeCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?|\n/g, "\\n")
    .trim();
}

export function unescapeCell(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && i + 1 < value.length) {
      const next = value[++i]!;
      out += next === "n" ? "\n" : next;
    } else {
      out += value[i];
    }
  }
  return out.trim();
}

/** The `| --- | --- |` rule under a header row. */
export const SEPARATOR_RE = /^\|[\s:|-]+\|$/;

/** True when a trimmed line looks like a table row rather than prose. */
export function isTableRow(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|") && !SEPARATOR_RE.test(line);
}

/**
 * Split a table row on unescaped pipes. The leading pipe is skipped and the
 * trailing one closes the final cell, so a well-formed row yields exactly as
 * many cells as it has columns.
 */
export function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 1; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) {
      current += ch + line[++i];
    } else if (ch === "|") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  return cells;
}

/** A header row and its rule, for creating a table file that does not exist yet. */
export function tableHeader(columns: readonly string[]): string {
  return `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |`;
}

/**
 * Render a row. Cells are not padded to a common width: both tables are
 * appended to, and aligning columns would mean rewriting rows already written.
 * An empty cell becomes a single space so the pipes still line up as a row.
 */
export function renderCells(cells: readonly string[]): string {
  return `| ${cells.map((cell) => escapeCell(cell) || " ").join(" | ")} |`;
}
