import { describe, expect, it } from "vitest";

import { parseVariable, type VariableNote } from "../catalogue/variable";
import { findStudy, parseStudy, type StudyNote } from "../study/study";
import { assessGovernance, blockingOf, identifierHint } from "./governance";
import { parseField } from "./field";
import { parseFormSpec } from "./form";

function study(id: string, governance: Record<string, unknown> | undefined): StudyNote {
  return parseStudy({
    path: `20 Studies/${id}.md`,
    frontmatter: { type: "study", id, title: id, ...(governance === undefined ? {} : { governance }) },
  });
}

function variable(id: string, over: Record<string, unknown> = {}): VariableNote {
  return parseVariable(`87 Catalogue/${id}.md`, {
    type: "variable",
    id,
    label: id,
    data_type: "text",
    definition: "d",
    version: 1,
    ...over,
  });
}

function form(fields: unknown[], studyRef = "[[EuroHeart]]") {
  return parseFormSpec({
    path: "88 Forms/FORM-x.md",
    frontmatter: { id: "FORM-x", title: "A form", study: studyRef },
    block: { instruments: [{ name: "baseline", label: "Baseline", fields }] },
  });
}

const STUDIES = [
  study("EuroHeart", { identifiers: "indirect", irb_ref: "DSRB-2026-0142" }),
  study("NoIdentifiers", { identifiers: "none" }),
  study("Unstated", { irb_ref: "DSRB-2026-0999" }),
];

describe("the study note (§5.1 vocabulary, reused not reinvented)", () => {
  it("records no scope rather than defaulting to one", () => {
    expect(study("Unstated", { irb_ref: "x" }).approved).toBeNull();
    expect(study("Bare", undefined).approved).toBeNull();
  });

  it("refuses a scope outside §5.1's three values, and says so", () => {
    const odd = study("Odd", { identifiers: "some" });
    expect(odd.approved).toBeNull();
    expect(odd.problems.join(" ")).toMatch(/not one of none, indirect, direct/);
  });

  it("matches a study however the form spells the link", () => {
    for (const ref of ["[[EuroHeart]]", "[[20 Studies/EuroHeart]]", "EuroHeart", "[[EuroHeart|the registry]]"]) {
      expect(findStudy(ref, STUDIES)?.id).toBe("EuroHeart");
    }
    expect(findStudy("Nothing", STUDIES)).toBeNull();
  });
});

describe("identifiers against the approved scope (§7 D2)", () => {
  it("blocks an identifier on a study approved to collect none", () => {
    const report = assessGovernance({
      spec: form(
        [
          { name: "record_id", type: "text", label: "Record ID" },
          { name: "nric", type: "text", label: "NRIC", identifier: true, justification: "Linkage." },
        ],
        "[[NoIdentifiers]]",
      ),
      studies: STUDIES,
      variables: [],
    });
    expect(report.exportable).toBe(false);
    expect(blockingOf(report)).toHaveLength(1);
    expect(blockingOf(report)[0]?.message).toMatch(/approved to collect no identifiers at all/);
  });

  it("allows an identifier inside the approved scope when it is justified", () => {
    const report = assessGovernance({
      spec: form([
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "study_year", type: "text", label: "Year of enrolment", identifier: true, justification: "Cohort." },
      ]),
      studies: STUDIES,
      variables: [],
    });
    expect(report.findings).toEqual([]);
    expect(report.exportable).toBe(true);
  });

  it("flags an identifier nothing justifies, and names the variable that could have", () => {
    const report = assessGovernance({
      spec: form([
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "study_year", type: "text", label: "Year", identifier: true, variable: "VAR-YEAR" },
      ]),
      studies: STUDIES,
      variables: [variable("VAR-YEAR", { identifier: true })],
    });
    const finding = report.findings.find((f) => f.kind === "unjustified");
    expect(finding?.message).toMatch(/neither the field nor VAR-YEAR says why/);
  });

  it("accepts the catalogue's justification in place of the field's", () => {
    const report = assessGovernance({
      spec: form([
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "study_year", type: "text", label: "Year", identifier: true, variable: "VAR-YEAR" },
      ]),
      studies: STUDIES,
      variables: [variable("VAR-YEAR", { identifier: true, justification: "Needed to link admissions." })],
    });
    expect(report.findings).toEqual([]);
  });

  /** Silence is not approval — the same rule C3 applies to an undated run. */
  it("reports an unrecorded scope as uncheckable, never as a pass", () => {
    const unstated = assessGovernance({
      spec: form(
        [
          { name: "record_id", type: "text", label: "Record ID" },
          { name: "yr", type: "text", label: "Year", identifier: true, justification: "x" },
        ],
        "[[Unstated]]",
      ),
      studies: STUDIES,
      variables: [],
    });
    expect(unstated.findings.map((f) => f.kind)).toEqual(["unknown-scope"]);
    expect(unstated.findings[0]?.message).toMatch(/Not recorded is not the same as approved/);
    // Uncheckable does not block: it is a question to answer, not a refusal.
    expect(unstated.exportable).toBe(true);
  });

  it("distinguishes a form naming no study from one naming a study that is missing", () => {
    const none = assessGovernance({
      spec: form([{ name: "nric", type: "text", label: "NRIC", identifier: true, justification: "x" }], ""),
      studies: STUDIES,
      variables: [],
    });
    expect(none.findings[0]?.message).toMatch(/names no study/);

    const missing = assessGovernance({
      spec: form([{ name: "nric", type: "text", label: "NRIC", identifier: true, justification: "x" }], "[[Ghost]]"),
      studies: STUDIES,
      variables: [],
    });
    expect(missing.findings[0]?.message).toMatch(/the study "\[\[Ghost\]\]" was not found/);
  });
});

