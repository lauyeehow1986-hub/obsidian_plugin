/**
 * Policy and SOP notes (CLAUDE.md §5.14, §7 C1).
 *
 * §5.14 names the note type and the folder and stops there, so the fields
 * below are this module's contract. They exist to serve one question the track
 * is built around — *when this policy changes, what in the vault has to be
 * looked at* — and nothing here is decorative.
 *
 * **The dependency edge is declarable from both ends, deliberately.** A policy
 * may list what it `governs:`; a local SOP may name what it `derives_from:`.
 * Whoever writes the local SOP is usually the person who knows it implements
 * clause 5.2 of something, and requiring them to go and edit the institutional
 * policy note to say so is how an impact map ends up empty. Both directions
 * fold into one edge list (`impact.ts`), so it does not matter which end was
 * used.
 *
 * **`clause` is what makes the map worth having.** An edge that names the
 * clause it rests on can be told apart from one that does not, and a change to
 * clause 5.2 then flags the three things resting on 5.2 rather than the
 * forty resting on the document. An edge with no clause is never reported as
 * unaffected — see `impact.ts` — because we do not know that.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseParty, type Party } from "../comms/party";
import { parseTimestamp } from "../time/dates";

export const POLICY_TYPE = "policy";

/**
 * Where a policy comes from, which decides who can change it.
 *
 * The distinction is operational, not bureaucratic: an `institutional` policy
 * arrives already decided and the work is absorbing it, while an `scdb` SOP is
 * one we own and must revise ourselves when the policy above it moves. The
 * impact map's whole job is turning the first into a list of the second.
 */
export const POLICY_SCOPES = ["institutional", "departmental", "scdb", "external"] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export function isPolicyScope(value: unknown): value is PolicyScope {
  return typeof value === "string" && (POLICY_SCOPES as readonly string[]).includes(value);
}

