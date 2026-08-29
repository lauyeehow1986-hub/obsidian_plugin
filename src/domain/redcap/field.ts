/**
 * The REDCap field model (§5.14 `type: redcap-form`, §7 D2).
 *
 * This mirrors one row of a REDCap **data dictionary**, which is the format
 * D2 ships first: it is stable across REDCap versions, and it is testable
 * without access to anyone's instance. The project XML that creates a whole
 * project carries version-specific extensions and is deliberately not modelled
 * here — §11 blocks it until a real exported project XML exists to build
 * against, and a guessed schema is a file REDCap rejects at the last step.
 *
 * Two places the vault holds more than the dictionary can:
 *
 *  - **`variable`** — the catalogue id this field collects (§5.8). REDCap has
 *    no column for it, so it never reaches the CSV. It is how a form joins the
 *    catalogue: the variable says whether the thing being collected is an
 *    identifier and why it is held, and D2's governance hook reads it.
 *  - **`justification`** — why an identifier is collected, when the field does
 *    not cite a catalogue variable that already says. The dictionary's
 *    `identifier` column is a bare `y`, and a bare `y` is exactly the sort of
 *    unevidenced claim §5.5 exists to refuse.
 *
 * Both survive a round trip because the form note is the source of truth and
 * the CSV is an export of part of it. An *import* of a dictionary that never
 * had them leaves them empty, which is a finding, not a default.
 *
 * Pure module: no Obsidian, no Node.
 */

export const REDCAP_FORM_TYPE = "redcap-form";

/**
 * REDCap field types, as the dictionary spells them.
 *
 * Closed, because every one of them changes what else the row must contain —
 * a `radio` without choices is broken, a `text` with choices is confused, a
 * `calc` without a calculation produces nothing. `validate.ts` is where those
 * consequences live; this list is only the vocabulary.
 */
export const FIELD_TYPES = [
  "text",
  "notes",
  "dropdown",
  "radio",
  "checkbox",
  "yesno",
  "truefalse",
  "file",
  "calc",
  "sql",
  "descriptive",
  "slider",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text box",
  notes: "Notes box",
  dropdown: "Dropdown",
  radio: "Radio buttons",
  checkbox: "Checkboxes",
  yesno: "Yes / No",
  truefalse: "True / False",
  file: "File upload",
  calc: "Calculated",
  sql: "SQL query",
  descriptive: "Descriptive text",
  slider: "Slider",
};

/** Field types whose answers come from a choice list. */
export const CHOICE_TYPES: readonly FieldType[] = ["dropdown", "radio", "checkbox"];

/** Field types REDCap will not accept a text-validation type on. */
export const VALIDATABLE_TYPES: readonly FieldType[] = ["text", "notes"];

/**
 * Text validation types.
 *
 * The set REDCap ships by default. An instance can add more, so an unknown one
 * is reported as unrecognised rather than refused outright — but the common
 * cause is a typo (`date_dmy` written `date-dmy`), and saying so beats
 * exporting a dictionary the instance rejects on upload.
 */
export const VALIDATION_TYPES = [
  "",
  "date_ymd",
  "date_mdy",
  "date_dmy",
  "datetime_ymd",
  "datetime_mdy",
  "datetime_dmy",
  "datetime_seconds_ymd",
  "datetime_seconds_mdy",
  "datetime_seconds_dmy",
  "time",
  "time_mm_ss",
  "email",
  "integer",
  "number",
  "number_1dp",
  "number_2dp",
  "number_3dp",
  "number_4dp",
  "phone",
  "postalcode_australia",
  "zipcode",
  "alpha_only",
] as const;
export type ValidationType = (typeof VALIDATION_TYPES)[number];

/** Validation types whose min/max are dates rather than numbers. */
export function isDateValidation(type: string): boolean {
  return type.startsWith("date_") || type.startsWith("datetime");
}

export function isNumericValidation(type: string): boolean {
  return type === "integer" || type === "number" || /^number_\d+dp$/.test(type);
}

/**
 * Field names REDCap reserves.
 *
 * Using one produces an instrument that uploads and then behaves strangely, or
 * fails at import with a message naming a row number rather than a field. The
 * `_complete` suffix is reserved too: REDCap generates `<form>_complete` for
 * every instrument, so a field of that name collides with a column that will
 * exist whether you declare it or not.
 */
export const RESERVED_FIELD_NAMES: readonly string[] = [
  "redcap_event_name",
  "redcap_repeat_instrument",
  "redcap_repeat_instance",
  "redcap_data_access_group",
  "redcap_survey_identifier",
  "redcap_survey_timestamp",
  "redcap_csrf_token",
];

/** REDCap truncates beyond this, and a truncated name can collide with another. */
export const MAX_FIELD_NAME_LENGTH = 26;

/** The shape REDCap accepts: lowercase, starts with a letter, no spaces. */
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** One code and the label shown for it. Same shape as a catalogue `coding`. */
export interface Choice {
  code: string;
  label: string;
}

