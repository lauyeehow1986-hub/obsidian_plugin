/**
 * The request note model (CLAUDE.md §5.1) and evidence records (§5.5).
 *
 * Frontmatter is the source of truth; the body is narrative. This module reads
 * frontmatter into a shape the engine can reason about and reports what it
 * could not read, rather than silently defaulting. A request whose `history` is
 * unparseable must not quietly show a dwell time of zero.
 *
 * Dwell, age and holdup are **never stored** — see `dwell.ts`. Nothing here
 * writes anything.
 *
 * Pure module: no Obsidian, no Node.
 */

import { parseTimestamp } from "../time/dates";

/** How a claim was evidenced (§5.5, closed vocabulary). */
export const EVIDENCE_VIA = [
  "email",
  "portal",
  "signed-document",
  "meeting-minute",
  "verbal",
] as const;
export type EvidenceVia = (typeof EVIDENCE_VIA)[number];

export function isEvidenceVia(value: unknown): value is EvidenceVia {
  return typeof value === "string" && (EVIDENCE_VIA as readonly string[]).includes(value);
}

/**
 * A governance claim with a provenance, not a boolean.
 *
 * `via: verbal` is allowed but never satisfies a hard gate on its own — that is
 * the whole reason this is a record and not a checkbox.
 */
export interface EvidenceRecord {
  /** The claim, e.g. `dua_signed`, `irb_approval`. */
  claim: string;
  by: string;
  /** Epoch ms, or null when the record carries no readable date. */
  on: number | null;
  via: EvidenceVia | null;
  ref: string;
  artefact: string;
  note: string;
  /** False when `via` is verbal or missing — cannot satisfy a hard gate alone. */
  hard: boolean;
}

export interface HistoryEntry {
  /** Epoch ms. Entries that could not be read are dropped and reported. */
  at: number;
  /** The stage entered. */
  to: string;
  by: string;
  blockedOn: string | null;
  /**
   * True for a workflow-migration relabel (§5.2) rather than a real move.
   * A migration renames the occupancy the request is already sitting in, so
   * `dwell.ts` folds these entries away before measuring anything — renaming a
   * stage must not reset a request's dwell clock or count as a bounce.
   */
  migration: boolean;
  /** The stage id a migration entry replaced. Null on ordinary entries. */
  from: string | null;
}

export interface RequestNote {
  /** Immutable machine identity (§5.1). Machine references point here, never at `id`. */
  uid: string;
  /** Human label, `REQ-YYYY-NNN`. May be renumbered. */
  id: string;
  title: string;
  /** The institutional eData system's ID — the record of truth (§5.1). */
  externalRef: string;
  lastReconciled: number | null;

  workflow: string;
  /** Which spec version this note was last valid under. */
  workflowVersion: number | null;

  stage: string;
  blockedOn: string | null;
  blockedSince: number | null;

  requester: string;
  study: string;
  hat: string;
  assignee: string;
  priority: string;

  received: number | null;
  due: number | null;
  slaDays: number | null;
  effortEstimateHours: number | null;

  evidence: EvidenceRecord[];
  /** Chronological, earliest first. */
  history: HistoryEntry[];

  /** The frontmatter as read, so gates can address fields this model does not name. */
  raw: Record<string, unknown>;
}

export interface ParsedRequest {
  request: RequestNote;
  /** Plain-English notes on what could not be read. Surfaced, never swallowed. */
  problems: string[];
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvidence(raw: unknown, problems: string[]): EvidenceRecord[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("`evidence` is not a list, so no evidence records were read.");
    return [];
  }
  const records: EvidenceRecord[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`evidence[${index}] is not a mapping and was ignored.`);
      return;
    }
    const claim = str(entry["for"]);
    if (claim === "") {
      problems.push(`evidence[${index}] has no \`for\`, so it evidences nothing.`);
      return;
    }
    const rawVia = entry["via"];
    const via = isEvidenceVia(rawVia) ? rawVia : null;
    if (rawVia !== undefined && via === null) {
      problems.push(
        `evidence[${index}] has an unrecognised \`via: ${str(rawVia)}\`; it cannot satisfy a gate.`,
      );
    }
    records.push({
      claim,
      by: str(entry["by"]),
      on: parseTimestamp(entry["on"]),
      via,
      ref: str(entry["ref"]),
      artefact: str(entry["artefact"]),
      note: str(entry["note"]),
      hard: via !== null && via !== "verbal",
    });
  });
  return records;
}

