/**
 * A live interpreter, from start to wedge to restart (§7 F2).
 *
 * §7 F2 asks for a long-lived process, output attributed per execution, an
 * environment listing, a plot pane and a visible busy state — and is candid
 * that this is "where this kind of thing rots", asking for restart to be a
 * first-class action rather than a last resort. The shape of this class
 * follows from taking that seriously:
 *
 *  - **Readiness is confirmed, not assumed.** Starting sends one empty cell of
 *    the plugin's own and waits for its marker. A spawn that succeeded proves
 *    only that a file was executable; the round trip proves the harness parsed,
 *    the loop is reading, and both streams are flowing. When the interpreter
 *    is going to fail — a broken R install, a Python whose stdlib is missing —
 *    it fails here, with its own message, instead of on somebody's first cell.
 *
 *  - **One cell at a time, and never writing ahead.** Cells queue rather than
 *    interleave, and the next command reaches the pipe only after the previous
 *    cell's markers have both arrived. Two in flight would be two sets of
 *    output on one pipe with no honest way to attribute them — but the sharper
 *    reason is R. An R cell can read the process's stdin, and with a command
 *    already sitting in the pipe it consumes that command: the session runs on,
 *    quietly attributing every later result to the wrong code. Keeping the pipe
 *    empty while a cell runs leaves such a cell blocked instead, visibly, with
 *    Stop available. See the note in `sessionHarness.ts`.
 *
 *  - **A cell that never returns is not an error.** No timeout: `Sys.sleep(600)`
 *    is a legitimate thing to type into a console, and killing it at some
 *    arbitrary second would be the tool deciding it knows better. The UI shows
 *    elapsed time and offers Stop, which is the person deciding.
 *
 * **Nothing here writes to the vault, and that is §5.12's rule, not caution.**
 * "Exploratory console lines do *not*" log to the ledger — so console cells
 * write no run record, append no audit row, and land nothing in a note. What
 * that buys is a ledger a person can still read; what it costs is that the
 * console is not a route for getting results *out*. That is the right way
 * round: to keep something, put the code in a block and run it (F1), which
 * costs one action and produces a record naming the interpreter, the hash and
 * the data version.
 *
 * The honest limit of that promise: the interpreter is a process running as
 * you, and it can write anywhere you can. What is guaranteed is that *this
 * plugin* copies nothing out of a session. The defence against a cell that
 * writes somewhere it should not is the same as F1's and rule 12's — you read
 * the code before you run it.
 */

import { randomBytes } from "node:crypto";

import { LANGUAGE_LABELS, type RunLanguage } from "../domain/compute/block";
import {
  interpreterLabel,
  META_FILE,
  readMeta,
  FIGURE_DIR,
} from "../domain/compute/harness";
import {
  cellFile,
  cellId,
  parseEnvironment,
  runCommand,
  SessionParser,
  type EnvEntry,
  type SessionEvent,
  type StreamName,
} from "../domain/compute/session";
import {
  buildSessionHarness,
  ENV_FILE,
  figureCell,
  SESSION_FIGURE_PATTERN,
} from "../domain/compute/sessionHarness";
import {
  listWorkFiles,
  looksAbsolute,
  makeWorkDir,
  readWorkBinary,
  readWorkFile,
  removeWorkDir,
  spawnSession,
  writeWorkFile,
  type SessionProcess,
} from "./interpreter";
import { describeSpawnError, type ComputeSettings } from "./computeRunner";

export type SessionState = "stopped" | "starting" | "ready" | "busy" | "failed";

export const SESSION_STATE_LABELS: Record<SessionState, string> = {
  stopped: "Not running",
  starting: "Starting…",
  ready: "Ready",
  busy: "Running",
  failed: "Stopped with an error",
};

export interface SessionFigure {
  /** `fig-0003-001.png` — the cell that drew it is in the name. */
  name: string;
  cell: string;
  bytes: ArrayBuffer;
}

export interface CellResult {
  cell: string;
  /** The harness's status for the cell: 0 ran, non-zero raised. */
  status: number;
  durationMs: number;
  figures: SessionFigure[];
  /** True when the process ended before the cell reported. */
  interrupted: boolean;
}

export interface SessionListener {
  onState: (state: SessionState, detail: string) => void;
  onText: (stream: StreamName, text: string) => void;
  onCell: (result: CellResult) => void;
  onEnvironment: (rows: EnvEntry[]) => void;
}

interface PendingCell {
  cell: string;
  started: number;
  sawEnd: boolean;
  status: number;
  figures: number;
  sawErrEnd: boolean;
  internal: boolean;
  settle: (result: CellResult) => void;
}

/** 16 hex characters — the shape `SessionParser` insists on. */
function makeToken(): string {
  return randomBytes(8).toString("hex");
}

