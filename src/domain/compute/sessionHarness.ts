/**
 * The two REPL harnesses (§7 F2).
 *
 * A sibling of `harness.ts` rather than an addition to it, because the two
 * answer different questions and share only their defences. F1's harness runs
 * one block and exits; this one starts, then waits, and every decision below
 * is about *staying alive*: an error must not end the session, a cell that
 * exits must not take the process with it, and nothing the harness does may
 * leave a trace in the environment the person is looking at.
 *
 * The hardening is F1's, unchanged and for the same reasons — `--vanilla`,
 * Python's isolation flags, a working directory outside the vault. A session
 * lives longer than a run, which makes the working directory question *more*
 * pressing rather than less: an `.Rprofile` would be read once and then be in
 * scope for an afternoon.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { RunLanguage } from "./block";
import { FIGURE_DIR, META_FILE, pythonFlags, type PythonIsolation } from "./harness";

export const SESSION_RUNNER_FILES: Record<RunLanguage, string> = {
  r: "session.R",
  python: "session.py",
};

export const ENV_FILE = "env.tsv";

/**
 * Figures the harness itself named, one series per cell.
 *
 * Same confinement-by-construction as F1: the host lists the directory and
 * takes only what matches, so a file the cell wrote itself is not a figure
 * however it is named. The cell number is in the name because a plot is worth
 * nothing without knowing which line drew it.
 */
export const SESSION_FIGURE_PATTERN = /^fig-(\d{4})-\d{3}\.png$/;

export function figureCell(name: string): string | null {
  return SESSION_FIGURE_PATTERN.exec(name)?.[1] ?? null;
}

/**
 * The Python session harness.
 *
 * **`sys.stdin` is swapped out while a cell runs.** This is the trap that would
 * have been found in production rather than here: the protocol arrives on
 * stdin, so a cell calling `input()` reads the *next* command line and the
 * session desynchronises silently — every later cell attributed to the wrong
 * code. Handing the cell a stream that refuses instead turns a corrupted
 * session into one clear error. Verified: `input('who?')` now raises where it
 * is called, and the next cell runs normally.
 *
 * **`SystemExit` is caught and the session stays open.** `exit()` is muscle
 * memory, and in a console it should not throw away every variable in the
 * environment. It is reported rather than silently swallowed, because a person
 * who wrote `sys.exit(1)` deserves to know it did not do what it says.
 *
 * The notebook display rule and the `finally` figure sweep are F1's, arrived
 * at the same way — see the notes in `harness.ts`; both were bugs first.
 */
