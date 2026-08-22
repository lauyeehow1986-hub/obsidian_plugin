import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import type { Party } from "../domain/comms/party";

/**
 * Pick a person for the meeting agenda (CLAUDE.md §7 B1).
 *
 * The list is **everyone the vault already mentions**, not everyone with a note
 * in `30 People/`. An approver can block a request for six weeks before anybody
 * writes them a note, and that is exactly the person you need an agenda for.
 * A4's integrity check is where a name with no note behind it gets raised; here
 * it is simply a name.
 *
 * Ordered by how much is waiting on them rather than alphabetically: the person
 * holding up nine things is who you are looking for, and typing their name is
 * still one keystroke away if not.
 */
export interface PersonChoice {
  party: Party;
  /** How many open items name them. Shown so the list is worth scanning. */
  count: number;
  /** What kinds — "4 requests, 1 unanswered message". */
  detail: string;
}

export class PersonPicker extends FuzzySuggestModal<PersonChoice> {
  constructor(
    app: App,
    private readonly choices: PersonChoice[],
    private readonly onPick: (choice: PersonChoice) => void,
  ) {
    super(app);
    this.setPlaceholder(
      choices.length === 0
        ? "Nobody is recorded as holding anything up"
        : "Who are you meeting?",
    );
  }

  getItems(): PersonChoice[] {
    return this.choices;
  }

  getItemText(choice: PersonChoice): string {
    return choice.party.name;
  }

  override renderSuggestion(match: FuzzyMatch<PersonChoice>, el: HTMLElement): void {
    // createEl rather than innerHTML: these names come out of note frontmatter
    // (§8, never innerHTML with vault-derived content).
    el.createDiv({ cls: "scdb-suggest__title", text: match.item.party.name });
    el.createDiv({ cls: "scdb-suggest__sub", text: match.item.detail });
  }

  onChooseItem(choice: PersonChoice): void {
    this.onPick(choice);
  }
}
