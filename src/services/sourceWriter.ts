/**
 * Writing what a fetch produced into the vault (§7 E1).
 *
 * Two things land: a briefing note per search, and a set of confirmed field
 * changes on a publication note. Both happen **after** the user has seen the
 * result and chosen; nothing fetched is written on arrival.
 *
 * Rule 8 throughout: frontmatter is merged, unknown keys survive, and every
 * write goes through Obsidian's vault APIs.
 */

import { TFile, type App } from "obsidian";
import { toVaultMinute } from "../domain/time/dates";
import { buildSourceBriefing, type BriefingInput } from "../domain/sources/note";
import { collapse } from "../domain/markdown/foreign";
import type { EnrichableField, FieldProposal } from "../domain/sources/pubmed";
import type { AuditLog } from "./auditLog";
import type { NoteIndex } from "../data/noteIndex";
import { ensureFolder } from "../data/vaultPaths";

export interface SourceWriterContext {
  app: App;
  notes: NoteIndex;
  audit: AuditLog;
  actor: () => string;
  /** The folder briefings go in, read fresh so a settings change takes effect. */
  briefingsFolder: () => string;
}

export class SourceWriter {
  constructor(private readonly ctx: SourceWriterContext) {}

  /**
   * Write the briefing note for one search.
   *
   * Never overwrites, for the same reason the daily briefing does not: the note
   * is a record of one search on one day, and running the same search again is
   * a *new* observation rather than a correction of the old one. A second
   * search on the same day gets a numbered suffix.
   */
  async briefing(input: BriefingInput): Promise<TFile> {
    const built = buildSourceBriefing(input);
    const folder = this.ctx.briefingsFolder();
    await ensureFolder(this.ctx.app, folder);

    let path = `${folder}/${built.stem}.md`;
    for (let n = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; n += 1) {
      path = `${folder}/${built.stem} (${n}).md`;
      if (n > 50) throw new Error("Too many briefings with this name already exist.");
    }

    const file = await this.ctx.app.vault.create(path, built.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, built.frontmatter);
    });
    this.ctx.notes.update(file);
    return file;
  }

  /**
   * Apply the field changes the user ticked to a publication note.
   *
   * Only the fields passed in are touched. `history`, `authors`, `position` and
   * everything else the note holds are left exactly as they were — the fetch
   * had nothing to say about them, and rule 8 says a write never destroys what
   * it did not author.
   */
  async enrich(
    file: TFile,
    accepted: readonly FieldProposal[],
    where: { pmid: string; from: string },
  ): Promise<void> {
    if (accepted.length === 0) return;
    const actor = this.actorOrThrow();

    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const proposal of accepted) {
        frontmatter[proposal.field] = value(proposal.field, proposal.proposed);
      }
      // A note that says where a value came from can be checked later; one that
      // does not is a value of unknown provenance sitting in a governance
      // record. Same argument as §5.1's `last_reconciled`.
      frontmatter["enriched_from"] = where.from;
      frontmatter["enriched_at"] = toVaultMinute(Date.now());
    });

    this.ctx.notes.update(file);

    await this.ctx.audit.append([
      {
        ts: toVaultMinute(Date.now()),
        actor,
        action: "bulk-edit",
        subject: file.basename,
        // Field names, not values (rule 7); the values are in the note.
        detail:
          `enriched from ${where.from}${where.pmid === "" ? "" : ` (PMID ${where.pmid})`}: ` +
          accepted.map((proposal) => proposal.field).join(", "),
      },
    ]);
  }

  private actorOrThrow(): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials as the actor in SCDB Cockpit settings first — every logged action needs to name who did it.",
      );
    }
    return actor;
  }
}

/**
 * `year` is a number in §5.4's shape and everything else is a string.
 *
 * Written as a number so a query can sort and compare it; a year stored as
 * `"2018"` sorts as text, which puts 2019 before 900 and is the kind of defect
 * nobody notices until a CV comes out in the wrong order.
 */
function value(field: EnrichableField, proposed: string): string | number {
  if (field !== "year") return collapse(proposed);
  const year = Number.parseInt(proposed, 10);
  return Number.isFinite(year) ? year : collapse(proposed);
}
