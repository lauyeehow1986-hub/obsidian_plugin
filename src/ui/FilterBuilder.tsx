import {
  LIST_OPERATORS,
  NULLARY_OPERATORS,
  condition,
  operatorsFor,
  type Condition,
  type FieldDef,
  type FilterGroup,
  type FilterNode,
  type Operator,
} from "../domain/query/model";

/**
 * The filter UI (§7 A2).
 *
 * **Two levels, on purpose.** The model supports an arbitrary tree, but a
 * general tree editor is a lot of interface for a case that almost never
 * arrives. Two levels — a top-level all/any, with nested any/all groups one
 * deep — expresses everything real: *blocked, and either breaching or sitting
 * more than a fortnight*. A hand-edited saved view may nest deeper and still
 * evaluates correctly; this editor simply will not build one, and says so
 * rather than silently flattening it.
 *
 * Operators are offered per field kind, so a date never gets "contains".
 */

const OPERATOR_LABELS: Record<Operator, string> = {
  is: "is",
  "is-not": "is not",
  contains: "contains",
  "not-contains": "does not contain",
  "starts-with": "starts with",
  gt: "is after / more than",
  gte: "is at least",
  lt: "is before / less than",
  lte: "is at most",
  between: "is between",
  "one-of": "is one of",
  "none-of": "is none of",
  has: "includes",
  "not-has": "does not include",
  empty: "is empty",
  "not-empty": "is not empty",
  "is-true": "is yes",
  "is-false": "is no",
};

/** A hint under the value box, because `-14d` is not guessable. */
function valueHint(field: FieldDef): string {
  if (field.kind === "date") return "A date, or today, -14d, +2w";
  if (field.kind === "duration") return "14d, 36h, 2w";
  if (LIST_OPERATORS.length > 0 && field.options) return `One of: ${field.options.join(", ")}`;
  return "";
}

function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

function textToValue(text: string, op: Operator): unknown {
  if (!LIST_OPERATORS.includes(op)) return text;
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function ConditionRow({
  clause,
  fields,
  onChange,
  onRemove,
}: {
  clause: Condition;
  fields: readonly FieldDef[];
  onChange: (next: Condition) => void;
  onRemove: () => void;
}) {
  const field = fields.find((entry) => entry.id === clause.field);
  const available = field ? operatorsFor(field.kind) : [];
  const takesValue = !NULLARY_OPERATORS.includes(clause.op);

  return (
    <div class="scdb-filter__row">
      <select
        aria-label="Field"
        value={clause.field}
        onChange={(event) => {
          const id = (event.currentTarget as HTMLSelectElement).value;
          const next = fields.find((entry) => entry.id === id);
          const ops = next ? operatorsFor(next.kind) : [];
          // Keep the operator when the new field still supports it, so changing
          // your mind about the field does not silently reset the comparison.
          const op = ops.includes(clause.op) ? clause.op : (ops[0] ?? "is");
          onChange(condition(id, op, takesValue ? clause.value : undefined));
        }}
      >
        {fields.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
            {entry.computed ? " ƒ" : ""}
          </option>
        ))}
      </select>

      <select
        aria-label="Comparison"
        value={clause.op}
        onChange={(event) => {
          const op = (event.currentTarget as HTMLSelectElement).value as Operator;
          onChange(
            NULLARY_OPERATORS.includes(op)
              ? condition(clause.field, op)
              : condition(clause.field, op, clause.value ?? ""),
          );
        }}
      >
        {available.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>

      {takesValue &&
        (field?.options ? (
          <select
            aria-label="Value"
            value={valueToText(clause.value)}
            onChange={(event) =>
              onChange(
                condition(
                  clause.field,
                  clause.op,
                  textToValue((event.currentTarget as HTMLSelectElement).value, clause.op),
                ),
              )
            }
          >
            <option value="">—</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            aria-label="Value"
            placeholder={valueHint(field ?? { id: "", label: "", kind: "text" })}
            value={valueToText(clause.value)}
            onInput={(event) =>
              onChange(
                condition(
                  clause.field,
                  clause.op,
                  textToValue((event.currentTarget as HTMLInputElement).value, clause.op),
                ),
              )
            }
          />
        ))}

      <button type="button" class="scdb-link" onClick={onRemove} aria-label="Remove this filter">
        remove
      </button>
    </div>
  );
}

