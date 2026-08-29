import { MarkdownView, Notice, TFile, type Plugin } from "obsidian";
import {
  findRunnableBlocks,
  LANGUAGE_LABELS,
  NO_RUN_FLAG,
  runLanguage,
  type RunnableBlock,
} from "../domain/compute/block";

/**
 * A Run affordance under R and Python blocks in reading view (§7 F1).
 *
 * **A button is not an execution.** Rule 12 forbids code running on note open,
 * on vault load or on sync; drawing a button does none of those. Pressing it
 * opens the dialog that shows the code, and the run starts from there. So the
 * affordance can be offered everywhere without weakening anything.
 *
 * The button carries no state and resolves nothing at render time. On click it
 * reads the note as it is *then* and matches this block by its text — which
 * means a stale button under an edited block resolves to the edited block or
 * to nothing, never to code that has been replaced.
 *
 * Blocks fenced `no-run` get no button. That is how the archived copy of a
 * past run in `94 Runs/` avoids offering itself for re-execution out of the
 * context it was run in.
 */
export function registerRunButtons(
  plugin: Plugin,
  options: {
    enabled: () => boolean;
    open: (file: TFile, block: RunnableBlock) => void;
  },
): void {
  plugin.registerMarkdownPostProcessor((element, context) => {
    if (!options.enabled()) return;

    for (const code of Array.from(element.querySelectorAll("pre > code"))) {
      const classes = Array.from(code.classList);
      if (classes.some((name) => name === NO_RUN_FLAG || name.endsWith(`-${NO_RUN_FLAG}`))) continue;

      const language = languageOf(classes);
      if (language === null) continue;

      const pre = code.parentElement;
      if (pre === null) continue;

      const source = code.textContent ?? "";
      if (source.trim() === "") continue;

      // A row after the block rather than a button inside it. Obsidian's code
      // blocks scroll in both directions, and an absolutely positioned child of
      // a scroll container anchors to its *scroll* height — so a button placed
      // at the bottom right sat below the visible box and was clipped away.
      // Out here there is nothing to clip it, and nothing to collide with
      // Obsidian's own copy button in the corner.
      const existing = pre.nextElementSibling;
      if (existing?.classList.contains("scdb-run-bar") === true) continue;

      const bar = createDiv({ cls: "scdb-run-bar" });
      pre.insertAdjacentElement("afterend", bar);

      const button = bar.createEl("button", {
        cls: "scdb-run-button",
        text: "Run",
        attr: { "aria-label": `Run this ${language} block` },
      });

      plugin.registerDomEvent(button, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openFor(plugin, context.sourcePath, source, options.open);
      });
    }
  });
}

/**
 * "Run this block" in the editor's right-click menu.
 *
 * The reading-view button is not enough on its own: Live Preview is Obsidian's
 * default mode, and it renders code blocks through CodeMirror, where a
 * markdown post-processor never runs. Confirmed in the app rather than assumed
 * — the reading view had five buttons and Live Preview had no `<pre>` at all.
 *
 * So the block a person is *editing* is reachable by right-clicking inside it.
 * The palette command covers both modes and every other case; this is the one
 * that costs no keystrokes when you are already looking at the code.
 */
export function registerRunMenu(
  plugin: Plugin,
  options: { open: (file: TFile, block: RunnableBlock) => void },
): void {
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu, editor, view) => {
      const file = view.file;
      if (file === null) return;

      const offset = editor.posToOffset(editor.getCursor());
      const block = findRunnableBlocks(editor.getValue()).find(
        (candidate) => offset >= candidate.start && offset <= candidate.end,
      );
      if (block === undefined) return;

      menu.addItem((item) =>
        item
          .setTitle(`Run this ${LANGUAGE_LABELS[block.language]} block`)
          .setIcon("play")
          .onClick(() => options.open(file, block)),
      );
    }),
  );
}

/** `language-python` → `python`, via the alias table so `py` and `R` count too. */
function languageOf(classes: string[]): string | null {
  for (const name of classes) {
    const word = name.startsWith("language-") ? name.slice("language-".length) : name;
    const language = runLanguage(word);
    if (language !== null) return language;
  }
  return null;
}

/**
 * Turn a rendered block back into a block in the file.
 *
 * By text rather than by position: the rendered element knows what it says,
 * and the file is the only authority on where that is now. When the text
 * matches nothing the answer is to say so, not to run the block that happens
 * to sit at the same index.
 */
async function openFor(
  plugin: Plugin,
  sourcePath: string,
  rendered: string,
  open: (file: TFile, block: RunnableBlock) => void,
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;

  const text = await plugin.app.vault.read(file);
  const blocks = findRunnableBlocks(text);

  const wanted = rendered.replace(/\s+$/, "");
  const matches = blocks.filter((block) => block.source.replace(/\s+$/, "") === wanted);

  const block = matches[0] ?? null;
  if (block === null) {
    new Notice("That block is no longer in the note as it was rendered. Reopen the note and try again.");
    return;
  }

  open(file, block);
}

/** The note the user is looking at, for the palette command. */
export function activeMarkdownFile(plugin: Plugin): TFile | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  return view?.file ?? null;
}
