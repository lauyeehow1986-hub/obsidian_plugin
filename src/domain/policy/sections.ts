/**
 * Splitting a policy document into clause-numbered sections (§7 C1).
 *
 * The impact map's precision comes entirely from here. Without sections a
 * revision says "the document changed" and every dependant has to be reviewed;
 * with them it says "clause 5.2 changed" and the three things resting on 5.2
 * are named. So the parsing rule matters, and it is deliberately literal:
 *
 * **A clause number is read off the heading, never invented.** `## 5.2 Onward
 * transfer` is clause 5.2. `### Definitions` sitting under it is *not* clause
 * 5.2.1 — numbering an unnumbered heading would put a number in an impact
 * report that appears nowhere in the policy, which is the kind of confident
 * fabrication a governance instrument cannot afford. Unnumbered sections are
 * matched by their heading path instead.
 *
 * Pure module: no Obsidian, no Node.
 */

/** One heading and the lines beneath it, up to the next heading of any level. */
export interface Section {
  /** Heading text with the clause number and `#` marks removed. */
  heading: string;
  /** 1–6. Zero for the preamble before the first heading. */
  level: number;
  /** "5.2", or "" when the heading carries no number. */
  clause: string;
  /** Ancestor headings, outermost first, for identifying unnumbered sections. */
  path: string[];
  /** Zero-based line index of the heading in the body. */
  line: number;
  /** The body lines, heading excluded. */
  lines: string[];
}

/** Everything after a leading `---` frontmatter block, or the text unchanged. */
export function stripFrontmatter(text: string): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  if (!normalised.startsWith("---\n")) return normalised;
  const end = normalised.indexOf("\n---", 3);
  if (end === -1) return normalised;
  const after = normalised.indexOf("\n", end + 1);
  return after === -1 ? "" : normalised.slice(after + 1);
}

/**
 * Up to three leading spaces, as markdown allows. Not pedantry: a policy
 * pasted out of a word processor arrives indented, and an indented heading
 * read as body text collapses the whole document into one section — which
 * turns a two-line revision into "everything changed".
 */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;

/**
 * A leading clause number: "5", "5.2", "5.2.1", optionally "§5.2" or "5.2)".
 *
 * Anchored and requiring whitespace or a closing mark after it, so a heading
 * that merely opens with a year — "2026 review cycle" — is not read as clause
 * 2026. A bare single number is accepted ("## 5 Scope") because top-level
 * clauses are usually written that way.
 */
const CLAUSE = /^[§¶]?\s*(\d+(?:\.\d+)*)[.)]?(?:\s+|$)/;

/** The clause number a heading declares, and the heading text without it. */
export function splitClause(heading: string): { clause: string; text: string } {
  const match = CLAUSE.exec(heading.trim());
  if (match === null) return { clause: "", text: heading.trim() };
  const clause = match[1]!.replace(/\.$/, "");
  return { clause, text: heading.trim().slice(match[0].length).trim() };
}

/**
 * Split a policy body into sections.
 *
 * Fenced code blocks are skipped so a `#` inside one is not read as a heading —
 * policies quote command lines and configuration more often than one expects.
 */
export function splitSections(body: string): Section[] {
  const lines = stripFrontmatter(body).split("\n");
  const sections: Section[] = [];
  const ancestors: { level: number; heading: string }[] = [];

  let current: Section = { heading: "", level: 0, clause: "", path: [], line: 0, lines: [] };
  let fence = "";

  lines.forEach((line, index) => {
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch !== null) {
      const mark = fenceMatch[1]!;
      if (fence === "") fence = mark[0]!;
      else if (mark.startsWith(fence)) fence = "";
      current.lines.push(line);
      return;
    }
    if (fence !== "") {
      current.lines.push(line);
      return;
    }

    const match = HEADING.exec(line);
    if (match === null) {
      current.lines.push(line);
      return;
    }

    // Keep the preamble only when it has something in it — a document that
    // opens with a heading should not report an empty section above it.
    if (current.level > 0 || current.lines.some((text) => text.trim() !== "")) {
      sections.push(current);
    }

    const level = match[1]!.length;
    const { clause, text } = splitClause(match[2]!);
    while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= level) {
      ancestors.pop();
    }
    const path = ancestors.map((entry) => entry.heading);
    ancestors.push({ level, heading: text });

    current = { heading: text, level, clause, path, line: index, lines: [] };
  });

  if (current.level > 0 || current.lines.some((text) => text.trim() !== "")) {
    sections.push(current);
  }
  return sections;
}

/**
 * A stable identity for a section, for matching one revision's sections
 * against the next.
 *
 * The clause number when there is one — a renamed "5.2 Onward transfer" is
 * still clause 5.2 and its edges still point at it. Otherwise the heading
 * path, lower-cased, because that is all we have.
 */
export function sectionKey(section: Section): string {
  if (section.clause !== "") return `clause:${section.clause}`;
  if (section.level === 0) return "preamble";
  return `path:${[...section.path, section.heading].join(" > ").toLowerCase()}`;
}

/** How a section is named in a report. */
export function sectionLabel(section: Section): string {
  if (section.level === 0) return "Preamble";
  const prefix = section.clause === "" ? "" : `${section.clause} `;
  return `${prefix}${section.heading}`.trim() || "(untitled section)";
}

/**
 * True when a cited clause and a document clause are the same rule.
 *
 * Prefix matching on dot boundaries, in both directions. A change to 5.2
 * reaches something resting on 5.2.1 (the subclause is inside what changed),
 * and something resting on 5.2.1 is reached by a change recorded at 5.2 (the
 * document may not be sectioned as finely as the citation). Being wrong in the
 * "flag it anyway" direction is the right way to be wrong here.
 */
export function clauseMatches(cited: string, sectionClause: string): boolean {
  if (cited === "" || sectionClause === "") return false;
  if (cited === sectionClause) return true;
  return cited.startsWith(`${sectionClause}.`) || sectionClause.startsWith(`${cited}.`);
}
