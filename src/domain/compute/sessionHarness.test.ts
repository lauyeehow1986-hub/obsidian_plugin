import { describe, expect, it } from "vitest";
import {
  buildSessionHarness,
  ENV_FILE,
  figureCell,
  SESSION_FIGURE_PATTERN,
  SESSION_RUNNER_FILES,
} from "./sessionHarness";

const TOKEN = "a1b2c3d4e5f60718";

function runner(language: "r" | "python", isolation: "isolated" | "user-site" = "isolated"): string {
  const plan = buildSessionHarness({ language, interpreter: "X", isolation, token: TOKEN });
  return plan.files.find((file) => file.name === SESSION_RUNNER_FILES[language])?.text ?? "";
}

describe("what is handed to a session", () => {
  it("passes the token as an argument, never inside the runner", () => {
    const plan = buildSessionHarness({
      language: "python",
      interpreter: "C:\\Python314\\python.exe",
      isolation: "isolated",
      token: TOKEN,
    });
    expect(plan.args.at(-1)).toBe(TOKEN);
    expect(runner("python")).not.toContain(TOKEN);
  });

  it("passes arguments as separate tokens, never a command string", () => {
    const plan = buildSessionHarness({
      language: "r",
      interpreter: "C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe",
      isolation: "isolated",
      token: TOKEN,
    });
    expect(plan.command).toBe("C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe");
    for (const arg of plan.args) expect(arg).not.toContain(" ");
  });

  // F1's hardening, unchanged. A session lives longer than a run, which makes
  // the startup-file question more pressing rather than less: an .Rprofile
  // would be read once and then be in scope for an afternoon.
  it("keeps R's startup files disabled", () => {
    const plan = buildSessionHarness({ language: "r", interpreter: "Rscript", isolation: "isolated", token: TOKEN });
    expect(plan.args[0]).toBe("--vanilla");
  });

  it("keeps Python's isolation flags, and honours the setting", () => {
    const strict = buildSessionHarness({ language: "python", interpreter: "py", isolation: "isolated", token: TOKEN });
    expect(strict.args).toContain("-I");
    const loose = buildSessionHarness({ language: "python", interpreter: "py", isolation: "user-site", token: TOKEN });
    expect(loose.args).toContain("-E");
    expect(loose.args).toContain("-P");
  });

  // There is no `source` parameter, and that is the point: unlike F1 there is
  // not even a block to keep out of the runner. A cell reaches the interpreter
  // as a file it opens itself, so nothing a person writes is ever interpolated
  // into anything.
  it("takes no user code at all", () => {
    const plan = buildSessionHarness({ language: "python", interpreter: "py", isolation: "isolated", token: TOKEN });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.name).toBe(SESSION_RUNNER_FILES.python);
  });
});

describe("the agreement with the parser", () => {
  /**
   * Markers carry no newlines of their own.
   *
   * The harness used to write one before each marker, and the parser took it
   * back off. That worked only when both arrived in the same chunk; when the
   * boundary fell between them a blank line appeared before the result. If
   * this ever goes back, `session.ts` starts lying about output again.
   */
  it("emits markers with nothing around them", () => {
    for (const language of ["r", "python"] as const) {
      const text = runner(language);
      expect(text).toContain("<<SCDB %s END %s %d %d>>");
      expect(text).toContain("<<SCDB %s ERR %s>>");
      expect(text).not.toContain("\\n<<SCDB");
      expect(text).not.toContain(">>\\n");
    }
  });

  it("marks both streams, so a traceback cannot land in the next cell", () => {
    expect(runner("python")).toContain("sys.stderr.write(\"<<SCDB");
    expect(runner("r")).toContain("file = stderr()");
  });

  it("writes the environment to a file rather than through the console", () => {
    for (const language of ["r", "python"] as const) {
      expect(runner(language)).toContain(ENV_FILE);
    }
  });
});

describe("staying alive", () => {
  /**
   * The protocol arrives on stdin, so a cell calling input() would read the
   * *next* command and every later result would be attributed to the wrong
   * code. Handing the cell a stream at end-of-file turns that into one clear
   * error at the line that asked.
   */
  it("takes Python's stdin away while a cell runs, and gives it back", () => {
    const text = runner("python");
    expect(text).toContain("sys.stdin = _ScdbNoInput()");
    expect(text).toContain("sys.stdin = _scdb_protocol_stdin");
    expect(text).toContain("This console has no keyboard input");
  });

  // exit() is muscle memory, and in a console it should not throw away every
  // variable in the environment. Reported rather than swallowed, because a
  // person who wrote sys.exit(1) deserves to know it did not do that.
  it("does not let exit() end a Python session", () => {
    expect(runner("python")).toContain("except SystemExit");
    expect(runner("python")).toContain("the console stays open");
  });

  it("does not let an error end either session", () => {
    expect(runner("python")).toContain("except BaseException");
    expect(runner("r")).toContain("withCallingHandlers");
    expect(runner("r")).toContain('invokeRestart("muffleWarning")');
  });
});

describe("the R harness leaves no trace in the environment", () => {
  /**
   * R's `for` and `repeat` assign in the enclosing environment, so a harness
   * loop written at top level puts its own counters into globalenv() — where
   * they sit in the environment pane as though the person had made them. The
   * prototype leaked a variable called `f` exactly this way. Inside one
   * `local()` there is nothing to filter and nothing to leak.
   */
  it("wraps everything in a single local()", () => {
    const text = runner("r");
    const body = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(body[0]).toBe("local({");
    expect(body.at(-1)).toBe("})");
  });

  it("lists globalenv() without needing to filter it", () => {
    expect(runner("r")).toContain("for (nm in ls(globalenv()))");
  });
});

describe("knowing whether a cell drew anything", () => {
  /**
   * R's png device writes a complete, valid, blank image the moment it opens,
   * so a file appearing proves nothing: every cell reported a figure and the
   * plot pane filled with white rectangles. With the display list enabled,
   * recordPlot() reports what was actually drawn.
   */
  it("asks R rather than counting files", () => {
    const text = runner("r");
    expect(text).toContain('grDevices::dev.control(displaylist = "enable")');
    expect(text).toContain("length(grDevices::recordPlot()[[1]]) > 0");
    expect(text).toContain("file.remove(f)");
  });

  // Saved and then closed, so the next cell starts on a clean sheet and no
  // figure is ever written twice under two names.
  it("closes Python's figures once they are saved", () => {
    const text = runner("python");
    expect(text.indexOf("savefig")).toBeLessThan(text.indexOf('plt.close("all")'));
  });
});

describe("which files come back as figures", () => {
  it("accepts only the names the harness itself generates", () => {
    expect(SESSION_FIGURE_PATTERN.test("fig-0003-001.png")).toBe(true);
    expect(figureCell("fig-0003-001.png")).toBe("0003");
  });

  // Confinement by construction: a file the cell wrote under its own name is
  // not a figure however it is spelled.
  it("refuses anything a cell made for itself", () => {
    for (const name of ["../../elsewhere.png", "fig-3-1.png", "payload.png", "fig-0003-001.png.exe"]) {
      expect(SESSION_FIGURE_PATTERN.test(name)).toBe(false);
      expect(figureCell(name)).toBeNull();
    }
  });
});
