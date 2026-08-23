/**
 * The timer's dialogs (CLAUDE.md §7 B2).
 *
 * One form serves the stop dialog and retroactive editing, because they are the
 * same act at different times: B2 asks for retroactive editing as a first-class
 * feature, and a second, thinner form for "the entry you forgot" would be the
 * afterthought it warns against.
 */

import type { App } from "obsidian";
import { useState } from "preact/hooks";
import { formatMinutes } from "../domain/effort/aggregate";
import { clockSpan, validateEntry, type TimeEntry } from "../domain/effort/entry";
import {
  formatElapsed,
  type IdleChoice,
  type RecoveryChoice,
  type TimerBinding,
  type TimerRecovery,
  type TimerState,
} from "../domain/effort/timer";
import type { StopOutcome } from "../services/timerService";
import { PreactModal } from "./PreactModal";
import { askText } from "./PromptModal";

interface FormProps {
  initial: TimeEntry;
  activities: readonly string[];
  costCentres: readonly string[];
  lede: string;
  submitLabel: string;
  /** Offered by the stop dialog: end the session without recording it. */
  discardLabel?: string;
  onSubmit: (entry: TimeEntry) => void;
  onDiscard?: () => void;
  onCancel: () => void;
}

function EntryForm({
  initial,
  activities,
  costCentres,
  lede,
  submitLabel,
  discardLabel,
  onSubmit,
  onDiscard,
  onCancel,
}: FormProps) {
  const [entry, setEntry] = useState<TimeEntry>(initial);
  const set = <K extends keyof TimeEntry>(key: K, value: TimeEntry[K]) =>
    setEntry((current) => ({ ...current, [key]: value }));

  const reasons = validateEntry(entry, activities);
  const span = clockSpan(entry.start, entry.end);
  // The span is shown, never enforced downward: minutes below it are a paused
  // timer, which is the normal case and the reason `mins` is its own column.
  const spanHint =
    span === null
      ? "No clock times, so only the minutes are recorded."
      : `${entry.start}–${entry.end} spans ${formatMinutes(span)}.` +
        (entry.mins < span ? ` ${formatMinutes(span - entry.mins)} of it was not counted.` : "");

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">{lede}</p>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Date</span>
          <input
            type="text"
            value={entry.date}
            onInput={(event) => set("date", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Start</span>
          <input
            type="text"
            placeholder="09:12"
            value={entry.start}
            onInput={(event) => set("start", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">End</span>
          <input
            type="text"
            placeholder="10:05"
            value={entry.end}
            onInput={(event) => set("end", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Minutes</span>
          <input
            type="number"
            min="0"
            value={String(entry.mins)}
            onInput={(event) =>
              set("mins", Number.parseInt((event.target as HTMLInputElement).value, 10) || 0)
            }
          />
        </label>
      </div>
      <p class="scdb-field__hint">{spanHint}</p>

      <label class="scdb-field">
        <span class="scdb-field__label">Reference</span>
        <input
          type="text"
          placeholder="REQ-2026-014"
          value={entry.ref}
          onInput={(event) => set("ref", (event.target as HTMLInputElement).value)}
        />
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Activity</span>
          <select
            class="dropdown"
            value={entry.activity}
            onChange={(event) => set("activity", (event.target as HTMLSelectElement).value)}
          >
            {activities.map((activity) => (
              <option key={activity} value={activity}>
                {activity}
              </option>
            ))}
          </select>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Person</span>
          <input
            type="text"
            value={entry.person}
            onInput={(event) => set("person", (event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Study</span>
          <input
            type="text"
            value={entry.study}
            onInput={(event) => set("study", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Cost centre</span>
          <input
            type="text"
            list="scdb-cost-centres"
            value={entry.costCentre}
            onInput={(event) => set("costCentre", (event.target as HTMLInputElement).value)}
          />
          <datalist id="scdb-cost-centres">
            {costCentres.map((centre) => (
              <option key={centre} value={centre} />
            ))}
          </datalist>
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Note</span>
        <input
          type="text"
          placeholder="Optional — what this time went on"
          value={entry.note}
          onInput={(event) => set("note", (event.target as HTMLInputElement).value)}
        />
      </label>

      {reasons.length > 0 && (
        <ul class="scdb-modal__list scdb-field__error">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        {discardLabel !== undefined && onDiscard !== undefined && (
          <button type="button" class="scdb-control mod-warning" onClick={onDiscard}>
            {discardLabel}
          </button>
        )}
        <button
          type="button"
          class="mod-cta"
          disabled={reasons.length > 0}
          onClick={() => onSubmit(entry)}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

class EntryModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly props: Omit<FormProps, "onSubmit" | "onDiscard" | "onCancel"> & {
      title: string;
    },
    private readonly resolve: (outcome: StopOutcome) => void,
  ) {
    super(app);
  }

  protected body() {
    return (
      <EntryForm
        {...this.props}
        onSubmit={(entry) => this.finish({ kind: "save", entry })}
        onDiscard={
          this.props.discardLabel === undefined ? undefined : () => this.finish({ kind: "discard" })
        }
        onCancel={() => this.finish({ kind: "cancel" })}
      />
    );
  }

  override onOpen(): void {
    this.titleEl.setText(this.props.title);
    super.onOpen();
  }

  override onClose(): void {
    super.onClose();
    // Dismissal is never consent and never a discard: the session is left
    // exactly as it was, so "I meant to pause" cannot cost an afternoon.
    if (!this.decided) this.resolve({ kind: "cancel" });
  }

  private finish(outcome: StopOutcome): void {
    this.decided = true;
    this.resolve(outcome);
    this.close();
  }
}

export interface EntryDialogOptions {
  title: string;
  lede: string;
  submitLabel: string;
  discardLabel?: string;
  activities: readonly string[];
  costCentres: readonly string[];
}

/** Show an entry for editing. Resolves `cancel` on dismissal. */
export function askEntry(
  app: App,
  entry: TimeEntry,
  options: EntryDialogOptions,
): Promise<StopOutcome> {
  return new Promise((resolve) => {
    new EntryModal(
      app,
      {
        initial: entry,
        activities: options.activities,
        costCentres: options.costCentres,
        lede: options.lede,
        submitLabel: options.submitLabel,
        discardLabel: options.discardLabel,
        title: options.title,
      },
      resolve,
    ).open();
  });
}

/* --------------------------------------------------------- what to time -- */

interface BindingProps {
  initial: TimerBinding;
  activities: readonly string[];
  costCentres: readonly string[];
  suggestions: readonly string[];
  onSubmit: (binding: TimerBinding) => void;
  onCancel: () => void;
}

function BindingForm({
  initial,
  activities,
  costCentres,
  suggestions,
  onSubmit,
  onCancel,
}: BindingProps) {
  const [binding, setBinding] = useState<TimerBinding>(initial);
  const set = <K extends keyof TimerBinding>(key: K, value: TimerBinding[K]) =>
    setBinding((current) => ({ ...current, [key]: value }));

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        The activity starts on the one your hat implies. Everything here can still be changed when
        the timer stops.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Reference</span>
        <input
          type="text"
          autofocus
          list="scdb-timer-refs"
          placeholder="REQ-2026-014, a study, or what you are doing"
          value={binding.ref}
          onInput={(event) => set("ref", (event.target as HTMLInputElement).value)}
        />
        <datalist id="scdb-timer-refs">
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Activity</span>
          <select
            class="dropdown"
            value={binding.activity}
            onChange={(event) => set("activity", (event.target as HTMLSelectElement).value)}
          >
            {activities.map((activity) => (
              <option key={activity} value={activity}>
                {activity}
              </option>
            ))}
          </select>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Study</span>
          <input
            type="text"
            value={binding.study}
            onInput={(event) => set("study", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Cost centre</span>
          <input
            type="text"
            list="scdb-cost-centres"
            value={binding.costCentre}
            onInput={(event) => set("costCentre", (event.target as HTMLInputElement).value)}
          />
          <datalist id="scdb-cost-centres">
            {costCentres.map((centre) => (
              <option key={centre} value={centre} />
            ))}
          </datalist>
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Note</span>
        <input
          type="text"
          value={binding.note}
          onInput={(event) => set("note", (event.target as HTMLInputElement).value)}
        />
      </label>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" class="mod-cta" onClick={() => onSubmit(binding)}>
          Start
        </button>
      </div>
    </div>
  );
}

class BindingModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly props: Omit<BindingProps, "onSubmit" | "onCancel"> & { title: string },
    private readonly resolve: (binding: TimerBinding | null) => void,
  ) {
    super(app);
  }

  protected body() {
    return (
      <BindingForm
        {...this.props}
        onSubmit={(binding) => this.finish(binding)}
        onCancel={() => this.finish(null)}
      />
    );
  }

  override onOpen(): void {
    this.titleEl.setText(this.props.title);
    super.onOpen();
  }

  override onClose(): void {
    super.onClose();
    if (!this.decided) this.resolve(null);
  }

  private finish(binding: TimerBinding | null): void {
    this.decided = true;
    this.resolve(binding);
    this.close();
  }
}

/** What to time. `suggestions` are the live request ids, offered but not enforced. */
export function askBinding(
  app: App,
  initial: TimerBinding,
  options: {
    title: string;
    activities: readonly string[];
    costCentres: readonly string[];
    suggestions: readonly string[];
  },
): Promise<TimerBinding | null> {
  return new Promise((resolve) => {
    new BindingModal(app, { initial, ...options }, resolve).open();
  });
}

/* ---------------------------------------------------------- split time -- */

/** Ask where to split an entry. The prompt itself lives in `PromptModal`. */
export function askSplitTime(
  app: App,
  lede: string,
  suggested: string,
): Promise<string | null> {
  return askText(app, {
    title: "Split entry",
    lede,
    label: "Split at",
    initial: suggested,
    submitLabel: "Split",
  });
}

/* ------------------------------------------------------------- choices -- */

interface Choice<T> {
  value: T;
  label: string;
  detail: string;
}

class ChoiceModal<T> extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly config: { title: string; lede: string; choices: Choice<T>[] },
    private readonly resolve: (value: T | null) => void,
  ) {
    super(app);
  }

  protected body() {
    return (
      <div class="scdb-modal__body">
        <p class="scdb-modal__lede">{this.config.lede}</p>
        <div class="scdb-choices">
          {this.config.choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              class="scdb-choice"
              onClick={() => this.finish(choice.value)}
            >
              <span class="scdb-choice__label">{choice.label}</span>
              <span class="scdb-choice__detail">{choice.detail}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  override onOpen(): void {
    this.titleEl.setText(this.config.title);
    super.onOpen();
  }

  override onClose(): void {
    super.onClose();
    if (!this.decided) this.resolve(null);
  }

  private finish(value: T): void {
    this.decided = true;
    this.resolve(value);
    this.close();
  }
}

/**
 * What happened during a gap.
 *
 * The dialog says what was actually detected — a missed heartbeat, meaning the
 * machine slept or Obsidian was not running — rather than claiming to know the
 * user was idle. It cannot see the keyboard, and a dialog that overstates what
 * it measured teaches people to distrust the numbers it produces.
 */
export function askIdle(app: App, gapMs: number, state: TimerState): Promise<IdleChoice | null> {
  const gap = formatElapsed(gapMs);
  return new Promise((resolve) => {
    new ChoiceModal<IdleChoice>(
      app,
      {
        title: "The timer went quiet",
        lede:
          `Nothing was heard from this machine for ${gap} while the timer on ` +
          `${state.binding.ref.trim() || state.binding.activity} was running. ` +
          "That usually means it slept or Obsidian was closed. What should happen to that time?",
        choices: [
          {
            value: "keep",
            label: `Count it — ${gap} of work`,
            detail: "Reading, a call, a meeting away from the desk.",
          },
          {
            value: "discard",
            label: `Drop it and keep going`,
            detail: "The session continues, minus the gap.",
          },
          {
            value: "split",
            label: "End the session there and start a new one",
            detail: "Records what came before, then starts fresh on the same work.",
          },
        ],
      },
      resolve,
    ).open();
  });
}

/**
 * The options, with the two "record" rows collapsed when they say the same.
 *
 * After a quick restart the vouched and optimistic totals round to the same
 * number, and offering *Record 2m* twice with different small print is a dialog
 * that looks broken. Only when the gap actually cost something is there a
 * decision to put in front of anyone.
 */
function recoveryChoices(recovery: TimerRecovery): Choice<RecoveryChoice>[] {
  const vouched = formatElapsed(recovery.vouchedMs);
  const optimistic = formatElapsed(recovery.optimisticMs);
  const record: Choice<RecoveryChoice>[] =
    vouched === optimistic
      ? [{ value: "heartbeat", label: `Record ${vouched}`, detail: "What the timer had counted." }]
      : [
          {
            value: "heartbeat",
            label: `Record ${vouched}`,
            detail: "Up to the last moment the timer was seen alive.",
          },
          {
            value: "now",
            label: `Record ${optimistic}`,
            detail: "The whole span, if the work really did carry on.",
          },
        ];

  return [
    ...record,
    {
      value: "resume",
      label: "Carry on timing",
      detail: `Keeps ${vouched} and starts counting again now.`,
    },
    { value: "discard", label: "Record nothing", detail: "The session is dropped." },
  ];
}

/** A timer found still going at startup. */
export function askRecovery(app: App, recovery: TimerRecovery): Promise<RecoveryChoice | null> {
  const { binding } = recovery.state;
  return new Promise((resolve) => {
    new ChoiceModal<RecoveryChoice>(
      app,
      {
        title: "A timer was still running",
        lede:
          `A timer on ${binding.ref.trim() || binding.activity} was running when Obsidian last ` +
          `stopped, and ${formatElapsed(recovery.gapMs)} has passed since it last checked in. ` +
          "Only you know whether that time was worked.",
        choices: recoveryChoices(recovery),
      },
      resolve,
    ).open();
  });
}
