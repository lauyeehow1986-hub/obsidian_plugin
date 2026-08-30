/**
 * Events, recurring obligations and the calendar bridge (CLAUDE.md §5.7, §7 B3).
 *
 * The vault side of the recurrence engine. Everything decided here is decided
 * in `domain/events`; this file reads notes out of the index, writes frontmatter
 * back through Obsidian's APIs, and nothing else.
 *
 * Three rules shape it:
 *
 *  - **Nothing is materialised on load.** The board computes the next
 *    occurrence in memory, so no obligation is ever unwatched; writing that
 *    date into a note is a separate, confirmed act (rule 12).
 *  - **Frontmatter merges.** `processFrontMatter` with `Object.assign`, so a
 *    key this plugin has never heard of survives (rule 8).
 *  - **Nothing reaches a network.** A calendar file is written into the vault
 *    and read back from it. There is no mailbox access anywhere in here.
 */

import { normalizePath, TFile, type App } from "obsidian";
import type { AuditLog } from "./auditLog";
import type { Exporter } from "./exporter";
import type { NoteIndex } from "../data/noteIndex";
import { ensureFolder } from "../data/vaultPaths";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import {
  eventFromCalendar,
  newObligation,
  nextEventId,
  DEFAULT_OBLIGATION_PREFIX,
  type ObligationInput,
} from "../domain/events/create";
import { EVENT_TYPE, OBLIGATION_TYPE, parseEventNote, type EventNote } from "../domain/events/event";
import { calendarEvents } from "../domain/events/feed";
import { buildCalendar, parseCalendar } from "../domain/events/ics";
import {
  buildSchedule,
  completion,
  materialisePlan,
  type MaterialisePlan,
  type Occurrence,
} from "../domain/events/schedule";

export interface EventStoreDeps {
  app: App;
  notes: NoteIndex;
  audit: AuditLog;
  exporter: Exporter;
  eventsFolder: () => string;
  exportsFolder: () => string;
  calendarFile: () => string;
  leadDays: () => readonly number[];
  horizonDays: () => number;
  actor: () => string;
  /**
   * Dated project milestones, as virtual event notes (§5.15).
   *
   * Injected rather than imported so this store keeps knowing nothing about
   * projects, and so the *read* path can include them while `all()` — which
   * every write path goes through — cannot. A milestone has no file behind it;
   * mixing it into `all()` would put a note the plugin can write to one refactor
   * away from a computed date landing in a project's frontmatter.
   */
  milestones?: () => EventNote[];
  /**
   * Marks a derived occurrence complete in whatever note owns it.
   *
   * Injected for the same reason `milestones` is: this store knows nothing
   * about projects. Without it, `complete()` refuses a derived occurrence
   * rather than guessing — which is the correct failure, because guessing
   * means writing `last_completed` into the host note and never touching the
   * milestone at all.
   */
  completeDerived?: (note: EventNote, on: string) => Promise<void>;
}

export interface ImportOutcome {
  created: string[];
  /** Entries already in the vault under the same calendar UID. */
  duplicates: number;
  problems: string[];
}

export class EventStore {
  constructor(private readonly deps: EventStoreDeps) {}

  /** Every event and obligation note the index holds, parsed. */
  all(): EventNote[] {
    return [...this.deps.notes.byType(EVENT_TYPE), ...this.deps.notes.byType(OBLIGATION_TYPE)].map(
      (entry) => parseEventNote(entry.file.path, entry.frontmatter),
    );
  }

  /**
   * Everything dated, real notes and project milestones together.
   *
   * One schedule, deliberately: §5.15 refuses a second reminder system on the
   * grounds that two would mean two places to look for what is late. The
   * deadline board, the daily briefing and the ICS feed all read this.
   */
  schedule(now = Date.now()): Occurrence[] {
    const milestones = this.deps.milestones?.() ?? [];
    return buildSchedule([...this.all(), ...milestones], {
      today: toVaultDate(now),
      horizonDays: this.deps.horizonDays(),
      defaultLeadDays: this.deps.leadDays(),
    });
  }

