/**
 * Running a block, and everything that has to be true afterwards (§7 F1).
 *
 * The order of the steps below is the part worth reading. A run touches four
 * things — a temporary directory, the note, `94 Runs/`, and the ledger — and
 * the sequence is chosen so that a crash at any point leaves something a person
 * can make sense of:
 *
 *  1. the ledger entry goes in **first**, before anything is written, so an
 *     interrupted run leaves a recorded intent rather than a silent change
 *     (the same order `services/scriptWriter` uses, and for the same reason);
 *  2. the figures are copied into the vault, because the note is about to
 *     point at them;
 *  3. the run record is written, so the provenance exists before the thing
 *     that cites it;
 *  4. the note gets its output block last.
 *
 * Rule 12 lives in the caller: nothing here is reachable without a person
 * pressing Run and confirming a dialog that showed them the code.
 */

import { normalizePath, TFile, type App } from "obsidian";
import type { AuditEntry } from "../domain/audit/ledger";
import { sha256 } from "../domain/audit/sha256";
import {
  LANGUAGE_LABELS,
  locateBlock,
  type RunLanguage,
  type RunnableBlock,
} from "../domain/compute/block";
import {
  buildHarness,
  buildProbe,
  FIGURE_DIR,
  interpreterLabel,
  isHarnessFigure,
  META_FILE,
  readMeta,
  readProbe,
  type ProbeReading,
  type PythonIsolation,
} from "../domain/compute/harness";
import { insertOutput, renderOutputBlock } from "../domain/compute/insert";
import {
  capOutput,
  classifyExit,
  outcomeDetail,
  outcomeSummary,
  type RunOutcome,
} from "../domain/compute/outcome";
import { blockLabel, planObservedRun, type ObservedRunPlan } from "../domain/compute/provenance";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";
import {
  listWorkFiles,
  looksAbsolute,
  makeWorkDir,
  readWorkBinary,
  readWorkFile,
  removeWorkDir,
  runProcess,
  writeWorkFile,
} from "./interpreter";

export interface ComputeSettings {
  rPath: string;
  pythonPath: string;
  pythonIsolation: PythonIsolation;
  timeoutSeconds: number;
  maxOutputKb: number;
}

export interface ComputeContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
  runsFolder: () => string;
  settings: () => ComputeSettings;
  reindex: (file: TFile) => void;
}

/** Thrown when a run cannot start. Carries every reason, not the first. */
export class RunBlocked extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
    this.name = "RunBlocked";
  }
}

export interface RunOptions {
  file: TFile;
  block: RunnableBlock;
  /** Optional provenance a person supplied in the run dialog. */
  request: string;
  inputs: { dataset: string; version: string }[];
  variables: string[];
}

export interface RunReport {
  plan: ObservedRunPlan;
  outcome: RunOutcome;
  runFile: TFile;
  /** True when a previous run's output block was replaced rather than added. */
  replaced: boolean;
}

/** A run in flight. `stop` is what the Stop button calls. */
export interface RunTicket {
  done: Promise<RunReport>;
  stop: () => void;
}

export class ComputeRunner {
  constructor(private readonly ctx: ComputeContext) {}

  interpreterFor(language: RunLanguage): string {
    const settings = this.ctx.settings();
    return (language === "r" ? settings.rPath : settings.pythonPath).trim();
  }

  /**
   * Why this block cannot be run, in plain English.
   *
   * Returned as a list rather than thrown so the dialog can show the problem
   * *before* offering a Run button that would fail — an error message after
   * the fact teaches nothing about what to change.
   */
  blockers(language: RunLanguage): string[] {
    const reasons: string[] = [];
    const interpreter = this.interpreterFor(language);
    const name = LANGUAGE_LABELS[language];

    if (interpreter === "") {
      reasons.push(
        `No ${name} interpreter is configured. Settings → SCDB Cockpit → Running code, then point at the ${language === "r" ? "Rscript executable" : "python executable"}.`,
      );
    } else if (!looksAbsolute(interpreter)) {
      reasons.push(
        `The ${name} interpreter is set to "${interpreter}", which is not a full path. The target machine does not have either interpreter on PATH, so give the whole path to the executable.`,
      );
    }
    if (this.ctx.actor().trim() === "") {
      reasons.push("Set your initials in settings first — a run record with no author is not provenance.");
    }
    return reasons;
  }

