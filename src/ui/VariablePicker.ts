import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { dataTypeLabel, variableLabel, type VariableNote } from "../domain/catalogue/variable";

/**
 * Pick a catalogue variable (§5.8, §7 C2).
 *
 * Ordered by domain and then id, the way the board is, so the list a command
 * opens matches the list the eye has already learned. The subtitle carries the
 * version, because the two commands that use this picker — revise, and what
 * was in force on a date — are both about which version is meant.
 */
export class VariablePicker extends FuzzySuggestModal<VariableNote> {
  constructor(
    app: App,
    private readonly variables: VariableNote[],
    private readonly onPick: (variable: VariableNote) => void,
  ) {
    super(app);
    this.setPlaceholder(
      variables.length === 0 ? "No variables in the catalogue" : "Which variable?",
    );
  }

  getItems(): VariableNote[] {
    return [...this.variables].sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.id.localeCompare(b.id) ||
        a.path.localeCompare(b.path),
    );
  }

  getItemText(variable: VariableNote): string {
    return `${variableLabel(variable)} ${variable.domain}`;
  }

  override renderSuggestion(match: FuzzyMatch<VariableNote>, el: HTMLElement): void {
    // createEl rather than innerHTML: these come out of note frontmatter (§8).
    const variable = match.item;
    el.createDiv({ cls: "scdb-suggest__title", text: variableLabel(variable) });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: [
        `v${variable.version || "?"}`,
        dataTypeLabel(variable.dataType),
        variable.domain || "no domain",
        variable.identifier ? "identifier" : "",
      ]
        .filter((part) => part !== "")
        .join(" · "),
    });
  }

  onChooseItem(variable: VariableNote): void {
    this.onPick(variable);
  }
}