export class InterpreterSession {
  private process: SessionProcess | null = null;
  private parser: SessionParser | null = null;
  private dir = "";
  private sequence = 0;
  private pending: PendingCell | null = null;
  private readonly queue: { source: string; settle: (result: CellResult) => void }[] = [];
  private state: SessionState = "stopped";
  private seenFigures = new Set<string>();
  /**
   * Which session a callback belongs to.
   *
   * Restart is two processes overlapping: the old one is still dying while the
   * new one is starting. Without this, the old one's exit handler runs against
   * the new one's fields — and since it tidies up the working directory, it
   * would delete the directory the new session had just been given. Each
   * process carries the generation it was started in and its own directory, so
   * a late callback tidies its own and touches nothing else.
   */
  private generation = 0;

  /** How the interpreter identified itself, once it has. §5.12's wording. */
  interpreter = "";

  constructor(
    readonly language: RunLanguage,
    private readonly settings: () => ComputeSettings,
    private readonly listener: SessionListener,
  ) {}

  current(): SessionState {
    return this.state;
  }

  interpreterPath(): string {
    const compute = this.settings();
    return (this.language === "r" ? compute.rPath : compute.pythonPath).trim();
  }

  /** Why this session cannot start, in the words the settings screen uses. */
  blockers(): string[] {
    const path = this.interpreterPath();
    const name = LANGUAGE_LABELS[this.language];
    if (path === "") {
      return [
        `No ${name} interpreter is configured. Settings → SCDB Cockpit → Running code, then point at the ${this.language === "r" ? "Rscript executable" : "python executable"}.`,
      ];
    }
    if (!looksAbsolute(path)) {
      return [
        `The ${name} interpreter is set to "${path}", which is not a full path. Give the whole path to the executable.`,
      ];
    }
    return [];
  }

  async start(): Promise<boolean> {
    if (this.state === "starting" || this.state === "ready" || this.state === "busy") return true;

    const blockers = this.blockers();
    if (blockers.length > 0) {
      this.setState("failed", blockers.join(" "));
      return false;
    }

    this.setState("starting", "");
    this.seenFigures = new Set<string>();
    this.sequence = 0;

    const token = makeToken();
    const plan = buildSessionHarness({
      language: this.language,
      interpreter: this.interpreterPath(),
      isolation: this.settings().pythonIsolation,
      token,
    });

    const generation = (this.generation += 1);
    const dir = await makeWorkDir();
    this.dir = dir;
    for (const file of plan.files) await writeWorkFile(dir, file.name, file.text);

    this.parser = new SessionParser(token);
    this.process = spawnSession({
      command: plan.command,
      args: plan.args,
      cwd: dir,
      onStdout: (chunk) => this.consume(generation, "stdout", chunk),
      onStderr: (chunk) => this.consume(generation, "stderr", chunk),
      onExit: (code, error) => {
        // Its own directory, whether or not it is still the current session.
        void removeWorkDir(dir);
        if (generation === this.generation) this.onExit(code, error);
      },
    });

    // The readiness round trip. Its output is the plugin's own, so it is not
    // shown; only whether it came back matters.
    const probe = await this.send("", true);
    if (probe.interrupted) return false;

    this.interpreter = interpreterLabel(
      this.language,
      readMeta(this.language, await readWorkFile(dir, META_FILE)),
    );
    // Only if nothing has started running in the meantime. A cell queued while
    // the session was starting is sent the moment the probe returns, and
    // announcing "ready" over the top of it would show an idle console with a
    // cell running in it.
    if (this.pending === null) this.setState("ready", this.interpreter);
    return true;
  }

  /**
   * Run one cell.
   *
   * Resolves when the cell reports, or when the process ends without it — an
   * `interrupted` result rather than a rejection, because "you stopped it" is
   * an outcome to display, not an exception to handle.
   */
  async run(source: string): Promise<CellResult> {
    if (this.state === "stopped" || this.state === "failed") {
      const started = await this.start();
      if (!started) return interruptedResult(cellId(this.sequence));
    }
    if (this.pending !== null) {
      return await new Promise<CellResult>((settle) => this.queue.push({ source, settle }));
    }
    return await this.send(source, false);
  }

  /**
   * Ends the process.
   *
   * The cell in flight is settled here rather than left to the exit handler.
   * A restart starts a new session immediately, which replaces `pending` — so
   * an unsettled promise from the old one would never resolve and whatever was
   * awaiting it would wait for the rest of the session.
   */
  stop(detail = ""): void {
    const process = this.process;
    this.process = null;

    const pending = this.pending;
    this.pending = null;
    pending?.settle(interruptedResult(pending.cell));
    this.drainQueue();

    this.setState("stopped", detail);
    // The directory is removed by this process's own exit handler, once it has
    // actually let go of the files it has open in it.
    process?.kill();
  }

