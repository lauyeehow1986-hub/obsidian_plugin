import { describe, expect, it } from "vitest";
import {
  buildNote,
  fieldsFor,
  initialValues,
  NOTE_KIND_SPECS,
  NEW_NOTE_KINDS,
  safeStem,
  type NoteValues,
} from "./newNote";
import { parseStudy } from "../study/study";
import { parsePolicy } from "../policy/policy";
import { parsePublication } from "../publication/publication";
import { parseProfileNote } from "../profile/profile";

/**
 * The contract these tests hold is not "the fields are the fields" — it is
 * that a note this module writes is a note the matching parser reads back.
 * Every kind is round-tripped through its own reader, because the whole reason
 * this module exists is that typing the frontmatter from memory gets it subtly
 * wrong in the way that makes a board silently show nothing.
 */

const NOW = Date.parse("2026-08-31T09:00:00Z");

function build(kind: (typeof NEW_NOTE_KINDS)[number], values: Record<string, string>) {
  const spec = NOTE_KIND_SPECS[kind];
  return buildNote(spec, { ...initialValues(spec, NOW), ...values } as NoteValues, NOW);
}

describe("required fields", () => {
  it("names every empty required field, not just the first", () => {
    const built = build("meeting", { title: "", date: "" });
    expect(built.missing).toEqual(["Title", "Date"]);
  });

  it("is satisfied once they are filled", () => {
    expect(build("meeting", { title: "Committee", date: "2026-09-01" }).missing).toEqual([]);
  });

  it("only counts required fields the chosen variant actually shows", () => {
    // `trainee` belongs to supervision; a grant must not be blocked on it.
    expect(build("profile", { type: "grant", title: "A grant" }).missing).toEqual([]);
  });
});

describe("empty fields write no key", () => {
  it("omits an unfilled optional rather than writing an empty string", () => {
    const built = build("study", { title: "EuroHeart" });
    expect(built.frontmatter["id"]).toBeUndefined();
    expect(built.frontmatter["status"]).toBeUndefined();
  });

  it("omits the whole governance mapping when nothing in it was filled", () => {
    // A study with no recorded scope is not a study scoped to `none`: every
    // check has to be able to answer "nobody wrote it down".
    const built = build("study", { title: "EuroHeart" });
    expect(built.frontmatter["governance"]).toBeUndefined();
    const study = parseStudy({ path: "20 Studies/EuroHeart.md", frontmatter: built.frontmatter });
    expect(study.approved).toBeNull();
  });

  it("writes a checkbox either way, because false is a recorded answer", () => {
    expect(build("publication", { title: "A paper" }).frontmatter["scdb_supported"]).toBe(false);
    expect(
      build("publication", { title: "A paper", scdb_supported: "yes" }).frontmatter[
        "scdb_supported"
      ],
    ).toBe(true);
  });
});

describe("study", () => {
  it("nests governance keys where parseStudy reads them", () => {
    const built = build("study", {
      title: "EuroHeart",
      id: "EH",
      "governance.identifiers": "indirect",
      "governance.irb_ref": "DSRB-2026-0142",
      "governance.irb_expiry": "2027-03-31",
    });
    expect(built.frontmatter["governance"]).toEqual({
      identifiers: "indirect",
      irb_ref: "DSRB-2026-0142",
      irb_expiry: "2027-03-31",
    });

    const study = parseStudy({ path: "20 Studies/EuroHeart.md", frontmatter: built.frontmatter });
    expect(study.approved).toBe("indirect");
    expect(study.irbRef).toBe("DSRB-2026-0142");
    expect(study.irbExpiry).not.toBeNull();
    expect(study.problems).toEqual([]);
  });
});

describe("policy", () => {
  it("reads back with no problems once id, version and review date are given", () => {
    const built = build("policy", {
      title: "SCDB extraction SOP",
      id: "POL-SCDB-01",
      version: "3",
      review_due: "2027-03-31",
    });
    const policy = parsePolicy("40 Policies/SCDB extraction SOP.md", built.frontmatter);
    expect(policy.version).toBe("3");
    expect(policy.status).toBe("current");
    expect(policy.reviewDue).not.toBeNull();
    expect(policy.problems).toEqual([]);
  });

  it("refuses without the version, because a revision is frozen under it", () => {
    expect(build("policy", { title: "SOP", version: "" }).missing).toEqual(["Version"]);
  });
});

