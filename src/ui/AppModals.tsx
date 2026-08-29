import { Modal, type App } from "obsidian";
import { useState } from "preact/hooks";

import type { FieldChange, WriteProposal } from "../domain/apps/broker";
import type { AppManifest } from "../domain/apps/manifest";
import type { GrantCheck } from "../domain/apps/grant";
import { PreactModal } from "./PreactModal";

/**
 * Consent to run an app (§5.13, §7 F3).
 *
 * Rule 12 says code never runs without "showing what will run", so this dialog
 * shows three things and not fewer: the capabilities in words, what changed
 * since you last agreed, and the code itself. The code is behind a disclosure
 * rather than always open — a hundred lines above the buttons is a dialog
 * people scroll past — but it is *there*, on the screen where the decision is
 * made, rather than one navigation away.
 *
 * The confirm button says what it does. "OK" on a permission dialog is how
 * permission gets granted by muscle memory.
 */
export class GrantAppModal extends PreactModal {
  constructor(
    app: App,
    private readonly manifest: AppManifest,
    private readonly check: GrantCheck,
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  private decided = false;

  private finish(ok: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(ok);
    this.close();
  }

  override onClose(): void {
    super.onClose();
    // Dismissing with Escape or the X is a refusal, never a silent yes.
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
  }

  protected body() {
    const { manifest, check } = this;
    const widened = check.verdict === "widened";

    return (
      <div class="scdb-modal__body">
        <h2 class="scdb-modal__heading">{widened ? "This app now asks for more" : "Allow this app to run?"}</h2>

        <p>
          <strong>{manifest.title}</strong> <code>{manifest.id}</code>
        </p>
        {manifest.description !== "" && <p class="scdb-muted">{manifest.description}</p>}

        {widened && (
          <ul class="scdb-list scdb-list--problems">
            {check.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}

        <h3 class="scdb-modal__heading">What it will be able to do</h3>
        <ul class="scdb-list">
          <li>
            {manifest.capabilities.query.length === 0 ? (
              <>Read nothing. It has been granted no note types.</>
            ) : (
              <>
                Read every note of type{" "}
                <strong>{manifest.capabilities.query.join(", ")}</strong> — the same fields the
                boards show.
              </>
            )}
          </li>
          <li>
            {manifest.capabilities.write === "propose" ? (
              <>
                <strong>Propose</strong> changes to those notes. Each one is shown to you in full
                and written only if you confirm it.
              </>
            ) : (
              <>Change nothing. It cannot write to any note.</>
            )}
          </li>
          <li>
            No network, no filesystem, no access to any other note. It runs in a sandbox and
            everything it reads comes back through the plugin.
          </li>
        </ul>

        {manifest.problems.length > 0 && (
          <ul class="scdb-list scdb-list--problems">
            {manifest.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <details>
          <summary>Show the code that will run ({manifest.source.split("\n").length} lines)</summary>
          <pre class="scdb-code">{manifest.source}</pre>
        </details>

        <div class="scdb-modal__actions">
          <button type="button" class="scdb-control" onClick={() => this.finish(false)}>
            Cancel
          </button>
          <button type="button" class="mod-cta" onClick={() => this.finish(true)}>
            {widened ? "Allow the new access" : "Allow and run"}
          </button>
        </div>
      </div>
    );
  }
}

/**
 * An app has proposed a change (§5.13, rule 5).
 *
 * The dialog names the note, every field that would move, and both values —
 * before and after — because "confirm this change" without the old value is
 * not something anyone can weigh. The app's own stated reason is shown as
 * *its* claim, quoted and attributed, never as a fact.
 */
export class ProposeWriteModal extends PreactModal {
  private decided = false;

  constructor(
    app: App,
    private readonly manifest: AppManifest,
    private readonly proposal: WriteProposal,
    private readonly changes: FieldChange[],
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  private finish(ok: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(ok);
    this.close();
  }

  override onClose(): void {
    super.onClose();
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
  }

  protected body() {
    return (
      <div class="scdb-modal__body">
        <h2 class="scdb-modal__heading">{this.manifest.title} wants to change a note</h2>
        <p>
          <code>{this.proposal.path}</code>
        </p>

        <table class="scdb-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Now</th>
              <th>Would become</th>
            </tr>
          </thead>
          <tbody>
            {this.changes.map((change) => (
              <tr key={change.key}>
                <td>
                  <code>{change.key}</code>
                </td>
                <td class="scdb-muted">
                  {change.added ? "not set" : show(change.before)}
                </td>
                <td>{show(change.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {this.proposal.reason !== "" && (
          <p class="scdb-muted">
            The app says: “{this.proposal.reason}”
          </p>
        )}

        <p class="scdb-muted">
          Confirming writes this to the note and records it in the audit ledger against you, with
          the app named as the origin.
        </p>

        <div class="scdb-modal__actions">
          <button type="button" class="scdb-control" onClick={() => this.finish(false)}>
            No
          </button>
          <button type="button" class="mod-cta" onClick={() => this.finish(true)}>
            Make this change
          </button>
        </div>
      </div>
    );
  }
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "string") return value === "" ? "empty" : value;
  return JSON.stringify(value);
}

/** Create a new app note. Kept minimal — the note itself is where it is written. */
export class NewAppModal extends PreactModal {
  constructor(
    app: App,
    private readonly types: string[],
    private readonly resolve: (input: { id: string; title: string; description: string; types: string[] } | null) => void,
  ) {
    super(app);
  }

  private decided = false;

  private finish(value: { id: string; title: string; description: string; types: string[] } | null): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(value);
    this.close();
  }

  override onClose(): void {
    super.onClose();
    if (!this.decided) {
      this.decided = true;
      this.resolve(null);
    }
  }

  protected body() {
    return <NewAppForm types={this.types} onDone={(value) => this.finish(value)} />;
  }
}

function NewAppForm({
  types,
  onDone,
}: {
  types: string[];
  onDone: (value: { id: string; title: string; description: string; types: string[] } | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);

  const suggested = id.trim() === "" ? slug(title) : id.trim();

  return (
    <div class="scdb-modal__body">
      <h2 class="scdb-modal__heading">New vault app</h2>

      <label class="scdb-field">
        <span class="scdb-field__label">Title</span>
        <input
          type="text"
          value={title}
          placeholder="Turnaround explorer"
          onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Id</span>
        <input
          type="text"
          value={id}
          placeholder={suggested}
          onInput={(event) => setId((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Also the file name. Your permission for this app is recorded against it, so renaming it
          later means allowing the app again.
        </span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">What it is for</span>
        <input
          type="text"
          value={description}
          onInput={(event) => setDescription((event.target as HTMLInputElement).value)}
        />
      </label>

      <fieldset class="scdb-field">
        <legend class="scdb-field__label">Note types it may read</legend>
        <div class="scdb-field-row">
          {types.map((type) => (
            <label key={type} class="scdb-field scdb-field--inline">
              <input
                type="checkbox"
                checked={chosen.includes(type)}
                onChange={() =>
                  setChosen(
                    chosen.includes(type)
                      ? chosen.filter((entry) => entry !== type)
                      : [...chosen, type],
                  )
                }
              />
              {type}
            </label>
          ))}
        </div>
        <span class="scdb-field__hint">
          You can change this later in the note. Widening it will ask you again.
        </span>
      </fieldset>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={suggested === ""}
          onClick={() =>
            onDone({ id: suggested, title: title.trim(), description: description.trim(), types: chosen })
          }
        >
          Create
        </button>
      </div>
    </div>
  );
}

function slug(title: string): string {
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "" : `APP-${cleaned}`;
}

/**
 * A plain modal for the one case Preact would be ceremony: telling the person
 * an app has stopped answering, and offering to take it down.
 */
export class WedgedAppModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly detail: string,
    private readonly resolve: (stop: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.contentEl.createEl("h2", { text: `${this.title} has stopped responding` });
    this.contentEl.createEl("p", { text: this.detail });
    this.contentEl.createEl("p", {
      cls: "scdb-muted",
      text:
        "Closing it discards whatever it was showing. Nothing it had not already asked you to confirm has been written.",
    });

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const wait = actions.createEl("button", { cls: "scdb-control", text: "Keep waiting" });
    wait.addEventListener("click", () => this.finish(false));
    const stop = actions.createEl("button", { cls: "mod-warning", text: "Close the app" });
    stop.addEventListener("click", () => this.finish(true));
    stop.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
  }

  private finish(stop: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(stop);
    this.close();
  }
}
