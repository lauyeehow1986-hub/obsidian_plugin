/**
 * A report as a markdown note (CLAUDE.md §7 B7).
 *
 * The third surface for one element tree, after the cockpit's Preact and the
 * static HTML export. B7 asks for "a markdown note with tables and embedded
 * SVG", and both halves of that are deliberate:
 *
 *  - **Tables, not HTML tables.** A pipe table is something the user can edit,
 *    diff, sort in a Base and paste into an email. An HTML table in a note is
 *    a wall of markup that Obsidian renders and nothing else can touch. Rule
 *    11: everything we write is plain markdown a human can read and undo.
 *  - **SVG, because a note has no stylesheet.** Charts arrive already drawn
 *    with presentation attributes (`svg.ts`) and are passed through as the one
 *    piece of literal markup in the file.
 *
 * The note also carries frontmatter, so a generated report is a note the index
 * and the query engine can see rather than a dead artefact.
 *
 * **Escaping.** Every string in the tree came out of a note, and markdown has
 * its own injection surface: a `|` splits a table row, a leading `#` becomes a
 * heading, a leading `-` becomes a bullet. None of that is dangerous the way
 * raw HTML is — Preact and `toHtml` handle that — but a report that silently
 * reformats itself around a study called "- Pilot" is wrong, so structural
 * characters are escaped where they would be read as structure and left alone
 * where they would not.
 *
 * Pure module: no Obsidian, no Node.
 */

import { markdownCell } from "../query/format";
import type { ReportDocument } from "./document";
import { toHtml, type El, type Node } from "./element";

/** The `type:` a generated report note carries, so the index can find it. */
export const REPORT_NOTE_TYPE = "scdb-report";

export interface MarkdownOptions {
  /** Goes into `template:` in the frontmatter, for regenerating later. */
  templateId: string;
  /** `2026-07`, `2026`, or "". */
  period: string;
  /** The study the report is about, as written, or "". */
  study: string;
  /** Rows the report is about — the same number the ledger records. */
  rows: number;
}

/**
 * Escape what markdown would read as structure at the start of a line.
 *
 * Only the start: a hash mid-sentence is a hash, and escaping every one would
 * litter the prose with backslashes to prevent a problem that does not exist.
 */
