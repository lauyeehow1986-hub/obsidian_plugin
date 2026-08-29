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
 * Pure module: no Obsidian, no Node.
 */

export const BLOCK_TAG = "redcap";

/** Where the block sits, so it can be replaced without touching anything else. */
export interface BlockLocation {
  /** The YAML inside the fence, unparsed. */
  body: string;
  /** Index into the note text of the opening fence's first character. */
  start: number;
  /** Index just past the closing fence's newline. */
  end: number;
  /** True when the fence carried the `redcap` tag rather than being a bare yaml block. */
  tagged: boolean;
}

// Fence, optional info string, body, closing fence. Tolerates ``` and ~~~, and
// more than three markers, because both are valid CommonMark and a note that
// contains a fenced block inside the YAML needs the longer form.
const FENCE = /^([`~]{3,})[ \t]*([^\n]*)\n([\s\S]*?)^\1[`~]*[ \t]*$/gm;

/**
 * Find the form block in a note body.
 *
 * Prefers a `redcap`-tagged fence; falls back to the first `yaml` fence.
 * Returns null when the note has neither, which is a finding for the caller
 * and not an error here — a form note with no block is a form with no fields,
 * and `parseFormSpec` already says so in plain English.
 */
export function findBlock(text: string): BlockLocation | null {
  let fallback: BlockLocation | null = null;

  FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE.exec(text)) !== null) {
    const info = (match[2] ?? "").trim().toLowerCase();
    const words = info.split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) continue;

    const language = words[0] ?? "";
    if (language !== "yaml" && language !== "yml") continue;

    const location: BlockLocation = {
      body: match[3] ?? "",
      start: match.index,
      end: match.index + match[0].length,
      tagged: words.includes(BLOCK_TAG),
    };

    if (location.tagged) return location;
    if (fallback === null) fallback = location;
  }

  return fallback;
}

/** The fenced block as it is written into a note. */
export function renderBlock(yaml: string): string {
  const body = yaml.replace(/\s+$/, "");
  return `\`\`\`yaml ${BLOCK_TAG}\n${body}\n\`\`\``;
}

/**
 * Put a new block into a note, replacing the old one or appending a new one.
 *
 * Appending puts the block at the end rather than at the top: the top of a
 * form note is where a person writes what the instrument is for, and inserting
 * eighty fields above it would bury the only part a human reads.
 */
export function replaceBlock(text: string, yaml: string): string {
  const block = renderBlock(yaml);
  const found = findBlock(text);
  if (found === null) {
    const separator = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${block}\n`;
  }
  return `${text.slice(0, found.start)}${block}${text.slice(found.end)}`;
}
