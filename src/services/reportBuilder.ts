/**
 * Gathering what a report needs, and building it (CLAUDE.md §7 B7).
 *
 * The seam between the plugin and the engine. `domain/report/compose.ts` is
 * pure and knows nothing about Obsidian; this class knows where everything
 * lives and hands it over as plain data.
 *
 * It reads and builds. It does not write — writing goes through `Exporter`,
 * which already carries A3's three guards: everything lands in `95 Exports/`,
 * the user confirms a line naming the file and the row count, and the write
 * appends an `export` entry to the audit ledger. A second write path would be
 * a second set of guards to keep in step, and the one that drifted would be
 * the one nobody logged.
 */

import { composeReport, reportRowCount, windowFor, type ReportData } from "../domain/report/compose";
import type { ReportDocument } from "../domain/report/document";
import { renderMarkdown } from "../domain/report/markdown";
import { renderDocument } from "../domain/report/document";
import type { ReportTemplate } from "../domain/report/template";
import { parseProfileNote, PROFILE_TYPES, type ProfileNote } from "../domain/profile/profile";
import type { CitationFormat } from "../domain/publication/citation";
import type { PublicationNote } from "../domain/publication/publication";
import type { RequestView } from "../domain/request/holdup";
import type { WorkflowSpec } from "../domain/request/workflow";
import type { FieldDef, Row } from "../domain/query/model";
import { toVaultMinute } from "../domain/time/dates";
import { parseParty, sameParty } from "../domain/comms/party";
import type { NoteIndex } from "../data/noteIndex";
import type { EffortLog } from "./effortLog";

/** What the user chose in the dialog. */
export interface ReportChoice {
  templateId: string;
  /** `2026-07`, `2026`, or "" when the template takes no period. */
  period: string;
  /** A study as written in a note (`[[EuroHeart]]` or plain text), or "". */
  study: string;
  format: "md" | "html";
}

export interface ReportBuilderContext {
  notes: NoteIndex;
  effort: EffortLog;
  /** Requests, filtered by the hat when the hat filter is on. */
  views: (now: number) => readonly RequestView[];
  /** Every request, whatever hat it is under. */
  allViews: (now: number) => readonly RequestView[];
  spec: () => WorkflowSpec | null;
  publications: () => PublicationNote[];
  rows: (types: readonly string[], now: number) => Row[];
  fields: (types: readonly string[]) => FieldDef[];
  citationFormat: () => CitationFormat;
  /** "Head of SCDB work only", or "" when nothing is filtered out. */
  scope: () => string;
}

export interface BuiltReport {
  document: ReportDocument;
  data: ReportData;
  rows: number;
  content: string;
  extension: "md" | "html";
}

/**
 * Rows handed to a `query` block: every type, because the query says what it
 * wants. `buildRows` treats an empty list as "everything" (see `data/rows.ts`).
 */
const EVERY_TYPE: readonly string[] = [];

export class ReportBuilder {
  constructor(private readonly ctx: ReportBuilderContext) {}

  /** Every profile note in the vault (§5.9). */
  profile(): ProfileNote[] {
    const notes: ProfileNote[] = [];
    const types = new Set<string>(PROFILE_TYPES);
    for (const entry of this.ctx.notes.all()) {
      if (!types.has(entry.type)) continue;
      const parsed = parseProfileNote(entry.file.path, entry.frontmatter);
      if (parsed !== null) notes.push(parsed);
    }
    return notes;
  }

  /**
   * Every study the vault mentions, for the study picker.
   *
   * Drawn from the effort log, the request queue and the publications rather
   * than from `20 Studies/`: a chargeback statement is only useful for a study
   * something is actually recorded against, and offering a study with no
   * effort and no requests produces an empty report and a puzzled user.
   */
  async studies(now = Date.now()): Promise<string[]> {
    const seen = new Map<string, string>();
    // Keyed and labelled through `parseParty`, so `[[Example Registry]]` on a
    // request and bare `Example Registry` in the effort log are one entry
    // rather than two. Offering both would let the user pick the spelling that
    // silently excludes half the data — the exact failure the row count in the
    // dialog exists to catch.
    const add = (value: string) => {
      const party = parseParty(value);
      if (party.key === "" || seen.has(party.key)) return;
      seen.set(party.key, party.name);
    };

    for (const entry of await this.ctx.effort.allEntries()) add(entry.study);
    for (const view of this.ctx.allViews(now)) add(view.request.study);
    for (const publication of this.ctx.publications()) {
      for (const study of publication.studies) add(study.raw);
    }

    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  /** Assemble everything the engine needs. Reads the vault; writes nothing. */
  async gather(
    template: ReportTemplate,
    choice: ReportChoice,
    now = Date.now(),
  ): Promise<ReportData> {
    const study = template.study ? choice.study.trim() : "";
    const all = this.ctx.allViews(now);
    const visible = this.ctx.views(now);

    // The study narrows what the report is *about*; the hat filter narrows
    // what this person is looking at. Both apply, and they are different
    // questions — a study statement under the wrong hat would silently omit
    // half the requests it is meant to account for, so a study report ignores
    // the hat and says so through `scope`.
    const scoped = study === "" ? visible : all.filter((view) => sameParty(view.request.study, study));

    return {
      views: scoped,
      allViews: all,
      spec: this.ctx.spec(),
      entries: await this.ctx.effort.allEntries(),
      publications: this.ctx
        .publications()
        .filter(
          (publication) =>
            study === "" ||
            publication.studies.some((party) => sameParty(party.raw, study)),
        ),
      profile: this.profile(),
      rows: this.ctx.rows(EVERY_TYPE, now),
      fields: this.ctx.fields(EVERY_TYPE),
      citationFormat: this.ctx.citationFormat(),
      window: windowFor(template.period, choice.period, now),
      study,
      now,
      generatedAt: toVaultMinute(now).replace("T", " "),
      scope: study === "" ? this.ctx.scope() : `${parseParty(study).name} only, every hat`,
      charts: choice.format === "md" ? "svg" : "html",
    };
  }

  async build(
    template: ReportTemplate,
    choice: ReportChoice,
    now = Date.now(),
  ): Promise<BuiltReport> {
    const data = await this.gather(template, choice, now);
    const document = composeReport(template, data);
    const rows = reportRowCount(template, data);

    return {
      document,
      data,
      rows,
      extension: choice.format,
      content:
        choice.format === "md"
          ? renderMarkdown(document, {
              templateId: template.id,
              period: data.window.value,
              study: data.study,
              rows,
            })
          : renderDocument(document),
    };
  }
}

