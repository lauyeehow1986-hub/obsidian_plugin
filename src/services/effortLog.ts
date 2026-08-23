/**
 * The effort log on disk (CLAUDE.md §5.3, §7 B2).
 *
 * One file per month in `80 Time/`. The timer appends; the effort table may
 * rewrite, and a rewrite that touches rows already written is logged to the
 * audit ledger (see `domain/effort/edit` for why that line falls where it does).
 *
 * Writes are serialised through a queue for the same reason the ledger's are:
 * Obsidian runs one thread, but two awaited appends can interleave between the
 * read and the write, and the second would land on a file the first has not
 * finished with.
 */

import { TFile, normalizePath, parseYaml, type App } from "obsidian";
import type { AuditEntry } from "../domain/audit/ledger";
import {
  applyEffortEdits,
  describeEdits,
  touchesExisting,
  type EditOutcome,
  type EffortEdit,
} from "../domain/effort/edit";
import {
  EFFORT_HEADER,
  entryMonth,
  parseEffortLog,
  renderEntry,
  type EffortProblem,
  type TimeEntry,
} from "../domain/effort/entry";
import {
  defaultVocabularies,
  parseVocabularies,
  type Vocabularies,
} from "../domain/effort/vocabulary";
import { toVaultMinute, toVaultMonth } from "../domain/time/dates";
import { appendToFile, readIfExists } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";

const MONTH_FILE_RE = /^(\d{4}-\d{2})\.md$/;

export interface EffortMonth {
  month: string;
  path: string;
  entries: TimeEntry[];
  problems: EffortProblem[];
  /** Line index and raw text per entry, so the table can edit in place. */
  rows: { entry: TimeEntry; line: number; text: string }[];
}

export interface EffortLogDeps {
  app: App;
  audit: AuditLog;
  /** Read from settings each time, so a folder change takes effect at once. */
  timeFolder: () => string;
  configFolder: () => string;
  actor: () => string;
}

export class EffortLog {
  private queue: Promise<unknown> = Promise.resolve();
  private vocab: Vocabularies = defaultVocabularies();
  private vocabProblems: string[] = [];

  constructor(private readonly deps: EffortLogDeps) {}

  /* ------------------------------------------------------------ paths -- */

  path(month: string): string {
    return `${this.deps.timeFolder()}/${month}.md`;
  }

