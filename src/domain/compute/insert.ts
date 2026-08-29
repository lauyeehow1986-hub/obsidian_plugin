/**
 * Putting a run's output back into the note (§7 F1), without eating the prose.
 *
 * Rule 8 is the whole of this module: never destroy data you did not write. So
 * the output region is defined narrowly enough that it can only ever match
 * something this plugin put there —
 *
 *  - a fence tagged `text scdb-run`, sitting immediately after the code block
 *    with nothing but blank lines between;
 *  - followed by embed lines that are *only* an embed, and only of a figure in
 *    the runs folder whose name starts with `RUN-`.
 *
 * The first line that is anything else ends the region. A person's own note
 * under a block, their own image, a second code block — all survive a re-run
 * untouched, because the sweep stops at them rather than assuming everything
 * up to the next heading belongs to us.
 *
 * The output is a plain `text` fence, so a vault opened without this plugin
 * reads exactly the same (rule 11). Nothing about it is a custom syntax.
 *
 * Pure module: no Obsidian, no Node.
 */

import { renderFence, scanFences } from "../markdown/fence";
import type { RunnableBlock } from "./block";

export const OUTPUT_LANGUAGE = "text";
export const OUTPUT_TAG = "scdb-run";

/** Where a previous run's output sits, so it can be replaced wholesale. */
export interface OutputRegion {
  start: number;
  end: number;
  figures: string[];
}

/**
 * The stdout / stderr split, as it reads in the note.
 *
 * Two pipes cannot be interleaved faithfully after the fact — the order you
 * would print them in is not the order they happened — so they are kept apart
 * and labelled rather than spliced into a plausible-looking transcript.
 */
export function renderOutputBody(input: {
  summary: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}): string {
  const parts = [input.summary];

  const stdout = input.stdout.replace(/\s+$/, "");
  const stderr = input.stderr.replace(/\s+$/, "");

  if (stdout !== "") parts.push("", stdout);
  if (stderr !== "") parts.push("", "--- stderr ---", stderr);
  if (stdout === "" && stderr === "") parts.push("", "(no output)");
  if (input.truncated) parts.push("", "(output was longer than the limit and was cut in the middle)");

  return parts.join("\n");
}

export function renderOutputBlock(input: {
  summary: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Vault paths, embedded below the fence so they render natively. */
  figures: string[];
}): string {
  const fence = renderFence(renderOutputBody(input), OUTPUT_LANGUAGE, OUTPUT_TAG);
  const embeds = input.figures.map((path) => `![[${path}]]`);
  return [fence, ...embeds].join("\n");
}

function isOurFence(words: string[]): boolean {
  return words[0] === OUTPUT_LANGUAGE && words.includes(OUTPUT_TAG);
}

/**
 * A figure embed this plugin wrote, and nothing else.
 *
 * Three conditions, all required: the line is only an embed, the target is in
 * the runs folder, and its name starts with `RUN-`. A person's `![[diagram]]`
 * under a block fails the second, and a file they saved into the runs folder
 * themselves fails the third.
 */
export function isFigureEmbed(line: string, runsFolder: string): boolean {
  const match = /^!\[\[([^\]|#^]+)(?:\|[^\]]*)?\]\]$/.exec(line.trim());
  if (match === null) return false;

  const target = (match[1] ?? "").trim();
  const prefix = `${runsFolder.replace(/\/+$/, "")}/`;
  if (!target.startsWith(prefix)) return false;

  const name = target.slice(prefix.length);
  return name.startsWith("RUN-") && !name.includes("/");
}

/**
 * The output region belonging to one block, if there is one.
 *
 * Returns null when the next thing after the block is anything else — which is
 * the ordinary case for a block that has never been run, and the safe answer
 * for a note somebody has written under.
 */
export function findOutputRegion(
  text: string,
  block: RunnableBlock,
  runsFolder: string,
): OutputRegion | null {
  const between = text.slice(block.end, text.length);
  const gap = /^\s*/.exec(between)?.[0] ?? "";
  const fenceStart = block.end + gap.length;
  // More than one blank line between them means the person put space there on
  // purpose, and what follows is theirs.
  if ((gap.match(/\n/g) ?? []).length > 2) return null;

  const fence = scanFences(text).find((candidate) => candidate.start === fenceStart);
  if (fence === undefined || !isOurFence(fence.words)) return null;

  let end = fence.end;
  const figures: string[] = [];

  for (;;) {
    const rest = text.slice(end);
    const line = /^\n([^\n]*)/.exec(rest);
    if (line === null) break;

    const content = line[1] ?? "";
    if (!isFigureEmbed(content, runsFolder)) break;

    const match = /^!\[\[([^\]|#^]+)(?:\|[^\]]*)?\]\]$/.exec(content.trim());
    figures.push((match?.[1] ?? "").trim());
    end += line[0].length;
  }

  return { start: block.end, end, figures };
}

/**
 * Put this run's output under the block, replacing the last one's.
 *
 * Replacing rather than appending is deliberate: a block re-run six times
 * should show what it does now, not a stack of six transcripts. The run
 * records in `94 Runs/` are the history, and they are the copy that is meant
 * to be complete.
 */
export function insertOutput(input: {
  text: string;
  block: RunnableBlock;
  rendered: string;
  runsFolder: string;
}): { text: string; replaced: OutputRegion | null } {
  const region = findOutputRegion(input.text, input.block, input.runsFolder);
  const cutFrom = region?.start ?? input.block.end;
  const cutTo = region?.end ?? input.block.end;

  const before = input.text.slice(0, cutFrom);
  const after = input.text.slice(cutTo);
  const tail = after.startsWith("\n") ? after : `\n${after}`;

  return { text: `${before}\n\n${input.rendered}${tail}`, replaced: region ?? null };
}

/** Take a block's output away again, leaving the block and the prose alone. */
export function clearOutput(input: {
  text: string;
  block: RunnableBlock;
  runsFolder: string;
}): { text: string; removed: OutputRegion | null } {
  const region = findOutputRegion(input.text, input.block, input.runsFolder);
  if (region === null) return { text: input.text, removed: null };

  const after = input.text.slice(region.end);
  return { text: `${input.text.slice(0, region.start)}${after.startsWith("\n") ? "" : "\n"}${after}`, removed: region };
}
