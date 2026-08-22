import type { QueryResult } from "../domain/query/evaluate";
import { formatAggregate, formatCell } from "../domain/query/format";
import type { FieldDef, Row } from "../domain/query/model";

/**
 * A query result as a table (§7 A2), grouped, with per-group and overall totals.
 *
 * Presentational only — every number arrives already computed. Numeric and
 * duration columns are right-aligned with tabular figures (§6), and a row is a
 * button because clicking it opens the note, not because it is a control.
 */

function alignment(field: FieldDef): string {
  return field.kind === "number" || field.kind === "duration" ? "scdb-num" : "";
}

/**
 * `data-label` carries the column name into the cell.
 *
 * At sidebar width the table stacks and the header row is hidden (§6), which
 * would otherwise leave a column of bare durations with nothing saying which is
 * dwell and which is age. The stylesheet renders this attribute as a prefix
 * only in that layout.
 */
function Cell({ row, field, now }: { row: Row; field: FieldDef; now: number }) {
  const text = formatCell(row.fields[field.id], field.kind, now);
  return (
    <td class={alignment(field)} data-label={field.label}>
      {text === "" ? <span class="scdb-muted">—</span> : text}
    </td>
  );
}

export interface ResultTableProps {
  result: QueryResult;
  now: number;
  onOpen: (key: string) => void;
}

export function ResultTable({ result, now, onOpen }: ResultTableProps) {
  if (result.columns.length === 0) {
    return <p class="scdb-empty">No columns selected. Pick at least one field to show.</p>;
  }
  if (result.returned === 0) {
    return (
      <p class="scdb-empty">
        Nothing matches. Loosen a filter, or check that the note type you picked is present in the
        vault.
      </p>
    );
  }

  const grouped = !(result.groups.length === 1 && result.groups[0]?.key === "");

  return (
    <div class="scdb-result">
      {result.groups.map((group) => (
        <section key={group.key} class="scdb-result__group">
          {grouped && (
            <h4 class="scdb-result__heading">
              {group.label}
              <span class="scdb-column__count">{group.rows.length}</span>
            </h4>
          )}
          <table class="scdb-table">
            <thead>
              <tr>
                {result.columns.map((field) => (
                  <th key={field.id} class={alignment(field)} title={field.computed ? "Computed" : ""}>
                    {field.label}
                    {field.computed && <span class="scdb-result__computed"> ƒ</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.key}>
                  {result.columns.map((field, position) =>
                    position === 0 ? (
                      <td key={field.id} class={alignment(field)} data-label={field.label}>
                        <button type="button" class="scdb-link" onClick={() => onOpen(row.key)}>
                          {formatCell(row.fields[field.id], field.kind, now) || row.key}
                        </button>
                      </td>
                    ) : (
                      <Cell key={field.id} row={row} field={field} now={now} />
                    ),
                  )}
                </tr>
              ))}
            </tbody>
            {group.aggregates.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={result.columns.length}>
                    {group.aggregates.map((aggregate) => (
                      <span key={aggregate.label} class="scdb-result__total">
                        {aggregate.label}: <span class="scdb-num">{formatAggregate(aggregate)}</span>
                      </span>
                    ))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </section>
      ))}

      <p class="scdb-result__footer">
        {result.truncated
          ? `Showing ${result.returned} of ${result.matched} matching notes.`
          : `${result.matched} matching note${result.matched === 1 ? "" : "s"}.`}
        {result.totals.length > 0 && grouped && (
          <span>
            {" · "}
            {result.totals.map((aggregate) => (
              <span key={aggregate.label} class="scdb-result__total">
                {aggregate.label}: <span class="scdb-num">{formatAggregate(aggregate)}</span>
              </span>
            ))}
          </span>
        )}
      </p>
    </div>
  );
}