export interface RedcapField {
  name: string;
  /** The instrument this field belongs to. Set by the form, not the field. */
  form: string;
  /** Section header printed above the field. Free text, optional. */
  section: string;
  type: FieldType;
  label: string;
  choices: Choice[];
  note: string;
  validation: string;
  validationMin: string;
  validationMax: string;
  identifier: boolean;
  branching: string;
  required: boolean;
  /** left | right | vertical (radio and checkbox layout). Carried, not checked. */
  alignment: string;
  /** For `calc`. */
  calculation: string;
  /** Beyond the dictionary: the catalogue variable this collects (§5.8). */
  variable: string;
  /** Beyond the dictionary: why an identifier is held, when no variable says. */
  justification: string;
  /**
   * Dictionary columns we carry but do not check: survey question number,
   * matrix grouping, and REDCap's field annotation (`@HIDDEN`, `@CALCTEXT`
   * and friends). Modelling them properly is survey and action-tag territory,
   * which D2 does not claim to cover — but dropping them would mean importing
   * an existing instrument silently deletes them, and §7 D2 exists so an
   * instrument can be *edited* rather than rebuilt.
   */
  questionNumber: string;
  matrixGroup: string;
  matrixRanking: string;
  annotation: string;
  /** What could not be read off this field's entry. */
  problems: string[];
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // An unquoted `min: 2026-01-01` in the form block arrives as a Date: YAML's
  // default schema resolves a bare date scalar, and a person writing the block
  // by hand will not quote it. Returning "" there would silently drop a
  // validation bound — the field would look unbounded on the board and export
  // with an empty column. Formatted in UTC deliberately: YAML resolves a
  // date-only scalar to UTC midnight, so reading it back in local time would
  // shift it a day west of Greenwich.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  return "";
}

/**
 * Read a truthy flag written any of the ways a human writes one.
 *
 * The dictionary uses `y` and blank; a person editing YAML writes `true`; a
 * spreadsheet may have turned it into `TRUE` or `1`. Anything else is not
 * silently false — it is returned as `null` so the caller can say the field
 * does not answer the question, which for `identifier` is the difference
 * between "not an identifier" and "nobody said".
 */
export function readFlag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const text = str(value).toLowerCase();
  if (text === "") return null;
  if (["y", "yes", "true", "1"].includes(text)) return true;
  if (["n", "no", "false", "0"].includes(text)) return false;
  return null;
}

/**
 * Parse a REDCap choice list: `1, Label | 2, Other label`.
 *
 * The separator is the *first* comma only, because labels contain commas —
 * "Yes, with complications" is an ordinary label and splitting on every comma
 * would quietly turn it into a third choice. A pipe inside a label cannot be
 * represented in this format at all; that is REDCap's limitation, and
 * `validate.ts` reports it rather than this parser inventing an escape.
 */
export function parseChoices(raw: unknown): { choices: Choice[]; problems: string[] } {
  const problems: string[] = [];
  const choices: Choice[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry !== null && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const code = str(record.code ?? record.value);
        const label = str(record.label ?? record.name);
        if (code === "" && label === "") continue;
        choices.push({ code, label });
        continue;
      }
      const text = str(entry);
      if (text === "") continue;
      const split = splitChoice(text);
      if (split === null) problems.push(`Choice "${text}" has no code before a comma.`);
      else choices.push(split);
    }
    return { choices, problems };
  }

  const text = str(raw);
  if (text === "") return { choices, problems };
  for (const part of text.split("|")) {
    const piece = part.trim();
    if (piece === "") continue;
    const split = splitChoice(piece);
    if (split === null) problems.push(`Choice "${piece}" has no code before a comma.`);
    else choices.push(split);
  }
  return { choices, problems };
}

function splitChoice(text: string): Choice | null {
  const comma = text.indexOf(",");
  if (comma < 0) return null;
  return { code: text.slice(0, comma).trim(), label: text.slice(comma + 1).trim() };
}

/** Back to the dictionary's one-line form. */
export function formatChoices(choices: readonly Choice[]): string {
  return choices.map((choice) => `${choice.code}, ${choice.label}`).join(" | ");
}

/** Parse one field from a plain object, as the form's YAML block holds it. */
export function parseField(raw: unknown, form: string): RedcapField {
  const record = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];

  const name = str(record.name ?? record.field_name).toLowerCase();
  if (name === "") problems.push("This field has no name.");

  const typeRaw = str(record.type ?? record.field_type).toLowerCase();
  let type: FieldType = "text";
  if (typeRaw === "") {
    problems.push("No field type, so it was read as a text box.");
  } else if (isFieldType(typeRaw)) {
    type = typeRaw;
  } else {
    problems.push(`Field type "${typeRaw}" is not one REDCap has; read as a text box.`);
  }

  // REDCap packs two different things into one dictionary column: a choice
  // list for the choice types, and the expression for `calc` and `sql`. Read
  // it as choices only when the type says it is choices, or a calculation
  // containing a comma parses into nonsense choices nobody wrote.
  const shared = record.select_choices_or_calculations;
  const expressionType = type === "calc" || type === "sql";
  const parsedChoices = expressionType
    ? { choices: [] as Choice[], problems: [] as string[] }
    : parseChoices(record.choices ?? shared);
  problems.push(...parsedChoices.problems);
  const calculation = str(record.calculation) || (expressionType ? str(shared) : "");

  const identifier = readFlag(record.identifier);
  const required = readFlag(record.required ?? record.required_field);

  return {
    name,
    form,
    section: str(record.section ?? record.section_header),
    type,
    label: str(record.label ?? record.field_label),
    choices: parsedChoices.choices,
    note: str(record.note ?? record.field_note),
    validation: str(record.validation ?? record.text_validation_type_or_show_slider_number),
    validationMin: str(record.min ?? record.text_validation_min),
    validationMax: str(record.max ?? record.text_validation_max),
    identifier: identifier === true,
    branching: str(record.branching ?? record.branching_logic),
    required: required === true,
    alignment: str(record.alignment ?? record.custom_alignment).toLowerCase(),
    calculation,
    variable: str(record.variable),
    justification: str(record.justification),
    questionNumber: str(record.question_number),
    matrixGroup: str(record.matrix_group_name),
    matrixRanking: str(record.matrix_ranking),
    annotation: str(record.annotation ?? record.field_annotation),
    problems,
  };
}
