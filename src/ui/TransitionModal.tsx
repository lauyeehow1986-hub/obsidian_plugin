import type { App, TFile } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import type { RequestNote } from "../domain/request/request";
import { evaluateTransition } from "../domain/request/transition";
import { allowedTargets, resolveStage, type WorkflowSpec } from "../domain/request/workflow";
import { PreactModal } from "./PreactModal";
import { displayName } from "./format";

export interface TransitionSubmission {
  to: string;
  /** `undefined` leaves the holdup as it is; `null` clears it. */
  blockedOn?: string | null;
  override?: { reason: string };
}

interface PanelProps {
  spec: WorkflowSpec;
  request: RequestNote;
  onSubmit: (submission: TransitionSubmission) => void;
  onCancel: () => void;
}

function GateReport({
  spec,
  request,
  to,
}: {
  spec: WorkflowSpec;
  request: RequestNote;
  to: string;
}) {
  const decision = useMemo(
    () => evaluateTransition({ spec, request, to, now: Date.now() }),
    [spec, request, to],
  );

  return (
    <div class="scdb-gatereport">
      {decision.refusals.length === 0 ? (
        <p class="scdb-gatereport__ok">Nothing blocks this move.</p>
      ) : (
        <ul class="scdb-gatereport__list">
          {decision.refusals.map((refusal) => (
            <li
              key={refusal.message}
              class={
                refusal.overridable
                  ? "scdb-gatereport__item scdb-gatereport__item--gate"
                  : "scdb-gatereport__item scdb-gatereport__item--hard"
              }
            >
              <span class="scdb-gatereport__badge">
                {refusal.overridable ? "Gate" : "Blocked"}
              </span>
              <span>{refusal.message}</span>
            </li>
          ))}
        </ul>
      )}

      {decision.gates
        .filter((gate) => gate.ok)
        .map((gate) => (
          <p key={gate.gate.message} class="scdb-gatereport__pass">
            Gate satisfied: {gate.gate.message}
          </p>
        ))}

      {decision.warnings.map((warning) => (
        <p key={warning} class="scdb-gatereport__warning">
          {warning}
        </p>
      ))}
    </div>
  );
}

function TransitionPanel({ spec, request, onSubmit, onCancel }: PanelProps) {
  const targets = useMemo(() => allowedTargets(spec, request.stage), [spec, request.stage]);
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [blockedOn, setBlockedOn] = useState(request.blockedOn ?? "");
  const [reason, setReason] = useState("");

  const decision = useMemo(
    () => (to === "" ? null : evaluateTransition({ spec, request, to, now: Date.now() })),
    [spec, request, to],
  );

  const needsReason = decision !== null && !decision.allowed && decision.overridable;
  const impossible = decision === null || (!decision.allowed && !decision.overridable);
  const canSubmit = !impossible && (!needsReason || reason.trim() !== "");
  const current = resolveStage(spec, request.stage);

  if (targets.length === 0) {
    return (
      <div class="scdb-modal__body">
        <p>
          {current?.terminal
            ? `"${current.label}" is a terminal stage. This request has finished its workflow.`
            : "The workflow offers no stage to move to from here."}
        </p>
        <div class="scdb-modal__actions">
          <button type="button" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        {request.id || request.uid} is in <strong>{current?.label ?? request.stage}</strong>.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Move to</span>
        <select
          class="dropdown"
          value={to}
          onChange={(event) => setTo((event.target as HTMLSelectElement).value)}
        >
          {targets.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.label}
            </option>
          ))}
        </select>
      </label>

      {to !== "" && <GateReport spec={spec} request={request} to={to} />}

      <label class="scdb-field">
        <span class="scdb-field__label">Waiting on</span>
        <input
          type="text"
          placeholder="[[Dr A Tan]] — leave empty if nobody is holding this up"
          value={blockedOn}
          onInput={(event) => setBlockedOn((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Who the holdup sits with. This is what groups the chase-up view.
        </span>
      </label>

      {needsReason && (
        <label class="scdb-field scdb-field--override">
          <span class="scdb-field__label">Reason for overriding the gate</span>
          <textarea
            rows={3}
            placeholder="Why is it right to proceed despite the gate?"
            value={reason}
            onInput={(event) => setReason((event.target as HTMLTextAreaElement).value)}
          />
          <span class="scdb-field__hint">
            Required. The reason is written to the audit ledger with your name and the
            time, and cannot be edited afterwards.
          </span>
        </label>
      )}

      <div class="scdb-modal__actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class={needsReason ? "mod-warning" : "mod-cta"}
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              to,
              blockedOn: blockedOn.trim() === "" ? null : blockedOn.trim(),
              ...(needsReason ? { override: { reason } } : {}),
            })
          }
        >
          {needsReason ? "Override and move" : "Move"}
        </button>
      </div>
    </div>
  );
}

export class TransitionModal extends PreactModal {
  constructor(
    app: App,
    private readonly options: {
      spec: WorkflowSpec;
      request: RequestNote;
      file: TFile;
      onSubmit: (submission: TransitionSubmission) => Promise<void>;
    },
  ) {
    super(app);
    this.titleEl.setText(
      `Move ${options.request.id || displayName(options.request.title)}`,
    );
  }

  protected body() {
    return (
      <TransitionPanel
        spec={this.options.spec}
        request={this.options.request}
        onCancel={() => this.close()}
        onSubmit={(submission) => {
          this.close();
          void this.options.onSubmit(submission);
        }}
      />
    );
  }
}
