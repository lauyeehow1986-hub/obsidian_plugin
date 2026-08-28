/**
 * Diagram → SVG → PNG → clipboard (§7 D1).
 *
 * The plugin bundles no diagram library. Obsidian already carries Mermaid as a
 * core feature, so a diagram is rendered by asking `MarkdownRenderer.render` to
 * render a fenced block and then lifting the `<svg>` it produced. That keeps
 * ~500 KB out of the bundle budget (§3) and keeps rule 2 — core APIs are not a
 * plugin dependency. It also makes core Mermaid a real runtime assumption,
 * which is why A4's diagnostics probes it rather than assuming it.
 *
 * Three things here are not obvious and should not be "simplified":
 *
 *  - **The host is off-screen, not detached.** §7 D1 says a detached element,
 *    and a detached element is what you would reach for. Mermaid measures text
 *    to lay a flowchart out, and text in an element that is not in the document
 *    has no measurable size, so labels collide or the diagram comes back with
 *    zero dimensions. The host is therefore in the document and positioned far
 *    off-screen, and is always removed in a `finally`.
 *
 *  - **Rendering finishes after the promise does.** Mermaid renders
 *    asynchronously beyond the promise `render` returns, so the SVG is polled
 *    for with a deadline. A timeout is reported as a timeout, never as an empty
 *    diagram.
 *
 *  - **The exported SVG carries explicit pixel dimensions.** Mermaid sizes its
 *    output with a `max-width` style and a viewBox, which a browser resolves
 *    against a parent that an exported file does not have. Without a width and
 *    height a rasterised PNG comes out either tiny or blank, which is precisely
 *    the failure that would only show up in the slide.
 */

import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { DiagramSpec } from "../domain/diagram/diagram";
import { diagramLabel } from "../domain/diagram/diagram";
import {
  FALLBACK_PALETTE,
  toMermaid,
  toMermaidBlock,
  type DiagramPalette,
  type NodeColours,
} from "../domain/diagram/mermaid";

/** How long to wait for Mermaid before saying so. */
const RENDER_TIMEOUT_MS = 4000;

/** PNG scales offered. 2x is a slide; 3x is a slide someone will zoom into. */
export const PNG_SCALES = [2, 3] as const;
export type PngScale = (typeof PNG_SCALES)[number];

export class DiagramRenderFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramRenderFailed";
  }
}

/**
 * Resolve the semantic palette (§6) from whatever theme is loaded.
 *
 * The boards colour themselves with `--scdb-overdue` and friends, which resolve
 * through the theme's own `--text-error` and so on. A Mermaid `classDef` cannot
 * take a custom property — and even if it could, an exported file has no
 * Obsidian stylesheet behind it — so the values are read out of the live
 * document once and passed in as literal colours. One palette, two renderers.
 */
/**
 * Normalise any CSS colour to `#rrggbb`.
 *
 * Mermaid's `classDef` takes a comma-separated list, so a theme colour that
 * resolves to `hsl(258, 88%, 66%)` — which is exactly what Obsidian's default
 * accent does — turns one declaration into four and fails the whole diagram
 * with a parse error. A canvas context is the shortest correct converter:
 * assigning to `fillStyle` normalises whatever the browser accepts, and reading
 * it back gives hex for any opaque colour.
 *
 * `fillStyle` silently ignores a value it cannot parse, so the fallback is
 * assigned first and survives if the read fails. A colour carrying alpha comes
 * back as `rgba(...)`, still with commas, so that falls back too — a diagram
 * that renders in the wrong shade beats a diagram that does not render.
 */
function toHex(value: string, fallback: string): string {
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = value;
  const resolved = context.fillStyle;
  return typeof resolved === "string" && /^#[0-9a-f]{3,8}$/i.test(resolved) ? resolved : fallback;
}

export function resolvePalette(root: HTMLElement): DiagramPalette {
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : toHex(value, fallback);
  };

  const surface = read("--background-primary", "#ffffff");
  const ink = read("--text-normal", "#202020");
  const colours = (variable: string, fallback: NodeColours): NodeColours => {
    const stroke = read(variable, fallback.stroke);
    return { fill: surface, stroke, text: ink };
  };

  return {
    // `none` deliberately keeps a muted border rather than the accent: an
    // uncoloured node should not compete with the ones carrying meaning.
    none: { fill: surface, stroke: read("--background-modifier-border", "#8a8a8a"), text: ink },
    overdue: colours("--scdb-overdue", FALLBACK_PALETTE.overdue),
    "at-risk": colours("--scdb-at-risk", FALLBACK_PALETTE["at-risk"]),
    "on-track": colours("--scdb-on-track", FALLBACK_PALETTE["on-track"]),
    blocked: colours("--scdb-blocked", FALLBACK_PALETTE.blocked),
    done: colours("--scdb-done", FALLBACK_PALETTE.done),
  };
}

