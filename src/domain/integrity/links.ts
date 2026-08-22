/**
 * Link and reference integrity (CLAUDE.md §7 A4).
 *
 * §5.2 splits identity in two, and the split is what makes this check
 * necessary: `uid` is what durable machine references point at, while
 * human-facing links stay ordinary wikilinks because this is a markdown vault
 * and not a database. Two naming systems over the same notes drift, and this is
 * the module that reconciles them and says where.
 *
 * **It reports; it never deletes.** The only repair offered anywhere here is
 * creating a note that something already points at — additive, reversible, and
 * exactly what an unresolved `[[Dr A Tan]]` is asking for. Everything else is
 * named with the remedy in words, because the fixes are judgement calls: which
 * of two notes claiming one `uid` is the impostor is not a question this code
 * can answer, and guessing would break every reference that resolved correctly.
 *
 * Pure module: no Obsidian, no Node.
 */

import { isUlid } from "../id/ulid";

export type FindingKind =
  | "unresolved-link"
  | "duplicate-uid"
  | "duplicate-id"
  | "missing-uid"
  | "dangling-uid"
  | "ledger-orphan";

/** Severity, so the report leads with what actually breaks something. */
export const FINDING_ORDER: readonly FindingKind[] = [
  "duplicate-uid",
  "missing-uid",
  "dangling-uid",
  "duplicate-id",
  "ledger-orphan",
  "unresolved-link",
];

export interface Repair {
  /** The only repair this module offers: create the note being pointed at. */
  kind: "create-note";
  path: string;
  title: string;
}

export interface Finding {
  kind: FindingKind;
  /** The note the problem was found in. Empty for a ledger finding. */
  path: string;
  /** What the finding is about: a link target, a uid, a request id. */
  subject: string;
  message: string;
  repair?: Repair;
}

/** A note as the integrity check needs to see it. */
export interface IntegrityNote {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
}

export interface IntegrityInput {
  notes: readonly IntegrityNote[];
  /** Resolve a wikilink target the way Obsidian would. Null when it resolves to nothing. */
  resolve: (target: string, fromPath: string) => string | null;
  /**
   * Where a stub for a link found in this frontmatter field belongs, or "" when
   * we should not offer to create one. Keeps the folder map — which is a
   * setting — out of a pure module.
   */
  folderFor: (field: string) => string;
  /** `subject` values from the audit ledger, to reconcile against live notes. */
  ledgerSubjects: readonly string[];
  /** Note types whose `uid` is a durable machine reference (§5.2). */
  uidTypes: readonly string[];
}

