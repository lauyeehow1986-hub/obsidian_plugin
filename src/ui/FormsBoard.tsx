import { useEffect, useMemo, useState } from "preact/hooks";

import { FIELD_TYPE_LABELS, formatChoices, type RedcapField } from "../domain/redcap/field";
import { GOVERNANCE_LABELS, identifierHint } from "../domain/redcap/governance";
import { FORM_STATUS_LABELS } from "../domain/redcap/form";
import {
  VERDICT_LABELS,
  searchForms,
  type FormAssessment,
  type FormsRegister,
  type Verdict,
} from "../domain/redcap/register";
import { IDENTIFIER_SCOPE_LABELS } from "../domain/study/study";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

/**
 * The REDCap forms register (§5.14, §7 D2).
 *
 * Grouped by whether the form is ready to build, not by its declared status:
 * status is what a person asserts, the verdict is what the checks found, and
 * the second is the one that changes what you do next. Presentational only —
 * every finding comes from `domain/redcap`.
 *
 * This board loads asynchronously, unlike the others. A form's fields live in
 * a fenced block in the note body rather than in frontmatter (§7 D2), and the
 * body is not in the metadata cache, so building the register means reading
 * files. Rendering a stale register would be worse than a moment's wait: the
 * whole point of the board is that the export decision rests on what the note
 * says now.
 */

/** §6: status is colour *plus* a glyph, never colour alone. */
const VERDICT_CHIPS: Record<Verdict, { cls: string; glyph: string }> = {
  blocked: { cls: "scdb-chip scdb-chip--overdue", glyph: "⛔" },
  invalid: { cls: "scdb-chip scdb-chip--problem", glyph: "✕" },
  questions: { cls: "scdb-chip", glyph: "?" },
  ready: { cls: "scdb-chip", glyph: "✓" },
};

function FieldRow({ field, plugin }: { field: RedcapField; plugin: ScdbCockpitPlugin }) {
  const hint = field.identifier ? "" : identifierHint(field);
  return (
    <tr>
      <td>
        <code>{field.name || "(no name)"}</code>
      </td>
      <td>{field.label || <span class="scdb-muted">no label</span>}</td>
      <td class="scdb-muted">{FIELD_TYPE_LABELS[field.type]}</td>
      <td>
        {field.choices.length > 0 && (
          <span class="scdb-muted">{formatChoices(field.choices)}</span>
        )}
        {field.calculation !== "" && <code>{field.calculation}</code>}
        {field.branching !== "" && (
          <span class="scdb-muted" title="Branching logic">
            shown if <code>{field.branching}</code>
          </span>
        )}
      </td>
      <td>
        {field.identifier && (
          <span
            class={field.justification === "" ? "scdb-chip scdb-chip--problem" : "scdb-chip scdb-chip--blocked"}
            title={field.justification === "" ? "Flagged as an identifier with no recorded reason." : field.justification}
          >
            ⚑ identifier
          </span>
        )}
        {hint !== "" && (
          <span class="scdb-chip scdb-chip--problem" title={`Looks like it holds ${hint}. This is a guess from the name.`}>
            ⚑ looks like one
          </span>
        )}
        {field.variable !== "" && (
          <button
            type="button"
            class="scdb-linkish"
            title="Open the catalogue variable this field collects"
            onClick={() => plugin.openVariable(field.variable)}
          >
            {field.variable}
          </button>
        )}
      </td>
    </tr>
  );
}

