/**
 * The SCDB variable catalogue (CLAUDE.md §5.8, §7 C2).
 *
 * "The asset a data collection facility actually owns." A variable note is the
 * join between everything else: requests cite variables, REDCap forms create
 * them, scripts consume them, and a policy change alters their definition.
 *
 * §5.8 gives the frontmatter shape and this module is its parser. Two things
 * it adds, both because C2 has to answer a question the example cannot:
 *
 *  - **`history:`** — the definitions that came before. §5.8 carries `version`
 *    and `supersedes: VAR-LVEF@2`, which name a prior version without saying
 *    what it *said*. "Which definition was in force when this extraction ran"
 *    (§5.8, §7 C2) cannot be answered from a pointer to a version number, so
 *    the superseded text lives on the note in the same append-only shape a
 *    request's `history` uses. See `lineage.ts` for how it resolves.
 *  - **`justification`** — free text, required by nothing, but the field a
 *    board can point at when `identifier: true`. D2's governance hook checks
 *    identifiers against the study's approved IRB scope; this is where the
 *    answer is written down.
 *
 * Unlike a policy's version (a string, because the issuer prints "2026-A"), a
 * variable's version is **ours** and sequential: `supersedes: VAR-LVEF@2`
 * only parses as a chain if the numbers are numbers. A version that is not a
 * positive integer is reported as a problem rather than coerced.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseTimestamp } from "../time/dates";

export const VARIABLE_TYPE = "variable";

/**
 * What kind of value the variable holds.
 *
 * Closed, because the catalogue board groups by it and because D2 maps each
 * one onto a REDCap field type. `calculated` is here for the same reason
 * REDCap has it: a derived variable has a definition worth versioning and no
 * source form.
 */
