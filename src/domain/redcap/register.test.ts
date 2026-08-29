import { describe, expect, it } from "vitest";

import { parseStudy, type StudyNote } from "../study/study";
import { parseFormSpec } from "./form";
import { buildRegister, searchForms } from "./register";

const STUDIES: StudyNote[] = [
  parseStudy({
    path: "20 Studies/EuroHeart.md",
    frontmatter: { type: "study", id: "EuroHeart", governance: { identifiers: "indirect" } },
  }),
  parseStudy({
    path: "20 Studies/NoIdentifiers.md",
    frontmatter: { type: "study", id: "NoIdentifiers", governance: { identifiers: "none" } },
  }),
];

const RECORD_ID = { name: "record_id", type: "text", label: "Record ID" };

function form(id: string, fields: unknown[], study = "[[EuroHeart]]") {
  return parseFormSpec({
    path: `88 Forms/${id}.md`,
    frontmatter: { id, title: id, study },
    block: { instruments: [{ name: "baseline", label: "Baseline", fields }] },
  });
}

const READY = form("FORM-ready", [RECORD_ID, { name: "age", type: "text", label: "Age" }]);
const INVALID = form("FORM-invalid", [RECORD_ID, { name: "Bad Name", type: "text", label: "x" }]);
const BLOCKED = form(
  "FORM-blocked",
  [RECORD_ID, { name: "mrn", type: "text", label: "Hospital number", identifier: true, justification: "x" }],
  "[[NoIdentifiers]]",
);
const QUESTIONS = form("FORM-questions", [RECORD_ID, { name: "email", type: "text", label: "Email" }]);

describe("the forms register (§7 D2)", () => {
  const register = buildRegister({ specs: [READY, INVALID, BLOCKED, QUESTIONS], studies: STUDIES, variables: [] });

  /**
   * Governance outranks formatting. A malformed field name is fixed in a
   * minute; an unapproved identifier is a decision, and burying it under
   * validation noise is how it gets made by accident.
   */
  it("groups worst first, with governance ahead of validation", () => {
    expect(register.groups.map((group) => group.verdict)).toEqual([
      "blocked",
      "invalid",
      "questions",
      "ready",
    ]);
  });

  it("counts what the header has to say", () => {
    expect(register.summary.total).toBe(4);
    expect(register.summary.blocked).toBe(1);
    expect(register.summary.invalid).toBe(1);
    expect(register.summary.ready).toBe(1);
    expect(register.summary.identifiers).toBe(1);
  });

  it("only calls a form exportable when both halves pass", () => {
    const byId = new Map(register.forms.map((form) => [form.spec.id, form]));
    expect(byId.get("FORM-ready")?.exportable).toBe(true);
    expect(byId.get("FORM-questions")?.exportable).toBe(true);
    expect(byId.get("FORM-invalid")?.exportable).toBe(false);
    expect(byId.get("FORM-blocked")?.exportable).toBe(false);
  });

  it("counts forms whose identifiers cannot be checked against anything", () => {
    const orphan = buildRegister({
      specs: [form("FORM-orphan", [RECORD_ID, { name: "mrn", type: "text", label: "MRN", identifier: true }], "")],
      studies: STUDIES,
      variables: [],
    });
    expect(orphan.summary.uncheckable).toBe(1);
  });

  it("searches field names and labels, not just the note's title", () => {
    expect(searchForms(register.forms, "email").map((form) => form.spec.id)).toEqual(["FORM-questions"]);
    expect(searchForms(register.forms, "").length).toBe(4);
  });
});
