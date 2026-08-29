/**
 * The only place REDCap form notes are read and written (§5.14, §7 D2).
 *
 * A form note is two halves with different write rules, and this is where that
 * lives:
 *
 *  - **frontmatter** through `processFrontMatter`, merged key by key, unknown
 *    keys surviving (rule 8);
 *  - **the fenced YAML block** through `vault.process`, replacing only the
 *    block and leaving every word of prose around it exactly as it was.
 *
 * **Export refuses, and the refusal is the feature.** §7 D2 is explicit that
 * validation runs before any export. So `exportDictionary` re-validates at the
 * moment of writing rather than trusting what a board rendered a minute ago,
 * and throws with every reason. A governance block can be overridden — this is
 * a working tool and there are legitimate reasons to export an instrument that
 * is ahead of its approval — but only with a typed reason, and the override
 * appends a `gate-override` entry beside the `export` entry (§5.6). The same
 * rule A1 applies to a stage transition, for the same reason: "a gate override
 * always requires a typed reason" is most of the audit value.
 *
 * A **validation** error cannot be overridden at all, because there is nothing
 * to weigh — REDCap will simply reject the file, and an override that produces
 * a broken artefact is a control that wastes the person's time twice.
 */

import { normalizePath, parseYaml, stringifyYaml, TFile, type App } from "obsidian";

import { correctionEntry } from "../domain/audit/ledger";
import { findBlock, replaceBlock } from "../domain/redcap/block";
import {
  fromDictionaryCsv,
  instrumentsToBlock,
  toDictionaryCsv,
  type DictionaryImport,
} from "../domain/redcap/dictionary";
import { REDCAP_FORM_TYPE } from "../domain/redcap/field";
import { parseFormSpec, type FormSpec, type Instrument } from "../domain/redcap/form";
import { assessForm, type FormAssessment } from "../domain/redcap/register";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import type { VariableNote } from "../domain/catalogue/variable";
import type { StudyNote } from "../domain/study/study";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";
import type { Exporter, ExportResult } from "./exporter";

export interface RedcapWriterContext {
  app: App;
  audit: AuditLog;
  exporter: Exporter;
  actor: () => string;
  /** Read fresh, so a settings change takes effect without a reload. */
  formsFolder: () => string;
  studies: () => readonly StudyNote[];
  variables: () => readonly VariableNote[];
  reindex: (file: TFile) => void;
}

/** Thrown when an export cannot proceed. Carries every reason, not the first. */
export class ExportRefused extends Error {
  constructor(
    readonly reasons: string[],
    /** True when a typed override could let it through; false for validation errors. */
    readonly overridable: boolean,
  ) {
    super(reasons.join(" "));
    this.name = "ExportRefused";
  }
}

export interface NewForm {
  id: string;
  title: string;
  study: string;
  project: string;
  instrumentName: string;
  instrumentLabel: string;
}

export class RedcapWriter {
  constructor(private readonly ctx: RedcapWriterContext) {}

