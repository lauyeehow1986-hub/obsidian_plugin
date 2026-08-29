/**
 * Which fenced blocks in a note can be run, and how one is named (§7 F1).
 *
 * A runnable block is an ordinary fenced code block. Nothing marks it as
 * special, nothing opts it in, and nothing about it changes how the note reads
 * without the plugin — which is the point of rule 11. What makes it runnable is
 * an explicit action by a person (rule 12), never anything about the note.
 *
 * **A block has two names and they do different jobs.** Its *position* — the
 * nth block of that language — is how a person points at one: "run the second
 * python block". Its *hash* is what survives an edit and is what a run record
 * leans on six months later. Position is a convenience that goes stale the
 * moment the note is edited; the hash is the identity. Everywhere this module
 * returns both, the comment says which is which, because confusing them is how
 * a provenance record ends up naming code that never ran.
 *
 * Pure module: no Obsidian, no Node.
 */

import { scanFences } from "../markdown/fence";

/** The two languages F1 executes. Everything else is prose to us. */
export const RUN_LANGUAGES = ["r", "python"] as const;

export type RunLanguage = (typeof RUN_LANGUAGES)[number];

/**
 * Info-string spellings that mean one of our languages.
 *
 * Generous on input and canonical on output: a note written by a person says
 * `py` or `R` as often as `python`, and refusing to run a block over its
 * spelling would be pedantry. The canonical id is what the run record carries.
 */
const ALIASES: Record<string, RunLanguage> = {
  r: "r",
  rscript: "r",
  python: "python",
  python3: "python",
  py: "python",
};

export function runLanguage(word: string): RunLanguage | null {
  return ALIASES[word.trim().toLowerCase()] ?? null;
}

export function isRunLanguage(value: unknown): value is RunLanguage {
  return typeof value === "string" && (RUN_LANGUAGES as readonly string[]).includes(value);
}

export const LANGUAGE_LABELS: Record<RunLanguage, string> = { r: "R", python: "Python" };

export interface RunnableBlock {
  language: RunLanguage;
  /** The code exactly as written, trailing whitespace intact. */
  source: string;
  /** 1-based position among blocks of this language. A hint, not an identity. */
  ordinal: number;
  /** 1-based position among all runnable blocks, for "block 3 of 5" in the UI. */
  index: number;
  /** Index into the note text of the opening fence. */
  start: number;
  /** Index just past the closing fence. */
  end: number;
  /** 1-based line the opening fence sits on, so the UI can say where it is. */
  line: number;
  /** The tail of the info string, e.g. `no-run`. Lower-cased. */
  flags: string[];
}

/**
 * The fence word that keeps a block off the run list.
 *
 * Deliberately opt-*out* rather than opt-in. A block of R in a note is R
 * whether or not somebody remembered a marker, and a plugin that only offered
 * to run specially-marked blocks would quietly do nothing on the note a
 * colleague sent you. `no-run` exists for the block that is an illustration of
 * something you must never run — which is a real thing to write in an SOP.
 */
export const NO_RUN_FLAG = "no-run";

/**
 * Every runnable block in a note body, in document order.
 *
 * Blocks inside blocks are not a special case: the fence scanner already
 * treats a longer run of backticks as one block, so a markdown example that
 * *contains* a python fence stays one non-runnable block.
 */
export function findRunnableBlocks(text: string): RunnableBlock[] {
  const blocks: RunnableBlock[] = [];
  const counts: Record<RunLanguage, number> = { r: 0, python: 0 };

  for (const fence of scanFences(text)) {
    const first = fence.words[0] ?? "";
    const language = runLanguage(first);
    if (language === null) continue;

    const flags = fence.words.slice(1);
    if (flags.includes(NO_RUN_FLAG)) continue;

    counts[language] += 1;
    blocks.push({
      language,
      source: fence.body,
      ordinal: counts[language],
      index: blocks.length + 1,
      start: fence.start,
      end: fence.end,
      line: lineOf(text, fence.start),
      flags,
    });
  }

  return blocks;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * Find the block a person pointed at, after the note may have moved under us.
 *
 * The gap between pressing Run and the code being read is small but real: an
 * open editor, a sync, a colleague's change. Matching on the source text first
 * means a block that moved down the note still runs; falling back to position
 * means a block that was *edited* since the button was drawn still runs, which
 * is what a person expects from a button under the block they are looking at.
 *
 * Returns null rather than guessing when neither matches. Running the wrong
 * code is worse than running none, and this is the only place that choice is
 * made.
 */
export function locateBlock(
  text: string,
  wanted: { language: RunLanguage; source: string; ordinal: number },
): RunnableBlock | null {
  const blocks = findRunnableBlocks(text).filter((block) => block.language === wanted.language);
  const exact = blocks.filter((block) => block.source === wanted.source);
  if (exact.length === 1) return exact[0] ?? null;
  // Several identical blocks: position picks between them, and if the position
  // is gone the first identical one is as good an answer as exists.
  if (exact.length > 1) {
    return exact.find((block) => block.ordinal === wanted.ordinal) ?? exact[0] ?? null;
  }
  return blocks.find((block) => block.ordinal === wanted.ordinal) ?? null;
}

/** A one-line description for a picker: `Python · block 2 · line 41`. */
export function describeBlock(block: RunnableBlock): string {
  return `${LANGUAGE_LABELS[block.language]} · block ${block.ordinal} · line ${block.line}`;
}

/**
 * The first line of code, for a picker that has to fit on one row.
 *
 * Comments are skipped: `# ---- load ----` is what a person writes at the top
 * of every block, so showing it would make every row look the same.
 */
export function previewLine(source: string, limit = 72): string {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return "(no code)";
}
