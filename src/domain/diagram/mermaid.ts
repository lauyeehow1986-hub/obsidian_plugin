/**
 * Diagram model → Mermaid source (§7 D1).
 *
 * **This module is a sanitiser as much as a formatter, and that is the reason
 * it exists separately.** Every label here comes from vault content — a note
 * title, a person's name, a stage label out of a YAML file somebody emailed
 * over. Obsidian renders the result with core Mermaid, and Mermaid will treat
 * markup in a label as markup when HTML labels are on. Rule 8 of §8 says never
 * put vault-derived content through `innerHTML`; handing it to Mermaid unescaped
 * is the same act with an extra step. So labels are escaped character by
 * character into Mermaid's `#nnn;` entity form, and node ids — which are also
 * hand-editable — are reduced to `[A-Za-z0-9_]` before they can become syntax.
 *
 * Escaping happens in **one pass over the characters**, never as a sequence of
 * string replaces: `#` has to become `#35;`, and a second pass would go on to
 * mangle the `#` in every escape the first pass wrote.
 *
 * The second rule from §6 lives here too: **never colour alone.** A state's
 * glyph is prefixed to its label, so a red box still reads as overdue in
 * greyscale, in a colour-blind reader's eyes, and on a projector that renders
 * everything beige.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { DiagramSpec, DiagramState, EdgeStyle, NodeShape } from "./diagram";

/** `fill,stroke,color` for one state, as literal CSS colours. */
export interface NodeColours {
  fill: string;
  stroke: string;
  text: string;
}

export type DiagramPalette = Record<DiagramState, NodeColours>;

/**
 * The fallback palette: coloured stroke and text, no fill.
 *
 * A fill has to pick a side — a pale fill vanishes on a dark theme, a dark one
 * on a light theme — and this palette has to be legible in both without
 * knowing which it is in. The renderer resolves the real one from the theme's
 * own custom properties (§6) and passes it in; this is what is used when
 * nothing has been resolved, and when a test wants a deterministic string.
 */
export const FALLBACK_PALETTE: DiagramPalette = {
  none: { fill: "transparent", stroke: "#8a8a8a", text: "inherit" },
  overdue: { fill: "transparent", stroke: "#b3261e", text: "#b3261e" },
  "at-risk": { fill: "transparent", stroke: "#8a6100", text: "#8a6100" },
  "on-track": { fill: "transparent", stroke: "#1b6b2f", text: "#1b6b2f" },
  blocked: { fill: "transparent", stroke: "#4a5bd4", text: "#4a5bd4" },
  done: { fill: "transparent", stroke: "#8a8a8a", text: "#8a8a8a" },
};

/**
 * Glyph per state — §6's "never colour alone", applied to a picture.
 *
 * The same meanings `domain/report/present` gives the boards, written out here
 * rather than imported because that module speaks in CSS class names and a
 * Mermaid label cannot carry one.
 */
const STATE_GLYPHS: Record<DiagramState, string> = {
  none: "",
  overdue: "!",
  "at-risk": "~",
  "on-track": "+",
  blocked: "?",
  done: "*",
};

/** Mermaid class name per state. Must be a bare identifier. */
const STATE_CLASSES: Record<DiagramState, string> = {
  none: "scdbNone",
  overdue: "scdbOverdue",
  "at-risk": "scdbAtRisk",
  "on-track": "scdbOnTrack",
  blocked: "scdbBlocked",
  done: "scdbDone",
};

/**
 * Characters that must not reach Mermaid as themselves.
 *
 * `"` would close the label; `#` starts an entity and so must be escaped
 * first-and-only; `<`, `>` and `&` are markup the moment HTML labels are on;
 * a backtick opens Mermaid's markdown-string form; a backslash is an escape in
 * some label positions. Everything else is left alone — over-escaping turns a
 * readable label into soup.
 */
const ESCAPES: Record<string, string> = {
  "#": "#35;",
  '"': "#34;",
  "<": "#60;",
  ">": "#62;",
  "&": "#38;",
  "`": "#96;",
  "\\": "#92;",
  "{": "#123;",
  "}": "#125;",
  "|": "#124;",
  "[": "#91;",
  "]": "#93;",
  "(": "#40;",
  ")": "#41;",
  ";": "#59;",
};

/**
 * A label safe to place inside Mermaid quotes.
 *
 * Every escape is the decimal `#nnn;` form rather than a named one: decimal is
 * the form Mermaid documents, and a named `#quot;` would rest on whichever
 * Mermaid the target Obsidian happens to bundle supporting it.
 *
 * Newlines and other control characters collapse to a space. Mermaid's
 * line-break form is `<br/>`, which is markup, and markup is the thing this
 * function exists to keep out.
 */
