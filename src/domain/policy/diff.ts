/**
 * Diffing two versions of a policy, section by section (§7 C1).
 *
 * The diff is not the deliverable — the impact map is — but it is what the
 * impact map is computed from, so it has to be attributable: *which clause*
 * changed, not merely how many lines moved. Everything here therefore works
 * per section (`sections.ts`) and the line diff is run inside one.
 *
 * Line-level, not word-level, and deliberately so. A policy is read in
 * sentences; a word diff of a re-wrapped paragraph produces a confetti of
 * single-word changes that hides the one clause that actually moved. Whole
 * changed lines are shown, and the reader compares them.
 *
 * Pure module: no Obsidian, no Node.
 */

import {
  clauseMatches,
  sectionKey,
  sectionLabel,
  splitSections,
  stripFrontmatter,
  type Section,
} from "./sections";

export type LineChangeKind = "added" | "removed";

export interface LineChange {
  kind: LineChangeKind;
  text: string;
}

export type SectionChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface SectionChange {
  /** Stable identity, from `sectionKey`. */
  key: string;
  label: string;
  /** "5.2", or "" for an unnumbered section. */
  clause: string;
  kind: SectionChangeKind;
  addedLines: number;
  removedLines: number;
  /** The changed lines, capped — see `LINE_CAP`. */
  lines: LineChange[];
  /** Changed lines beyond the cap, not listed. */
  omitted: number;
}

export interface PolicyDiff {
  /** Every section of either version, in the new version's order. */
  sections: SectionChange[];
  addedLines: number;
  removedLines: number;
  identical: boolean;
  /**
   * True when the texts differ only in whitespace or blank lines.
   *
   * Worth separating: a re-export of the same policy from a different word
   * processor changes every line ending and nothing else, and reporting that
   * as a revision teaches people to click through the impact map.
   */
  whitespaceOnly: boolean;
  /**
   * Set when the documents were too large to diff line by line and each
   * changed section is reported as wholly replaced. Never silent.
   */
  coarse: boolean;
}

/** Changed lines listed per section before the rest are counted instead. */
export const LINE_CAP = 40;

/**
 * Above this many lines on either side of one section, the quadratic line
 * diff is skipped and the section is reported as replaced. A policy clause is
 * tens of lines; something this size is a pasted appendix, and spending
 * seconds of a blocked UI thread on it to produce an unreadable diff helps
 * nobody.
 */
const LINE_DIFF_LIMIT = 1500;

