/**
 * Loading workflow specs from `_config/workflows/*.yaml` (CLAUDE.md §5.2).
 *
 * YAML is parsed with Obsidian's core `parseYaml`, so this costs no bundle
 * bytes and is not a plugin dependency. The domain layer never sees the file —
 * it is handed a plain object.
 */

import { parseYaml, TFile, type App } from "obsidian";
import {
  DEFAULT_APPLIES_TO,
  parseWorkflowSpec,
  type SpecProblem,
  type WorkflowSpec,
} from "../domain/request/workflow";
import { planStarterInstall, starterSpecs } from "../domain/request/starterSpecs";
import { ensureFolder } from "./vaultPaths";

export interface LoadedSpec {
  path: string;
  spec: WorkflowSpec | null;
  problems: SpecProblem[];
}

const WORKFLOW_FILE_RE = /\.ya?ml$/i;

export class WorkflowStore {
  private loaded: LoadedSpec[] = [];

  constructor(
    private readonly app: App,
    /** `_config` from settings; workflows live in `<config>/workflows`. */
    private readonly configFolder: () => string,
  ) {}

  private folder(): string {
    return `${this.configFolder()}/workflows`;
  }

  /** Re-read every spec file. Cheap enough to call on any change under the folder. */
  async reload(): Promise<void> {
    const prefix = `${this.folder()}/`;
    const files = this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(prefix) && WORKFLOW_FILE_RE.test(f.name))
      .sort((a, b) => a.path.localeCompare(b.path));

    const loaded: LoadedSpec[] = [];
    for (const file of files) {
      loaded.push(await this.readOne(file));
    }
    this.loaded = loaded;
  }

  private async readOne(file: TFile): Promise<LoadedSpec> {
    let raw: unknown;
    try {
      raw = parseYaml(await this.app.vault.read(file));
    } catch (error) {
      return {
        path: file.path,
        spec: null,
        problems: [
          {
            severity: "error",
            at: "file",
            message: `Could not read this file as YAML: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    return { path: file.path, ...parseWorkflowSpec(raw) };
  }

  /**
   * Write the starter specs, skipping any file that already exists.
   *
   * Called only from an explicit command — never on load. Returns the paths
   * created and the paths left alone, so the caller can say which is which
   * rather than claiming a clean install over somebody's edited spec.
   *
   * **Never overwrites** (rule 8). A spec is the file the whole governance
   * argument rests on; replacing an edited one with a placeholder would throw
   * away the real stage names and silently re-open every gate the user had
   * tightened.
   */
  async installStarters(): Promise<{ created: string[]; kept: string[] }> {
    const folder = this.folder();

    // What to write is decided in the pure layer, so the never-overwrite rule
    // is unit-tested rather than asserted here. This method is left with the
    // I/O it cannot avoid: make the folder, create the files, re-read.
    const present = starterSpecs()
      .map((starter) => `${folder}/${starter.name}`)
      .filter((path) => this.app.vault.getAbstractFileByPath(path) !== null);
    const plan = planStarterInstall(folder, present);

    if (plan.create.length === 0) return { created: [], kept: plan.keep };

    await ensureFolder(this.app, folder);
    const created: string[] = [];
    for (const spec of plan.create) {
      await this.app.vault.create(spec.path, spec.yaml);
      created.push(spec.path);
    }

    await this.reload();
    return { created, kept: plan.keep };
  }

  /** True when a path is a workflow spec, so the watcher knows to reload. */
  isSpecPath(path: string): boolean {
    return path.startsWith(`${this.folder()}/`) && WORKFLOW_FILE_RE.test(path);
  }

  all(): LoadedSpec[] {
    return this.loaded;
  }

  /** Specs that parsed. */
  usable(): WorkflowSpec[] {
    return this.loaded.map((l) => l.spec).filter((s): s is WorkflowSpec => s !== null);
  }

  get(id: string): WorkflowSpec | null {
    return this.usable().find((s) => s.id === id) ?? null;
  }

  /** Every usable spec governing one note type (§5.2 `applies_to`). */
  forNoteType(noteType: string): WorkflowSpec[] {
    return this.usable().filter((spec) => spec.appliesTo === noteType);
  }

  /**
   * The single spec governing a note type, or null when that is ambiguous.
   *
   * **Counts within a type, never across all specs.** The previous version
   * counted every spec installed, which was correct while there was only ever
   * one — and silently wrong the moment B8 added `project.yaml`, because a
   * vault with exactly one request workflow then reported "more than one
   * workflow is installed" and refused intake. Two specs governing two
   * different things is the normal state, not an ambiguity.
   */
  onlyFor(noteType: string): WorkflowSpec | null {
    const matching = this.forNoteType(noteType);
    return matching.length === 1 ? matching[0]! : null;
  }

  /**
   * The single spec governing requests. Named for what it is, so a future
   * second note type cannot quietly inherit it the way `only()` was inherited.
   */
  onlyRequestSpec(): WorkflowSpec | null {
    return this.onlyFor(DEFAULT_APPLIES_TO);
  }

  /** The spec governing a request, or null when it names one we do not have. */
  forRequest(workflowId: string): WorkflowSpec | null {
    return workflowId === "" ? this.onlyRequestSpec() : this.get(workflowId);
  }

  /** Everything wrong across all spec files, for diagnostics and the settings tab. */
  problems(): { path: string; problem: SpecProblem }[] {
    return this.loaded.flatMap((l) => l.problems.map((problem) => ({ path: l.path, problem })));
  }
}
