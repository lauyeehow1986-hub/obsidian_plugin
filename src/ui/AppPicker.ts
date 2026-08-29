import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";

import { STATE_LABELS, type AppAssessment } from "../domain/apps/register";

/**
 * Pick a vault app (§5.13, §7 F3).
 *
 * The subtitle carries what the app may reach and whether it can run, because
 * both commands behind this picker — run one, export one — turn on exactly
 * that. A picker that showed only titles would put "reads correspondence" one
 * dialog further away than the decision it belongs to.
 */
export class AppPicker extends FuzzySuggestModal<AppAssessment> {
  constructor(
    app: App,
    private readonly apps: AppAssessment[],
    private readonly onPick: (entry: AppAssessment) => void,
  ) {
    super(app);
    this.setPlaceholder(apps.length === 0 ? "No vault apps" : "Which app?");
  }

  getItems(): AppAssessment[] {
    return [...this.apps].sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
  }

  getItemText(entry: AppAssessment): string {
    return `${entry.manifest.id} ${entry.manifest.title} ${entry.manifest.description}`;
  }

  override renderSuggestion(match: FuzzyMatch<AppAssessment>, el: HTMLElement): void {
    // createEl rather than innerHTML: these come out of note frontmatter (§8).
    const entry = match.item;
    el.createDiv({ cls: "scdb-suggest__title", text: entry.manifest.title });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: [STATE_LABELS[entry.state], entry.capabilities].join(" · "),
    });
  }

  onChooseItem(entry: AppAssessment): void {
    this.onPick(entry);
  }
}
