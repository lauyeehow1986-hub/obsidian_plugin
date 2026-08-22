import { Modal, type App } from "obsidian";
import { formatBytes } from "../domain/backup/snapshots";
import type { SnapshotFile } from "../services/backup.js";

/**
 * The two dialogs the backup commands need (CLAUDE.md §7 A4).
 *
 * Plain DOM rather than Preact, matching `ConfirmModal`: a passphrase field and
 * a list of file names do not need a component tree, and `createEl` escapes its
 * text (§8).
 *
 * Both resolve on dismissal — Escape or the X can never read as consent.
 */

export interface PassphraseRequest {
  title: string;
  /** What is about to happen, in one or two sentences. */
  lede: string;
  /** True when the passphrase is being *set*: adds a confirmation field. */
  confirm: boolean;
  actionLabel: string;
}

class PassphraseModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly request: PassphraseRequest,
    private readonly resolve: (passphrase: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.titleEl.setText(this.request.title);
    this.contentEl.createEl("p", { cls: "scdb-modal__lede", text: this.request.lede });

    if (this.request.confirm) {
      // Said plainly and without softening. There is no recovery path, no
      // escrow and no reset — the passphrase is not stored anywhere, which is
      // the property that makes the file safe to leave in a Downloads folder.
      this.contentEl.createEl("p", {
        cls: "scdb-modal__warning",
        text:
          "This passphrase is never stored. If you lose it the snapshot cannot be opened by " +
          "anyone, including you. Keep it somewhere you would keep a key, not in the vault.",
      });
    }

    const first = this.field("Passphrase");
    const second = this.request.confirm ? this.field("Passphrase again") : null;

    const error = this.contentEl.createEl("p", { cls: "scdb-modal__error" });
    error.hide();

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const cancel = actions.createEl("button", { cls: "scdb-control", text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(null));

    const go = actions.createEl("button", { cls: "mod-cta", text: this.request.actionLabel });

    const submit = (): void => {
      const value = first.value;
      if (value === "") {
        error.setText("Type a passphrase.");
        error.show();
        return;
      }
      if (second !== null && second.value !== value) {
        error.setText("The two passphrases do not match.");
        error.show();
        return;
      }
      if (this.request.confirm && value.length < 8) {
        // Not a policy, a floor. The KDF is deliberately slow, but four
        // characters is guessable however slow the derivation is.
        error.setText("Use at least 8 characters.");
        error.show();
        return;
      }
      this.finish(value);
    };

    go.addEventListener("click", submit);
    for (const input of [first, second]) {
      input?.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
    }
    first.focus();
  }

  private field(label: string): HTMLInputElement {
    const row = this.contentEl.createDiv({ cls: "scdb-field" });
    row.createEl("label", { text: label });
    return row.createEl("input", {
      cls: "scdb-field__input",
      attr: {
        type: "password",
        // Nothing about this should reach a password manager or a form-fill
        // heuristic: it is not an account credential and there is no account.
        autocomplete: "off",
        spellcheck: "false",
      },
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(null);
  }

  private finish(value: string | null): void {
    this.decided = true;
    this.resolve(value);
    this.close();
  }
}

export function askPassphrase(app: App, request: PassphraseRequest): Promise<string | null> {
  return new Promise((resolve) => new PassphraseModal(app, request, resolve).open());
}

class SnapshotPicker extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly snapshots: readonly SnapshotFile[],
    private readonly lede: string,
    private readonly resolve: (name: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.titleEl.setText("Choose a snapshot");
    this.contentEl.createEl("p", { cls: "scdb-modal__lede", text: this.lede });

    const list = this.contentEl.createEl("ul", { cls: "scdb-modal__list scdb-snapshots" });
    for (const snapshot of this.snapshots) {
      const item = list.createEl("li");
      const button = item.createEl("button", { cls: "scdb-control scdb-snapshot" });
      button.createSpan({ cls: "scdb-snapshot__name", text: snapshot.name });
      button.createSpan({
        cls: "scdb-snapshot__meta scdb-num",
        text: `${new Date(snapshot.at).toLocaleString()} · ${formatBytes(snapshot.bytes)}`,
      });
      button.addEventListener("click", () => this.finish(snapshot.name));
    }

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const cancel = actions.createEl("button", { cls: "scdb-control", text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(null));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(null);
  }

  private finish(name: string | null): void {
    this.decided = true;
    this.resolve(name);
    this.close();
  }
}

export function pickSnapshot(
  app: App,
  snapshots: readonly SnapshotFile[],
  lede: string,
): Promise<string | null> {
  return new Promise((resolve) => new SnapshotPicker(app, snapshots, lede, resolve).open());
}
