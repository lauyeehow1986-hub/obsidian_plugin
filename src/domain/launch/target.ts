/**
 * Launch targets — what this plugin may open, and with what (CLAUDE.md §5.16).
 *
 * B9 opens the thing a note is *about*: the request in the eData portal, the
 * countersigned DUA on the SOP share, the folder a scan landed in. The value is
 * that it saves retyping a search; the risk is that "open this" and "run this"
 * are the same call to the operating system, and only the extension tells them
 * apart.
 *
 * So the shape of this module is the shape of §5.16, and every rule traces to a
 * failure it prevents:
 *
 *  - **The destination is config; the note supplies one field.** §5.11 rule 4
 *    already forbids opening a URL taken from note text, because a note may
 *    have been pasted out of an email. A file path from note text is the same
 *    problem with a worse ending, so the same answer applies: the template
 *    lives in `_config/launchers.yaml`, the note fills one slot, and the slot
 *    is shape-checked before it is used.
 *  - **A resolved path is checked, never the string in the note.** `..`,
 *    junctions and symlinks all mean the path you read is not the path you
 *    open. Resolution happens in `services/launcher` (it needs the
 *    filesystem); everything here decides whether an *already resolved* path
 *    may be opened. That split is deliberate: the decisions are the part worth
 *    unit-testing, and they must not depend on which machine the tests run on.
 *  - **Executables are refused whatever the config says.** `shell.openPath` on
 *    a `.lnk`, `.hta` or `.bat` is code execution wearing a document's name.
 *    Starting a program deliberately is §7 F4 and goes through a different
 *    door, with a different dialog.
 *
 * Pure module: no Obsidian, no Node, no I/O.
 */

export type TargetKind = "url" | "file" | "folder";

export interface TargetProblem {
  severity: "error" | "warning";
  /** Which target it is about, or "file" for the document as a whole. */
  at: string;
  message: string;
}

export interface LaunchTarget {
  id: string;
  label: string;
  kind: TargetKind;
  /** Note `type` this offers itself on, or null for any note. */
  appliesTo: string | null;
  /** `url` only. Contains exactly one `{field}` placeholder. */
  template: string | null;
  /** The single frontmatter field supplying the substituted value. */
  field: string | null;
  /** What that field is allowed to contain. Absent means the default below. */
  pattern: RegExp | null;
  /** `file` and `folder` only. Resolved paths must stay under this. */
  root: string | null;
  /** `file` only, lowercase and without dots. Empty means "no file opens". */
  extensions: readonly string[];
}

export interface ParsedTargets {
  targets: LaunchTarget[];
  problems: TargetProblem[];
}

/**
 * What a substituted field may contain when the config does not say.
 *
 * Deliberately narrow. An institutional record id is letters, digits, dots,
 * underscores and hyphens; anything else in that position is either a mistake
 * or an attempt to leave the path segment it was meant to fill.
 */
export const DEFAULT_FIELD_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Extensions that never open, whatever `extensions:` says.
 *
 * Every one of these executes when handed to the shell. The list is a denylist
 * *on top of* the per-target allowlist rather than instead of it — a config
 * that allows `[pdf, exe]` is a configuration mistake we refuse to honour, and
 * saying so out loud is better than trusting whoever edits that file next.
 */
export const NEVER_OPEN = Object.freeze([
  "exe", "com", "scr", "pif", "cpl", "msc", "msi", "msp", "application", "gadget",
  "bat", "cmd", "ps1", "psm1", "ps1xml", "sh",
  "js", "jse", "vbs", "vbe", "wsf", "wsh", "hta", "sct", "jar",
  "lnk", "url", "inf", "reg", "chm",
]);

/** Extensions a `file` target may allow, if it names them. */
export const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const PLACEHOLDER_RE = /\{([A-Za-z0-9_.]+)\}/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Parse `_config/launchers.yaml` into targets plus everything wrong with it.
 *
 * Never throws and never returns a half-valid target: a target with any error
 * is dropped, so a typo in one entry cannot make a *different* entry open
 * something unintended. The problems are surfaced in settings rather than
 * swallowed, because a launcher that silently stopped offering itself is a
 * bug the user would otherwise diagnose by guessing.
 */
export function parseLaunchTargets(raw: unknown): ParsedTargets {
  const problems: TargetProblem[] = [];
  const targets: LaunchTarget[] = [];

  const doc = asRecord(raw);
  if (doc === null) {
    if (raw !== null && raw !== undefined) {
      problems.push({ severity: "error", at: "file", message: "This file is not a YAML mapping." });
    }
    return { targets, problems };
  }

  const list = doc["targets"];
  if (!Array.isArray(list)) {
    problems.push({
      severity: "error",
      at: "file",
      message: "Expected a `targets:` list. Nothing will be offered until there is one.",
    });
    return { targets, problems };
  }

  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const parsed = parseOne(entry, index, problems);
    if (parsed === null) return;
    if (seen.has(parsed.id)) {
      problems.push({
        severity: "error",
        at: parsed.id,
        message: `Two targets share the id "${parsed.id}". Both are ignored.`,
      });
      const first = targets.findIndex((t) => t.id === parsed.id);
      if (first >= 0) targets.splice(first, 1);
      return;
    }
    seen.add(parsed.id);
    targets.push(parsed);
  });

  return { targets, problems };
}

