/**
 * Variable lineage (§5.8, §7 C2) — "which definition was in force on this date".
 *
 * §5.8 states the reason this module exists: *"'which definition was in force
 * when this extraction ran' is a question you will eventually be asked."* A
 * run record (§5.12) names the variables it consumed and the day it ran; this
 * turns those two into an answer, or into an honest refusal.
 *
 * **Fields are never borrowed backwards.** A history entry records what
 * changed, so most entries state two or three fields. Resolving a past version
 * therefore folds *forwards* from the start of the chain, and any field never
 * stated by then resolves to `null` — "not recorded at that version" — rather
 * than to today's value. Answering "what did this mean in 2023" with the 2026
 * definition is precisely the failure this module exists to prevent, and it
 * would be invisible: the answer would look confident and be wrong.
 *
 * **The chain is the history entries plus the live note.** The note's own
 * frontmatter is the head; `changed` is the date it came into force. A
 * variable at version 1 has a chain of one, which is the common case and
 * answers every date after `changed`.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultDate } from "../time/dates";
import {
  currentDefinition,
  versionRef,
  type Definition,
  type DefinitionRecord,
  type VariableNote,
} from "./variable";

/** One version in the chain, before resolution. */
export interface ChainEntry {
  version: number;
  /** Epoch ms it came into force, or null when the note does not say. */
  on: number | null;
  /** Only the fields this version stated. */
  fields: Partial<Definition>;
  /** Why it replaced the one before. Empty at version 1. */
  reason: string;
  /** True for the live note's own frontmatter. */
  live: boolean;
}

/**
 * A definition resolved at a point in the chain.
 *
 * Every field is either a value with the version that last stated it, or null
 * — and the difference is the whole point. `null` reads as "not recorded",
 * never as a default.
 */
export interface ResolvedField<T> {
  value: T;
  /** The version this value was stated at. */
  since: number;
}

export interface ResolvedDefinition {
  definition: ResolvedField<string> | null;
  dataType: ResolvedField<string> | null;
  units: ResolvedField<string> | null;
  validRange: ResolvedField<[number, number] | null> | null;
  coding: ResolvedField<Definition["coding"]> | null;
  identifier: ResolvedField<boolean> | null;
}

export interface InForce {
  /** The version in force, or 0 when the vault cannot say. */
  version: number;
  /** `VAR-LVEF@2`, or "" when the version is unknown. */
  ref: string;
  /** When that version came into force. */
  on: number | null;
  /** True when the answer is the live note rather than a superseded record. */
  live: boolean;
  /** The resolved fields. Every one may be null — see the module header. */
  definition: ResolvedDefinition;
  /** Plain English for the row that shows it. Never a bare status word. */
  note: string;
  /**
   * Fields the chain never recorded by that version.
   *
   * Named so a report can say "the units were not recorded at version 2"
   * rather than quietly printing today's.
   */
  unrecorded: string[];
}

/** The chain, oldest first, ending with the live note. */
export function chainOf(variable: VariableNote): ChainEntry[] {
  const entries: ChainEntry[] = variable.history.map((record: DefinitionRecord) => ({
    version: record.version,
    on: record.on,
    fields: fieldsOf(record),
    reason: record.reason,
    live: false,
  }));

  entries.push({
    version: variable.version,
    on: variable.changed,
    fields: currentDefinition(variable),
    reason: variable.changeReason,
    live: true,
  });

  return entries.sort((a, b) => a.version - b.version);
}

/** The stated fields of a history record, without its bookkeeping. */
function fieldsOf(record: DefinitionRecord): Partial<Definition> {
  const { version: _version, on: _on, reason: _reason, ...fields } = record;
  return fields;
}

const FIELD_LABELS: Record<keyof ResolvedDefinition, string> = {
  definition: "definition",
  dataType: "data type",
  units: "units",
  validRange: "valid range",
  coding: "coding",
  identifier: "identifier flag",
};

/**
 * Fold the chain up to and including `upTo`, keeping the version each field
 * was last stated at.
 */
