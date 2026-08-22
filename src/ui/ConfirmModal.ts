import { Modal, type App } from "obsidian";

/**
 * A confirmation for an action that writes outside the note you are looking at
 * — an export (§7 A3), or generating the Bases dashboards (§7 A2b).
 *
 * Resolves false on dismissal, so closing the dialog with Escape or the X can
 * never be mistaken for consent. Plain DOM rather than Preact: a modal with a
 * short message and two buttons does not need a component tree, and `createEl`
 * escapes its text (§8, never `innerHTML` with vault-derived content).
 *
 * The message may be several lines. Callers that list what is about to be
 * written pass one `• ` line per file, and those must render as a list — a
 * confirmation whose whole point is "here is exactly what will be created" is
 * useless if it collapses into a run-on paragraph.
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
    this.renderMessage();

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const cancel = actions.createEl("button", { cls: "scdb-control", text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));

    const confirm = actions.createEl("button", { cls: "mod-cta", text: this.confirmLabel });
    confirm.addEventListener("click", () => this.finish(true));
    confirm.focus();
  }

  /**
   * One element per line, so line breaks survive. Consecutive `• ` lines gather
   * into a single `<ul>`; everything else is a paragraph. Blank lines are only
   * spacing in the source string and are dropped — the gap comes from CSS.
   */
  private renderMessage(): void {
    let list: HTMLElement | null = null;

    for (const line of this.message.split("\n")) {
      const text = line.trim();
      if (text === "") {
        list = null;
        continue;
      }
      if (text.startsWith("•")) {
        list ??= this.contentEl.createEl("ul", { cls: "scdb-modal__list" });
        list.createEl("li", { text: text.replace(/^•\s*/, "") });
        continue;
      }
      list = null;
      this.contentEl.createEl("p", { cls: "scdb-modal__lede", text });
    }
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
