import { Modal, type App } from "obsidian";

/**
 * A one-line confirmation for an action that writes outside the note you are
 * looking at — today, an export (§7 A3).
 *
 * Resolves false on dismissal, so closing the dialog with Escape or the X can
 * never be mistaken for consent. Plain DOM rather than Preact: a modal with one
 * sentence and two buttons does not need a component tree, and `createEl`
 * escapes its text (§8, never `innerHTML` with vault-derived content).
 */
export class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.contentEl.createEl("p", { cls: "scdb-modal__lede", text: this.message });

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const cancel = actions.createEl("button", { cls: "scdb-control", text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));

    const confirm = actions.createEl("button", { cls: "mod-cta", text: this.confirmLabel });
    confirm.addEventListener("click", () => this.finish(true));
    confirm.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(false);
  }

  private finish(ok: boolean): void {
    this.decided = true;
    this.resolve(ok);
    this.close();
  }
}

export function confirm(app: App, message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, message, confirmLabel, resolve).open());
}
