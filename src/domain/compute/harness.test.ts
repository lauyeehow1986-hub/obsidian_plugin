import { describe, expect, it } from "vitest";
import {
  BLOCK_FILES,
  buildHarness,
  buildProbe,
  interpreterLabel,
  isHarnessFigure,
  isPythonIsolation,
  pythonFlags,
  readMeta,
  readProbe,
} from "./harness";

describe("what is handed to the interpreter", () => {
  const source = "print('hello')\n";

  it("never puts the user's code in the command line", () => {
    const plan = buildHarness({
      language: "python",
      source,
      interpreter: "C:\\Python314\\python.exe",
      isolation: "isolated",
    });
    for (const arg of plan.args) expect(arg).not.toContain("print(");
  });

  // The whole point of the separate file: there is no escaping problem to get
  // wrong, because nothing is interpolated into the runner at all.
  it("never puts the user's code in the runner either", () => {
    const nasty = "x = '''\"\"\"`$(rm -rf /)'''\n";
    const plan = buildHarness({
      language: "python",
      source: nasty,
      interpreter: "python",
      isolation: "isolated",
    });
    const runner = plan.files.find((file) => file.name.startsWith("runner"));
    expect(runner?.text).not.toContain("rm -rf");
    const block = plan.files.find((file) => file.name === BLOCK_FILES.python);
    expect(block?.text).toBe(nasty);
  });

  it("passes arguments as separate tokens, never a command string", () => {
    const plan = buildHarness({
      language: "r",
      source: "1 + 1\n",
      interpreter: "C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe",
      isolation: "isolated",
    });
    expect(plan.command).toBe("C:\\Program Files\\R\\R-4.5.2\\bin\\Rscript.exe");
    for (const arg of plan.args) expect(arg).not.toContain(" ");
  });

  // Verified against a real .Rprofile planted in the working directory: with
  // --vanilla it does not execute.
  it("disables R's startup files", () => {
    const plan = buildHarness({ language: "r", source, interpreter: "Rscript", isolation: "isolated" });
    expect(plan.args[0]).toBe("--vanilla");
  });

  it("keeps the working directory off Python's import path", () => {
    expect(pythonFlags("isolated")).toContain("-I");
    expect(pythonFlags("user-site")).toContain("-P");
    expect(pythonFlags("user-site")).toContain("-E");
  });

  it("forces the Agg backend before any of the block runs", () => {
    const plan = buildHarness({ language: "python", source, interpreter: "python", isolation: "isolated" });
    const runner = plan.files.find((file) => file.name === "runner.py")?.text ?? "";
    expect(runner.indexOf('matplotlib.use("Agg")')).toBeLessThan(runner.indexOf("ast.parse"));
  });

  /**
   * Both of these pin a bug that a working version already had.
   *
   * The figure sweep was an `atexit` handler, which captured nothing: importing
   * `matplotlib.pyplot` registers an atexit handler that closes every figure,
   * user code imports pyplot after ours is registered, and atexit runs LIFO. A
   * `finally` has no ordering to get wrong and still runs when the block fails
   * — which is the run whose plots you most want.
   */
  it("sweeps figures in a finally, never at exit", () => {
    const plan = buildHarness({ language: "python", source, interpreter: "python", isolation: "isolated" });
    const runner = plan.files.find((file) => file.name === "runner.py")?.text ?? "";
    expect(runner).toContain("finally:\n    _scdb_figures()");
    expect(runner).not.toContain("atexit");
  });

  /**
   * Displaying *every* top-level expression, REPL-style, meant a block that
   * drew a chart printed `<Figure size …>`, the histogram's return tuple and
   * three `Text(...)` objects around two lines of real output. A notebook cell
   * displays the last expression only, and that is what behaves.
   */
  it("displays the last expression only, like a notebook cell", () => {
    const plan = buildHarness({ language: "python", source, interpreter: "python", isolation: "isolated" });
    const runner = plan.files.find((file) => file.name === "runner.py")?.text ?? "";
    expect(runner).toContain('ast.Module(body=_scdb_head, type_ignores=[])');
    expect(runner).toContain("ast.Interactive(body=[_scdb_tail])");
  });

  // R needs no equivalent: its plotting calls return invisibly, so printing
  // every visible top-level result is quiet there. Python has no such notion.
  it("lets R print every visible result, which is R's own behaviour", () => {
    const plan = buildHarness({ language: "r", source: "1", interpreter: "Rscript", isolation: "isolated" });
    const runner = plan.files.find((file) => file.name === "runner.R")?.text ?? "";
    expect(runner).toContain("withVisible");
    expect(runner).toContain("if (.scdb_result$visible) print(.scdb_result$value)");
  });

  /**
   * A warning must never abort the block.
   *
   * `tryCatch(warning = ...)` unwinds, so a cosmetic warning on line 2 would
   * leave forty lines that silently never ran. A *calling* handler that muffles
   * prints and resumes — R's own mechanism for this — and it keeps harness
   * variable names out of a message a person is meant to read.
   */
  it("reports R warnings without stopping the block", () => {
    const plan = buildHarness({ language: "r", source: "1", interpreter: "Rscript", isolation: "isolated" });
    const runner = plan.files.find((file) => file.name === "runner.R")?.text ?? "";
    expect(runner).toContain("withCallingHandlers");
    expect(runner).toContain('invokeRestart("muffleWarning")');
    expect(runner).not.toContain("tryCatch(\n  warning");
  });

  it("gives the block a trailing newline it may not have had", () => {
    const plan = buildHarness({
      language: "python",
      source: "print(1)",
      interpreter: "python",
      isolation: "isolated",
    });
    expect(plan.files.find((file) => file.name === BLOCK_FILES.python)?.text).toBe("print(1)\n");
  });
});

