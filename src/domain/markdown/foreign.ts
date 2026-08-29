/**
 * Making text from outside the vault safe to write into a note.
 *
 * Everything this plugin writes is markdown a person reads in Obsidian, and
 * Obsidian's markdown does things ordinary markdown does not. A paper title
 * arriving from an external service is **data**, and it must not be able to
 * become a control:
 *
 * - `[[Dr A Tan]]` in a fetched title would render as a link to a real person
 *   note, putting a fabricated connection into the graph.
 * - `![[10 Requests/REQ-2026-014]]` is an **embed**: the fetched line would
 *   pull the contents of a request note into the briefing. In a vault §5.10
 *   calls a regulated data store, an external string that can transclude an
 *   arbitrary note is not a cosmetic problem.
 * - `|` ends a cell early and silently reshapes a table.
 * - A backtick opens a code span that swallows the rest of the line.
 *
 * The fix is escaping rather than stripping, because the text is a title
 * someone will read and compare against the source: `[Article in French]` and
 * `Phase I/II` have to survive. CommonMark backslash escapes render as the
 * literal character, so nothing is lost.
 *
 * This is the same instinct as rule 5 — untrusted text is inert by
 * architecture, not by hoping nobody sends anything awkward.
 */

/** Characters whose markdown meaning would change the note rather than the text. */
const ESCAPE = /[[\]|`!\\]/g;

/**
 * Escape one line of foreign text for use in prose, a heading or a table cell.
 *
 * Also flattens newlines: a fetched field is a value, and a value that spans
 * lines would break out of the list item or table row it was placed in.
 */
export function foreignText(raw: string): string {
  return collapse(raw).replace(ESCAPE, (ch) => `\\${ch}`);
}

/**
 * Foreign text that will **start a line** — a list item, or a line of prose
 * whose first characters came from outside.
 *
 * `foreignText` alone is not enough there. Markdown decides what kind of block
 * a line is from how it begins, so a condition named `- see protocol` becomes a
 * bullet and a journal called `> Heart` becomes a block quote. Text that sits
 * *inside* a line — after `### `, in a table cell, mid-sentence — needs only
 * `foreignText`.
 */
export function foreignLine(raw: string): string {
  return startOfLine(foreignText(raw));
}

/**
 * The line-start half of `foreignLine`, for text that has **already** been
 * through `foreignText`.
 *
 * Separate because a line is often several escaped values joined together, and
 * running `foreignText` over the join would escape the backslashes it added the
 * first time. Only the first value can start the line, so only the join needs
 * this.
 *
 * **The test follows CommonMark rather than blocking every marker, and that
 * precision is load-bearing.** An earlier version escaped `*` unconditionally,
 * which ate the emphasis marker *this codebase itself* writes around a journal
 * name: the briefing came out with a stray backslash and no italics. Found by
 * reading the generated note rather than the render. `*`, `-` and `+` open a
 * list only when whitespace follows; a run of `#` opens a heading only when
 * whitespace follows it. Emphasis is not a list.
 *
 * One escape is always enough: once the first character is a backslash the line
 * is a paragraph, and nothing behind it can open a block.
 */
export function startOfLine(escaped: string): string {
  const opensBlock =
    // A block quote needs no space after the `>`.
    /^>/.test(escaped) ||
    // Bullet: the marker, then whitespace or nothing else on the line.
    /^[-+*]([ \t]|$)/.test(escaped) ||
    // ATX heading: one to six hashes, then whitespace or end of line.
    /^#{1,6}([ \t]|$)/.test(escaped) ||
    // Ordered list: up to nine digits, a delimiter, then whitespace.
    /^\d{1,9}[.)]([ \t]|$)/.test(escaped) ||
    // Setext underline: a line of nothing but `=`, which would promote the
    // paragraph above it to a heading.
    /^=+$/.test(escaped);

  return opensBlock ? `\\${escaped}` : escaped;
}

/**
 * Collapse whitespace and remove control characters.
 *
 * Exported because a value written into **frontmatter** needs this but not the
 * markdown escaping: frontmatter is YAML, the escapes would be stored
 * literally, and `title: "\\[Article in French\\]"` is what you would then read
 * back out of the note forever.
 */
export function collapse(raw: string): string {
  return (
    raw
      // Control characters, except tab, newline and carriage return: those
      // are whitespace and the next step folds them into a single space,
      // whereas deleting them here would join two words into one.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
