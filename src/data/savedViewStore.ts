/**
 * Saved views as notes in `90 Dashboards/` (§5.14, §7 A2).
 *
 * Reading comes from the note index, so a view edited by hand shows up the
 * moment Obsidian re-caches the file — there is no separate store to keep in
 * step. Writing goes through `processFrontMatter`, so anything else in the note
 * survives (rule 8): a person's own notes under the frontmatter are theirs.
 */

import { normalizePath, type App, type TFile } from "obsidian";
import {
  VIEW_TYPE,
  parseSavedView,
  savedViewFrontmatter,
  type SavedView,
} from "../domain/query/savedView";
import { ensureFolder } from "./vaultPaths";
import type { NoteIndex } from "./noteIndex";

export interface StoredView {
  file: TFile;
  view: SavedView;
  /** What could not be read from the note, shown in the view rather than hidden. */
  problems: string[];
}

export class SavedViewStore {
  constructor(
    private readonly app: App,
    private readonly notes: NoteIndex,
    private readonly dashboardsFolder: () => string,
  ) {}

  all(): StoredView[] {
    return this.notes
      .byType(VIEW_TYPE)
      .map((entry) => {
        const { view, problems } = parseSavedView(entry.frontmatter);
        return {
          file: entry.file,
          // A view with no title is still usable; fall back to the file name
          // rather than rendering a blank tab.
          view: { ...view, title: view.title === "" ? entry.file.basename : view.title },
          problems,
        };
      })
      .sort((a, b) => a.view.title.localeCompare(b.view.title));
  }

  byPath(path: string): StoredView | null {
    return this.all().find((stored) => stored.file.path === path) ?? null;
  }

  /**
   * Write a view, creating the note when it does not exist.
   *
   * The body is left alone on an update — the frontmatter is the view, the body
   * is whatever the person wrote about it.
   */
  async save(view: SavedView, existing?: TFile): Promise<TFile> {
    const frontmatter = savedViewFrontmatter(view);

    if (existing) {
      await this.app.fileManager.processFrontMatter(existing, (current) => {
        Object.assign(current, frontmatter);
      });
      return existing;
    }

    const folder = normalizePath(this.dashboardsFolder());
    await ensureFolder(this.app, folder);
    const path = this.freePath(folder, view.title === "" ? "Saved view" : view.title);
    const file = await this.app.vault.create(
      path,
      `---\ntype: ${VIEW_TYPE}\n---\n\nSaved SCDB view. The query lives in the frontmatter above.\n`,
    );
    await this.app.fileManager.processFrontMatter(file, (current) => {
      Object.assign(current, frontmatter);
    });
    return file;
  }

  private freePath(folder: string, title: string): string {
    const base = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() || "Saved view";
    for (let counter = 1; counter < 100; counter++) {
      const suffix = counter === 1 ? "" : ` ${counter}`;
      const candidate = normalizePath(`${folder}/${base}${suffix}.md`);
      if (this.app.vault.getAbstractFileByPath(candidate) === null) return candidate;
    }
    throw new Error(`Too many views named "${base}" in ${folder}.`);
  }
}
