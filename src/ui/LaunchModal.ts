import { Modal, Notice, type App } from "obsidian";
import type { LaunchTarget } from "../domain/launch/target.js";
import type { Launcher } from "../services/launcher.js";

export interface LaunchRequest {
  targets: readonly LaunchTarget[];
  /** Reads the note field a target names, or "" when the note has no such field. */
  valueFor: (target: LaunchTarget) => string;
  /** What goes in the ledger's `subject` — the request id, or the note path. */
  subject: string;
  confirm: boolean;
}

/**
 * Choosing a target, seeing where it goes, and only then opening it
 * (CLAUDE.md §5.16 rule 7).
 *
 * Two panes rather than one: the list of what applies to this note, then the
 * **resolved** destination in full. The second pane is the point. A label like
 * "Open SOP" tells you nothing about which file is about to open, and a path
 * that has been through `realpath` is frequently not the path written in the
 * note — that is exactly the case worth showing a person before anything
 * happens.
 *
 * The destination shown comes from `launcher.resolve`, which is the same call
 * `launcher.open` makes. Recomputing it here would be a second implementation
 * of "what will open", and a dialog that tells the truth about something other
 * than what happens next is worse than no dialog.
 *
 * `createEl` with text throughout, never `innerHTML` — the destination is
 * partly vault-derived (§8).
 */
export class LaunchModal extends Modal {
  constructor(
    app: App,
    private readonly launcher: Launcher,
    private readonly request: LaunchRequest,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.titleEl.setText("Open externally");

    if (this.request.targets.length === 0) {
      // Empty states matter (§6): say what this is and what to do next.
      this.contentEl.createEl("p", {
        cls: "scdb-empty",
        text:
          "Nothing is configured to open from this note. Launch targets live in " +
          "_config/launchers.yaml — settings has a starter you can adapt.",
      });
      return;
    }

    this.renderChoices();
  }

  private renderChoices(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      cls: "scdb-modal__lede",
      text: "Choose what to open. You will see the exact destination before anything happens.",
    });

    const list = this.contentEl.createDiv({ cls: "scdb-launch__list" });
    for (const target of this.request.targets) {
      const button = list.createEl("button", { cls: "scdb-control", text: target.label });
      button.createSpan({ cls: "scdb-launch__kind", text: ` ${target.kind}` });
      button.addEventListener("click", () => void this.choose(target));
    }
  }

  private async choose(target: LaunchTarget): Promise<void> {
    const value = this.request.valueFor(target);

    if (!this.request.confirm) {
      await this.run(target, value);
      return;
    }

    const decision = await this.launcher.resolve(target, value);
    this.contentEl.empty();

    if (!decision.ok) {
      // A refusal is shown, never swallowed: a launcher that quietly declines
      // is indistinguishable from one that is broken (§8, errors reach the
      // user as plain language plus a next action).
      //
      // And it is logged here rather than left to `open`, which a refusal never
      // reaches while this dialog is on. Without this the ledger row §5.6
      // promises for a refused launch would exist only for people who had
      // turned the dialog off.
      void this.launcher.logRefusal(target, this.request.subject, decision.why);
      this.contentEl.createEl("p", { cls: "scdb-modal__lede", text: decision.why });
      this.actions(null, target, value);
      return;
    }

    this.contentEl.createEl("p", {
      cls: "scdb-modal__lede",
      text: `${target.label} will open:`,
    });
    const pre = this.contentEl.createEl("pre", { cls: "scdb-diagnostics" });
    pre.createEl("code", { text: decision.destination });
    this.actions(decision.destination, target, value);
  }

  private actions(destination: string | null, target: LaunchTarget, value: string): void {
    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });

    const back = actions.createEl("button", { cls: "scdb-control", text: "Back" });
    back.addEventListener("click", () => this.renderChoices());

    if (destination === null) return;

    const open = actions.createEl("button", { cls: "mod-cta", text: "Open" });
    open.addEventListener("click", () => void this.run(target, value));
    open.focus();
  }

  private async run(target: LaunchTarget, value: string): Promise<void> {
    const result = await this.launcher.open(target, value, this.request.subject);
    this.close();
    if (!result.ok) new Notice(`SCDB: ${result.why}`, 8000);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
