/**
 * REDCap form validation (§7 D2: "Validation is the value, and must run before
 * any export").
 *
 * The argument for this module is simple. Uploading a bad data dictionary to
 * REDCap fails with a message naming a row number, after the upload, at the
 * point where you are least able to think about it. Everything checkable
 * without an instance is checked here instead, before the file is written, and
 * named in English against the field it belongs to.
 *
 * **Two severities, and the line between them is whether REDCap will accept
 * the file.** An `error` is something the instance will reject or silently
 * mangle — a duplicate field name, a malformed choice list, a `calc` with
 * nothing to calculate. A `warning` is something that will upload and then
 * disappoint: a checkbox with one option, a branching condition naming a field
 * this dictionary does not carry. Errors block export; warnings are shown and
 * exported past. Blocking on warnings would train the person to override, and
 * an override that becomes routine has stopped being a control.
 *
 * Governance findings live in `governance.ts` and are *not* here, even though
 * both gate the export. Validation asks whether REDCap will take the file;
 * governance asks whether it should exist. They are different questions with
 * different remedies, and merging them into one list makes the second one look
 * like a formatting complaint.
 *
 * Pure module: no Obsidian, no Node.
 */

import { checkLogic, type LogicContext } from "./branching";
import {
  CHOICE_TYPES,
  FIELD_NAME_PATTERN,
  MAX_FIELD_NAME_LENGTH,
  RESERVED_FIELD_NAMES,
  VALIDATABLE_TYPES,
  VALIDATION_TYPES,
  isDateValidation,
  isNumericValidation,
  type RedcapField,
} from "./field";
import { allFields, type FormSpec } from "./form";
import { parseTimestamp } from "../time/dates";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  /** Stable slug, so a test can pin a rule without pinning its wording. */
  code: string;
  /** The instrument, or "" when the finding is about the form as a whole. */
  instrument: string;
  /** The field, or "" when it is about the instrument. */
  field: string;
  message: string;
}

function error(code: string, instrument: string, field: string, message: string): Finding {
  return { severity: "error", code, instrument, field, message };
}

function warn(code: string, instrument: string, field: string, message: string): Finding {
  return { severity: "warning", code, instrument, field, message };
}

/** Build the lookup `checkLogic` needs from a whole form. */
export function logicContext(spec: FormSpec): LogicContext {
  const choices = new Map<string, readonly string[]>();
  const checkboxes = new Set<string>();
  const known = new Set<string>();
  for (const field of allFields(spec)) {
    if (field.name === "") continue;
    known.add(field.name);
    if (field.choices.length > 0) choices.set(field.name, field.choices.map((c) => c.code));
    if (field.type === "checkbox") checkboxes.add(field.name);
  }
  return { choices, checkboxes, known };
}

/**
 * A min/max bound, read the way its validation type says to read it.
 *
 * Returns `null` when the bound is empty, and `undefined` when it is present
 * but unreadable — the difference between "no lower bound" and "the lower
 * bound is the word banana", which are not the same finding.
 */
