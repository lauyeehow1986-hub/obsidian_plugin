/**
 * The study note (`20 Studies/`, §5 vault contract).
 *
 * §5 gives studies a folder — "one note per study or registry" — and every
 * other note type links to one, but until now nothing read a study note. D2
 * has to: §7 requires that "every field flagged as an identifier is checked
 * against the linked study's approved IRB scope", and that scope has to be
 * written down somewhere a person maintains.
 *
 * **This deliberately invents no vocabulary.** `governance.identifiers` is
 * §5.1's field with §5.1's closed values (`none | indirect | direct`), and
 * `irb_ref` / `irb_expiry` are §5.1's spelling. A request already carries the
 * same block; a study carries the *approved* scope, and a request carries what
 * that request actually asks for. Two levels of the same question, in the same
 * words, so a reader who understands one understands the other.
 *
 * **A study that records no scope is not a study with a scope of `none`.**
 * `approved` is `null` in that case and every check against it reports "cannot
 * be checked from here" rather than a pass or a fail. Same discipline as C3's
 * undated runs and C2's unresolvable definitions: the honest answer to an
 * unanswerable question is that nobody wrote it down. Reading a missing scope
 * as `none` would produce loud false alarms that get ignored; reading it as
 * permissive would produce a governance instrument that approves by silence,
 * which is worse.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseParty, sameParty } from "../comms/party";
import { parseTimestamp } from "../time/dates";

export const STUDY_TYPE = "study";

/** §5.1's vocabulary, and the only one. */
export const IDENTIFIER_SCOPES = ["none", "indirect", "direct"] as const;
export type IdentifierScope = (typeof IDENTIFIER_SCOPES)[number];

export function isIdentifierScope(value: unknown): value is IdentifierScope {
  return typeof value === "string" && (IDENTIFIER_SCOPES as readonly string[]).includes(value);
}

export const IDENTIFIER_SCOPE_LABELS: Record<IdentifierScope, string> = {
  none: "No identifiers",
  indirect: "Indirect identifiers",
  direct: "Direct identifiers",
};

/** How much a scope permits, so two can be compared. */
export const SCOPE_RANK: Record<IdentifierScope, number> = { none: 0, indirect: 1, direct: 2 };

export interface StudyNote {
  path: string;
  id: string;
  title: string;
  /** The approved identifier scope, or null when the note does not record one. */
  approved: IdentifierScope | null;
  irbRef: string;
  /** Epoch ms, or null. */
  irbExpiry: number | null;
  status: string;
  problems: string[];
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseStudy(input: { path: string; frontmatter: Record<string, unknown> }): StudyNote {
  const raw = input.frontmatter;
  const problems: string[] = [];

  const basename = input.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  const governance = isRecord(raw["governance"]) ? raw["governance"] : {};
  if (raw["governance"] !== undefined && !isRecord(raw["governance"])) {
    problems.push("`governance` is not a mapping, so the approved identifier scope cannot be read.");
  }

  const scopeRaw = str(governance["identifiers"]);
  let approved: IdentifierScope | null = null;
  if (scopeRaw !== "") {
    if (isIdentifierScope(scopeRaw)) {
      approved = scopeRaw;
    } else {
      problems.push(
        `\`governance.identifiers\` is "${scopeRaw}", which is not one of ${IDENTIFIER_SCOPES.join(", ")}. Treated as not recorded.`,
      );
    }
  }

  const irbExpiryRaw = governance["irb_expiry"];
  const irbExpiry = parseTimestamp(irbExpiryRaw);
  if (irbExpiryRaw !== undefined && irbExpiry === null) {
    problems.push("`governance.irb_expiry` is not a date that can be read.");
  }

  return {
    path: input.path,
    id: str(raw["id"]) || basename,
    title: str(raw["title"]) || basename,
    approved,
    irbRef: str(governance["irb_ref"]),
    irbExpiry,
    status: str(raw["status"]),
    problems,
  };
}

/**
 * Find the study a note points at.
 *
 * Studies are named as ordinary wikilinks — `[[EuroHeart]]`,
 * `[[20 Studies/EuroHeart]]`, or a bare name — because this is a markdown
 * vault, not a database (§5.2). `sameParty` already exists for exactly this
 * comparison and its own comment names studies as the case it handles, so the
 * matching rule stays in one place: a second normaliser here is a second thing
 * to keep in step with the effort log's bare-name spelling.
 */
export function findStudy(reference: string, studies: readonly StudyNote[]): StudyNote | null {
  const party = parseParty(reference);
  if (party.key === "") return null;

  for (const study of studies) {
    const basename = (study.path.split("/").pop() ?? "").replace(/\.md$/i, "");
    if (
      sameParty(reference, study.id) ||
      sameParty(reference, study.title) ||
      sameParty(reference, basename)
    ) {
      return study;
    }
  }
  return null;
}
