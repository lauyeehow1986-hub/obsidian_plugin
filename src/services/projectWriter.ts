/**
 * Writing project notes (CLAUDE.md §5.15, §7 B8).
 *
 * Deliberately thin. Creation and milestone completion are the only two things
 * here that a request writer does not already do; **stage changes are not** —
 * `RequestWriter.transition` takes a `WorkflowNote`, and a project is one, so
 * moving a project through its spec goes through the request writer verbatim
 * and gets the same refusals, the same typed-reason rule and the same ledger
 * rows. §5.15 says if a project feature needs a second engine the design is
 * wrong; this file is where that would have happened, and it did not.
 *
 * Both writers extend `LedgerWriter`, so there is exactly one definition of
 * "ledger first, then the note, and a correction if the note write fails".
 */

import { TFile, type App } from "obsidian";
import { newProject, newProjectBody, nextProjectId, type NewProjectInput } from "../domain/project/create";
import { toVaultDate } from "../domain/time/dates";
import type { ProjectIndex } from "../data/projectIndex";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";
import { LedgerWriter } from "./ledgerWriter";

export interface ProjectWriterContext {
  app: App;
  index: ProjectIndex;
  audit: AuditLog;
  projectsFolder: () => string;
  actor: () => string;
}

export class ProjectWriter extends LedgerWriter {
  constructor(private readonly ctx: ProjectWriterContext) {
    super(ctx);
  }

  /** Create a project note and open the ledger on it. */
  async create(
    input: Omit<NewProjectInput, "actor" | "id" | "now"> & { now?: number; id?: string },
  ): Promise<TFile> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();
    const id = input.id ?? nextProjectId(this.ctx.index.ids(), new Date(now).getFullYear());

    const created = newProject({ ...input, actor, now, id });
    const folder = this.ctx.projectsFolder();
    const path = `${folder}/${created.filename}`;

    if (this.ctx.app.vault.getAbstractFileByPath(path) !== null) {
      throw new Error(
        `"${path}" already exists. Two projects cannot share a filename — rename the existing one or pick another id.`,
      );
    }

    let file: TFile | null = null;
    await this.logThen(created.audit, id, async () => {
      await ensureFolder(this.ctx.app, folder);
      file = await this.ctx.app.vault.create(path, newProjectBody(input));
      await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
        Object.assign(frontmatter, created.frontmatter);
      });
    });

    if (file === null) throw new Error(`Could not create "${path}".`);
    this.ctx.index.update(file);
    return file;
  }

  /**
   * Mark a milestone landed, or reopen one.
   *
   * Not logged to the ledger, and that is a considered position rather than an
   * omission. §5.6 lists what is consequential — gate overrides, deletions,
   * exports, changes to identifier scope or governance fields — and §5.12 makes
   * the argument directly: "an audit trail nobody can read is not an audit
   * trail". A milestone date is an ordinary field a person could type by hand,
   * and it is already recorded where it belongs: in the note, in plain markdown,
   * under version control if the vault has any.
   *
   * The write still goes through `processFrontMatter`, so a hand-added key on
   * that milestone survives (rule 8).
   */
  async setMilestoneDone(file: TFile, milestoneId: string, done: number | null): Promise<void> {
    const wanted = milestoneId.trim();
    if (wanted === "") throw new Error("No milestone was named.");

    let found = false;
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const raw: unknown = frontmatter["milestones"];
      if (!Array.isArray(raw)) return;

      frontmatter["milestones"] = raw.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
        const milestone = entry as Record<string, unknown>;
        if (String(milestone["id"] ?? "").trim() !== wanted) return entry;
        found = true;
        // Merge, never replace: a hand-added `owner` or `note` on this
        // milestone is not ours to discard.
        if (done === null) {
          const { done: _dropped, ...rest } = milestone;
          return rest;
        }
        return { ...milestone, done: toVaultDate(done) };
      });
    });

    if (!found) {
      throw new Error(
        `This note has no milestone "${wanted}". Check the id in the note's \`milestones\` list.`,
      );
    }
    this.ctx.index.update(file);
  }

  /**
   * Link a request to a project, for the effort roll-up (§5.15).
   *
   * Appends to `requests` and refuses to duplicate an entry already there. The
   * link is a plain wikilink, because this is a markdown vault and the note has
   * to stay readable with the plugin uninstalled.
   */
  async linkRequest(file: TFile, requestId: string): Promise<boolean> {
    const link = `[[${requestId.trim()}]]`;
    let added = false;

    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const raw: unknown = frontmatter["requests"];
      const existing = Array.isArray(raw) ? raw.map((entry) => String(entry).trim()) : [];
      if (existing.includes(link)) return;
      frontmatter["requests"] = [...existing, link];
      added = true;
    });

    if (added) this.ctx.index.update(file);
    return added;
  }
}
