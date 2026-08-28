/**
 * The diagram model (§5.14, §7 D1) — a `type: diagram` note as nodes and edges.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * **Nodes and edges live in frontmatter, not a fenced block.** §5.1 makes
 * frontmatter the source of truth, and it buys three things a body block would
 * not: Obsidian's metadata cache reads it for us, `processFrontMatter` merges
 * it key by key so unknown keys survive (rule 8), and there is no hand-rolled
 * YAML emitter to get the quoting wrong. A flowchart of twenty nodes fits;
 * a REDCap instrument (D2) genuinely does not, which is why that one differs.
 *
 * **Nothing here throws.** A diagram note is hand-editable, so it will be
 * hand-broken. Parsing reports what it could not read and drives the rest —
 * one malformed edge should not cost you the other nineteen. The one thing it
 * will not do is guess: an edge pointing at a node that does not exist is
 * dropped and named, because Mermaid would otherwise invent a phantom node
 * labelled with the raw id, and a diagram that shows a box nobody drew is
 * worse than a diagram missing an arrow.
 *
 * Pure module: no Obsidian, no Node.
 */

export const DIAGRAM_NOTE_TYPE = "diagram";

/** Roughly what Mermaid's flowchart shapes are good for, named in English. */
export const NODE_SHAPES = [
  "box",
  "round",
  "stadium",
  "diamond",
  "circle",
  "subroutine",
  "cylinder",
] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

export const EDGE_STYLES = ["solid", "thick", "dotted"] as const;
export type EdgeStyle = (typeof EDGE_STYLES)[number];

export const DIRECTIONS = ["TD", "LR", "BT", "RL"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * Node colouring, drawn from the one semantic palette (§6).
 *
 * Deliberately the same six states the boards use rather than a free colour
 * per node: a diagram generated from a request should read in the same colours
 * as the queue it came from, and a palette anyone can extend stops being a
 * palette. `none` is the default and is not a colour.
 */
export const DIAGRAM_STATES = [
  "none",
  "overdue",
  "at-risk",
  "on-track",
  "blocked",
  "done",
] as const;
export type DiagramState = (typeof DIAGRAM_STATES)[number];

/** How a diagram came to exist. Generated ones can be redrawn; hand ones cannot. */
export const DIAGRAM_SOURCES = ["hand", "workflow", "request-path", "data-flow"] as const;
export type DiagramSource = (typeof DIAGRAM_SOURCES)[number];

export interface DiagramNode {
  id: string;
  label: string;
  shape: NodeShape;
  state: DiagramState;
  /** Free text for the author. Never rendered into the diagram. */
  note: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string;
  style: EdgeStyle;
}

export interface DiagramSpec {
  /** Human label, `DIA-...`. May be empty on a note that has not been named. */
  id: string;
  title: string;
  direction: Direction;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  source: DiagramSource;
  /**
   * What a generated diagram was drawn from — `edata-request@3`, `REQ-2026-014`.
   *
   * Its job is to make a stale diagram detectable: a lifecycle drawn from
   * spec v3 and still sitting in the vault after the spec moves to v4 is a
   * picture of a process nobody follows any more.
   */
  generatedFrom: string;
  /** `YYYY-MM-DD`, or empty on a hand-drawn diagram. */
  generatedAt: string;
}

export interface ParsedDiagram {
  spec: DiagramSpec;
  /** Plain English, surfaced in the editor. Never swallowed. */
  problems: string[];
}

/**
 * Caps, so a generator pointed at the wrong thing cannot wedge the renderer.
 *
 * Mermaid lays a flowchart out synchronously on the UI thread; a few hundred
 * nodes is seconds of frozen Obsidian. These are also honest editorial limits —
 * §6 says a chart that cannot be read at sidebar width is the wrong chart, and
 * that goes double for a diagram destined for a slide.
 */
export const MAX_NODES = 120;
export const MAX_EDGES = 240;

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Case-insensitive in both directions: `direction: lr` in a hand-written note
 * has to reach the uppercase `LR` Mermaid wants, and matching a lowercased
 * input against an uppercase vocabulary would quietly never match.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = str(value).toLowerCase();
  return allowed.find((option) => option.toLowerCase() === raw) ?? fallback;
}

/**
 * Fold a label into something usable as a node id.
 *
 * Only ever a starting point: ids are stable identity in this model, so a
 * caller that renames a node must not re-derive the id from the new label or
 * every edge pointing at it breaks. Used when creating a node, never after.
 */
export function slugId(label: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "n";
  const head = /^[a-z]/.test(base) ? base : `n_${base}`;
  if (!taken.has(head)) return head;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${head}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${head}_${Date.now()}`;
}

function parseNode(raw: unknown, at: string, problems: string[]): DiagramNode | null {
  if (!isRecord(raw)) {
    problems.push(`${at} is not a node — expected something like { id: intake, label: Intake }.`);
    return null;
  }
  const id = str(raw["id"]);
  const label = str(raw["label"]);
  if (id === "" && label === "") {
    problems.push(`${at} has neither an id nor a label, so there is nothing to draw.`);
    return null;
  }
  return {
    id: id === "" ? slugId(label) : id,
    label: label === "" ? id : label,
    shape: oneOf(raw["shape"], NODE_SHAPES, "box"),
    state: oneOf(raw["state"], DIAGRAM_STATES, "none"),
    note: str(raw["note"]),
  };
}

function parseEdge(raw: unknown, at: string, problems: string[]): DiagramEdge | null {
  if (!isRecord(raw)) {
    problems.push(`${at} is not an edge — expected something like { from: intake, to: triage }.`);
    return null;
  }
  const from = str(raw["from"]);
  const to = str(raw["to"]);
  if (from === "" || to === "") {
    problems.push(`${at} needs both a \`from\` and a \`to\`.`);
    return null;
  }
  return { from, to, label: str(raw["label"]), style: oneOf(raw["style"], EDGE_STYLES, "solid") };
}

