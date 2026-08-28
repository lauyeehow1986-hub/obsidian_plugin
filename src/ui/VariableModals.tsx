import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import { definitionInForceOn, lineage } from "../domain/catalogue/lineage";
import { planRevision } from "../domain/catalogue/revise";
import {
  DATA_TYPES,
  dataTypeLabel,
  parseCoding,
  variableLabel,
  type Coding,
  type Definition,
  type VariableNote,
} from "../domain/catalogue/variable";
import { toVaultDate } from "../domain/time/dates";
import { PreactModal } from "./PreactModal";
import type { NewVariable } from "../services/catalogueWriter";

/**
 * The three dialogs the catalogue needs (§5.8, §7 C2): create a variable,
 * supersede its definition, and ask what it meant on a date.
 *
 * All three are presentational. The revise dialog renders `planRevision`'s
 * refusals rather than deciding anything itself, so the rule that a revision
 * needs a typed reason lives in one place and is unit-tested there.
 */

const CODING_HINT = "1, Mild | 2, Moderate | 3, Severe";

function codingText(coding: Coding[]): string {
  return coding.map((code) => `${code.code}, ${code.label}`).join(" | ");
}

/* ------------------------------------------------------------------ new -- */

function NewVariablePanel({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: NewVariable) => Promise<void>;
  onCancel: () => void;
}) {
  const [id, setId] = useState("VAR-");
  const [label, setLabel] = useState("");
  const [domain, setDomain] = useState("");
  const [dataType, setDataType] = useState<string>("numeric");
  const [units, setUnits] = useState("");
  const [definition, setDefinition] = useState("");
  const [identifier, setIdentifier] = useState(false);
  const [justification, setJustification] = useState("");
  const [collectedIn, setCollectedIn] = useState("");
  const [sourceForm, setSourceForm] = useState("");

  const ready = id.trim().length > 4 && label.trim() !== "" && definition.trim() !== "";

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        A catalogue entry is created at version 1 and dated today, so every later question about
        what it meant on a date has somewhere to start.
      </p>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">ID</span>
          <input
            type="text"
            value={id}
            onInput={(event) => setId((event.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">What everything else cites. It never changes.</span>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Domain</span>
          <input
            type="text"
            placeholder="echo"
            value={domain}
            onInput={(event) => setDomain((event.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">Free text. The board groups by it.</span>
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Label</span>
        <input
          type="text"
          placeholder="Left ventricular ejection fraction"
          value={label}
          onInput={(event) => setLabel((event.target as HTMLInputElement).value)}
        />
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Type</span>
          <select
            value={dataType}
            onChange={(event) => setDataType((event.target as HTMLSelectElement).value)}
          >
            {DATA_TYPES.map((type) => (
              <option key={type} value={type}>
                {dataTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Units</span>
          <input
            type="text"
            placeholder="%"
            value={units}
            onInput={(event) => setUnits((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Definition</span>
        <textarea
          rows={3}
          placeholder="Biplane Simpson's, per institutional echo protocol v3."
          value={definition}
          onInput={(event) => setDefinition((event.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">
          The thing a request, a form and a script all rely on. Write it as you would defend it.
        </span>
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Collected in</span>
          <input
            type="text"
            placeholder="[[EuroHeart]], [[HF Registry]]"
            value={collectedIn}
            onInput={(event) => setCollectedIn((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Source form</span>
          <input
            type="text"
            placeholder="[[FORM-echo-baseline]]"
            value={sourceForm}
            onInput={(event) => setSourceForm((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class="scdb-field scdb-field--inline">
        <input
          type="checkbox"
          checked={identifier}
          onChange={(event) => setIdentifier((event.target as HTMLInputElement).checked)}
        />
        <span class="scdb-field__label">This is an identifier</span>
      </label>

      {identifier && (
        <label class="scdb-field">
          <span class="scdb-field__label">Held because</span>
          <input
            type="text"
            placeholder="Linkage to the national registry, within DSRB-2026-0142."
            value={justification}
            onInput={(event) => setJustification((event.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">
            Not required to save, but an identifier with no recorded reason is flagged on the
            board and is what a form export has to justify anyway.
          </span>
        </label>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!ready}
          title={ready ? undefined : "An id, a label and a definition are the minimum."}
          onClick={() =>
            void onSubmit({
              id: id.trim(),
              label: label.trim(),
              domain: domain.trim(),
              dataType,
              units: units.trim(),
              definition: definition.trim(),
              identifier,
              justification: justification.trim(),
              collectedIn: collectedIn
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry !== ""),
              sourceForm: sourceForm.trim(),
            })
          }
        >
          Create
        </button>
      </div>
    </div>
  );
}

export class NewVariableModal extends PreactModal {
  constructor(
    app: App,
    private readonly onSubmit: (input: NewVariable) => Promise<void>,
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText("New catalogue variable");
    return (
      <NewVariablePanel
        onSubmit={async (input) => {
          await this.onSubmit(input);
          this.close();
        }}
        onCancel={() => this.close()}
      />
    );
  }
}

/* --------------------------------------------------------------- revise -- */

export interface ReviseSubmission {
  changes: Partial<Definition>;
  reason: string;
}

function RevisePanel({
  variable,
  onSubmit,
  onCancel,
  now,
}: {
  variable: VariableNote;
  onSubmit: (submission: ReviseSubmission) => Promise<void>;
  onCancel: () => void;
  now: number;
}) {
  const [definition, setDefinition] = useState(variable.definition);
  const [dataType, setDataType] = useState<string>(variable.dataType);
  const [units, setUnits] = useState(variable.units);
  const [low, setLow] = useState(variable.validRange === null ? "" : String(variable.validRange[0]));
  const [high, setHigh] = useState(variable.validRange === null ? "" : String(variable.validRange[1]));
  const [coding, setCoding] = useState(codingText(variable.coding));
  const [identifier, setIdentifier] = useState(variable.identifier);
  const [reason, setReason] = useState("");

  const changes = useMemo((): Partial<Definition> => {
    const range: [number, number] | null =
      low.trim() === "" || high.trim() === "" ? null : [Number(low), Number(high)];
    return {
      definition: definition.trim(),
      dataType: (dataType === "" ? "" : dataType) as Definition["dataType"],
      units: units.trim(),
      validRange: range !== null && range.every(Number.isFinite) ? range : null,
      coding: parseCoding(coding, []),
      identifier,
    };
  }, [definition, dataType, units, low, high, coding, identifier]);

  const plan = useMemo(
    () => planRevision({ variable, changes, reason, at: now }),
    [variable, changes, reason, now],
  );

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        {variableLabel(variable)} is at version <strong>{variable.version || "(none)"}</strong>.
        The current definition is kept as version {variable.version || "?"} before the new one
        replaces it, so nothing that cites it loses its meaning.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Definition</span>
        <textarea
          rows={3}
          value={definition}
          onInput={(event) => setDefinition((event.target as HTMLTextAreaElement).value)}
        />
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Type</span>
          <select
            value={dataType}
            onChange={(event) => setDataType((event.target as HTMLSelectElement).value)}
          >
            <option value="">Unstated</option>
            {DATA_TYPES.map((type) => (
              <option key={type} value={type}>
                {dataTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Units</span>
          <input
            type="text"
            value={units}
            onInput={(event) => setUnits((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Valid from</span>
          <input
            type="number"
            value={low}
            onInput={(event) => setLow((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">to</span>
          <input
            type="number"
            value={high}
            onInput={(event) => setHigh((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Coding</span>
        <input
          type="text"
          placeholder={CODING_HINT}
          value={coding}
          onInput={(event) => setCoding((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          <code>code, label</code> separated by <code>|</code> — the same form a REDCap data
          dictionary uses, so it can be pasted either way.
        </span>
      </label>

      <label class="scdb-field scdb-field--inline">
        <input
          type="checkbox"
          checked={identifier}
          onChange={(event) => setIdentifier((event.target as HTMLInputElement).checked)}
        />
        <span class="scdb-field__label">This is an identifier</span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Why it changed</span>
        <input
          type="text"
          placeholder="Aligned to the ESC 2025 definition."
          value={reason}
          onInput={(event) => setReason((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Required. It is written onto the superseded version and into the audit ledger — a
          version bump saying only “updated” is one nobody can act on later.
        </span>
      </label>

      {plan.refusals.length > 0 && (
        <div class="scdb-gatereport">
          <ul class="scdb-gatereport__list">
            {plan.refusals.map((refusal) => (
              <li key={refusal} class="scdb-gatereport__item scdb-gatereport__item--hard">
                <span class="scdb-gatereport__badge">Blocked</span>
                <span>{refusal}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.changes.length > 0 && (
        <>
          <h3 class="scdb-modal__heading">
            What would move — version {plan.fromVersion} to {plan.toVersion}
          </h3>
          <table class="scdb-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Was</th>
                <th scope="col">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {plan.changes.map((change) => (
                <tr key={change.field}>
                  <td>{change.label}</td>
                  <td class="scdb-muted">{change.before}</td>
                  <td>{change.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.identifierMoved && (
            <p class="scdb-gatereport__warning">
              This moves the identifier flag, which is logged separately as an
              <code> identifier-scope</code> entry as well as the revision.
            </p>
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
          disabled={plan.refusals.length > 0}
          title={plan.refusals.length > 0 ? plan.refusals.join(" ") : undefined}
          onClick={() => void onSubmit({ changes, reason: reason.trim() })}
        >
          Supersede to v{plan.toVersion}
        </button>
      </div>
    </div>
  );
}

export class ReviseVariableModal extends PreactModal {
  constructor(
    app: App,
    private readonly variable: VariableNote,
    private readonly onSubmit: (submission: ReviseSubmission) => Promise<void>,
    private readonly now = Date.now(),
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText("Revise a catalogue variable");
    return (
      <RevisePanel
        variable={this.variable}
        now={this.now}
        onSubmit={async (submission) => {
          await this.onSubmit(submission);
          this.close();
        }}
        onCancel={() => this.close()}
      />
    );
  }
}

/* -------------------------------------------------------------- in force -- */

function InForcePanel({ variable, now }: { variable: VariableNote; now: number }) {
  const [date, setDate] = useState(toVaultDate(now));
  const at = useMemo(() => Date.parse(`${date}T12:00:00`), [date]);
  const answer = useMemo(
    () => (Number.isFinite(at) ? definitionInForceOn(variable, at) : null),
    [variable, at],
  );
  const rows = lineage(variable);

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        {variableLabel(variable)} — what the catalogue says this meant on a given day. The answer
        comes from the versions the note recorded, and says so when it cannot know.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">On</span>
        <input
          type="date"
          value={date}
          onInput={(event) => setDate((event.target as HTMLInputElement).value)}
        />
      </label>

      {answer === null ? (
        <p class="scdb-empty">That is not a date.</p>
      ) : (
        <>
          <p class={answer.version === 0 ? "scdb-gatereport__warning" : "scdb-modal__lede"}>
            {answer.note}
          </p>
          {answer.version > 0 && (
            <dl class="scdb-deflist">
              <div>
                <dt>Definition</dt>
                <dd>
                  {answer.definition.definition?.value ?? (
                    <span class="scdb-muted">not recorded at that version</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>
                  {answer.definition.dataType === null ? (
                    <span class="scdb-muted">not recorded</span>
                  ) : (
                    dataTypeLabel(answer.definition.dataType.value)
                  )}
                </dd>
              </div>
              <div>
                <dt>Units</dt>
                <dd>
                  {answer.definition.units?.value ?? <span class="scdb-muted">not recorded</span>}
                </dd>
              </div>
              <div>
                <dt>Valid range</dt>
                <dd>
                  {answer.definition.validRange === null ? (
                    <span class="scdb-muted">not recorded</span>
                  ) : answer.definition.validRange.value === null ? (
                    "—"
                  ) : (
                    `${answer.definition.validRange.value[0]} to ${answer.definition.validRange.value[1]}`
                  )}
                </dd>
              </div>
              <div>
                <dt>Identifier</dt>
                <dd>
                  {answer.definition.identifier === null ? (
                    <span class="scdb-muted">not recorded</span>
                  ) : answer.definition.identifier.value ? (
                    "yes"
                  ) : (
                    "no"
                  )}
                </dd>
              </div>
            </dl>
          )}
        </>
      )}

      <h3 class="scdb-modal__heading">The chain</h3>
      <table class="scdb-table">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">In force</th>
            <th scope="col">Why it changed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.version}>
              <td class="scdb-num">
                {row.version}
                {row.live && <span class="scdb-chip">current</span>}
              </td>
              <td class="scdb-muted">
                {row.from === null ? "undated" : toVaultDate(row.from)}
                {row.until === null ? "" : ` – ${toVaultDate(row.until)}`}
              </td>
              <td>{row.reason || <span class="scdb-muted">not recorded</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export class InForceModal extends PreactModal {
  constructor(
    app: App,
    private readonly variable: VariableNote,
    private readonly now = Date.now(),
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText("Which definition was in force");
    return <InForcePanel variable={this.variable} now={this.now} />;
  }
}
