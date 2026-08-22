import { normalizePath, stringifyYaml, type App, type BasesConfigFile } from "obsidian";
import { standardBases, type BaseSpec } from "../domain/bases/config";
import type { NoteIndex } from "./noteIndex";
import { ensureFolder } from "./vaultPaths";

/**
 * Writing `.base` files for the browse layer (CLAUDE.md §7 A2b).
 *
 * Progressive enhancement, never a dependency: Bases arrived in Obsidian 1.10
 * and our `minAppVersion` is lower on purpose, so everything here is behind a
 * runtime check and its absence costs nothing. The A2 views remain the whole
 * story on an older build.
 */

export interface BasesWriteResult {
  path: string;
  /** False when a file was already there — we do not overwrite (rule 8). */
  written: boolean;
  /** How many notes of that type exist right now, so an empty table is expected. */
  matches: number;
  purpose: string;
}

export class BasesFiles {
  constructor(
    private readonly app: App,
    private readonly notes: NoteIndex,
    private readonly dashboardsFolder: () => string,
    private readonly requestType: string,
  ) {}

  private pathFor(spec: BaseSpec): string {
    return normalizePath(`${this.dashboardsFolder()}/${spec.name}.base`);
  }

  /** What `write()` would do, so the confirmation can name every file first. */
  plan(): BasesWriteResult[] {
    return standardBases(this.requestType).map((spec) => {
      const path = this.pathFor(spec);
      return {
        path,
        written: this.app.vault.getAbstractFileByPath(path) === null,
        matches: this.notes.byType(spec.noteType).length,
        purpose: spec.purpose,
      };
    });
  }

  /**
   * Create any `.base` file that is not already there.
   *
   * An existing file is left exactly as it is. These are ordinary notes the user
   * can edit — columns reordered, a view added — and regenerating over the top
   * would throw that away. Rule 8: never destroy data you did not write.
   */
  async write(): Promise<BasesWriteResult[]> {
    await ensureFolder(this.app, this.dashboardsFolder());
    const results: BasesWriteResult[] = [];

    for (const spec of standardBases(this.requestType)) {
      const path = this.pathFor(spec);
      const existing = this.app.vault.getAbstractFileByPath(path) !== null;
      const matches = this.notes.byType(spec.noteType).length;

      if (!existing) {
        // Assigning to Obsidian's own interface is the schema check: if a future
        // release changes the `.base` shape, this stops compiling instead of
        // silently writing files Bases refuses to parse.
        const config: BasesConfigFile = spec.config;
        await this.app.vault.create(path, stringifyYaml(config));
      }

      results.push({ path, written: !existing, matches, purpose: spec.purpose });
    }

    return results;
  }
}
