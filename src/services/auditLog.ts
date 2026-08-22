/**
 * Writing and verifying the audit ledger (CLAUDE.md §5.6).
 *
 * One file per month in `82 Audit/`, append-only, never edited by the plugin
 * after writing. The hash chain is seeded from the last row of the previous
 * month, so verification walks every month the vault holds as one sequence.
 *
 * Appends are serialised through a queue. Obsidian runs one thread, but two
 * awaited appends can still interleave between the read and the write, and an
 * interleaved append would chain onto a value that is about to change.
 */

import type { App } from "obsidian";
import {
  type AuditEntry,
  type AuditRow,
  CHAIN_GENESIS,
  LEDGER_HEADER,
  parseLedger,
  renderRow,
  tailChain,
  verifyChain,
  chainEntry,
} from "../domain/audit/ledger";
import { appendToFile, readIfExists } from "../data/vaultPaths";

const MONTH_FILE_RE = /^(\d{4}-\d{2})\.md$/;

export interface LedgerMonth {
  month: string;
  path: string;
  rows: AuditRow[];
  malformed: number[];
}

export interface LedgerVerification {
  ok: boolean;
  monthsChecked: number;
  rowsChecked: number;
  /** Rows that are not readable as ledger entries at all, per file. */
  malformed: { path: string; lines: number[] }[];
  /** The first row in the whole sequence that does not reconcile. */
  firstBreak?: { path: string; index: number; row: AuditRow; expected: string; found: string };
}

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly app: App,
    /** Reads the audit folder from settings each time, so a settings change takes effect. */
    private readonly folder: () => string,
  ) {}

  private path(month: string): string {
    return `${this.folder()}/${month}.md`;
  }

  /** Every month file present, oldest first. */
  private months(): string[] {
    const prefix = `${this.folder()}/`;
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => MONTH_FILE_RE.exec(f.name)?.[1])
      .filter((m): m is string => m !== undefined)
      .sort();
  }

  private async read(month: string): Promise<LedgerMonth> {
    const path = this.path(month);
    const text = await readIfExists(this.app, path);
    const parsed = text === null ? { rows: [], malformed: [] } : parseLedger(text);
    return { month, path, ...parsed };
  }

  /**
   * The chain value a new row in `month` must follow: the last row of that
   * month if it has any, otherwise the last row of the most recent earlier
   * month, otherwise genesis.
   */
  private async seedFor(month: string): Promise<string> {
    const current = await this.read(month);
    if (current.rows.length > 0) return tailChain(current.rows);

    const earlier = this.months()
      .filter((m) => m < month)
      .reverse();
    for (const previous of earlier) {
      const rows = (await this.read(previous)).rows;
      if (rows.length > 0) return tailChain(rows);
    }
    return CHAIN_GENESIS;
  }

  /**
   * Append entries. Grouped by the month in each entry's timestamp, so a batch
   * that straddles midnight on the last of the month still lands correctly.
   */
  append(entries: readonly AuditEntry[]): Promise<void> {
    const run = async (): Promise<void> => {
      if (entries.length === 0) return;

      const byMonth = new Map<string, AuditEntry[]>();
      for (const entry of entries) {
        const month = entry.ts.slice(0, 7);
        byMonth.set(month, [...(byMonth.get(month) ?? []), entry]);
      }

      for (const month of [...byMonth.keys()].sort()) {
        let previous = await this.seedFor(month);
        const lines: string[] = [];
        for (const entry of byMonth.get(month)!) {
          const row = chainEntry(previous, entry);
          lines.push(renderRow(row));
          previous = row.chain;
        }
        await appendToFile(
          this.app,
          this.path(month),
          `${lines.join("\n")}\n`,
          `${LEDGER_HEADER}\n`,
        );
      }
    };

    this.queue = this.queue.then(run, run);
    return this.queue as Promise<void>;
  }

  /** Walk every month as one chain and report the first row that does not reconcile. */
  async verify(): Promise<LedgerVerification> {
    const months = this.months();
    const malformed: { path: string; lines: number[] }[] = [];
    let seed = CHAIN_GENESIS;
    let rowsChecked = 0;

    for (const month of months) {
      const file = await this.read(month);
      if (file.malformed.length > 0) malformed.push({ path: file.path, lines: file.malformed });

      const result = verifyChain(file.rows, seed);
      if (!result.ok && result.break) {
        return {
          ok: false,
          monthsChecked: months.indexOf(month) + 1,
          rowsChecked: rowsChecked + result.checked,
          malformed,
          firstBreak: { path: file.path, ...result.break },
        };
      }
      rowsChecked += file.rows.length;
      seed = tailChain(file.rows, seed);
    }

    return { ok: true, monthsChecked: months.length, rowsChecked, malformed };
  }

  /** A one-paragraph result for a notice or the diagnostics report. */
  static describe(result: LedgerVerification): string {
    if (result.ok) {
      const clean = `Audit ledger verified: ${result.rowsChecked} entries across ${result.monthsChecked} month${result.monthsChecked === 1 ? "" : "s"} reconcile.`;
      if (result.malformed.length === 0) return clean;
      const lines = result.malformed
        .map((m) => `${m.path} lines ${m.lines.join(", ")}`)
        .join("; ");
      return `${clean} Some rows could not be read and were skipped: ${lines}.`;
    }
    const b = result.firstBreak!;
    return (
      `Audit ledger does NOT reconcile. The first row that fails is entry ${b.index + 1} of ${b.path} ` +
      `(${b.row.ts} ${b.row.action} ${b.row.subject}). Expected chain ${b.expected}, found ${b.found}. ` +
      "Rows after it cannot be checked. Entries are never edited in place — a mistake is corrected by appending a correction entry."
    );
  }
}
