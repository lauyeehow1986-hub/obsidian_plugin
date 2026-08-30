/**
 * Reviewing a `.eml` import before anything is written (CLAUDE.md §5.10).
 *
 * This dialog is the plugin's answer to §2 rule 5 in its most literal form:
 * **the payload is shown first, and every line of it can be unticked.** An
 * email is untrusted text, and an importer that reads a folder and writes notes
 * without showing what it found is exactly the delivery mechanism rule 12
 * describes.
 *
 * What it shows for each message: when, which way, who, the subject, the thread
 * it will join or open, the requests it will link, and any attachment that will
 * be saved. What it does not show is the body — the review is about *what will
 * happen*, and pasting message text into a modal is not that.
 */

import type { App } from "obsidian";
import { useState } from "preact/hooks";
import { formatDuration } from "../domain/time/dates";
import type { EmlPreview, ThreadAction } from "../services/emlImport";
import { PreactModal } from "./PreactModal";

export interface EmlImportChoice {
  actions: ThreadAction[];
}

function when(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function senderOf(action: ThreadAction, index: number): string {
  const plan = action.plans[index];
  if (plan === undefined) return "";
  const from = plan.message.from[0];
  if (from === undefined) return "unknown sender";
  return from.name === "" ? from.address : from.name;
}

function Review({
  preview,
  attachmentsFolder,
  lede,
  onSubmit,
  onCancel,
}: {
  preview: EmlPreview;
  attachmentsFolder: string;
  lede: string;
  onSubmit: (choice: EmlImportChoice) => void;
  onCancel: () => void;
}) {
  // Keyed by thread id — the unit a person thinks in ("import this
  // conversation"), not by file, which is an implementation detail of how the
  // messages happen to have been saved.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(preview.actions.map((action) => action.threadId)),
  );

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selected = preview.actions.filter((action) => chosen.has(action.threadId));
  const messages = selected.reduce((n, action) => n + action.plans.length, 0);
  const attachments = selected.reduce(
    (n, action) => n + action.plans.reduce((m, plan) => m + plan.attachments.length, 0),
    0,
  );

  return (
    <div class="scdb-modal__body scdb-eml">
      <p class="scdb-modal__lede">
        {lede}
        {attachments > 0 && (
          <>
            {" "}
            Attachments go into <code>{attachmentsFolder}</code>.
          </>
        )}
      </p>

      <div class="scdb-eml__list">
        {preview.actions.map((action) => {
          const picked = chosen.has(action.threadId);
          const requests = [...new Set(action.plans.flatMap((plan) => plan.requests))];
          const files = action.plans.flatMap((plan) =>
            plan.attachments.map((attachment) => `${attachment.filename} (${attachment.sizeKb} KB)`),
          );
          const skipped = action.plans.flatMap((plan) => plan.skipped);

          return (
            <div class={`scdb-eml__thread${picked ? "" : " scdb-eml__thread--off"}`} key={action.threadId}>
              <label class="scdb-eml__head">
                <input
                  type="checkbox"
                  checked={picked}
                  onChange={() => toggle(action.threadId)}
                />
                <span class="scdb-eml__subject">{action.subject}</span>
              </label>

              <div class="scdb-eml__meta">
                <span class="scdb-chip">
                  {action.existing === null
                    ? `new thread ${action.threadId}`
                    : `joins ${action.threadId}`}
                </span>
                <span class="scdb-muted">
                  {action.plans.length} message{action.plans.length === 1 ? "" : "s"}
                </span>
                {requests.map((id) => (
                  <span class="scdb-chip" key={id}>
                    {id}
                  </span>
                ))}
              </div>

              <ul class="scdb-eml__messages">
                {action.plans.map((plan, index) => (
                  <li key={`${action.threadId}-${index}`}>
                    <span class="scdb-num">{when(plan.at)}</span>{" "}
                    <span
                      class={`scdb-chip${plan.direction === "inbound" ? "" : " scdb-chip--blocked"}`}
                    >
                      {plan.direction}
                    </span>{" "}
                    {senderOf(action, index)}
                    {plan.message.date === null && (
                      <span class="scdb-muted"> · no date in the file, using the file's own</span>
                    )}
                    {plan.message.messageId.startsWith("msg-local:") && (
                      // Some .msg files — drafts, internal Exchange items —
                      // carry no Message-ID at all, so one is derived from what
                      // the message contains. Worth saying: it is what stops a
                      // second import duplicating the message, and it is
                      // weaker than the real thing.
                      <span class="scdb-muted"> · no message id in the file, matched on content</span>
                    )}
                  </li>
                ))}
              </ul>

              {files.length > 0 && (
                <div class="scdb-eml__files">
                  <strong>Saves:</strong> {files.join(", ")}
                </div>
              )}
              {skipped.length > 0 && (
                <div class="scdb-eml__files scdb-muted">
                  <strong>Leaves behind:</strong> {skipped.join(" · ")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {preview.duplicates > 0 && (
        <p class="scdb-muted">
          {preview.duplicates} message{preview.duplicates === 1 ? " is" : "s are"} already recorded
          on {preview.duplicates === 1 ? "its" : "their"} thread and will be skipped.
        </p>
      )}

      {preview.unreadable.length > 0 && (
        <div class="scdb-section--problems">
          <div class="scdb-section__title">Not a readable message</div>
          <ul class="scdb-modal__list">
            {preview.unreadable.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.problems.length > 0 && (
        <details class="scdb-eml__problems">
          <summary>
            {preview.problems.length} note{preview.problems.length === 1 ? "" : "s"} on what could
            not be read
          </summary>
          <ul class="scdb-modal__list scdb-list--problems">
            {preview.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      )}

      <div class="scdb-modal__actions">
        <span class="scdb-muted">
          {messages} message{messages === 1 ? "" : "s"} into {selected.length} thread
          {selected.length === 1 ? "" : "s"}
          {attachments > 0 ? `, ${attachments} attachment${attachments === 1 ? "" : "s"}` : ""}
        </span>
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={selected.length === 0}
          onClick={() => onSubmit({ actions: selected })}
        >
          Import
        </button>
      </div>
    </div>
  );
}

class EmlImportModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly config: {
      preview: EmlPreview;
      attachmentsFolder: string;
      title: string;
      lede: string;
    },
    private readonly resolve: (choice: EmlImportChoice | null) => void,
  ) {
    super(app);
  }

  protected body() {
    return (
      <Review
        preview={this.config.preview}
        attachmentsFolder={this.config.attachmentsFolder}
        lede={this.config.lede}
        onSubmit={(choice) => this.finish(choice)}
        onCancel={() => this.finish(null)}
      />
    );
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal--wide");
    this.titleEl.setText(this.config.title);
    super.onOpen();
  }

  override onClose(): void {
    super.onClose();
    // Dismissal is never consent.
    if (!this.decided) this.resolve(null);
  }

  private finish(choice: EmlImportChoice | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(choice);
    this.close();
  }
}

/**
 * The review, whichever route the messages arrived by.
 *
 * One dialog for the file import and the Outlook sync deliberately: they show
 * the same facts, they are approved on the same terms, and a second dialog
 * would be a second place for the "every line can be unticked" rule to drift.
 * Only the title differs, because what the user is agreeing to differs.
 */
/** What the file import is asking the user to agree to. */
export const FILE_LEDE =
  "Read from files already in this vault. Nothing was fetched and nothing will be sent. " +
  "Untick anything you do not want; the message text goes into the thread note, and " +
  "attachments are saved alongside it.";

/**
 * What a sync is asking, which is not the same thing.
 *
 * It names the two facts a reader of a mailbox import needs and cannot see:
 * that Outlook was read rather than a file, and that the attachments are still
 * sitting in the mailbox. An attachment nobody mentions is an attachment
 * somebody assumes was saved.
 */
export const OUTLOOK_LEDE =
  "Read from the Outlook session already open on this machine. Nothing left the machine and " +
  "nothing was sent, moved or marked as read. Untick anything you do not want; message text " +
  "goes into the thread note, and any attachments stay in Outlook.";

export function reviewEmlImport(
  app: App,
  preview: EmlPreview,
  attachmentsFolder: string,
  title = "Import saved email",
  lede = FILE_LEDE,
): Promise<EmlImportChoice | null> {
  return new Promise((resolve) =>
    new EmlImportModal(app, { preview, attachmentsFolder, title, lede }, resolve).open(),
  );
}

/* --------------------------------------------------------- file picking -- */

export interface EmlFileChoice {
  path: string;
  detail: string;
}

/** A short human size for the picker. Shared with the folder summary. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "modified 3 days ago", for the picker line. */
export function agoLabel(mtime: number, now: number): string {
  const gap = now - mtime;
  return gap < 60_000 ? "just now" : `${formatDuration(gap)} ago`;
}
