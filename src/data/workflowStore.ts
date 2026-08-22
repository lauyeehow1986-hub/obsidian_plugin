/**
 * Loading workflow specs from `_config/workflows/*.yaml` (CLAUDE.md §5.2).
 *
 * YAML is parsed with Obsidian's core `parseYaml`, so this costs no bundle
 * bytes and is not a plugin dependency. The domain layer never sees the file —
 * it is handed a plain object.
 */

import { parseYaml, TFile, type App } from "obsidian";
import {
  parseWorkflowSpec,
  type SpecProblem,
  type WorkflowSpec,
} from "../domain/request/workflow";

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

  /**
   * The spec to use when a note does not name one. With exactly one spec
   * installed this is unambiguous; with several, a note without a `workflow`
   * field is a note we should not guess about.
   */
  only(): WorkflowSpec | null {
    const usable = this.usable();
    return usable.length === 1 ? usable[0]! : null;
  }

  /** The spec governing a request, or null when it names one we do not have. */
  forRequest(workflowId: string): WorkflowSpec | null {
    return workflowId === "" ? this.only() : this.get(workflowId);
  }

  /** Everything wrong across all spec files, for diagnostics and the settings tab. */
  problems(): { path: string; problem: SpecProblem }[] {
    return this.loaded.flatMap((l) => l.problems.map((problem) => ({ path: l.path, problem })));
  }
}
