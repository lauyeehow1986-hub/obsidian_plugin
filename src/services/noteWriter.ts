/**
 * Creating the note kinds nothing else creates, and the folders they live in
 * (§5 vault contract, `domain/notes/newNote`).
 *
 * **No ledger entry, deliberately.** §5.6's list of logged actions is closed
 * and creating a note is not on it, which is the same reading `CatalogueWriter`
 * already applies: `create` logs nothing, `revise` logs a `variable-revision`.
 * The distinction is not squeamishness about volume — it is that an audit
 * ledger nobody can read is not an audit ledger (§5.12 makes the identical
 * argument about exploratory console lines). A note appearing is visible in the
 * vault, reversible by deleting it, and destroys nothing. What happens to it
 * afterwards — a stage moving, a gate overridden, an identifier scope changing
 * — is what the ledger is for, and every one of those paths still logs.
 *
 * **Folders are created, never populated.** `createFolders` writes empty
 * directories and nothing else, so running it on a vault with notes already in
 * it cannot touch them (rule 8).
 */

import { normalizePath, TFile, type App } from "obsidian";
import { buildNote, type NoteKindSpec, type NoteValues } from "../domain/notes/newNote";
import { FOLDER_KEYS, type FolderKey } from "../domain/settings/schema";
import { ensureFolder } from "../data/vaultPaths";

export interface NoteWriterContext {
  app: App;
  /** Folder paths, read fresh so a settings change takes effect. */
  folder: (key: FolderKey) => string;
  /** Called after a successful write so the index repaints. */
  reindex: (file: TFile) => void;
}

/** Thrown when a required field is empty. Carries every one, not the first. */
export class NoteRefused extends Error {
  constructor(readonly missing: string[]) {
    super(`Fill in ${missing.join(", ")}.`);
    this.name = "NoteRefused";
  }
}

export class NoteWriter {
  constructor(private readonly ctx: NoteWriterContext) {}

  /**
   * Create one note from a kind spec.
   *
   * The body is written first and the frontmatter merged onto it, rather than
   * a YAML block being serialised by hand: `processFrontMatter` is the one
   * path §8 allows, and it is also the only one that gets quoting, dates and
   * nested mappings right without this module owning a YAML emitter.
   */
  async create(spec: NoteKindSpec, values: NoteValues, now = Date.now()): Promise<TFile> {
    const built = buildNote(spec, values, now);
    if (built.missing.length > 0) throw new NoteRefused(built.missing);

    const folder = normalizePath(this.ctx.folder(spec.folderKey));
    await ensureFolder(this.ctx.app, folder);

    // Never overwrite: a second study called the same thing is a second note,
    // not a replacement for the first one (rule 8).
    let path = normalizePath(`${folder}/${built.stem}.md`);
    for (let index = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; index += 1) {
      path = normalizePath(`${folder}/${built.stem} ${index}.md`);
    }

    const file = await this.ctx.app.vault.create(path, `# ${built.stem}\n\n${built.body}`);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(built.frontmatter)) {
        frontmatter[key] = value;
      }
    });

    this.ctx.reindex(file);
    return file;
  }

  /**
   * Which of §5's folders are not there yet.
   *
   * Returned rather than created, so the command can name every one in a
   * confirm before anything is written. Nothing scaffolds this vault by
   * itself — folders otherwise appear the first time a writer needs one — and
   * a command that creates two dozen directories should say which.
   */
  missingFolders(): string[] {
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const key of FOLDER_KEYS) {
      const path = normalizePath(this.ctx.folder(key));
      if (path === "" || path === "/" || seen.has(path)) continue;
      seen.add(path);
      if (this.ctx.app.vault.getAbstractFileByPath(path) === null) missing.push(path);
    }
    return missing;
  }

  /** Create the given folders. Returns the ones that were actually created. */
  async createFolders(paths: readonly string[]): Promise<string[]> {
    const created: string[] = [];
    for (const path of paths) {
      if (this.ctx.app.vault.getAbstractFileByPath(path) !== null) continue;
      await ensureFolder(this.ctx.app, path);
      created.push(path);
    }
    return created;
  }
}