export interface RenderedDiagram {
  /** The SVG element, already sized. Owned by the caller. */
  svg: SVGSVGElement;
  /** Serialised, ready to write to a file. */
  text: string;
  width: number;
  height: number;
}

/**
 * A host that is in the viewport but invisible.
 *
 * The obvious `left: -100000px` does not work, and the reason is worth keeping:
 * Obsidian defers rendering a code block until it is on screen, so a host
 * parked far off to the left never intersects the viewport and the Mermaid
 * fence is never rendered at all — no error, no SVG, just a timeout. The host
 * therefore sits at the origin at full size and is hidden with `opacity`, which
 * an intersection check ignores. `visibility: hidden` and `display: none` would
 * both put us back where we started.
 */
function offscreenHost(): HTMLDivElement {
  const host = document.body.createDiv();
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  // A width Mermaid can lay out against. Zero-width would wrap every label.
  host.style.width = "1200px";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  host.style.zIndex = "-1";
  host.setAttribute("aria-hidden", "true");
  return host;
}

async function waitForSvg(host: HTMLElement): Promise<SVGSVGElement> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  for (;;) {
    const svg = host.querySelector("svg");
    if (svg instanceof SVGSVGElement) return svg;
    if (Date.now() >= deadline) {
      throw new DiagramRenderFailed(
        `Mermaid produced no diagram within ${RENDER_TIMEOUT_MS / 1000} seconds. Run the diagnostics self-test to check core Mermaid rendering is working.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Give the lifted SVG the dimensions a file needs.
 *
 * Mermaid leaves behind `style="max-width: NNNpx"` and a viewBox; a standalone
 * file resolves neither. The viewBox is the source of truth for the aspect
 * ratio, so width and height are taken from it and the max-width is dropped.
 */
function sizeSvg(svg: SVGSVGElement): { width: number; height: number } {
  const box = svg.viewBox.baseVal;
  const fromBox = box !== null && box.width > 0 && box.height > 0;
  const width = Math.max(1, Math.round(fromBox ? box.width : svg.clientWidth || 800));
  const height = Math.max(1, Math.round(fromBox ? box.height : svg.clientHeight || 600));
  svg.removeAttribute("style");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  if (!fromBox) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return { width, height };
}

/** The shape of Obsidian's own Mermaid, as much of it as we use. */
interface MermaidGlobal {
  render(id: string, source: string): Promise<{ svg: string }>;
}

/**
 * Obsidian's bundled Mermaid, if it is reachable directly.
 *
 * **This is the path that actually works, and the reason is worth recording.**
 * §7 D1 specifies rendering through `MarkdownRenderer.render` and lifting the
 * `<svg>`, which is the documented route — and on this machine it produces no
 * SVG at all, in a detached host or an attached one, with no error raised. A4's
 * Mermaid probe reports the same thing, which is exactly why §7 A4 asks for
 * risky integrations to be probed rather than assumed.
 *
 * `window.mermaid.render()` is Obsidian's own bundled copy — the same core
 * feature, reached without the markdown pipeline in between — so this is still
 * no diagram library of ours and no bundle cost (rule 2, §3). It returns the
 * SVG as a string, which removes the polling and the timeout as well.
 *
 * Null when a future Obsidian stops exposing it, in which case the caller falls
 * back to the documented route rather than failing outright.
 */
function mermaidGlobal(): MermaidGlobal | null {
  const candidate = (globalThis as { mermaid?: unknown }).mermaid;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as MermaidGlobal).render === "function"
  ) {
    return candidate as MermaidGlobal;
  }
  return null;
}

/**
 * Get Obsidian's Mermaid, loading it first if it has not been used yet.
 *
 * **Obsidian loads Mermaid lazily**, so `window.mermaid` is `undefined` on a
 * fresh start and only appears once something has rendered a fence. Asking the
 * markdown pipeline to render one is what triggers that load — the pipeline
 * does not give us a usable SVG in an off-screen host, but it does pull the
 * library in, which is all this needs it for. After that the direct call works
 * every time, including for the rest of the session.
 */
async function ensureMermaid(app: App, component: Component): Promise<MermaidGlobal | null> {
  const already = mermaidGlobal();
  if (already !== null) return already;

  const host = offscreenHost();
  try {
    await MarkdownRenderer.render(app, "```mermaid\nflowchart LR\n  a --> b\n```", host, "", component);
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    for (;;) {
      const loaded = mermaidGlobal();
      if (loaded !== null) return loaded;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    host.remove();
  }
}

let renderCounter = 0;

/**
 * Turn Mermaid's SVG string into an element.
 *
 * `DOMParser` rather than `innerHTML` (§8). The markup is Mermaid's own, over
 * labels this plugin escaped in `domain/diagram/mermaid`, but "it should be
 * safe" is not the standard the rule sets.
 */
function parseSvg(text: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = parsed.documentElement;
  if (parsed.querySelector("parsererror") !== null || svg.tagName.toLowerCase() !== "svg") {
    throw new DiagramRenderFailed("Mermaid returned something that is not an SVG.");
  }
  return document.importNode(svg, true) as unknown as SVGSVGElement;
}

/**
 * Render a diagram to SVG using core Mermaid.
 *
 * `component` is the lifetime the fallback render is tied to — pass the plugin,
 * or the view, so a render in flight does not outlive the thing that asked for
 * it. The direct path needs no component and ignores it.
 */
export async function renderDiagram(
  app: App,
  component: Component,
  spec: DiagramSpec,
  palette?: DiagramPalette,
): Promise<RenderedDiagram> {
  const options = palette === undefined ? {} : { palette };
  const direct = await ensureMermaid(app, component);

  if (direct !== null) {
    renderCounter += 1;
    const result = await direct.render(`scdb-diagram-${renderCounter}`, toMermaid(spec, options));
    const svg = parseSvg(result.svg);
    const { width, height } = sizeSvg(svg);
    return { svg, width, height, text: new XMLSerializer().serializeToString(svg) };
  }

  const host = offscreenHost();
  try {
    await MarkdownRenderer.render(app, toMermaidBlock(spec, options), host, "", component);
    const found = await waitForSvg(host);
    // Cloned before the host is removed: the live node belongs to a subtree
    // that is about to be torn down, and Mermaid keeps handlers on it.
    const svg = found.cloneNode(true) as SVGSVGElement;
    const { width, height } = sizeSvg(svg);
    return { svg, width, height, text: new XMLSerializer().serializeToString(svg) };
  } finally {
    host.remove();
  }
}

/** UTF-8 safe base64 — a node label may well carry an accent or a dash. */
function svgDataUri(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Rasterise an SVG to PNG bytes at a scale.
 *
 * A white-or-theme background is painted first, deliberately: a transparent PNG
 * dropped on a dark PowerPoint template renders dark text on dark, and the one
 * job this feature has is to survive the paste into a slide.
 */
export async function rasterise(
  rendered: RenderedDiagram,
  scale: PngScale,
  background: string,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rendered.width * scale);
  canvas.height = Math.round(rendered.height * scale);
  const context = canvas.getContext("2d");
  if (context === null) throw new DiagramRenderFailed("This machine could not open a 2D canvas.");

  const image = new Image();
  image.width = canvas.width;
  image.height = canvas.height;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(
        new DiagramRenderFailed(
          "The diagram could not be rasterised. This usually means the SVG carries something the image decoder rejected.",
        ),
      );
    image.src = svgDataUri(rendered.text);
  });

  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new DiagramRenderFailed("The canvas produced no PNG."));
      else resolve(blob);
    }, "image/png");
  });
}

/**
 * Put a PNG on the clipboard — the feature that actually matters (§7 D1).
 *
 * Returns a plain-English failure rather than throwing, because every caller
 * wants to say "copied" or say why not, and none of them want a stack trace.
 * The capability is probed by diagnostics but never exercised there: writing to
 * the clipboard during a self-test would destroy whatever the user had copied.
 */
export async function copyPngToClipboard(blob: Blob): Promise<{ ok: true } | { ok: false; why: string }> {
  const ClipboardItemCtor = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (typeof navigator.clipboard?.write !== "function" || ClipboardItemCtor === undefined) {
    return {
      ok: false,
      why: "This Obsidian build has no clipboard image support. Save the PNG to 95 Exports/ and insert it from there.",
    };
  }
  try {
    await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      why: `The clipboard refused the image: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Bytes, for the vault. */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** How a diagram is named in a file name and a ledger row. */
export function exportBasename(spec: DiagramSpec): string {
  return spec.id === "" ? diagramLabel(spec) : `${spec.id} ${spec.title}`.trim();
}

/** The Mermaid source, for the "copy source" action and the note body. */
export function mermaidSource(spec: DiagramSpec): string {
  return toMermaid(spec);
}
