/**
 * What actually gets handed to an interpreter (§7 F1, "interpreter hardening
 * is not optional").
 *
 * **User code is never concatenated into the harness.** The block goes into its
 * own file and the runner reads it at run time. That is not tidiness: it means
 * there is no escaping problem to get wrong, the way `</script>` had to be
 * escaped for the app sandbox (§5.13). The runner text below is a constant per
 * language, with nothing interpolated into it at all.
 *
 * It also buys honest line numbers. A prologue pasted above the block would
 * shift every line in every traceback, so an error on line 3 of what you are
 * looking at would report line 47 of something you cannot see.
 *
 * **What the hardening is defending against**, in the spec's own words: R runs
 * `.Rprofile` from its working directory, so a file arriving in the vault from
 * a colleague's zip would execute on every run; Python's mirror of that is the
 * working directory landing on `sys.path`, where a `random.py` shadows the
 * standard library. Both are closed here — `--vanilla` for R, isolation flags
 * for Python — and the working directory is outside the vault regardless, so
 * neither has vault content to find in the first place.
 *
 * Pure module: no Obsidian, no Node. The service creates the directory, writes
 * these files and spawns the command with `shell: false`.
 */

import type { RunLanguage } from "./block";

/** File names inside the working directory. Constants, so nothing is quoted. */
export const BLOCK_FILES: Record<RunLanguage, string> = { r: "block.R", python: "block.py" };
export const RUNNER_FILES: Record<RunLanguage, string> = { r: "runner.R", python: "runner.py" };
export const FIGURE_DIR = "figures";
export const META_FILE = "meta.txt";

/**
 * Only a file the harness itself named is copied back into the vault.
 *
 * §7 F1 asks for output paths "normalised and confined to the vault". The
 * confinement here is by construction — we generate the names and accept
 * nothing else — which is stronger than normalising whatever turned up. A
 * block that writes `figures/../../elsewhere.png` produces a file this pattern
 * does not match, so it stays in the temporary directory and is discarded.
 */
export const FIGURE_PATTERN = /^fig-\d{3}\.png$/;

export function isHarnessFigure(name: string): boolean {
  return FIGURE_PATTERN.test(name);
}

/**
 * How much of the interpreter's own environment a Python run may see.
 *
 * `isolated` is what §7 F1 specifies and what ships by default. Running it on
 * this machine turned up the cost, which is worth stating rather than
 * discovering on the work laptop: `-I` implies `-s`, so a package installed
 * with `pip install --user` is invisible and every `import` of it fails with
 * `ModuleNotFoundError` — including matplotlib, i.e. including plots.
 *
 * `user-site` keeps the part of the hardening the spec actually argues for —
 * `-P` keeps the working directory off `sys.path`, `-E` ignores `PYTHONPATH` —
 * and gives up only the exclusion of the per-user site directory. A conda or
 * venv interpreter keeps its packages in its own `site-packages` and does not
 * need this; a bare system Python that was pip-installed into usually does.
 */
export const PYTHON_ISOLATION = ["isolated", "user-site"] as const;

export type PythonIsolation = (typeof PYTHON_ISOLATION)[number];

export function isPythonIsolation(value: unknown): value is PythonIsolation {
  return typeof value === "string" && (PYTHON_ISOLATION as readonly string[]).includes(value);
}

export const ISOLATION_LABELS: Record<PythonIsolation, string> = {
  isolated: "Isolated (-I) — ignores per-user packages",
  "user-site": "Allow per-user packages (-E -P)",
};

export function pythonFlags(isolation: PythonIsolation): string[] {
  // -B in both: a temporary working directory does not want __pycache__, and
  // a stale .pyc is one more thing that could differ between two runs.
  return isolation === "isolated" ? ["-I", "-B"] : ["-E", "-P", "-B"];
}

export interface HarnessFile {
  name: string;
  text: string;
}

export interface HarnessPlan {
  /** The interpreter, verbatim from settings. Never a shell string. */
  command: string;
  /** Separate tokens, in order. Nothing here is ever joined with spaces. */
  args: string[];
  /** Written into the working directory before the spawn. */
  files: HarnessFile[];
}

/**
 * The Python runner.
 *
 * **Only the last expression is displayed**, the way a notebook cell behaves.
 * The first version printed every top-level expression, like a REPL, and
 * running it showed why that is wrong: a block that draws a chart printed
 * `<Figure size 600x300 with 0 Axes>`, the histogram's return tuple and three
 * `Text(...)` objects — five lines of noise around two lines of output. R does
 * not have this problem because its plotting calls return invisibly; Python
 * has no such notion, so the notebook rule is the one that behaves.
 *
 * **The figure sweep runs in a `finally`, not at exit.** It was an `atexit`
 * handler, which looked equivalent and silently captured nothing: importing
 * `matplotlib.pyplot` registers an atexit handler of its own that closes every
 * figure, user code imports pyplot *after* our handler is registered, and
 * atexit runs LIFO — so matplotlib destroyed the figures first and our sweep
 * found an empty list. A `finally` runs before interpreter shutdown begins,
 * which sidesteps the ordering question entirely, and still fires when the
 * block raises. That is the run whose plots you most want.
 */
