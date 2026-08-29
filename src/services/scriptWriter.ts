/**
 * The only place script docs and run records are written (§5.12, §5.14, §7 C3).
 *
 * Three jobs, and the boundaries between them are the interesting part:
 *
 *  - **Create a documentation note.** Not consequential, so not logged — the
 *    same call the catalogue writer makes for a new variable.
 *  - **Record a run.** Consequential: it writes a provenance record that a
 *    number in a report will later lean on. Logged as `run-recorded`, never
 *    `code-run`, because nothing was executed here (see `domain/script/recordRun`).
 *  - **Check the file hash.** Reads the script file and compares it with what
 *    the note documents.
 *
 * **The hash is only ever read from inside the vault.** `file:` may point at a
 * portable R build's working folder or a network share, and reaching those
 * would mean `fs` and a path outside the vault — the boundary rule 8 draws,
 * with `services/backup.ts` as the single documented exception. So an outside
 * path is reported as uncheckable from here rather than quietly resolved, and
 * F1 — which will have the file open anyway — is where that gap closes.
 */

import { normalizePath, TFile, type App } from "obsidian";
import { correctionEntry, type AuditEntry } from "../domain/audit/ledger";
import { sha256Bytes } from "../domain/audit/sha256";
import { planRun, type RunDraft, type RunPlan } from "../domain/script/recordRun";
import { parseScriptDoc, scriptLabel, type ScriptDoc } from "../domain/script/scriptDoc";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";

export interface ScriptWriterContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
  /** Read fresh, so a settings change takes effect without a reload. */
  scriptsFolder: () => string;
  runsFolder: () => string;
  reindex: (file: TFile) => void;
}

/** Thrown when a run cannot be recorded. Carries every reason, not the first. */
export class RunRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
    this.name = "RunRefused";
  }
}

export interface NewScript {
  id: string;
  title: string;
  purpose: string;
  language: string;
  file: string;
  study: string;
  inputs: { dataset: string; version: string; changed: string }[];
  variables: string[];
}

export interface RecordRunInput {
  file: TFile;
  doc: ScriptDoc;
  draft: RunDraft;
  now?: number;
}

/** What checking a documented hash against the file on disk found. */
export interface HashCheck {
  outcome: "match" | "differs" | "not-recorded" | "missing" | "outside-vault";
  /** What the file actually hashes to, when it could be read. */
  observed: string;
  documented: string;
  /** One plain-English line, ready for a notice. */
  message: string;
}

/**
 * A path Obsidian's vault adapter cannot resolve: a Windows drive letter, a
 * UNC share, or a POSIX absolute path. Checked by shape rather than by trying
 * and catching, so the refusal reads as a decision instead of a failure.
 */
function isOutsideVault(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path.trim());
}

export class ScriptWriter {
  constructor(private readonly ctx: ScriptWriterContext) {}

