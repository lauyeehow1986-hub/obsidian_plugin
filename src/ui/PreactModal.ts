import { Modal, type App } from "obsidian";
import { render, type ComponentChild } from "preact";

/**
 * A Modal whose body is a Preact tree.
 *
 * Preact needs an explicit unmount when the modal closes, or effects and
 * subscriptions in the tree outlive the dialog.
 */
export abstract class PreactModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  protected abstract body(): ComponentChild;

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    render(this.body(), this.contentEl);
  }

  override onClose(): void {
    render(null, this.contentEl);
    this.contentEl.empty();
  }
}