const PYTHON_RUNNER = `# scdb-cockpit run harness. Generated; not part of your code.
import ast, io, os, sys, traceback

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import matplotlib
    matplotlib.use("Agg")
except Exception:
    pass

try:
    with io.open("${META_FILE}", "w", encoding="utf-8") as _fh:
        _fh.write(sys.version.split()[0] + "\\n")
        _fh.write(sys.executable + "\\n")
except Exception:
    pass


def _scdb_figures():
    try:
        import matplotlib.pyplot as plt
    except Exception:
        return
    try:
        os.makedirs("${FIGURE_DIR}", exist_ok=True)
        for _index, _number in enumerate(plt.get_fignums(), start=1):
            _name = os.path.join("${FIGURE_DIR}", "fig-%03d.png" % _index)
            plt.figure(_number).savefig(_name, dpi=144, bbox_inches="tight")
    except Exception:
        pass


_scdb_source = io.open("${BLOCK_FILES.python}", encoding="utf-8").read()
_scdb_globals = {"__name__": "__main__", "__file__": "${BLOCK_FILES.python}"}
_scdb_status = 0

try:
    _scdb_body = ast.parse(_scdb_source, "${BLOCK_FILES.python}").body
except SyntaxError:
    traceback.print_exc()
    sys.exit(1)

# All but a trailing expression run as a module; a trailing expression is
# compiled in "single" mode so its value is displayed. One compile, the block's
# own line numbers, and a notebook's output rather than a REPL's.
_scdb_tail = _scdb_body[-1] if _scdb_body and isinstance(_scdb_body[-1], ast.Expr) else None
_scdb_head = _scdb_body[:-1] if _scdb_tail is not None else _scdb_body

try:
    if _scdb_head:
        exec(compile(ast.Module(body=_scdb_head, type_ignores=[]), "${BLOCK_FILES.python}", "exec"), _scdb_globals)
    if _scdb_tail is not None:
        exec(compile(ast.Interactive(body=[_scdb_tail]), "${BLOCK_FILES.python}", "single"), _scdb_globals)
except SystemExit as _scdb_exit:
    _scdb_status = _scdb_exit.code if isinstance(_scdb_exit.code, int) else 0
except BaseException as _scdb_error:
    # Drop this frame, so the traceback starts in the block itself.
    traceback.print_exception(type(_scdb_error), _scdb_error, _scdb_error.__traceback__.tb_next)
    _scdb_status = 1
finally:
    _scdb_figures()

sys.exit(_scdb_status)
`;

/**
 * The R runner.
 *
 * `--vanilla` is on the command line rather than in here because `.Rprofile`
 * is read *before* any of this would run — a startup file cannot be disabled
 * from inside the session it already started. Verified against a real
 * `.Rprofile` planted in the working directory: it does not execute.
 *
 * Expression by expression rather than `source()`, for the same reason the
 * Python runner walks the AST: it makes errors report the user's own line.
 * `source()` reports `Error in eval(ei, envir)`, which is a location inside R
 * rather than inside the block, and points nowhere useful.
 *
 * Warnings are reported through a *calling* handler with `muffleWarning`, not
 * `tryCatch`. `tryCatch` on a warning aborts the expression, which would turn
 * a cosmetic warning on line 2 into forty lines that silently never ran. The
 * calling handler prints and then resumes, which is what R itself does.
 *
 * It also keeps the harness out of the message. Left to R, a muffled-nothing
 * warning printed as `Warning in eval(.scdb_exprs[[.scdb_i]], globalenv())`,
 * naming a variable of ours in output a person is meant to read.
 */