  /**
   * Ask an interpreter what it is. The "test interpreter" button (§7 F1).
   *
   * Runs with the same isolation a real run would, because the useful question
   * is not "is there a python here" but "does the python we would run find its
   * packages". A green tick from a laxer invocation than the real one would be
   * a lie that costs an afternoon.
   */
  async probe(language: RunLanguage): Promise<{ reading: ProbeReading; error: string }> {
    const interpreter = this.interpreterFor(language);
    if (interpreter === "") {
      return { reading: emptyReading(), error: "No path set." };
    }

    const settings = this.ctx.settings();
    const probe = buildProbe({ language, interpreter, isolation: settings.pythonIsolation });
    const dir = await makeWorkDir();
    try {
      const result = await runProcess({
        command: probe.command,
        args: probe.args,
        cwd: dir,
        timeoutMs: 20_000,
        maxBytes: 16 * 1024,
      }).done;

      if (result.spawnError !== "") {
        return { reading: emptyReading(), error: describeSpawnError(result.spawnError, interpreter) };
      }
      if (result.timedOut) {
        return { reading: emptyReading(), error: "It did not answer within 20 seconds." };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim().split("\n")[0] ?? "";
        return {
          reading: emptyReading(),
          error: `It started but exited with status ${String(result.code)}${detail === "" ? "" : `: ${detail}`}`,
        };
      }
      return { reading: readProbe(language, result.stdout), error: "" };
    } finally {
      await removeWorkDir(dir);
    }
  }

  /**
   * Run a block and land everything it produced.
   *
   * The block is re-located in the file as it is *now*, not as it was when the
   * dialog opened. An editor left open, a sync, a colleague's change — the gap
   * is small but real, and running code the person is no longer looking at is
   * the one outcome worth going out of the way to prevent.
   */
  start(options: RunOptions): RunTicket {
    const blockers = this.blockers(options.block.language);
    if (blockers.length > 0) {
      return { done: Promise.reject(new RunBlocked(blockers)), stop: () => {} };
    }

    let stop = (): void => {};
    const done = this.execute(options, (fn) => {
      stop = fn;
    });
    return { done, stop: () => stop() };
  }

  private async execute(options: RunOptions, expose: (stop: () => void) => void): Promise<RunReport> {
    const { file, block } = options;
    const settings = this.ctx.settings();
    const actor = this.ctx.actor().trim();

    const text = await this.ctx.app.vault.read(file);
    const current = locateBlock(text, block);
    if (current === null) {
      throw new RunBlocked([
        "That block is no longer in the note — it has been edited or removed since the dialog opened. Nothing was run.",
      ]);
    }

    const source = current.source;
    const scriptHash = sha256(source);
    const harness = buildHarness({
      language: current.language,
      source,
      interpreter: this.interpreterFor(current.language),
      isolation: settings.pythonIsolation,
    });

    const dir = await makeWorkDir();
    const started = Date.now();

    try {
      for (const item of harness.files) await writeWorkFile(dir, item.name, item.text);

      const handle = runProcess({
        command: harness.command,
        args: harness.args,
        cwd: dir,
        timeoutMs: settings.timeoutSeconds * 1000,
        maxBytes: settings.maxOutputKb * 1024,
      });
      expose(handle.stop);

      const result = await handle.done;

      if (result.spawnError !== "") {
        throw new RunBlocked([describeSpawnError(result.spawnError, harness.command)]);
      }

      const exit = classifyExit({
        code: result.code,
        timedOut: result.timedOut,
        stopped: result.stopped,
        spawnFailed: false,
      });

      const meta = readMeta(current.language, await readWorkFile(dir, META_FILE));
      const limit = settings.maxOutputKb * 1024;
      const stdout = capOutput(result.stdout, limit);
      const stderr = capOutput(result.stderr, limit);

      // Allocate the id before the figures, because the figures are named
      // after it — that is what ties a picture in a note to a run record.
      const sequence = this.sequenceFor(started);
      const runFolder = normalizePath(this.ctx.runsFolder());
      const id = planObservedRun({
        run: draftFor({ options, current, source, scriptHash, started, actor, outcome: blankOutcome() }),
        sequence,
      }).id;

      const figures = await this.saveFigures(dir, runFolder, id);

      const outcome: RunOutcome = {
        exit,
        code: result.code,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: result.durationMs,
        figures,
        interpreter: interpreterLabel(current.language, meta),
        truncated: result.truncated || stdout.cut || stderr.cut,
      };

      const plan = planObservedRun({
        run: draftFor({ options, current, source, scriptHash, started, actor, outcome }),
        sequence,
      });

      // 1 — the ledger, before any write. §5.12: a run that writes into the
      // vault logs `code-run`, and ours always writes into the note.
      const entries: AuditEntry[] = [
        {
          ts: toVaultMinute(Date.now()),
          actor,
          action: "code-run",
          subject: file.basename,
          detail: plan.auditDetail,
        },
      ];
      await this.ctx.audit.append(entries);

      // 2 — the run record.
      const runFile = await this.writeRunRecord(runFolder, plan);

      // 3 — the note.
      const fresh = await this.ctx.app.vault.read(file);
      const located = locateBlock(fresh, current) ?? current;
      const rendered = renderOutputBlock({
        summary: outcomeSummary({ runId: plan.id, outcome, at: toVaultMinute(started) }),
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        truncated: outcome.truncated,
        figures: outcome.figures,
      });
      const inserted = insertOutput({
        text: fresh,
        block: located,
        rendered,
        runsFolder: runFolder,
      });
      await this.ctx.app.vault.modify(file, inserted.text);
      this.ctx.reindex(file);

      return { plan, outcome, runFile, replaced: inserted.replaced !== null };
    } finally {
      await removeWorkDir(dir);
    }
  }

