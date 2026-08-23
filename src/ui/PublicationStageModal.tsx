import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import { stageLabel, type PublicationNote } from "../domain/publication/publication";
import { evaluatePublicationTransition, nextStages } from "../domain/publication/stages";
import { parseTimestamp, toVaultDate } from "../domain/time/dates";
import { PreactModal } from "./PreactModal";
import { displayName } from "./format";

export interface PublicationSubmission {
  to: string;
  /** Only sent when it differs from what the note already says. */
  journal?: string;
  /** `undefined` leaves the date alone; `null` clears it. */
  decisionDue?: number | null;
}

/** Stages after which the journal owes us an answer, so a date is worth asking for. */
const AWAITS_DECISION: readonly string[] = ["submitted", "under-review"];

function StagePanel({
  publication,
  onSubmit,
  onCancel,
}: {
  publication: PublicationNote;
  onSubmit: (submission: PublicationSubmission) => void;
  onCancel: () => void;
}) {
  const targets = useMemo(() => nextStages(publication.stage), [publication.stage]);
  const [to, setTo] = useState(targets[0] ?? "");
  const [journal, setJournal] = useState(publication.journal);
  const [typedDate, setTypedDate] = useState("");
  const [dateTouched, setDateTouched] = useState(false);

  /**
   * What the date field shows before anyone types in it.
   *
   * It follows the chosen stage rather than staying on whatever the note said.
   * Moving to a stage where the journal has already answered means the old
   * date is spent — pre-filling it there would quietly carry a stale chase-up
   * forward while the hint underneath promised it was cleared.
   */
  const suggestedDate =
    AWAITS_DECISION.includes(to) && publication.decisionDue !== null
      ? toVaultDate(publication.decisionDue)
      : "";
  const decisionDue = dateTouched ? typedDate : suggestedDate;

  const decision = useMemo(
    () => (to === "" ? null : evaluatePublicationTransition({ publication, to, journal })),
    [publication, to, journal],
  );

  const dateEntered = decisionDue.trim() !== "";
  const parsedDate = dateEntered ? parseTimestamp(decisionDue.trim()) : null;
  const dateBroken = dateEntered && parsedDate === null;
  const canSubmit = decision !== null && decision.allowed && !dateBroken;

  if (targets.length === 0) {
    return (
      <div class="scdb-modal__body">
        <p>
          {publication.stage === "published"
            ? "This manuscript is published. That is where a manuscript's story ends."
            : `"${stageLabel(publication.stage)}" is not one of the publication stages, so there is nowhere defined to move it. Correct the note's stage first.`}
        </p>
        <div class="scdb-modal__actions">
          <button type="button" class="scdb-control" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        {publication.id || displayName(publication.title)} is{" "}
        <strong>{stageLabel(publication.stage).toLowerCase()}</strong>
        {publication.journal === "" ? "" : ` at ${publication.journal}`}.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Move to</span>
        <select
          class="dropdown"
          value={to}
          onChange={(event) => setTo((event.target as HTMLSelectElement).value)}
        >
          {targets.map((stage) => (
            <option key={stage} value={stage}>
              {stageLabel(stage)}
            </option>
          ))}
        </select>
      </label>

      {decision !== null && decision.refusals.length > 0 && (
        <div class="scdb-gatereport">
          <ul class="scdb-gatereport__list">
            {decision.refusals.map((refusal) => (
              <li key={refusal.message} class="scdb-gatereport__item scdb-gatereport__item--hard">
                <span class="scdb-gatereport__badge">Blocked</span>
                <span>{refusal.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {decision?.warnings.map((warning) => (
        <p key={warning} class="scdb-gatereport__warning">
          {warning}
        </p>
      ))}

      <label class="scdb-field">
        <span class="scdb-field__label">Journal</span>
        <input
          type="text"
          placeholder="European Heart Journal"
          value={journal}
          onInput={(event) => setJournal((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Changing it records the move in <code>history</code> as well, so a paper sent
          somewhere else keeps both stops — that is what the resubmission count reads.
        </span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Decision expected</span>
        <input
          type="date"
          value={decisionDue}
          onInput={(event) => {
            setDateTouched(true);
            setTypedDate((event.target as HTMLInputElement).value);
          }}
        />
        <span class="scdb-field__hint">
          {AWAITS_DECISION.includes(to)
            ? "An overdue decision is the first thing on the publications board. Leave empty if you would rather not be chased."
            : "The journal has answered, so this is cleared unless you set a new one."}
        </span>
        {dateBroken && (
          <span class="scdb-field__hint scdb-field__hint--bad">
            That is not a date the plugin can read. Use YYYY-MM-DD.
          </span>
        )}
      </label>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              to,
              ...(journal.trim() === publication.journal ? {} : { journal: journal.trim() }),
              // Only send a date when the user actually expressed one, so an
              // untouched field leaves the engine's own clearing rule to apply.
              ...(dateEntered ? { decisionDue: parsedDate } : { decisionDue: null }),
            })
          }
        >
          Move
        </button>
      </div>
    </div>
  );
}

export class PublicationStageModal extends PreactModal {
  constructor(
    app: App,
    private readonly options: {
      publication: PublicationNote;
      onSubmit: (submission: PublicationSubmission) => Promise<void>;
    },
  ) {
    super(app);
    this.titleEl.setText(
      `Move ${options.publication.id || displayName(options.publication.title)}`,
    );
  }

  protected body() {
    return (
      <StagePanel
        publication={this.options.publication}
        onCancel={() => this.close()}
        onSubmit={(submission) => {
          this.close();
          void this.options.onSubmit(submission);
        }}
      />
    );
  }
}
