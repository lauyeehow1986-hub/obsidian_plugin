/**
 * Revising a catalogue variable (§5.8, §7 C2).
 *
 * §7 C2 asks to "version and supersede them with a recorded reason". This
 * plans that: what the new version would say, what the superseded record has
 * to preserve, and why it would be refused.
 *
 * **The prior definition is pushed down, not overwritten.** The note's current
 * definition fields become a `history` entry stamped with the version and the
 * date they came into force, and only then does the head change. That entry is
 * the only thing that will ever be able to answer what the variable meant last
 * year, so it is written before anything else — the same ordering rule as
 * C1's "freeze first, replace second", and for the same reason.
 *
 * **A reason is required.** Same rule as a gate override (§5.6) and a policy
 * revision (§7 C1): a version bump that says only "updated" is a row nobody
 * can act on. Refusing to type one cancels the revision.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultDate } from "../time/dates";
import { nextVersion } from "./lineage";
import {
  dataTypeLabel,
  versionRef,
  type Coding,
  type Definition,
  type VariableNote,
} from "./variable";

/** One field the revision would move. */
export interface FieldChange {
  field: keyof Definition;
  label: string;
  before: string;
  after: string;
}

export interface RevisionPlan {
  fromVersion: number;
  toVersion: number;
  /** `VAR-LVEF@2` — what the new version will declare it supersedes. */
  supersedes: string;
  reason: string;
  changes: FieldChange[];
  /**
   * The frontmatter the note would carry after the revision, as plain values
   * ready for `processFrontMatter`. Only keys this revision touches.
   */
  patch: Record<string, unknown>;
  /** The history entry the prior definition becomes. */
  record: Record<string, unknown>;
  /** Why it cannot proceed. Empty means it can. */
  refusals: string[];
  /** One line for the audit ledger's detail cell: ids and counts, no content. */
  auditDetail: string;
  /** True when the identifier flag moves — logged separately, see §5.6. */
  identifierMoved: boolean;
}

const FIELD_LABELS: Record<keyof Definition, string> = {
  definition: "Definition",
  dataType: "Data type",
  units: "Units",
  validRange: "Valid range",
  coding: "Coding",
  identifier: "Identifier",
};

function showRange(range: [number, number] | null): string {
  return range === null ? "—" : `${range[0]} to ${range[1]}`;
}

function showCoding(coding: Coding[]): string {
  return coding.length === 0 ? "—" : coding.map((code) => `${code.code}, ${code.label}`).join(" | ");
}

function sameCoding(a: Coding[], b: Coding[]): boolean {
  return a.length === b.length && a.every((code, index) => {
    const other = b[index];
    return other !== undefined && other.code === code.code && other.label === code.label;
  });
}

function show(field: keyof Definition, value: Definition[keyof Definition]): string {
  if (field === "validRange") return showRange(value as [number, number] | null);
  if (field === "coding") return showCoding(value as Coding[]);
  if (field === "identifier") return value === true ? "yes" : value === false ? "no" : "—";
  if (field === "dataType") return dataTypeLabel(String(value ?? ""));
  const text = String(value ?? "").trim();
  return text === "" ? "—" : text;
}

/** Which definition fields differ between the note and the proposed change. */
export function diffDefinition(current: Definition, proposed: Partial<Definition>): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of Object.keys(FIELD_LABELS) as (keyof Definition)[]) {
    const after = proposed[field];
    if (after === undefined) continue;
    const before = current[field];

    const same =
      field === "coding"
        ? sameCoding(before as Coding[], after as Coding[])
        : field === "validRange"
          ? showRange(before as [number, number] | null) === showRange(after as [number, number] | null)
          : before === after;
    if (same) continue;

    changes.push({
      field,
      label: FIELD_LABELS[field],
      before: show(field, before),
      after: show(field, after),
    });
  }

  return changes;
}

