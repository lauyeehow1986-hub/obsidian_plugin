/**
 * The project projection over the note index (CLAUDE.md §5.15, §7 B8).
 *
 * The same shape as `RequestIndex`, and for the same reason: `NoteIndex` reads
 * Obsidian's metadata cache once, and each projection parses the notes it cares
 * about. A second cache of the vault would drift the moment one file event was
 * handled here and not there.
 *
 * A project filed outside `15 Projects/` still counts — the folder is a
 * convention, and a note that declares the type should never quietly vanish
 * from the portfolio because someone moved it.
 */

import { TFile, type App } from "obsidian";
import { PROJECT_TYPE } from "../domain/project/create";
import { parseProject, type ProjectNote } from "../domain/project/project";
import type { ProjectAt } from "../domain/project/schedule";
import type { NoteIndex } from "./noteIndex";

export interface ProjectEntry {
  file: TFile;
  project: ProjectNote;
  /** What could not be read from this note — a `blocked_by` cycle, say. */
  problems: string[];
}

export class ProjectIndex {
  private entries = new Map<string, ProjectEntry>();

  constructor(
    private readonly app: App,
    private readonly notes: NoteIndex,
  ) {}

  rebuild(): void {
    this.entries.clear();
    for (const file of this.app.vault.getMarkdownFiles()) this.update(file);
  }

  /** Re-read one file. Removes it from the index if it is no longer a project. */
  update(file: TFile): boolean {
    const entry = this.notes.byPath(file.path);
    if (!entry || entry.type !== PROJECT_TYPE) {
      return this.entries.delete(file.path);
    }
    const { project, problems } = parseProject(entry.frontmatter);
    this.entries.set(file.path, { file, project, problems });
    return true;
  }

  remove(path: string): boolean {
    return this.entries.delete(path);
  }

  rename(oldPath: string, file: TFile): void {
    this.entries.delete(oldPath);
    this.update(file);
  }

  get size(): number {
    return this.entries.size;
  }

  all(): ProjectEntry[] {
    return [...this.entries.values()];
  }

  projects(): ProjectNote[] {
    return this.all().map((entry) => entry.project);
  }

  /** Projects paired with their paths, for the milestone-to-event projection. */
  located(): ProjectAt[] {
    return this.all().map((entry) => ({ project: entry.project, path: entry.file.path }));
  }

  byPath(path: string): ProjectEntry | null {
    return this.entries.get(path) ?? null;
  }

  /** Lookup by the immutable identity. This is what machine references use. */
  byUid(uid: string): ProjectEntry | null {
    return this.all().find((e) => e.project.uid === uid) ?? null;
  }

  /** Lookup by the human label. May be renumbered, so never store this. */
  byId(id: string): ProjectEntry | null {
    const wanted = id.trim().toLowerCase();
    return this.all().find((e) => e.project.id.toLowerCase() === wanted) ?? null;
  }

  /** Every human label in the vault, for allocating the next one. */
  ids(): string[] {
    return this.all()
      .map((e) => e.project.id)
      .filter((id) => id !== "");
  }

  fileFor(project: ProjectNote): TFile | null {
    return this.all().find((e) => e.project.uid === project.uid)?.file ?? null;
  }
}
