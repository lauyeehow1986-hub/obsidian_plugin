import { Modal, type App } from "obsidian";
import {
  describeFindings,
  summariseIntegrity,
  type Finding,
  type Repair,
} from "../domain/integrity/links";

/**
 * Link and reference integrity, on screen (CLAUDE.md §7 A4).
 *
 * Grouped by kind and worst first, because the list is read to answer "is
 * anything actually broken?" — and forty unresolved `[[Dr A Tan]]` links must
 * not bury one duplicated uid.
 *
 * There is exactly one button that changes anything, and it only ever creates
 * notes. Everything else is a report with the remedy written out, which is what
 * "report and offer repairs; never auto-delete" means when the fixes are
 * judgement calls.
 */
export interface IntegrityActions {
  onOpenNote: (path: string) => void;
  onRepair: (repairs: readonly Repair[]) => Promise<void>;
}

const SHOWN_PER_KIND = 8;

export class IntegrityModal extends Modal {
  constructor(
    app: App,
    private readonly findings: readonly Finding[],
    private readonly actions: IntegrityActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("scdb-modal");
    this.modalEl.addClass("scdb-modal--wide");
    this.titleEl.setText("Link and reference integrity");

    const summary = summariseIntegrity(this.findings);

    if (summary.total === 0) {
      this.contentEl.createEl("p", {
        cls: "scdb-modal__lede",
        text:
          "Nothing to report. Every wikilink in frontmatter resolves, every uid is unique, " +
          "and every audit entry names a note that still exists.",
      });
      this.closeRow();
      return;
    }

    this.contentEl.createEl("p", {
      cls: "scdb-modal__lede",
      text: `${summary.total} finding${summary.total === 1 ? "" : "s"}: ${summary.byKind
        .map((entry) => describeFindings(entry.kind, entry.count))
        .join(", ")}.`,
    });

    for (const { kind, count } of summary.byKind) {
      const group = this.contentEl.createDiv({ cls: "scdb-group" });
      group.createEl("h3", {
        cls: "scdb-group__title",
        text: describeFindings(kind, count),
      });

      const list = group.createEl("ul", { cls: "scdb-list" });
      const mine = this.findings.filter((finding) => finding.kind === kind);
      for (const finding of mine.slice(0, SHOWN_PER_KIND)) {
        const item = list.createEl("li");
        if (finding.path === "") {
          item.createSpan({ cls: "scdb-card__id", text: finding.subject });
        } else {
          const link = item.createEl("button", { cls: "scdb-link", text: finding.path });
          link.addEventListener("click", () => {
            this.actions.onOpenNote(finding.path);
            this.close();
          });
        }
        item.createSpan({ text: ` — ${finding.message}` });
      }
      if (mine.length > SHOWN_PER_KIND) {
        group.createEl("p", {
          cls: "scdb-muted",
          text: `…and ${mine.length - SHOWN_PER_KIND} more.`,
        });
      }
    }

    if (summary.repairs.length > 0) {
      // Every path named before the button is pressed. The repair is additive
      // and reversible, but "creates ten notes" still has to be readable as
      // ten specific notes rather than as a number.
      this.contentEl.createEl("p", {
        cls: "scdb-muted scdb-repairs",
        text: `Would create: ${summary.repairs.map((entry) => entry.path).join(", ")}`,
      });
    }

    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const close = actions.createEl("button", { cls: "scdb-control", text: "Close" });
    close.addEventListener("click", () => this.close());

    if (summary.repairs.length > 0) {
      const repair = actions.createEl("button", {
        cls: "mod-cta",
        text: `Create ${summary.repairs.length} missing note${summary.repairs.length === 1 ? "" : "s"}`,
      });
      repair.addEventListener("click", () => {
        void this.actions.onRepair(summary.repairs).then(() => this.close());
      });
    }
  }

  private closeRow(): void {
    const actions = this.contentEl.createDiv({ cls: "scdb-modal__actions" });
    const close = actions.createEl("button", { cls: "mod-cta", text: "Close" });
    close.addEventListener("click", () => this.close());
    close.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