const R_RUNNER = `# scdb-cockpit run harness. Generated; not part of your code.
local({
  con <- file("${META_FILE}", "w")
  writeLines(c(R.version.string, R.home()), con)
  close(con)
})

dir.create("${FIGURE_DIR}", showWarnings = FALSE)
grDevices::png(
  filename = file.path("${FIGURE_DIR}", "fig-%03d.png"),
  width = 1200, height = 800, res = 144
)

.scdb_status <- 0
.scdb_exprs <- tryCatch(
  parse("${BLOCK_FILES.r}", keep.source = TRUE),
  error = function(e) {
    message("Error: ", conditionMessage(e))
    NULL
  }
)

if (is.null(.scdb_exprs)) {
  .scdb_status <- 1
} else {
  .scdb_refs <- attr(.scdb_exprs, "srcref")
  for (.scdb_i in seq_along(.scdb_exprs)) {
    .scdb_line <- if (is.null(.scdb_refs)) NA_integer_ else
      utils::getSrcLocation(.scdb_refs[[.scdb_i]], "line")
    .scdb_ok <- withCallingHandlers(
      tryCatch(
        {
          .scdb_result <- withVisible(eval(.scdb_exprs[[.scdb_i]], globalenv()))
          if (.scdb_result$visible) print(.scdb_result$value)
          TRUE
        },
        error = function(e) {
          where <- if (is.na(.scdb_line)) "" else paste0(" on line ", .scdb_line)
          message("Error", where, ": ", conditionMessage(e))
          FALSE
        }
      ),
      warning = function(w) {
        where <- if (is.na(.scdb_line)) "" else paste0(" on line ", .scdb_line)
        message("Warning", where, ": ", conditionMessage(w))
        invokeRestart("muffleWarning")
      }
    )
    # Stop at the first failure, the way a script would. Carrying on would run
    # the rest of the block against state the failed line never established.
    if (!.scdb_ok) {
      .scdb_status <- 1
      break
    }
  }
}

# Closes our png device, so the figures are flushed even after a failure.
while (length(grDevices::dev.list()) > 0) {
  try(invisible(grDevices::dev.off()), silent = TRUE)
}

quit(save = "no", status = .scdb_status)
`;

export function buildHarness(input: {
  language: RunLanguage;
  /** The block, verbatim. Written to its own file; never interpolated. */
  source: string;
  interpreter: string;
  isolation: PythonIsolation;
}): HarnessPlan {
  const block: HarnessFile = { name: BLOCK_FILES[input.language], text: ensureNewline(input.source) };

  if (input.language === "python") {
    return {
      command: input.interpreter,
      args: [...pythonFlags(input.isolation), RUNNER_FILES.python],
      files: [{ name: RUNNER_FILES.python, text: PYTHON_RUNNER }, block],
    };
  }

  return {
    command: input.interpreter,
    // --vanilla is --no-save --no-restore --no-site-file --no-init-file
    // --no-environ: the whole family of startup files, .Rprofile included.
    args: ["--vanilla", RUNNER_FILES.r],
    files: [{ name: RUNNER_FILES.r, text: R_RUNNER }, block],
  };
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Asking an interpreter what it is, for the "test interpreter" button.
 *
 * The same isolation the runs will use, because the question worth answering
 * is not "is there a python here" but "does the python we would run find its
 * packages". Reporting a version from a laxer invocation than the real one
 * would be a green tick for a configuration that then fails.
 */
export function buildProbe(input: {
  language: RunLanguage;
  interpreter: string;
  isolation: PythonIsolation;
}): { command: string; args: string[] } {
  if (input.language === "python") {
    return {
      command: input.interpreter,
      args: [
        ...pythonFlags(input.isolation),
        "-c",
        [
          "import sys",
          "print(sys.version.split()[0])",
          "print(sys.executable)",
          "mods = []",
          "for name in ('matplotlib', 'pandas', 'numpy'):",
          "    try:",
          "        __import__(name)",
          "        mods.append(name)",
          "    except Exception:",
          "        pass",
          "print(','.join(mods))",
        ].join("\n"),
      ],
    };
  }

  return {
    command: input.interpreter,
    args: ["--vanilla", "-e", "cat(R.version.string, R.home(), sep = '\\n')"],
  };
}

/**
 * What the probe found, as the settings screen shows it.
 *
 * A version alone is not the useful answer. On this machine the default
 * isolation finds Python 3.14 and *no* matplotlib, because the packages are in
 * the per-user site directory that `-I` excludes — a run would have succeeded
 * at printing and failed at plotting, with nothing in the settings screen
 * hinting at why. So the probe reports the packages too.
 */
export interface ProbeReading {
  version: string;
  executable: string;
  packages: string[];
}

export function readProbe(language: RunLanguage, stdout: string): ProbeReading {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  if (language === "python") {
    return {
      version: lines[0] ?? "",
      executable: lines[1] ?? "",
      packages: (lines[2] ?? "").split(",").filter((name) => name !== ""),
    };
  }
  return { version: lines[0] ?? "", executable: lines[1] ?? "", packages: [] };
}

/** `Python 3.14.7 (C:\\Python314\\python.exe)` — §5.12's `interpreter:` field. */
export function interpreterLabel(language: RunLanguage, reading: ProbeReading): string {
  const name = language === "python" ? "Python" : "R";
  const version = reading.version === "" ? "unknown version" : reading.version;
  const head = version.toLowerCase().startsWith(name.toLowerCase()) ? version : `${name} ${version}`;
  return reading.executable === "" ? head : `${head} (${reading.executable})`;
}

/**
 * The version line the harness wrote, read back from the working directory.
 *
 * Preferred over the probe: it names the interpreter that *did* run, not one
 * asked a moment earlier. Same argument as `script_hash` naming the code that
 * actually ran rather than the code the note describes now (§5.12).
 */
export function readMeta(language: RunLanguage, text: string): ProbeReading {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return { version: lines[0] ?? "", executable: lines[1] ?? "", packages: [] };
}