  /**
   * Copy the harness's figures into the vault.
   *
   * Only files matching the name the harness itself generates are taken —
   * §7 F1's "output paths normalised and confined to the vault", done by
   * refusing anything we did not name rather than by normalising whatever
   * turned up. A block that wrote `figures/../../elsewhere.png` produces a
   * file this loop never sees.
   */
  private async saveFigures(dir: string, runFolder: string, id: string): Promise<string[]> {
    const names = (await listWorkFiles(dir, FIGURE_DIR)).filter(isHarnessFigure);
    if (names.length === 0) return [];

    await ensureFolder(this.ctx.app, runFolder);
    const saved: string[] = [];

    for (const [index, name] of names.entries()) {
      const bytes = await readWorkBinary(dir, FIGURE_DIR, name);
      const target = normalizePath(`${runFolder}/${id}-fig${index + 1}.png`);
      const existing = this.ctx.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        await this.ctx.app.vault.modifyBinary(existing, bytes);
      } else {
        await this.ctx.app.vault.createBinary(target, bytes);
      }
      saved.push(target);
    }

    return saved;
  }

  private async writeRunRecord(folder: string, plan: ObservedRunPlan): Promise<TFile> {
    await ensureFolder(this.ctx.app, folder);

    let path = normalizePath(`${folder}/${plan.id}.md`);
    for (let index = 2; this.ctx.app.vault.getAbstractFileByPath(path) !== null; index += 1) {
      path = normalizePath(`${folder}/${plan.id} ${index}.md`);
    }

    const file = await this.ctx.app.vault.create(path, plan.body);
    await this.ctx.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(plan.frontmatter)) frontmatter[key] = value;
    });
    this.ctx.reindex(file);
    return file;
  }

  /** Counted from the folder, not the index: a record written a moment ago may not be in it yet. */
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
}

function emptyReading(): ProbeReading {
  return { version: "", executable: "", packages: [] };
}

function blankOutcome(): RunOutcome {
  return {
    exit: "ok",
    code: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    figures: [],
    interpreter: "",
    truncated: false,
  };
}

function draftFor(input: {
  options: RunOptions;
  current: RunnableBlock;
  source: string;
  scriptHash: string;
  started: number;
  actor: string;
  outcome: RunOutcome;
}) {
  return {
    source: `[[${input.options.file.basename}]]`,
    block: blockLabel(input.current.language, input.current.ordinal),
    language: input.current.language,
    script: input.source,
    scriptHash: input.scriptHash,
    outcome: input.outcome,
    started: input.started,
    actor: input.actor,
    request: input.options.request,
    inputs: input.options.inputs,
    variables: input.options.variables,
  };
}

/**
 * A failed spawn, said in a way that names the fix.
 *
 * `ENOENT` from `spawn` means "there is nothing at that path" and nothing more
 * — it is not evidence that R or Python is missing from the machine, only that
 * the setting points somewhere empty. Saying "R is not installed" would send
 * somebody off to install a second copy of what they already have.
 */
export function describeSpawnError(message: string, command: string): string {
  if (message.includes("ENOENT")) {
    return `Nothing is at ${command}. Check the path in Settings → SCDB Cockpit → Running code — it points somewhere that does not exist.`;
  }
  if (message.includes("EACCES") || message.includes("EPERM")) {
    return `${command} is there but could not be started — permission was refused. On a managed laptop this is usually policy rather than the file.`;
  }
  return `The interpreter could not be started: ${message}`;
}

/** For the notice after a run. Rule 7: counts, never content. */
export function runNotice(report: RunReport): string {
  return `${report.plan.id} · ${outcomeDetail(report.plan.id, report.outcome)}`;
}