  private actorOrThrow(): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials as the actor in SCDB Cockpit settings first — every logged action needs to name who did it.",
      );
    }
    return actor;
  }

  /** Create a script documentation note. */
  async create(input: NewScript): Promise<TFile> {
    const folder = normalizePath(this.ctx.scriptsFolder());
    await ensureFolder(this.ctx.app, folder);

    const stem = (input.id || input.title).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "Script";
    let path = normalizePath(`${folder}/${stem}.md`);
    for (let index = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; index += 1) {
      path = normalizePath(`${folder}/${stem} ${index}.md`);
    }

    const file = await this.ctx.app.vault.create(
      path,
      [
        `# ${input.title || input.id}`,
        "",
        "What this script does, in enough detail that somebody else could run it:",
        "the order of the steps, anything it assumes about the extract, and any",
        "decision inside it that a reader would otherwise have to reverse-engineer.",
        "",
        "Record each run through the script board rather than editing `last_run`",
        "here — a run recorded by hand leaves no provenance record, and it is the",
        "record that makes a number defensible six months later.",
        "",
      ].join("\n"),
    );

    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["type"] = "script-doc";
      frontmatter["id"] = input.id;
      if (input.title !== "") frontmatter["title"] = input.title;
      frontmatter["purpose"] = input.purpose;
      if (input.language !== "") frontmatter["language"] = input.language;
      frontmatter["file"] = input.file;
      if (input.study !== "") frontmatter["study"] = input.study;
      const inputs = input.inputs
        .filter((entry) => entry.dataset.trim() !== "")
        .map((entry) => {
          const record: Record<string, unknown> = { dataset: entry.dataset.trim() };
          if (entry.version.trim() !== "") record["version"] = entry.version.trim();
          if (entry.changed.trim() !== "") record["changed"] = entry.changed.trim();
          return record;
        });
      if (inputs.length > 0) frontmatter["inputs"] = inputs;
      if (input.variables.length > 0) frontmatter["variables"] = input.variables;
    });

    this.ctx.reindex(file);
    return file;
  }

  /** What recording a run would write, without writing it. Drives the dialog. */
  preview(input: RecordRunInput, sequence = 1): RunPlan {
    return planRun({
      doc: input.doc,
      draft: input.draft,
      actor: this.ctx.actor().trim(),
      sequence,
    });
  }

  /**
   * How many run records already exist for a date, so the sequence continues.
   *
   * Counted from the folder rather than from the index, because the index may
   * not have caught up with a record written a moment ago — and a duplicate id
   * would put two runs behind one name in every later report.
   */
  private sequenceFor(at: number): number {
    const folder = normalizePath(this.ctx.runsFolder());
    const prefix = `RUN-${toVaultDate(at)}-`;
    let highest = 0;
    for (const file of this.ctx.app.vault.getFiles()) {
      if (!file.path.startsWith(`${folder}/`)) continue;
      if (!file.basename.startsWith(prefix)) continue;
      const suffix = Number(file.basename.slice(prefix.length));
      if (Number.isInteger(suffix) && suffix > highest) highest = suffix;
    }
    return highest + 1;
  }

  /**
   * Write a §5.12 run record and advance the doc's `last_run`.
   *
   * The ledger entry goes in before either write, so a crash between them
   * leaves a recorded intent rather than a silent change; a failure appends a
   * `correction` saying what did not complete.
   */
  async recordRun(input: RecordRunInput): Promise<RunPlan> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();
    const at = input.draft.started ?? now;
    const plan = planRun({
      doc: input.doc,
      draft: input.draft,
      actor,
      sequence: this.sequenceFor(at),
    });
    if (plan.refusals.length > 0) throw new RunRefused(plan.refusals);

    const subject = input.doc.id || input.file.path;
    const entries: AuditEntry[] = [
      {
        ts: toVaultMinute(now),
        actor,
        action: "run-recorded",
        subject,
        detail: plan.auditDetail,
      },
    ];
    await this.ctx.audit.append(entries);

    try {
      const folder = normalizePath(this.ctx.runsFolder());
      await ensureFolder(this.ctx.app, folder);

      let path = normalizePath(`${folder}/${plan.id}.md`);
      for (let index = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; index += 1) {
        path = normalizePath(`${folder}/${plan.id} ${index}.md`);
      }

      const runFile = await this.ctx.app.vault.create(
        path,
        [
          `# ${plan.id}`,
          "",
          `Provenance record for ${scriptLabel(input.doc)} (§5.12).`,
          "",
          "Recorded by hand: the plugin did not run this, it wrote down that it was",
          "run. `script_hash` is what makes it worth anything — it names the code",
          "that actually produced these outputs, not the code the note describes now.",
          "",
        ].join("\n"),
      );
      await this.ctx.app.fileManager.processFrontMatter(runFile, (frontmatter) => {
        for (const [key, value] of Object.entries(plan.frontmatter)) frontmatter[key] = value;
      });

      await this.ctx.app.fileManager.processFrontMatter(input.file, (frontmatter) => {
        for (const [key, value] of Object.entries(plan.patch)) frontmatter[key] = value;
      });

      this.ctx.reindex(runFile);
      this.ctx.reindex(input.file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `the run record did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }

    return plan;
  }

  /** Hash the script file, when it is somewhere the vault can reach. */
  async checkHash(doc: ScriptDoc): Promise<HashCheck> {
    const documented = doc.fileHash;
    if (doc.file === "") {
      return {
        outcome: "missing",
        observed: "",
        documented,
        message: "This note names no `file`, so there is nothing to hash.",
      };
    }
    if (isOutsideVault(doc.file)) {
      return {
        outcome: "outside-vault",
        observed: "",
        documented,
        message: `\`${doc.file}\` is outside the vault, so the plugin will not read it. Record its hash on the note when you run it.`,
      };
    }

    const path = normalizePath(doc.file);
    const adapter = this.ctx.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      return {
        outcome: "missing",
        observed: "",
        documented,
        message: `Nothing at \`${path}\` in the vault. Either the code moved or \`file\` is wrong.`,
      };
    }

    const observed = sha256Bytes(new Uint8Array(await adapter.readBinary(path)));
    if (documented === "") {
      return {
        outcome: "not-recorded",
        observed,
        documented,
        message: `\`${path}\` hashes to ${observed.slice(0, 12)}…, and this note records no hash to compare it with.`,
      };
    }
    return observed === documented
      ? {
          outcome: "match",
          observed,
          documented,
          message: `\`${path}\` still matches the hash on this note (${observed.slice(0, 12)}…).`,
        }
      : {
          outcome: "differs",
          observed,
          documented,
          message: `\`${path}\` now hashes to ${observed.slice(0, 12)}…, but this note documents ${documented.slice(0, 12)}… — the code has changed since it was last recorded.`,
        };
  }

  /**
   * Write an observed hash onto the note.
   *
   * Separate from `checkHash` on purpose: seeing that the code moved and
   * declaring the new version documented are two different decisions, and
   * collapsing them would mean the note silently caught up with every edit.
   */
  async adoptHash(file: TFile, hash: string, now = Date.now()): Promise<void> {
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["file_hash"] = `sha256:${hash}`;
      frontmatter["hash_checked"] = toVaultDate(now);
    });
    this.ctx.reindex(file);
  }

  /** Re-read a script doc from the vault, for a caller holding only a file. */
  docFor(file: TFile): ScriptDoc | null {
    const frontmatter = this.ctx.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return null;
    const { position: _position, ...rest } = frontmatter as Record<string, unknown>;
    return parseScriptDoc(file.path, rest);
  }
}