function meaningful(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * Longest common subsequence of two line arrays, as a list of changes.
 *
 * Classic DP. Both sides are bounded by `LINE_DIFF_LIMIT` before this is
 * called, so the table is at most ~2.25M cells in the worst case and typically
 * a few hundred.
 */
function diffLines(before: readonly string[], after: readonly string[]): LineChange[] {
  const rows = before.length;
  const columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      changes.push({ kind: "removed", text: before[i]! });
      i += 1;
    } else {
      changes.push({ kind: "added", text: after[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    changes.push({ kind: "removed", text: before[i]! });
    i += 1;
  }
  while (j < columns) {
    changes.push({ kind: "added", text: after[j]! });
    j += 1;
  }
  return changes;
}

function cap(changes: readonly LineChange[]): { lines: LineChange[]; omitted: number } {
  if (changes.length <= LINE_CAP) return { lines: [...changes], omitted: 0 };
  return { lines: changes.slice(0, LINE_CAP), omitted: changes.length - LINE_CAP };
}

function wholesale(section: Section, kind: "added" | "removed"): SectionChange {
  const lines = meaningful(section.lines).map((text) => ({ kind, text }) as LineChange);
  const { lines: shown, omitted } = cap(lines);
  return {
    key: sectionKey(section),
    label: sectionLabel(section),
    clause: section.clause,
    kind,
    addedLines: kind === "added" ? lines.length : 0,
    removedLines: kind === "removed" ? lines.length : 0,
    lines: shown,
    omitted,
  };
}

/**
 * Compare two versions of a policy body.
 *
 * `before` is the frozen revision, `after` the live note. Frontmatter is
 * stripped from both by `splitSections`, so a frozen copy that carries a
 * snapshot of the frontmatter does not report every field as a change.
 */
export function diffPolicy(before: string, after: string): PolicyDiff {
  const beforeSections = splitSections(before);
  const afterSections = splitSections(after);

  const byKeyBefore = new Map<string, Section>();
  for (const section of beforeSections) byKeyBefore.set(sectionKey(section), section);
  const seen = new Set<string>();

  const sections: SectionChange[] = [];
  let coarse = false;

  for (const section of afterSections) {
    const key = sectionKey(section);
    seen.add(key);
    const previous = byKeyBefore.get(key);
    if (previous === undefined) {
      sections.push(wholesale(section, "added"));
      continue;
    }

    const oldLines = meaningful(previous.lines);
    const newLines = meaningful(section.lines);
    const headingMoved = previous.heading.trim() !== section.heading.trim();

    let changes: LineChange[];
    if (oldLines.length > LINE_DIFF_LIMIT || newLines.length > LINE_DIFF_LIMIT) {
      coarse = true;
      const same = oldLines.join("\n") === newLines.join("\n");
      changes = same
        ? []
        : [
            ...oldLines.map((text) => ({ kind: "removed" as const, text })),
            ...newLines.map((text) => ({ kind: "added" as const, text })),
          ];
    } else {
      changes = diffLines(oldLines, newLines);
    }

    const addedLines = changes.filter((change) => change.kind === "added").length;
    const removedLines = changes.length - addedLines;
    const { lines, omitted } = cap(changes);

    sections.push({
      key,
      label: sectionLabel(section),
      clause: section.clause,
      // A renamed heading is a change even when not one line beneath it moved:
      // "5.2 Onward transfer" becoming "5.2 Onward transfer (prohibited)" is
      // the whole revision.
      kind: changes.length === 0 && !headingMoved ? "unchanged" : "changed",
      addedLines,
      removedLines,
      lines,
      omitted,
    });
  }

  // Sections the new version no longer has. Appended at the end rather than
  // interleaved: there is no position for them in a document they are not in.
  for (const section of beforeSections) {
    const key = sectionKey(section);
    if (!seen.has(key)) sections.push(wholesale(section, "removed"));
  }

  const addedLines = sections.reduce((total, section) => total + section.addedLines, 0);
  const removedLines = sections.reduce((total, section) => total + section.removedLines, 0);

  return {
    sections,
    addedLines,
    removedLines,
    // Compared on the bodies, not the raw text. The live note carries
    // frontmatter and the incoming document usually does not, so a raw
    // comparison is never equal — which would mean the "nothing changed"
    // refusal in `planRevision` could not fire on the one case it exists for.
    // …and trimmed, because stripping a frontmatter block leaves the blank
    // line that followed it and the incoming document has no such line.
    identical: stripFrontmatter(before).trim() === stripFrontmatter(after).trim(),
    whitespaceOnly: addedLines === 0 && removedLines === 0,
    coarse,
  };
}

/** Only the sections that moved. What the impact map and the report read. */
export function changedSections(diff: PolicyDiff): SectionChange[] {
  return diff.sections.filter((section) => section.kind !== "unchanged");
}

/**
 * Clauses that existed in the old version and are gone from the new one.
 *
 * Separated out because a citation pointing at a deleted clause is the single
 * most dangerous outcome of a revision: the dependant still reads as governed,
 * and the rule it named no longer exists.
 */
export function droppedClauses(diff: PolicyDiff): string[] {
  return diff.sections
    .filter((section) => section.kind === "removed" && section.clause !== "")
    .map((section) => section.clause);
}

/** True when a cited clause matches any section that moved in this revision. */
export function clauseChanged(diff: PolicyDiff, cited: string): boolean {
  return changedSections(diff).some((section) => clauseMatches(cited, section.clause));
}