export const DATA_TYPES = [
  "numeric",
  "integer",
  "categorical",
  "boolean",
  "date",
  "datetime",
  "text",
  "calculated",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export function isDataType(value: unknown): value is DataType {
  return typeof value === "string" && (DATA_TYPES as readonly string[]).includes(value);
}

export const DATA_TYPE_LABELS: Record<DataType, string> = {
  numeric: "Numeric",
  integer: "Integer",
  categorical: "Categorical",
  boolean: "Boolean",
  date: "Date",
  datetime: "Date and time",
  text: "Free text",
  calculated: "Calculated",
};

/** One code and its meaning, for a categorical variable. */
export interface Coding {
  code: string;
  label: string;
}

/**
 * The fields whose change is a change of *meaning*, not of bookkeeping.
 *
 * A revision snapshots these and nothing else: retitling a variable or adding
 * a study to `collected_in` does not change what a past extraction measured,
 * and filling the history with entries that did not move the definition makes
 * the ones that did harder to find.
 */
export interface Definition {
  definition: string;
  dataType: DataType | "";
  units: string;
  validRange: [number, number] | null;
  coding: Coding[];
  identifier: boolean | null;
}

/** One superseded definition, as recorded on the note. */
export interface DefinitionRecord extends Partial<Definition> {
  /** The version this definition *was*. */
  version: number;
  /** Epoch ms it came into force, or null when the note does not say. */
  on: number | null;
  /** Why it changed to the next one. The point of the record. */
  reason: string;
}

export interface VariableNote {
  path: string;
  id: string;
  label: string;
  /** Free text: echo, labs, demographics. Grouped on, not validated. */
  domain: string;
  dataType: DataType | "";
  units: string;
  definition: string;
  validRange: [number, number] | null;
  coding: Coding[];
  /** Studies that collect it, as written — wikilinks, ids, or names. */
  collectedIn: string[];
  sourceForm: string;
  identifier: boolean;
  /** Why an identifier is held. Empty is a finding, not an error. */
  justification: string;
  /** Sequential, ours. 0 when the note gives none or gives nonsense. */
  version: number;
  /** As written, e.g. "VAR-LVEF@2". Empty at version 1. */
  supersedes: string;
  /** When the current version came into force. Epoch ms, or null. */
  changed: number | null;
  changeReason: string;
  /** Prior definitions, oldest first. */
  history: DefinitionRecord[];
  problems: string[];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A tri-state boolean.
 *
 * `null` means "the note does not say", which on a history entry is different
 * from `false` and must stay different: a superseded definition that never
 * recorded whether it was an identifier cannot be reported as "it was not".
 */
function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = str(value).toLowerCase();
  if (text === "true" || text === "yes") return true;
  if (text === "false" || text === "no") return false;
  return null;
}

/** `[0, 100]`, or null when absent or unreadable. */
function parseRange(value: unknown, where: string, problems: string[]): [number, number] | null {
  if (value === undefined || value === null) return null;
  const items = list(value);
  if (items.length !== 2) {
    problems.push(`\`${where}\` needs exactly two values, a minimum and a maximum.`);
    return null;
  }
  const low = Number(items[0]);
  const high = Number(items[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    problems.push(`\`${where}\` is not a pair of numbers.`);
    return null;
  }
  if (low > high) {
    problems.push(`\`${where}\` runs backwards: ${low} is above ${high}.`);
    return null;
  }
  return [low, high];
}

/**
 * Codes for a categorical variable.
 *
 * Accepts the mapping form §5.8 shows (`coding: { 1: Mild }`), a list of
 * mappings, and REDCap's own `"1, Mild | 2, Severe"` string — the last because
 * that is what somebody pasting from a data dictionary will type, and D2 has
 * to read it anyway.
 */
export function parseCoding(value: unknown, problems: string[]): Coding[] {
  if (value === undefined || value === null) return [];

  if (typeof value === "string") {
    const codes: Coding[] = [];
    for (const chunk of value.split("|")) {
      const text = chunk.trim();
      if (text === "") continue;
      const comma = text.indexOf(",");
      if (comma === -1) {
        problems.push(`\`coding\` entry "${text}" has no comma between the code and its label.`);
        continue;
      }
      codes.push({ code: text.slice(0, comma).trim(), label: text.slice(comma + 1).trim() });
    }
    return codes;
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([code, label]) => ({ code: code.trim(), label: str(label) }));
  }

  const codes: Coding[] = [];
  list(value).forEach((entry, index) => {
    if (isRecord(entry)) {
      const code = str(entry["code"]);
      if (code === "") {
        problems.push(`\`coding[${index}]\` has no \`code\`.`);
        return;
      }
      codes.push({ code, label: str(entry["label"]) });
      return;
    }
    problems.push(`\`coding[${index}]\` is neither a mapping nor a "code, label" string.`);
  });
  return codes;
}

/** The definition fields off any mapping — the note itself or a history entry. */
function definitionFields(raw: Record<string, unknown>, where: string, problems: string[]): Partial<Definition> {
  const fields: Partial<Definition> = {};

  const definition = str(raw["definition"]);
  if (definition !== "") fields.definition = definition;

  if (raw["data_type"] !== undefined) {
    const dataType = str(raw["data_type"]);
    if (isDataType(dataType)) fields.dataType = dataType;
    else if (dataType !== "") {
      problems.push(`\`${where}data_type\` "${dataType}" is not one of ${DATA_TYPES.join(", ")}.`);
    }
  }

  if (raw["units"] !== undefined) fields.units = str(raw["units"]);
  if (raw["valid_range"] !== undefined) {
    fields.validRange = parseRange(raw["valid_range"], `${where}valid_range`, problems);
  }
  if (raw["coding"] !== undefined) fields.coding = parseCoding(raw["coding"], problems);
  if (raw["identifier"] !== undefined) {
    const identifier = bool(raw["identifier"]);
    if (identifier === null) {
      problems.push(`\`${where}identifier\` is not true or false.`);
    } else {
      fields.identifier = identifier;
    }
  }

  return fields;
}

function parseHistory(raw: unknown, problems: string[]): DefinitionRecord[] {
  const records: DefinitionRecord[] = [];
  list(raw).forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`\`history[${index}]\` is not a mapping and was ignored.`);
      return;
    }
    const version = Number(entry["version"]);
    if (!Number.isInteger(version) || version < 1) {
      problems.push(`\`history[${index}]\` has no whole-number \`version\`, so it cannot be placed in the chain.`);
      return;
    }
    records.push({
      ...definitionFields(entry, `history[${index}].`, problems),
      version,
      on: parseTimestamp(entry["on"] ?? entry["changed"]),
      reason: str(entry["reason"] ?? entry["change_reason"]),
    });
  });

  // Oldest first: the chain is read forwards, and a note may have been
  // hand-edited into any order.
  return records.sort((a, b) => a.version - b.version);
}

