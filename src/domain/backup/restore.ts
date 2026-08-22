/**
 * Planning a restore (CLAUDE.md §7 A4).
 *
 * Two rules, both from §2 rule 8 — never destroy data you did not write:
 *
 *  1. **A restore only ever creates.** A file already in the vault is left
 *     exactly as it is and reported as skipped. Restoring into an empty vault
 *     therefore writes everything, which is the case the phase is specified
 *     against, and restoring into a live vault can never overwrite a note you
 *     have edited since the snapshot.
 *  2. **Every path in the archive is checked before it is used.** A snapshot is
 *     a file that travels — off the laptop, onto a USB stick, back again — so
 *     by the time it is read it is untrusted input. A path escaping the vault
 *     is refused and named, never normalised into something that happens to be
 *     safe.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { ArchiveFile } from "./archive";

export interface RefusedPath {
  path: string;
  reason: string;
}

export interface RestorePlan {
  /** Missing from the vault, safe to write. */
  create: ArchiveFile[];
  /** Already in the vault. Left untouched. */
  existing: string[];
  /** Refused outright — see the two rules above. */
  refused: RefusedPath[];
  bytes: number;
}

/**
 * Reject anything that is not a plain relative path inside the vault.
 *
 * Backslashes are refused rather than converted: a snapshot written by this
 * plugin never contains one (Obsidian reports forward slashes everywhere), so
 * one appearing means the file did not come from here, and quietly rewriting
 * it would hide that.
 */
export function refusePath(path: string): string | null {
  if (path.trim() === "") return "the archive lists a file with no name";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "it is an absolute path";
  if (path.includes("\\")) return "it contains a backslash";
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    return "it points outside the vault";
  }
  // A control character in a path is never legitimate, and a newline in one
  // would corrupt every report that lists it.
  if ([...path].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    return "it contains a control character";
  }
  return null;
}

export function planRestore(
  files: readonly ArchiveFile[],
  existingPaths: ReadonlySet<string>,
): RestorePlan {
  const plan: RestorePlan = { create: [], existing: [], refused: [], bytes: 0 };

  for (const file of files) {
    const refusal = refusePath(file.path);
    if (refusal !== null) {
      plan.refused.push({ path: file.path, reason: refusal });
      continue;
    }
    if (existingPaths.has(file.path)) {
      plan.existing.push(file.path);
      continue;
    }
    plan.create.push(file);
    plan.bytes += file.bytes.length;
  }

  return plan;
}

/** One sentence per outcome, for the confirmation that precedes any writing. */
export function describeRestore(plan: RestorePlan): string[] {
  const lines: string[] = [];
  lines.push(
    plan.create.length === 0
      ? "Nothing to restore: every file in the snapshot is already in this vault."
      : `${plan.create.length} file${plan.create.length === 1 ? "" : "s"} will be created.`,
  );
  if (plan.existing.length > 0) {
    lines.push(
      `${plan.existing.length} already exist and will be left exactly as they are — a restore never overwrites.`,
    );
  }
  if (plan.refused.length > 0) {
    lines.push(
      `${plan.refused.length} refused because the path is not safe to write: ${plan.refused
        .slice(0, 3)
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join("; ")}${plan.refused.length > 3 ? "; …" : ""}`,
    );
  }
  return lines;
}
