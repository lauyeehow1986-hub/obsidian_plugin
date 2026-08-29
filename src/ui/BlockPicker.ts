import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import { describeBlock, previewLine, type RunnableBlock } from "../domain/compute/block";

/**
 * Pick a runnable block in the current note (§7 F1).
 *
 * The palette route into running code, and the one that works everywhere —
 * the Run button lives in reading view, and a person editing a note is not in
 * reading view. Neither route runs anything: both open the dialog that shows
 * the code first (rule 12).
 *
 * The subtitle is the block's first line of actual code rather than its first
 * line, because `# ---- load ----` is what people write at the top of every
 * block and it would make every row identical.
 */
export class BlockPicker extends FuzzySuggestModal<RunnableBlock> {
  constructor(
    app: App,
    private readonly blocks: RunnableBlock[],
    private readonly onPick: (block: RunnableBlock) => void,
  ) {
    super(app);
    this.setPlaceholder(blocks.length === 0 ? "No R or Python blocks here" : "Which block?");
  }

  getItems(): RunnableBlock[] {
    return this.blocks;
  }

  getItemText(block: RunnableBlock): string {
    return `${describeBlock(block)} ${previewLine(block.source, 200)}`;
  }

  override renderSuggestion(match: FuzzyMatch<RunnableBlock>, el: HTMLElement): void {
    // createEl rather than innerHTML: this is note content (§8).
    const block = match.item;
    el.createDiv({ cls: "scdb-suggest__title", text: describeBlock(block) });
    el.createDiv({ cls: "scdb-suggest__sub", text: previewLine(block.source) });
  }

  onChooseItem(block: RunnableBlock): void {
    this.onPick(block);
  }
}
