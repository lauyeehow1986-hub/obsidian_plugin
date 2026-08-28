import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { type WorkflowSpec } from "../domain/request/workflow";

/**
 * Pick a workflow spec (§7 D1).
 *
 * Only reached when more than one spec is installed. With one, the caller draws
 * it without asking — and with none there is nothing to ask about. The same
 * reasoning `WorkflowStore.only()` uses: a vault with several specs is one where
 * guessing which was meant produces a diagram of the wrong process.
 */
export class WorkflowPicker extends FuzzySuggestModal<WorkflowSpec> {
  constructor(
    app: App,
    private readonly specs: WorkflowSpec[],
    private readonly onPick: (spec: WorkflowSpec) => void,
  ) {
    super(app);
    this.setPlaceholder("Which workflow?");
  }

  getItems(): WorkflowSpec[] {
    return [...this.specs].sort((a, b) => a.id.localeCompare(b.id));
  }

  getItemText(spec: WorkflowSpec): string {
    return `${spec.label} ${spec.id}`;
  }

  override renderSuggestion(match: FuzzyMatch<WorkflowSpec>, el: HTMLElement): void {
    // createEl rather than innerHTML: labels come out of a YAML file (§8).
    const spec = match.item;
    el.createDiv({ cls: "scdb-suggest__title", text: spec.label || spec.id });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: `${spec.id} · version ${spec.version} · ${spec.stages.length} stages`,
    });
  }

  onChooseItem(spec: WorkflowSpec): void {
    this.onPick(spec);
  }
}
