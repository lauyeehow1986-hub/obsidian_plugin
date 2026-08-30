/**
 * Loading launch targets from `_config/launchers.yaml` (CLAUDE.md §5.16).
 *
 * The allowlist lives in the vault rather than in settings on purpose: it is
 * the list of everything this plugin may open, and that belongs somewhere a
 * person can read, diff and keep after uninstalling. A settings blob would put
 * it where only the plugin can see it.
 *
 * YAML is parsed with Obsidian's core `parseYaml`, so this costs no bundle
 * bytes and is not a plugin dependency. The domain layer never sees the file.
 */

import { parseYaml, type App } from "obsidian";
import {
  parseLaunchTargets,
  type LaunchTarget,
  type TargetProblem,
} from "../domain/launch/target";

export class LauncherStore {
  private targets: LaunchTarget[] = [];
  private problems: TargetProblem[] = [];

  constructor(
    private readonly app: App,
    /** `_config` from settings; the file is `<config>/launchers.yaml`. */
    private readonly configFolder: () => string,
  ) {}

  path(): string {
    return `${this.configFolder()}/launchers.yaml`;
  }

  /** True when a changed path is this file, so the watcher knows to reload. */
  isConfigPath(path: string): boolean {
    return path === this.path();
  }

  async reload(): Promise<void> {
    const file = this.app.vault.getFileByPath(this.path());
    if (file === null) {
      // No file is the default state, not an error: nothing is offered, and
      // settings says where to create one.
      this.targets = [];
      this.problems = [];
      return;
    }

    let raw: unknown;
    try {
      raw = parseYaml(await this.app.vault.cachedRead(file));
    } catch (error) {
      this.targets = [];
      this.problems = [
        {
          severity: "error",
          at: "file",
          message: `Could not read ${this.path()} as YAML: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ];
      return;
    }

    const parsed = parseLaunchTargets(raw);
    this.targets = parsed.targets;
    this.problems = parsed.problems;
  }

  all(): readonly LaunchTarget[] {
    return this.targets;
  }

  byId(id: string): LaunchTarget | null {
    return this.targets.find((t) => t.id === id) ?? null;
  }

  /** Surfaced in settings and in diagnostics — never swallowed (§8). */
  allProblems(): readonly TargetProblem[] {
    return this.problems;
  }
}