describe("the identifier nobody flagged", () => {
  it("recognises the shapes that matter, and says it is guessing", () => {
    const report = assessGovernance({
      spec: form([
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "nric", type: "text", label: "NRIC" },
        { name: "q7", type: "text", label: "Date of birth" },
      ]),
      studies: STUDIES,
      variables: [],
    });
    const flagged = report.findings.filter((f) => f.kind === "unflagged");
    expect(flagged.map((f) => f.field)).toEqual(["nric", "q7"]);
    expect(flagged[0]?.message).toMatch(/this is a guess from the name/);
  });

  it("does not fire on a word that merely contains one, so dobutamine is safe", () => {
    expect(identifierHint(parseField({ name: "dobutamine_dose", label: "Dobutamine dose" }, "f"))).toBe("");
    expect(identifierHint(parseField({ name: "dob", label: "" }, "f"))).toBe("a date of birth");
  });

  it("stays quiet when the catalogue already says the variable is an identifier", () => {
    // The mismatch finding covers this case; a second, weaker guess about the
    // same field would be noise on a row that is already flagged.
    const report = assessGovernance({
      spec: form([
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "nric", type: "text", label: "NRIC", variable: "VAR-NRIC" },
      ]),
      studies: STUDIES,
      variables: [variable("VAR-NRIC", { identifier: true, justification: "Linkage." })],
    });
    expect(report.findings.map((f) => f.kind)).toEqual(["mismatch"]);
  });
});

describe("the catalogue join (C2)", () => {
  it("reports a field and its variable disagreeing, without picking a winner", () => {
    const report = assessGovernance({
      spec: form([
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "mrn", type: "text", label: "Hospital number", identifier: true, justification: "x", variable: "VAR-MRN" },
      ]),
      studies: STUDIES,
      variables: [variable("VAR-MRN", { identifier: false })],
    });
    const mismatch = report.findings.find((f) => f.kind === "mismatch");
    expect(mismatch?.message).toMatch(/One of the two is wrong/);
    expect(report.exportable).toBe(true);
  });
});

describe("ordering", () => {
  it("puts the blocking finding first, whatever order the fields are in", () => {
    const report = assessGovernance({
      spec: form(
        [
          { name: "record_id", type: "text", label: "Record ID" },
          { name: "email", type: "text", label: "Email" },
          { name: "mrn", type: "text", label: "Hospital number", identifier: true },
        ],
        "[[NoIdentifiers]]",
      ),
      studies: STUDIES,
      variables: [],
    });
    expect(report.findings.map((f) => f.kind)).toEqual(["unapproved", "unflagged", "unjustified"]);
  });
});