const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Every `[[target]]` in a frontmatter value, with the field it came from. */
export function frontmatterLinks(
  frontmatter: Record<string, unknown>,
): { field: string; target: string }[] {
  const found: { field: string; target: string }[] = [];

  const walk = (field: string, value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(WIKILINK)) {
        const target = match[1]!.trim();
        if (target !== "") found.push({ field, target });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(field, item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      // Nested mappings keep the top-level field name: `evidence[0].by` belongs
      // to `evidence` as far as "where should a stub go" is concerned.
      for (const item of Object.values(value)) walk(field, item);
    }
  };

  for (const [field, value] of Object.entries(frontmatter)) walk(field, value);
  return found;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The last path segment without its extension. */
function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function checkIntegrity(input: IntegrityInput): Finding[] {
  const findings: Finding[] = [];

  const byUid = new Map<string, string[]>();
  const byId = new Map<string, string[]>();
  const knownUids = new Set<string>();
  const knownIds = new Set<string>();
  const durable = new Set(input.uidTypes);

  for (const note of input.notes) {
    const uid = str(note.frontmatter["uid"]);
    const id = str(note.frontmatter["id"]);
    if (uid !== "") {
      knownUids.add(uid);
      byUid.set(uid, [...(byUid.get(uid) ?? []), note.path]);
    }
    if (id !== "") {
      knownIds.add(id);
      byId.set(id, [...(byId.get(id) ?? []), note.path]);
    }
  }

  // --- identity ------------------------------------------------------------

  for (const [uid, paths] of byUid) {
    if (paths.length < 2) continue;
    findings.push({
      kind: "duplicate-uid",
      path: paths[0]!,
      subject: uid,
      // §5.2: a uid is immutable and never reused. Two notes claiming one means
      // a note was copied, and every machine reference to it is now ambiguous.
      message: `${paths.length} notes claim uid ${uid}: ${paths.join(", ")}. A uid is never reused, so one of these was copied from the other. Decide which keeps it and give the other a fresh one — do not edit anything that points at it until you have.`,
    });
  }

  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    findings.push({
      kind: "duplicate-id",
      path: paths[0]!,
      subject: id,
      message: `${paths.length} notes carry id ${id}: ${paths.join(", ")}. Human labels may be renumbered, so this is fixable by renaming one — but until it is, any wikilink using this id is ambiguous.`,
    });
  }

  for (const note of input.notes) {
    if (!durable.has(note.type)) continue;
    if (str(note.frontmatter["uid"]) !== "") continue;
    findings.push({
      kind: "missing-uid",
      path: note.path,
      subject: basename(note.path),
      message:
        "No `uid`. Run records, correspondence threads and audit entries point at uids (§5.2), so nothing durable can reference this note until it has one.",
    });
  }

  // --- references ----------------------------------------------------------

  for (const note of input.notes) {
    const own = str(note.frontmatter["uid"]);

    // One finding per missing target, not per link to it. A request typically
    // names the same person in `requester`, `blocked_on`, an evidence record
    // and two history entries; five rows saying the same thing would bury the
    // twenty other notes with the same gap.
    const missing = new Map<string, string[]>();
    for (const { field, target } of frontmatterLinks(note.frontmatter)) {
      if (input.resolve(target, note.path) !== null) continue;
      const fields = missing.get(target) ?? [];
      if (!fields.includes(field)) fields.push(field);
      missing.set(target, fields);
    }

    for (const [target, fields] of missing) {
      // The first field that knows where the note belongs decides. `history`
      // records what was true and cannot say where anything lives now.
      const folder = fields.map(input.folderFor).find((value) => value !== "") ?? "";
      findings.push({
        kind: "unresolved-link",
        path: note.path,
        subject: target,
        message: `${fields.map((field) => `\`${field}\``).join(", ")} link${
          fields.length === 1 ? "s" : ""
        } to [[${target}]], which is not a note in this vault.`,
        ...(folder === ""
          ? {}
          : { repair: { kind: "create-note", path: `${folder}/${target}.md`, title: target } }),
      });
    }

    // A ULID in a field that is not this note's own `uid` is a reference to
    // another note. Nothing else in the vault contract looks like one.
    for (const value of stringsIn(note.frontmatter)) {
      if (!isUlid(value) || value === own || knownUids.has(value)) continue;
      findings.push({
        kind: "dangling-uid",
        path: note.path,
        subject: value,
        message: `References uid ${value}, which no note in this vault carries. The note it pointed at was deleted, or its uid was changed.`,
      });
    }
  }

  // --- the ledger ----------------------------------------------------------

  // Deliberately a warning and nothing more. The ledger is append-only and
  // records what happened; a subject that no longer exists is a fact about
  // history, not damage — a request may have been legitimately deleted. What
  // matters is that it is visible rather than assumed.
  const orphans = [...new Set(input.ledgerSubjects)].filter(
    (subject) => subject !== "" && !knownIds.has(subject) && !knownUids.has(subject),
  );
  for (const subject of orphans) {
    findings.push({
      kind: "ledger-orphan",
      path: "",
      subject,
      message: `The audit ledger records actions on ${subject}, which is not a note in this vault now. Expected if it was deleted or renamed; worth checking if it was not.`,
    });
  }

  return findings.sort(
    (a, b) =>
      FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind) ||
      a.subject.localeCompare(b.subject),
  );
}

/** Every string anywhere in a frontmatter tree. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value.trim());
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) stringsIn(item, out);
  }
  return out;
}

export interface IntegritySummary {
  total: number;
  byKind: { kind: FindingKind; count: number }[];
  /** Findings the plugin could act on, deduplicated by the note it would create. */
  repairs: Repair[];
}

export function summariseIntegrity(findings: readonly Finding[]): IntegritySummary {
  const counts = new Map<FindingKind, number>();
  const repairs = new Map<string, Repair>();

  for (const finding of findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
    // Five requests all pointing at one missing person is one note to create,
    // not five.
    if (finding.repair) repairs.set(finding.repair.path, finding.repair);
  }

  return {
    total: findings.length,
    byKind: FINDING_ORDER.filter((kind) => counts.has(kind)).map((kind) => ({
      kind,
      count: counts.get(kind)!,
    })),
    repairs: [...repairs.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Plain English for a kind, singular and plural. */
export const FINDING_LABEL: Record<FindingKind, { one: string; many: string }> = {
  "duplicate-uid": { one: "note sharing a uid", many: "notes sharing a uid" },
  "missing-uid": { one: "note with no uid", many: "notes with no uid" },
  "dangling-uid": {
    one: "reference to a uid that no longer exists",
    many: "references to a uid that no longer exists",
  },
  "duplicate-id": { one: "note sharing an id", many: "notes sharing an id" },
  "ledger-orphan": {
    one: "ledger entry about a note that is gone",
    many: "ledger entries about notes that are gone",
  },
  "unresolved-link": {
    one: "link to a note that does not exist",
    many: "links to notes that do not exist",
  },
};

/** `3 links to notes that do not exist`. Used on screen and in the report. */
export function describeFindings(kind: FindingKind, count: number): string {
  return `${count} ${count === 1 ? FINDING_LABEL[kind].one : FINDING_LABEL[kind].many}`;
}