function escapeBlock(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/^(\s*)([#>|]|[-+*]\s|\d+[.)]\s)/, "$1\\$2")
    .trim();
}

function isEl(node: Node): node is El {
  return typeof node === "object" && node !== null;
}

/** Every string under a node, joined — the inline content of a block. */
function inlineText(node: Node): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  // A `<title>` inside an SVG `<text>` is a tooltip, not content; it would
  // otherwise print the label twice.
  if (node.tag === "title") return "";
  return node.children
    .map(inlineText)
    .filter((part) => part !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cellsOf(row: El): string[] {
  return row.children
    .filter(isEl)
    .filter((child) => child.tag === "td" || child.tag === "th")
    .map((child) => markdownCell(inlineText(child)));
}

function alignmentOf(row: El | null): string[] {
  if (row === null) return [];
  return row.children
    .filter(isEl)
    .filter((child) => child.tag === "td" || child.tag === "th")
    // §6: numbers right-aligned, with tabular figures. The `num` class is how
    // every table in this plugin says a column is a number.
    .map((child) => (String(child.attrs["class"] ?? "").includes("num") ? "---:" : "---"));
}

function rowsUnder(node: El, tag: string): El[] {
  const container = node.children.filter(isEl).find((child) => child.tag === tag);
  const scope = container ?? node;
  return scope.children.filter(isEl).filter((child) => child.tag === "tr");
}

function renderTable(node: El): string[] {
  const head = rowsUnder(node, "thead");
  const body = rowsUnder(node, "tbody");
  const header = head[0] ?? null;
  if (header === null) return [];

  const headerCells = cellsOf(header);
  // A header row of empty strings (the portfolio's headline grid) still needs
  // cells, or the pipe table has no shape and renders as a paragraph.
  const lines = [
    `| ${headerCells.join(" | ")} |`,
    `| ${alignmentOf(header).join(" | ")} |`,
    ...body.map((row) => `| ${cellsOf(row).join(" | ")} |`),
  ];
  return [lines.join("\n")];
}

function renderList(node: El): string[] {
  const items = node.children
    .filter(isEl)
    .filter((child) => child.tag === "li")
    .map((child) => inlineText(child));
  if (items.length === 0) return [];

  const lines = items.map((item, index) =>
    node.tag === "ol" ? `${index + 1}. ${escapeBlock(item)}` : `- ${escapeBlock(item)}`,
  );
  return [lines.join("\n")];
}

/** One node as zero or more markdown blocks, each separated by a blank line. */
function renderNode(node: Node): string[] {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === "string" || typeof node === "number") {
    const text = escapeBlock(String(node));
    return text === "" ? [] : [text];
  }

  switch (node.tag) {
    case "svg":
      // The one place literal markup is emitted. It is ours, built from
      // numbers, not from note text — every string inside it went through
      // `toHtml`'s escaping on the way.
      return [toHtml(node)];
    case "table":
      return renderTable(node);
    case "ul":
    case "ol":
      return renderList(node);
    case "h2":
    case "h3":
    case "h4": {
      const text = escapeBlock(inlineText(node));
      const hashes = "#".repeat(Number(node.tag.slice(1)));
      return text === "" ? [] : [`${hashes} ${text}`];
    }
    case "p": {
      const text = escapeBlock(inlineText(node));
      if (text === "") return [];
      const classes = String(node.attrs["class"] ?? "");
      // A lede and an empty state are both said quietly on screen; italics is
      // markdown's only equivalent, and it keeps them distinguishable from the
      // report's own findings when the note is read as plain text.
      return classes.includes("lede") || classes.includes("scdb-empty")
        ? [`*${text}*`]
        : [text];
    }
    default:
      return node.children.flatMap(renderNode);
  }
}

function frontmatter(document: ReportDocument, options: MarkdownOptions): string[] {
  const lines = [
    "---",
    `type: ${REPORT_NOTE_TYPE}`,
    `title: ${yaml(document.title)}`,
    `template: ${yaml(options.templateId)}`,
  ];
  if (options.period !== "") lines.push(`period: ${yaml(options.period)}`);
  if (options.study !== "") lines.push(`study: ${yaml(options.study)}`);
  lines.push(`generated: ${yaml(document.generatedAt)}`, `rows: ${options.rows}`);
  if (document.scope !== undefined && document.scope !== "") {
    lines.push(`scope: ${yaml(document.scope)}`);
  }
  lines.push("---");
  return [lines.join("\n")];
}

/**
 * A frontmatter scalar, always quoted.
 *
 * Quoting everything rather than deciding case by case: a title containing a
 * colon, a leading `[`, or the word `yes` are each a different way for an
 * unquoted value to parse as something other than the string it is.
 */
function yaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderMarkdown(document: ReportDocument, options: MarkdownOptions): string {
  const blocks: string[] = [
    ...frontmatter(document, options),
    `# ${escapeBlock(document.title)}`,
    `*${escapeBlock(document.subtitle)}*`,
  ];

  if (document.scope !== undefined && document.scope !== "") {
    blocks.push(`*${escapeBlock(document.scope)}*`);
  }

  for (const section of document.sections) {
    if (section.heading !== "") blocks.push(`## ${escapeBlock(section.heading)}`);
    if (section.lede !== undefined && section.lede !== "") {
      blocks.push(`*${escapeBlock(section.lede)}*`);
    }
    blocks.push(...renderNode(section.body));
  }

  // The same provenance line the HTML export carries, and for the same reason
  // (§5.1): this is what the vault observed at a moment, not an official
  // record. A markdown note is the form most likely to be copied onwards, so
  // it is the one that can least afford to leave the caveat behind.
  blocks.push(
    "---",
    `*Generated by SCDB Cockpit from the vault on ${document.generatedAt}. ` +
      "This is what the vault recorded at that moment, not an official record — " +
      "the institutional eData system remains authoritative for a request's " +
      "existence and approval state.*",
  );

  return `${blocks.filter((block) => block !== "").join("\n\n")}\n`;
}
