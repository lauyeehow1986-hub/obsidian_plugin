/**
 * Freezing a policy revision, and the record it leaves (§5.14, §7 C1).
 *
 * Everything here is planning: paths, note text, the record to append, and the
 * reasons a revision must be refused. Nothing writes — `services/policyWriter`
 * does that, and only after the plan says it may.
 *
 * The order the writer must keep, and why: **freeze first, replace second.**
 * A crash between the two leaves a frozen copy that duplicates the live note,
 * which is harmless. The other order loses the prior text, which is the one
 * thing this whole track exists to preserve.
 *
 * Pure module: no Obsidian, no Node.
 */

import { toVaultDate } from "../time/dates";
import { diffPolicy, changedSections, type PolicyDiff } from "./diff";
import type { ImpactMap } from "./impact";
import { presentVerdict } from "../report/present";
import { policyLabel, type PolicyNote, type RevisionRecord } from "./policy";
import { stripFrontmatter } from "./sections";

/** The type frozen copies carry, so the register never lists one as a policy. */
export const REVISION_TYPE = "policy-revision";

/** Folder name under the policies folder, as §5.14 names it. */
export const REVISIONS_FOLDER = "_revisions";

/**
 * A version string, made safe for a filename.
 *
 * Real versions include "2026-A" and "v4 final"; none of that is a problem,
 * but a slash would silently create a folder and a colon is illegal on
 * Windows, which is the platform this runs on.
 */
export function sanitiseVersion(version: string): string {
  const cleaned = version
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");
  return cleaned === "" ? "unversioned" : cleaned;
}

/** The basename a policy's frozen copies are filed under. */
export function revisionStem(policy: PolicyNote): string {
  const basename = policy.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  return policy.id !== "" ? policy.id : basename || "policy";
}

/**
 * Where a frozen copy goes. `taken` lets the caller rule out names already in
 * the vault: an issuer may reissue under the same version number, and the
 * honest record of that is two files, not one overwritten one (rule 8).
 */
export function revisionPath(
  policiesFolder: string,
  policy: PolicyNote,
  version: string,
  at: number,
  taken: (path: string) => boolean = () => false,
): string {
  const folder = `${policiesFolder}/${REVISIONS_FOLDER}`;
  const stem = `${revisionStem(policy)}@${sanitiseVersion(version)}`;
  const first = `${folder}/${stem}.md`;
  if (!taken(first)) return first;

  const dated = `${folder}/${stem} (${toVaultDate(at)}).md`;
  if (!taken(dated)) return dated;

  for (let n = 2; n < 100; n += 1) {
    const candidate = `${folder}/${stem} (${toVaultDate(at)}-${n}).md`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(
    `Cannot find an unused name for a frozen copy of ${policyLabel(policy)} version ${version}.`,
  );
}

/** Where the impact report for a revision is written, beside the frozen copy. */
export function impactReportPath(frozenPath: string): string {
  return frozenPath.replace(/\.md$/i, " impact.md");
}

/**
 * The raw frontmatter block of a note, without its `---` fences.
 *
 * Taken as text rather than re-serialised from the parsed object: the frozen
 * copy is evidence of what the note said, and round-tripping through a YAML
 * writer would quietly reformat it — dropping comments, reordering keys and
 * refolding long strings. Empty when the note has no frontmatter.
 */
export function frontmatterBlock(text: string): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  if (!normalised.startsWith("---\n")) return "";
  const end = normalised.indexOf("\n---", 3);
  return end === -1 ? "" : normalised.slice(4, end + 1);
}

function yamlString(value: string): string {
  // Quote whenever the value could be read as anything but a plain string.
  return /^[\w .@/&()+-]*$/.test(value) && value.trim() === value && value !== ""
    ? value
    : JSON.stringify(value);
}

/**
 * The frozen copy: a header saying what it is, then the body verbatim.
 *
 * The original frontmatter is **not** copied into the snapshot's own
 * frontmatter — merging two policies' worth of keys would produce a note that
 * looks live. It goes into a fenced block in the body instead, so nothing the
 * user wrote is lost (rule 8) and nothing in it is machine-read by mistake.
 */
