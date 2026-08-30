/**
 * Deciding whether a launch may happen (CLAUDE.md §5.16 rules 1-3, 5, 8).
 *
 * Everything here answers one question — *given this target and this already
 * resolved destination, do we open it?* — and answers it with a sentence a
 * person can act on rather than a boolean. Refusals are shown, not swallowed:
 * a launcher that quietly declines is indistinguishable from one that is
 * broken, and the user is on a laptop with no dev tools.
 *
 * **Resolution is not done here.** `services/launcher` calls the filesystem to
 * turn a path into a real one, then hands the result to `decideFile`. Keeping
 * the decision pure means the interesting cases — a path escaping its root, an
 * extension that lies, a UNC prefix — are tested without a filesystem and
 * without caring which machine runs the tests.
 *
 * Pure module: no Obsidian, no Node, no I/O.
 */

import {
  DEFAULT_FIELD_PATTERN,
  NEVER_OPEN,
  type LaunchTarget,
} from "./target";

export type LaunchDecision =
  | { ok: true; destination: string }
  | { ok: false; why: string };

/* ------------------------------------------------------------- the field -- */

/**
 * Why the note's value cannot be substituted, or null if it can.
 *
 * Checked *before* the URI is built, exactly as §5.11 rule 3 requires for an
 * address, and for the same reason: a value we cannot vouch for is not a value,
 * and escaping something that should have been refused is how the interesting
 * bugs happen.
 */
export function fieldProblem(target: LaunchTarget, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return `${target.field ?? "the field"} is empty on this note`;
  if (/[\r\n\t]/.test(trimmed)) return `${target.field ?? "the field"} contains a line break`;

  const pattern = target.pattern ?? DEFAULT_FIELD_PATTERN;
  if (!pattern.test(trimmed)) {
    return `${target.field ?? "the field"} is "${trimmed}", which does not match what this target allows (${pattern.source})`;
  }
  return null;
}

/**
 * Why a note's relative path may not be joined to a root, or null if it may.
 *
 * This is belt *and* braces, deliberately. The string check here catches the
 * obvious escape and gives a legible reason; `containmentProblem` on the
 * resolved path catches what a string never can — a junction or symlink inside
 * the root that points out of it. Neither is sufficient alone, and dropping
 * either because the other exists is how this stops working.
 *
 * A colon is refused anywhere, not only in position 2: on NTFS
 * `x.pdf:evil.exe` is an alternate data stream, and it is not a filename we
 * have any reason to construct.
 */
export function relativePathProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "it is empty";
  if (trimmed.length > 240) return "it is too long to be a path we built";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return "it contains a control character";
  if (/^[\\/]/.test(trimmed)) return "it starts at the root of a drive or a network share";
  if (/:/.test(trimmed)) return "it names a drive or an alternate data stream";
  if (trimmed.split(/[\\/]/).some((part) => part === "..")) {
    return "it contains `..`, which would climb out of the folder";
  }
  return null;
}