function fold(chain: ChainEntry[], upTo: number): { resolved: ResolvedDefinition; unrecorded: string[] } {
  const resolved: ResolvedDefinition = {
    definition: null,
    dataType: null,
    units: null,
    validRange: null,
    coding: null,
    identifier: null,
  };

  for (const entry of chain) {
    if (entry.version > upTo) break;
    const { fields } = entry;
    if (fields.definition !== undefined && fields.definition !== "") {
      resolved.definition = { value: fields.definition, since: entry.version };
    }
    if (fields.dataType !== undefined && fields.dataType !== "") {
      resolved.dataType = { value: fields.dataType, since: entry.version };
    }
    if (fields.units !== undefined && fields.units !== "") {
      resolved.units = { value: fields.units, since: entry.version };
    }
    if (fields.validRange !== undefined) {
      resolved.validRange = { value: fields.validRange, since: entry.version };
    }
    if (fields.coding !== undefined && fields.coding.length > 0) {
      resolved.coding = { value: fields.coding, since: entry.version };
    }
    if (fields.identifier !== undefined && fields.identifier !== null) {
      resolved.identifier = { value: fields.identifier, since: entry.version };
    }
  }

  return { resolved, unrecorded: unrecordedFields(resolved) };
}

/**
 * Which fields the chain never recorded, narrowed to the ones that apply.
 *
 * A numeric variable has no coding and a free-text one has no valid range, so
 * reporting those as "not recorded" is true and useless — and noise here is
 * expensive, because it buries the case that matters ("the units were not
 * recorded in 2020") among two that never could be. When the data type itself
 * is unrecorded nothing is narrowed away: we cannot rule anything out, and
 * guessing which fields applied is exactly what this module refuses to do.
 */
function unrecordedFields(resolved: ResolvedDefinition): string[] {
  const dataType = resolved.dataType?.value ?? "";
  const applies = (key: keyof ResolvedDefinition): boolean => {
    if (dataType === "") return true;
    if (key === "coding") return dataType === "categorical" || dataType === "integer";
    if (key === "validRange") return dataType === "numeric" || dataType === "integer";
    if (key === "units") return dataType === "numeric" || dataType === "integer";
    return true;
  };

  return (Object.keys(FIELD_LABELS) as (keyof ResolvedDefinition)[])
    .filter((key) => resolved[key] === null && applies(key))
    .map((key) => FIELD_LABELS[key]);
}

const UNKNOWN: ResolvedDefinition = {
  definition: null,
  dataType: null,
  units: null,
  validRange: null,
  coding: null,
  identifier: null,
};

/**
 * Which definition was in force on a given date.
 *
 * Answers from the newest version whose start date is on or before `at`. A
 * version with no start date cannot be placed in time and is skipped — but it
 * is named in the note, because a chain with undated links is a chain whose
 * answer is only as good as the dated part.
 */
export function definitionInForceOn(variable: VariableNote, at: number): InForce {
  const chain = chainOf(variable);
  const dated = chain.filter((entry) => entry.on !== null);
  const undated = chain.filter((entry) => entry.on === null);
  const caveat =
    undated.length === 0
      ? ""
      : ` ${undated.length} version${undated.length === 1 ? "" : "s"} in the chain carry no date and were skipped.`;

  if (dated.length === 0) {
    return {
      version: 0,
      ref: "",
      on: null,
      live: false,
      definition: UNKNOWN,
      note: "No version in the chain records when it came into force, so the vault cannot answer this by date.",
      unrecorded: Object.values(FIELD_LABELS),
    };
  }

  // Newest first, so the first match is the one in force.
  const match = [...dated].reverse().find((entry) => (entry.on ?? 0) <= at);
  if (match === undefined) {
    const earliest = dated[0]!;
    return {
      version: 0,
      ref: "",
      on: null,
      live: false,
      definition: UNKNOWN,
      note: `The catalogue's earliest recorded version starts ${toVaultDate(earliest.on ?? 0)}, after that date. The vault holds nothing from before it.${caveat}`,
      unrecorded: Object.values(FIELD_LABELS),
    };
  }

  const { resolved, unrecorded } = fold(chain, match.version);
  const where = match.live
    ? "the current definition, in force since"
    : "a superseded definition, in force from";
  const missing =
    unrecorded.length === 0
      ? ""
      : ` Not recorded at that version: ${unrecorded.join(", ")} — today's values are deliberately not shown in their place.`;

  return {
    version: match.version,
    ref: versionRef(variable.id, match.version),
    on: match.on,
    live: match.live,
    definition: resolved,
    note: `Version ${match.version}, ${where} ${toVaultDate(match.on ?? 0)}.${missing}${caveat}`,
    unrecorded,
  };
}

