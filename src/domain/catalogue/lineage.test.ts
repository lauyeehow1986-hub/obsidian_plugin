import { describe, expect, it } from "vitest";
import { chainOf, chainProblems, definitionInForceOn, lineage, nextVersion } from "./lineage";
import { parseVariable } from "./variable";

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

/** VAR-LVEF as §5.8 shows it, with the two versions before it recorded. */
function lvef(over: Record<string, unknown> = {}) {
  return parseVariable(
    "87 Catalogue/VAR-LVEF.md",
    {
      type: "variable",
      id: "VAR-LVEF",
      label: "Left ventricular ejection fraction",
      data_type: "numeric",
      units: "%",
      valid_range: [0, 100],
      definition: "Biplane Simpson's, per institutional echo protocol v3.",
      version: 3,
      supersedes: "VAR-LVEF@2",
      changed: "2026-02-01",
      change_reason: "Aligned to ESC 2025 definition.",
      identifier: false,
      history: [
        { version: 1, on: "2019-04-01", definition: "Visual estimate.", reason: "First issue." },
        {
          version: 2,
          on: "2023-07-01",
          definition: "Biplane Simpson's.",
          units: "%",
          valid_range: [0, 100],
          identifier: false,
          reason: "Moved off visual estimation.",
        },
      ],
      ...over,
    },
  );
}

