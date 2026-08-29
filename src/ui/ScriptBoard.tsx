import { useMemo, useState } from "preact/hooks";
import { languageLabel, shortHash } from "../domain/script/scriptDoc";
import { RUN_EXIT_LABELS, type RunRecord } from "../domain/script/runRecord";
import { searchScripts, type ScriptRow } from "../domain/script/register";
import { VERDICT_LABELS, type Verdict } from "../domain/script/staleness";
import { toVaultDate } from "../domain/time/dates";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

/**
 * The script register (§5.14, §7 C3).
 *
 * Grouped by verdict rather than by folder, because the board answers one
 * question — which of these needs re-running before anyone quotes its output
 * again — and any other grouping buries it.
 *
 * Presentational only: every finding comes from `domain/script/staleness`.
 */

/**
 * Colour is never the only signal (§6): each verdict carries a glyph and its
 * own words as well, so the board reads the same to a colour-blind reader.
 */
const VERDICT_CHIPS: Record<Verdict, { cls: string; glyph: string }> = {
  "run-failed": { cls: "scdb-chip scdb-chip--overdue", glyph: "✕" },
  "definition-moved": { cls: "scdb-chip scdb-chip--problem", glyph: "⚑" },
  "inputs-moved": { cls: "scdb-chip scdb-chip--problem", glyph: "⚑" },
  "code-moved": { cls: "scdb-chip scdb-chip--problem", glyph: "⚑" },
  "never-run": { cls: "scdb-chip", glyph: "○" },
  undated: { cls: "scdb-chip", glyph: "?" },
  current: { cls: "scdb-chip", glyph: "✓" },
};

function VerdictChip({ verdict }: { verdict: Verdict }) {
  const chip = VERDICT_CHIPS[verdict];
  return (
    <span class={chip.cls}>
      {chip.glyph} {VERDICT_LABELS[verdict]}
    </span>
  );
}

