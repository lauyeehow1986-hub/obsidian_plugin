/**
 * Finding the form's YAML block in a note body (§5.14, §7 D2).
 *
 * §7 puts a REDCap instrument in a fenced block rather than in frontmatter
 * because eighty fields do not belong in frontmatter and a body block diffs
 * cleanly in git. That means the plugin has to locate the block itself — the
 * metadata cache reads frontmatter, not fences.
 *
 * The block is tagged ```` ```yaml redcap ````: `yaml` so Obsidian highlights
 * it like any other YAML, `redcap` so this can find *ours* in a note that also
 * contains an unrelated YAML example. A note with no tagged block falls back
 * to its first plain ```` ```yaml ```` fence, because a hand-written form note
 * is a reasonable thing to exist and refusing it over a missing tag would be
 * pedantry.
 *
 * **Replacement is surgical.** The editor rewrites the block and nothing else:
 * the prose above it, the notes below it and the frontmatter are untouched
 * (rule 8, and §5.1's "the plugin renders from frontmatter and never rewrites
 * prose"). A form note is somewhere a person explains why an instrument is
 * shaped the way it is, and that explanation must survive every edit the
 * plugin makes.
 *
 * The mechanics moved to `markdown/fence.ts` when F3's vault apps needed the
 * same surgery on a `js` fence. This module keeps the REDCap-specific spelling
 * of it — the tag, the languages — so nothing that reads a form has to know.
 *
 * Pure module: no Obsidian, no Node.
 */

import { findFence, renderFence, replaceFence, type FenceLocation } from "../markdown/fence";

export const BLOCK_TAG = "redcap";

const FORM_FENCE = { languages: ["yaml", "yml"] as const, tag: BLOCK_TAG };

/** Where the block sits, so it can be replaced without touching anything else. */
export type BlockLocation = FenceLocation;

export function findBlock(text: string): BlockLocation | null {
  return findFence(text, FORM_FENCE);
}

/** The fenced block as it is written into a note. */
export function renderBlock(yaml: string): string {
  return renderFence(yaml, "yaml", BLOCK_TAG);
}

/** Replace the block, or append one at the end when the note has none. */
export function replaceBlock(text: string, yaml: string): string {
  return replaceFence(text, yaml, FORM_FENCE, "yaml");
}
