/**
 * Writing `type: diagram` notes, and exporting what they draw (§7 D1).
 *
 * **What is and is not logged.** Saving a diagram is ordinary note authoring —
 * it changes no stage, satisfies no gate, moves no identifier scope — so it
 * appends nothing to the ledger. Following §5.12's precedent that exploratory
 * console lines stay out of it: an audit trail padded with every edit to a
 * flowchart is one nobody reads, and a ledger nobody reads proves nothing.
 * Exports **are** logged, every one, because an export is a file leaving the
 * boards (§5.6) and that is exactly what the ledger is for.
 *
 * **The body carries a Mermaid block the plugin maintains.** Rule 11 asks that
 * everything written stays plain markdown a human can read and undo, and a
 * diagram whose picture only exists inside the plugin fails that: uninstall
 * tomorrow and the note is a list of node ids. So the frontmatter stays the
 * source of truth (§5.1) and the body carries a generated fence between two
 * markers, refreshed on save. Prose outside the markers is never touched.
 */

import { TFile, normalizePath, type App, type Component } from "obsidian";
import {
  diagramFrontmatter,
  diagramLabel,
  parseDiagram,
  type DiagramSpec,
} from "../domain/diagram/diagram";
import { toMermaidBlock } from "../domain/diagram/mermaid";
import { ensureFolder } from "../data/vaultPaths";
import type { Exporter } from "./exporter";
import {
  blobBytes,
  copyPngToClipboard,
  exportBasename,
  rasterise,
  renderDiagram,
  resolvePalette,
  type PngScale,
} from "./diagramRender";

const OPEN = "%% scdb:diagram %%";
const CLOSE = "%% /scdb:diagram %%";

export interface DiagramWriterContext {
  app: App;
  exporter: Exporter;
  diagramsFolder: () => string;
}

export interface DiagramExportResult {
  path: string;
}

export class DiagramWriter {
  constructor(private readonly ctx: DiagramWriterContext) {}

  /**
   * The managed block, rebuilt.
   *
   * Rendered with the fallback palette rather than the theme's: the block is
   * read by core Mermaid inside Obsidian, which applies the theme itself, and
   * baking today's resolved colours into the note would leave a light-theme
   * diagram in a note opened tomorrow in dark.
   */
  private block(spec: DiagramSpec): string {
    return [
      OPEN,
      "",
      toMermaidBlock(spec),
      "",
      CLOSE,
    ].join("\n");
  }

  /** Replace the managed block, or append one. Prose outside it survives. */
  private withBlock(body: string, spec: DiagramSpec): string {
    const start = body.indexOf(OPEN);
    const end = body.indexOf(CLOSE);
    const block = this.block(spec);
    if (start !== -1 && end > start) {
      return `${body.slice(0, start)}${block}${body.slice(end + CLOSE.length)}`;
    }
    const trimmed = body.trimEnd();
    return trimmed === "" ? `${block}\n` : `${trimmed}\n\n${block}\n`;
  }

  /** Everything after the frontmatter block, or the whole file if there is none. */
  private bodyOf(text: string): { frontmatter: string; body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (match === null) return { frontmatter: "", body: text };
    return { frontmatter: match[0], body: text.slice(match[0].length) };
  }

  /** Create a diagram note and return it. Never overwrites (rule 8). */
  async create(spec: DiagramSpec, basename?: string): Promise<TFile> {
    const folder = normalizePath(this.ctx.diagramsFolder());
    await ensureFolder(this.ctx.app, folder);

    const stem = (basename ?? diagramLabel(spec)).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Diagram";
    let path = normalizePath(`${folder}/${stem}.md`);
    for (let i = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; i++) {
      path = normalizePath(`${folder}/${stem} ${i}.md`);
    }

    const file = await this.ctx.app.vault.create(
      path,
      [
        this.block(spec),
        "",
        "## Notes",
        "",
        spec.source === "hand"
          ? "Why this diagram exists, and what it is for."
          : `Generated from ${spec.generatedFrom || "vault data"}. Redraw it rather than editing the boxes by hand, or the two will drift apart.`,
        "",
      ].join("\n"),
    );

    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(diagramFrontmatter(spec))) {
        frontmatter[key] = value;
      }
    });
    return file;
  }

  /** Merge the spec into an existing note and refresh the managed block. */
  async save(file: TFile, spec: DiagramSpec): Promise<void> {
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(diagramFrontmatter(spec))) {
        frontmatter[key] = value;
      }
    });
    await this.ctx.app.vault.process(file, (text) => {
      const { frontmatter, body } = this.bodyOf(text);
      return `${frontmatter}${this.withBlock(body, spec)}`;
    });
  }

  /** Read a diagram back out of a note. */
  read(file: TFile): ReturnType<typeof parseDiagram> {
    const cache = this.ctx.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (frontmatter === undefined) {
      return parseDiagram(null);
    }
    const { position: _position, ...rest } = frontmatter as Record<string, unknown>;
    return parseDiagram(rest);
  }

  /**
   * Save the SVG beside the note (§7 D1), replacing the previous one.
   *
   * The one place a diagram export does not land in `95 Exports/`, because D1
   * asks for it next to the note and a derived sibling is what that means: it
   * is regenerated from the note every time, so a dated pile of them would be
   * clutter rather than history. Replacing is the same exception the calendar
   * file takes, and for the same reason. The ledger row is written either way.
   */
  async saveSvg(file: TFile, spec: DiagramSpec, svgText: string): Promise<DiagramExportResult> {
    const path = `${file.parent?.path ?? this.ctx.diagramsFolder()}/${file.basename}.svg`;
    const result = await this.ctx.exporter.write({
      basename: file.basename,
      extension: "svg",
      content: svgText,
      subject: spec.id || file.basename,
      rows: spec.nodes.length,
      path: normalizePath(path),
    });
    return { path: result.path };
  }

  /** Rasterise and write a PNG into `95 Exports/`. */
  async savePng(
    component: Component,
    root: HTMLElement,
    spec: DiagramSpec,
    scale: PngScale,
  ): Promise<DiagramExportResult> {
    const blob = await this.rasterFor(component, root, spec, scale);
    const result = await this.ctx.exporter.writeBinary({
      basename: `${exportBasename(spec)} ${scale}x`,
      extension: "png",
      bytes: await blobBytes(blob),
      subject: spec.id || diagramLabel(spec),
      detail: `diagram PNG at ${scale}x, ${spec.nodes.length} nodes`,
    });
    return { path: result.path };
  }

  /** Rasterise and put it on the clipboard. Nothing is written to the vault. */
  async copyPng(
    component: Component,
    root: HTMLElement,
    spec: DiagramSpec,
    scale: PngScale,
  ): Promise<{ ok: true } | { ok: false; why: string }> {
    const blob = await this.rasterFor(component, root, spec, scale);
    return await copyPngToClipboard(blob);
  }

  /**
   * Render fresh and rasterise.
   *
   * Rendered again rather than reusing whatever is on screen: the preview is
   * sized to the pane it sits in and may be mid-update, and an export that
   * silently captures a stale or clipped picture is the sort of thing that is
   * only noticed in the meeting.
   */
  private async rasterFor(
    component: Component,
    root: HTMLElement,
    spec: DiagramSpec,
    scale: PngScale,
  ): Promise<Blob> {
    const palette = resolvePalette(root);
    const rendered = await renderDiagram(this.ctx.app, component, spec, palette);
    const background = getComputedStyle(root).getPropertyValue("--background-primary").trim();
    return await rasterise(rendered, scale, background === "" ? "#ffffff" : background);
  }
}