describe("chainOf", () => {
  it("puts the live note at the head, oldest first", () => {
    const chain = chainOf(lvef());
    expect(chain.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(chain.map((entry) => entry.live)).toEqual([false, false, true]);
  });

  it("is a chain of one for a variable at version 1", () => {
    const chain = chainOf(parseVariable("x.md", { type: "variable", id: "V", version: 1, definition: "d" }));
    expect(chain).toHaveLength(1);
    expect(chain[0]?.live).toBe(true);
  });
});

describe("definitionInForceOn — the question §5.8 says you will be asked", () => {
  it("answers with the version in force on the day", () => {
    const answer = definitionInForceOn(lvef(), at("2024-05-06"));
    expect({ version: answer.version, ref: answer.ref, live: answer.live }).toEqual({
      version: 2,
      ref: "VAR-LVEF@2",
      live: false,
    });
    expect(answer.definition.definition?.value).toBe("Biplane Simpson's.");
  });

  it("answers with the live note for a date after the current version took effect", () => {
    const answer = definitionInForceOn(lvef(), at("2026-08-29"));
    expect({ version: answer.version, live: answer.live }).toEqual({ version: 3, live: true });
    expect(answer.definition.definition?.value).toContain("protocol v3");
  });

  it("never borrows a later value backwards", () => {
    // Version 1 recorded only a definition. Today the units are "%" — but they
    // were not recorded then, and answering "%" would be a confident lie about
    // what an extraction in 2020 measured.
    const answer = definitionInForceOn(lvef(), at("2020-01-01"));
    expect(answer.version).toBe(1);
    expect(answer.definition.units).toBeNull();
    expect(answer.unrecorded).toContain("units");
    expect(answer.note).toContain("Not recorded at that version");
  });

  it("carries a value forward from the version that last stated it", () => {
    const answer = definitionInForceOn(lvef(), at("2024-05-06"));
    expect(answer.definition.units).toEqual({ value: "%", since: 2 });
    expect(answer.definition.validRange).toEqual({ value: [0, 100], since: 2 });
  });

  it("refuses a date before anything the vault holds", () => {
    const answer = definitionInForceOn(lvef(), at("2018-01-01"));
    expect(answer.version).toBe(0);
    expect(answer.note).toContain("The vault holds nothing from before it");
  });

  it("says so when no version in the chain carries a date", () => {
    const answer = definitionInForceOn(
      parseVariable("x.md", { type: "variable", id: "V", version: 1, definition: "d" }),
      Date.now(),
    );
    expect(answer.version).toBe(0);
    expect(answer.note).toContain("cannot answer this by date");
  });

  it("names the undated versions it had to skip", () => {
    const answer = definitionInForceOn(
      lvef({
        history: [
          { version: 1, definition: "Visual estimate.", reason: "First issue." },
          { version: 2, on: "2023-07-01", definition: "Biplane Simpson's.", reason: "b" },
        ],
      }),
      at("2024-05-06"),
    );
    expect(answer.version).toBe(2);
    expect(answer.note).toContain("carry no date and were skipped");
  });

  it("does not report a field the data type rules out", () => {
    // A numeric variable has no coding, so "coding not recorded" is true and
    // useless — and it buries the one that matters.
    const answer = definitionInForceOn(lvef(), at("2026-08-29"));
    expect(answer.unrecorded).toEqual([]);
  });

  it("rules nothing out while the data type itself is unrecorded", () => {
    const answer = definitionInForceOn(lvef(), at("2020-01-01"));
    expect(answer.unrecorded).toEqual([
      "data type",
      "units",
      "valid range",
      "coding",
      "identifier flag",
    ]);
  });

  it("treats the start date as inclusive", () => {
    const start = Date.parse("2023-07-01T00:00:00.000Z");
    expect(definitionInForceOn(lvef(), start).version).toBe(2);
    expect(definitionInForceOn(lvef(), start - 1).version).toBe(1);
    expect(definitionInForceOn(lvef(), start + DAY).version).toBe(2);
  });
});

describe("lineage", () => {
  it("closes each version at the next one's start, leaving the head open", () => {
    const rows = lineage(lvef());
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(rows[0]?.until).toBe(rows[1]?.from);
    expect(rows[2]?.until).toBeNull();
    expect(rows[2]?.live).toBe(true);
  });

  it("names what actually moved, not what the entry happened to write", () => {
    const rows = lineage(lvef());
    // Version 1 started the chain; nothing moved at it.
    expect(rows[0]?.changed).toEqual([]);
    expect(rows[1]?.changed).toEqual(["definition", "units", "valid range", "identifier flag"]);
    // The live head carries every field, so listing its keys would claim the
    // coding moved on a variable that has never had any. The data type is
    // there because version 2 never recorded one — moving from "not recorded"
    // to "numeric" is a real move, and is the honest thing to report.
    expect(rows[2]?.changed).toEqual(["definition", "data type"]);
  });

  it("does not report a field an entry restated without changing", () => {
    const rows = lineage(
      lvef({
        history: [
          { version: 1, on: "2019-04-01", definition: "Visual estimate.", units: "%", reason: "a" },
          { version: 2, on: "2023-07-01", definition: "Visual estimate.", units: "%", reason: "b" },
        ],
      }),
    );
    expect(rows[1]?.changed).toEqual([]);
  });
});

describe("chainProblems", () => {
  it("is silent on a well-formed chain", () => {
    expect(chainProblems(lvef())).toEqual([]);
  });

  it("catches a gap, because a date inside it cannot be answered", () => {
    const said = chainProblems(
      lvef({ history: [{ version: 1, on: "2019-04-01", definition: "d", reason: "r" }] }),
    ).join(" ");
    expect(said).toContain("jumps from version 1 to 3");
  });

  it("catches a supersedes that names the wrong version", () => {
    expect(chainProblems(lvef({ supersedes: "VAR-LVEF@1" })).join(" ")).toContain("follows VAR-LVEF@2");
  });

  it("catches dates running backwards", () => {
    const said = chainProblems(
      lvef({
        history: [
          { version: 1, on: "2019-04-01", definition: "d", reason: "r" },
          { version: 2, on: "2018-01-01", definition: "d", reason: "r" },
        ],
      }),
    ).join(" ");
    expect(said).toContain("runs backwards");
  });

  it("catches a version bump that kept no history", () => {
    const said = chainProblems(lvef({ history: [] })).join(" ");
    expect(said).toContain("only the version number survives");
  });

  it("says nothing about supersedes at version 1", () => {
    expect(
      chainProblems(parseVariable("x.md", { type: "variable", id: "V", version: 1, definition: "d" })),
    ).toEqual([]);
  });
});

describe("nextVersion", () => {
  it("follows the highest version anywhere in the chain", () => {
    expect(nextVersion(lvef())).toBe(4);
  });

  it("is 2 for a fresh variable, and 1 for one with no readable version", () => {
    expect(nextVersion(parseVariable("x.md", { type: "variable", id: "V", version: 1, definition: "d" }))).toBe(2);
    expect(nextVersion(parseVariable("x.md", { type: "variable", id: "V", definition: "d" }))).toBe(1);
  });
});
