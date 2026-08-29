/**
 * Finding and replacing a fenced block in a note body.
 *
 * Two note types keep their payload in the body rather than in frontmatter: a
 * REDCap instrument (§5.14, §7 D2) because eighty fields do not belong in
 * frontmatter, and a vault app (§5.13) because its payload is JavaScript. Both
 * need the same three things — locate *our* fence among any others, replace it
 * without touching a word of the prose around it, and tolerate the fence
 * spellings CommonMark allows.
 *
 * D2 wrote this for YAML first. Generalised here rather than copied, because a
 * second copy is a second place for the "replace only the block" rule to be
 * got subtly wrong, and that rule is what keeps rule 8 true for these notes.
 *
 * Pure module: no Obsidian, no Node.
 */

export interface FenceQuery {
  /** Info-string languages that count, lower-cased. First word of the info string. */
  languages: readonly string[];
  /** A further word marking the fence as ours, e.g. `redcap` or `app`. */
  tag: string;
}

/** Where a block sits, so it can be replaced without touching anything else. */
export interface FenceLocation {
  /** The text inside the fence, unparsed. */
  body: string;
  /** Index into the note text of the opening fence's first character. */
  start: number;
  /** Index just past the closing fence's newline. */
  end: number;
  /** True when the fence carried the tag rather than being an untagged block. */
  tagged: boolean;
}

// Fence, optional info string, body, closing fence. Tolerates ``` and ~~~, and
// more than three markers, because both are valid CommonMark and a note that
// contains a fenced block inside the block needs the longer form.
const FENCE = /^([`~]{3,})[ \t]*([^\n]*)\n([\s\S]*?)^\1[`~]*[ \t]*$/gm;

/**
 * Find our block in a note body.
 *
 * Prefers a tagged fence; falls back to the first fence in one of the given
 * languages. Returns null when the note has neither, which is a finding for
 * the caller and not an error here — a form note with no block is a form with
 * no fields, and an app note with no block is an app that does nothing. Both
 * callers say so in plain English.
 */
export function findFence(text: string, query: FenceQuery): FenceLocation | null {
  let fallback: FenceLocation | null = null;

  FENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE.exec(text)) !== null) {
    const info = (match[2] ?? "").trim().toLowerCase();
    const words = info.split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) continue;

    const language = words[0] ?? "";
    if (!query.languages.includes(language)) continue;

    const location: FenceLocation = {
      body: match[3] ?? "",
      start: match.index,
      end: match.index + match[0].length,
      tagged: words.includes(query.tag),
    };

    if (location.tagged) return location;
    if (fallback === null) fallback = location;
  }

  return fallback;
}

/**
 * The fenced block as it is written into a note.
 *
 * The fence grows past three backticks when the body contains a run of them,
 * so a block holding a markdown example does not close itself halfway.
 */
export function renderFence(body: string, language: string, tag: string): string {
  const inner = body.replace(/\s+$/, "");
  let longest = 0;
  for (const run of inner.match(/`{3,}/g) ?? []) longest = Math.max(longest, run.length);
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}${language} ${tag}\n${inner}\n${marker}`;
}

/**
 * Put a new block into a note, replacing the old one or appending a new one.
 *
 * Appending puts the block at the end rather than at the top: the top of the
 * note is where a person writes what the thing is *for*, and inserting eighty
 * fields or two hundred lines of JavaScript above it would bury the only part
 * a human reads.
 */
export function replaceFence(
  text: string,
  body: string,
  query: FenceQuery,
  language = query.languages[0] ?? "text",
): string {
  const block = renderFence(body, language, query.tag);
  const found = findFence(text, query);
  if (found === null) {
    const separator =
      text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${block}\n`;
  }
  return `${text.slice(0, found.start)}${block}${text.slice(found.end)}`;
}
