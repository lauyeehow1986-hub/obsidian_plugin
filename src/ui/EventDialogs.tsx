/**
 * Dialogs for events and recurring obligations (CLAUDE.md §5.7, §7 B3).
 *
 * One form makes both note types: a `recurrence` of "does not repeat" writes an
 * `event`, anything else writes an `obligation`. They are the same act — "watch
 * this date for me" — and two forms would mean two places to forget the
 * `consequence` field §5.7 requires.
 */

import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { useState } from "preact/hooks";
import {
  RECURRENCE_UNITS,
  parseDate,
  type Recurrence,
  type RecurrenceUnit,
} from "../domain/events/recurrence";
import { PreactModal } from "./PreactModal";

export interface ObligationDraft {
  title: string;
  due: string;
  recurrence: Recurrence | null;
  leadDays: number[];
  owner: string;
  study: string;
  consequence: string;
}

export function emptyDraft(today: string, defaultLeads: readonly number[]): ObligationDraft {
  return {
    title: "",
    due: today,
    recurrence: null,
    leadDays: [...defaultLeads],
    owner: "",
    study: "",
    consequence: "",
  };
}

/** `90, 30, 7` → `[90, 30, 7]`. Anything unreadable is dropped, not guessed at. */
function parseLeads(value: string): number[] {
  return [
    ...new Set(
      value
        .split(/[,\s]+/)
        .map((part) => Number.parseInt(part, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 3650),
    ),
  ].sort((a, b) => b - a);
}

/**
 * What is wrong with the draft, in plain language.
 *
 * `consequence` is required for anything recurring and only for that: §5.7
 * attaches it to obligations, and demanding a paragraph about a one-off
 * submission deadline would train people to type "n/a".
 */
export function draftProblems(draft: ObligationDraft): string[] {
  const problems: string[] = [];

  if (draft.title.trim() === "") problems.push("Give it a title.");

  const dueOk = parseDate(draft.due.trim()) !== null;
  const anchorOk = draft.recurrence !== null && parseDate(draft.recurrence.anchor.trim()) !== null;
  if (!dueOk && !anchorOk) {
    problems.push("Set a date as YYYY-MM-DD — either the next one, or the rule's anchor.");
  }
  if (draft.due.trim() !== "" && !dueOk) {
    problems.push(`"${draft.due.trim()}" is not a date the calendar has.`);
  }

  if (draft.recurrence !== null) {
    if (draft.recurrence.every < 1) problems.push("Repeat every one or more units.");
    if (draft.consequence.trim() === "") {
      problems.push("§5.7 requires it: say what breaks if this lapses.");
    }
    if (draft.leadDays.length === 0) {
      problems.push("Give at least one lead time, or nothing will warn you before the day.");
    }
  }

  return problems;
}

function Form({
  initial,
  today,
  onSubmit,
  onCancel,
}: {
  initial: ObligationDraft;
  today: string;
  onSubmit: (draft: ObligationDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ObligationDraft>(initial);
  const [leadText, setLeadText] = useState(initial.leadDays.join(", "));

  const set = <K extends keyof ObligationDraft>(key: K, value: ObligationDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const repeats = draft.recurrence !== null;
  const rule: Recurrence = draft.recurrence ?? { every: 1, unit: "year", anchor: "" };
  const setRule = (patch: Partial<Recurrence>) =>
    set("recurrence", { ...rule, ...patch });

  const problems = draftProblems(draft);

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        A date the cockpit will watch. Nothing leaves the vault and nothing is sent — the
        reminder is a badge and a notice inside Obsidian.
      </p>

      <label class="scdb-field">
        <span class="scdb-field__label">Title</span>
        <input
          type="text"
          autofocus
          placeholder="DSRB continuing review"
          value={draft.title}
          onInput={(event) => set("title", (event.target as HTMLInputElement).value)}
        />
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Next date</span>
          <input
            type="text"
            placeholder={today}
            value={draft.due}
            onInput={(event) => set("due", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field scdb-field--inline">
          <span class="scdb-field__label">Repeats</span>
          <select
            class="dropdown"
            value={repeats ? "yes" : "no"}
            onChange={(event) =>
              set(
                "recurrence",
                (event.target as HTMLSelectElement).value === "yes"
                  ? { every: 1, unit: "year", anchor: "" }
                  : null,
              )
            }
          >
            <option value="no">Once only</option>
            <option value="yes">On a cycle</option>
          </select>
        </label>
      </div>

      {repeats && (
        <>
          <div class="scdb-field-row">
            <label class="scdb-field">
              <span class="scdb-field__label">Every</span>
              <input
                type="number"
                min="1"
                value={String(rule.every)}
                onInput={(event) =>
                  setRule({
                    every: Number.parseInt((event.target as HTMLInputElement).value, 10) || 1,
                  })
                }
              />
            </label>
            <label class="scdb-field">
              <span class="scdb-field__label">Unit</span>
              <select
                class="dropdown"
                value={rule.unit}
                onChange={(event) =>
                  setRule({ unit: (event.target as HTMLSelectElement).value as RecurrenceUnit })
                }
              >
                {RECURRENCE_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>
            <label class="scdb-field">
              <span class="scdb-field__label">Warn me (days before)</span>
              <input
                type="text"
                placeholder="90, 30, 7"
                value={leadText}
                onInput={(event) => {
                  const text = (event.target as HTMLInputElement).value;
                  setLeadText(text);
                  set("leadDays", parseLeads(text));
                }}
              />
            </label>
          </div>
          <p class="scdb-field__hint">
            {/* The anchor is what every occurrence is counted from, so a month
                end stays a month end instead of drifting. */}
            Counted from the next date above unless you set a different anchor.
          </p>

          <label class="scdb-field">
            <span class="scdb-field__label">What breaks if this lapses</span>
            <input
              type="text"
              placeholder="Study suspended if the review lapses."
              value={draft.consequence}
              onInput={(event) => set("consequence", (event.target as HTMLInputElement).value)}
            />
          </label>
        </>
      )}

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Owner</span>
          <input
            type="text"
            placeholder="[[Owner]]"
            value={draft.owner}
            onInput={(event) => set("owner", (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Study</span>
          <input
            type="text"
            placeholder="[[EuroHeart]]"
            value={draft.study}
            onInput={(event) => set("study", (event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      {problems.length > 0 && (
        <ul class="scdb-modal__list scdb-list--problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={problems.length > 0}
          onClick={() => onSubmit(draft)}
        >
          Create
        </button>
      </div>
    </div>
  );
}

class ObligationModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly config: { initial: ObligationDraft; today: string },
    private readonly resolve: (draft: ObligationDraft | null) => void,
  ) {
    super(app);
  }

  protected body() {
    return (
      <Form
        initial={this.config.initial}
        today={this.config.today}
        onSubmit={(draft) => this.finish(draft)}
        onCancel={() => this.finish(null)}
      />
    );
  }

  override onOpen(): void {
    this.titleEl.setText("New deadline");
    super.onOpen();
  }

  override onClose(): void {
    super.onClose();
    if (!this.decided) this.resolve(null);
  }

  private finish(draft: ObligationDraft | null): void {
    this.decided = true;
    this.resolve(draft);
    this.close();
  }
}

export function askObligation(
  app: App,
  initial: ObligationDraft,
  today: string,
): Promise<ObligationDraft | null> {
  return new Promise((resolve) => new ObligationModal(app, { initial, today }, resolve).open());
}

/* ------------------------------------------------------- calendar files -- */

export interface CalendarChoice {
  path: string;
  detail: string;
}

/**
 * Pick a calendar file to import.
 *
 * Only files **inside the vault** are offered. Reading an arbitrary path off
 * the disk would mean `fs`, which rule 8 forbids; dropping the export from
 * Outlook into the vault first is one extra step and keeps every read inside
 * Obsidian's own API.
 */
class CalendarPicker extends FuzzySuggestModal<CalendarChoice> {
  private decided = false;

  constructor(
    app: App,
    private readonly choices: CalendarChoice[],
    private readonly resolve: (choice: CalendarChoice | null) => void,
  ) {
    super(app);
    this.setPlaceholder(
      choices.length === 0
        ? "No .ics file in the vault — save one from Outlook into the vault first"
        : "Which calendar file?",
    );
  }

  getItems(): CalendarChoice[] {
    return this.choices;
  }

  getItemText(choice: CalendarChoice): string {
    return choice.path;
  }

  override renderSuggestion(match: FuzzyMatch<CalendarChoice>, el: HTMLElement): void {
    // createEl rather than innerHTML: these are vault paths (§8).
    el.createDiv({ cls: "scdb-suggest__title", text: match.item.path });
    el.createDiv({ cls: "scdb-suggest__sub", text: match.item.detail });
  }

  /**
   * Mark the choice made **before** the modal closes.
   *
   * `SuggestModal` closes first and calls `onChooseItem` afterwards, so an
   * `onClose` that resolves null on the way past wins the race and the picked
   * file is silently dropped — which is exactly what happened the first time
   * this ran: the picker closed and nothing else occurred. Setting the flag in
   * the override that runs first is the fix; the ordinary `Modal` pickers do
   * not need it because their own handler runs before `close()`.
   */
  override selectSuggestion(value: FuzzyMatch<CalendarChoice>, event: MouseEvent | KeyboardEvent): void {
    this.decided = true;
    super.selectSuggestion(value, event);
  }

  onChooseItem(choice: CalendarChoice): void {
    this.resolve(choice);
  }

  override onClose(): void {
    super.onClose();
    // Dismissal is never consent.
    if (!this.decided) this.resolve(null);
  }
}

export function pickCalendarFile(
  app: App,
  choices: readonly CalendarChoice[],
): Promise<CalendarChoice | null> {
  return new Promise((resolve) => new CalendarPicker(app, [...choices], resolve).open());
}