const PYTHON_SESSION = `# scdb-cockpit session harness. Generated; not part of your code.
import ast, io, os, sys, traceback

_scdb_token = sys.argv[1]

for _scdb_stream in (sys.stdout, sys.stderr):
    try:
        _scdb_stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import matplotlib
    matplotlib.use("Agg")
except Exception:
    pass

try:
    with io.open("${META_FILE}", "w", encoding="utf-8") as _scdb_fh:
        _scdb_fh.write(sys.version.split()[0] + "\\n")
        _scdb_fh.write(sys.executable + "\\n")
except Exception:
    pass

_scdb_protocol_stdin = sys.stdin
_scdb_globals = {"__name__": "__main__"}

# Types that are plumbing rather than data. A console's environment pane is for
# what you are working on, and every import would otherwise sit in it.
_scdb_hidden = ("module",)


_scdb_asked_for_input = False


class _ScdbNoInput(io.TextIOBase):
    """Stands in for stdin while a cell runs, so a cell cannot eat the protocol.

    It reports end-of-file rather than raising. Raising from in here put this
    file, and the whole temporary path it lives at, into the middle of the
    traceback, so the one message a person needed was framed by a path that
    means nothing to them. At EOF, input() raises where it was called and the
    traceback holds their line and nothing else; the explanation is added
    afterwards, by the loop, which knows it was stdin that was asked for.
    """

    def _asked(self):
        global _scdb_asked_for_input
        _scdb_asked_for_input = True

    def readline(self, *args):
        self._asked()
        return ""

    def read(self, *args):
        self._asked()
        return ""

    def readable(self):
        return True


def _scdb_save_figures(cell):
    try:
        import matplotlib.pyplot as plt
    except Exception:
        return 0
    saved = 0
    try:
        os.makedirs("${FIGURE_DIR}", exist_ok=True)
        for _scdb_number in plt.get_fignums():
            saved += 1
            plt.figure(_scdb_number).savefig(
                os.path.join("${FIGURE_DIR}", "fig-%s-%03d.png" % (cell, saved)),
                dpi=144, bbox_inches="tight",
            )
        # Closed after saving, so the next cell starts with a clean sheet and a
        # figure is never saved twice under two names.
        plt.close("all")
    except Exception:
        pass
    return saved


def _scdb_clean(value):
    text = str(value).replace("\\t", " ").replace("\\r", " ").replace("\\n", " ")
    return text[:120]


def _scdb_write_env():
    rows = []
    for name in sorted(_scdb_globals):
        # Only dunders. The harness keeps its own names out of this dict
        # entirely, so there is nothing of ours to filter — and hiding every
        # leading underscore would hide a variable somebody meant to have.
        if name.startswith("__"):
            continue
        try:
            value = _scdb_globals[name]
            kind = type(value).__name__
            if kind in _scdb_hidden:
                continue
            shape = getattr(value, "shape", None)
            if shape is not None:
                size = "x".join(str(n) for n in shape)
            elif callable(value):
                size = ""
            else:
                try:
                    size = str(len(value))
                except Exception:
                    size = ""
            rows.append("\\t".join([name, kind, size, _scdb_clean(repr(value))]))
        except Exception:
            rows.append("\\t".join([name, "?", "", ""]))
    try:
        with io.open("${ENV_FILE}", "w", encoding="utf-8") as fh:
            fh.write("\\n".join(rows))
    except Exception:
        pass


while True:
    _scdb_line = _scdb_protocol_stdin.readline()
    if not _scdb_line:
        break
    _scdb_line = _scdb_line.strip()
    if not _scdb_line.startswith("SCDB-RUN "):
        continue
    _scdb_cell = _scdb_line[9:].strip()
    _scdb_name = "cell-%s.py" % _scdb_cell
    _scdb_status = 0
    _scdb_figures = 0
    _scdb_asked_for_input = False
    sys.stdin = _ScdbNoInput()
    try:
        _scdb_body = ast.parse(io.open(_scdb_name, encoding="utf-8").read(), _scdb_name).body
        _scdb_tail = _scdb_body[-1] if _scdb_body and isinstance(_scdb_body[-1], ast.Expr) else None
        _scdb_head = _scdb_body[:-1] if _scdb_tail is not None else _scdb_body
        if _scdb_head:
            exec(compile(ast.Module(body=_scdb_head, type_ignores=[]), _scdb_name, "exec"), _scdb_globals)
        if _scdb_tail is not None:
            exec(compile(ast.Interactive(body=[_scdb_tail]), _scdb_name, "single"), _scdb_globals)
    except SyntaxError:
        traceback.print_exc(limit=0)
        _scdb_status = 1
    except SystemExit as _scdb_exit:
        sys.stderr.write("exit(%s) — the console stays open; use Restart to clear the environment.\\n" % _scdb_exit.code)
    except BaseException as _scdb_error:
        # Drop this frame, so the traceback starts inside the cell.
        traceback.print_exception(type(_scdb_error), _scdb_error, _scdb_error.__traceback__.tb_next)
        _scdb_status = 1
    finally:
        sys.stdin = _scdb_protocol_stdin
        if _scdb_asked_for_input:
            sys.stderr.write("This console has no keyboard input — put the value in the code instead.\\n")
        _scdb_figures = _scdb_save_figures(_scdb_cell)
        _scdb_write_env()

    sys.stdout.write("<<SCDB %s END %s %d %d>>" % (_scdb_token, _scdb_cell, _scdb_status, _scdb_figures))
    sys.stdout.flush()
    sys.stderr.write("<<SCDB %s ERR %s>>" % (_scdb_token, _scdb_cell))
    sys.stderr.flush()
`;

/**
 * The R session harness.
 *
 * **Everything is inside one `local()`**, which is not tidiness — it is what
 * makes the environment pane true. R's `for` and `repeat` assign in the
 * enclosing environment, so a harness loop written at top level puts its own
 * counters into `globalenv()`, where they appear alongside the person's data
 * as though they had created them. The prototype leaked a variable called `f`
 * this way. Inside `local()` there is nothing to filter and nothing to leak,
 * and `ls(globalenv())` is exactly the person's own work.
 *
 * **Whether a cell drew anything is asked, not guessed.** R's `png` device
 * writes a complete, valid, blank image the moment it is opened, so a file
 * appearing proves nothing: every cell would report a figure, and the plot
 * pane would fill with white rectangles. With the display list enabled,
 * `recordPlot()` reports what was actually drawn on the current page, so a
 * cell that plotted nothing is known to have plotted nothing and its blank is
 * deleted.
 *
 * `q()` still ends the process. R offers no way to make it not, short of
 * shadowing it in the user's own environment — which would put a decoy `q` in
 * the environment pane and break the person's own `q` if they wanted one. The
 * host notices the exit and says the session ended; restarting is one click.
 *
 * **A cell that reads stdin has no defence here, and the host is what makes
 * that survivable.** Python's `sys.stdin` can be swapped out for the duration
 * of a cell; R has no equivalent, because `file("stdin")` opens the process's
 * descriptor afresh and there is nothing to substitute. Driven with two
 * commands in the pipe at once, `readLines(file("stdin"), n = 1)` was seen to
 * consume the *next* cell's command — a session that keeps running while
 * silently attributing every later result to the wrong code, which is the
 * worst outcome available.
 *
 * It cannot happen through `InterpreterSession` because that never writes
 * ahead: the next command goes down the pipe only once the previous cell's
 * markers have both arrived, so while a cell is running the pipe is empty and
 * there is nothing to steal. Such a cell blocks instead — visibly, with the
 * busy state showing and Stop available. That serialisation is therefore not
 * merely tidy scheduling; it is what stands between this and silent
 * misattribution, and there is a test that says so.
 */