function readBound(raw: string, validation: string): number | null | undefined {
  if (raw.trim() === "") return null;
  if (isDateValidation(validation)) return parseTimestamp(raw) ?? undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function validateField(
  field: RedcapField,
  instrument: string,
  seen: Map<string, string>,
  context: LogicContext,
): Finding[] {
  const findings: Finding[] = [];
  const where = field.name === "" ? (field.label || "an unnamed field") : field.name;

  for (const problem of field.problems) {
    findings.push(error("field-unreadable", instrument, field.name, problem));
  }

  /* -- the name ---------------------------------------------------------- */

  if (field.name === "") {
    findings.push(error("name-missing", instrument, "", `${where} has no field name.`));
  } else {
    if (!FIELD_NAME_PATTERN.test(field.name)) {
      findings.push(
        error(
          "name-shape",
          instrument,
          field.name,
          `"${field.name}" is not a name REDCap accepts: lowercase letters, digits and underscores, starting with a letter.`,
        ),
      );
    }
    if (field.name.length > MAX_FIELD_NAME_LENGTH) {
      findings.push(
        error(
          "name-length",
          instrument,
          field.name,
          `"${field.name}" is ${field.name.length} characters; REDCap allows ${MAX_FIELD_NAME_LENGTH}, and truncation can collide with another field.`,
        ),
      );
    }
    if (RESERVED_FIELD_NAMES.includes(field.name)) {
      findings.push(
        error("name-reserved", instrument, field.name, `"${field.name}" is a name REDCap reserves for itself.`),
      );
    }
    if (field.name.endsWith("_complete")) {
      findings.push(
        error(
          "name-reserved",
          instrument,
          field.name,
          `"${field.name}" collides with the \`<instrument>_complete\` column REDCap creates for every instrument.`,
        ),
      );
    }
    const previous = seen.get(field.name);
    if (previous !== undefined) {
      findings.push(
        error(
          "name-duplicate",
          instrument,
          field.name,
          `"${field.name}" is already used${previous === instrument ? "" : ` on ${previous}`}. Field names are unique across the whole project, not per instrument.`,
        ),
      );
    } else {
      seen.set(field.name, instrument);
    }
  }

  if (field.label === "" && field.type !== "descriptive") {
    findings.push(warn("label-missing", instrument, field.name, `${where} has no label, so it will show as a blank prompt.`));
  }

  /* -- choices ----------------------------------------------------------- */

  const wantsChoices = CHOICE_TYPES.includes(field.type);
  if (wantsChoices && field.choices.length === 0) {
    findings.push(
      error("choices-missing", instrument, field.name, `${where} is a ${field.type} with no choices to pick from.`),
    );
  }
  if (!wantsChoices && field.choices.length > 0) {
    findings.push(
      warn(
        "choices-unused",
        instrument,
        field.name,
        `${where} is a ${field.type}, so its choice list is carried but never shown.`,
      ),
    );
  }
  if (wantsChoices && field.choices.length === 1) {
    findings.push(
      warn("choices-single", instrument, field.name, `${where} offers only one choice, so it cannot record a distinction.`),
    );
  }

  const codes = new Map<string, number>();
  for (const choice of field.choices) {
    if (choice.code === "") {
      findings.push(error("choice-code-missing", instrument, field.name, `${where} has a choice with no code.`));
      continue;
    }
    if (choice.label === "") {
      findings.push(
        error("choice-label-missing", instrument, field.name, `${where}: choice ${choice.code} has no label.`),
      );
    }
    if (/[|]/.test(choice.label) || /[|]/.test(choice.code)) {
      findings.push(
        error(
          "choice-pipe",
          instrument,
          field.name,
          `${where}: choice ${choice.code} contains a \`|\`, which is the separator between choices and cannot be escaped.`,
        ),
      );
    }
    codes.set(choice.code, (codes.get(choice.code) ?? 0) + 1);
  }
  for (const [code, count] of codes) {
    if (count > 1) {
      findings.push(
        error("choice-duplicate", instrument, field.name, `${where} uses the code ${code} ${count} times.`),
      );
    }
  }

  /* -- validation and bounds --------------------------------------------- */

  if (field.validation !== "") {
    if (!(VALIDATION_TYPES as readonly string[]).includes(field.validation)) {
      findings.push(
        warn(
          "validation-unknown",
          instrument,
          field.name,
          `${where} uses the validation type "${field.validation}", which is not one REDCap ships. If your instance defines it this is fine; if it is a typo the upload will fail.`,
        ),
      );
    }
    if (!VALIDATABLE_TYPES.includes(field.type) && field.type !== "slider") {
      findings.push(
        error(
          "validation-misplaced",
          instrument,
          field.name,
          `${where} is a ${field.type}; REDCap only validates text and notes fields.`,
        ),
      );
    }
  }

  const min = readBound(field.validationMin, field.validation);
  const max = readBound(field.validationMax, field.validation);
  const dated = isDateValidation(field.validation);
  if (min === undefined) {
    findings.push(
      error(
        "bound-unreadable",
        instrument,
        field.name,
        `${where}: the minimum "${field.validationMin}" is not a ${dated ? "date" : "number"}.`,
      ),
    );
  }
  if (max === undefined) {
    findings.push(
      error(
        "bound-unreadable",
        instrument,
        field.name,
        `${where}: the maximum "${field.validationMax}" is not a ${dated ? "date" : "number"}.`,
      ),
    );
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    findings.push(
      error(
        "bound-inverted",
        instrument,
        field.name,
        `${where}: the minimum (${field.validationMin}) is above the maximum (${field.validationMax}), so nothing can be entered.`,
      ),
    );
  }
  if ((min !== null || max !== null) && field.validation === "") {
    findings.push(
      warn(
        "bound-without-validation",
        instrument,
        field.name,
        `${where} has a range but no validation type, so REDCap will not enforce it.`,
      ),
    );
  }
  if (
    (min !== null || max !== null) &&
    field.validation !== "" &&
    !isNumericValidation(field.validation) &&
    !dated
  ) {
    findings.push(
      warn(
        "bound-unenforceable",
        instrument,
        field.name,
        `${where} has a range, but "${field.validation}" is not a type REDCap applies a range to.`,
      ),
    );
  }

  /* -- expressions -------------------------------------------------------- */

  if (field.type === "calc") {
    if (field.calculation === "") {
      findings.push(error("calc-empty", instrument, field.name, `${where} is a calculated field with no calculation.`));
    } else {
      const check = checkLogic(field.calculation, field.name, "Calculation", context);
      for (const problem of check.problems) {
        findings.push(error("calc-invalid", instrument, field.name, `${where}: ${problem}`));
      }
      for (const name of check.unknown) {
        findings.push(
          warn(
            "calc-external",
            instrument,
            field.name,
            `${where}: the calculation uses [${name}], which is not a field in this form.`,
          ),
        );
      }
    }
  } else if (field.calculation !== "") {
    findings.push(
      warn(
        "calc-unused",
        instrument,
        field.name,
        `${where} carries a calculation but is a ${field.type}, so it will never run.`,
      ),
    );
  }

  if (field.branching !== "") {
    const check = checkLogic(field.branching, field.name, "Branching logic", context);
    for (const problem of check.problems) {
      findings.push(error("branching-invalid", instrument, field.name, `${where}: ${problem}`));
    }
    for (const name of check.unknown) {
      findings.push(
        warn(
          "branching-external",
          instrument,
          field.name,
          `${where}: the branching logic tests [${name}], which is not a field in this form. If it is on another instrument in the same project this is fine — but this dictionary does not carry it.`,
        ),
      );
    }
  }

  if (field.required && field.type === "descriptive") {
    findings.push(
      error("required-descriptive", instrument, field.name, `${where} is descriptive text and cannot be required.`),
    );
  }

  return findings;
}

/**
 * Validate a whole form.
 *
 * Field names are checked for uniqueness across every instrument, not per
 * instrument, because REDCap's namespace is the project. A form that validates
 * one instrument at a time will export two `dob` columns and fail on upload.
 */
export function validateForm(spec: FormSpec): Finding[] {
  const findings: Finding[] = [];

  for (const problem of spec.problems) {
    findings.push(error("form-unreadable", "", "", problem));
  }

  if (spec.instruments.length === 0) {
    findings.push(error("no-instruments", "", "", "This form has no instruments, so there is nothing to export."));
    return findings;
  }

  const context = logicContext(spec);
  const seenFields = new Map<string, string>();
  const seenForms = new Map<string, number>();

  for (const instrument of spec.instruments) {
    if (instrument.name === "") {
      findings.push(
        error(
          "form-name-missing",
          "",
          "",
          `The instrument "${instrument.label}" has no form name, and the dictionary groups rows by form name.`,
        ),
      );
    } else {
      if (!FIELD_NAME_PATTERN.test(instrument.name)) {
        findings.push(
          error(
            "form-name-shape",
            instrument.name,
            "",
            `"${instrument.name}" is not a form name REDCap accepts: lowercase letters, digits and underscores, starting with a letter.`,
          ),
        );
      }
      seenForms.set(instrument.name, (seenForms.get(instrument.name) ?? 0) + 1);
    }

    if (instrument.fields.length === 0) {
      findings.push(warn("form-empty", instrument.name, "", `"${instrument.label}" has no fields.`));
    }

    for (const field of instrument.fields) {
      findings.push(...validateField(field, instrument.name, seenFields, context));
    }
  }

  for (const [name, count] of seenForms) {
    if (count > 1) {
      findings.push(error("form-name-duplicate", name, "", `Two instruments are both called "${name}".`));
    }
  }

  /* -- the record identifier --------------------------------------------- */

  // REDCap takes the very first field of the very first instrument as the
  // record identifier, whatever it is called. A form whose first field is a
  // date of birth produces a project keyed on date of birth — which uploads
  // cleanly and is discovered much later.
  const first = spec.instruments[0]?.fields[0];
  if (first !== undefined && first.name !== "") {
    if (first.type !== "text") {
      findings.push(
        error(
          "record-id-type",
          spec.instruments[0]?.name ?? "",
          first.name,
          `"${first.name}" is the first field, so REDCap will make it the record identifier — and a ${first.type} cannot be one.`,
        ),
      );
    }
    if (first.identifier) {
      findings.push(
        warn(
          "record-id-identifier",
          spec.instruments[0]?.name ?? "",
          first.name,
          `"${first.name}" is the record identifier and is flagged as an identifier, so every record is keyed on identifiable data.`,
        ),
      );
    }
    if (first.branching !== "") {
      findings.push(
        error(
          "record-id-branching",
          spec.instruments[0]?.name ?? "",
          first.name,
          `"${first.name}" is the record identifier and cannot be hidden by branching logic.`,
        ),
      );
    }
  }

  return findings;
}

export function errorsOf(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "error");
}

export function warningsOf(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "warning");
}
