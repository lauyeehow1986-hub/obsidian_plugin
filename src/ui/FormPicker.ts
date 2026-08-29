import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";

import { FORM_STATUS_LABELS, type FormSpec } from "../domain/redcap/form";

/**
 * Pick a REDCap form (§5.14, §7 D2).
 *
 * The subtitle carries the study and the field count, because both commands
 * behind this picker — export the dictionary, import one over it — turn on
 * those two things: which study's approval governs it, and how much would be
 * replaced.
 */
export class FormPicker extends FuzzySuggestModal<FormSpec> {
  constructor(
    app: App,
    private readonly specs: FormSpec[],
    private readonly onPick: (spec: FormSpec) => void,
  ) {
    super(app);
    this.setPlaceholder(specs.length === 0 ? "No REDCap forms" : "Which form?");
  }

  getItems(): FormSpec[] {
    return [...this.specs].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  }

  getItemText(spec: FormSpec): string {
    return `${spec.id} ${spec.title} ${spec.study}`;
  }

  override renderSuggestion(match: FuzzyMatch<FormSpec>, el: HTMLElement): void {
    // createEl rather than innerHTML: these come out of note frontmatter (§8).
    const spec = match.item;
    const fields = spec.instruments.reduce((sum, instrument) => sum + instrument.fields.length, 0);
    el.createDiv({
      cls: "scdb-suggest__title",
      text: spec.title === spec.id ? spec.id : `${spec.id} — ${spec.title}`,
    });
    el.createDiv({
      cls: "scdb-suggest__sub",
      text: [
        FORM_STATUS_LABELS[spec.status],
        spec.study === "" ? "no study" : spec.study,
        `${fields} field${fields === 1 ? "" : "s"}`,
      ].join(" · "),
    });
  }

  onChooseItem(spec: FormSpec): void {
    this.onPick(spec);
  }
}