/** How a resolved field compares, for the "what moved" column. */
function shown(field: keyof ResolvedDefinition, resolved: ResolvedDefinition): string {
  const entry = resolved[field];
  if (entry === null) return " unrecorded";
  const value = entry.value;
  if (field === "validRange") {
    const range = value as [number, number] | null;
    return range === null ? "" : `${range[0]}..${range[1]}`;
  }
  if (field === "coding") {
    return (value as Definition["coding"]).map((code) => `${code.code}=${code.label}`).join("|");
  }
  return String(value);
}

/** One row of the lineage table shown on the board. */
export interface LineageRow {
  version: number;
  ref: string;
  from: number | null;
  /** The day before the next version started, or null while it is current. */
  until: number | null;
  reason: string;
  live: boolean;
  /**
   * Which fields actually moved at this version.
   *
   * **Computed by comparing resolved states, not by listing what the entry
   * happened to write.** The live head always carries every field, so listing
   * its keys would report "coding changed" on a variable that has never had
   * any — and a column that cries wolf on the current version is the one nobody
   * reads on the version that matters. Empty at version 1: nothing moved, it
   * started.
   */
  changed: string[];
}

export function lineage(variable: VariableNote): LineageRow[] {
  const chain = chainOf(variable);
  return chain.map((entry, index) => {
    const next = chain[index + 1];
    const before = index === 0 ? null : fold(chain, chain[index - 1]!.version).resolved;
    const after = fold(chain, entry.version).resolved;
    return {
      version: entry.version,
      ref: versionRef(variable.id, entry.version),
      from: entry.on,
      until: next === undefined ? null : (next.on ?? null),
      reason: entry.reason,
      live: entry.live,
      changed:
        before === null
          ? []
          : (Object.keys(FIELD_LABELS) as (keyof ResolvedDefinition)[])
              .filter((key) => shown(key, before) !== shown(key, after))
              .map((key) => FIELD_LABELS[key]),
    };
  });
}

/**
 * What is wrong with the chain itself, as distinct from the fields.
 *
 * Reported separately from `VariableNote.problems` because these are about the
 * *shape of the history* and only make sense once the chain is assembled:
 * a duplicated version, a gap, a `supersedes` that names the wrong version, or
 * dates that run backwards.
 */
export function chainProblems(variable: VariableNote): string[] {
  const problems: string[] = [];
  const chain = chainOf(variable);

  const seen = new Map<number, number>();
  for (const entry of chain) seen.set(entry.version, (seen.get(entry.version) ?? 0) + 1);
  for (const [version, times] of seen) {
    if (times > 1) problems.push(`Version ${version} appears ${times} times in the chain.`);
  }

  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1]!;
    const entry = chain[index]!;
    if (entry.version !== previous.version + 1) {
      problems.push(
        `The chain jumps from version ${previous.version} to ${entry.version}; ${entry.version - previous.version - 1} version${entry.version - previous.version - 1 === 1 ? " is" : "s are"} missing, so a date in the gap cannot be answered.`,
      );
    }
    if (previous.on !== null && entry.on !== null && entry.on < previous.on) {
      problems.push(
        `Version ${entry.version} is dated before version ${previous.version}, so the chain runs backwards.`,
      );
    }
  }

  if (variable.version > 1) {
    const expected = versionRef(variable.id, variable.version - 1);
    if (variable.supersedes === "") {
      problems.push(`At version ${variable.version} but \`supersedes\` is empty; it should name ${expected}.`);
    } else if (variable.supersedes.toLowerCase() !== expected.toLowerCase()) {
      problems.push(
        `\`supersedes\` says ${variable.supersedes}, but version ${variable.version} follows ${expected}.`,
      );
    }
    if (variable.history.length === 0) {
      problems.push(
        `At version ${variable.version} with an empty \`history\`, so no earlier definition can be produced — only the version number survives, not what it said.`,
      );
    }
  }

  return problems;
}

/** The version a revision would create. */
export function nextVersion(variable: VariableNote): number {
  const highest = Math.max(variable.version, ...variable.history.map((record) => record.version), 0);
  return highest + 1;
}
