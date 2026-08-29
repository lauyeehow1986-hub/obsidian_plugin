import { describe, expect, it } from "vitest";

import { checkBalance, checkLogic, parseRefs } from "./branching";
import { parseChoices, parseField, readFlag } from "./field";
import { parseFormSpec, toFormName } from "./form";
import { errorsOf, logicContext, validateForm, warningsOf, type Finding } from "./validate";

function spec(block: unknown, frontmatter: Record<string, unknown> = {}) {
  return parseFormSpec({
    path: "88 Forms/FORM-x.md",
    frontmatter: { id: "FORM-x", title: "A form", ...frontmatter },
    block,
  });
}

/** Findings by code, so a test pins a rule and not its wording. */
function codes(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.code);
}

const RECORD_ID = { name: "record_id", type: "text", label: "Record ID" };

describe("choice lists (§7 D2)", () => {
  it("splits on the first comma only, so a label may contain one", () => {
    expect(parseChoices("1, Yes, with complications | 2, No").choices).toEqual([
      { code: "1", label: "Yes, with complications" },
      { code: "2", label: "No" },
    ]);
  });

  it("reports a choice with no code rather than inventing one", () => {
    const parsed = parseChoices("1, Yes | No");
    expect(parsed.choices).toHaveLength(1);
    expect(parsed.problems.join(" ")).toMatch(/no code before a comma/);
  });

  it("reads a flag written any of the ways a person writes one", () => {
    expect(readFlag("y")).toBe(true);
    expect(readFlag("TRUE")).toBe(true);
    expect(readFlag("")).toBeNull();
    expect(readFlag("maybe")).toBeNull();
    expect(readFlag("n")).toBe(false);
  });
});

describe("field names", () => {
  it("refuses a name REDCap will not accept", () => {
    const findings = validateForm(spec({ fields: [RECORD_ID, { name: "Date Of Visit", type: "text" }] }));
    expect(codes(findings)).toContain("name-shape");
  });

  it("refuses a duplicate across instruments, because the namespace is the project", () => {
    const findings = validateForm(
      spec({
        instruments: [
          { name: "baseline", fields: [RECORD_ID, { name: "age", type: "text", label: "Age" }] },
          { name: "followup", fields: [{ name: "age", type: "text", label: "Age" }] },
        ],
      }),
    );
    const duplicate = findings.find((finding) => finding.code === "name-duplicate");
    expect(duplicate?.message).toMatch(/already used on baseline/);
  });

  it("refuses a reserved name and a `_complete` collision", () => {
    const findings = validateForm(
      spec({
        fields: [
          RECORD_ID,
          { name: "redcap_event_name", type: "text", label: "Event" },
          { name: "baseline_complete", type: "text", label: "Done" },
        ],
      }),
    );
    expect(codes(findings).filter((code) => code === "name-reserved")).toHaveLength(2);
  });

  it("refuses a name past REDCap's length limit, naming the risk", () => {
    const long = "a".repeat(30);
    const findings = validateForm(spec({ fields: [RECORD_ID, { name: long, type: "text", label: "x" }] }));
    expect(findings.find((f) => f.code === "name-length")?.message).toMatch(/truncation can collide/);
  });
});

