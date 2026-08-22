import { Modal, Notice, type App } from "obsidian";
import { renderReport, summarise, tally, type DiagnosticsReport } from "../domain/diagnostics/report";

/**
 * The diagnostics report, on screen (CLAUDE.md §7 A4).
 *
 * Shown as the markdown that would be pasted, not as a prettier rendering of
 * it. The acceptance criterion for A4 is "copy-pasteable into a message", and
 * the only way to be sure of that is for the thing on screen to be the thing on
 * the clipboard.
 *
 * `createEl` with text, never `innerHTML` (§8) — the report carries note names
 * out of the vault, which is exactly the content that rule exists for.
 */
export interface DiagnosticsActions {
  onSave: (markdown: string, checks: number) => Promise<void>;
}

export class DiagnosticsModal extends Modal {
  constructor(
    app: App,
    private readonly report: DiagnosticsReport,
    private readonly actions: DiagnosticsActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.modalEl.addClass("scdb-modal--wide");
    this.titleEl.setText("Diagnostics");

    const markdown = renderReport(this.report);
    const counts = tally(this.report);
    const checks = counts.ok + counts.warn + counts.problem + counts.unavailable;

    this.contentEl.createEl("p", { cls: "scdb-modal__lede", text: summarise(this.report) });

    const pre = this.contentEl.createEl("pre", { cls: "scdb-diagnostics" });
    pre.createEl("code", { text: markdown });

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });

    const close = actions.createEl("button", { cls: "scdb-control", text: "Close" });
    close.addEventListener("click", () => this.close());

    const save = actions.createEl("button", { cls: "scdb-control", text: "Save to the vault" });
    save.addEventListener("click", () => {
      void this.actions.onSave(markdown, checks).then(() => this.close());
    });

    const copy = actions.createEl("button", { cls: "mod-cta", text: "Copy" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(markdown).then(
        () => new Notice("SCDB: diagnostics report copied.", 4000),
        // A clipboard that refuses is exactly the sort of thing this report is
        // for, so say so rather than letting the button appear to work.
        () =>
          new Notice(
            "SCDB: could not write to the clipboard. Use “Save to the vault” instead.",
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
