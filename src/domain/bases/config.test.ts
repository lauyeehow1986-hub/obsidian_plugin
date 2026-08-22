import { dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { stageLabelFormula, stageLabels, standardBases, type BaseViewSpec } from "./config";

const STAGES = [
  { id: "triage", label: "SCDB triage" },
  { id: "awaiting-approval", label: "Awaiting approval" },
  { id: "qc", label: "QC" },
];

const BASES = standardBases("scdb-request", STAGES);
const views: BaseViewSpec[] = BASES.flatMap((base) => base.config.views ?? []);

describe("the set we generate", () => {
  it("covers the four browse surfaces the plan names", () => {
    expect(BASES.map((base) => base.noteType)).toEqual([
      "scdb-request",
      "publication",
      "correspondence",
      "variable",
    ]);
  });

  it("gives every file a distinct name, since the name is the filename", () => {
    const names = BASES.map((base) => base.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("says what each one is for, because an empty table needs explaining", () => {
    for (const base of BASES) expect(base.purpose.length).toBeGreaterThan(0);
  });
});

describe("view specs Obsidian will accept", () => {
  it("names a view renderer that exists", () => {
    // `table` is what Bases itself inserts when a .base declares no views.
    // A made-up type id renders as "view not found".
    for (const view of views) expect(view.type).toBe("table");
  });

  it("always gives groupBy both a property and a direction", () => {
    // Bases throws while parsing a view whose groupBy lacks either key, which
    // would make the whole file unopenable rather than degrade.
    for (const view of views) {
      if (!view.groupBy) continue;
      expect(view.groupBy.property.length).toBeGreaterThan(0);
      expect(["ASC", "DESC"]).toContain(view.groupBy.direction);
    }
  });

  it("names frontmatter properties bare inside a view, the way Bases writes them back", () => {
    // Bases accepts `note.stage` here but rewrites it to `stage` the first time
    // the view is edited (verified against 1.12.7). Emitting the prefixed form
    // would mean every generated file changed on disk as soon as it was opened
    // and touched — pure churn in the user's vault and in git.
    for (const view of views) {
      for (const property of [
        ...(view.order ?? []),
        ...(view.groupBy ? [view.groupBy.property] : []),
      ]) {
        if (property.startsWith("formula.")) continue;
        expect(property).not.toMatch(/^(note|file)\./);
      }
    }
  });

  it("keeps the `formula.` prefix, because bare names mean frontmatter", () => {
    const grouped = views.find((view) => view.name === "By stage");
    expect(grouped?.groupBy?.property).toBe("formula.stage_label");
  });

  it("gives every view a name for the view selector", () => {
    for (const view of views) expect(view.name.length).toBeGreaterThan(0);
  });

  it("orders view keys the way Bases writes them back", () => {
    // Same reason as the bare property names: a file Bases has rewritten should
    // be textually identical to the one we generated, or every user who opens a
    // dashboard gets a spurious change in their vault.
    for (const view of views) {
      const expected = ["type", "name", ...(view.groupBy ? ["groupBy"] : []), "order"];
      expect(Object.keys(view)).toEqual(expected);
    }
  });
});

describe("the stage-label formula", () => {
  it("maps every stage id to its spec label", () => {
    const formula = stageLabelFormula(STAGES);
    for (const stage of STAGES) {
      expect(formula).toContain(`note.stage == "${stage.id}"`);
      expect(formula).toContain(`"${stage.label}"`);
    }
  });

  it("falls back to the raw id, so a retired stage stays visibly odd", () => {
    // Not blank and not a guess: a request sitting in a stage the spec dropped
    // should look different in the browse layer, the same way it carries a
    // "migrate" chip on our own boards (§5.2).
    expect(stageLabelFormula(STAGES).endsWith("note.stage)))")).toBe(true);
    expect(stageLabelFormula([])).toBe("note.stage");
  });

  it("nests innermost-last, so the first stage is tested first", () => {
    expect(stageLabelFormula([{ id: "a", label: "A" }, { id: "b", label: "B" }])).toBe(
      'if(note.stage == "a", "A", if(note.stage == "b", "B", note.stage))',
    );
  });

  it("escapes quotes and backslashes rather than emitting a broken expression", () => {
    // Ids and labels come from a YAML file the user edits. An unescaped quote
    // would produce an expression Bases cannot parse, and an unparseable .base
    // does not degrade — it fails to open.
    const formula = stageLabelFormula([{ id: 'we"ird', label: 'said "go" \\ done' }]);
    expect(formula).toBe(
      'if(note.stage == "we\\"ird", "said \\"go\\" \\\\ done", note.stage)',
    );
  });

  it("collects live stages across specs, first definition winning", () => {
    const labels = stageLabels([
      { stages: [{ id: "triage", label: "SCDB triage" }] },
      { stages: [{ id: "triage", label: "Other triage" }, { id: "qc", label: "QC" }] },
    ]);
    expect(labels).toEqual([
      { id: "triage", label: "SCDB triage" },
      { id: "qc", label: "QC" },
    ]);
  });
});

describe("filters", () => {
  it("quotes the value, so it is not parsed as an identifier", () => {
    expect(BASES[0]?.config.filters).toBe('note.type == "scdb-request"');
  });

  it("filters each base to the note type it claims to browse", () => {
    for (const base of BASES) {
      expect(base.config.filters).toBe(`note.type == "${base.noteType}"`);
    }
  });
});

describe("column labels", () => {
  it("labels every column a view displays, so no raw frontmatter key shows", () => {
    for (const base of BASES) {
      const labelled = new Set(Object.keys(base.config.properties ?? {}));
      // Views name properties bare; the `properties` map keys them `note.`-
      // prefixed. Bridge the two so a column can never go unlabelled unnoticed.
      const shown = (base.config.views ?? []).flatMap((view) => [
        ...(view.order ?? []),
        ...(view.groupBy ? [view.groupBy.property] : []),
      ]);
      const unlabelled = shown.filter(
        (property) =>
          !labelled.has(property.startsWith("formula.") ? property : `note.${property}`),
      );
      expect({ base: base.name, unlabelled }).toEqual({ base: base.name, unlabelled: [] });
    }
  });

  it("uses the request type it is given rather than hardcoding it", () => {
    const [queue] = standardBases("other-type");
    expect(queue?.config.filters).toBe('note.type == "other-type"');
  });
});

describe("serialising to a .base file", () => {
  // Obsidian writes these with `stringifyYaml`, which is js-yaml `dump`. A
  // config carrying `undefined`, a function or a cycle would either throw or
  // silently lose a key on the way to disk.
  it("round-trips through YAML unchanged", () => {
    for (const base of BASES) {
      expect(load(dump(base.config))).toEqual(base.config);
    }
  });

  it("emits no null or empty keys that Bases would have to interpret", () => {
    for (const base of BASES) {
      const text = dump(base.config);
      expect(text).not.toContain("null");
      expect(text).not.toContain("undefined");
    }
  });
});
