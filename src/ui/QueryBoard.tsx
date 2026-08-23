import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { runQuery } from "../domain/query/evaluate";
import { toCsv, toMarkdownTable } from "../domain/query/format";
import type { ParsedText } from "../domain/query/language";
import {
  AGGREGATE_FNS,
  BUCKETS,
  andGroup,
  emptyQuery,
  validateQuery,
  type AggregateSpec,
  type Query,
} from "../domain/query/model";
import type ScdbCockpitPlugin from "../main.js";
import { FilterBuilder } from "./FilterBuilder";
import { LanguageSearch } from "./LanguageSearch";
import { ResultTable } from "./ResultTable";

/**
 * The Explore board (§7 A2): pick types, filter, sort, group, aggregate, export.
 *
 * The query lives in component state and is evaluated on every render. That is
 * deliberate rather than lazy — dwell times are computed from `now`, so a
 * cached result is a result that is quietly wrong by tomorrow (§5.1). Re-running
 * a few thousand rows costs less than a repaint.
 *
 * The English box (§7 B4) sits on top and *rebuilds* the panels below rather
 * than filtering alongside them, so what runs is always what the panels show.
 * Emptying the box puts the board back as it was, so that rebuild is a
 * detour rather than a commitment.
 */

const REQUEST_TYPE = "scdb-request";

const NOTHING_PARSED: ParsedText = { chips: [], ignored: [] };

function Panel({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <details class="scdb-panel">
      <summary>{title}</summary>
      <div class="scdb-panel__body">{children}</div>
    </details>
  );
}

