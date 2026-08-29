/**
 * The REDCap data dictionary, both directions (§7 D2 steps 1 and 2).
 *
 * §7 orders D2's three deliverables deliberately and this module is the first
 * two of them. The dictionary CSV is the format worth building against: it has
 * been stable across REDCap versions for years, an instance will import one,
 * and — the part that matters for a plugin developed on a machine with no
 * access to any REDCap instance — it is testable in full without one. The
 * project XML that step 3 needs carries version-specific REDCap extensions
 * inside CDISC ODM, and §11 blocks it until a real exported project XML exists
 * to check against. Nothing here guesses at it.
 *
 * **Import is not the inverse of export, and the difference is the point.**
 * Exporting writes the eighteen columns REDCap reads. Importing reads them
 * back *and reports what the dictionary could never have carried*: which
 * catalogue variable a field collects, and why an identifier is held. A form
 * imported from a live instance arrives with those blank, which is a finding
 * to work through, not a defect in the import.
 *
 * §9 requires the round trip be tested — export → import → export produces an
 * identical file — so every column is carried, including the four the model
 * does not interpret. A round trip that quietly drops `@HIDDEN` from a field
 * annotation would silently change how an instrument behaves.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseKeyedCsv, toCsvText } from "../table/csv";
import { formatChoices, parseField, type RedcapField } from "./field";
import { toFormName, type FormSpec, type Instrument } from "./form";

/**
 * The dictionary's columns, in REDCap's own order and spelling.
 *
 * Order matters on export because a person will open the file in Excel beside
 * one exported from REDCap and expect the columns to line up. It deliberately
 * does *not* matter on import: `parseKeyedCsv` reads by header name, so a file
 * whose columns were reordered, or which gained a trailing empty column in
 * Excel, still imports.
 */
export const DICTIONARY_COLUMNS: readonly string[] = [
  "Variable / Field Name",
  "Form Name",
  "Section Header",
  "Field Type",
  "Field Label",
  "Choices, Calculations, OR Slider Labels",
  "Field Note",
  "Text Validation Type OR Show Slider Number",
  "Text Validation Min",
  "Text Validation Max",
  "Identifier?",
  "Branching Logic (Show field only if...)",
  "Required Field?",
  "Custom Alignment",
  "Question Number (surveys only)",
  "Matrix Group Name",
  "Matrix Ranking?",
  "Field Annotation",
];

/** Header name → the key `parseKeyedCsv` lower-cases it to. */
const KEYS = DICTIONARY_COLUMNS.map((column) => column.toLowerCase());

/**
 * Older REDCap exports spell the first column `Variable / Field Name` with no
 * spaces around the slash, and some hand-made files use the plain field name.
 * Accepting the variants costs nothing and saves an import that fails with
 * "the file has no field-name column" on a file that plainly does.
 */
const NAME_ALIASES = [
  "variable / field name",
  "variable/field name",
  "field_name",
  "field name",
  "variable name",
];
const FORM_ALIASES = ["form name", "form_name", "instrument name"];

