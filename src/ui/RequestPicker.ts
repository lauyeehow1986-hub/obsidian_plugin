import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import type { IndexEntry } from "../data/requestIndex";
import { stageLabelOf, type WorkflowSpec } from "../domain/request/workflow";

/**
 * Pick a request (§7 D1).
 *
 * Ordered with the open ones first and the most recently moved at the top of
 * those: the request somebody wants to draw is nearly always the one that just
 * caused an argument, and a delivered request from March at the top of the list
 * is a mis-click away from the wrong picture.
 */
export class RequestPicker extends FuzzySuggestModal<IndexEntry> {
  constructor(
    app: App,
    private readonly entries: IndexEntry[],
    private readonly spec: WorkflowSpec | null,
    private readonly onPick: (entry: IndexEntry) => void,
    placeholder = "Which request?",
  ) {
    super(app);
    this.setPlaceholder(entries.length === 0 ? "No requests in the vault" : placeholder);
  }

  getItems(): IndexEntry[] {
    const lastMove = (entry: IndexEntry): number =>
      entry.request.history[entry.request.history.length - 1]?.at ?? 0;
    return [...this.entries].sort((a, b) => lastMove(b) - lastMove(a) || a.request.id.localeCompare(b.request.id));
  }

  getItemText(entry: IndexEntry): string {
    return `${entry.request.id} ${entry.request.title}`;
  }

  override renderSuggestion(match: FuzzyMatch<IndexEntry>, el: HTMLElement): void {
    // createEl rather than innerHTML: titles come out of note frontmatter (§8).
    const { request } = match.item;
    el.createDiv({
      cls: "scdb-suggest__title",
      text: `${request.id || request.uid} — ${request.title || "(untitled)"}`,
    });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: `${stageLabelOf(this.spec, request.stage)} · ${request.history.length} recorded move${request.history.length === 1 ? "" : "s"}`,
    });
  }

  onChooseItem(entry: IndexEntry): void {
    this.onPick(entry);
  }
}
