import { Modal, Notice, type App } from "obsidian";
import { modeInfo } from "../domain/settings/mode";
import type { Mode } from "../domain/settings/schema";

/**
 * Quick capture (CLAUDE.md §7 B1): one hotkey, one line, gone.
 *
 * Plain DOM rather than Preact, and one control rather than a form. Both are
 * the same decision: this dialog is on the critical path of a two-second
 * interaction, and every element added to it is a thing the eye has to skip
 * past while somebody is standing in the doorway.
 *
 * Enter saves. Escape discards. There is no Save button, because reaching for
 * the mouse is the cost this feature exists to remove — but the hint line says
 * so, since an unlabelled interaction is only obvious to the person who wrote
 * it.
 *
 * The dialog closes before the write completes. That is deliberate: `capture`
 * cannot block, and a failed write reports itself in a notice that names what
 * was typed, so nothing is lost silently.
 */
export class CaptureModal extends Modal {
  private input: HTMLInputElement | null = null;

  constructor(
    app: App,
    private readonly mode: Mode,
    private readonly onCapture: (text: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.modalEl.addClass("scdb-modal--capture");
    this.titleEl.setText(`Capture · ${modeInfo(this.mode).label}`);

    const input = this.contentEl.createEl("input", {
      cls: "scdb-capture__input",
      attr: {
        type: "text",
        placeholder: "What just came up?",
        // The one line is the whole note; browsers autocompleting it from a
        // previous capture would be actively unhelpful.
        autocomplete: "off",
        spellcheck: "true",
      },
    });
    this.input = input;

    this.contentEl.createDiv({
      cls: "scdb-capture__hint",
      text: "Enter to file it in the inbox · Escape to discard",
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const text = input.value.trim();
      if (text === "") {
        this.close();
        return;
      }
      this.close();
      this.onCapture(text);
    });

    input.focus();
  }

  override onClose(): void {
    this.input = null;
    this.contentEl.empty();
  }
}

/** The notice shown when a capture could not be written, carrying the text back. */
export function captureFailed(text: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  // The typed line is echoed so it can be pasted somewhere rather than retyped.
  // It is the user's own words, not vault content read back (rule 7).
  new Notice(`SCDB: the capture was not saved (${reason}).\n\n${text}`, 20000);
}
