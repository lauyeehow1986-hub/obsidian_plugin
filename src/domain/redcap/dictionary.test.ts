import { describe, expect, it } from "vitest";

import { parseCsv, parseKeyedCsv, toCsvText } from "../table/csv";
import {
  DICTIONARY_COLUMNS,
  fieldToBlock,
  fromDictionaryCsv,
  instrumentsToBlock,
  labelFromFormName,
  toDictionaryCsv,
} from "./dictionary";
import { parseFormSpec } from "./form";
import { parseField } from "./field";

function spec(block: unknown, frontmatter: Record<string, unknown> = {}) {
  return parseFormSpec({
    path: "88 Forms/FORM-x.md",
    frontmatter: { id: "FORM-x", title: "A form", ...frontmatter },
    block,
  });
}

describe("CSV, both directions (§7 D2)", () => {
  it("round-trips a value containing a comma, a quote and a newline", () => {
    const text = toCsvText(["a", "b"], [['one, two', 'he said "no"'], ["line\nbreak", ""]]);
    const back = parseCsv(text);
    expect(back.problems).toEqual([]);
    expect(back.rows.map((row) => row.cells)).toEqual([
      ["a", "b"],
      ["one, two", 'he said "no"'],
      ["line\nbreak", ""],
    ]);
  });

  it("reports an unclosed quote rather than silently eating the file", () => {
    const parsed = parseCsv('a,b\r\n"never closed,c\r\n');
    expect(parsed.problems.join(" ")).toMatch(/never closed/);
  });

  it("accepts CR, LF and CRLF as line endings", () => {
    expect(parseCsv("a,b\rc,d\ne,f\r\n").rows.map((r) => r.cells)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("keys rows by header name, so column order does not matter", () => {
    const keyed = parseKeyedCsv("B,A\r\n2,1\r\n");
    expect(keyed.rows[0]?.values).toEqual({ a: "1", b: "2" });
  });

  it("strips the BOM Excel leaves on the first header cell", () => {
    const keyed = parseKeyedCsv("﻿Field Name,x\r\nage,1\r\n");
    expect(keyed.header[0]).toBe("field name");
  });

  it("names the line when a row has the wrong number of cells", () => {
    const keyed = parseKeyedCsv("a,b,c\r\n1,2\r\n");
    expect(keyed.problems.join(" ")).toMatch(/Line 2: 2 values for 3 columns/);
  });
});

describe("data dictionary export (§7 D2 step 1)", () => {
  const form = spec({
    instruments: [
      {
        name: "baseline",
        label: "Baseline",
        fields: [
          { name: "record_id", type: "text", label: "Record ID" },
          {
            name: "nyha",
            type: "radio",
            label: "NYHA class",
            choices: "1, I | 2, II | 3, III | 4, IV",
            required: true,
          },
          {
            name: "lvef",
            type: "text",
            label: "LVEF",
            validation: "number",
            min: "0",
            max: "100",
            branching: "[nyha] > '1'",
          },
        ],
      },
    ],
  });

  it("writes REDCap's eighteen columns in REDCap's order", () => {
    const rows = parseCsv(toDictionaryCsv(form)).rows;
    expect(rows[0]?.cells).toEqual([...DICTIONARY_COLUMNS]);
  });

  it("puts the choice list back in REDCap's one-line form", () => {
    const rows = parseKeyedCsv(toDictionaryCsv(form)).rows;
    expect(rows[1]?.values["choices, calculations, or slider labels"]).toBe(
      "1, I | 2, II | 3, III | 4, IV",
    );
  });

  it("writes the identifier column as `y` or blank, which is all REDCap has", () => {
    const flagged = spec({
      fields: [
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "nric", type: "text", label: "NRIC", identifier: true },
      ],
    });
    const rows = parseKeyedCsv(toDictionaryCsv(flagged)).rows;
    expect(rows.map((row) => row.values["identifier?"])).toEqual(["", "y"]);
  });

  it("puts a calculation in the shared column, not a choice list", () => {
    const calc = spec({
      fields: [
        { name: "record_id", type: "text", label: "Record ID" },
        { name: "bmi", type: "calc", label: "BMI", calculation: "[wt]/([ht]*[ht])" },
      ],
    });
    const rows = parseKeyedCsv(toDictionaryCsv(calc)).rows;
    expect(rows[1]?.values["choices, calculations, or slider labels"]).toBe("[wt]/([ht]*[ht])");
  });

  it("exports under the instrument's form name, not a stale one on the field", () => {
    const moved = spec({
      instruments: [
        {
          name: "followup",
          fields: [{ name: "record_id", type: "text", label: "Record ID", form: "baseline" }],
        },
      ],
    });
    const rows = parseKeyedCsv(toDictionaryCsv(moved)).rows;
    expect(rows[0]?.values["form name"]).toBe("followup");
  });
});

describe("data dictionary import (§7 D2 step 2)", () => {
  const csv = toDictionaryCsv(
    spec({
      instruments: [
        {
          name: "baseline",
          fields: [
            { name: "record_id", type: "text", label: "Record ID" },
            { name: "nric", type: "text", label: "NRIC", identifier: true },
          ],
        },
        {
          name: "followup",
          fields: [{ name: "readmit", type: "yesno", label: "Readmitted within 30 days?" }],
        },
      ],
    }),
  );

  it("reads instruments back in first-appearance order", () => {
    const imported = fromDictionaryCsv(csv);
    expect(imported.instruments.map((i) => i.name)).toEqual(["baseline", "followup"]);
    expect(imported.fieldCount).toBe(3);
  });

  it("derives a human label for each instrument the dictionary cannot carry", () => {
    expect(labelFromFormName("baseline_visit")).toBe("Baseline visit");
    expect(fromDictionaryCsv(csv).instruments[1]?.label).toBe("Followup");
  });

  it("says what the dictionary format could never have carried", () => {
    const imported = fromDictionaryCsv(csv);
    expect(imported.gaps.join(" ")).toMatch(/no column for the catalogue variable/);
    expect(imported.gaps.join(" ")).toMatch(/1 field is flagged as an identifier/);
  });

  it("refuses a file that is not a data dictionary rather than importing nothing quietly", () => {
    const imported = fromDictionaryCsv("date,mins,person\r\n2026-07-14,53,yh\r\n");
    expect(imported.instruments).toEqual([]);
    expect(imported.problems.join(" ")).toMatch(/not a REDCap data dictionary/);
  });

  it("reports an extra column rather than dropping it in silence", () => {
    const imported = fromDictionaryCsv(
      'Variable / Field Name,Form Name,Field Type,Field Label,Notes for me\r\nage,baseline,text,Age,keep this\r\n',
    );
    expect(imported.unknownColumns).toEqual(["notes for me"]);
    expect(imported.problems.join(" ")).toMatch(/not part of a data dictionary/);
  });

  it("names the line when a row has no field name", () => {
    const imported = fromDictionaryCsv(
      "Variable / Field Name,Form Name,Field Type\r\n,baseline,text\r\n",
    );
    expect(imported.problems.join(" ")).toMatch(/Line 2: a row with no field name/);
  });

  /**
   * §9: "REDCap CSV round-trip is tested: export → import → export produces an
   * identical file." The distinction the spec holds and the CSV cannot — a
   * catalogue link, an identifier's justification — is not in the file either
   * way, so the *file* is identical even though the note carries more.
   */
  it("round-trips: export → import → export is byte-identical", () => {
    const first = toDictionaryCsv(
      spec({
        instruments: [
          {
            name: "baseline",
            fields: [
              { name: "record_id", type: "text", label: "Record ID" },
              {
                name: "nyha",
                type: "radio",
                label: "NYHA class, at rest",
                choices: "1, I | 2, II",
                required: true,
                alignment: "lh",
              },
              {
                name: "lvef",
                type: "text",
                label: 'LVEF ("biplane")',
                validation: "number",
                min: "0",
                max: "100",
                branching: "[nyha] = '2'",
                annotation: "@HIDDEN-SURVEY",
              },
              { name: "bmi", type: "calc", calculation: "[wt]/([ht]*[ht])", label: "BMI" },
            ],
          },
        ],
      }),
    );

    const imported = fromDictionaryCsv(first);
    const second = toDictionaryCsv(
      parseFormSpec({
        path: "88 Forms/FORM-x.md",
        frontmatter: { id: "FORM-x" },
        block: instrumentsToBlock(imported.instruments),
      }),
    );

    expect(second).toBe(first);
  });
});

/**
 * `fieldToBlock` is the only supported way back from a parsed field to block
 * input, and everything that writes a note goes through it. A parsed field is
 * *not* valid block input — its keys are the model's, not the note's — so a
 * caller that skipped this bridge would lose the bounds silently. Pinned here
 * because "silently" is the word that matters.
 */
describe("the bridge between a parsed field and the block it is written back as", () => {
  it("survives a parse → block → parse round trip with nothing lost", () => {
    const original = parseField(
      {
        name: "lvef",
        type: "text",
        label: "LVEF",
        validation: "number",
        min: "0",
        max: "100",
        required: true,
        identifier: true,
        justification: "Linkage.",
        variable: "VAR-LVEF",
        branching: "[nyha] = '2'",
        note: "Biplane.",
        section: "Echo",
        alignment: "lh",
        annotation: "@HIDDEN-SURVEY",
      },
      "baseline",
    );

    expect(parseField(fieldToBlock(original), "baseline")).toEqual(original);
  });

  it("keeps a calculation across the same round trip", () => {
    const calc = parseField({ name: "bmi", type: "calc", calculation: "[wt]/([ht]*[ht])" }, "f");
    expect(parseField(fieldToBlock(calc), "f").calculation).toBe("[wt]/([ht]*[ht])");
  });
});