export function buildFrozenNote(input: {
  policy: PolicyNote;
  /** The full current text of the policy note, frontmatter and all. */
  currentText: string;
  version: string;
  at: number;
  actor: string;
  summary: string;
  frontmatterYaml: string;
}): string {
  const { policy, version, at, actor, summary } = input;
  const frontmatter = [
    "---",
    `type: ${REVISION_TYPE}`,
    `of: ${yamlString(policy.path.replace(/\.md$/i, ""))}`,
    `policy_id: ${yamlString(policy.id)}`,
    `version: ${yamlString(version)}`,
    `frozen: ${toVaultDate(at)}`,
    `by: ${yamlString(actor)}`,
    `summary: ${yamlString(summary)}`,
    "---",
  ].join("\n");

  const notice = [
    "",
    `> **Frozen copy — never edited.** This is ${policyLabel(policy)} as it stood at`,
    `> version ${version}, frozen on ${toVaultDate(at)} by ${actor || "an unnamed actor"}.`,
    "> Edit the live policy note, not this one; the impact map beside it was computed",
    "> against this text.",
    "",
  ].join("\n");

  const snapshot =
    input.frontmatterYaml.trim() === ""
      ? ""
      : ["", "## Frontmatter as it stood", "", "```yaml", input.frontmatterYaml.trim(), "```", ""].join(
          "\n",
        );

  return `${frontmatter}\n${notice}${stripFrontmatter(input.currentText).replace(/^\n+/, "\n")}${snapshot}`;
}

/** The record appended to the live note's `revisions:` list. */
export function revisionRecord(input: {
  version: string;
  frozen: string;
  at: number;
  actor: string;
  summary: string;
}): Record<string, unknown> {
  return {
    version: input.version,
    frozen: input.frozen,
    on: toVaultDate(input.at),
    by: input.actor,
    summary: input.summary,
  };
}

export interface RevisionPlan {
  /** Empty when the revision may go ahead. Each is a plain-English reason. */
  refusals: string[];
  /** Things worth saying yes to deliberately. Never block. */
  warnings: string[];
  diff: PolicyDiff;
  /** Where the frozen copy will be written. */
  frozenPath: string;
  /** The version the frozen copy is filed under — the *outgoing* one. */
  frozenVersion: string;
}

export interface PlanRevisionInput {
  policy: PolicyNote;
  /** The text currently in the policy note, frontmatter and all. */
  currentText: string;
  /** The replacement text, frontmatter and all (usually none). */
  incomingText: string;
  /** The version the incoming document declares. */
  newVersion: string;
  policiesFolder: string;
  at: number;
  taken?: (path: string) => boolean;
}

/**
 * Decide whether a revision can be frozen, and what it would do.
 *
 * The refusals are the governance content. A revision that cannot be told
 * apart from its predecessor later is not a revision worth recording, and the
 * plugin says which of those two problems it has rather than writing the file
 * and leaving the mess to be discovered.
 */
export function planRevision(input: PlanRevisionInput): RevisionPlan {
  const { policy, at } = input;
  const refusals: string[] = [];
  const warnings: string[] = [];

  const outgoing = policy.version.trim();
  if (outgoing === "") {
    refusals.push(
      "The policy note has no `version`, so the frozen copy has nothing to be filed under. Add the version printed on the current document first.",
    );
  }

  const incomingVersion = input.newVersion.trim();
  if (incomingVersion === "") {
    refusals.push("Give the version the new document is issued under — it goes on the live note.");
  }

  const diff = diffPolicy(input.currentText, input.incomingText);
  if (diff.identical) {
    refusals.push(
      "The incoming text is identical to the current note, so there is nothing to freeze. Use “Freeze the current version” if you want a baseline snapshot.",
    );
  } else if (diff.whitespaceOnly) {
    warnings.push(
      "The two documents differ only in whitespace or line endings — usually a re-export rather than a revision. Every dependant will come back clear.",
    );
  }

  if (incomingVersion !== "" && outgoing !== "" && incomingVersion === outgoing) {
    warnings.push(
      `Both versions read "${outgoing}". That happens when an issuer reissues without renumbering; the frozen copy gets a dated name so the two can be told apart.`,
    );
  }

  if (diff.coarse) {
    warnings.push(
      "At least one section was too large to compare line by line, so it is reported as wholly replaced.",
    );
  }

  const changed = changedSections(diff);
  const unnumbered = changed.filter((section) => section.clause === "").length;
  if (changed.length > 0 && unnumbered === changed.length) {
    warnings.push(
      "None of the changed sections carries a clause number, so every dependant that cites one will come back clear. Check the headings before trusting that.",
    );
  }

  const frozenVersion = outgoing === "" ? "unversioned" : outgoing;
  const frozenPath =
    refusals.length > 0
      ? ""
      : revisionPath(input.policiesFolder, policy, frozenVersion, at, input.taken);

  return { refusals, warnings, diff, frozenPath, frozenVersion };
}