export interface FilterBuilderProps {
  group: FilterGroup;
  fields: readonly FieldDef[];
  onChange: (next: FilterGroup) => void;
}

export function FilterBuilder({ group, fields, onChange }: FilterBuilderProps) {
  const first = fields[0];
  const newCondition = (): Condition =>
    condition(first?.id ?? "", first ? (operatorsFor(first.kind)[0] ?? "is") : "is", "");

  const replace = (index: number, node: FilterNode | null): void => {
    const clauses = [...group.clauses];
    if (node === null) clauses.splice(index, 1);
    else clauses[index] = node;
    onChange({ ...group, clauses });
  };

  const tooDeep = group.clauses.some(
    (clause) => clause.kind === "group" && clause.clauses.some((inner) => inner.kind === "group"),
  );

  return (
    <div class="scdb-filter">
      <div class="scdb-filter__head">
        <label class="scdb-toggle">
          Match
          <select
            aria-label="Combine filters"
            value={group.combine}
            onChange={(event) =>
              onChange({
                ...group,
                combine: (event.currentTarget as HTMLSelectElement).value === "or" ? "or" : "and",
              })
            }
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          of these
        </label>
      </div>

      {group.clauses.length === 0 && (
        <p class="scdb-muted">No filters — every note of the chosen types is shown.</p>
      )}

      {group.clauses.map((clause, index) =>
        clause.kind === "condition" ? (
          <ConditionRow
            key={index}
            clause={clause}
            fields={fields}
            onChange={(next) => replace(index, next)}
            onRemove={() => replace(index, null)}
          />
        ) : (
          <fieldset key={index} class="scdb-filter__nested">
            <legend>
              <select
                aria-label="Combine nested filters"
                value={clause.combine}
                onChange={(event) =>
                  replace(index, {
                    ...clause,
                    combine: (event.currentTarget as HTMLSelectElement).value === "or" ? "or" : "and",
                  })
                }
              >
                <option value="or">any of</option>
                <option value="and">all of</option>
              </select>
              <label class="scdb-toggle">
                <input
                  type="checkbox"
                  checked={clause.negate}
                  onChange={(event) =>
                    replace(index, {
                      ...clause,
                      negate: (event.currentTarget as HTMLInputElement).checked,
                    })
                  }
                />
                not
              </label>
              <button type="button" class="scdb-link" onClick={() => replace(index, null)}>
                remove group
              </button>
            </legend>

            {clause.clauses.map((inner, innerIndex) =>
              inner.kind === "condition" ? (
                <ConditionRow
                  key={innerIndex}
                  clause={inner}
                  fields={fields}
                  onChange={(next) => {
                    const clauses = [...clause.clauses];
                    clauses[innerIndex] = next;
                    replace(index, { ...clause, clauses });
                  }}
                  onRemove={() => {
                    const clauses = clause.clauses.filter((_, at) => at !== innerIndex);
                    replace(index, { ...clause, clauses });
                  }}
                />
              ) : (
                <p key={innerIndex} class="scdb-muted">
                  A nested group written by hand. It still runs; edit the note to change it.
                </p>
              ),
            )}

            <button
              type="button"
              class="scdb-link"
              onClick={() =>
                replace(index, { ...clause, clauses: [...clause.clauses, newCondition()] })
              }
            >
              + filter
            </button>
          </fieldset>
        ),
      )}

      {tooDeep && (
        <p class="scdb-muted">
          This filter nests deeper than the builder edits. It runs exactly as written; change it in
          the saved-view note.
        </p>
      )}

      <div class="scdb-filter__actions">
        <button
          type="button"
          class="scdb-link"
          onClick={() => onChange({ ...group, clauses: [...group.clauses, newCondition()] })}
        >
          + filter
        </button>
        <button
          type="button"
          class="scdb-link"
          onClick={() =>
            onChange({
              ...group,
              clauses: [
                ...group.clauses,
                { kind: "group", combine: "or", negate: false, clauses: [newCondition()] },
              ],
            })
          }
        >
          + any-of group
        </button>
      </div>
    </div>
  );
}
