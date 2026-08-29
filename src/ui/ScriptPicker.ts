import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { languageLabel, scriptLabel, type ScriptDoc } from "../domain/script/scriptDoc";
import { toVaultDate } from "../domain/time/dates";

/**
 * Pick a documented script (§5.14, §7 C3).
 *
 * The subtitle carries the language and when it last ran, because the two
 * commands that use this picker — record a run, and check the hash — are both
 * about a script's current state rather than its name.
 */
export class ScriptPicker extends FuzzySuggestModal<ScriptDoc> {
  constructor(
    app: App,
    private readonly docs: ScriptDoc[],
    private readonly onPick: (doc: ScriptDoc) => void,
  ) {
    super(app);
    this.setPlaceholder(docs.length === 0 ? "No documented scripts" : "Which script?");
  }

  getItems(): ScriptDoc[] {
    return [...this.docs].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  }

  getItemText(doc: ScriptDoc): string {
    return `${scriptLabel(doc)} ${doc.purpose}`;
  }

  override renderSuggestion(match: FuzzyMatch<ScriptDoc>, el: HTMLElement): void {
    // createEl rather than innerHTML: these come out of note frontmatter (§8).
    const doc = match.item;
    el.createDiv({ cls: "scdb-suggest__title", text: scriptLabel(doc) });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: [
        languageLabel(doc.language),
        doc.lastRun === null ? "never run" : `last run ${toVaultDate(doc.lastRun)}`,
        doc.fileHash === "" ? "no hash" : "hashed",
      ].join(" · "),
    });
  }

  onChooseItem(doc: ScriptDoc): void {
    this.onPick(doc);
  }
}
