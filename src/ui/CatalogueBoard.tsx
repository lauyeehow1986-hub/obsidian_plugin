import { useMemo, useState } from "preact/hooks";
import { searchCatalogue, type CatalogueRow } from "../domain/catalogue/register";
import { lineage } from "../domain/catalogue/lineage";
import { dataTypeLabel, variableLabel } from "../domain/catalogue/variable";
import { toVaultDate } from "../domain/time/dates";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

/**
 * The variable catalogue (§5.8, §7 C2).
 *
 * Browse and search, with each row opening onto the two things the catalogue
 * exists to answer: what the variable has meant over time, and what in the
 * vault rests on it. Presentational only — every number comes from
 * `domain/catalogue`.
 */

function Range({ range }: { range: [number, number] | null }) {
  if (range === null) return <>—</>;
  return (
    <>
      {range[0]} to {range[1]}
    </>
  );
}

function Lineage({ row }: { row: CatalogueRow }) {
  const rows = lineage(row.variable);
  return (
    <table class="scdb-table">
      <thead>
        <tr>
          <th scope="col">Version</th>
          <th scope="col">In force</th>
          <th scope="col">What moved</th>
          <th scope="col">Why</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <tr key={entry.version}>
            <td class="scdb-num">
              {entry.version}
              {entry.live && <span class="scdb-chip">current</span>}
            </td>
            <td class="scdb-muted">
              {entry.from === null ? "undated" : toVaultDate(entry.from)}
              {entry.until === null ? "" : ` – ${toVaultDate(entry.until)}`}
            </td>
            <td class="scdb-muted">{entry.changed.join(", ") || "—"}</td>
            <td>{entry.reason || <span class="scdb-muted">not recorded</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Dependants({ row, plugin }: { row: CatalogueRow; plugin: ScdbCockpitPlugin }) {
  const { dependants } = row;
  if (dependants.total === 0) {
    return (
      <p class="scdb-empty">
        Nothing in the vault cites this variable. Either it is new, or the notes that use it do
        not say so — add <code>variables:</code> to the run record, script doc or request that
        consumes it, and it will appear here.
      </p>
    );
  }
  return (
    <>
      {dependants.groups.map((group) => (
        <section key={group.kind} class="scdb-group">
          <h4 class="scdb-group__title">
            {group.label}
            <span class="scdb-group__sub">{count(group.rows.length, "note")}</span>
          </h4>
          <ul class="scdb-list">
            {group.rows.map((entry) => (
              <li key={`${entry.citation.path}${entry.citation.ref}`}>
                <button
                  type="button"
                  class="scdb-linkish"
                  onClick={() => plugin.openNote(entry.citation.path)}
                >
                  {entry.citation.id || entry.citation.path}
                </button>
                <span class="scdb-muted"> · {entry.citation.field} </span>
                {entry.version !== null && (
                  <span class={entry.stale ? "scdb-chip scdb-chip--problem" : "scdb-chip"}>
                    {entry.stale
                      ? `cites v${entry.version}, now v${row.variable.version}`
                      : `v${entry.version}`}
                  </span>
                )}
                {entry.version === null && (
                  <span
                    class="scdb-muted"
                    title="No version named, so which definition it meant is not recorded."
                  >
                    {" "}
                    unversioned
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function VariableCard({ row, plugin }: { row: CatalogueRow; plugin: ScdbCockpitPlugin }) {
  const [open, setOpen] = useState(false);
  const { variable } = row;

  return (
    <li class="scdb-card scdb-card--stacked">
      <div class="scdb-card__row">
        <button
          type="button"
          class="scdb-card__main"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${variableLabel(variable)}`}
        >
          <span class="scdb-card__id">
            {variable.id || "(no id)"} · v{variable.version || "?"}
          </span>
          <span class="scdb-card__title">{variable.label || "(unlabelled)"}</span>
          <span class="scdb-card__meta">
            <span class="scdb-chip">{dataTypeLabel(variable.dataType)}</span>
            {variable.units !== "" && <span class="scdb-muted scdb-num">{variable.units}</span>}
            {variable.identifier && (
              <span
                class={
                  variable.justification === ""
                    ? "scdb-chip scdb-chip--problem"
                    : "scdb-chip scdb-chip--blocked"
                }
                title={
                  variable.justification === ""
                    ? "Identifier with nothing recording why it is held."
                    : variable.justification
                }
              >
                ⚑ identifier
              </span>
            )}
            <span class="scdb-muted scdb-num">
              {count(row.dependants.total, "dependant")}
              {row.dependants.stale > 0 && ` (${row.dependants.stale} on an old version)`}
            </span>
            {row.problems.length > 0 && (
              <span class="scdb-chip scdb-chip--problem" title={row.problems.join("\n\n")}>
                needs attention
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          class="scdb-card__action"
          title="Supersede the current definition, keeping what it used to say"
          onClick={() => plugin.reviseVariable(variable)}
        >
          Revise
        </button>
        <button
          type="button"
          class="scdb-card__action"
          title="Which definition was in force on a given date"
          onClick={() => plugin.askInForce(variable)}
        >
          On a date…
        </button>
      </div>

      {open && (
        <div class="scdb-card__detail">
          <p>{variable.definition || <span class="scdb-muted">No definition recorded.</span>}</p>
          <dl class="scdb-deflist">
            <div>
              <dt>Valid range</dt>
              <dd>
                <Range range={variable.validRange} />
              </dd>
            </div>
            {variable.coding.length > 0 && (
              <div>
                <dt>Coding</dt>
                <dd>
                  {variable.coding.map((code) => `${code.code} = ${code.label}`).join(" · ")}
                </dd>
              </div>
            )}
            {variable.collectedIn.length > 0 && (
              <div>
                <dt>Collected in</dt>
                <dd>{variable.collectedIn.join(", ")}</dd>
              </div>
            )}
            {variable.identifier && (
              <div>
                <dt>Held because</dt>
                <dd>
                  {variable.justification || (
                    <span class="scdb-muted">nothing recorded — see the problems below</span>
                  )}
                </dd>
              </div>
            )}
          </dl>

          {row.problems.length > 0 && (
            <ul class="scdb-list scdb-list--problems">
              {row.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          <h4 class="scdb-modal__heading">What it has meant</h4>
          <Lineage row={row} />

          <h4 class="scdb-modal__heading">What rests on it</h4>
          <Dependants row={row} plugin={plugin} />

          <p>
            <button type="button" class="scdb-linkish" onClick={() => plugin.openNote(variable.path)}>
              Open the note
            </button>
          </p>
        </div>
      )}
    </li>
  );
}

export function CatalogueBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [query, setQuery] = useState("");
  const catalogue = plugin.catalogue();
  const rows = useMemo(() => searchCatalogue(catalogue.rows, query), [catalogue, query]);

  if (catalogue.rows.length === 0) {
    return (
      <div class="scdb-stack">
        <p class="scdb-empty">
          The catalogue is empty. A variable note carries <code>type: variable</code>, an{" "}
          <code>id</code>, a <code>definition</code> and <code>version: 1</code> — and from then
          on every request, form, script and run that names it in <code>variables:</code> shows up
          here. Start with the variables you already argue about.
        </p>
        <p>
          <button type="button" class="mod-cta" onClick={() => void plugin.newVariable()}>
            New variable
          </button>
        </p>
      </div>
    );
  }

  const { summary } = catalogue;
  const groups = catalogue.groups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => rows.includes(row)) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div class="scdb-stack">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Variable catalogue
          <span class="scdb-group__sub">
            {count(summary.total, "variable")}, {count(summary.identifiers, "identifier")}
          </span>
        </h3>

        <div class="scdb-toolbar">
          <input
            type="search"
            class="scdb-catalogue__search"
            placeholder="Search id, label, units, definition, codes…"
            value={query}
            aria-label="Search the catalogue"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          />
          <button type="button" class="scdb-control" onClick={() => void plugin.newVariable()}>
            New variable
          </button>
        </div>

        {(summary.unjustified > 0 || summary.stale > 0 || summary.orphans > 0 || summary.uncited > 0) && (
          <ul class="scdb-list scdb-list--problems">
            {summary.unjustified > 0 && (
              <li>
                {count(summary.unjustified, "identifier")} held with no recorded justification —
                the check a REDCap form export has to make anyway.
              </li>
            )}
            {summary.stale > 0 && (
              <li>
                {count(summary.stale, "citation")} naming a version the catalogue has moved past.
              </li>
            )}
            {summary.orphans > 0 && (
              <li>
                {count(summary.orphans, "citation")} naming a variable the catalogue does not
                hold — a typo, or something uncatalogued.
              </li>
            )}
            {summary.uncited > 0 && (
              <li>
                {count(summary.uncited, "variable")} that nothing in the vault cites.
              </li>
            )}
          </ul>
        )}

        {groups.length === 0 ? (
          <p class="scdb-empty">Nothing matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <section key={group.domain} class="scdb-group">
              <h3 class="scdb-group__title">
                {group.label}
                <span class="scdb-group__sub">{count(group.rows.length, "variable")}</span>
              </h3>
              <ul class="scdb-cards">
                {group.rows.map((row) => (
                  <VariableCard key={row.variable.path} row={row} plugin={plugin} />
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