export const POLICY_STATUSES = ["draft", "current", "superseded", "withdrawn"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export function isPolicyStatus(value: unknown): value is PolicyStatus {
  return typeof value === "string" && (POLICY_STATUSES as readonly string[]).includes(value);
}

export const STATUS_LABELS: Record<PolicyStatus, string> = {
  draft: "Draft",
  current: "In force",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

/**
 * What kind of thing an edge points at.
 *
 * A closed vocabulary because the impact map groups by it, and because an
 * open one would let two spellings of "form" sit in separate groups on the
 * same board. `other` is the escape hatch and is rendered as written.
 */
export const EDGE_KINDS = [
  "policy",
  "workflow",
  "gate",
  "form",
  "variable",
  "study",
  "script",
  "template",
  "other",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === "string" && (EDGE_KINDS as readonly string[]).includes(value);
}

export const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  policy: "Local SOP",
  workflow: "Workflow",
  gate: "Request gate",
  form: "Form",
  variable: "Catalogue variable",
  study: "Study",
  script: "Script",
  template: "Template",
  other: "Other",
};

/** One thing that rests on a policy, as declared from either end. */
export interface PolicyEdge {
  kind: EdgeKind;
  /** As written — a wikilink, a workflow id, a `workflow:stage` gate ref. */
  ref: string;
  /** Display form of `ref`, folder and alias stripped. */
  label: string;
  /** The clause it rests on, e.g. "5.2". Empty when the note does not say. */
  clause: string;
  /** Free text from the note, shown beside the row. */
  note: string;
  /**
   * Which note declared this edge — the policy itself, or the dependant.
   *
   * Carried through to the impact map so a row can say where the claim came
   * from. An edge nobody can trace back is one nobody will maintain.
   */
  declaredBy: string;
}

/** A frozen prior version, as recorded on the live note. */
export interface RevisionRecord {
  /** The issuer's version number this snapshot holds. */
  version: string;
  /** Vault path of the frozen copy in `_revisions/`. */
  frozen: string;
  /** Epoch ms the freeze happened, or null when unreadable. */
  on: number | null;
  by: string;
  /** One line on what changed, written at freeze time. */
  summary: string;
}

export interface PolicyNote {
  path: string;
  id: string;
  title: string;
  /** The issuer. A wikilink when there is a person or body note for them. */
  authority: Party | null;
  scope: PolicyScope | "";
  status: PolicyStatus | "";
  /**
   * The issuer's version, as printed on the document — a string, not a number.
   *
   * Real policies are versioned "3", "3.1", "2026-A" and "v4 final". Coercing
   * that to a number would silently turn "3.1" into 3.1 and "2026-A" into
   * nothing, and the version is what a frozen revision is filed under.
   */
  version: string;
  /** Epoch ms, or null. */
  effective: number | null;
  reviewDue: number | null;
  supersedes: string;
  /** Declared from this note's own `governs:`. */
  governs: PolicyEdge[];
  /** Policies this note declares itself derived from — the upstream edge. */
  derivesFrom: PolicyEdge[];
  revisions: RevisionRecord[];
  problems: string[];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A clause reference, normalised.
 *
 * "§5.2", "5.2.", "clause 5.2" and "5.2" are one clause. Trailing dots go
 * because a numbered heading usually carries one and an edge usually does not.
 */
export function normaliseClause(value: unknown): string {
  return str(value)
    .replace(/^(?:clause|section|para(?:graph)?)\s+/i, "")
    .replace(/^[§¶\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

/** The readable half of a ref: folder path and alias stripped from a wikilink. */
export function edgeLabel(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("[[")) return parseParty(trimmed).name;
  return trimmed;
}

/**
 * Read one edge.
 *
 * Accepts the long mapping form and a bare string. The bare form is there
 * because `derives_from: "[[POL-DATA-REL-02]]"` is what somebody will actually
 * type on a local SOP, and refusing it would mean the common case needs the
 * verbose syntax.
 */
function parseEdge(
  raw: unknown,
  fallbackKind: EdgeKind,
  declaredBy: string,
  index: number,
  field: string,
  problems: string[],
): PolicyEdge | null {
  if (typeof raw === "string") {
    const ref = raw.trim();
    if (ref === "") return null;
    return { kind: fallbackKind, ref, label: edgeLabel(ref), clause: "", note: "", declaredBy };
  }

  if (!isRecord(raw)) {
    problems.push(`\`${field}[${index}]\` is neither a link nor a mapping and was ignored.`);
    return null;
  }

  const ref = str(raw["ref"]);
  if (ref === "") {
    problems.push(`\`${field}[${index}]\` has no \`ref\`, so there is nothing to point at.`);
    return null;
  }

  const declared = str(raw["what"] ?? raw["kind"]);
  let kind: EdgeKind = fallbackKind;
  if (declared !== "") {
    if (isEdgeKind(declared)) kind = declared;
    else {
      kind = "other";
      problems.push(
        `\`${field}[${index}]\` says what: "${declared}", which is not one of ${EDGE_KINDS.join(", ")}. Filed under "other".`,
      );
    }
  }

  return {
    kind,
    ref,
    label: edgeLabel(ref),
    clause: normaliseClause(raw["clause"]),
    note: str(raw["note"]),
    declaredBy,
  };
}

function parseEdges(
  raw: unknown,
  fallbackKind: EdgeKind,
  declaredBy: string,
  field: string,
  problems: string[],
): PolicyEdge[] {
  const edges: PolicyEdge[] = [];
  list(raw).forEach((entry, index) => {
    const edge = parseEdge(entry, fallbackKind, declaredBy, index, field, problems);
    if (edge !== null) edges.push(edge);
  });
  return edges;
}

function parseRevisions(raw: unknown, problems: string[]): RevisionRecord[] {
  const revisions: RevisionRecord[] = [];
  list(raw).forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`\`revisions[${index}]\` is not a mapping and was ignored.`);
      return;
    }
    const version = str(entry["version"]);
    const frozen = str(entry["frozen"]);
    if (version === "" || frozen === "") {
      problems.push(
        `\`revisions[${index}]\` needs both \`version\` and \`frozen\`; it names ${version === "" ? "no version" : "no frozen copy"}.`,
      );
      return;
    }
    revisions.push({
      version,
      frozen,
      on: parseTimestamp(entry["on"]),
      by: str(entry["by"]),
      summary: str(entry["summary"]),
    });
  });

  // Newest freeze first: the last revision is the one anyone asks about.
  return revisions.sort((a, b) => (b.on ?? 0) - (a.on ?? 0));
}

export function parsePolicy(path: string, raw: Record<string, unknown>): PolicyNote {
  const problems: string[] = [];

  const scope = str(raw["scope"]);
  if (scope !== "" && !isPolicyScope(scope)) {
    problems.push(`Scope "${scope}" is not one of ${POLICY_SCOPES.join(", ")}.`);
  }

  const status = str(raw["status"]);
  if (status !== "" && !isPolicyStatus(status)) {
    problems.push(`Status "${status}" is not one of ${POLICY_STATUSES.join(", ")}.`);
  }

  const version = str(raw["version"]);
  if (version === "") {
    // Not fatal, but a policy with no version cannot have a revision frozen
    // under a name, and the freeze command says so rather than inventing one.
    problems.push("No `version`, so a revision cannot be frozen under a version name.");
  }

  const effective = parseTimestamp(raw["effective"]);
  if (raw["effective"] !== undefined && effective === null) {
    problems.push("`effective` is not a date the plugin can read.");
  }
  const reviewDue = parseTimestamp(raw["review_due"]);
  if (raw["review_due"] !== undefined && reviewDue === null) {
    problems.push("`review_due` is not a date the plugin can read.");
  }

  const authorityRaw = str(raw["authority"]);

  return {
    path,
    id: str(raw["id"]),
    title: str(raw["title"]),
    authority: authorityRaw === "" ? null : parseParty(authorityRaw),
    scope: isPolicyScope(scope) ? scope : "",
    status: isPolicyStatus(status) ? status : "",
    version,
    effective,
    reviewDue,
    supersedes: str(raw["supersedes"]),
    governs: parseEdges(raw["governs"], "other", path, "governs", problems),
    derivesFrom: parseEdges(raw["derives_from"], "policy", path, "derives_from", problems),
    revisions: parseRevisions(raw["revisions"], problems),
    problems,
  };
}

