import { dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { standardBases, type BaseViewSpec } from "./config";

const BASES = standardBases("scdb-request");
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
      expect(view.groupBy.property).toMatch(/^note\./);
      expect(["ASC", "DESC"]).toContain(view.groupBy.direction);
    }
  });

  it("prefixes every property id with its source", () => {
    for (const view of views) {
      for (const property of view.order ?? []) {
        expect(property).toMatch(/^(note|file|formula)\./);
      }
    }
  });

  it("gives every view a name for the view selector", () => {
    for (const view of views) expect(view.name.length).toBeGreaterThan(0);
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
      const shown = (base.config.views ?? []).flatMap((view) => [
        ...(view.order ?? []),
        ...(view.groupBy ? [view.groupBy.property] : []),
      ]);
      const unlabelled = shown.filter((property) => !labelled.has(property));
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