export function parseVariable(path: string, raw: Record<string, unknown>): VariableNote {
  const problems: string[] = [];

  const id = str(raw["id"]);
  if (id === "") problems.push("No `id`, so nothing can cite this variable.");

  const dataTypeRaw = str(raw["data_type"]);
  if (dataTypeRaw !== "" && !isDataType(dataTypeRaw)) {
    problems.push(`Data type "${dataTypeRaw}" is not one of ${DATA_TYPES.join(", ")}.`);
  }
  const dataType: DataType | "" = isDataType(dataTypeRaw) ? dataTypeRaw : "";

  const versionRaw = raw["version"];
  let version = 0;
  if (versionRaw === undefined) {
    problems.push("No `version`. A catalogue entry with no version cannot be superseded.");
  } else {
    const parsed = Number(versionRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      problems.push(
        `Version "${str(versionRaw)}" is not a whole number. Catalogue versions are ours and sequential — \`supersedes: ${id || "VAR-x"}@2\` only reads as a chain if they are.`,
      );
    } else {
      version = parsed;
    }
  }

  const definition = str(raw["definition"]);
  if (definition === "") {
    problems.push("No `definition`. The definition is the thing a request, a form and a script all rely on.");
  }

  const coding = parseCoding(raw["coding"], problems);
  if (dataType === "categorical" && coding.length === 0) {
    problems.push("Categorical, but no `coding`, so a code in the data means nothing on its own.");
  }
  if (coding.length > 0 && dataType !== "" && dataType !== "categorical" && dataType !== "integer") {
    problems.push(`\`coding\` on a ${DATA_TYPE_LABELS[dataType].toLowerCase()} variable — one of the two is wrong.`);
  }

  const identifier = bool(raw["identifier"]) ?? false;
  const justification = str(raw["justification"]);
  if (identifier && justification === "") {
    // Not an error: the catalogue records what is true. But an identifier with
    // no recorded reason is exactly what D2's governance hook has to flag, and
    // it is cheaper to answer here than at form-export time.
    problems.push("Flagged as an identifier with no `justification`, so nothing records why it is held.");
  }

  const changed = parseTimestamp(raw["changed"]);
  if (raw["changed"] !== undefined && changed === null) {
    problems.push("`changed` is not a date the plugin can read.");
  }

  const supersedes = str(raw["supersedes"]);
  const history = parseHistory(raw["history"], problems);

  if (version > 1 && changed === null) {
    problems.push(
      "Past version 1 with no `changed` date, so the vault cannot say when this definition came into force.",
    );
  }
  if (version > 1 && str(raw["change_reason"]) === "") {
    problems.push("Past version 1 with no `change_reason`.");
  }

  return {
    path,
    id,
    label: str(raw["label"]),
    domain: str(raw["domain"]),
    dataType,
    units: str(raw["units"]),
    definition,
    validRange: parseRange(raw["valid_range"], "valid_range", problems),
    coding,
    collectedIn: list(raw["collected_in"]).map(str).filter((entry) => entry !== ""),
    sourceForm: str(raw["source_form"]),
    identifier,
    justification,
    version,
    supersedes,
    changed,
    changeReason: str(raw["change_reason"]),
    history,
    problems,
  };
}

/** The current definition, as the head of the chain. */
export function currentDefinition(variable: VariableNote): Definition {
  return {
    definition: variable.definition,
    dataType: variable.dataType,
    units: variable.units,
    validRange: variable.validRange,
    coding: variable.coding,
    identifier: variable.identifier,
  };
}

/** `VAR-LVEF@2` — how one version of a variable is named in `supersedes`. */
export function versionRef(id: string, version: number): string {
  return id === "" ? "" : `${id}@${version}`;
}

/** How a variable is named for a human: "VAR-LVEF — Left ventricular…". */
export function variableLabel(variable: VariableNote): string {
  if (variable.id !== "" && variable.label !== "") return `${variable.id} — ${variable.label}`;
  return variable.id || variable.label || variable.path;
}

/** A data type's label, or the raw value when the note says something else. */
export function dataTypeLabel(dataType: string): string {
  return isDataType(dataType) ? DATA_TYPE_LABELS[dataType] : dataType || "Unstated";
}

/**
 * True when a ref written on some other note points at this variable.
 *
 * The same latitude the policy register allows: a markdown vault means the ref
 * is whatever somebody typed — the id, the filename, a path, or a wikilink
 * around any of them. A version suffix is stripped first, so a run record
 * citing `VAR-LVEF@2` is still recognised as depending on `VAR-LVEF`; which
 * version it named is a separate question, answered in `lineage.ts`.
 */
export function refMatchesVariable(ref: string, variable: VariableNote): boolean {
  const target = refTarget(ref);
  if (target === "") return false;
  const basename = variable.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  return (
    target === variable.id.toLowerCase() ||
    target === basename.toLowerCase() ||
    target === variable.path.replace(/\.md$/i, "").toLowerCase() ||
    target === variable.label.toLowerCase()
  );
}

/** The comparable half of a ref: brackets, alias, folder and `@version` gone. */
export function refTarget(ref: string): string {
  let text = ref.trim();
  const wikilink = /^\[\[([^\]]+)\]\]$/.exec(text);
  if (wikilink !== null) text = wikilink[1] ?? "";
  const pipe = text.indexOf("|");
  if (pipe !== -1) text = text.slice(0, pipe);
  const hash = text.indexOf("#");
  if (hash !== -1) text = text.slice(0, hash);
  text = text.trim().replace(/\.md$/i, "");
  const at = text.lastIndexOf("@");
  if (at > 0 && /^\d+$/.test(text.slice(at + 1))) text = text.slice(0, at);
  return text.trim().toLowerCase();
}

/** The version a ref named, or null when it named none. */
export function refVersion(ref: string): number | null {
  const text = ref.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0]?.trim() ?? "";
  const at = /@(\d+)\s*$/.exec(text);
  return at === null ? null : Number(at[1]);
}