describe("choices, types and bounds", () => {
  it("refuses a choice type with no choices, and warns about choices on a text box", () => {
    const findings = validateForm(
      spec({
        fields: [
          RECORD_ID,
          { name: "sex", type: "radio", label: "Sex" },
          { name: "notes", type: "text", label: "Notes", choices: "1, a | 2, b" },
        ],
      }),
    );
    expect(codes(errorsOf(findings))).toContain("choices-missing");
    expect(codes(warningsOf(findings))).toContain("choices-unused");
  });

  it("refuses a duplicate choice code", () => {
    const findings = validateForm(
      spec({ fields: [RECORD_ID, { name: "sex", type: "radio", choices: "1, F | 1, M", label: "Sex" }] }),
    );
    expect(findings.find((f) => f.code === "choice-duplicate")?.message).toMatch(/the code 1 2 times/);
  });

  it("refuses an inverted range, saying why it matters", () => {
    const findings = validateForm(
      spec({
        fields: [RECORD_ID, { name: "lvef", type: "text", validation: "number", min: "100", max: "0", label: "LVEF" }],
      }),
    );
    expect(findings.find((f) => f.code === "bound-inverted")?.message).toMatch(/nothing can be entered/);
  });

  it("refuses a bound that is not a number, and reads a date bound as a date", () => {
    const bad = validateForm(
      spec({ fields: [RECORD_ID, { name: "n", type: "text", validation: "integer", min: "banana", label: "N" }] }),
    );
    expect(bad.find((f) => f.code === "bound-unreadable")?.message).toMatch(/is not a number/);

    const dated = validateForm(
      spec({
        fields: [
          RECORD_ID,
          { name: "visit", type: "text", validation: "date_ymd", min: "2026-01-01", max: "2026-12-31", label: "Visit" },
        ],
      }),
    );
    expect(codes(dated)).not.toContain("bound-unreadable");
    expect(codes(dated)).not.toContain("bound-inverted");
  });

  it("warns when a range is set with no validation type to enforce it", () => {
    const findings = validateForm(spec({ fields: [RECORD_ID, { name: "n", type: "text", min: "0", label: "N" }] }));
    expect(codes(warningsOf(findings))).toContain("bound-without-validation");
  });

  it("refuses a calculated field with nothing to calculate", () => {
    const findings = validateForm(spec({ fields: [RECORD_ID, { name: "bmi", type: "calc", label: "BMI" }] }));
    expect(codes(findings)).toContain("calc-empty");
  });
});