const R_SESSION = `# scdb-cockpit session harness. Generated; not part of your code.
local({
  token <- commandArgs(trailingOnly = TRUE)[1]

  meta <- file("${META_FILE}", open = "w")
  writeLines(c(R.version.string, R.home()), meta)
  close(meta)

  clean <- function(x) substr(gsub("[\\t\\r\\n]", " ", x), 1, 120)

  writeEnv <- function() {
    rows <- character(0)
    for (nm in ls(globalenv())) {
      row <- tryCatch(
        {
          value <- get(nm, envir = globalenv())
          kind <- paste(class(value), collapse = "/")
          size <- if (!is.null(dim(value))) paste(dim(value), collapse = "x")
            else if (is.function(value)) "" else as.character(length(value))
          shown <- utils::capture.output(utils::str(value, max.level = 0, give.attr = FALSE))
          paste(nm, kind, size, clean(paste(shown, collapse = " ")), sep = "\\t")
        },
        error = function(e) paste(nm, "?", "", "", sep = "\\t")
      )
      rows <- c(rows, row)
    }
    con <- file("${ENV_FILE}", open = "w")
    writeLines(rows, con)
    close(con)
  }

  con <- file("stdin", open = "r")

  repeat {
    line <- readLines(con, n = 1L)
    if (length(line) == 0L) break
    line <- trimws(line)
    if (!startsWith(line, "SCDB-RUN ")) next
    cell <- trimws(substring(line, 10))
    status <- 0L

    dir.create("${FIGURE_DIR}", showWarnings = FALSE)
    grDevices::png(
      filename = file.path("${FIGURE_DIR}", paste0("fig-", cell, "-%03d.png")),
      width = 1200, height = 800, res = 144
    )
    try(grDevices::dev.control(displaylist = "enable"), silent = TRUE)

    exprs <- tryCatch(
      parse(paste0("cell-", cell, ".R"), keep.source = TRUE),
      error = function(e) {
        cat("Error: ", conditionMessage(e), "\\n", sep = "", file = stderr())
        NULL
      }
    )

    if (is.null(exprs)) {
      status <- 1L
    } else {
      refs <- attr(exprs, "srcref")
      for (i in seq_along(exprs)) {
        lineno <- if (is.null(refs)) NA_integer_ else utils::getSrcLocation(refs[[i]], "line")
        ok <- withCallingHandlers(
          tryCatch(
            {
              shown <- withVisible(eval(exprs[[i]], globalenv()))
              if (shown$visible) print(shown$value)
              TRUE
            },
            error = function(e) {
              where <- if (is.na(lineno)) "" else paste0(" on line ", lineno)
              cat("Error", where, ": ", conditionMessage(e), "\\n", sep = "", file = stderr())
              FALSE
            }
          ),
          warning = function(w) {
            where <- if (is.na(lineno)) "" else paste0(" on line ", lineno)
            cat("Warning", where, ": ", conditionMessage(w), "\\n", sep = "", file = stderr())
            invokeRestart("muffleWarning")
          }
        )
        # Stop at the first failure, the way a script would: the rest of the
        # cell would run against state the failed line never established.
        if (!ok) {
          status <- 1L
          break
        }
      }
    }

    drawn <- tryCatch(length(grDevices::recordPlot()[[1]]) > 0, error = function(e) FALSE)
    while (length(grDevices::dev.list()) > 0) {
      try(invisible(grDevices::dev.off()), silent = TRUE)
    }

    made <- 0L
    for (f in list.files("${FIGURE_DIR}", pattern = paste0("^fig-", cell, "-"), full.names = TRUE)) {
      if (drawn) made <- made + 1L else file.remove(f)
    }

    writeEnv()

    cat(sprintf("<<SCDB %s END %s %d %d>>", token, cell, status, made))
    flush(stdout())
    cat(sprintf("<<SCDB %s ERR %s>>", token, cell), file = stderr())
    flush(stderr())
  }
})
`;

export interface SessionPlan {
  command: string;
  args: string[];
  files: { name: string; text: string }[];
}

export function buildSessionHarness(input: {
  language: RunLanguage;
  interpreter: string;
  isolation: PythonIsolation;
  /** Hex, from the service. Appears only on the command line and in markers. */
  token: string;
}): SessionPlan {
  if (input.language === "python") {
    return {
      command: input.interpreter,
      args: [...pythonFlags(input.isolation), SESSION_RUNNER_FILES.python, input.token],
      files: [{ name: SESSION_RUNNER_FILES.python, text: PYTHON_SESSION }],
    };
  }
  return {
    command: input.interpreter,
    args: ["--vanilla", SESSION_RUNNER_FILES.r, input.token],
    files: [{ name: SESSION_RUNNER_FILES.r, text: R_SESSION }],
  };
}
