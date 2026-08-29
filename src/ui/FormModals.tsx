import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";

import { fromDictionaryCsv } from "../domain/redcap/dictionary";
import { toFormName } from "../domain/redcap/form";
import { GOVERNANCE_LABELS } from "../domain/redcap/governance";
import type { FormAssessment } from "../domain/redcap/register";
import { PreactModal } from "./PreactModal";
import type { NewForm } from "../services/redcapWriter";
import { count } from "./format";

/**
 * The three dialogs D2 needs: create a form, override a blocked export with a
 * typed reason, and preview a data dictionary before it replaces anything.
 *
 * All three are presentational. The override dialog renders the findings the
 * domain produced and collects a reason; it decides nothing — the writer
 * re-validates and refuses on its own, so a dialog that got out of step could
 * not let a blocked export through.
 */

/* ------------------------------------------------------------------ new -- */

function NewFormPanel({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: NewForm) => Promise<void>;
  onCancel: () => void;
}) {
  const [id, setId] = useState("FORM-");
  const [title, setTitle] = useState("");
  const [study, setStudy] = useState("");
  const [project, setProject] = useState("");
  const [instrumentLabel, setInstrumentLabel] = useState("");

  // Shown, never silently applied: a form name generated behind someone's back
  // is one they will not recognise in the dictionary.
  const instrumentName = useMemo(
    () => toFormName(instrumentLabel || title),
    [instrumentLabel, title],
  );

  const ready = id.trim().length > 5 && title.trim() !== "" && instrumentName !== "";

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        The form's fields go in a <code>```yaml redcap</code> block in the note body, not in
        frontmatter — an instrument of eighty fields does not belong there, and a body block
        diffs cleanly in git.
      </p>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">ID</span>
          <input type="text" value={id} onInput={(e) => setId((e.target as HTMLInputElement).value)} />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Title</span>
          <input
            type="text"
            placeholder="Baseline visit"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Study</span>
          <input
            type="text"
            placeholder="[[EuroHeart]]"
            value={study}
            onInput={(e) => setStudy((e.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">
            Where the approved identifier scope comes from. Without it, an identifier on this form
            cannot be checked against anything.
          </span>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">REDCap project</span>
          <input
            type="text"
            placeholder="Optional — a name, for your reference"
            value={project}
            onInput={(e) => setProject((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">First instrument</span>
        <input
          type="text"
          placeholder="Baseline visit"
          value={instrumentLabel}
          onInput={(e) => setInstrumentLabel((e.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          {instrumentName === "" ? (
            "REDCap groups the dictionary by form name, so the instrument needs one."
          ) : (
            <>
              REDCap will call it <code>{instrumentName}</code>. It starts with a{" "}
              <code>record_id</code> text field — REDCap makes the first field of the first
              instrument the record key whatever it is called.
            </>
          )}
        </span>
      </label>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!ready}
          title={ready ? undefined : "An id, a title and an instrument name are the minimum."}
          onClick={() =>
            void onSubmit({
              id: id.trim(),
              title: title.trim(),
              study: study.trim(),
              project: project.trim(),
              instrumentName,
              instrumentLabel: (instrumentLabel || title).trim(),
            })
          }
        >
          Create
        </button>
      </div>
    </div>
  );
}

export class NewFormModal extends PreactModal {
  constructor(
    app: App,
    private readonly onSubmit: (input: NewForm) => Promise<void>,
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText("New REDCap form");
    return (
      <NewFormPanel
        onSubmit={async (input) => {
          await this.onSubmit(input);
          this.close();
        }}
        onCancel={() => this.close()}
      />
    );
  }
}

/* ------------------------------------------------------------- override -- */

function OverridePanel({
  assessment,
  onSubmit,
  onCancel,
}: {
  assessment: FormAssessment;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const blocking = assessment.governance.findings.filter((finding) => finding.blocking);
  const ready = reason.trim().length >= 10;

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        Governance blocks this export. Exporting anyway is allowed — this is a working tool and
        an instrument can legitimately run ahead of its approval — but the reason goes in the
        audit ledger under your initials, and it stays there.
      </p>

      <ul class="scdb-list scdb-list--problems">
        {blocking.map((finding) => (
          <li key={`${finding.kind}${finding.field}`}>
            <span class="scdb-chip scdb-chip--overdue">⛔ {GOVERNANCE_LABELS[finding.kind]}</span>{" "}
            {finding.message}
          </li>
        ))}
      </ul>

      <label class="scdb-field">
        <span class="scdb-field__label">Why this is going out anyway</span>
        <textarea
          rows={3}
          placeholder="DSRB amendment 3 approved on 2026-08-12; the scope on the study note has not been updated yet."
          value={reason}
          onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">
          A sentence a stranger could act on. Refusing to give one cancels the export.
        </span>
      </label>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-warning"
          disabled={!ready}
          title={ready ? undefined : "A typed reason of at least a few words is required."}
          onClick={() => void onSubmit(reason.trim())}
        >
          Override and export
        </button>
      </div>
    </div>
  );
}

export class OverrideExportModal extends PreactModal {
  constructor(
    app: App,
    private readonly assessment: FormAssessment,
    private readonly onSubmit: (reason: string) => Promise<void>,
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText(`Export ${this.assessment.spec.id} against governance`);
    return (
      <OverridePanel
        assessment={this.assessment}
        onSubmit={async (reason) => {
          this.close();
          await this.onSubmit(reason);
        }}
        onCancel={() => this.close()}
      />
    );
  }
}

/* --------------------------------------------------------------- import -- */

function ImportPanel({
  formId,
  existingFields,
  onSubmit,
  onCancel,
}: {
  formId: string;
  existingFields: number;
  onSubmit: (csv: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [csv, setCsv] = useState("");
  const preview = useMemo(() => (csv.trim() === "" ? null : fromDictionaryCsv(csv)), [csv]);
  const ready = preview !== null && preview.fieldCount > 0;

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        Paste a data dictionary exported from REDCap. It replaces every field on{" "}
        <strong>{formId}</strong> — {count(existingFields, "field")} at the moment — so that an
        existing instrument can be edited here rather than rebuilt. The action is recorded in the
        audit ledger.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Data dictionary CSV</span>
        <textarea
          rows={8}
          class="scdb-mono"
          placeholder="Variable / Field Name,Form Name,Section Header,Field Type,…"
          value={csv}
          onInput={(e) => setCsv((e.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">
          In REDCap: Project Setup → Designer → Data Dictionary → Download. Columns may be in any
          order.
        </span>
      </label>

      {preview !== null && (
        <>
          <h4 class="scdb-modal__heading">What this would bring in</h4>
          {preview.fieldCount === 0 ? (
            <p class="scdb-empty">No fields could be read from that.</p>
          ) : (
            <ul class="scdb-list">
              {preview.instruments.map((instrument) => (
                <li key={instrument.name}>
                  <code>{instrument.name}</code> — {count(instrument.fields.length, "field")}
                </li>
              ))}
            </ul>
          )}

          {preview.gaps.length > 0 && (
            <>
              <h4 class="scdb-modal__heading">What a dictionary cannot carry</h4>
              <ul class="scdb-list scdb-list--problems">
                {preview.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </>
          )}

          {preview.problems.length > 0 && (
            <>
              <h4 class="scdb-modal__heading">Problems in the file</h4>
              <ul class="scdb-list scdb-list--problems">
                {preview.problems.slice(0, 10).map((problem, index) => (
                  <li key={`${problem}${index}`}>{problem}</li>
                ))}
                {preview.problems.length > 10 && (
                  <li class="scdb-muted">…and {preview.problems.length - 10} more.</li>
                )}
              </ul>
            </>
          )}
        </>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!ready}
          title={ready ? undefined : "Paste a dictionary that produces at least one field."}
          onClick={() => void onSubmit(csv)}
        >
          Replace {count(existingFields, "field")}
        </button>
      </div>
    </div>
  );
}

export class ImportDictionaryModal extends PreactModal {
  constructor(
    app: App,
    private readonly formId: string,
    private readonly existingFields: number,
    private readonly onSubmit: (csv: string) => Promise<void>,
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText("Import a REDCap data dictionary");
    return (
      <ImportPanel
        formId={this.formId}
        existingFields={this.existingFields}
        onSubmit={async (csv) => {
          this.close();
          await this.onSubmit(csv);
        }}
        onCancel={() => this.close()}
      />
    );
  }
}
