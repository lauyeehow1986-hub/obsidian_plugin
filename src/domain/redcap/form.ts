/**
 * A REDCap form specification (§5.14, §7 D2).
 *
 * §7 says why this one note type keeps its payload in a **fenced YAML block in
 * the body** rather than in frontmatter, unlike every other note in the vault:
 * an instrument of eighty fields is far too large for frontmatter, and it
 * diffs cleanly in git as a body block. Frontmatter still carries the note's
 * identity and its links — id, title, study, project — because that is what
 * the index and the boards read, and what `processFrontMatter` can merge
 * without touching the body (rule 8).
 *
 * So a form note is two halves with different rules:
 *
 *   frontmatter  →  identity, study, project, status. Merged, keys preserved.
 *   ```yaml block →  instruments and fields. Rewritten wholesale by the editor.
 *
 * This module is the parser for the block, and takes the plain object a caller
 * already produced with Obsidian's core `parseYaml` — `domain/` stays free of
 * Obsidian, and we do not carry a YAML parser in the bundle.
 *
 * **Nothing here throws and nothing here repairs.** A form note is hand-edited
 * and will be hand-broken; a field that cannot be read is reported and the
 * other seventy-nine still render. What it will not do is guess a field name
 * or invent a type, because a dictionary exported from a guess is worse than
 * one that refused to export.
 *
 * Pure module: no Obsidian, no Node.
 */

import { FIELD_NAME_PATTERN, parseField, type RedcapField } from "./field";

/** Where a form is in its life. Not REDCap's state — ours, for the board. */
export const FORM_STATUSES = ["draft", "review", "approved", "deployed", "retired"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export function isFormStatus(value: unknown): value is FormStatus {
  return typeof value === "string" && (FORM_STATUSES as readonly string[]).includes(value);
}

export const FORM_STATUS_LABELS: Record<FormStatus, string> = {
  draft: "Draft",
  review: "In review",
  approved: "Approved",
  deployed: "Deployed",
  retired: "Retired",
};

/** One instrument: a form name, a human label, and its fields in order. */
export interface Instrument {
  /** The REDCap `form_name`. Lowercase, and the dictionary groups rows by it. */
  name: string;
  label: string;
  fields: RedcapField[];
}

export interface FormSpec {
  path: string;
  id: string;
  title: string;
  /** Wikilink or name, as written. The governance hook resolves it (§7 D2). */
  study: string;
  /** The REDCap project this is destined for. Free text; never used to reach it. */
  project: string;
  status: FormStatus;
  version: string;
  instruments: Instrument[];
  /** What could not be read off the note. */
  problems: string[];
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * Derive a REDCap form name from a label, the way REDCap itself would.
 *
 * Used only when an instrument gives a label and no name. Exported because the
 * editor shows the derived name before it is written: a name generated behind
 * someone's back is one they will not recognise in the dictionary.
 */
export function toFormName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return FIELD_NAME_PATTERN.test(slug) ? slug : slug === "" ? "" : `f_${slug}`;
}

/**
 * Parse the body block into instruments.
 *
 * Accepts both shapes a person will write: a mapping with `instruments:`, and
 * — for a form that is only ever one instrument, which most are — a bare
 * `fields:` list, which becomes a single instrument named after the note.
 */
export function parseFormBlock(
  raw: unknown,
  fallback: { name: string; label: string },
): { instruments: Instrument[]; problems: string[] } {
  const problems: string[] = [];
  const record = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  if (raw === null || raw === undefined) {
    return { instruments: [], problems: ["This form note has no `redcap` block, so it has no fields."] };
  }

  const declared = list(record.instruments);
  if (declared.length === 0) {
    const fields = list(record.fields);
    if (fields.length === 0) {
      return {
        instruments: [],
        problems: ["The `redcap` block declares neither `instruments:` nor `fields:`."],
      };
    }
    const name = toFormName(fallback.name);
    return {
      instruments: [
        {
          name,
          label: fallback.label,
          fields: fields.map((field) => parseField(field, name)),
        },
      ],
      problems,
    };
  }

  const instruments: Instrument[] = [];
  for (const entry of declared) {
    const inst = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = str(inst.label ?? inst.title);
    let name = str(inst.name ?? inst.form_name).toLowerCase();
    if (name === "" && label !== "") {
      name = toFormName(label);
      problems.push(`Instrument "${label}" has no form name; "${name}" was derived from its label.`);
    }
    const fields = list(inst.fields).map((field) => parseField(field, name));
    instruments.push({ name, label: label === "" ? name : label, fields });
  }
  return { instruments, problems };
}

/** All fields across all instruments, in dictionary order. */
export function allFields(spec: FormSpec): RedcapField[] {
  return spec.instruments.flatMap((instrument) => instrument.fields);
}

/**
 * Assemble a form from its two halves.
 *
 * `frontmatter` is the note's own; `block` is the already-parsed YAML body
 * block. Kept separate because they are written by different mechanisms and
 * fail in different ways — a form whose block is unreadable still has an id, a
 * study and a status, and the board should say which form is broken rather
 * than showing an anonymous row.
 */
export function parseFormSpec(input: {
  path: string;
  frontmatter: Record<string, unknown>;
  block: unknown;
  blockProblems?: readonly string[];
}): FormSpec {
  const fm = input.frontmatter;
  const problems: string[] = [...(input.blockProblems ?? [])];

  const basename = input.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  const id = str(fm.id) || basename;
  const title = str(fm.title) || basename;

  const statusRaw = str(fm.status).toLowerCase();
  let status: FormStatus = "draft";
  if (statusRaw !== "") {
    if (isFormStatus(statusRaw)) status = statusRaw;
    else problems.push(`Status "${statusRaw}" is not one of the form statuses; read as draft.`);
  }

  const parsed = parseFormBlock(input.block, { name: basename, label: title });
  problems.push(...parsed.problems);

  return {
    path: input.path,
    id,
    title,
    study: str(fm.study),
    project: str(fm.project),
    status,
    version: str(fm.version),
    instruments: parsed.instruments,
    problems,
  };
}