  /** §7 F2 asks for this to be one click, not a last resort. */
  async restart(): Promise<boolean> {
    this.stop("");
    this.interpreter = "";
    return await this.start();
  }

  private send(source: string, internal: boolean): Promise<CellResult> {
    this.sequence += 1;
    const cell = cellId(this.sequence);

    return new Promise<CellResult>((settle) => {
      this.pending = {
        cell,
        started: Date.now(),
        sawEnd: false,
        status: 0,
        figures: 0,
        sawErrEnd: false,
        internal,
        settle,
      };
      if (!internal) this.setState("busy", "");

      void (async () => {
        try {
          await writeWorkFile(this.dir, cellFile(this.language, cell), ensureNewline(source));
          this.process?.write(runCommand(cell));
        } catch (error) {
          this.onExit(null, error instanceof Error ? error.message : String(error));
        }
      })();
    });
  }

  private consume(generation: number, stream: StreamName, chunk: string): void {
    const parser = this.parser;
    // Output from a session that has been replaced belongs to nobody: showing
    // it would put a dead session's last words into a live console.
    if (parser === null || generation !== this.generation) return;
    for (const event of parser.push(stream, chunk)) this.dispatch(event);
  }

  private dispatch(event: SessionEvent): void {
    const pending = this.pending;

    if (event.kind === "text") {
      // Suppressed only for the readiness round trip, which is ours. Anything
      // arriving with no cell in flight is still shown — an interpreter that
      // complains on startup is exactly what a person needs to see.
      if (pending?.internal === true) return;
      this.listener.onText(event.stream, event.text);
      return;
    }

    if (pending === null) return;

    if (event.kind === "end") {
      if (event.cell !== pending.cell) return;
      pending.sawEnd = true;
      pending.status = event.status;
      pending.figures = event.figures;
    } else {
      if (event.cell !== pending.cell) return;
      pending.sawErrEnd = true;
    }

    // Both streams, or the error still in flight lands in the next cell.
    if (pending.sawEnd && pending.sawErrEnd) void this.finish(pending);
  }

  private async finish(pending: PendingCell): Promise<void> {
    this.pending = null;

    const figures = pending.figures > 0 ? await this.collectFigures(pending.cell) : [];
    const result: CellResult = {
      cell: pending.cell,
      status: pending.status,
      durationMs: Date.now() - pending.started,
      figures,
      interrupted: false,
    };

    if (!pending.internal) {
      this.listener.onCell(result);
      this.listener.onEnvironment(parseEnvironment(await readWorkFile(this.dir, ENV_FILE)));
      this.setState("ready", this.interpreter);
    }
    pending.settle(result);

    const next = this.queue.shift();
    if (next !== undefined) {
      void this.send(next.source, false).then(next.settle);
    }
  }

  /**
   * The figures this cell drew.
   *
   * Listed and filtered rather than trusted: only names matching the pattern
   * the harness itself generates are read, and only for this cell. A file the
   * cell wrote into the same directory under its own name is not a figure, and
   * is left where it is to be discarded with the working directory.
   */
  private async collectFigures(cell: string): Promise<SessionFigure[]> {
    const figures: SessionFigure[] = [];
    for (const name of await listWorkFiles(this.dir, FIGURE_DIR)) {
      if (!SESSION_FIGURE_PATTERN.test(name)) continue;
      if (figureCell(name) !== cell) continue;
      if (this.seenFigures.has(name)) continue;
      this.seenFigures.add(name);
      try {
        figures.push({ name, cell, bytes: await readWorkBinary(this.dir, FIGURE_DIR, name) });
      } catch {
        /* a figure we cannot read is one we do not show */
      }
    }
    return figures;
  }

  private onExit(code: number | null, error: string): void {
    this.process = null;
    if (this.parser !== null) {
      for (const stream of ["stdout", "stderr"] as StreamName[]) {
        for (const event of this.parser.flush(stream)) this.dispatch(event);
      }
    }

    const pending = this.pending;
    this.pending = null;
    pending?.settle(interruptedResult(pending.cell));
    this.drainQueue();

    if (error !== "") {
      this.setState("failed", describeSpawnError(error, this.interpreterPath()));
    } else if (this.state === "stopped") {
      // Already reported by whoever pressed Stop.
    } else {
      this.setState(
        code === 0 ? "stopped" : "failed",
        code === 0
          ? "The interpreter exited — q() or exit() ends the process. Restart to start a new one."
          : `The interpreter exited with status ${String(code)}. Restart to start a new one.`,
      );
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      this.queue.shift()?.settle(interruptedResult(cellId(this.sequence)));
    }
  }

  private setState(state: SessionState, detail: string): void {
    this.state = state;
    this.listener.onState(state, detail);
  }
}

function interruptedResult(cell: string): CellResult {
  return { cell, status: 1, durationMs: 0, figures: [], interrupted: true };
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