describe("branching logic, checked against the fields it names", () => {
  it("pulls a checkbox code and an event prefix out of a reference", () => {
    expect(parseRefs("[sx(2)] = '1' and [baseline_arm_1][age] > 60")).toEqual([
      { field: "sx", code: "2", prefix: "", raw: "[sx(2)]" },
      { field: "age", code: "", prefix: "baseline_arm_1", raw: "[baseline_arm_1][age]" },
    ]);
  });

  it("reports an unclosed bracket and an unclosed quote", () => {
    expect(checkBalance("[age > 60").join(" ")).toMatch(/`\[` was never closed/);
    expect(checkBalance("[sex] = 'F").join(" ")).toMatch(/quote \('\) was opened and never closed/);
  });

  it("refuses logic naming a choice code the checkbox does not offer", () => {
    const findings = validateForm(
      spec({
        fields: [
          RECORD_ID,
          { name: "sx", type: "checkbox", choices: "1, Chest pain | 2, Dyspnoea", label: "Symptoms" },
          { name: "detail", type: "text", label: "Detail", branching: "[sx(3)] = '1'" },
        ],
      }),
    );
    expect(findings.find((f) => f.code === "branching-invalid")?.message).toMatch(/no choice coded 3/);
  });

  it("refuses a checkbox tested whole, and a non-checkbox tested by code", () => {
    const findings = validateForm(
      spec({
        fields: [
          RECORD_ID,
          { name: "sx", type: "checkbox", choices: "1, a | 2, b", label: "Symptoms" },
          { name: "sex", type: "radio", choices: "1, F | 2, M", label: "Sex" },
          { name: "a", type: "text", label: "A", branching: "[sx] = '1'" },
          { name: "b", type: "text", label: "B", branching: "[sex(1)] = '1'" },
        ],
      }),
    );
    const messages = findings.filter((f) => f.code === "branching-invalid").map((f) => f.message);
    expect(messages.join(" ")).toMatch(/one choice at a time/);
    expect(messages.join(" ")).toMatch(/is not a checkbox/);
  });

  it("refuses logic that depends on the field it is hiding", () => {
    const findings = validateForm(
      spec({ fields: [RECORD_ID, { name: "a", type: "text", label: "A", branching: "[a] = '1'" }] }),
    );
    expect(findings.find((f) => f.code === "branching-invalid")?.message).toMatch(/depends on this field itself/);
  });

  it("treats a field on another instrument as a warning, not an error", () => {
    const findings = validateForm(
      spec({ fields: [RECORD_ID, { name: "a", type: "text", label: "A", branching: "[elsewhere] = '1'" }] }),
    );
    expect(codes(errorsOf(findings))).not.toContain("branching-invalid");
    expect(findings.find((f) => f.code === "branching-external")?.message).toMatch(
      /this dictionary does not carry it/,
    );
  });

  it("leaves REDCap smart variables alone", () => {
    const context = logicContext(spec({ fields: [RECORD_ID] }));
    const check = checkLogic("[record-dag-name] = 'A'", "x", "Branching logic", context);
    expect(check.problems).toEqual([]);
    expect(check.unknown).toEqual([]);
  });
});

describe("the record identifier", () => {
  it("refuses a first field REDCap cannot key records on", () => {
    const findings = validateForm(
      spec({ fields: [{ name: "sex", type: "radio", choices: "1, F | 2, M", label: "Sex" }] }),
    );
    expect(findings.find((f) => f.code === "record-id-type")?.message).toMatch(
      /REDCap will make it the record identifier/,
    );
  });

  it("warns when every record would be keyed on identifiable data", () => {
    const findings = validateForm(
      spec({ fields: [{ name: "nric", type: "text", label: "NRIC", identifier: true }] }),
    );
    expect(codes(warningsOf(findings))).toContain("record-id-identifier");
  });

  it("refuses branching logic on the record identifier", () => {
    const findings = validateForm(
      spec({ fields: [{ ...RECORD_ID, branching: "[x] = '1'" }] }),
    );
    expect(codes(findings)).toContain("record-id-branching");
  });
});

describe("instruments", () => {
  it("refuses an instrument with no form name, because the dictionary groups by it", () => {
    const findings = validateForm(spec({ instruments: [{ fields: [RECORD_ID] }] }));
    expect(codes(findings)).toContain("form-name-missing");
  });

  it("derives a form name from a label and says it did", () => {
    expect(toFormName("Baseline visit — echo")).toBe("baseline_visit_echo");
    const form = spec({ instruments: [{ label: "Baseline visit", fields: [RECORD_ID] }] });
    expect(form.instruments[0]?.name).toBe("baseline_visit");
    expect(form.problems.join(" ")).toMatch(/"baseline_visit" was derived from its label/);
  });

  it("refuses two instruments with the same form name", () => {
    const findings = validateForm(
      spec({
        instruments: [
          { name: "baseline", fields: [RECORD_ID] },
          { name: "baseline", fields: [{ name: "age", type: "text", label: "Age" }] },
        ],
      }),
    );
    expect(codes(findings)).toContain("form-name-duplicate");
  });

  it("reports a form with nothing in it rather than exporting an empty file", () => {
    expect(codes(validateForm(spec({})))).toContain("no-instruments");
  });

  it("passes a well-formed instrument with no findings at all", () => {
    const findings = validateForm(
      spec({
        instruments: [
          {
            name: "baseline",
            label: "Baseline",
            fields: [
              RECORD_ID,
              { name: "nyha", type: "radio", label: "NYHA class", choices: "1, I | 2, II | 3, III | 4, IV" },
              { name: "lvef", type: "text", label: "LVEF", validation: "number", min: "0", max: "100" },
              { name: "detail", type: "notes", label: "Detail", branching: "[nyha] = '4'" },
            ],
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("what YAML does to an unquoted date", () => {
  /**
   * `min: 2026-01-01` in a hand-written block is a Date by the time it reaches
   * the parser — YAML's default schema resolves a bare date scalar, and nobody
   * quotes one. Dropping it would leave a field looking unbounded on the board
   * and exporting an empty column, which is the quiet kind of wrong.
   */
  it("keeps a date bound that YAML resolved into a Date object", () => {
    const field = parseField(
      { name: "visit", type: "text", validation: "date_ymd", min: new Date("2026-01-01T00:00:00Z") },
      "baseline",
    );
    expect(field.validationMin).toBe("2026-01-01");
  });

  it("formats it in UTC, because that is where YAML put it", () => {
    // A local-time formatter would render this as 2025-12-31 anywhere west of
    // Greenwich, moving a bound by a day depending on who opened the vault.
    const field = parseField({ name: "v", type: "text", min: new Date(Date.UTC(2026, 0, 1)) }, "f");
    expect(field.validationMin).toBe("2026-01-01");
  });

  it("ignores an unreadable date rather than writing Invalid Date into the CSV", () => {
    expect(parseField({ name: "v", type: "text", min: new Date("nonsense") }, "f").validationMin).toBe("");
  });
});
