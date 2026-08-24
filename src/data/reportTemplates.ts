/**
 * Loading report templates from `_config/reports/*.yaml` (CLAUDE.md §7 B7).
 *
 * Same shape as `WorkflowStore`, and for the same reason: YAML is parsed with
 * Obsidian's core `parseYaml`, so it costs no bundle bytes and is not a plugin
 * dependency, and the domain layer never sees a file.
 *
 * The one thing this store does that the workflow store does not is **merge
 * with the built-ins**. Five templates ship compiled in so the feature works
 * before `_config/reports/` exists; a file with the same `id` replaces the
 * built-in of that name, a file with a new id adds one. Writing the built-ins
 * out is a command the user runs, never something that happens on load — rule
 * 3's "nothing is enabled on first install", applied to the vault.
 */

import { normalizePath, parseYaml, stringifyYaml, TFile, type App } from "obsidian";
import { BUILT_IN_TEMPLATES } from "../domain/report/builtins";
import {
  parseTemplate,
  templateToPlain,
  type ReportTemplate,
} from "../domain/report/template";
import { ensureFolder } from "./vaultPaths";

export interface LoadedTemplate {
  path: string;
  template: ReportTemplate | null;
  problems: string[];
}

const YAML_FILE_RE = /\.ya?ml$/i;

export class ReportTemplateStore {
  private loaded: LoadedTemplate[] = [];

  constructor(
    private readonly app: App,
    /** `_config` from settings; report templates live in `<config>/reports`. */
    private readonly configFolder: () => string,
  ) {}

  folder(): string {
    return `${this.configFolder()}/reports`;
  }

  /** Re-read every template file. Cheap enough to call on any change under it. */
  async reload(): Promise<void> {
    const prefix = `${this.folder()}/`;
    const files = this.app.vault
      .getFiles()
      .filter((file) => file.path.startsWith(prefix) && YAML_FILE_RE.test(file.name))
      .sort((a, b) => a.path.localeCompare(b.path));

    const loaded: LoadedTemplate[] = [];
    for (const file of files) loaded.push(await this.readOne(file));
    this.loaded = loaded;
  }

  private async readOne(file: TFile): Promise<LoadedTemplate> {
    let raw: unknown;
    try {
      raw = parseYaml(await this.app.vault.read(file));
    } catch (error) {
      return {
        path: file.path,
        template: null,
        problems: [
          `Could not read this file as YAML: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    return { path: file.path, ...parseTemplate(raw, file.path) };
  }

  /** True when a path is a template file, so the watcher knows to reload. */
  isTemplatePath(path: string): boolean {
    return path.startsWith(`${this.folder()}/`) && YAML_FILE_RE.test(path);
  }

  /**
   * Every usable template: the built-ins, with vault files layered over them.
   *
   * Order is built-in order first so the five B7 names stay where the user
   * learned them, with anything new appended alphabetically by id.
   */
  all(): ReportTemplate[] {
    const overrides = new Map<string, ReportTemplate>();
    for (const entry of this.loaded) {
      if (entry.template !== null) overrides.set(entry.template.id, entry.template);
    }

    const merged = BUILT_IN_TEMPLATES.map(
      (builtIn) => overrides.get(builtIn.id) ?? builtIn,
    );
    const builtInIds = new Set(BUILT_IN_TEMPLATES.map((template) => template.id));
    const extra = [...overrides.values()]
      .filter((template) => !builtInIds.has(template.id))
      .sort((a, b) => a.id.localeCompare(b.id));

    return [...merged, ...extra];
  }

  get(id: string): ReportTemplate | null {
    return this.all().find((template) => template.id === id) ?? null;
  }

  /** Everything wrong across all template files, for diagnostics and settings. */
  problems(): { path: string; problem: string }[] {
    return this.loaded.flatMap((entry) =>
      entry.problems.map((problem) => ({ path: entry.path, problem })),
    );
  }

  /**
   * Write the built-in templates into `_config/reports/` so they can be edited.
   *
   * Existing files are left alone and reported, never overwritten: the whole
   * point of the folder is that the user has changed something in it, and rule
   * 8 is that we never destroy what we did not write.
   */
  async writeBuiltIns(): Promise<{ written: string[]; skipped: string[] }> {
    const folder = normalizePath(this.folder());
    await ensureFolder(this.app, folder);

    const written: string[] = [];
    const skipped: string[] = [];

    for (const template of BUILT_IN_TEMPLATES) {
      const path = normalizePath(`${folder}/${template.id}.yaml`);
      if (this.app.vault.getAbstractFileByPath(path) !== null) {
        skipped.push(path);
        continue;
      }
      await this.app.vault.create(path, header(template) + stringifyYaml(templateToPlain(template)));
      written.push(path);
    }

    await this.reload();
    return { written, skipped };
  }
}

/**
 * A comment block at the top of a written template.
 *
 * `stringifyYaml` cannot carry comments, so this is prepended by hand. It earns
 * its place: the file is the first thing someone edits, and without it the only
 * documentation for the block vocabulary is the source of a plugin they cannot
 * build.
 */
function header(template: ReportTemplate): string {
  return [
    `# ${template.label} — a SCDB Cockpit report template.`,
    "#",
    "# Edit freely. A file here replaces the built-in template with the same `id`;",
    "# give it a new `id` to add a template rather than replace one. Delete the",
    "# file to go back to the built-in.",
    "#",
    "# period: month | year | all   — what the dialog asks for before running.",
    "# study: true                  — the report is about one study.",
    "# {period} and {study} in a title or lede are substituted when it runs.",
    "#",
    "# Blocks: prose, request-queue, turnaround, bottlenecks, effort (by: ...),",
    "# estimate-vs-actual, publications, publication-metrics, cv, portfolio, query.",
    "",
    "",
  ].join("\n");
}