export function escapeLabel(value: string): string {
  // Character by character, not a chain of string replaces: `#` becomes `#35;`
  // and a second pass would go on to mangle the `#` in every escape the first
  // pass had just written.
  const flattened = [...value]
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .replace(/ +/g, " ");
  return flattened.replace(/[#"<>&`\\{}|[\]();]/g, (char) => ESCAPES[char] ?? char).trim();
}

/**
 * A node id reduced to something that cannot be syntax.
 *
 * Ids are read from frontmatter a person edits, so `a-->b` is a thing that can
 * arrive here. The mapping is applied to both ends of every edge, so it stays
 * consistent even when two different ids fold onto the same safe form — hence
 * the collision counter.
 */
function safeIdMap(spec: DiagramSpec): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const node of spec.nodes) {
    const base = node.id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "") || "n";
    const head = /^[A-Za-z]/.test(base) ? base : `n_${base}`;
    let candidate = head;
    for (let i = 2; used.has(candidate); i++) candidate = `${head}_${i}`;
    used.add(candidate);
    map.set(node.id, candidate);
  }
  return map;
}

const SHAPES: Record<NodeShape, [string, string]> = {
  box: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  diamond: ["{", "}"],
  circle: ["((", "))"],
  subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"],
};

const ARROWS: Record<EdgeStyle, string> = {
  solid: "-->",
  thick: "==>",
  dotted: "-.->",
};

/**
 * A colour safe to place in a Mermaid `classDef`.
 *
 * `classDef` takes a **comma-separated** list of `name:value` pairs, so a
 * perfectly ordinary CSS colour breaks the parser: a theme whose accent
 * resolves to `hsl(258, 88%, 66%)` turns one style declaration into four, and
 * Mermaid fails the whole diagram with a parse error. That is not hypothetical
 * — it is what the default Obsidian theme did the first time this ran.
 *
 * The renderer converts resolved colours to hex before they get here; this is
 * the guard that means a caller who forgets cannot emit a broken diagram.
 * Anything with a comma, a space or a semicolon in it is refused rather than
 * escaped: there is no escaping in `classDef`, only a different colour.
 */
export function safeColour(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/.test(trimmed) ? trimmed : fallback;
}

export interface MermaidOptions {
  /** Theme-resolved colours. Omit for the fallback palette. */
  palette?: DiagramPalette;
  /**
   * Whether to prefix state glyphs onto labels.
   *
   * On by default and should stay that way (§6). The switch exists because a
   * diagram whose every node is `none` gains nothing from the machinery, and
   * a test wants to read the label it wrote.
   */
  glyphs?: boolean;
}

/** The Mermaid source for a diagram, ready for a ```mermaid fence. */
export function toMermaid(spec: DiagramSpec, options: MermaidOptions = {}): string {
  const palette = options.palette ?? FALLBACK_PALETTE;
  const glyphs = options.glyphs ?? true;
  const ids = safeIdMap(spec);
  const lines: string[] = [`flowchart ${spec.direction}`];

  for (const node of spec.nodes) {
    const [open, close] = SHAPES[node.shape];
    const glyph = glyphs ? STATE_GLYPHS[node.state] : "";
    const text = escapeLabel(glyph === "" ? node.label : `${glyph} ${node.label}`);
    lines.push(`  ${ids.get(node.id) ?? "n"}${open}"${text}"${close}`);
  }

  for (const edge of spec.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    // Unreachable for a parsed spec — `parseDiagram` drops dangling edges — but
    // a caller may build a spec by hand, and a phantom node is the one outcome
    // this module must never produce.
    if (from === undefined || to === undefined) continue;
    const arrow = ARROWS[edge.style];
    const label = escapeLabel(edge.label);
    lines.push(`  ${from} ${label === "" ? arrow : `${arrow}|"${label}"|`} ${to}`);
  }

  // Only the states actually in use, so the source stays readable and a
  // diagram with no colouring carries no colour machinery at all.
  //
  // `none` is included *only* once something else is coloured. Left to
  // Mermaid's own theme an uncoloured node comes out in a confident lavender,
  // which reads louder than the states that actually mean something — the
  // uncoloured boxes end up looking like the important ones. Once any state is
  // in play, `none` is given the quiet neutral it should have had.
  const used = new Set(spec.nodes.map((node) => node.state));
  const meaningful = [...used].filter((state) => state !== "none");
  const inUse = meaningful.length > 0 && used.has("none") ? ["none" as const, ...meaningful] : meaningful;
  for (const state of inUse) {
    const colours = palette[state];
    const fallback = FALLBACK_PALETTE[state];
    const fill = safeColour(colours.fill, fallback.fill);
    const stroke = safeColour(colours.stroke, fallback.stroke);
    const text = safeColour(colours.text, fallback.text);
    lines.push(
      `  classDef ${STATE_CLASSES[state]} fill:${fill},stroke:${stroke},color:${text},stroke-width:2px`,
    );
  }
  for (const state of inUse) {
    const members = spec.nodes
      .filter((node) => node.state === state)
      .map((node) => ids.get(node.id))
      .filter((id): id is string => id !== undefined);
    if (members.length > 0) lines.push(`  class ${members.join(",")} ${STATE_CLASSES[state]}`);
  }

  return lines.join("\n");
}

/** The Mermaid source wrapped in the fence Obsidian renders. */
export function toMermaidBlock(spec: DiagramSpec, options: MermaidOptions = {}): string {
  return ["```mermaid", toMermaid(spec, options), "```"].join("\n");
}
