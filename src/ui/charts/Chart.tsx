import { Fragment, h, type ComponentChild } from "preact";
import type { Node } from "../../domain/report/element";

/**
 * Render a neutral element tree (`domain/report/element`) as Preact.
 *
 * The whole adapter is this function. Chart layout lives in `domain/report`
 * so the cockpit and the static HTML export cannot disagree about what a chart
 * looks like; this maps that tree onto `h`, and `toHtml` maps it onto a string.
 *
 * Preact escapes text and attribute values itself, so nothing here needs to —
 * and nothing here may reach for `dangerouslySetInnerHTML` (§8).
 */
function toVNode(node: Node, index: number): ComponentChild {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  // `key` travels inside `attrs` where the tree needed one; Preact picks it up
  // from props, and positional index covers everything else.
  return h(
    node.tag,
    { key: index, ...node.attrs } as never,
    node.children.map((child, childIndex) => toVNode(child, childIndex)),
  );
}

export function Chart({ node }: { node: Node }) {
  return <Fragment>{toVNode(node, 0)}</Fragment>;
}
