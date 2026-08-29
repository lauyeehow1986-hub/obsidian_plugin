import { describe, expect, it } from "vitest";
import { languageLabel, normaliseHash, parseScriptDoc, scriptLabel, shortHash } from "./scriptDoc";

const HASH = "9f2c".padEnd(64, "0");

function doc(over: Record<string, unknown> = {}) {
  return parseScriptDoc("50 Scripts/SCRIPT-cohort.md", {
    type: "script-doc",
    id: "SCRIPT-cohort",
    title: "Readmission cohort build",
    purpose: "Builds the analysis cohort from the echo and admissions extracts.",
    language: "r",
    file: "50 Scripts/cohort-build.R",
    file_hash: `sha256:${HASH}`,
    inputs: [{ dataset: "SCDB-echo", version: "2026-Q2", changed: "2026-06-30" }],
    outputs: [{ kind: "table", path: "94 Runs/cohort.csv" }],
    variables: ["[[VAR-LVEF@2]]"],
    last_run: "2026-05-12",
    last_run_by: "yh",
    ...over,
  });
}

describe("normaliseHash", () => {
  it("accepts the prefixed and bare forms, and is case-insensitive", () => {
    expect(normaliseHash(`sha256:${HASH.toUpperCase()}`)).toBe(HASH);
    expect(normaliseHash(HASH)).toBe(HASH);
    expect(normaliseHash("sha-256=" + HASH)).toBe(HASH);
  });

  it("rejects anything that is not a full digest", () => {
    // A half-copied hash compares unequal to everything, which would surface
    // as "the code moved" on a script nobody has touched.
    expect(normaliseHash("sha256:9f2c…")).toBe("");
    expect(normaliseHash("9f2c")).toBe("");
    expect(normaliseHash(undefined)).toBe("");
  });

  it("shortens to what a human compares by eye", () => {
    expect(shortHash(HASH)).toBe("9f2c00000000");
    expect(shortHash("")).toBe("");
  });
});

describe("parseScriptDoc", () => {
  it("reads the fields §5.14 names", () => {
    const parsed = doc();
    expect(parsed.problems).toEqual([]);
    expect(parsed.fileHash).toBe(HASH);
    expect(parsed.inputs[0]).toMatchObject({ dataset: "SCDB-echo", version: "2026-Q2" });
    expect(parsed.inputs[0]?.changed).toBe(Date.parse("2026-06-30"));
    expect(parsed.outputs[0]).toMatchObject({ kind: "table", path: "94 Runs/cohort.csv" });
    expect(parsed.variables).toEqual(["[[VAR-LVEF@2]]"]);
    expect(parsed.lastRunBy).toBe("yh");
  });

  it("reads a bare string input, because a dataset with no version is a real state", () => {
    const parsed = doc({ inputs: ["SCDB-admissions"] });
    expect(parsed.inputs).toEqual([{ dataset: "SCDB-admissions", version: "", changed: null, note: "" }]);
    expect(parsed.problems).toEqual([]);
  });

  it("harvests `consumes` as well as `variables`, matching the catalogue's keys", () => {
    expect(doc({ consumes: ["[[VAR-CLASS]]"] }).variables).toEqual(["[[VAR-LVEF@2]]", "[[VAR-CLASS]]"]);
  });

  it("reports a missing purpose, the field that ages worst", () => {
    expect(doc({ purpose: undefined }).problems.join(" ")).toContain("what the script is for");
  });

  it("reports a missing file, because then the hash can never be checked", () => {
    expect(doc({ file: undefined }).problems.join(" ")).toContain("where the code is");
  });

  it("reports a hash that is not a digest rather than silently dropping it", () => {
    const parsed = doc({ file_hash: "sha256:9f2c…" });
    expect(parsed.fileHash).toBe("");
    expect(parsed.problems.join(" ")).toContain("not a sha256 digest");
  });

  it("reports an unreadable last_run instead of treating it as never run", () => {
    const parsed = doc({ last_run: "last Tuesday" });
    expect(parsed.lastRun).toBeNull();
    expect(parsed.problems.join(" ")).toContain("`last_run` is not a date");
  });

  it("reports an input with no dataset name", () => {
    expect(doc({ inputs: [{ version: "2026-Q2" }] }).problems.join(" ")).toContain("names no `dataset`");
  });

  it("reports an unknown language without coercing it", () => {
    const parsed = doc({ language: "julia" });
    expect(parsed.language).toBe("");
    expect(parsed.problems.join(" ")).toContain('Language "julia"');
  });
});

describe("labels", () => {
  it("names a script by id and title together when it has both", () => {
    expect(scriptLabel(doc())).toBe("SCRIPT-cohort — Readmission cohort build");
  });

  it("falls back to the filename when the note says nothing", () => {
    expect(scriptLabel(doc({ id: undefined, title: undefined }))).toBe("SCRIPT-cohort");
  });

  it("says a language is missing rather than showing an empty cell", () => {
    expect(languageLabel("")).toBe("No language set");
    expect(languageLabel("r")).toBe("R");
    expect(languageLabel("julia")).toBe("julia");
  });
});
