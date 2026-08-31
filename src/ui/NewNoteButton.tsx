import { Menu } from "obsidian";
import {
  NEW_NOTE_KINDS,
  NOTE_KIND_SPECS,
  type NewNoteKind,
} from "../domain/notes/newNote";
import type ScdbCockpitPlugin from "../main.js";

/**
 * The two ways to reach note creation from a board.
 *
 * The palette already carries one command per kind, and that is the fastest
 * route for anyone who knows the name. These exist for the other case: an
 * empty board whose text says what to add is a board that should let you add
 * it, and §6 asks every empty state to say what to do next — which reads
 * hollow when the next thing is "go to the palette and type".
 */

/** One kind, for an empty state that has just named that kind. */
export function NewNoteButton({
  plugin,
  kind,
  primary = false,
}: {
  plugin: ScdbCockpitPlugin;
  kind: NewNoteKind;
  primary?: boolean;
}) {
  const spec = NOTE_KIND_SPECS[kind];
  return (
    <button
      type="button"
      class={primary ? "mod-cta" : "scdb-control"}
      onClick={() => plugin.newNote(kind)}
    >
      {spec.commandName}
    </button>
  );
}

/**
 * All six kinds behind one button, for the cockpit header.
 *
 * A menu rather than six buttons: studies, people, meetings and profile items
 * have no board of their own to hang a button on, and a header that grew a
 * button per note type would crowd out the one action that belongs there.
 */
export function NewNoteMenuButton({ plugin }: { plugin: ScdbCockpitPlugin }) {
  return (
    <button
      type="button"
      class="scdb-control"
      title="Create a study, person, policy, meeting note, profile item or publication"
      onClick={(event) => {
        const menu = new Menu();
        for (const kind of NEW_NOTE_KINDS) {
          const spec = NOTE_KIND_SPECS[kind];
          menu.addItem((item) => item.setTitle(spec.commandName).onClick(() => plugin.newNote(kind)));
        }
        menu.showAtMouseEvent(event as MouseEvent);
      }}
    >
      New note
    </button>
  );
}