  /** Every month file present, oldest first. */
  months(): string[] {
    const prefix = `${normalizePath(this.deps.timeFolder())}/`;
    return this.deps.app.vault
      .getFiles()
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => MONTH_FILE_RE.exec(file.name)?.[1])
      .filter((month): month is string => month !== undefined)
      .sort();
  }

  isEffortPath(path: string): boolean {
    const prefix = `${normalizePath(this.deps.timeFolder())}/`;
    return path.startsWith(prefix) && MONTH_FILE_RE.test(path.slice(prefix.length));
  }

  /* ----------------------------------------------------------- reading -- */

  async read(month: string): Promise<EffortMonth> {
    const path = this.path(month);
    const text = await readIfExists(this.deps.app, path);
    const parsed = text === null ? { rows: [], problems: [] } : parseEffortLog(text);
    return {
      month,
      path,
      entries: parsed.rows.map((row) => row.entry),
      problems: parsed.problems,
      rows: parsed.rows,
    };
  }

  /**
   * Entries across every month, or the months given.
   *
   * Reads whole files rather than an index. The effort log is a handful of
   * small tables — a busy year is a few thousand rows — and keeping it out of
   * the note index means a time entry is never mistaken for a note, never
   * queried as one, and never shows up in a board that lists notes.
   */
  async allEntries(months?: readonly string[]): Promise<TimeEntry[]> {
    const wanted = months ?? this.months();
    const out: TimeEntry[] = [];
    for (const month of wanted) out.push(...(await this.read(month)).entries);
    return out;
  }

  /** Every problem the month files report, for diagnostics. */
  async problems(): Promise<{ path: string; problems: EffortProblem[] }[]> {
    const out: { path: string; problems: EffortProblem[] }[] = [];
    for (const month of this.months()) {
      const file = await this.read(month);
      if (file.problems.length > 0) out.push({ path: file.path, problems: file.problems });
    }
    return out;
  }

  /* ----------------------------------------------------------- writing -- */

  /**
   * Append entries, grouped by the month each belongs to.
   *
   * A session that starts at 23:40 on the last of the month is attributed to
   * the day it started (see `timerEntry`), so a batch can still straddle two
   * files — group rather than assume.
   */
  append(entries: readonly TimeEntry[]): Promise<void> {
    const run = async (): Promise<void> => {
      if (entries.length === 0) return;
      const byMonth = new Map<string, TimeEntry[]>();
      for (const entry of entries) {
        const month = entryMonth(entry);
        byMonth.set(month, [...(byMonth.get(month) ?? []), entry]);
      }
      for (const month of [...byMonth.keys()].sort()) {
        const lines = byMonth.get(month)!.map(renderEntry).join("\n");
        await appendToFile(this.deps.app, this.path(month), `${lines}\n`, `${EFFORT_HEADER}\n`);
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue as Promise<void>;
  }

  /**
   * Apply retroactive edits to one month.
   *
   * Rejects rather than half-applies: `applyEffortEdits` throws on a line that
   * has moved, before anything is written.
   */
  edit(month: string, edits: readonly EffortEdit[]): Promise<EditOutcome> {
    const run = async (): Promise<EditOutcome> => {
      const path = normalizePath(this.path(month));
      const file = this.deps.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        throw new Error(`There is no effort log at ${path} to change.`);
      }

      let outcome: EditOutcome | null = null;
      await this.deps.app.vault.process(file, (current) => {
        outcome = applyEffortEdits(current, edits);
        return outcome.text;
      });
      const applied = outcome as EditOutcome | null;
      if (applied === null) throw new Error("The effort log could not be written.");

      if (touchesExisting(edits)) {
        // §5.6: no silent consequential action. A new row is the tool doing its
        // job; rewriting hours that may justify a post or a chargeback line is
        // not. Counts only — the ledger carries no content (rule 7).
        const entry: AuditEntry = {
          ts: toVaultMinute(Date.now()),
          actor: this.deps.actor() || "unknown",
          action: "bulk-edit",
          subject: `effort ${month}`,
          detail: describeEdits(applied, month),
        };
        await this.deps.audit.append([entry]);
      }
      return applied;
    };

    this.queue = this.queue.then(run, run);
    return this.queue as Promise<EditOutcome>;
  }

  /* ------------------------------------------------------ vocabularies -- */

  vocabularyPath(): string {
    return `${this.deps.configFolder()}/vocabularies.yaml`;
  }

  isVocabularyPath(path: string): boolean {
    return normalizePath(path) === normalizePath(this.vocabularyPath());
  }

  /**
   * Load `_config/vocabularies.yaml`, falling back to the shipped list.
   *
   * Cached because the timer dialog and the effort table both want it while
   * rendering, and a file this small is not worth an await in a render path.
   * Reloaded when the file changes.
   */
  async loadVocabularies(): Promise<void> {
    const text = await readIfExists(this.deps.app, this.vocabularyPath());
    if (text === null) {
      this.vocab = defaultVocabularies();
      this.vocabProblems = [];
      return;
    }
    try {
      const parsed = parseVocabularies(parseYaml(text) as unknown);
      this.vocab = parsed.vocab;
      this.vocabProblems = parsed.problems;
    } catch (error) {
      this.vocab = defaultVocabularies();
      this.vocabProblems = [
        `${this.vocabularyPath()} is not readable YAML (${
          error instanceof Error ? error.message : String(error)
        }). Using the built-in activity list.`,
      ];
    }
  }

  vocabularies(): Vocabularies {
    return this.vocab;
  }

  vocabularyProblems(): readonly string[] {
    return this.vocabProblems;
  }

  /** The month a moment belongs to, so callers do not reimplement it. */
  static monthOf(ms: number): string {
    return toVaultMonth(ms);
  }
}
