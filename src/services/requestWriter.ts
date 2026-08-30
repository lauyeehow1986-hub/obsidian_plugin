/**
 * The only place request notes are written.
 *
 * Two rules shape the ordering below:
 *
 *  - **Consequential actions are logged** (rule 9). The ledger entry is
 *    appended *before* the note is touched, so a crash between the two leaves a
 *    recorded intent rather than a silent change. If the write then fails, a
 *    `correction` entry is appended saying so — which is exactly what an
 *    append-only ledger is for.
 *  - **Never destroy data you did not write** (rule 8). Frontmatter is merged
 *    key by key through `processFrontMatter`; unknown keys are untouched and
 *    `history` is appended to, never replaced.
 */

import { TFile, type App } from "obsidian";
import {
  newRequest,
  newRequestBody,
  nextRequestId,
  type NewRequestInput,
} from "../domain/request/create";
import { applyMigration, type MigrationItem } from "../domain/request/migration";
import type { WorkflowNote } from "../domain/request/request";
import {
  applyTransition,
  type FrontmatterPatch,
  type TransitionEffect,
} from "../domain/request/transition";
import type { WorkflowSpec } from "../domain/request/workflow";
import { ensureFolder } from "../data/vaultPaths";
import type { RequestIndex } from "../data/requestIndex";
import type { AuditLog } from "./auditLog";
import { LedgerWriter } from "./ledgerWriter";

export { reportError } from "./ledgerWriter";

export interface WriterContext {
  app: App;
  index: RequestIndex;
  audit: AuditLog;
  requestsFolder: () => string;
  actor: () => string;
}

export interface MigrateRequestInput {
  file: TFile;
  request: WorkflowNote;
  spec: WorkflowSpec;
  /** The live stage id the note will carry afterwards. */
  toStage: string;
  /** Required when this is not the stage the spec proposed. */
  reason?: string;
  now?: number;
}

export interface MigrationOutcome {
  request: WorkflowNote;
  ok: boolean;
  /** Present when `ok` is false. Plain language, already user-facing. */
  error?: string;
  /** Present when `ok` is true. */
  item?: MigrationItem;
  remapped?: boolean;
}

export interface TransitionRequestInput {
  file: TFile;
  /**
   * `WorkflowNote`, not `RequestNote`: a project is one too (§5.15), and moving
   * one through its spec goes through this method rather than a second engine.
   */
  request: WorkflowNote;
  spec: WorkflowSpec;
  to: string;
  now?: number;
  blockedOn?: string | null;
  override?: { reason: string };
}

export class RequestWriter extends LedgerWriter {
  constructor(private readonly ctx: WriterContext) {
    super(ctx);
  }

  /** Create a request note and open the ledger on it. */
  async create(
    input: Omit<NewRequestInput, "actor" | "id" | "now"> & { now?: number; id?: string },
  ): Promise<TFile> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();
    const id =
      input.id ?? nextRequestId(this.ctx.index.ids(), new Date(now).getFullYear());

    const created = newRequest({ ...input, actor, now, id });
    const folder = this.ctx.requestsFolder();
    const path = `${folder}/${created.filename}`;

    if (this.ctx.app.vault.getAbstractFileByPath(path) !== null) {
      throw new Error(
        `"${path}" already exists. Two requests cannot share a filename — rename the existing one or pick another id.`,
      );
    }

    let file: TFile | null = null;
    await this.logThen(created.audit, id, async () => {
      await ensureFolder(this.ctx.app, folder);
      file = await this.ctx.app.vault.create(path, newRequestBody(input));
      await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
        Object.assign(frontmatter, created.frontmatter);
      });
    });

    if (file === null) throw new Error(`Could not create "${path}".`);
    this.ctx.index.update(file);
    return file;
  }

  /**
   * Move a request to another stage. Throws `TransitionRefused` when the move
   * is not allowed — call `evaluateTransition` first and collect an override
   * reason if the user wants one.
   */
  async transition(input: TransitionRequestInput): Promise<TransitionEffect> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();

    const effect = applyTransition({
      spec: input.spec,
      request: input.request,
      to: input.to,
      now,
      actor,
      blockedOn: input.blockedOn,
      ...(input.override ? { override: input.override } : {}),
    });

    const subject = input.request.id || input.request.uid;
    await this.logThen(effect.audit, subject, async () => {
      await this.applyPatch(input.file, effect.patch);
    });

    this.ctx.index.update(input.file);
    return effect;
  }

  /**
   * Migrate stranded requests onto the current workflow version (§5.2).
   *
   * Bulk, but not atomic, and deliberately so: each note is logged and written
   * independently, so one unwritable file does not silently abandon the other
   * eleven. The caller gets an outcome per note and reports what actually
   * happened.
   */
  async migrate(inputs: readonly MigrateRequestInput[]): Promise<MigrationOutcome[]> {
    const actor = this.actorOrThrow();
    const outcomes: MigrationOutcome[] = [];

    for (const input of inputs) {
      const { request } = input;
      try {
        const effect = applyMigration({
          spec: input.spec,
          request,
          toStage: input.toStage,
          actor,
          now: input.now ?? Date.now(),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });

        await this.logThen(effect.audit, request.id || request.uid, async () => {
          await this.applyPatch(input.file, effect.patch);
        });

        this.ctx.index.update(input.file);
        outcomes.push({ request, ok: true, item: effect.item, remapped: effect.remapped });
      } catch (error) {
        outcomes.push({
          request,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return outcomes;
  }
}
