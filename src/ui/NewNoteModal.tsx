import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import {
  buildNote,
  fieldsFor,
  initialValues,
  type FieldSpec,
  type NoteKindSpec,
  type NoteValues,
} from "../domain/notes/newNote";
import { PreactModal } from "./PreactModal";

/**
 * One dialog for the six note kinds nothing else creates
 * (`domain/notes/newNote`).
 *
 * Presentational to the letter: it renders whatever fields the spec names for
 * the chosen variant, and asks `buildNote` whether anything required is still
 * empty rather than deciding that itself. So adding a field to a note kind —
 * or a seventh kind — is an edit to the spec module and its tests, and nothing
 * here changes.
 *
 * Six bespoke dialogs would have been the other option, and would have drifted
 * apart within a month.
 */

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  const hint =
    field.hint === undefined ? null : <span class="scdb-field__hint">{field.hint}</span>;

  if (field.kind === "checkbox") {
    return (
      <label class="scdb-field scdb-field--inline">
        <input
          type="checkbox"
          checked={value !== ""}
          onChange={(event) => onChange((event.target as HTMLInputElement).checked ? "yes" : "")}
        />
        <span class="scdb-field__label">{field.label}</span>
        {hint}
      </label>
    );
  }

  return (
    <label class="scdb-field">
      <span class="scdb-field__label">
        {field.label}
        {field.required === true ? "" : " (optional)"}
      </span>
      {field.kind === "select" ? (
        <select value={value} onChange={(event) => onChange((event.target as HTMLSelectElement).value)}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea
          rows={3}
          placeholder={field.placeholder}
          value={value}
          onInput={(event) => onChange((event.target as HTMLTextAreaElement).value)}
        />
      ) : (
        <input
          type={field.kind === "date" ? "date" : "text"}
          placeholder={field.placeholder}
          value={value}
          onInput={(event) => onChange((event.target as HTMLInputElement).value)}
        />
      )}
      {hint}
    </label>
  );
}

function NewNotePanel({
  spec,
  now,
  onSubmit,
  onCancel,
}: {
  spec: NoteKindSpec;
  now: number;
  onSubmit: (values: NoteValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(spec, now));

  const variant =
    spec.variantField === undefined ? "" : (values[spec.variantField.key] ?? "").trim();
  const fields = useMemo(() => fieldsFor(spec, variant), [spec, variant]);
  const built = useMemo(() => buildNote(spec, values, now), [spec, values, now]);

  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">{spec.lede}</p>

      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key] ?? ""}
          onChange={(value) => set(field.key, value)}
        />
      ))}

      <p class="scdb-modal__lede">
        Saved as <code>{built.stem}.md</code>. Everything left blank writes no key at all — an
        absent field and an empty one do not mean the same thing to the boards that read them.
      </p>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={built.missing.length > 0}
          title={built.missing.length > 0 ? `Fill in ${built.missing.join(", ")}.` : undefined}
          onClick={() => void onSubmit(values)}
        >
          Create
        </button>
      </div>
    </div>
  );
}

export class NewNoteModal extends PreactModal {
  constructor(
    app: App,
    private readonly spec: NoteKindSpec,
    private readonly onSubmit: (values: NoteValues) => Promise<void>,
    private readonly now = Date.now(),
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText(this.spec.title);
    return (
      <NewNotePanel
        spec={this.spec}
        now={this.now}
        onSubmit={async (values) => {
          await this.onSubmit(values);
          this.close();
        }}
        onCancel={() => this.close()}
      />
    );
  }
}