describe("publication", () => {
  it("stamps a first history entry so time in stage is measurable", () => {
    const built = build("publication", { title: "A paper", stage: "submitted" });
    expect(built.frontmatter["history"]).toEqual([{ at: "2026-08-31", to: "submitted" }]);

    const publication = parsePublication("85 Publications/A paper.md", built.frontmatter);
    expect(publication.stage).toBe("submitted");
    expect(publication.history).toHaveLength(1);
    expect(publication.problems).toEqual([]);
  });

  it("splits authors into a list in the order they were typed", () => {
    const built = build("publication", {
      title: "A paper",
      authors: "[[Dr A Tan]], [[Owner]]",
    });
    expect(built.frontmatter["authors"]).toEqual(["[[Dr A Tan]]", "[[Owner]]"]);
    const publication = parsePublication("85 Publications/A paper.md", built.frontmatter);
    expect(publication.authors.map((author) => author.name)).toEqual(["Dr A Tan", "Owner"]);
  });
});

describe("profile", () => {
  it("writes the chosen kind as the note type", () => {
    const built = build("profile", { type: "award", title: "Best paper", body: "ESC" });
    expect(built.frontmatter["type"]).toBe("award");
    const note = parseProfileNote("84 Profile/Best paper.md", built.frontmatter);
    expect(note?.type).toBe("award");
  });

  it("shows only the fields belonging to the chosen kind", () => {
    const keys = (variant: string) =>
      fieldsFor(NOTE_KIND_SPECS["profile"], variant).map((field) => field.key);
    expect(keys("grant")).toContain("agency");
    expect(keys("grant")).not.toContain("trainee");
    expect(keys("supervision")).toContain("trainee");
    expect(keys("supervision")).not.toContain("agency");
  });

  it("writes a service position as `role`, which is the key the CV reads", () => {
    // Obsidian's metadata cache overwrites `position` with the frontmatter
    // block's own line range, so a `position:` written here would never reach
    // the CV. This is the regression that guards it.
    const built = build("profile", {
      type: "service",
      title: "Research committee",
      role: "Chair",
      period: "2024–2027",
    });
    expect(built.frontmatter["role"]).toBe("Chair");
    expect(built.frontmatter["position"]).toBeUndefined();

    const note = parseProfileNote("84 Profile/Research committee.md", built.frontmatter);
    expect(note?.type).toBe("service");
    if (note?.type === "service") expect(note.position).toBe("Chair");
    expect(note?.problems).toEqual([]);
  });

  it("reads a bare year as a legitimate precision", () => {
    const built = build("profile", { type: "award", title: "A prize", period: "2025" });
    const note = parseProfileNote("84 Profile/A prize.md", built.frontmatter);
    expect(note?.year).toBe(2025);
    expect(note?.problems).toEqual([]);
  });
});

describe("filenames", () => {
  it("names the file from the first stem field that has a value", () => {
    expect(build("study", { title: "", id: "EH" }).stem).toBe("EH");
  });

  it("falls back rather than producing an empty name", () => {
    expect(build("person", { name: "" }).stem).toBe("Person");
  });

  it("strips characters a vault path or a wikilink cannot carry", () => {
    expect(safeStem('REQ/2026: "big" [draft]#1')).toBe("REQ 2026 big draft 1");
  });
});

describe("every kind", () => {
  it("has a spec whose id matches its key, so the commands cannot drift", () => {
    for (const kind of NEW_NOTE_KINDS) {
      expect(NOTE_KIND_SPECS[kind].id).toBe(kind);
      expect(NOTE_KIND_SPECS[kind].commandName.startsWith("New ")).toBe(true);
    }
  });

  it("produces a body and a stem even when only the required fields are filled", () => {
    for (const kind of NEW_NOTE_KINDS) {
      const spec = NOTE_KIND_SPECS[kind];
      const values: Record<string, string> = { ...initialValues(spec, NOW) };
      for (const field of fieldsFor(spec, values[spec.variantField?.key ?? ""] ?? "")) {
        if (field.required === true && (values[field.key] ?? "") === "") values[field.key] = "X";
      }
      const built = buildNote(spec, values as NoteValues, NOW);
      expect(built.missing).toEqual([]);
      expect(built.stem).not.toBe("");
      expect(built.body.trim()).not.toBe("");
    }
  });
});
