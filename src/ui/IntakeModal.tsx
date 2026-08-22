import type { App } from "obsidian";
import { useState } from "preact/hooks";
import { nextRequestId } from "../domain/request/create";
import type { WorkflowSpec } from "../domain/request/workflow";
import { parseTimestamp } from "../domain/time/dates";
import type { Mode } from "../domain/settings/schema";
import { PreactModal } from "./PreactModal";

export interface IntakeSubmission {
  title: string;
  requester?: string;
  study?: string;
  externalRef?: string;
  due?: number;
  identifiers: "none" | "indirect" | "direct";
  hat: string;
}

interface PanelProps {
  spec: WorkflowSpec;
  suggestedId: string;
  mode: Mode;
  onSubmit: (submission: IntakeSubmission) => void;
  onCancel: () => void;
}

function IntakePanel({ spec, suggestedId, mode, onSubmit, onCancel }: PanelProps) {
  const [title, setTitle] = useState("");
  const [requester, setRequester] = useState("");
  const [study, setStudy] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [due, setDue] = useState("");
  const [identifiers, setIdentifiers] = useState<"none" | "indirect" | "direct">("none");

  const dueMs = due.trim() === "" ? undefined : parseTimestamp(due.trim());
  const dueUnreadable = due.trim() !== "" && dueMs === null;
  const canSubmit = title.trim() !== "" && !dueUnreadable;

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        Creates <strong>{suggestedId}</strong> in {spec.label}, at stage{" "}
        <strong>{spec.stages[0]?.label ?? "—"}</strong>.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Title</span>
        <input
          type="text"
          autofocus
          placeholder="What is being asked for"
          value={title}
          onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Requester</span>
        <input
          type="text"
          placeholder="[[Dr A Tan]]"
          value={requester}
          onInput={(event) => setRequester((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Study</span>
        <input
          type="text"
          placeholder="[[EuroHeart]]"
          value={study}
          onInput={(event) => setStudy((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">eData reference</span>
        <input
          type="text"
          placeholder="EDR-2026-00871"
          value={externalRef}
          onInput={(event) => setExternalRef((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          The institutional system is the record of truth; this vault is a working tracker.
        </span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Due</span>
        <input
          type="text"
          placeholder="2026-08-04"
          value={due}
          onInput={(event) => setDue((event.target as HTMLInputElement).value)}
        />
        {dueUnreadable && (
          <span class="scdb-field__error">
            Write the date as YYYY-MM-DD, or leave it empty.
          </span>
        )}
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Identifiers</span>
        <select
          class="dropdown"
          value={identifiers}
          onChange={(event) =>
            setIdentifiers(
              (event.target as HTMLSelectElement).value as "none" | "indirect" | "direct",
            )
          }
        >
          <option value="none">None — fully de-identified</option>
          <option value="indirect">Indirect — dates, case numbers, small cells</option>
          <option value="direct">Direct — names, NRIC, MRN, contact details</option>
        </select>
        <span class="scdb-field__hint">
          Drives the governance gates. Changing it later is logged to the audit ledger.
        </span>
      </label>

      <div class="scdb-modal__actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              title,
              requester: requester.trim(),
              study: study.trim(),
              externalRef: externalRef.trim(),
              ...(dueMs !== undefined && dueMs !== null ? { due: dueMs } : {}),
              identifiers,
              hat: mode,
            })
          }
        >
          Create request
        </button>
      </div>
    </div>
  );
}

export class IntakeModal extends PreactModal {
  private readonly suggestedId: string;

  constructor(
    app: App,
    private readonly options: {
      spec: WorkflowSpec;
      existingIds: readonly string[];
      mode: Mode;
      onSubmit: (submission: IntakeSubmission) => Promise<void>;
    },
  ) {
    super(app);
    this.suggestedId = nextRequestId(options.existingIds, new Date().getFullYear());
    this.titleEl.setText("New request");
  }

  protected body() {
    return (
      <IntakePanel
        spec={this.options.spec}
        suggestedId={this.suggestedId}
        mode={this.options.mode}
        onCancel={() => this.close()}
        onSubmit={(submission) => {
          this.close();
          void this.options.onSubmit(submission);
        }}
      />
    );
  }
}