function FormCard({ form, plugin }: { form: FormAssessment; plugin: ScdbCockpitPlugin }) {
  const [open, setOpen] = useState(false);
  const { spec, governance } = form;
  const chip = VERDICT_CHIPS[form.verdict];

  return (
    <li class="scdb-card scdb-card--stacked">
      <div class="scdb-card__row">
        <button
          type="button"
          class="scdb-card__main"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${spec.id}`}
        >
          <span class="scdb-card__id">{spec.id}</span>
          <span class="scdb-card__title">{spec.title}</span>
          <span class="scdb-card__meta">
            <span class={chip.cls}>
              {chip.glyph} {VERDICT_LABELS[form.verdict]}
            </span>
            <span class="scdb-chip">{FORM_STATUS_LABELS[spec.status]}</span>
            <span class="scdb-muted scdb-num">
              {count(spec.instruments.length, "instrument")}, {count(form.fieldCount, "field")}
            </span>
            {form.identifierCount > 0 && (
              <span class="scdb-muted scdb-num">{count(form.identifierCount, "identifier")}</span>
            )}
          </span>
        </button>
        <button
          type="button"
          class="scdb-card__action"
          title="Write the REDCap data dictionary to 95 Exports/"
          onClick={() => void plugin.exportDictionary(spec.path)}
        >
          Export CSV
        </button>
        <button
          type="button"
          class="scdb-card__action"
          title="Replace these fields with a data dictionary exported from REDCap"
          onClick={() => void plugin.importDictionary(spec.path)}
        >
          Import CSV
        </button>
      </div>

      {open && (
        <div class="scdb-card__detail">
          <dl class="scdb-deflist">
            <div>
              <dt>Study</dt>
              <dd>{spec.study || <span class="scdb-muted">none named</span>}</dd>
            </div>
            <div>
              <dt>Approved to collect</dt>
              <dd>
                {governance.approved === null ? (
                  <span class="scdb-muted" title="Not recorded is not the same as approved.">
                    not recorded
                  </span>
                ) : (
                  IDENTIFIER_SCOPE_LABELS[governance.approved]
                )}
                {governance.study?.irbRef !== undefined && governance.study.irbRef !== "" && (
                  <span class="scdb-muted"> · {governance.study.irbRef}</span>
                )}
              </dd>
            </div>
            {spec.project !== "" && (
              <div>
                <dt>REDCap project</dt>
                <dd>{spec.project}</dd>
              </div>
            )}
          </dl>

          {governance.findings.length > 0 && (
            <>
              <h4 class="scdb-modal__heading">Governance</h4>
              <ul class="scdb-list scdb-list--problems">
                {governance.findings.map((finding) => (
                  <li key={`${finding.kind}${finding.field}`}>
                    <span class={finding.blocking ? "scdb-chip scdb-chip--overdue" : "scdb-chip"}>
                      {finding.blocking ? "⛔" : "⚑"} {GOVERNANCE_LABELS[finding.kind]}
                    </span>{" "}
                    {finding.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          {form.findings.length > 0 && (
            <>
              <h4 class="scdb-modal__heading">
                {form.errors.length > 0 ? "What REDCap would reject" : "Worth a look"}
              </h4>
              <ul class="scdb-list scdb-list--problems">
                {form.findings.map((finding, index) => (
                  <li key={`${finding.code}${finding.field}${index}`}>
                    <span class={finding.severity === "error" ? "scdb-chip scdb-chip--problem" : "scdb-chip"}>
                      {finding.severity === "error" ? "✕" : "⚑"}
                    </span>{" "}
                    {finding.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          {spec.instruments.map((instrument) => (
            <section key={instrument.name} class="scdb-group">
              <h4 class="scdb-group__title">
                {instrument.label}
                <span class="scdb-group__sub">
                  <code>{instrument.name}</code> · {count(instrument.fields.length, "field")}
                </span>
              </h4>
              {instrument.fields.length === 0 ? (
                <p class="scdb-empty">No fields yet.</p>
              ) : (
                <table class="scdb-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Label</th>
                      <th scope="col">Type</th>
                      <th scope="col">Choices, calculation or condition</th>
                      <th scope="col">Governance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instrument.fields.map((field) => (
                      <FieldRow key={field.name} field={field} plugin={plugin} />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}

          <p>
            <button type="button" class="scdb-linkish" onClick={() => plugin.openNote(spec.path)}>
              Open the note
            </button>
          </p>
        </div>
      )}
    </li>
  );
}

export function FormsBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [query, setQuery] = useState("");
  const [register, setRegister] = useState<FormsRegister | null>(null);

  useEffect(() => {
    let live = true;
    void plugin.formsRegister().then((built) => {
      if (live) setRegister(built);
    });
    return () => {
      live = false;
    };
  }, [plugin, plugin.formsVersion]);

  const matching = useMemo(
    () => (register === null ? [] : searchForms(register.forms, query)),
    [register, query],
  );

  if (register === null) return <p class="scdb-empty">Reading the form notes…</p>;

  if (register.forms.length === 0) {
    return (
      <div class="scdb-stack">
        <p class="scdb-empty">
          No REDCap forms yet. A form note carries <code>type: redcap-form</code> in its
          frontmatter and its fields in a <code>```yaml redcap</code> block in the body — too
          large for frontmatter, and it diffs cleanly. Start one from scratch, or import a data
          dictionary you already have.
        </p>
        <p>
          <button type="button" class="mod-cta" onClick={() => void plugin.newForm()}>
            New form
          </button>
        </p>
      </div>
    );
  }

  const { summary } = register;
  const groups = register.groups
    .map((group) => ({ ...group, forms: group.forms.filter((form) => matching.includes(form)) }))
    .filter((group) => group.forms.length > 0);

  return (
    <div class="scdb-stack">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          REDCap forms
          <span class="scdb-group__sub">
            {count(summary.total, "form")}, {count(summary.fields, "field")}
            {summary.identifiers > 0 && `, ${count(summary.identifiers, "identifier")}`}
          </span>
        </h3>

        <div class="scdb-toolbar">
          <input
            type="search"
            class="scdb-catalogue__search"
            placeholder="Search form, instrument, field name or label…"
            value={query}
            aria-label="Search the forms"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          />
          <button type="button" class="scdb-control" onClick={() => void plugin.newForm()}>
            New form
          </button>
        </div>

        {(summary.blocked > 0 || summary.invalid > 0 || summary.uncheckable > 0) && (
          <ul class="scdb-list scdb-list--problems">
            {summary.blocked > 0 && (
              <li>
                {count(summary.blocked, "form")} collecting identifiers the linked study is not
                approved to hold. Exporting one needs a typed reason, and the reason is logged.
              </li>
            )}
            {summary.invalid > 0 && (
              <li>{count(summary.invalid, "form")} REDCap would reject on upload.</li>
            )}
            {summary.uncheckable > 0 && (
              <li>
                {count(summary.uncheckable, "form")} whose identifiers cannot be checked, because
                no linked study records an approved scope. Not recorded is not approved.
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
                <span class="scdb-group__sub">{count(group.forms.length, "form")}</span>
              </h3>
              <ul class="scdb-cards">
                {group.forms.map((form) => (
                  <FormCard key={form.spec.path} form={form} plugin={plugin} />
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
