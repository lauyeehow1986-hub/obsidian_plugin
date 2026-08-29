/**
 * Branching logic and calculations, checked against the fields they name
 * (§7 D2, "branching-logic syntax checked against referenced fields").
 *
 * This is deliberately **not** an evaluator. REDCap's expression language has
 * functions, smart variables, event prefixes and instance syntax, and a
 * half-implemented evaluator that silently disagrees with the real one is
 * worse than no evaluator: it would tell you a form behaves in a way it does
 * not. What is checkable without an instance, and what actually goes wrong in
 * practice, is narrower and worth doing properly:
 *
 *  - the brackets, parentheses and quotes balance;
 *  - every `[field]` it names exists in this form;
 *  - a checkbox is referenced as `[field(code)]` and a non-checkbox is not;
 *  - the code inside `[field(code)]` is one the checkbox actually offers;
 *  - it does not depend on itself.
 *
 * The last two are the ones that reach REDCap and behave wrongly rather than
 * failing: a branching condition naming a choice code that was renamed simply
 * never fires, so the field never shows, and nobody finds out until the data
 * comes back empty.
 *
 * **A reference to a field on another instrument is not an error.** Branching
 * across instruments in the same project is ordinary REDCap. It is reported as
 * *external* so the caller can say the dictionary is only part of the picture,
 * because a single-instrument export will not carry the field being tested.
 *
 * Pure module: no Obsidian, no Node.
 */

/** One `[field]` or `[field(code)]` reference, and where it sat. */
export interface LogicRef {
  field: string;
  /** The checkbox code inside the brackets, or "" when there was none. */
  code: string;
  /** An event or instrument prefix REDCap allows, kept so it can be reported. */
  prefix: string;
  raw: string;
}

/**
 * REDCap smart variables. Bracketed like fields but never declared as one, so
 * they must not be reported as unknown. Only the common ones; an unrecognised
 * `[something]` that starts with one of these prefixes is left alone too,
 * because the list grows with every REDCap release and a false "unknown field"
 * on a working form is the more annoying error.
 */
const SMART_VARIABLE_PREFIXES = [
  "record-",
  "user-",
  "event-",
  "instrument-",
  "survey-",
  "form-",
  "arm-",
  "redcap-",
  "is-",
  "language",
  "new-instance",
  "previous-instance",
  "first-instance",
  "last-instance",
  "current-instance",
  "instance",
  "today",
  "now",
];

export function isSmartVariable(name: string): boolean {
  const lower = name.toLowerCase();
  return SMART_VARIABLE_PREFIXES.some((prefix) =>
    prefix.endsWith("-") ? lower.startsWith(prefix) : lower === prefix,
  );
}

/**
 * Pull every bracketed reference out of an expression.
 *
 * `[event][field(2)]` is one reference to `field` with a prefix and a code.
 * Adjacent bracket groups belong together in REDCap's syntax, so they are
 * folded rather than counted twice.
 */
export function parseRefs(expression: string): LogicRef[] {
  const refs: LogicRef[] = [];
  const pattern = /\[([A-Za-z0-9_-]+)(?:\(([^)]*)\))?\]/g;

  let pending = "";
  let lastEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(expression)) !== null) {
    const name = match[1] ?? "";
    const code = match[2] ?? "";
    const adjacent = match.index === lastEnd;
    lastEnd = match.index + match[0].length;

    // `[arm][event][field]`: everything before the last group is a prefix.
    if (adjacent && pending !== "") {
      refs.pop();
      refs.push({ field: name, code, prefix: pending, raw: `[${pending}][${name}]` });
      pending = `${pending}][${name}`;
      continue;
    }

    refs.push({ field: name, code, prefix: "", raw: match[0] });
    pending = name;
  }

  return refs;
}

export interface BalanceProblem {
  message: string;
}

/**
 * Check that brackets, parentheses and quotes close.
 *
 * The overwhelmingly common real failure — a missing `]` after a rename, or an
 * apostrophe inside a double-quoted label that was typed as the closing quote.
 * REDCap accepts both `"` and `'`, and only the outermost matters.
 */
export function checkBalance(expression: string): string[] {
  const problems: string[] = [];
  let square = 0;
  let round = 0;
  let quote = "";

  for (const ch of expression) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "(") round++;
    else if (ch === ")") round--;
    if (square < 0) {
      problems.push("There is a `]` with no `[` before it.");
      square = 0;
    }
    if (round < 0) {
      problems.push("There is a `)` with no `(` before it.");
      round = 0;
    }
  }

  if (quote !== "") problems.push(`A quote (${quote}) was opened and never closed.`);
  if (square > 0) problems.push(`${square} `.concat(square === 1 ? "`[` was" : "`[`s were", " never closed."));
  if (round > 0) problems.push(`${round} `.concat(round === 1 ? "`(` was" : "`(`s were", " never closed."));

  return problems;
}

/** What a field's expression can be checked against. */
export interface LogicContext {
  /** Field name → the codes it offers, for checkbox reference checking. */
  choices: ReadonlyMap<string, readonly string[]>;
  /** Field names that are checkboxes. */
  checkboxes: ReadonlySet<string>;
  /** Every field name in this form, across all instruments. */
  known: ReadonlySet<string>;
}

export interface LogicCheck {
  problems: string[];
  /** Fields named that this form does not declare, and are not smart variables. */
  unknown: string[];
  refs: LogicRef[];
}

/**
 * Check one expression belonging to `owner`.
 *
 * `owner` is the field the logic sits on, so self-reference can be reported.
 * `kind` names the expression in the message — "branching logic" or
 * "calculation" — because the two fail for the same reasons and the reader
 * needs to know which one they are looking at.
 */
export function checkLogic(
  expression: string,
  owner: string,
  kind: string,
  context: LogicContext,
): LogicCheck {
  const trimmed = expression.trim();
  if (trimmed === "") return { problems: [], unknown: [], refs: [] };

  const problems = checkBalance(trimmed).map((problem) => `${kind}: ${problem}`);
  const refs = parseRefs(trimmed);
  const unknown: string[] = [];

  if (refs.length === 0 && problems.length === 0) {
    problems.push(`${kind} names no field, so it can never depend on an answer.`);
  }

  for (const ref of refs) {
    const name = ref.field.toLowerCase();
    if (isSmartVariable(name)) continue;

    if (name === owner && owner !== "") {
      problems.push(`${kind} depends on this field itself.`);
      continue;
    }

    if (!context.known.has(name)) {
      // Could be a field on another instrument in the same project, which is
      // legitimate. Reported as unknown-to-this-form, not as an error, and the
      // caller decides how loudly to say it.
      unknown.push(ref.field);
      continue;
    }

    const isCheckbox = context.checkboxes.has(name);
    if (ref.code !== "") {
      if (!isCheckbox) {
        problems.push(
          `${kind} tests \`[${ref.field}(${ref.code})]\`, but ${ref.field} is not a checkbox — only checkboxes are referenced that way.`,
        );
        continue;
      }
      const codes = context.choices.get(name) ?? [];
      if (!codes.includes(ref.code)) {
        problems.push(
          `${kind} tests \`[${ref.field}(${ref.code})]\`, but ${ref.field} offers no choice coded ${ref.code}.`,
        );
      }
    } else if (isCheckbox) {
      problems.push(
        `${kind} tests \`[${ref.field}]\`, but ${ref.field} is a checkbox — it has to be tested one choice at a time, as \`[${ref.field}(code)]\`.`,
      );
    }
  }

  return { problems, unknown, refs };
}
