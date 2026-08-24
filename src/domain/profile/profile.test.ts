import { describe, expect, it } from "vitest";
import {
  byRecency,
  parseProfileNote,
  periodText,
  profilesOfType,
  readPeriod,
  type ProfileNote,
} from "./profile";

function parse(frontmatter: Record<string, unknown>, path = "84 Profile/x.md"): ProfileNote {
  const note = parseProfileNote(path, frontmatter);
  if (note === null) throw new Error("expected a profile note");
  return note;
}

describe("parseProfileNote — the six types", () => {
  it("ignores a note that is not one of them", () => {
    expect(parseProfileNote("x.md", { type: "publication" })).toBeNull();
    expect(parseProfileNote("x.md", {})).toBeNull();
  });

  it("reads a grant", () => {
    const note = parse({
      type: "grant",
      title: "Readmission modelling",
      role: "PI",
      agency: "Invented Funding Body",
      ref: "IFB-2024-01",
      amount: "250,000",
      currency: "SGD",
      status: "awarded",
      period: "2024-2027",
      studies: ["[[Example Registry]]"],
    });
    expect(note.type).toBe("grant");
    if (note.type !== "grant") return;
    expect(note.amount).toBe(250000);
    expect(note.agency).toBe("Invented Funding Body");
    expect(note.studies.map((party) => party.name)).toEqual(["Example Registry"]);
    expect(note.period).toMatchObject({ from: "2024", to: "2027", startYear: 2024, endYear: 2027 });
  });

  it("reads a presentation, including its own date and the invited flag", () => {
    const note = parse({
      type: "presentation",
      title: "What a data facility measures",
      meeting: "Invented Society Congress",
      location: "Singapore",
      date: "2026-05-03",
      invited: true,
      format: "oral",
    });
    if (note.type !== "presentation") throw new Error("wrong type");
    expect(note.date).toBe("2026-05-03");
    expect(note.invited).toBe(true);
    expect(note.year).toBe(2026);
  });

  it("reads an award from a bare year", () => {
    const note = parse({ type: "award", title: "Invented Prize", body: "Some Body", year: 2025 });
    expect(note.year).toBe(2025);
    expect(periodText(note.period)).toBe("2025");
  });

  it("falls back to another field when there is no title", () => {
    expect(parse({ type: "teaching", course: "Applied biostatistics" }).title).toBe(
      "Applied biostatistics",
    );
    expect(parse({ type: "supervision", trainee: "A Trainee" }).title).toBe("A Trainee");
  });

  it("says so rather than guessing when there is no title at all", () => {
    const note = parse({ type: "award", body: "Some Body" });
    expect(note.title).toBe("(untitled)");
    expect(note.problems[0]).toMatch(/no `title`/);
  });

  it("keeps an unreadable amount out of the number and reports it", () => {
    const note = parse({ type: "grant", title: "x", amount: "$250,000" });
    if (note.type !== "grant") throw new Error("wrong type");
    // A currency symbol in `amount` means the currency was put in the wrong
    // field, and silently dropping it would hide that.
    expect(note.amount).toBeNull();
    expect(note.problems.some((problem) => problem.includes("amount"))).toBe(true);
  });
});

describe("readPeriod", () => {
  it("reads a written range at any precision", () => {
    expect(readPeriod({ period: "2024-2027" })).toMatchObject({ from: "2024", to: "2027" });
    expect(readPeriod({ period: "2024-03 to 2026-09" })).toMatchObject({
      from: "2024-03",
      to: "2026-09",
    });
    expect(readPeriod({ period: "2024–2027" })).toMatchObject({ from: "2024", to: "2027" });
  });

  it("reads an open-ended one as ongoing", () => {
    expect(readPeriod({ period: "2024-present" })).toMatchObject({ from: "2024", ongoing: true });
    expect(periodText(readPeriod({ period: "2024-present" }))).toBe("2024–present");
  });

  it("reads a mapping, and separate from/to keys", () => {
    expect(readPeriod({ period: { from: "2024-01-01", to: "2025-12-31" } })).toMatchObject({
      from: "2024-01-01",
      to: "2025-12-31",
    });
    expect(readPeriod({ from: "2024", to: "2025" })).toMatchObject({ from: "2024", to: "2025" });
  });

  it("takes a Date, which is what unquoted YAML hands over", () => {
    expect(readPeriod({ date: new Date(Date.UTC(2026, 4, 3, 12)) }).from).toMatch(/^2026-05-0[23]$/);
  });

  it("prints nothing rather than a bare dash when there is no period", () => {
    expect(periodText(readPeriod({}))).toBe("");
  });

  it("does not print a range when both ends are the same", () => {
    expect(periodText(readPeriod({ period: "2026" }))).toBe("2026");
  });
});

describe("byRecency", () => {
  const notes = [
    parse({ type: "award", title: "Older", year: 2020 }, "a.md"),
    parse({ type: "award", title: "Newer", year: 2026 }, "b.md"),
    parse({ type: "award", title: "Undated" }, "c.md"),
  ];

  it("puts the newest first and the undated last", () => {
    expect([...notes].sort(byRecency).map((note) => note.title)).toEqual([
      "Newer",
      "Older",
      // An item with no year is usually one somebody has not finished typing;
      // at the top of a section it ends up pasted into a grant application.
      "Undated",
    ]);
  });

  it("sorts a long grant above a talk that started in the same year", () => {
    const grant = parse({ type: "grant", title: "Grant", period: "2024-2027" }, "g.md");
    const talk = parse({ type: "grant", title: "Talk", period: "2024" }, "t.md");
    expect([talk, grant].sort(byRecency).map((note) => note.title)).toEqual(["Grant", "Talk"]);
  });
});

describe("profilesOfType", () => {
  it("returns only that type, already sorted", () => {
    const notes = [
      parse({ type: "award", title: "A", year: 2020 }, "a.md"),
      parse({ type: "grant", title: "G", period: "2026" }, "g.md"),
      parse({ type: "award", title: "B", year: 2026 }, "b.md"),
    ];
    expect(profilesOfType(notes, "award").map((note) => note.title)).toEqual(["B", "A"]);
    expect(profilesOfType(notes, "teaching")).toEqual([]);
  });
});

describe("the key Obsidian will not let a note use", () => {
  // Found by generating a CV in Obsidian: the Service line printed the
  // committee and the institution but not the membership. Obsidian's metadata
  // cache overwrites `frontmatter.position` with the frontmatter block's own
  // line range, so `cleanFrontmatter` has to drop it and a `position:` the
  // user typed never arrives — see `data/noteIndex.ts`.
  it("reads a service role from `role`", () => {
    const note = parse({ type: "service", title: "A committee", role: "Member" });
    if (note.type !== "service") throw new Error("wrong type");
    expect(note.position).toBe("Member");
  });

  it("still reads `position` where the YAML is parsed directly, as §5.9 names it", () => {
    const note = parse({ type: "service", title: "A committee", position: "Chair" });
    if (note.type !== "service") throw new Error("wrong type");
    expect(note.position).toBe("Chair");
  });
});