describe("what comes back into the vault", () => {
  it("accepts only the figure names the harness itself generates", () => {
    expect(isHarnessFigure("fig-001.png")).toBe(true);
    expect(isHarnessFigure("fig-042.png")).toBe(true);
  });

  // Confinement by construction rather than by normalising whatever turned up.
  it("refuses anything the block created itself", () => {
    expect(isHarnessFigure("../../elsewhere.png")).toBe(false);
    expect(isHarnessFigure("fig-001.png.exe")).toBe(false);
    expect(isHarnessFigure("payload.png")).toBe(false);
    expect(isHarnessFigure("fig-1.png")).toBe(false);
  });
});

describe("asking an interpreter what it is", () => {
  it("probes with the same isolation a real run would use", () => {
    const strict = buildProbe({ language: "python", interpreter: "python", isolation: "isolated" });
    expect(strict.args).toContain("-I");
    const loose = buildProbe({ language: "python", interpreter: "python", isolation: "user-site" });
    expect(loose.args).toContain("-P");
  });

  it("reads a Python probe into version, executable and packages", () => {
    const reading = readProbe("python", "3.14.7\nC:\\Python314\\python.exe\nnumpy,pandas\n");
    expect(reading).toEqual({
      version: "3.14.7",
      executable: "C:\\Python314\\python.exe",
      packages: ["numpy", "pandas"],
    });
  });

  it("reports no packages rather than an empty name", () => {
    expect(readProbe("python", "3.14.7\npython.exe\n\n").packages).toEqual([]);
  });

  it("reads an R probe, which reports no packages", () => {
    const reading = readProbe("r", "R version 4.5.2 (2025-10-31 ucrt)\nC:/PROGRA~1/R/R-45~1.2\n");
    expect(reading.version).toBe("R version 4.5.2 (2025-10-31 ucrt)");
    expect(reading.packages).toEqual([]);
  });

  it("labels an interpreter the way §5.12 wants it recorded", () => {
    expect(
      interpreterLabel("python", { version: "3.14.7", executable: "C:\\py\\python.exe", packages: [] }),
    ).toBe("Python 3.14.7 (C:\\py\\python.exe)");
  });

  // R already says "R version ..." — prefixing would give "R R version 4.5.2".
  it("does not repeat the language when the version already names it", () => {
    expect(
      interpreterLabel("r", { version: "R version 4.5.2 (2025-10-31 ucrt)", executable: "C:/R", packages: [] }),
    ).toBe("R version 4.5.2 (2025-10-31 ucrt) (C:/R)");
  });

  it("says the version is unknown rather than inventing one", () => {
    expect(interpreterLabel("python", { version: "", executable: "", packages: [] })).toBe(
      "Python unknown version",
    );
  });

  it("reads the version the harness itself wrote", () => {
    expect(readMeta("r", "R version 4.5.2 (2025-10-31 ucrt)\nC:/PROGRA~1/R\n").version).toBe(
      "R version 4.5.2 (2025-10-31 ucrt)",
    );
  });
});

describe("the isolation setting", () => {
  it("recognises only the two values", () => {
    expect(isPythonIsolation("isolated")).toBe(true);
    expect(isPythonIsolation("user-site")).toBe(true);
    expect(isPythonIsolation("none")).toBe(false);
    expect(isPythonIsolation(undefined)).toBe(false);
  });
});
