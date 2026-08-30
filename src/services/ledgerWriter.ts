/**
 * The write discipline every consequential vault change goes through
 * (CLAUDE.md §5.6, rule 9).
 *
 * Three rules live here, and they live here *once* because they are the part
 * that must not vary between one kind of note and another:
 *
 *  1. **No action without an actor.** Every ledger row names who did it, so a
 *     change with nobody to name is refused before anything is written.
 *  2. **Ledger first, then the note.** If the write then fails, the ledger
 *     receives a `correction` rather than being left claiming something that
 *     did not happen. §5.6 forbids editing a past row — the chain is what makes
 *     that detectable — so an honest retraction is the only correct move.
 *  3. **Frontmatter merges, never replaces.** Unknown keys survive (rule 8), and
 *     `history` is appended to rather than rewritten.
 *
 * `RequestWriter` and `ProjectWriter` both extend this. A second copy of rule 2
 * that drifted from the first would be worse than no rule at all, because the
 * ledger would look trustworthy while being wrong in one of two places.
 */

import { Notice, TFile, type App } from "obsidian";
import { correctionEntry, type AuditEntry } from "../domain/audit/ledger";
import type { FrontmatterPatch } from "../domain/request/transition";
import { toVaultMinute } from "../domain/time/dates";
import type { AuditLog } from "./auditLog";

export interface LedgerWriterContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
}

export abstract class LedgerWriter {
  protected constructor(protected readonly base: LedgerWriterContext) {}

  protected actorOrThrow(): string {
    const actor = this.base.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials as the actor in SCDB Cockpit settings first — every logged action needs to name who did it.",
      );
    }
    return actor;
  }

  /**
   * Run `act` with the ledger written first. On failure the ledger gets a
   * correction rather than being left claiming something that did not happen.
   */
  protected async logThen(
    entries: AuditEntry[],
    subject: string,
    act: () => Promise<void>,
  ): Promise<void> {
    await this.base.audit.append(entries);
    try {
      await act();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.base.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor: entries[0]?.actor ?? "unknown",
          subject,
          correctsChain: "the entry above",
          reason: `the change did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }
  }

  /**
   * Merge a patch into a note's frontmatter. Keys we do not know are untouched
   * (rule 8), and `history` is appended to rather than rewritten.
   *
   * Verified against a real vault on Obsidian 1.12.7: bare dates survive
   * untouched — `received: 2026-07-20` does *not* come back as
   * `2026-07-20T00:00:00.000Z`, which had been the worry. What
   * `processFrontMatter` does do is re-serialise the whole block, so a
   * `history` written in flow style (`- { at: …, to: … }`) comes back in block
   * style. No data is lost and the note stays hand-readable; the cost is that
   * the first write to a note produces a whole-array diff. Preserving flow
   * style would mean hand-serialising YAML ourselves, which is the worse trade.
   */
  protected async applyPatch(file: TFile, patch: FrontmatterPatch): Promise<void> {
    await this.base.app.fileManager.processFrontMatter(file, (frontmatter) => {
      Object.assign(frontmatter, patch.set);
      for (const key of patch.unset) delete frontmatter[key];

      if (patch.appendHistory !== undefined) {
        const history: unknown = frontmatter["history"];
        frontmatter["history"] = [...(Array.isArray(history) ? history : []), patch.appendHistory];
      }
    });
  }
}

/** Show an error the way §8 requires: plain language plus what to do next. */
export function reportError(error: unknown, whatFailed: string): void {
  const message = error instanceof Error ? error.message : String(error);
  new Notice(`SCDB: ${whatFailed}\n${message}`, 10000);
}