function parseHistory(raw: unknown, problems: string[]): HistoryEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("`history` is not a list, so dwell time cannot be computed.");
    return [];
  }
  const entries: HistoryEntry[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`history[${index}] is not a mapping and was ignored.`);
      return;
    }
    const at = parseTimestamp(entry["at"]);
    const to = str(entry["to"]);
    if (at === null) {
      problems.push(`history[${index}] has no readable \`at\` date and was ignored.`);
      return;
    }
    if (to === "") {
      problems.push(`history[${index}] has no \`to\` stage and was ignored.`);
      return;
    }
    const blockedOn = str(entry["blocked_on"]);
    const from = str(entry["from"]);
    entries.push({
      at,
      to,
      by: str(entry["by"]),
      blockedOn: blockedOn === "" ? null : blockedOn,
      migration: entry["migration"] === true,
      from: from === "" ? null : from,
    });
  });

  // History is read chronologically regardless of how it is written, because
  // dwell maths depends on order and a hand-edited note may not be sorted.
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  if (sorted.some((e, i) => e !== entries[i])) {
    problems.push("`history` was not in date order; it was sorted before computing dwell time.");
  }
  return sorted;
}

/** Read a request note's frontmatter. Never throws. */
export function parseRequest(frontmatter: unknown): ParsedRequest {
  const problems: string[] = [];
  const raw: Record<string, unknown> = isRecord(frontmatter) ? frontmatter : {};
  if (!isRecord(frontmatter)) problems.push("The note has no frontmatter.");

  const governance = isRecord(raw["governance"]) ? raw["governance"] : {};
  if (raw["governance"] !== undefined && !isRecord(raw["governance"])) {
    problems.push("`governance` is not a mapping; governance gates will not find their fields.");
  }

  const history = parseHistory(raw["history"], problems);
  const stage = str(raw["stage"]);
  if (stage === "") problems.push("The note has no `stage`.");

  const uid = str(raw["uid"]);
  if (uid === "") {
    problems.push("The note has no `uid`. Machine references and the audit trail need one.");
  }

  const workflowVersion = num(raw["workflow_version"]);
  if (raw["workflow_version"] !== undefined && workflowVersion === null) {
    problems.push("`workflow_version` is not a number.");
  }

  const blockedOn = str(raw["blocked_on"]);

  const request: RequestNote = {
    uid,
    id: str(raw["id"]),
    title: str(raw["title"]),
    externalRef: str(raw["external_ref"]),
    lastReconciled: parseTimestamp(raw["last_reconciled"]),

    workflow: str(raw["workflow"]),
    workflowVersion,

    stage,
    blockedOn: blockedOn === "" ? null : blockedOn,
    blockedSince: parseTimestamp(raw["blocked_since"]),

    requester: str(raw["requester"]),
    study: str(raw["study"]),
    hat: str(raw["hat"]),
    assignee: str(raw["assignee"]),
    priority: str(raw["priority"]),

    received: parseTimestamp(raw["received"]),
    due: parseTimestamp(raw["due"]),
    slaDays: num(raw["sla_days"]),
    effortEstimateHours: num(raw["effort_estimate_hours"]),

    evidence: parseEvidence(raw["evidence"], problems),
    history,

    raw: { ...raw, governance },
  };

  // A request whose stage disagrees with its own history is not fatal, but it
  // means the note was hand-edited past the plugin and dwell time is suspect.
  const last = history[history.length - 1];
  if (last && stage !== "" && last.to !== stage) {
    problems.push(
      `\`stage: ${stage}\` does not match the last history entry (\`${last.to}\`). ` +
        "Dwell time is measured from the last history entry.",
    );
  }

  return { request, problems };
}

/** Evidence records for a claim, matched case-insensitively on `for`. */
export function evidenceFor(request: RequestNote, claim: string): EvidenceRecord[] {
  const wanted = claim.trim().toLowerCase();
  return request.evidence.filter((e) => e.claim.toLowerCase() === wanted);
}

/** True when a claim has at least one non-verbal evidence record (§5.5). */
export function hasHardEvidence(request: RequestNote, claim: string): boolean {
  return evidenceFor(request, claim).some((e) => e.hard);
}
