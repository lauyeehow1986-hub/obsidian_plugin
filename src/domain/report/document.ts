/**
 * A self-contained HTML document (CLAUDE.md §7 A3).
 *
 * The output opens in any browser on a machine with no Obsidian, no plugin and
 * no network: one file, styles inlined, no script, no external request of any
 * kind. That is a hard requirement, not a preference — the whole point is to
 * hand a board to somebody who does not have the vault.
 *
 * **No redaction machinery**, deliberately (§7 A3). The export carries what the
 * board showed. The guards are elsewhere and are the three A3 names: it always
 * lands in `95 Exports/`, the user confirms a line naming the file and the row
 * count, and the write appends an `export` entry to the audit ledger.
 *
 * Every document carries a provenance footer, because §5.1 is explicit that
 * nothing generated here is ever presented as the official record: the
 * institutional eData system is authoritative, and a governance instrument that
 * quietly contradicts the system of record is worse than no instrument.
 *
 * Pure module: no Obsidian, no Node.
 */

import { el, toHtml, type El, type Node } from "./element";

export interface ReportSection {
  heading: string;
  /** One line saying what the section is, shown under the heading. */
  lede?: string;
  body: Node;
}

export interface ReportDocument {
  title: string;
  /** The one-line state of what is being shown, e.g. "9 live requests". */
  subtitle: string;
  /** Rendered into the footer as an ISO-ish local stamp. */
  generatedAt: string;
  /** Which hat the board was filtered to, if it was. */
  scope?: string;
  sections: ReportSection[];
}

/**
 * The stylesheet, inlined.
 *
 * It cannot reference Obsidian's theme variables — there is no Obsidian here —
 * so §6's semantic palette is restated in plain CSS with a dark-mode block. The
 * contrast choices are the same ones `styles.css` documents.
 */
const CSS = `
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #5b6168;
  --line: #d8dbe0;
  --accent: #3a5bd9;
  --overdue: #b3261e;
  --panel: #f6f7f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c;
    --fg: #e8eaed;
    --muted: #a2a9b2;
    --line: #333840;
    --accent: #8ea4f5;
    --overdue: #f2857c;
    --panel: #1e2126;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 32px 20px 48px;
  max-width: 60rem;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
h1 { margin: 0 0 4px; font-size: 1.5rem; }
h2 { margin: 32px 0 4px; font-size: 1.1rem; }
p { margin: 4px 0; }
.sub, .lede, .foot { color: var(--muted); font-size: 0.85rem; }
.foot { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.88rem; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.state { white-space: nowrap; font-size: 0.82rem; }
.state--overdue { color: var(--overdue); font-weight: 600; }
.scdb-empty { color: var(--muted); font-style: italic; }
.scdb-chart { margin: 0 0 20px; break-inside: avoid; }
.scdb-chart__caption { display: block; margin-bottom: 6px; }
.scdb-chart__title { display: block; font-weight: 600; font-size: 0.95rem; }
.scdb-chart__meta, .scdb-chart__foot { display: block; color: var(--muted); font-size: 0.8rem; }
.scdb-bars { margin: 0; padding: 0; list-style: none; }
.scdb-bar {
  display: grid;
  grid-template-columns: minmax(7em, 12em) 1fr auto;
  gap: 2px 8px;
  align-items: center;
  padding: 3px 0;
}
.scdb-bar__label { font-size: 0.85rem; overflow-wrap: anywhere; }
.scdb-bar__track { height: 12px; border-radius: 2px; background: var(--panel); }
.scdb-bar__fill { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.scdb-bar__emphasis { display: block; height: 100%; border-radius: 2px 0 0 2px; background: var(--overdue); }
.scdb-bar__value { font-size: 0.85rem; font-variant-numeric: tabular-nums; }
.scdb-bar__note { grid-column: 2 / -1; color: var(--muted); font-size: 0.8rem; }
.scdb-trend { display: block; width: 100%; max-width: 480px; height: auto; }
.scdb-trend__line { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
.scdb-trend__dot { fill: var(--accent); }
.scdb-trend__axis { stroke: var(--muted); stroke-width: 0.75; }
.scdb-trend__grid { stroke: var(--line); stroke-width: 0.75; }
.scdb-trend__tick { fill: var(--muted); font-size: 8px; }
.scdb-trend__value { fill: var(--fg); font-size: 9px; }
/* min(...) so the grid can shrink below the track minimum on a narrow window
   rather than forcing the page to scroll sideways. */
.chartgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 20px; }

/* Print: this is a board somebody will put in front of a committee. Bars must
   survive the printer's default of dropping backgrounds, and a section must not
   break across a page in the middle of a chart. */
@media print {
  :root { --bg: #ffffff; --fg: #000000; --muted: #444444; --line: #999999; --panel: #eeeeee; }
  body { max-width: none; padding: 0; font-size: 11pt; }
  .scdb-bar__fill, .scdb-bar__emphasis, .scdb-bar__track {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h2 { break-after: avoid; }
  table, .scdb-chart { break-inside: avoid; }
}
`.trim();

function section(entry: ReportSection): El {
  return el(
    "section",
    {},
    el("h2", {}, entry.heading),
    entry.lede ? el("p", { class: "lede" }, entry.lede) : null,
    entry.body,
  );
}

/** The whole document, as a string ready to be written to `95 Exports/`. */
export function renderDocument(doc: ReportDocument): string {
  const head = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${toHtml(doc.title)}</title>`,
    `<style>${CSS}</style>`,
    "</head>",
  ].join("\n");

  const body = el(
    "body",
    {},
    el("h1", {}, doc.title),
    el("p", { class: "sub" }, doc.subtitle),
    doc.scope ? el("p", { class: "sub" }, doc.scope) : null,
    doc.sections.map(section),
    el(
      "p",
      { class: "foot" },
      `Generated by SCDB Cockpit from the vault on ${doc.generatedAt}. ` +
        "This is what the vault recorded at that moment, not an official record — " +
        "the institutional eData system remains authoritative for a request's " +
        "existence and approval state.",
    ),
  );

  return `${head}\n${toHtml(body)}\n</html>\n`;
}
