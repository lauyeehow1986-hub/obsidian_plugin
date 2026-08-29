/**
 * Starting an interpreter, and being able to stop it (§7 F1).
 *
 * The second of two places in this plugin that reach outside the vault. The
 * first is `services/backup.ts`, which rule 8 names as the documented exception
 * for writing an encrypted snapshot; this is the exception for *executing*, and
 * it exists for the same reason — the feature cannot be done any other way.
 *
 * What is outside the vault here, and why each one has to be:
 *
 *  - **The interpreter** is wherever it is installed. A portable R build or a
 *    miniconda environment is not vault content and never will be.
 *  - **The working directory** is a fresh temporary directory, deliberately
 *    *not* in the vault. §7 F1's threat is a file arriving in the vault that
 *    the interpreter reads on startup — an `.Rprofile` from a colleague's zip.
 *    Running somewhere else means there is nothing of the kind to find. It also
 *    means a block that writes a file writes it there, where it is discarded,
 *    rather than into notes nobody asked it to touch.
 *
 * Everything that comes *back* into the vault goes through Obsidian's vault
 * API, and only files this plugin named (see `isHarnessFigure`).
 *
 * **`shell: false` with array arguments, never a command string.** A path with
 * a space in it — `C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe`, which is
 * where R actually installs — is a command injection waiting to happen the
 * moment it is concatenated. Passed as an array element it is one argument, no
 * matter what is in it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SpawnRequest {
  command: string;
  args: string[];
  /** Absolute path. Created by the caller; never inside the vault. */
  cwd: string;
  timeoutMs: number;
  /** Per stream. Reading stops once past this; the process is left to finish. */
  maxBytes: number;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stopped: boolean;
  /** Set when the command could not be started at all — a wrong path, usually. */
  spawnError: string;
  truncated: boolean;
}

/** A run in flight, so the UI has something to press Stop on. */
export interface RunHandle {
  /** Resolves when the process ends, however it ends. Never rejects. */
  done: Promise<SpawnResult>;
  /** Ends the process. Safe to call more than once, and after it has ended. */
  stop: () => void;
}

/**
 * Environment for a child.
 *
 * Passed through rather than scrubbed. A conda environment needs its `PATH`
 * and its own variables to find its DLLs, and an empty environment on Windows
 * fails in ways that read as "Python is broken". The variables that *would*
 * change how code is found — `PYTHONPATH`, `R_PROFILE`, `.Renviron` — are
 * neutralised by the interpreter flags instead, which is where that job
 * belongs and where it is verifiable.
 */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function runProcess(request: SpawnRequest): RunHandle {
  const started = Date.now();

  let child: ChildProcessWithoutNullStreams | null = null;
  let settle: (result: SpawnResult) => void = () => {};
  const done = new Promise<SpawnResult>((resolve) => {
    settle = resolve;
  });

  let finished = false;
  let timedOut = false;
  let stopped = false;
  let truncated = false;
  const chunks: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  const sizes: Record<"stdout" | "stderr", number> = { stdout: 0, stderr: 0 };

  const finish = (code: number | null, spawnError: string): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    settle({
      code,
      stdout: chunks.stdout.join(""),
      stderr: chunks.stderr.join(""),
      durationMs: Date.now() - started,
      timedOut,
      stopped,
      spawnError,
      truncated,
    });
  };

  const kill = (): void => {
    if (child === null || child.killed) return;
    child.kill();
    // A second, harder attempt for a process ignoring the first. On Windows
    // both land on TerminateProcess, so this is belt and braces rather than
    // an escalation — and a wedged interpreter must never need a restart of
    // Obsidian to clear (§7 F2 makes the same promise for its session).
    setTimeout(() => {
      if (!finished && child !== null) child.kill("SIGKILL");
    }, 2000);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, Math.max(1000, request.timeoutMs));

  const collect = (stream: "stdout" | "stderr") => (data: Buffer | string) => {
    if (sizes[stream] >= request.maxBytes) {
      truncated = true;
      return;
    }
    const text = typeof data === "string" ? data : data.toString("utf8");
    sizes[stream] += text.length;
    if (sizes[stream] > request.maxBytes) {
      truncated = true;
      chunks[stream].push(text.slice(0, text.length - (sizes[stream] - request.maxBytes)));
      return;
    }
    chunks[stream].push(text);
  };

  try {
    child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: childEnv(),
      // Never true. See the note at the top of this file.
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    finish(null, error instanceof Error ? error.message : String(error));
    return { done, stop: () => {} };
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));

  child.on("error", (error: Error) => {
    finish(null, error.message);
  });
  child.on("close", (code: number | null) => {
    finish(code, "");
  });

  return {
    done,
    stop: () => {
      stopped = true;
      kill();
    },
  };
}

/**
 * A working directory for one run, outside the vault.
 *
 * Under the OS temp directory, in a folder of our own so a person can find and
 * clear them. One per run: two runs sharing a directory would share a
 * `block.py`, and the second would silently execute the first one's code.
 */
export async function makeWorkDir(): Promise<string> {
  const base = path.join(os.tmpdir(), "scdb-cockpit-runs");
  await fs.mkdir(base, { recursive: true });
  return await fs.mkdtemp(path.join(base, "run-"));
}

export async function writeWorkFile(dir: string, name: string, text: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), text, "utf8");
}

export async function readWorkFile(dir: string, name: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dir, name), "utf8");
  } catch {
    return "";
  }
}

/** Names of the files a run left in a subdirectory. Missing reads as empty. */
export async function listWorkFiles(dir: string, sub: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(dir, sub));
    return names.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function readWorkBinary(dir: string, sub: string, name: string): Promise<ArrayBuffer> {
  const buffer = await fs.readFile(path.join(dir, sub, name));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/**
 * Remove a working directory once its outputs are safely in the vault.
 *
 * Failure is ignored on purpose. A leftover temporary directory is untidy; an
 * error notice about one, after a run that otherwise succeeded, is noise that
 * teaches people to dismiss notices.
 */
export async function removeWorkDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Whether a path looks like something we can run, before trying to run it.
 *
 * Only a shape check — existence is the spawn's business, and a check that
 * passed a moment ago proves nothing about the moment after. What it catches
 * is the mistake people actually make: pasting `python` or `Rscript`, which
 * would work here and then not work on the target machine, where neither is on
 * `PATH`. §7 F1 is explicit that discovery never assumes `PATH`.
 */
export function looksAbsolute(candidate: string): boolean {
  const value = candidate.trim();
  if (value === "") return false;
  return path.isAbsolute(value);
}