/**
 * The impact report, as a markdown note.
 *
 * Written beside the frozen copy rather than into the policy note: §5.1's rule
 * that the plugin never rewrites prose applies here too, and an impact map is
 * a dated finding about one revision, not part of the policy.
 */
export function renderImpactReport(input: {
  map: ImpactMap;
  diff: PolicyDiff;
  fromVersion: string;
  toVersion: string;
  frozenPath: string;
  at: number;
  actor: string;
}): string {
  const { map, diff, at } = input;
  const policy = map.policy;
  const date = toVaultDate(at);

  const lines: string[] = [
    "---",
    "type: policy-impact",
    `of: ${yamlString(policy.path.replace(/\.md$/i, ""))}`,
    `policy_id: ${yamlString(policy.id)}`,
    `from_version: ${yamlString(input.fromVersion)}`,
    `to_version: ${yamlString(input.toVersion)}`,
    `on: ${date}`,
    `by: ${yamlString(input.actor)}`,
    "---",
    "",
    `# Impact of ${policyLabel(policy)} version ${input.toVersion}`,
    "",
    `Version ${input.fromVersion} → ${input.toVersion}, assessed ${date} by ${input.actor || "an unnamed actor"}.`,
    `Prior text frozen at [[${input.frozenPath.replace(/\.md$/i, "")}]].`,
    "",
    map.headline,
    "",
  ];

  if (map.counts.review > 0) {
    lines.push(
      "Rows marked **Review** cite no clause. They are not judged unaffected — the",
      "vault has no basis to say either way. Adding a `clause:` to the dependant is",
      "what turns one into an answer next time.",
      "",
    );
  }

  lines.push("## What changed", "");
  const changed = changedSections(diff);
  if (changed.length === 0) {
    lines.push("Nothing but whitespace.", "");
  } else {
    lines.push("| Section | Change | + | − |", "|---|---|---:|---:|");
    for (const section of changed) {
      lines.push(
        `| ${section.label} | ${section.kind} | ${section.addedLines} | ${section.removedLines} |`,
      );
    }
    lines.push("");
  }

  if (map.droppedClauses.length > 0) {
    lines.push(
      `**Clauses that no longer exist:** ${map.droppedClauses.join(", ")}.`,
      "",
    );
  }

  lines.push("## What rests on it", "");
  if (map.rows.length === 0) {
    lines.push(map.headline, "");
  } else {
    for (const group of map.groups) {
      lines.push(`### ${group.label}`, "", "| | Depends on | Clause | Verdict | Why |", "|---|---|---|---|---|");
      for (const row of group.rows) {
        const ref = row.edge.ref.startsWith("[[") ? row.edge.ref : `\`${row.edge.ref}\``;
        const missing = row.resolved === false ? " ⚠ not found in the vault" : "";
        lines.push(
          `| ${presentVerdict(row.verdict).glyph} | ${ref}${missing} | ${row.edge.clause || "—"} | ${presentVerdict(row.verdict).label} | ${row.reason} |`,
        );
      }
      lines.push("");
    }
  }

  if (map.unclaimedClauses.length > 0) {
    lines.push(
      "## Changed clauses nothing claims",
      "",
      `${map.unclaimedClauses.join(", ")} moved, and no note in the vault says it rests on ${map.unclaimedClauses.length === 1 ? "it" : "them"}.`,
      "That is more often an undeclared dependency than a genuinely free clause.",
      "",
    );
  }

  lines.push(
    "---",
    "",
    "*Computed by SCDB Cockpit from declared dependencies. It reports what the vault",
    "was told, not what is true of the institution — an undeclared dependency cannot",
    "appear here.*",
    "",
  );

  return lines.join("\n");
}

/** A revision record read back, newest first, for the register's detail view. */
export function revisionsNewestFirst(policy: PolicyNote): RevisionRecord[] {
  return [...policy.revisions].sort((a, b) => (b.on ?? 0) - (a.on ?? 0));
}
