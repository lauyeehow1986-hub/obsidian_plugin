/**
 * A tiny element tree, and its serialisation to HTML (CLAUDE.md §7 A3, B7).
 *
 * Why this exists rather than JSX everywhere: a chart has to render twice — as
 * live Preact in the cockpit, and as a string in the static HTML export. Two
 * hand-written renderers would drift, and the one that drifts is the one nobody
 * looks at until they hand it to a committee. So the *layout* is built once as
 * a neutral tree, and each surface adapts it: `ui/charts` maps it to Preact's
 * `h`, and `toHtml` below serialises it.
 *
 * The alternative was `preact-render-to-string`, which would have meant a new
 * dependency for something this file does in sixty lines.
 *
 * Escaping is the point of the serialiser, not an afterthought: every value in
 * a tree originates in a note, and §8 forbids putting vault-derived content
 * anywhere near raw markup.
 *
 * Pure module: no Obsidian, no Node.
 */

export interface El {
  tag: string;
  attrs: Record<string, string | number | boolean | undefined>;
  children: Node[];
}

export type Node = El | string | number | null | false | undefined;

export function el(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | Node[])[]
): El {
  return { tag, attrs, children: children.flat() };
}

/** HTML void elements — serialised without a closing tag. */
const VOID = new Set(["area", "base", "br", "col", "hr", "img", "input", "link", "meta", "wbr"]);

/** Text content. `&`, `<` and `>` only; quotes are safe outside an attribute. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute values, which additionally must not close their own quoting. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function attrsToHtml(attrs: El["attrs"]): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    // A bare attribute (`hidden`) rather than `hidden="true"`.
    if (value === true) {
      parts.push(` ${name}`);
      continue;
    }
    parts.push(` ${name}="${escapeAttr(String(value))}"`);
  }
  return parts.join("");
}

export function toHtml(node: Node): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string") return escapeText(node);
  if (typeof node === "number") return escapeText(String(node));

  const open = `<${node.tag}${attrsToHtml(node.attrs)}>`;
  if (VOID.has(node.tag)) return open;
  return `${open}${node.children.map(toHtml).join("")}</${node.tag}>`;
}

/** Every string of text in a tree, in order. Used to assert charts stay labelled. */
export function textOf(node: Node): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  // Empty children are dropped rather than joined, so a conditional branch that
  // rendered nothing does not leave a stray space in the middle of a sentence.
  return node.children
    .map(textOf)
    .filter((text) => text !== "")
    .join(" ");
}