/** An empty diagram, for a note being created. */
export function emptyDiagram(title = ""): DiagramSpec {
  return {
    id: "",
    title,
    direction: "TD",
    nodes: [],
    edges: [],
    source: "hand",
    generatedFrom: "",
    generatedAt: "",
  };
}

/**
 * Read a diagram out of a note's frontmatter.
 *
 * The caller supplies the frontmatter as a plain object — the same division of
 * labour as `parseWorkflowSpec`, so this module stays free of Obsidian.
 */
export function parseDiagram(frontmatter: unknown): ParsedDiagram {
  const problems: string[] = [];
  if (!isRecord(frontmatter)) {
    return { spec: emptyDiagram(), problems: ["The note has no frontmatter to read a diagram from."] };
  }

  const rawNodes = Array.isArray(frontmatter["nodes"]) ? frontmatter["nodes"] : [];
  if (frontmatter["nodes"] !== undefined && !Array.isArray(frontmatter["nodes"])) {
    problems.push("`nodes` is not a list, so no nodes could be read.");
  }
  const rawEdges = Array.isArray(frontmatter["edges"]) ? frontmatter["edges"] : [];
  if (frontmatter["edges"] !== undefined && !Array.isArray(frontmatter["edges"])) {
    problems.push("`edges` is not a list, so no edges could be read.");
  }

  const nodes: DiagramNode[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawNodes.entries()) {
    if (nodes.length >= MAX_NODES) {
      problems.push(
        `Only the first ${MAX_NODES} nodes are drawn; ${rawNodes.length - MAX_NODES} more were left out. Split the diagram.`,
      );
      break;
    }
    const node = parseNode(raw, `nodes[${index}]`, problems);
    if (node === null) continue;
    if (seen.has(node.id)) {
      problems.push(`Two nodes share the id "${node.id}"; the second was dropped.`);
      continue;
    }
    seen.add(node.id);
    nodes.push(node);
  }

  const edges: DiagramEdge[] = [];
  for (const [index, raw] of rawEdges.entries()) {
    if (edges.length >= MAX_EDGES) {
      problems.push(
        `Only the first ${MAX_EDGES} edges are drawn; ${rawEdges.length - MAX_EDGES} more were left out.`,
      );
      break;
    }
    const edge = parseEdge(raw, `edges[${index}]`, problems);
    if (edge === null) continue;
    // Dropped rather than drawn: see the module header. Mermaid would invent a
    // box for the missing end, and an invented box in a governance diagram is
    // the sort of thing that gets believed.
    const missing = [!seen.has(edge.from) && edge.from, !seen.has(edge.to) && edge.to].filter(
      (value): value is string => typeof value === "string",
    );
    if (missing.length > 0) {
      problems.push(
        `edges[${index}] points at ${missing.map((m) => `"${m}"`).join(" and ")}, which no node declares; the arrow was dropped.`,
      );
      continue;
    }
    edges.push(edge);
  }

  return {
    spec: {
      id: str(frontmatter["id"]),
      title: str(frontmatter["title"]),
      direction: oneOf(frontmatter["direction"], DIRECTIONS, "TD"),
    nodes,
      edges,
      source: oneOf(frontmatter["source"], DIAGRAM_SOURCES, "hand"),
      generatedFrom: str(frontmatter["generated_from"]),
      generatedAt: str(frontmatter["generated_at"]),
    },
    problems,
  };
}

/**
 * The frontmatter keys a diagram owns, as plain data for `processFrontMatter`.
 *
 * Only the keys this model understands. Everything else on the note is left
 * exactly as it was found (rule 8) — the caller merges rather than replaces.
 */
export function diagramFrontmatter(spec: DiagramSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: DIAGRAM_NOTE_TYPE,
    title: spec.title,
    direction: spec.direction,
    source: spec.source,
    nodes: spec.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      shape: node.shape,
      state: node.state,
      ...(node.note === "" ? {} : { note: node.note }),
    })),
    edges: spec.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.label === "" ? {} : { label: edge.label }),
      style: edge.style,
    })),
  };
  if (spec.id !== "") out["id"] = spec.id;
  if (spec.generatedFrom !== "") out["generated_from"] = spec.generatedFrom;
  if (spec.generatedAt !== "") out["generated_at"] = spec.generatedAt;
  return out;
}

/** Nodes nothing points at and that point at nothing. Reported, not removed. */
export function orphanNodes(spec: DiagramSpec): DiagramNode[] {
  const touched = new Set<string>();
  for (const edge of spec.edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }
  return spec.nodes.filter((node) => !touched.has(node.id));
}

/** How a diagram is named in a notice or a file name. */
export function diagramLabel(spec: DiagramSpec): string {
  return spec.title || spec.id || "(untitled diagram)";
}