function parseOne(
  entry: unknown,
  index: number,
  problems: TargetProblem[],
): LaunchTarget | null {
  const where = `target ${index + 1}`;
  const record = asRecord(entry);
  if (record === null) {
    problems.push({ severity: "error", at: where, message: "Not a mapping." });
    return null;
  }

  const id = asString(record["id"]);
  if (id === null || !ID_RE.test(id)) {
    problems.push({
      severity: "error",
      at: where,
      message: "Needs an `id` of lowercase letters, digits and hyphens.",
    });
    return null;
  }

  const kind = asString(record["kind"]);
  if (kind !== "url" && kind !== "file" && kind !== "folder") {
    problems.push({ severity: "error", at: id, message: "`kind` must be url, file or folder." });
    return null;
  }

  const label = asString(record["label"]) ?? id;
  const appliesTo = asString(record["applies_to"]);
  const field = asString(record["field"]);

  let pattern: RegExp | null = null;
  const rawPattern = asString(record["pattern"]);
  if (rawPattern !== null) {
    try {
      pattern = new RegExp(rawPattern);
    } catch {
      problems.push({
        severity: "error",
        at: id,
        message: `\`pattern\` is not a valid regular expression: ${rawPattern}`,
      });
      return null;
    }
  }

  if (kind === "url") {
    const template = asString(record["template"]);
    if (template === null) {
      problems.push({ severity: "error", at: id, message: "A url target needs a `template`." });
      return null;
    }
    // Checked here *and* on the built string before launching. Two checks on
    // purpose: this one gives a legible error while editing the config, the
    // other is the one that actually guards the call (§5.16 rule 8).
    if (!/^https:\/\//i.test(template)) {
      problems.push({
        severity: "error",
        at: id,
        message: "A url template must start with https:// — nothing else is opened.",
      });
      return null;
    }
    const names = [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
    if (names.length > 1) {
      problems.push({
        severity: "error",
        at: id,
        message: "A template may substitute at most one field, so exactly one part is checked.",
      });
      return null;
    }
    if (names.length === 1 && names[0] !== field) {
      problems.push({
        severity: "error",
        at: id,
        message: `The template substitutes {${names[0]}} but \`field\` says ${field ?? "nothing"}.`,
      });
      return null;
    }
    if (names.length === 0 && field !== null) {
      problems.push({
        severity: "warning",
        at: id,
        message: `\`field: ${field}\` is unused — the template has no placeholder.`,
      });
    }
    // A placeholder inside the scheme or host would let a note choose where the
    // request goes; §5.16 rule 2 confines substitution to the path or query.
    if (names.length === 1) {
      const at = template.indexOf(`{${names[0]}}`);
      const afterHost = template.indexOf("/", "https://".length);
      if (afterHost < 0 || at < afterHost) {
        problems.push({
          severity: "error",
          at: id,
          message: "The placeholder is in the host. It may only appear in the path or query.",
        });
        return null;
      }
    }
    return {
      id, label, kind, appliesTo, template, field,
      pattern, root: null, extensions: [],
    };
  }

  const root = asString(record["root"]);
  if (root === null) {
    problems.push({
      severity: "error",
      at: id,
      message: `A ${kind} target needs a \`root\`. Opening anywhere on the disk is not offered.`,
    });
    return null;
  }

  let extensions: string[] = [];
  if (kind === "file") {
    const rawList = record["extensions"];
    if (!Array.isArray(rawList) || rawList.length === 0) {
      problems.push({
        severity: "error",
        at: id,
        message: "A file target needs a non-empty `extensions` list.",
      });
      return null;
    }
    for (const item of rawList) {
      const ext = asString(item)?.toLowerCase().replace(/^\./, "") ?? null;
      if (ext === null || !SAFE_EXTENSION.test(ext)) {
        problems.push({ severity: "error", at: id, message: `Not a usable extension: ${String(item)}` });
        return null;
      }
      if (NEVER_OPEN.includes(ext)) {
        // Not silently dropped: someone wrote it down meaning it, and they
        // need to know it will never work rather than wondering why.
        problems.push({
          severity: "error",
          at: id,
          message: `\`${ext}\` executes when opened and is never allowed here. Running something deliberately is a different feature.`,
        });
        return null;
      }
      extensions.push(ext);
    }
    extensions = [...new Set(extensions)];
  }

  return {
    id, label, kind, appliesTo, template: null, field,
    pattern, root, extensions,
  };
}
