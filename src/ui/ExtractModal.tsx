/**
 * Reviewing what was read out of a set of minutes, before anything is written
 * (CLAUDE.md §7 B6).
 *
 * Minutes are untrusted text in exactly the sense §2 rule 5 means: they are
 * typed fast, by hand, sometimes pasted from an email somebody else wrote. So
 * this dialog is the whole safety story — **every candidate is shown, every
 * one can be corrected, and every one can be unticked.** Nothing here is a
 * preview of a decision already taken.
 *
 * Three things it is careful about:
 *
 *  - **Where each item will land is shown, not chosen.** It follows from
 *    whether there is a date, so the rule is learnable from one look: give it
 *    a date and it becomes a deadline you get nagged about, leave it and it
 *    goes to the inbox to be triaged.
 *  - **A guessed date says it is a guess.** "by Friday" carries a badge that
 *    "2026-09-15" does not.
 *  - **Editing the wording does not make an item new.** Its identity is the
 *    line it came from, so correcting a title here cannot cause a second copy
 *    on the next run.
 */

import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import { ITEM_KINDS, type ExtractedItem, type ItemKind, type MinutesScan } from "../domain/extract/minutes";
import { destinationFor, type Destination, type ExtractionRecord } from "../domain/extract/plan";
import { PreactModal } from "./PreactModal";

export interface ExtractChoice {
  /** The meeting date every relative deadline was resolved against. */
  anchor: string;
  /** The items as the user left them — edits applied, keys unchanged. */
  items: ExtractedItem[];
  chosen: Set<string>;
}

export interface ExtractModalOptions {
  filename: string;
  anchor: string;
  anchorFrom: "frontmatter" | "filename" | "none";
  people: readonly string[];
  existing: readonly ExtractionRecord[];
  scan: (anchor: string) => MinutesScan;
  folders: { events: string; inbox: string };
}

interface Edit {
  kind: ItemKind;
  text: string;
  /** `YYYY-MM-DD`, or "" for none. */
  due: string;
  /** The owner reference as it will be written, or "" for nobody. */
  owner: string;
}

const KIND_LABEL: Record<ItemKind, string> = {
  action: "Action",
  decision: "Decision",
  deadline: "Deadline",
};

const DUE_BADGE: Record<string, string> = {
  iso: "",
  written: "",
  weekday: "read from a weekday",
  relative: "read from a phrase",
};

function editOf(item: ExtractedItem): Edit {
  return {
    kind: item.kind,
    text: item.text,
    due: item.due?.date ?? "",
    owner: item.owner?.ref ?? "",
  };
}

/** The item as the user has left it. The key never moves — see the header. */
function applyEdit(item: ExtractedItem, edit: Edit | undefined): ExtractedItem {
  if (edit === undefined) return item;
  const due =
    edit.due === ""
      ? null
      : edit.due === item.due?.date
        ? item.due
        : { date: edit.due, from: "iso" as const, phrase: edit.due };
  const owner =
    edit.owner === ""
      ? null
      : edit.owner === item.owner?.ref
        ? item.owner
        : { ref: edit.owner, name: edit.owner.replace(/^\[\[|\]\]$/g, ""), known: true };

  return { ...item, kind: edit.kind, text: edit.text, due, owner };
}

function whereLabel(destination: Destination, folders: { events: string; inbox: string }): string {
  if (destination === "decision") return "recorded on these minutes";
  return destination === "event" ? `new event in ${folders.events}` : `new capture in ${folders.inbox}`;
}

