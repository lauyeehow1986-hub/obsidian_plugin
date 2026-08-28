/**
 * The only place catalogue variables are written (§5.8, §7 C2).
 *
 * Same two rules as every other writer here:
 *
 *  - **Consequential actions are logged** (rule 9). The ledger entry goes in
 *    before the note is touched, so a crash between the two leaves a recorded
 *    intent rather than a silent change; a failed write appends a `correction`
 *    saying so.
 *  - **Never destroy data you did not write** (rule 8). Frontmatter merges key
 *    by key; `history` is appended to, never replaced.
 *
 * **A revision writes the history entry and the new head in one
 * `processFrontMatter` call.** Unlike a policy revision, where the frozen copy
 * is a separate file and must be written first, both halves of a variable
 * revision live in the same frontmatter block — so the ordering risk C1 has to
 * design around does not exist here. Obsidian applies the callback's result
 * atomically: either both the superseded record and the new version land, or
 * neither does.
 *
 * **Two ledger entries when the identifier flag moves.** §5.6 names
 * `identifier-scope` as a logged action in its own right, and an auditor looks
 * for it by action rather than by reading every `variable-revision` detail
 * cell. One entry would technically record the fact and practically hide it.
 */

import { normalizePath, TFile, type App } from "obsidian";
import { correctionEntry, type AuditEntry } from "../domain/audit/ledger";
import { planRevision, type RevisionPlan } from "../domain/catalogue/revise";
import {
  parseVariable,
  variableLabel,
  type Definition,
  type VariableNote,
} from "../domain/catalogue/variable";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";

export interface CatalogueWriterContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
  /** The catalogue folder, read fresh so a settings change takes effect. */
  catalogueFolder: () => string;
  /** Called after a successful write so the index repaints. */
  reindex: (file: TFile) => void;
}

/** Thrown when a revision cannot proceed. Carries every reason, not the first. */
export class RevisionRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
    this.name = "RevisionRefused";
  }
}

export interface NewVariable {
  id: string;
  label: string;
  domain: string;
  dataType: string;
  units: string;
  definition: string;
  identifier: boolean;
  justification: string;
  collectedIn: string[];
  sourceForm: string;
}

export interface ReviseVariableInput {
  file: TFile;
  variable: VariableNote;
  /** Only the definition fields the dialog changed. */
  changes: Partial<Definition>;
  /** One line on why the definition moved. Required — see `revise`. */
  reason: string;
  now?: number;
}

export class CatalogueWriter {
  constructor(private readonly ctx: CatalogueWriterContext) {}

  private actorOrThrow(): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials as the actor in SCDB Cockpit settings first — every logged action needs to name who did it.",
      );
    }
    return actor;
  }

  /**
   * Create a variable note at version 1.
   *
   * `changed` is stamped with today, not left empty: version 1 needs a start
   * date or every later "which definition was in force" question about this
   * variable is unanswerable from the day it is created.
   */
  async create(input: NewVariable, now = Date.now()): Promise<TFile> {
    const folder = normalizePath(this.ctx.catalogueFolder());
    await ensureFolder(this.ctx.app, folder);

    const stem = (input.id || input.label).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Variable";
    let path = normalizePath(`${folder}/${stem}.md`);
    for (let index = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; index += 1) {
      path = normalizePath(`${folder}/${stem} ${index}.md`);
    }

    const file = await this.ctx.app.vault.create(
      path,
      [
        `# ${input.label || input.id}`,
        "",
        "Notes on how this variable is collected, and anything a person needs to",
        "know before using it that does not belong in the definition itself.",
        "",
        "Revise it through the catalogue board rather than editing `definition`",
        "here — a definition changed in place leaves nothing that can say what it",
        "used to mean.",
        "",
      ].join("\n"),
    );

    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["type"] = "variable";
      frontmatter["id"] = input.id;
      frontmatter["label"] = input.label;
      if (input.domain !== "") frontmatter["domain"] = input.domain;
      if (input.dataType !== "") frontmatter["data_type"] = input.dataType;
      if (input.units !== "") frontmatter["units"] = input.units;
      frontmatter["definition"] = input.definition;
      frontmatter["identifier"] = input.identifier;
      if (input.justification !== "") frontmatter["justification"] = input.justification;
      if (input.collectedIn.length > 0) frontmatter["collected_in"] = input.collectedIn;
      if (input.sourceForm !== "") frontmatter["source_form"] = input.sourceForm;
      frontmatter["version"] = 1;
      frontmatter["changed"] = toVaultDate(now);
    });

    this.ctx.reindex(file);
    return file;
  }

  /** What a revision would do, without doing it. Drives the dialog's preview. */
  preview(input: ReviseVariableInput): RevisionPlan {
    return planRevision({
      variable: input.variable,
      changes: input.changes,
      reason: input.reason,
      at: input.now ?? Date.now(),
    });
  }

  /**
   * Supersede the current definition and write the new one.
   *
   * Throws `RevisionRefused` with every reason when the plan refuses — a
   * reason that is not typed, a change that changes nothing, or a note with no
   * id or no readable version.
   */
  async revise(input: ReviseVariableInput): Promise<RevisionPlan> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();
    const plan = this.preview({ ...input, now });
    if (plan.refusals.length > 0) throw new RevisionRefused(plan.refusals);

    const subject = input.variable.id || input.file.path;
    const entries: AuditEntry[] = [
      {
        ts: toVaultMinute(now),
        actor,
        action: "variable-revision",
        subject,
        detail: `${plan.auditDetail}; reason: ${plan.reason}`,
      },
    ];
    if (plan.identifierMoved) {
      const change = plan.changes.find((entry) => entry.field === "identifier");
      entries.push({
        ts: toVaultMinute(now),
        actor,
        action: "identifier-scope",
        subject,
        detail: `identifier ${change?.before ?? "?"}→${change?.after ?? "?"} at v${plan.toVersion}`,
      });
    }
    await this.ctx.audit.append(entries);

    try {
      await this.ctx.app.fileManager.processFrontMatter(input.file, (frontmatter) => {
        const existing: unknown = frontmatter["history"];
        frontmatter["history"] = [...(Array.isArray(existing) ? existing : []), plan.record];
        for (const [key, value] of Object.entries(plan.patch)) frontmatter[key] = value;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `the revision did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }

    this.ctx.reindex(input.file);
    return plan;
  }

  /** Re-read a variable note from the vault, for a caller holding only a file. */
  variableFor(file: TFile): VariableNote | null {
    const cache = this.ctx.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter) return null;
    const { position: _position, ...rest } = frontmatter as Record<string, unknown>;
    return parseVariable(file.path, rest);
  }

  /** How a variable is named in a notice. */
  static label(variable: VariableNote): string {
    return variableLabel(variable);
  }
}