/**
 * The history entry the current definition becomes.
 *
 * **Every governed field is written, not only the ones that changed.** A
 * sparse entry would be smaller, but resolving a past version then depends on
 * folding several entries together and inherits whatever the earlier ones
 * happened to omit. Writing the whole state makes the record self-contained,
 * which is what an auditor reading one entry needs.
 */
export function historyRecord(variable: VariableNote, at: number): Record<string, unknown> {
  const record: Record<string, unknown> = {
    version: variable.version,
    on: variable.changed === null ? "" : toVaultDate(variable.changed),
    definition: variable.definition,
    reason: variable.changeReason,
  };
  // An empty reason is left out rather than written as `reason: ""`. Version 1
  // has no reason to record — it did not replace anything — and a blank key
  // reads as a reason someone failed to give.
  if (variable.changeReason.trim() === "") delete record["reason"];
  if (variable.dataType !== "") record["data_type"] = variable.dataType;
  if (variable.units !== "") record["units"] = variable.units;
  if (variable.validRange !== null) record["valid_range"] = variable.validRange;
  if (variable.coding.length > 0) {
    record["coding"] = variable.coding.map((code) => ({ code: code.code, label: code.label }));
  }
  record["identifier"] = variable.identifier;

  // A version that never recorded when it started cannot be placed in time.
  // Stamping today's date would be a lie; leaving it empty is the truth, and
  // `definitionInForceOn` says so out loud when it meets one.
  if (record["on"] === "") delete record["on"];
  void at;
  return record;
}

export function planRevision(input: {
  variable: VariableNote;
  /** Only the fields the dialog changed. */
  changes: Partial<Definition>;
  reason: string;
  at: number;
}): RevisionPlan {
  const { variable } = input;
  const refusals: string[] = [];

  const reason = input.reason.trim();
  if (reason === "") {
    refusals.push(
      "Say in one line why the definition changed. A superseded version with no reason cannot be acted on later.",
    );
  }
  if (variable.id === "") {
    refusals.push("The note has no `id`, so the superseded version has nothing to be named after.");
  }
  if (variable.version < 1) {
    refusals.push(
      "The note has no readable whole-number `version`, so there is nothing to bump. Set `version: 1` first.",
    );
  }

  const current: Definition = {
    definition: variable.definition,
    dataType: variable.dataType,
    units: variable.units,
    validRange: variable.validRange,
    coding: variable.coding,
    identifier: variable.identifier,
  };
  const changes = diffDefinition(current, input.changes);
  if (changes.length === 0) {
    refusals.push(
      "Nothing in the definition changed. A version bump with no change makes the versions that do mean something harder to find.",
    );
  }

  const fromVersion = variable.version;
  const toVersion = nextVersion(variable);
  const identifierMoved = changes.some((change) => change.field === "identifier");

  const patch: Record<string, unknown> = {
    version: toVersion,
    supersedes: versionRef(variable.id, fromVersion),
    changed: toVaultDate(input.at),
    change_reason: reason,
  };
  for (const change of changes) {
    if (change.field === "definition") patch["definition"] = input.changes.definition;
    if (change.field === "dataType") patch["data_type"] = input.changes.dataType;
    if (change.field === "units") patch["units"] = input.changes.units;
    if (change.field === "validRange") patch["valid_range"] = input.changes.validRange;
    if (change.field === "coding") {
      patch["coding"] = (input.changes.coding ?? []).map((code) => ({
        code: code.code,
        label: code.label,
      }));
    }
    if (change.field === "identifier") patch["identifier"] = input.changes.identifier;
  }

  return {
    fromVersion,
    toVersion,
    supersedes: versionRef(variable.id, fromVersion),
    reason,
    changes,
    patch,
    record: historyRecord(variable, input.at),
    refusals,
    // Field names and counts only (rule 7). What a definition *says* is the
    // user's own words about a measurement, but it can be long and it belongs
    // on the note, not in a ledger cell.
    auditDetail: `v${fromVersion}→v${toVersion}; ${changes.map((change) => change.field).join(", ") || "no field"} changed`,
    identifierMoved,
  };
}
