/**
 * Handing a composed draft to the OS (CLAUDE.md §5.11).
 *
 * **This module opens things. It is therefore the one place a mistake becomes
 * an executed program**, so it is deliberately small and does exactly two
 * things: check the allowlist, then call `shell.openExternal`.
 *
 * `shell.openExternal` will start *any* registered protocol handler — `ms-msdt:`,
 * `vscode:`, `file:`, whatever the machine has. §5.11 rule 4 requires the
 * allowlist to be applied to the **built string, immediately before launching**,
 * never to the parts that went into it, because the parts are validated by a
 * different function and a refactor can separate the two. The check is here,
 * one line above the call, on purpose.
 *
 * A URL taken from note content never reaches this module at all. Nothing here
 * accepts a URL from anywhere but `domain/comms/uri`.
 */

import { Notice } from "obsidian";
import {
  deliveryFor,
  schemeAllowed,
  tooLongMessage,
  type ComposedUri,
  type Delivery,
} from "../domain/comms/uri";

/** Electron's shell, narrowed rather than cast to `any` (§8). */
interface ElectronShell {
  openExternal(url: string): Promise<void>;
}

/**
 * Reach Electron without letting esbuild bundle it.
 *
 * Returns null on anything that is not desktop Electron, so a caller degrades
 * to "handler unavailable, here is the clipboard" rather than throwing.
 */
function electronShell(): ElectronShell | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = (globalThis as { require?: (id: string) => unknown }).require?.("electron");
    const shell = (electron as { shell?: ElectronShell } | undefined)?.shell;
    return typeof shell?.openExternal === "function" ? shell : null;
  } catch {
    return null;
  }
}

export type LaunchOutcome =
  | { ok: true; how: "launched" }
  | { ok: true; how: "copied"; why: string }
  | { ok: false; why: string };

export interface LaunchOptions {
  /** From settings. Over this, the draft is copied whole rather than launched. */
  ceiling: number;
  /** The whole message as plain text, for the clipboard path. */
  plainText: string;
  /** Force the clipboard even when the URI would fit (§5.11 rule 2). */
  preferClipboard?: boolean;
}

/**
 * Put text on the clipboard.
 *
 * Always available as an explicit alternative, not only as a fallback — it is
 * the path that works when no handler is registered at all, which on a
 * locked-down laptop is a real possibility rather than a hypothetical.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a composed URI, or copy it when it cannot safely be opened.
 *
 * The order of the guards matters and is the order §5.11 lists them: length
 * first (never launch something that will be truncated), then the allowlist
 * (never launch something that is not one of the three schemes), then launch.
 */
export async function launchUri(
  uri: ComposedUri,
  options: LaunchOptions,
): Promise<LaunchOutcome> {
  const delivery: Delivery = options.preferClipboard === true
    ? "clipboard"
    : deliveryFor(uri, options.ceiling);

  if (delivery === "clipboard") {
    const why =
      options.preferClipboard === true
        ? "Copied to the clipboard. Paste it into a new message."
        : tooLongMessage(uri, options.ceiling);
    return (await copyToClipboard(options.plainText))
      ? { ok: true, how: "copied", why }
      : { ok: false, why: `${why} The clipboard could not be written to either.` };
  }

  // §5.11 rule 4. On the built string, one line above the call.
  if (!schemeAllowed(uri.uri)) {
    return {
      ok: false,
      why: "That link is not one this plugin is allowed to open. Nothing was launched.",
    };
  }

  const shell = electronShell();
  if (shell === null) {
    return (await copyToClipboard(options.plainText))
      ? {
          ok: true,
          how: "copied",
          why: "No protocol handler is available here, so the draft is on the clipboard instead.",
        }
      : { ok: false, why: "No protocol handler is available and the clipboard could not be written to." };
  }

  try {
    await shell.openExternal(uri.uri);
    return { ok: true, how: "launched" };
  } catch (error) {
    // A handler that is registered but broken is the case §11 asks us to be
    // able to answer in ten seconds. Falling back keeps the draft.
    const reason = error instanceof Error ? error.message : String(error);
    return (await copyToClipboard(options.plainText))
      ? {
          ok: true,
          how: "copied",
          why: `The handler did not open (${reason}), so the draft is on the clipboard instead.`,
        }
      : { ok: false, why: `The handler did not open (${reason}) and the clipboard could not be written to.` };
  }
}

/** Report a launch outcome the way §8 requires: plain language, next action. */
export function reportLaunch(outcome: LaunchOutcome): void {
  if (outcome.ok && outcome.how === "launched") {
    new Notice("Draft opened. Nothing has been sent — press send yourself.", 6000);
    return;
  }
  new Notice(outcome.ok ? outcome.why : `SCDB: ${outcome.why}`, 12000);
}

/**
 * The "test this link" probe §11 asks for.
 *
 * Opens a deliberately trivial draft so the user can answer, in ten seconds and
 * on the machine that matters, whether Outlook is registered for `mailto:` and
 * whether the Teams deep link opens a chat. It is a probe, not an assertion —
 * we cannot detect the answer, only put it in front of a human.
 */
export async function probeHandler(uri: ComposedUri): Promise<LaunchOutcome> {
  return launchUri(uri, {
    ceiling: Math.max(uri.length, 200),
    plainText: uri.uri,
  });
}
