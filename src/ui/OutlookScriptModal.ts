import { Modal, Notice, type App } from "obsidian";
import { disclosure } from "../services/outlookBridge.js";

/**
 * "Show me exactly what would run" (CLAUDE.md §5.10 Tier 2).
 *
 * The Outlook reader starts `powershell.exe` with a base64 argument. On a
 * managed laptop that is a shape endpoint monitoring is built to notice, and
 * the person who has to answer for it is the one sitting at the machine. This
 * is what they answer with: the plaintext of both scripts, the command line,
 * and the four environment variables, on the clipboard in one press.
 *
 * It is deliberately reachable **whether or not the reader is switched on** and
 * without reading a single message, so the question "what would this do" can be
 * settled before granting anything — the same argument §11 makes for the mailto
 * and Teams test buttons.
 *
 * Built from the constants the spawn itself uses, so it cannot describe
 * something other than what runs. `createEl` with text, never `innerHTML` (§8).
 */
export class OutlookScriptModal extends Modal {
  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.modalEl.addClass("scdb-modal--wide");
    this.titleEl.setText("What the Outlook reader runs");

    const text = disclosure();

    this.contentEl.createEl("p", {
      cls: "scdb-modal__lede",
      text:
        "This is the whole of it. If your machine flags Obsidian for starting PowerShell, " +
        "decode the base64 from the alert and compare it with the script below — they match " +
        "exactly, because the script is a constant and nothing is ever added to it.",
    });

    const pre = this.contentEl.createEl("pre", { cls: "scdb-diagnostics" });
    pre.createEl("code", { text });

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });

    const close = actions.createEl("button", { cls: "scdb-control", text: "Close" });
    close.addEventListener("click", () => this.close());

    const copy = actions.createEl("button", { cls: "mod-cta", text: "Copy" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(text).then(
        () => new Notice("SCDB: copied. Paste it wherever it needs to go.", 4000),
        () =>
          new Notice(
            "SCDB: could not write to the clipboard. Select the text above and copy it instead.",
            8000,
          ),
      );
    });
    copy.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