export function QueryBoard({
  plugin,
  search,
}: {
  plugin: ScdbCockpitPlugin;
  /** A phrase a command arrived with. `token` changes on every request. */
  search?: { text: string; token: number };
}) {
  const [query, setQuery] = useState<Query>(() => ({
    ...emptyQuery([REQUEST_TYPE]),
    sort: [{ field: "dwell", direction: "desc" }],
  }));
  const [savedPath, setSavedPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedText>(NOTHING_PARSED);
  /** The board as it stood before the box was typed into. See `applySearch`. */
  const [before, setBefore] = useState<{ query: Query; savedPath: string } | null>(null);

  const applySearch = (next: string): void => {
    setText(next);
    const searching = next.trim() !== "";

    // Typing rebuilds the panels, so a filter built by hand would otherwise be
    // destroyed by one keystroke with no way back. Keep the board as it was and
    // restore it when the box is emptied, which makes searching something you
    // can back out of rather than something you commit to.
    const board = before?.query ?? query;
    if (!searching) {
      setParsed(NOTHING_PARSED);
      setQuery(board);
      // The view the search departed from comes back with it, so the picker
      // never names a view the board is no longer showing.
      setSavedPath(before?.savedPath ?? savedPath);
      setBefore(null);
      return;
    }
    if (before === null) setBefore({ query, savedPath });

    const result = plugin.searchInEnglish(next, {
      types: board.types,
      columns: board.columns,
      // Sort survives a search: the board opens sorted by dwell, and losing
      // that the moment someone types is a silent reordering of the answer.
      // A sort the sentence names wins over it (`chipsToQuery`).
      sort: board.sort,
    });
    setParsed(result.parsed);
    setQuery(result.query);
    // The query no longer matches the saved view it may have come from.
    setSavedPath("");
  };

  // A command can open this board with a phrase already typed. Keyed on the
  // token, not the text, so asking the same question twice still lands.
  useEffect(() => {
    if (search !== undefined) applySearch(search.text);
  }, [search?.token]);

  const now = Date.now();
  const types = plugin.notes.types();
  const catalogue = plugin.catalogueFor(query.types);
  const rows = plugin.rowsFor(query.types, now);
  const problems = validateQuery(query, catalogue);
  const result = runQuery(rows, query, catalogue, { now });

  const patch = (next: Partial<Query>): void => setQuery({ ...query, ...next });

  const toggleType = (type: string): void => {
    const has = query.types.includes(type);
    const next = has ? query.types.filter((entry) => entry !== type) : [...query.types, type];
    // Columns and filters are named per catalogue; changing the types can
    // orphan them. Drop columns that no longer exist rather than showing blanks.
    const nextCatalogue = plugin.catalogueFor(next).map((field) => field.id);
    patch({
      types: next,
      columns: query.columns.filter((column) => nextCatalogue.includes(column)),
    });
  };

  const exportAs = async (extension: "csv" | "md"): Promise<void> => {
    setBusy(true);
    try {
      const content =
        extension === "csv"
          ? toCsv(result, { now, rawDurations: true })
          : toMarkdownTable(result, { now });
      await plugin.exportDocument({
        basename: savedPath === "" ? "query" : "view",
        extension,
        content,
        subject: savedPath === "" ? "VIEW-ad-hoc" : savedPath,
        rows: result.returned,
      });
    } finally {
      setBusy(false);
    }
  };

  const saved = plugin.views.all();

  return (
    <div class="scdb-explore">
      <LanguageSearch text={text} parsed={parsed} onChange={applySearch} />

      <div class="scdb-explore__toolbar">
        <label class="scdb-toggle">
          Saved view
          <select
            value={savedPath}
            onChange={(event) => {
              const path = (event.currentTarget as HTMLSelectElement).value;
              setSavedPath(path);
              const stored = plugin.views.byPath(path);
              if (!stored) return;
              setQuery(stored.view.query);
              // The box no longer describes what is on screen, so it goes —
              // and with it the board it was searching over.
              setText("");
              setParsed(NOTHING_PARSED);
              setBefore(null);
            }}
          >
            <option value="">Ad hoc query</option>
            {saved.map((stored) => (
              <option key={stored.file.path} value={stored.file.path}>
                {stored.view.title}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          class="scdb-control"
          disabled={busy}
          onClick={() => void plugin.saveCurrentView(query, savedPath).then(setSavedPath)}
        >
          Save view
        </button>
        <button type="button" class="scdb-control" disabled={busy} onClick={() => void exportAs("csv")}>
          Export CSV
        </button>
        <button type="button" class="scdb-control" disabled={busy} onClick={() => void exportAs("md")}>
          Export markdown
        </button>
      </div>

      <Panel title={`Note types (${query.types.length === 0 ? "all" : query.types.join(", ")})`}>
        {types.length === 0 ? (
          <p class="scdb-muted">No typed notes in the vault yet.</p>
        ) : (
          <div class="scdb-chips">
            {types.map((entry) => (
              <label key={entry.type} class="scdb-toggle">
                <input
                  type="checkbox"
                  checked={query.types.includes(entry.type)}
                  onChange={() => toggleType(entry.type)}
                />
                {entry.type} <span class="scdb-muted scdb-num">{entry.count}</span>
              </label>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={`Filter (${query.where?.clauses.length ?? 0})`}>
        <FilterBuilder
          group={query.where ?? andGroup()}
          fields={catalogue}
          onChange={(where) => patch({ where })}
        />
      </Panel>

      <Panel title="Columns, sort and grouping">
        <div class="scdb-field">
          <span class="scdb-field__label">Columns</span>
          <span class="scdb-field__hint">
            None chosen shows the first few. ƒ marks a field we compute rather than read.
          </span>
          <div class="scdb-chips">
            {catalogue.map((field) => (
              <label key={field.id} class="scdb-toggle">
                <input
                  type="checkbox"
                  checked={query.columns.includes(field.id)}
                  onChange={() =>
                    patch({
                      columns: query.columns.includes(field.id)
                        ? query.columns.filter((id) => id !== field.id)
                        : [...query.columns, field.id],
                    })
                  }
                />
                {field.label}
                {field.computed ? " ƒ" : ""}
              </label>
            ))}
          </div>
        </div>

        <label class="scdb-field">
          <span class="scdb-field__label">Sort by</span>
          <div class="scdb-filter__row">
            <select
              value={query.sort[0]?.field ?? ""}
              onChange={(event) => {
                const field = (event.currentTarget as HTMLSelectElement).value;
                patch({
                  sort:
                    field === ""
                      ? []
                      : [{ field, direction: query.sort[0]?.direction ?? "asc" }],
                });
              }}
            >
              <option value="">Nothing (index order)</option>
              {catalogue.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Sort direction"
              value={query.sort[0]?.direction ?? "asc"}
              disabled={query.sort.length === 0}
              onChange={(event) => {
                const direction =
                  (event.currentTarget as HTMLSelectElement).value === "desc" ? "desc" : "asc";
                const first = query.sort[0];
                if (first) patch({ sort: [{ ...first, direction }] });
              }}
            >
              <option value="asc">ascending</option>
              <option value="desc">descending</option>
            </select>
          </div>
        </label>

        <label class="scdb-field">
          <span class="scdb-field__label">Group by</span>
          <div class="scdb-filter__row">
            <select
              value={query.group?.field ?? ""}
              onChange={(event) => {
                const field = (event.currentTarget as HTMLSelectElement).value;
                patch({ group: field === "" ? null : { field, direction: "asc" } });
              }}
            >
              <option value="">Nothing</option>
              {catalogue.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label}
                </option>
              ))}
            </select>
            {query.group !== null &&
              catalogue.find((field) => field.id === query.group?.field)?.kind === "date" && (
                <select
                  aria-label="Date bucket"
                  value={query.group.bucket ?? "day"}
                  onChange={(event) => {
                    const bucket = (event.currentTarget as HTMLSelectElement).value;
                    const group = query.group;
                    if (!group) return;
                    patch({
                      group: { ...group, bucket: BUCKETS.find((entry) => entry === bucket) },
                    });
                  }}
                >
                  {BUCKETS.map((bucket) => (
                    <option key={bucket} value={bucket}>
                      by {bucket}
                    </option>
                  ))}
                </select>
              )}
          </div>
        </label>
      </Panel>

      <Panel title={`Totals (${query.aggregates.length})`}>
        {query.aggregates.map((aggregate, index) => (
          <div key={index} class="scdb-filter__row">
            <select
              aria-label="Function"
              value={aggregate.fn}
              onChange={(event) => {
                const fn = (event.currentTarget as HTMLSelectElement)
                  .value as AggregateSpec["fn"];
                const next = [...query.aggregates];
                next[index] = { ...aggregate, fn };
                patch({ aggregates: next });
              }}
            >
              {AGGREGATE_FNS.map((fn) => (
                <option key={fn} value={fn}>
                  {fn}
                </option>
              ))}
            </select>
            <select
              aria-label="Of field"
              value={aggregate.field ?? ""}
              disabled={aggregate.fn === "count"}
              onChange={(event) => {
                const field = (event.currentTarget as HTMLSelectElement).value;
                const next = [...query.aggregates];
                next[index] = field === "" ? { fn: aggregate.fn } : { ...aggregate, field };
                patch({ aggregates: next });
              }}
            >
              <option value="">—</option>
              {catalogue.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              class="scdb-link"
              onClick={() => patch({ aggregates: query.aggregates.filter((_, at) => at !== index) })}
            >
              remove
            </button>
          </div>
        ))}
        <button
          type="button"
          class="scdb-link"
          onClick={() => patch({ aggregates: [...query.aggregates, { fn: "count" }] })}
        >
          + total
        </button>
      </Panel>

      {problems.length > 0 && (
        <ul class="scdb-list scdb-list--problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {result.problems.map((problem) => (
        <p key={problem} class="scdb-gatereport__warning">
          {problem}
        </p>
      ))}

      <ResultTable result={result} now={now} onOpen={(key) => void plugin.openNote(key)} />
    </div>
  );
}