  private actorOrThrow(action: string): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        `Set your initials as the actor in SCDB Cockpit settings first — ${action} is recorded in the audit ledger against an actor.`,
      );
    }
    return actor;
  }

  /* ------------------------------------------------------------- reading -- */

  /**
   * Read a form note: frontmatter from the cache, the block from the body.
   *
   * The body read is the reason this is async while the other parsers are not.
   * It is `cachedRead`, so a board showing twenty forms does not hit the disk
   * twenty times.
   */
  async specFor(file: TFile): Promise<FormSpec> {
    const cache = this.ctx.app.metadataCache.getFileCache(file);
    const { position: _position, ...frontmatter } = (cache?.frontmatter ?? {}) as Record<
      string,
      unknown
    >;

    const text = await this.ctx.app.vault.cachedRead(file);
    const block = findBlock(text);
    const problems: string[] = [];

    let parsed: unknown = null;
    if (block === null) {
      problems.push(
        "This note has no ```yaml redcap block, so it declares no fields. Add one, or import a data dictionary into it.",
      );
    } else {
      if (!block.tagged) {
        problems.push(
          "The form block is a plain ```yaml fence. Tagging it ```yaml redcap makes it unambiguous in a note that has more than one.",
        );
      }
      try {
        parsed = parseYaml(block.body);
      } catch (error) {
        problems.push(
          `The form block is not readable as YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return parseFormSpec({
      path: file.path,
      frontmatter,
      block: parsed,
      blockProblems: problems,
    });
  }

  /** Read and assess in one step, which is what every caller actually wants. */
  async assess(file: TFile): Promise<FormAssessment> {
    return assessForm({
      spec: await this.specFor(file),
      studies: this.ctx.studies(),
      variables: this.ctx.variables(),
    });
  }

  /* ------------------------------------------------------------- writing -- */

  /** Create a form note with one empty instrument and a record-id field. */
  async create(input: NewForm): Promise<TFile> {
    const folder = normalizePath(this.ctx.formsFolder());
    await ensureFolder(this.ctx.app, folder);

    const stem = (input.id || input.title).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Form";
    let path = normalizePath(`${folder}/${stem}.md`);
    for (let index = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; index += 1) {
      path = normalizePath(`${folder}/${stem} ${index}.md`);
    }

    // The record identifier is created rather than left to be forgotten:
    // REDCap makes the first field of the first instrument the record key
    // whatever it is, so an empty form's first field is a decision either way.
    const block = stringifyYaml({
      instruments: [
        {
          name: input.instrumentName,
          label: input.instrumentLabel,
          fields: [{ name: "record_id", type: "text", label: "Record ID" }],
        },
      ],
    });

    const file = await this.ctx.app.vault.create(
      path,
      [
        `# ${input.title || input.id}`,
        "",
        "What this instrument is for, who fills it in, and anything a person",
        "needs to know before changing it. This prose is never rewritten by the",
        "plugin — only the block below is.",
        "",
        "```yaml redcap",
        block.replace(/\s+$/, ""),
        "```",
        "",
      ].join("\n"),
    );

    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["type"] = REDCAP_FORM_TYPE;
      frontmatter["id"] = input.id;
      frontmatter["title"] = input.title;
      if (input.study !== "") frontmatter["study"] = input.study;
      if (input.project !== "") frontmatter["project"] = input.project;
      frontmatter["status"] = "draft";
      frontmatter["updated"] = toVaultDate(Date.now());
    });

    this.ctx.reindex(file);
    return file;
  }

  /**
   * Replace the instruments in a note's block, leaving everything else alone.
   *
   * Not logged. Editing a draft instrument is ordinary work, and §5.6's list of
   * consequential actions is deliberately short — a ledger that records every
   * keystroke is one nobody reads. What *is* logged is the export, the import
   * that replaces someone's fields, and any governance override.
   */
  async writeInstruments(file: TFile, instruments: readonly Instrument[]): Promise<void> {
    const yaml = stringifyYaml(instrumentsToBlock(instruments));
    await this.ctx.app.vault.process(file, (text) => replaceBlock(text, yaml));
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["updated"] = toVaultDate(Date.now());
    });
    this.ctx.reindex(file);
  }

  /* -------------------------------------------------------------- export -- */

  /**
   * Write the data dictionary to `95 Exports/`.
   *
   * Re-validates first, against the note as it is on disk right now. A board
   * rendered five minutes ago is not evidence about the file being written,
   * and this is the last point at which anything can be said before a CSV
   * exists that somebody will upload.
   */
  async exportDictionary(input: {
    file: TFile;
    /** A typed reason. Required only when a governance finding blocks. */
    override?: string;
  }): Promise<{ result: ExportResult; assessment: FormAssessment }> {
    const actor = this.actorOrThrow("an export");
    const assessment = await this.assess(input.file);

    if (assessment.errors.length > 0) {
      throw new ExportRefused(
        [
          `This form has ${assessment.errors.length} problem${assessment.errors.length === 1 ? "" : "s"} REDCap would reject the file for:`,
          ...assessment.errors.slice(0, 8).map((finding) => `• ${finding.message}`),
          ...(assessment.errors.length > 8 ? [`…and ${assessment.errors.length - 8} more.`] : []),
        ],
        false,
      );
    }

    const blocking = assessment.governance.findings.filter((finding) => finding.blocking);
    const override = (input.override ?? "").trim();
    if (blocking.length > 0 && override === "") {
      throw new ExportRefused(
        [
          "Governance blocks this export:",
          ...blocking.map((finding) => `• ${finding.message}`),
          "Exporting anyway needs a typed reason, and the reason goes in the audit ledger.",
        ],
        true,
      );
    }

    const subject = assessment.spec.id || input.file.basename;
    if (blocking.length > 0) {
      // Logged before the file exists, so a crash between the two leaves a
      // recorded intent rather than an unexplained CSV.
      await this.ctx.audit.append([
        {
          ts: toVaultMinute(Date.now()),
          actor,
          action: "gate-override",
          subject,
          detail: `redcap-export; ${blocking.map((f) => f.field).join(", ")} outside approved scope; reason: ${override}`,
        },
      ]);
    }

    const csv = toDictionaryCsv(assessment.spec);
    try {
      const result = await this.ctx.exporter.write({
        basename: `${subject}-dictionary`,
        extension: "csv",
        content: csv,
        subject,
        rows: assessment.fieldCount,
      });
      return { result, assessment };
    } catch (error) {
      if (blocking.length > 0) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.ctx.audit.append([
          correctionEntry({
            ts: toVaultMinute(Date.now()),
            actor,
            subject,
            correctsChain: "the override above",
            reason: `the export did not complete: ${reason}`,
          }),
        ]);
      }
      throw error;
    }
  }

  /* -------------------------------------------------------------- import -- */

  /** Read a dictionary without writing anything, so the dialog can show it first. */
  previewImport(csv: string): DictionaryImport {
    return fromDictionaryCsv(csv);
  }

  /**
   * Replace a note's instruments with an imported dictionary.
   *
   * Logged as a `bulk-edit`: it replaces every field in the note in one action,
   * which is exactly the shape §5.6 has that action for. The count in the
   * detail is what makes the entry useful later — "replaced 3 fields with 41"
   * is a sentence an auditor can act on.
   */
  async importDictionary(input: { file: TFile; csv: string }): Promise<DictionaryImport> {
    const actor = this.actorOrThrow("an import");
    const imported = fromDictionaryCsv(input.csv);

    if (imported.fieldCount === 0) {
      throw new Error(
        imported.problems[0] ??
          "That file produced no fields, so nothing was changed. Check it is a REDCap data dictionary export.",
      );
    }

    const before = await this.specFor(input.file);
    const beforeCount = before.instruments.reduce((sum, inst) => sum + inst.fields.length, 0);
    const subject = before.id || input.file.basename;

    await this.ctx.audit.append([
      {
        ts: toVaultMinute(Date.now()),
        actor,
        action: "bulk-edit",
        subject,
        detail: `redcap-import; replaced ${beforeCount} field${beforeCount === 1 ? "" : "s"} with ${imported.fieldCount} across ${imported.instruments.length} instrument${imported.instruments.length === 1 ? "" : "s"}`,
      },
    ]);

    try {
      await this.writeInstruments(input.file, imported.instruments);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `the import did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }

    return imported;
  }
}