function Runs({ runs, plugin }: { runs: RunRecord[]; plugin: ScdbCockpitPlugin }) {
  if (runs.length === 0) {
    return (
      <p class="scdb-empty">
        No run records point at this script. Use <em>Record a run</em> after you run it — a run
        with no record cannot say what data version or which code produced its outputs.
      </p>
    );
  }
  return (
    <table class="scdb-table">
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Started</th>
          <th scope="col">Outcome</th>
          <th scope="col">Interpreter</th>
          <th scope="col">Code</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.path}>
            <td>
              <button type="button" class="scdb-linkish" onClick={() => plugin.openNote(run.path)}>
                {run.id || run.path}
              </button>
            </td>
            <td class="scdb-muted">
              {run.started === null ? "undated" : toVaultDate(run.started)}
            </td>
            <td>
              {run.exit === "" ? (
                <span class="scdb-muted">not recorded</span>
              ) : run.exit === "ok" ? (
                RUN_EXIT_LABELS[run.exit]
              ) : (
                <span class="scdb-state scdb-state--overdue">{RUN_EXIT_LABELS[run.exit]}</span>
              )}
            </td>
            <td class="scdb-muted">{run.interpreter || "not recorded"}</td>
            <td class="scdb-muted scdb-num">
              {run.scriptHash === "" ? "no hash" : `${shortHash(run.scriptHash)}…`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScriptCard({ row, plugin }: { row: ScriptRow; plugin: ScdbCockpitPlugin }) {
  const [open, setOpen] = useState(false);
  const { doc, assessment } = row;

  return (
    <li class="scdb-card scdb-card--stacked">
      <div class="scdb-card__row">
        <button
          type="button"
          class="scdb-card__main"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${doc.id || doc.path}`}
        >
          <span class="scdb-card__id">{doc.id || "(no id)"}</span>
          <span class="scdb-card__title">{doc.title || doc.purpose || "(untitled)"}</span>
          <span class="scdb-card__meta">
            <VerdictChip verdict={assessment.verdict} />
            <span class="scdb-chip">{languageLabel(doc.language)}</span>
            <span class="scdb-muted scdb-num">
              {assessment.lastRunAt === null
                ? "never run"
                : `last run ${toVaultDate(assessment.lastRunAt)}`}
            </span>
            <span class="scdb-muted scdb-num">{count(assessment.runs.length, "run")}</span>
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
          title="Write a provenance record for a run that has already happened"
          onClick={() => plugin.recordScriptRun(doc)}
        >
          Record a run
        </button>
        <button
          type="button"
          class="scdb-card__action"
          title="Hash the script file and compare it with what this note documents"
          onClick={() => void plugin.checkScriptHash(doc)}
        >
          Check hash
        </button>
      </div>

      {open && (
        <div class="scdb-card__detail">
          <p>{doc.purpose || <span class="scdb-muted">No purpose recorded.</span>}</p>

          {assessment.findings.length > 0 && (
            <ul class="scdb-list scdb-list--problems">
              {assessment.findings.map((finding) => (
                <li key={`${finding.kind}${finding.detail}`}>{finding.detail}</li>
              ))}
            </ul>
          )}

          <dl class="scdb-deflist">
            <div>
              <dt>Code</dt>
              <dd>
                {doc.file || <span class="scdb-muted">not recorded</span>}
                {doc.fileHash !== "" && (
                  <span class="scdb-muted scdb-num"> · {shortHash(doc.fileHash)}…</span>
                )}
                {doc.fileHash === "" && (
                  <span class="scdb-muted"> · no hash recorded</span>
                )}
              </dd>
            </div>
            {doc.study !== "" && (
              <div>
                <dt>Study</dt>
                <dd>{doc.study}</dd>
              </div>
            )}
            {doc.lastRunBy !== "" && (
              <div>
                <dt>Last run by</dt>
                <dd>{doc.lastRunBy}</dd>
              </div>
            )}
            {doc.requests.length > 0 && (
              <div>
                <dt>Answers</dt>
                <dd>{doc.requests.join(", ")}</dd>
              </div>
            )}
          </dl>

          <h4 class="scdb-modal__heading">What it reads</h4>
          {doc.inputs.length === 0 ? (
            <p class="scdb-empty">
              No inputs listed, so nothing can flag this script when its data moves — which is
              the whole point of the register. Add <code>inputs:</code> with a{" "}
              <code>dataset</code> and the date that version came into being.
            </p>
          ) : (
            <table class="scdb-table">
              <thead>
                <tr>
                  <th scope="col">Dataset</th>
                  <th scope="col">Version</th>
                  <th scope="col">Changed</th>
                </tr>
              </thead>
              <tbody>
                {doc.inputs.map((input) => (
                  <tr key={input.dataset}>
                    <td>{input.dataset}</td>
                    <td class="scdb-muted">{input.version || "not recorded"}</td>
                    <td class="scdb-muted">
                      {input.changed === null ? (
                        <span title="With no date, nothing can say whether this has moved.">
                          not recorded
                        </span>
                      ) : (
                        toVaultDate(input.changed)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {assessment.consumed.length > 0 && (
            <>
              <h4 class="scdb-modal__heading">Variables it consumes</h4>
              <ul class="scdb-list">
                {assessment.consumed.map((entry) => (
                  <li key={entry.ref}>
                    {entry.variable === null ? (
                      <>
                        <span>{entry.ref}</span>
                        <span
                          class="scdb-muted"
                          title="Nothing in the catalogue holds this — a typo, or something consumed that was never catalogued."
                        >
                          {" "}
                          · not in the catalogue
                        </span>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          class="scdb-linkish"
                          onClick={() => plugin.openNote(entry.variable!.path)}
                        >
                          {entry.variable.id || entry.ref}
                        </button>
                        <span class="scdb-muted"> · v{entry.variable.version || "?"} current</span>
                        {entry.citedVersion !== null && (
                          <span class="scdb-muted"> · cited at v{entry.citedVersion}</span>
                        )}
                        {entry.revisedAfterRun && (
                          <span class="scdb-chip scdb-chip--problem"> revised after the last run</span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4 class="scdb-modal__heading">What it produces</h4>
          {doc.outputs.length === 0 ? (
            <p class="scdb-empty">No outputs listed.</p>
          ) : (
            <ul class="scdb-list">
              {doc.outputs.map((output) => (
                <li key={output.path}>
                  {output.path}
                  {output.kind !== "" && <span class="scdb-muted"> · {output.kind}</span>}
                </li>
              ))}
            </ul>
          )}

          <h4 class="scdb-modal__heading">Provenance</h4>
          <Runs runs={assessment.runs} plugin={plugin} />

          {row.problems.length > 0 && (
            <ul class="scdb-list scdb-list--problems">
              {row.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          <p>
            <button type="button" class="scdb-linkish" onClick={() => plugin.openNote(doc.path)}>
              Open the note
            </button>
          </p>
        </div>
      )}
    </li>
  );
}

export function ScriptBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [query, setQuery] = useState("");
  const register = plugin.scriptRegister();
  const rows = useMemo(() => searchScripts(register.rows, query), [register, query]);

  if (register.rows.length === 0) {
    return (
      <div class="scdb-stack">
        <p class="scdb-empty">
          No script documentation yet. A note with <code>type: script-doc</code>, a{" "}
          <code>purpose</code>, a <code>file</code> and the <code>inputs</code> it reads is enough
          — from then on the register flags it whenever an input dataset or a catalogue definition
          moves after the last recorded run. Start with the script whose output you are asked
          about most often.
        </p>
        <p>
          <button type="button" class="mod-cta" onClick={() => void plugin.newScript()}>
            New script doc
          </button>
        </p>
      </div>
    );
  }

  const { summary } = register;
  const groups = register.groups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => rows.includes(row)) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div class="scdb-stack">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Scripts
          <span class="scdb-group__sub">
            {count(summary.total, "script")}, {summary.needsAttention} needing attention
          </span>
        </h3>

        <div class="scdb-toolbar">
          <input
            type="search"
            class="scdb-catalogue__search"
            placeholder="Search id, purpose, dataset, variable…"
            value={query}
            aria-label="Search the script register"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          />
          <button type="button" class="scdb-control" onClick={() => void plugin.newScript()}>
            New script doc
          </button>
        </div>

        {(summary.unhashed > 0 || summary.orphanRuns > 0) && (
          <ul class="scdb-list scdb-list--problems">
            {summary.unhashed > 0 && (
              <li>
                {count(summary.unhashed, "script")} with no <code>file_hash</code>, so nothing can
                ever say which version of the code produced an output.
              </li>
            )}
            {summary.orphanRuns > 0 && (
              <li>
                {count(summary.orphanRuns, "run record")} pointing at no documented script — a
                typo in <code>script:</code>, or something run that was never documented.
              </li>
            )}
          </ul>
        )}

        {groups.length === 0 ? (
          <p class="scdb-empty">Nothing matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <section key={group.verdict} class="scdb-group">
              <h3 class="scdb-group__title">
                {group.label}
                <span class="scdb-group__sub">{count(group.rows.length, "script")}</span>
              </h3>
              <ul class="scdb-cards">
                {group.rows.map((row) => (
                  <ScriptCard key={row.doc.path} row={row} plugin={plugin} />
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
