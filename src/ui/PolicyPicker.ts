import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { policyLabel, statusLabel, type PolicyNote } from "../domain/policy/policy";

/**
 * Pick a policy to revise (CLAUDE.md §7 C1).
 *
 * Ordered as the register orders it — the ones in force first — because a
 * circular almost always revises something currently in force, and a
 * superseded policy at the top of the list is one mis-click from a frozen copy
 * of the wrong document.
 */
export class PolicyPicker extends FuzzySuggestModal<PolicyNote> {
  constructor(
    app: App,
    private readonly policies: PolicyNote[],
    private readonly onPick: (policy: PolicyNote) => void,
  ) {
    super(app);
    this.setPlaceholder(
      policies.length === 0 ? "No policy notes in the vault" : "Which policy has been reissued?",
    );
  }

  getItems(): PolicyNote[] {
    return [...this.policies].sort(
      (a, b) =>
        Number(b.status === "current") - Number(a.status === "current") ||
        a.id.localeCompare(b.id) ||
        a.path.localeCompare(b.path),
    );
  }

  getItemText(policy: PolicyNote): string {
    return policyLabel(policy);
  }

  override renderSuggestion(match: FuzzyMatch<PolicyNote>, el: HTMLElement): void {
    // createEl rather than innerHTML: these come out of note frontmatter (§8).
    const policy = match.item;
    el.createDiv({ cls: "scdb-suggest__title", text: policyLabel(policy) });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: `version ${policy.version || "?"} · ${statusLabel(policy.status)}`,
    });
  }

  onChooseItem(policy: PolicyNote): void {
    this.onPick(policy);
  }
}