function pick(values: Record<string, string>, aliases: readonly string[]): string {
  for (const alias of aliases) {
    const value = values[alias];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/* ---------------------------------------------------------------- export -- */

/**
 * The shared column: choices for the choice types, the expression for `calc`
 * and `sql`, slider labels for a slider. One column, three meanings, which is
 * REDCap's decision and not one we can improve on from this side.
 */
function sharedColumn(field: RedcapField): string {
  if (field.type === "calc" || field.type === "sql") return field.calculation;
  return formatChoices(field.choices);
}

export function fieldToRow(field: RedcapField): string[] {
  return [
    field.name,
    field.form,
    field.section,
    field.type,
    field.label,
    sharedColumn(field),
    field.note,
    field.validation,
    field.validationMin,
    field.validationMax,
    field.identifier ? "y" : "",
    field.branching,
    field.required ? "y" : "",
    field.alignment,
    field.questionNumber,
    field.matrixGroup,
    field.matrixRanking,
    field.annotation,
  ];
}

/**
 * Emit the whole form as a dictionary.
 *
 * Callers validate first — §7 is explicit that validation runs before any
 * export — but this does not refuse on its own. Refusing here would put the
 * governance decision in the emitter, where it cannot be overridden with a
 * reason and logged, and an unloggable refusal is not a control (§5.6).
 */
export function toDictionaryCsv(spec: FormSpec): string {
  const rows: string[][] = [];
  for (const instrument of spec.instruments) {
    for (const field of instrument.fields) {
      // The field carries its own `form`, but the instrument is authoritative:
      // a field moved between instruments in the editor would otherwise export
      // under the name of the one it came from.
      rows.push(fieldToRow({ ...field, form: instrument.name }));
    }
  }
  return toCsvText(DICTIONARY_COLUMNS, rows);
}

/* ---------------------------------------------------------------- import -- */

export interface DictionaryImport {
  instruments: Instrument[];
  problems: string[];
  /** What the dictionary format cannot carry, so it arrived empty. */
  gaps: string[];
  /** Columns in the file that are not dictionary columns. Carried nowhere. */
  unknownColumns: string[];
  fieldCount: number;
}

/**
 * Read a dictionary CSV into instruments.
 *
 * Row order within an instrument is REDCap's field order and is preserved.
 * Instrument order is first-appearance order, which is what REDCap shows.
 */
export function fromDictionaryCsv(text: string): DictionaryImport {
  const parsed = parseKeyedCsv(text);
  const problems = [...parsed.problems];

  if (parsed.header.length === 0) {
    return { instruments: [], problems, gaps: [], unknownColumns: [], fieldCount: 0 };
  }

  const hasName = NAME_ALIASES.some((alias) => parsed.header.includes(alias));
  if (!hasName) {
    problems.push(
      "This file has no field-name column, so it is not a REDCap data dictionary. The first column should be \"Variable / Field Name\".",
    );
    return { instruments: [], problems, gaps: [], unknownColumns: [], fieldCount: 0 };
  }

  const recognised = new Set([...KEYS, ...NAME_ALIASES, ...FORM_ALIASES]);
  const unknownColumns = parsed.header.filter((name) => name !== "" && !recognised.has(name));

  const order: string[] = [];
  const byForm = new Map<string, RedcapField[]>();
  let fieldCount = 0;

  for (const row of parsed.rows) {
    const name = pick(row.values, NAME_ALIASES);
    const form = pick(row.values, FORM_ALIASES).toLowerCase();

    if (name === "" && form === "") continue;
    if (name === "") {
      problems.push(`Line ${row.line}: a row with no field name was skipped.`);
      continue;
    }

    const formName = form === "" ? "form_1" : form;
    if (form === "") {
      problems.push(`Line ${row.line}: "${name}" names no instrument, so it was put in "form_1".`);
    }

    // `parseField` already accepts the dictionary's own key spellings, so the
    // row goes in almost as it stands. Only the two aliased columns and the
    // long shared column need naming across.
    const field = parseField(
      {
        ...row.values,
        name,
        field_name: name,
        section_header: row.values["section header"] ?? "",
        field_type: row.values["field type"] ?? "",
        field_label: row.values["field label"] ?? "",
        select_choices_or_calculations: row.values["choices, calculations, or slider labels"] ?? "",
        field_note: row.values["field note"] ?? "",
        text_validation_type_or_show_slider_number:
          row.values["text validation type or show slider number"] ?? "",
        text_validation_min: row.values["text validation min"] ?? "",
        text_validation_max: row.values["text validation max"] ?? "",
        identifier: row.values["identifier?"] ?? "",
        branching_logic: row.values["branching logic (show field only if...)"] ?? "",
        required_field: row.values["required field?"] ?? "",
        custom_alignment: row.values["custom alignment"] ?? "",
        question_number: row.values["question number (surveys only)"] ?? "",
        matrix_group_name: row.values["matrix group name"] ?? "",
        matrix_ranking: row.values["matrix ranking?"] ?? "",
        field_annotation: row.values["field annotation"] ?? "",
      },
      formName,
    );

    for (const problem of field.problems) problems.push(`Line ${row.line}: ${problem}`);

    if (!byForm.has(formName)) {
      byForm.set(formName, []);
      order.push(formName);
    }
    byForm.get(formName)?.push(field);
    fieldCount++;
  }

  const instruments: Instrument[] = order.map((name) => ({
    name,
    // The dictionary has no column for a human label; REDCap derives one from
    // the form name the same way. Shown for editing, not invented silently.
    label: labelFromFormName(name),
    fields: byForm.get(name) ?? [],
  }));

  const gaps: string[] = [];
  if (fieldCount > 0) {
    gaps.push(
      "A data dictionary has no column for the catalogue variable a field collects, so every field arrived without one. Link them to `87 Catalogue/` to get the definition and lineage checks.",
    );
    const flagged = instruments.flatMap((inst) => inst.fields).filter((field) => field.identifier);
    if (flagged.length > 0) {
      gaps.push(
        `${flagged.length} field${flagged.length === 1 ? " is" : "s are"} flagged as an identifier, and the dictionary carries no reason why. Until one is recorded the governance check will report them as unjustified.`,
      );
    }
  }

  if (unknownColumns.length > 0) {
    problems.push(
      `${unknownColumns.length} column${unknownColumns.length === 1 ? "" : "s"} in this file ${unknownColumns.length === 1 ? "is" : "are"} not part of a data dictionary and ${unknownColumns.length === 1 ? "was" : "were"} not read: ${unknownColumns.join(", ")}.`,
    );
  }

  return { instruments, problems, gaps, unknownColumns, fieldCount };
}

/** `baseline_visit` → "Baseline visit". REDCap does the same on its own screens. */
export function labelFromFormName(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words === "" ? "" : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The YAML block an imported dictionary becomes.
 *
 * Emitted as a plain object for the caller to hand to `stringifyYaml`, and
 * deliberately sparse: a field writes only the keys it actually has, so the
 * block a person opens is the instrument they imported rather than eighteen
 * columns of empty string per field.
 */
export function instrumentsToBlock(instruments: readonly Instrument[]): Record<string, unknown> {
  return {
    instruments: instruments.map((instrument) => ({
      name: instrument.name === "" ? toFormName(instrument.label) : instrument.name,
      label: instrument.label,
      fields: instrument.fields.map(fieldToBlock),
    })),
  };
}

export function fieldToBlock(field: RedcapField): Record<string, unknown> {
  const out: Record<string, unknown> = { name: field.name, type: field.type };
  if (field.label !== "") out.label = field.label;
  if (field.choices.length > 0) out.choices = formatChoices(field.choices);
  if (field.calculation !== "") out.calculation = field.calculation;
  if (field.section !== "") out.section = field.section;
  if (field.note !== "") out.note = field.note;
  if (field.validation !== "") out.validation = field.validation;
  if (field.validationMin !== "") out.min = field.validationMin;
  if (field.validationMax !== "") out.max = field.validationMax;
  if (field.required) out.required = true;
  if (field.identifier) out.identifier = true;
  if (field.branching !== "") out.branching = field.branching;
  if (field.alignment !== "") out.alignment = field.alignment;
  if (field.variable !== "") out.variable = field.variable;
  if (field.justification !== "") out.justification = field.justification;
  if (field.questionNumber !== "") out.question_number = field.questionNumber;
  if (field.matrixGroup !== "") out.matrix_group_name = field.matrixGroup;
  if (field.matrixRanking !== "") out.matrix_ranking = field.matrixRanking;
  if (field.annotation !== "") out.annotation = field.annotation;
  return out;
}