function Panel({
  options,
  onSubmit,
  onCancel,
}: {
  options: ExtractModalOptions;
  onSubmit: (choice: ExtractChoice) => void;
  onCancel: () => void;
}) {
  const [anchor, setAnchor] = useState(options.anchor);
  const [edits, setEdits] = useState<ReadonlyMap<string, Edit>>(new Map());
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());

  const scan = useMemo(() => options.scan(anchor), [options, anchor]);
  const seen = useMemo(
    () => new Map(options.existing.map((record) => [record.key, record])),
    [options.existing],
  );

  const fresh = scan.items.filter((item) => !seen.has(item.key));
  const already = scan.items.filter((item) => seen.has(item.key));
  const items = fresh.map((item) => applyEdit(item, edits.get(item.key)));
  const chosen = items.filter((item) => !dropped.has(item.key));

  const update = (key: string, item: ExtractedItem, patch: Partial<Edit>) =>
    setEdits((current) => {
      const next = new Map(current);
      next.set(key, { ...(current.get(key) ?? editOf(item)), ...patch });
      return next;
    });

  const toggle = (key: string) =>
    setDropped((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const counts = {
    event: chosen.filter((item) => destinationFor(item) === "event").length,
    capture: chosen.filter((item) => destinationFor(item) === "capture").length,
    decision: chosen.filter((item) => destinationFor(item) === "decision").length,
  };

  return (
    <div class="scdb-modal__body scdb-extract">
      <p class="scdb-modal__lede">
        Read from <code>{options.filename}</code> by rule, not by model. Nothing has been written.
        Correct anything that is wrong and untick anything that is not a job.
      </p>

      <label class="scdb-field scdb-extract__anchor">
        <span class="scdb-field__label">Meeting date</span>
        <input
          type="date"
          value={anchor}
          onInput={(event) => setAnchor((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          {options.anchorFrom === "none"
            ? "These minutes carry no date, so “by Friday” could not be resolved. Setting it here re-reads every line."
            : `From the note’s ${options.anchorFrom}. Every relative deadline below is counted from it, not from today.`}
        </span>
      </label>

      {fresh.length === 0 && (
        <p class="scdb-empty">
          {already.length > 0
            ? "Everything in these minutes has already been extracted — see below."
            : "Nothing to extract. Lines are read when they start with a marker — " +
              "Action, Task, Follow-up, Decision, Agreed, Decided, Deadline, Due, Milestone — " +
              "followed by a colon or a dash, or when they are an unticked checkbox."}
        </p>
      )}

      <div class="scdb-extract__list">
        {fresh.map((original) => {
          const item = applyEdit(original, edits.get(original.key));
          const on = !dropped.has(item.key);
          const destination = destinationFor(item);
          const badge = item.due === null ? "" : (DUE_BADGE[item.due.from] ?? "");

          return (
            <div class={`scdb-extract__item${on ? "" : " scdb-extract__item--off"}`} key={item.key}>
              <input
                type="checkbox"
                checked={on}
                aria-label="Extract this line"
                onChange={() => toggle(item.key)}
              />

              <div class="scdb-extract__body">
                <input
                  type="text"
                  class="scdb-extract__text"
                  value={item.text}
                  onInput={(event) =>
                    update(item.key, original, { text: (event.target as HTMLInputElement).value })
                  }
                />

                <div class="scdb-extract__controls">
                  <select
                    class="dropdown"
                    value={item.kind}
                    aria-label="Kind"
                    onChange={(event) =>
                      update(item.key, original, {
                        kind: (event.target as HTMLSelectElement).value as ItemKind,
                      })
                    }
                  >
                    {ITEM_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </option>
                    ))}
                  </select>

                  <select
                    class="dropdown"
                    value={item.owner?.ref ?? ""}
                    aria-label="Owner"
                    onChange={(event) =>
                      update(item.key, original, {
                        owner: (event.target as HTMLSelectElement).value,
                      })
                    }
                  >
                    <option value="">nobody</option>
                    {item.owner !== null && !options.people.includes(item.owner.name) && (
                      <option value={item.owner.ref}>{item.owner.name}</option>
                    )}
                    {options.people.map((person) => (
                      <option key={person} value={`[[${person}]]`}>
                        {person}
                      </option>
                    ))}
                  </select>

                  <input
                    type="date"
                    aria-label="Due"
                    value={item.due?.date ?? ""}
                    disabled={item.kind === "decision"}
                    onInput={(event) =>
                      update(item.key, original, { due: (event.target as HTMLInputElement).value })
                    }
                  />

                  <span class="scdb-extract__where">→ {whereLabel(destination, options.folders)}</span>
                  {badge !== "" && <span class="scdb-chip">{badge}</span>}
                </div>

                <div class="scdb-extract__src">
                  line {item.line}: <span class="scdb-muted">{item.raw}</span>
                </div>

                {item.problems
                  // A date problem that the user has since answered is stale,
                  // and "no deadline was set" beside a filled-in date field
                  // makes the reader distrust one of the two without knowing
                  // which. Owner problems stay: setting a date answers nothing
                  // about a name the vault could not resolve.
                  .filter((problem) => !(problem.about === "due" && item.due !== null))
                  .map((problem) => (
                    <p class="scdb-extract__problem" key={problem.message}>
                      {problem.message}
                    </p>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      {already.length > 0 && (
        <details class="scdb-extract__done">
          <summary>
            {already.length} line{already.length === 1 ? "" : "s"} already extracted from these
            minutes
          </summary>
          <ul class="scdb-modal__list">
            {already.map((item) => {
              const record = seen.get(item.key);
              return (
                <li key={item.key}>
                  <span class="scdb-num">line {item.line}</span> {item.text}
                  {record?.to === undefined ? "" : ` → ${record.to}`}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {scan.done > 0 && (
        <p class="scdb-field__hint">
          {scan.done} ticked checkbox{scan.done === 1 ? " was" : "es were"} left alone.
        </p>
      )}

      <div class="scdb-modal__actions">
        <span class="scdb-muted">
          {counts.event} event{counts.event === 1 ? "" : "s"}, {counts.capture} capture
          {counts.capture === 1 ? "" : "s"}, {counts.decision} decision
          {counts.decision === 1 ? "" : "s"}
        </span>
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={chosen.length === 0}
          onClick={() =>
            onSubmit({
              anchor,
              items,
              chosen: new Set(chosen.map((item) => item.key)),
            })
          }
        >
          Extract {chosen.length}
        </button>
      </div>
    </div>
  );
}

class ExtractModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly options: ExtractModalOptions,
    private readonly resolve: (choice: ExtractChoice | null) => void,
  ) {
    super(app);
    this.titleEl.setText("Extract from these minutes");
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal--wide");
    super.onOpen();
  }

  protected body() {
    return (
      <Panel
        options={this.options}
        onCancel={() => this.finish(null)}
        onSubmit={(choice) => this.finish(choice)}
      />
    );
  }

  override onClose(): void {
    super.onClose();
    // Closing the dialog is not agreeing to it.
    if (!this.decided) this.resolve(null);
  }

  private finish(choice: ExtractChoice | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(choice);
    this.close();
  }
}

export function reviewExtraction(
  app: App,
  options: ExtractModalOptions,
): Promise<ExtractChoice | null> {
  return new Promise((resolve) => new ExtractModal(app, options, resolve).open());
}