  /** Notes whose written date disagrees with their rule, or that carry none. */
  plans(): MaterialisePlan[] {
    return materialisePlan(this.all());
  }

  private fileFor(note: EventNote): TFile | null {
    const entry = this.deps.notes.byPath(note.path);
    return entry?.file ?? null;
  }

  /** Merge keys into a note's frontmatter and tell the index it moved. */
  private async patch(file: TFile, set: Record<string, unknown>): Promise<void> {
    await this.deps.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, set);
    });
    this.deps.notes.update(file);
  }

  /**
   * Write the computed next occurrence into each note's `due`.
   *
   * Logged as `bulk-edit` (§5.6) because that is literally what it is: one
   * action changing a governance-relevant field across several notes. A single
   * completion is not logged — it is an ordinary field edit the user could make
   * by hand, and a ledger that records every routine edit is one nobody reads
   * (the argument §5.12 makes about exploratory console lines).
   */
  async materialise(plans: readonly MaterialisePlan[]): Promise<number> {
    if (plans.length === 0) return 0;
    const actor = this.actorOrThrow();

    let written = 0;
    for (const plan of plans) {
      const file = this.fileFor(plan.note);
      if (file === null) continue;
      await this.patch(file, { due: plan.to });
      written += 1;
    }

    if (written > 0) {
      await this.deps.audit.append([
        {
          ts: toVaultMinute(Date.now()),
          actor,
          action: "bulk-edit",
          subject: "obligations",
          // Counts and ids only — never a title or a body (rule 7).
          detail: `materialised next occurrence on ${written} note${written === 1 ? "" : "s"}`,
        },
      ]);
    }

    return written;
  }

  /**
   * Record an obligation as done and move it on.
   *
   * A one-off keeps its date and simply gains `last_completed`; inventing a new
   * date for something that happens once would leave a ghost on the board.
   */
  async complete(note: EventNote, on: string): Promise<{ next: string }> {
    // A derived occurrence's `path` points at the note it lives *inside*, so
    // resolving a file from it and writing would stamp `last_completed` onto
    // that host note and leave the item itself untouched (§5.15).
    if (note.derivedFrom !== undefined) {
      const handler = this.deps.completeDerived;
      if (handler === undefined) {
        throw new Error(
          `${note.id} is part of another note, and nothing here knows how to complete it.`,
        );
      }
      await handler(note, on);
      return { next: "" };
    }

    const file = this.fileFor(note);
    if (file === null) {
      throw new Error(`${note.id} is no longer in the vault, so it could not be completed.`);
    }

    const result = completion(note, on);
    const set: Record<string, unknown> = { last_completed: result.lastCompleted };
    if (result.next !== "") set["due"] = result.next;

    await this.patch(file, set);
    return { next: result.next };
  }

  /* ---------------------------------------------------------- calendar -- */

  /** The `.ics` text for everything currently scheduled. */
  calendarText(now = Date.now()): { text: string; count: number } {
    const events = calendarEvents(this.schedule(now));
    return {
      text: buildCalendar(events, { now, name: "SCDB deadlines" }),
      count: events.length,
    };
  }

  /** Where the calendar file goes. Inside the vault, like every export (rule 8). */
  calendarPath(): string {
    const name = this.deps.calendarFile().trim();
    const file = name.toLowerCase().endsWith(".ics") ? name : `${name}.ics`;
    return normalizePath(`${this.deps.exportsFolder()}/${file}`);
  }

  /**
   * Write the calendar file, overwriting the previous one.
   *
   * Overwriting is deliberate and is the one place this plugin does it. A
   * calendar subscription needs a stable path; a dated file per run would leave
   * Outlook pointing at a snapshot that never changes, which is worse than no
   * calendar at all. Rule 8 forbids destroying data you did not write — this
   * file is one the plugin wrote, it is regenerated from the vault, and the
   * confirmation names it before anything happens.
   */
  async exportCalendar(now = Date.now()): Promise<{ path: string; count: number }> {
    const { text, count } = this.calendarText(now);
    const path = this.calendarPath();

    const written = await this.deps.exporter.write({
      basename: path,
      extension: "ics",
      content: text,
      subject: "calendar",
      rows: count,
      path,
    });

    return { path: written.path, count };
  }

  /**
   * Turn the VEVENTs in an `.ics` into event notes.
   *
   * Deduped on the calendar's own `UID`, so re-importing a fortnight of
   * meetings adds only what is new. Nothing already in the vault is modified —
   * an import that quietly rewrote a note somebody had annotated would be the
   * worst kind of surprise (rule 8).
   */
  async importCalendar(text: string, now = Date.now()): Promise<ImportOutcome> {
    const parsed = parseCalendar(text);
    const outcome: ImportOutcome = { created: [], duplicates: 0, problems: [...parsed.problems] };
    if (parsed.events.length === 0) return outcome;

    // Checked before anything is written, not after. Asking for the actor once
    // the notes already exist would leave the vault holding an import the
    // ledger has no record of — the failure rule 9 exists to prevent, and the
    // reason the exporter refuses up front too.
    const actor = this.actorOrThrow();

    const existing = this.all();
    const seen = new Set(existing.map((note) => note.icsUid).filter((uid) => uid !== ""));
    // Entries this vault emitted, so a round trip through Outlook does not
    // import our own obligations back as a second set of event notes. The uid
    // is the one we wrote in `feed.ts`; matching on it is the cheapest honest
    // answer to "did this come from here?".
    for (const note of existing) seen.add(`${note.uid === "" ? note.id : note.uid}@scdb-cockpit`);
    const ids = existing.map((note) => note.id);
    const folder = this.deps.eventsFolder();
    await ensureFolder(this.deps.app, folder);

    for (const event of parsed.events) {
      if (event.uid !== "" && seen.has(event.uid)) {
        outcome.duplicates += 1;
        continue;
      }

      const built = eventFromCalendar(event, { now, existingIds: ids });
      if (built === null) {
        outcome.problems.push(`Skipped "${event.summary}" — ${event.date} is not a real date.`);
        continue;
      }

      const path = this.freePath(folder, built.note.filename);
      const file = await this.deps.app.vault.create(path, built.note.body);
      await this.patch(file, built.note.frontmatter);

      ids.push(String(built.note.frontmatter["id"]));
      if (built.icsUid !== "") seen.add(built.icsUid);
      outcome.created.push(path);
    }

    if (outcome.created.length > 0) {
      await this.deps.audit.append([
        {
          ts: toVaultMinute(now),
          actor,
          action: "bulk-edit",
          subject: "calendar-import",
          detail: `${outcome.created.length} event note${outcome.created.length === 1 ? "" : "s"} created from a calendar file, ${outcome.duplicates} already present`,
        },
      ]);
    }

    return outcome;
  }

  /* ----------------------------------------------------------- writing -- */

  /** Create an obligation or a one-off event from the dialog. */
  async createObligation(input: Omit<ObligationInput, "id">): Promise<TFile> {
    const folder = this.deps.eventsFolder();
    const year = Number(toVaultDate(input.now).slice(0, 4));
    const id = nextEventId(
      this.all().map((note) => note.id),
      year,
      DEFAULT_OBLIGATION_PREFIX,
    );

    const built = newObligation({ ...input, id });
    await ensureFolder(this.deps.app, folder);

    const path = this.freePath(folder, built.filename);
    const file = await this.deps.app.vault.create(path, built.body);
    await this.patch(file, built.frontmatter);
    return file;
  }

  /** First free `name.md`, then `name 2.md`. Never overwrites a note (rule 8). */
  private freePath(folder: string, filename: string): string {
    const stem = filename.replace(/\.md$/, "");
    for (let counter = 1; counter < 100; counter++) {
      const candidate = normalizePath(
        `${folder}/${stem}${counter === 1 ? "" : ` ${counter}`}.md`,
      );
      if (this.deps.app.vault.getAbstractFileByPath(candidate) === null) return candidate;
    }
    throw new Error(`There are already 99 notes named "${stem}" in ${folder}.`);
  }

  private actorOrThrow(): string {
    const actor = this.deps.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials in SCDB Cockpit settings first — this action is recorded in the audit ledger against an actor.",
      );
    }
    return actor;
  }
}
