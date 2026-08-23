/**
 * The only place publication notes are written (CLAUDE.md §7 B5).
 *
 * Same two rules as `requestWriter.ts`, for the same reasons:
 *
 *  - **Consequential actions are logged** (rule 9). The ledger entry goes in
 *    *before* the note is touched, so a crash between the two leaves a recorded
 *    intent rather than a silent change; a failed write then appends a
 *    `correction` saying so.
 *  - **Never destroy data you did not write** (rule 8). Frontmatter merges key
 *    by key through `processFrontMatter`; unknown keys are untouched and
 *    `history` is appended to, never replaced.
 *
 * Deliberately a separate class from `RequestWriter` rather than a shared
 * generic one. The two engines refuse for different reasons — a request gate is
 * overridable with a typed reason, a publication refusal never is — and folding
 * them together would mean one code path where the override rule is a
 * parameter. §5.6's override rule is the single most load-bearing line in the
 * audit story; it does not become an argument.
 */

import { TFile, type App } from "obsidian";
import { correctionEntry, type AuditEntry } from "../domain/audit/ledger";
import type { PublicationNote } from "../domain/publication/publication";
import {
  applyPublicationTransition,
  type PublicationEffect,
  type PublicationPatch,
} from "../domain/publication/stages";
import { toVaultMinute } from "../domain/time/dates";
import type { AuditLog } from "./auditLog";

export interface PublicationWriterContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
  /** Called after a successful write so the index repaints. */
  reindex: (file: TFile) => void;
}

export interface PublicationTransitionInput {
  file: TFile;
  publication: PublicationNote;
  to: string;
  /** Where it is being sent, when the move is a submission elsewhere. */
  journal?: string;
  /** When the journal's answer is expected. `null` clears it. */
  decisionDue?: number | null;
  now?: number;
}

export class PublicationWriter {
  constructor(private readonly ctx: PublicationWriterContext) {}

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
   * Move a manuscript to another stage.
   *
   * Throws `PublicationRefused` when the move is not allowed. Call
   * `evaluatePublicationTransition` first; unlike a request there is no
   * override, so a refusal here is the end of it.
   */
  async transition(input: PublicationTransitionInput): Promise<PublicationEffect> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();

    const effect = applyPublicationTransition({
      publication: input.publication,
      to: input.to,
      now,
      actor,
      ...(input.journal === undefined ? {} : { journal: input.journal }),
      ...(input.decisionDue === undefined ? {} : { decisionDue: input.decisionDue }),
    });

    const subject = input.publication.id || input.publication.path;
    await this.ctx.audit.append(effect.audit);
    try {
      await this.applyPatch(input.file, effect.patch);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `the change did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }

    this.ctx.reindex(input.file);
    return effect;
  }

  /** Merge a patch into frontmatter without disturbing anything else in it. */
  private async applyPatch(file: TFile, patch: PublicationPatch): Promise<void> {
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, patch.set);
      for (const key of patch.unset) delete frontmatter[key];
      const history: unknown = frontmatter["history"];
      frontmatter["history"] = [...(Array.isArray(history) ? history : []), patch.appendHistory];
    });
  }
}

/** Re-exported so callers do not have to import from two places to catch it. */
export type { AuditEntry };