/** The candidate path before the filesystem sees it. Not yet safe: still needs resolving. */
export function joinUnderRoot(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${relative.trim().replace(/^[\\/]+/, "").replace(/\//g, "\\")}`;
}

/* --------------------------------------------------------------- the URL -- */

/**
 * The allowlist, applied to the **built** string immediately before it is
 * returned for launching (§5.16 rule 8, mirroring §5.11 rule 4).
 *
 * Only `https:`. Not `http:`, because an institutional portal that is not on
 * TLS is a finding rather than a target; and emphatically not `file:`, which
 * goes through the protocol handler table — a file opens through `openPath`
 * instead, which is a different call with different rules (rule 6).
 */
export function launchSchemeAllowed(url: string): boolean {
  return /^https:\/\/[^/\s]/i.test(url) && !/[\r\n]/.test(url);
}

/**
 * Substitute one shape-checked value into a config template.
 *
 * `encodeURIComponent` is applied to the value and only to the value: the
 * template is ours, the value is the note's, and confusing the two is the
 * whole class of bug this function exists to avoid.
 */
export function buildUrl(target: LaunchTarget, value: string): LaunchDecision {
  if (target.kind !== "url" || target.template === null) {
    return { ok: false, why: "That target does not open a URL." };
  }

  let url = target.template;
  if (target.field !== null && url.includes(`{${target.field}}`)) {
    const problem = fieldProblem(target, value);
    if (problem !== null) return { ok: false, why: `Cannot open: ${problem}.` };
    url = url.replace(`{${target.field}}`, encodeURIComponent(value.trim()));
  }

  if (!launchSchemeAllowed(url)) {
    return { ok: false, why: "That link is not one this plugin is allowed to open. Nothing was launched." };
  }
  return { ok: true, destination: url };
}

/* -------------------------------------------------------------- the path -- */

/**
 * One comparable form for two Windows paths.
 *
 * Separators are unified, repeats collapsed, a trailing separator dropped and
 * the case folded — Windows compares paths case-insensitively, so a check that
 * did not would be trivially defeated by `\\SERVER\sops`. The leading `\\` of a
 * UNC path is preserved deliberately: collapsing it would turn a network share
 * into a local root path and quietly change what the containment check means.
 */
export function normaliseForCompare(path: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path);
  let out = path.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
  if (unc) out = `\\${out}`;
  out = out.replace(/\\+$/, "");
  return out.toLowerCase();
}

/**
 * Why a resolved path may not be opened under `root`, or null if it may.
 *
 * The separator in the prefix test is what makes this correct: without it,
 * root `C:\SOPs` would happily contain `C:\SOPs-archive-public`, which is a
 * different folder with different permissions and is exactly the mistake a
 * naive `startsWith` makes.
 */
export function containmentProblem(root: string, resolved: string): string | null {
  const base = normaliseForCompare(root);
  const target = normaliseForCompare(resolved);
  if (base === "") return "this target has no root configured";
  if (target === base) return null;
  if (target.startsWith(`${base}\\`)) return null;
  return `it resolves to somewhere outside ${root}`;
}

/** The lowercase extension of a path, without the dot. Empty when there is none. */
export function extensionOf(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Decide on an already-resolved file or folder path (§5.16 rule 3).
 *
 * Order matters and is the order the rules are written in: containment first,
 * because a path outside its root is refused whatever it is called, and only
 * then the extension. The extension is taken from the **resolved** path, which
 * is the point — `report.pdf` that resolves to `report.pdf.exe` fails here and
 * would pass any check made on the string in the note.
 */
export function decideFile(target: LaunchTarget, resolved: string): LaunchDecision {
  if (target.kind !== "file" && target.kind !== "folder") {
    return { ok: false, why: "That target does not open a path." };
  }
  if (target.root === null) {
    return { ok: false, why: "That target has no root configured, so nothing is opened." };
  }

  const outside = containmentProblem(target.root, resolved);
  if (outside !== null) {
    return { ok: false, why: `Refused: ${outside}. Nothing was opened.` };
  }

  // A folder takes the root check and stops there: opening a file manager at a
  // location executes nothing, which is the whole reason the `folder` kind
  // exists (§5.16 rule 4).
  if (target.kind === "folder") return { ok: true, destination: resolved };

  const ext = extensionOf(resolved);
  if (ext === "") {
    return { ok: false, why: "Refused: that file has no extension, so there is no way to tell what opening it would do." };
  }
  if (NEVER_OPEN.includes(ext)) {
    return {
      ok: false,
      why: `Refused: a .${ext} file runs when it is opened. Opening documents and running programs are deliberately different features.`,
    };
  }
  if (!target.extensions.includes(ext)) {
    return {
      ok: false,
      why: `Refused: this target opens ${target.extensions.map((e) => `.${e}`).join(", ")} and that path resolves to a .${ext} file.`,
    };
  }
  return { ok: true, destination: resolved };
}
