/**
 * Opening the systems and documents beside the vault (CLAUDE.md §5.16, §7 B9).
 *
 * **This module opens things**, which puts it beside `services/protocol` as one
 * of the two places where a mistake becomes an executed program. It is written
 * to the same shape: decide in the pure layer, check the built result one line
 * above the call, and never accept a destination from note content.
 *
 * Three calls into the operating system, deliberately distinguished:
 *
 *  - `shell.openExternal` for `https:` only, checked on the built string.
 *  - `shell.openPath` for a document under a configured root.
 *  - `shell.openPath` on a directory for a `folder` target, which reveals it in
 *    the file manager and executes nothing.
 *
 * A `file:` URL is never built. It would go through the protocol handler table
 * — the surface §5.11 rule 4 exists to keep closed — and `openPath` reaches the
 * same file without it.
 *
 * **Filesystem access outside the vault, and why it is allowed here.** Rule 8
 * forbids `fs` and forbids leaving the vault; it is a rule about *writes*
 * ("never destroy data you did not write"), and the documented exceptions
 * (`backup`, `interpreter`, `httpGateway`) are where the plugin legitimately
 * touches the world outside. This module joins them for reads only: it calls
 * `realpath` to find out where a path actually leads, and never opens, creates,
 * moves or deletes anything. Resolving is the entire reason it needs `fs` — a
 * junction inside an allowed root can point anywhere, and no amount of string
 * checking finds that out.
 */

import * as fsp from "node:fs/promises";
import type { AuditEntry } from "../domain/audit/ledger";
import {
  buildUrl,
  decideFile,
  joinUnderRoot,
  launchSchemeAllowed,
  relativePathProblem,
} from "../domain/launch/resolve";
import type { LaunchTarget } from "../domain/launch/target";

/** Electron's shell, narrowed rather than cast to `any` (§8). */
interface ElectronShell {
  openExternal(url: string): Promise<void>;
  /** Resolves to "" on success, or a message on failure. Never throws. */
  openPath(path: string): Promise<string>;
}

function electronShell(): ElectronShell | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = (globalThis as { require?: (id: string) => unknown }).require?.("electron");
    const shell = (electron as { shell?: ElectronShell } | undefined)?.shell;
    return typeof shell?.openExternal === "function" && typeof shell.openPath === "function"
      ? shell
      : null;
  } catch {
    return null;
  }
}

export type OpenOutcome =
  | { ok: true; destination: string }
  | { ok: false; why: string };

export interface LauncherDeps {
  audit: { append(entries: readonly AuditEntry[]): Promise<void> };
  actor: () => string;
  enabled: () => boolean;
  /** Local `YYYY-MM-DDTHH:mm`. Injected so tests do not depend on the clock. */
  now: () => string;
  /**
   * Told when a ledger write fails, so the caller can raise a Notice.
   *
   * Injected rather than importing `Notice` directly: it is the only Obsidian
   * surface this module would need, and without it the whole launcher — which
   * is one of two places where a mistake becomes an executed program — is
   * testable with a fake shell and a fake filesystem.
   */
  notify: (message: string) => void;
  /** Overridable for tests; production leaves both undefined. */
  shell?: ElectronShell | null;
  realpath?: (path: string) => Promise<string>;
}

export class Launcher {
  constructor(private readonly deps: LauncherDeps) {}

  /**
   * Work out where a target would go, without opening it.
   *
   * Separate from `open` so the confirm dialog shows **the destination that
   * will actually be used** rather than a reconstruction of it (§5.16 rule 7).
   * Two code paths computing "what will open" is how a dialog ends up telling
   * the truth about something other than what happens next.
   */
  async resolve(target: LaunchTarget, value: string): Promise<OpenOutcome> {
    if (!this.deps.enabled()) {
      return { ok: false, why: "Opening external systems is switched off in settings." };
    }

    if (target.kind === "url") return buildUrl(target, value);

    if (target.root === null) {
      return { ok: false, why: "That target has no root configured, so nothing is opened." };
    }

    // A folder target with no field opens its root — "show me where this
    // lives" is the common case and needs nothing from the note.
    let candidate = target.root;
    if (target.field !== null && value.trim() !== "") {
      const problem = relativePathProblem(value);
      if (problem !== null) {
        return { ok: false, why: `Refused: ${problem}. Nothing was opened.` };
      }
      candidate = joinUnderRoot(target.root, value);
    } else if (target.kind === "file") {
      return { ok: false, why: `Cannot open: this note has no ${target.field ?? "path"} to open.` };
    }

    let resolved: string;
    try {
      resolved = await (this.deps.realpath ?? fsp.realpath)(candidate);
    } catch {
      // Deliberately does not distinguish "missing" from "no permission": on a
      // share, which of the two it is answers a question about the share that
      // this plugin has no business answering.
      return { ok: false, why: `Cannot open: nothing readable at ${candidate}.` };
    }

    return decideFile(target, resolved);
  }

  /**
   * Open a target, logging what happened either way (§5.6).
   *
   * `subject` is the note the action was taken from — a `REQ-` id or a path —
   * so the ledger answers "what was I looking at when this opened".
   */
  async open(target: LaunchTarget, value: string, subject: string): Promise<OpenOutcome> {
    const decision = await this.resolve(target, value);
    if (!decision.ok) {
      await this.log(target, subject, `refused: ${decision.why}`);
      return decision;
    }

    const shell = this.deps.shell !== undefined ? this.deps.shell : electronShell();
    if (shell === null) {
      const why = "No handler is available here, so nothing was opened.";
      await this.log(target, subject, `refused: ${why}`);
      return { ok: false, why };
    }

    try {
      if (target.kind === "url") {
        // §5.16 rule 8, on the built string, one line above the call — the
        // same placement and the same reasoning as §5.11 rule 4.
        if (!launchSchemeAllowed(decision.destination)) {
          const why = "That link is not one this plugin is allowed to open. Nothing was launched.";
          await this.log(target, subject, `refused: ${why}`);
          return { ok: false, why };
        }
        await shell.openExternal(decision.destination);
      } else {
        const failure = await shell.openPath(decision.destination);
        if (failure !== "") {
          await this.log(target, subject, `failed: ${failure}`);
          return { ok: false, why: `Windows did not open it: ${failure}` };
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.log(target, subject, `failed: ${reason}`);
      return { ok: false, why: `It did not open (${reason}).` };
    }

    await this.log(target, subject, `opened: ${decision.destination}`);
    return decision;
  }

  private async log(target: LaunchTarget, subject: string, detail: string): Promise<void> {
    try {
      await this.deps.audit.append([
        {
          ts: this.deps.now(),
          actor: this.deps.actor(),
          action: "external-open",
          subject,
          detail: `${target.id} (${target.kind}) ${detail}`,
        },
      ]);
    } catch (error) {
      // A ledger that cannot be written is worth saying out loud: rule 9 makes
      // the row mandatory, so a silent failure here would quietly turn a
      // logged action into an unlogged one.
      this.deps.notify(
        `Opened, but the audit ledger could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Targets that offer themselves on a note of this type. */
export function targetsFor(
  targets: readonly LaunchTarget[],
  noteType: string | null,
): LaunchTarget[] {
  return targets.filter((t) => t.appliesTo === null || t.appliesTo === noteType);
}
