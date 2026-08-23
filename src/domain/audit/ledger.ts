/**
 * The audit ledger (CLAUDE.md §5.6) — append-only, hash-chained monthly tables.
 *
 * The ledger is a markdown file the user can edit. Chaining does not prevent
 * that; it makes it **detectable**, which is the achievable goal. Each row's
 * `chain` is a hash over the previous chain value and this row's rendered
 * cells, so a reader with this file and this algorithm can recompute the whole
 * sequence — nothing hidden, nothing stored elsewhere.
 *
 * Be honest about the limit: someone with the plugin source can recompute the
 * whole chain after an edit. This detects casual and third-party tampering, not
 * a determined forger. Anchoring against that would need external timestamping,
 * which an offline-first plugin cannot offer.
 *
 * Pure module: no Obsidian, no Node.
 */

import { sha256 } from "./sha256";
import {
  escapeCell,
  isTableRow,
  splitCells,
  tableHeader,
  unescapeCell,
} from "../table/cells";

// The ledger and the effort log (§5.3) are both markdown tables a human may
// have typed into, so the cell escaping is shared rather than reimplemented.
// Re-exported because the ledger's file format is what these belong to.
export { escapeCell, unescapeCell };

export const AUDIT_ACTIONS = [
  "stage-change",
  "gate-override",
  "identifier-scope",
  "evidence-added",
  "evidence-removed",
  "delete",
  "export",
  "bulk-edit",
  "schema-migration",
  "settings-change",
  "message-composed",
  "code-run",
  "correction",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** One logged action, before it is chained. */
export interface AuditEntry {
  /** Local `YYYY-MM-DDTHH:mm`, from `toVaultMinute`. */
  ts: string;
  actor: string;
  action: AuditAction;
  /** What was acted on: a request id, a view name, a settings key. */
  subject: string;
  /** IDs and counts only — never note content (rule 7, no PHI in logs). */
  detail: string;
}

/** A ledger entry with its computed chain value, as written to the file. */
export interface AuditRow extends AuditEntry {
  chain: string;
}

/**
 * Chain values are truncated to 16 hex characters (64 bits). Full 64-character
 * digests would make a markdown table unreadable, and the length is not what
 * stops a forger (see the header) — legibility for a human auditor is worth
 * more here than bits nobody can use.
 */
export const CHAIN_DIGITS = 16;

/**
 * Seeds the very first row of the very first ledger file. Versioned on purpose:
 * changing the chaining scheme must not silently validate against old files.
 */
export const CHAIN_GENESIS = "scdb-audit-chain-v1";

const COLUMNS = ["ts", "actor", "action", "subject", "detail", "chain"] as const;

export const LEDGER_HEADER = tableHeader(COLUMNS);

/** The exact text the chain is computed over — the cells as they appear in the file. */
function canonicalise(entry: AuditEntry): string {
  return [entry.ts, entry.actor, entry.action, entry.subject, entry.detail]
    .map(escapeCell)
    .join("|");
}

/** The chain value a row must carry, given the chain value of the row before it. */
export function chainValue(previousChain: string, entry: AuditEntry): string {
  return sha256(`${previousChain}\n${canonicalise(entry)}`).slice(0, CHAIN_DIGITS);
}

/** Chain an entry onto a sequence. `previousChain` is CHAIN_GENESIS for the very first. */
export function chainEntry(previousChain: string, entry: AuditEntry): AuditRow {
  return { ...entry, chain: chainValue(previousChain, entry) };
}

/** The chain value the next file must be seeded from (§5.6, carried across months). */
export function tailChain(rows: readonly AuditRow[], fallback = CHAIN_GENESIS): string {
  return rows.length === 0 ? fallback : rows[rows.length - 1]!.chain;
}

/**
 * Render one row. Cells are not padded to a common width: the ledger is
 * append-only, and aligning columns would mean rewriting rows already written.
 */
export function renderRow(row: AuditRow): string {
  const cells = [row.ts, row.actor, row.action, row.subject, row.detail].map(escapeCell);
  return `| ${[...cells, row.chain].map((cell) => cell || " ").join(" | ")} |`;
}

/** A complete ledger file body, for creating a month that does not exist yet. */
export function renderLedger(rows: readonly AuditRow[]): string {
  return [LEDGER_HEADER, ...rows.map(renderRow)].join("\n") + "\n";
}

export interface ParsedLedger {
  rows: AuditRow[];
  /** 1-based line numbers of table rows that could not be read as entries. */
  malformed: number[];
}

/**
 * Read a ledger file. Prose above or below the table is ignored, so a human can
 * annotate a month without breaking verification.
 */
export function parseLedger(text: string): ParsedLedger {
  const rows: AuditRow[] = [];
  const malformed: number[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!isTableRow(line)) return;

    const cells = splitCells(line).map(unescapeCell);
    if (cells.length !== COLUMNS.length) {
      malformed.push(index + 1);
      return;
    }
    const [ts, actor, action, subject, detail, chain] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (ts === "ts" && actor === "actor") return; // the header row
    if (!isAuditAction(action)) {
      malformed.push(index + 1);
      return;
    }
    rows.push({ ts, actor, action, subject, detail, chain });
  });

  return { rows, malformed };
}

export interface ChainBreak {
  /** Index into the rows array. */
  index: number;
  row: AuditRow;
  expected: string;
  found: string;
}

export interface VerifyResult {
  ok: boolean;
  /** How many rows reconciled before the walk stopped. */
  checked: number;
  /** The first row that does not reconcile. Everything after it is unverifiable. */
  break?: ChainBreak;
}

/**
 * Walk the chain and report the first row that does not reconcile (§5.6).
 * Verification stops there: once one link is wrong, later rows were chained
 * onto a value we cannot vouch for, so reporting them all as broken would be
 * noise around a single real finding.
 */
export function verifyChain(
  rows: readonly AuditRow[],
  seedChain: string = CHAIN_GENESIS,
): VerifyResult {
  let previous = seedChain;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expected = chainValue(previous, row);
    if (expected !== row.chain) {
      return { ok: false, checked: i, break: { index: i, row, expected, found: row.chain } };
    }
    previous = row.chain;
  }
  return { ok: true, checked: rows.length };
}

/**
 * A gate override entry. The typed reason is enforced here as well as in the
 * UI: "a gate override always requires a typed reason" (§5.6) is the single
 * rule that carries most of the audit value, so it is checked where the record
 * is built, not only where it is asked for.
 */
export function gateOverrideEntry(input: {
  ts: string;
  actor: string;
  subject: string;
  gate: string;
  reason: string;
}): AuditEntry {
  const reason = input.reason.trim();
  if (reason === "") {
    throw new Error("A gate override requires a typed reason.");
  }
  return {
    ts: input.ts,
    actor: input.actor,
    action: "gate-override",
    subject: input.subject,
    detail: `${input.gate}; reason: ${reason}`,
  };
}

/**
 * A correction. Mistaken rows are never edited — editing breaks the chain,
 * which is the intended behaviour — so a correction is appended and points at
 * the chain value of the row it corrects.
 */
export function correctionEntry(input: {
  ts: string;
  actor: string;
  subject: string;
  correctsChain: string;
  reason: string;
}): AuditEntry {
  const reason = input.reason.trim();
  if (reason === "") {
    throw new Error("A correction requires a typed reason.");
  }
  return {
    ts: input.ts,
    actor: input.actor,
    action: "correction",
    subject: input.subject,
    detail: `corrects ${input.correctsChain}; ${reason}`,
  };
}