/**
 * Which kind of edge a note of a given `type:` contributes.
 *
 * A form that derives from a policy is a form on the impact map, not an
 * "other" — the grouping is what makes the map skimmable, and the note already
 * says what it is.
 */
const TYPE_EDGE_KINDS: Record<string, EdgeKind> = {
  policy: "policy",
  "redcap-form": "form",
  variable: "variable",
  "script-doc": "script",
  study: "study",
};

/**
 * The dependency a note declares on something upstream, read from any note.
 *
 * The counterpart to a policy's `governs:`. Any note type may carry
 * `derives_from:`, and this is how the impact map hears about a local SOP, a
 * consent template or a REDCap form that names the policy it implements —
 * without that policy's own note having to list them.
 */
export function noteDependencyEdges(
  path: string,
  type: string,
  raw: Record<string, unknown>,
): PolicyEdge[] {
  const problems: string[] = [];
  const kind = TYPE_EDGE_KINDS[type] ?? "other";
  return parseEdges(raw["derives_from"], kind, path, "derives_from", problems);
}

/**
 * True when a ref written on some other note points at this policy.
 *
 * A markdown vault means the ref is whatever somebody typed: the id, the
 * filename, or a path. All three are accepted; matching only one of them would
 * make the impact map depend on a spelling convention nobody agreed to.
 */
export function refMatchesPolicy(ref: string, policy: PolicyNote): boolean {
  const target = edgeLabel(ref).toLowerCase();
  if (target === "") return false;
  const basename = policy.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  return (
    target === policy.id.toLowerCase() ||
    target === basename.toLowerCase() ||
    target === policy.path.replace(/\.md$/i, "").toLowerCase() ||
    target === policy.title.toLowerCase()
  );
}

/** How a policy note is named for a human: "POL-x — Title", or whichever exists. */
export function policyLabel(policy: PolicyNote): string {
  if (policy.id !== "" && policy.title !== "") return `${policy.id} — ${policy.title}`;
  return policy.id || policy.title || policy.path;
}

/** A policy's status label, or the raw value when the note says something else. */
export function statusLabel(status: string): string {
  return isPolicyStatus(status) ? STATUS_LABELS[status] : status || "Unstated";
}

/**
 * Which version of a policy was in force on a given date.
 *
 * The question C2 will be asked about variables (§5.8) and the question an
 * auditor asks about a policy: *what did the rule say when this extraction
 * ran?* Answered from the frozen revisions plus the live note, so it is only
 * ever as good as the freezes — which is why it says when it does not know.
 */
export interface InForce {
  /** The issuer version in force, or "" when it cannot be determined. */
  version: string;
  /** Vault path of the text: a frozen copy, or the live note. */
  path: string;
  /** True when the answer is the live note rather than a frozen snapshot. */
  live: boolean;
  /** Plain English, for the row that shows it. */
  note: string;
}

export function versionInForceOn(policy: PolicyNote, at: number): InForce {
  const live = { version: policy.version, path: policy.path, live: true, note: "" };

  if (policy.effective === null) {
    return {
      ...live,
      note: "the note gives no `effective` date, so this is the current text, not a dated answer",
    };
  }
  if (at >= policy.effective) {
    return { ...live, note: "the version in force since the note's `effective` date" };
  }

  // Before the current version took effect: the newest freeze that was already
  // frozen by then is the best evidence we hold. Revisions are newest first.
  const frozen = policy.revisions.find((revision) => revision.on !== null && revision.on <= at);
  if (frozen === undefined) {
    return {
      version: "",
      path: "",
      live: false,
      note: "no revision was frozen before that date, so the vault cannot say what the text was",
    };
  }
  return {
    version: frozen.version,
    path: frozen.frozen,
    live: false,
    note: `from the copy frozen ${frozen.summary === "" ? "in `_revisions/`" : `in \`_revisions/\`: ${frozen.summary}`}`,
  };
}
