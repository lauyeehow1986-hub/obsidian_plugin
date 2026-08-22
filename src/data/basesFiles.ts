import {
  normalizePath,
  parseYaml,
  stringifyYaml,
  TFile,
  type App,
  type BasesConfigFile,
} from "obsidian";
import { standardBases, type BaseSpec, type StageLabel } from "../domain/bases/config";
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
  /**
   * An existing file whose compiled formulas no longer match the workflow spec.
   *
   * Stage labels are compiled into the `.base` because Bases cannot read the
   * spec. Since we never overwrite, renaming a stage leaves the old label in
   * place — so the drift is detected and reported rather than left to be
   * discovered as a wrong heading months later (§5.1: make drift visible).
   */
  stale: boolean;
}

export class BasesFiles {
  constructor(
    private readonly app: App,
    private readonly notes: NoteIndex,
    private readonly dashboardsFolder: () => string,
    private readonly requestType: string,
    /** Live stages across every usable spec, for the stage-label formula. */
    private readonly stages: () => readonly StageLabel[] = () => [],
  ) {}

  private specs(): BaseSpec[] {
    return standardBases(this.requestType, this.stages());
  }

  private pathFor(spec: BaseSpec): string {
    return normalizePath(`${this.dashboardsFolder()}/${spec.name}.base`);
  }

  /**
   * Whether an existing file's formulas still match what we would generate.
   *
   * Compares parsed values rather than raw text, so a user reformatting the
   * YAML or reordering keys is not mistaken for drift. Anything unreadable is
   * reported as *not* stale: we cannot claim a file is out of date when we
   * could not read it, and a parse failure is Bases' error to surface.
   */
  private async isStale(file: TFile, spec: BaseSpec): Promise<boolean> {
    const expected = spec.config.formulas;
    if (!expected) return false;

    try {
      const parsed = parseYaml(await this.app.vault.cachedRead(file)) as BaseSpec["config"] | null;
      const actual = parsed?.formulas ?? {};
      return Object.entries(expected).some(([name, formula]) => actual[name] !== formula);
    } catch {
      return false;
    }
  }

  /** What `write()` would do, so the confirmation can name every file first. */
  async plan(): Promise<BasesWriteResult[]> {
    const results: BasesWriteResult[] = [];

    for (const spec of this.specs()) {
      const path = this.pathFor(spec);
      const existing = this.app.vault.getAbstractFileByPath(path);
      results.push({
        path,
        written: existing === null,
        matches: this.notes.byType(spec.noteType).length,
        purpose: spec.purpose,
        stale: existing instanceof TFile ? await this.isStale(existing, spec) : false,
      });
    }

    return results;
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

    for (const spec of this.specs()) {
      const path = this.pathFor(spec);
      const found = this.app.vault.getAbstractFileByPath(path);
      const matches = this.notes.byType(spec.noteType).length;

      if (found === null) {
        // Assigning to Obsidian's own interface is the schema check: if a future
        // release changes the `.base` shape, this stops compiling instead of
        // silently writing files Bases refuses to parse.
        const config: BasesConfigFile = spec.config;
        await this.app.vault.create(path, stringifyYaml(config));
      }

      results.push({
        path,
        written: found === null,
        matches,
        purpose: spec.purpose,
        stale: found instanceof TFile ? await this.isStale(found, spec) : false,
      });
    }

    return results;
  }
}
