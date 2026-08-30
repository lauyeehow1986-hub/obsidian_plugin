import { describe, expect, it } from "vitest";
import { parseProject, type ProjectNote } from "./project";
import { projectFrontmatter } from "./testFixtures";

function only<T>(items: readonly T[], what: string): T {
  if (items.length !== 1) throw new Error(`expected exactly one ${what}, got ${items.length}`);
  return items[0]!;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

function project(overrides: Record<string, unknown> = {}): ProjectNote {
  return parseProject(projectFrontmatter(overrides)).project;
}

describe("reading a project note", () => {
  it("reads the fields the portfolio needs", () => {
    const parsed = parseProject(projectFrontmatter());
    expect(parsed.problems).toEqual([]);
    expect(parsed.project.id).toBe("PRJ-2026-004");
    expect(parsed.project.stage).toBe("delivery");
    expect(parsed.project.sponsor).toBe("[[Prof C Lim]]");
    expect(parsed.project.studies).toEqual(["[[EuroHeart]]"]);
    expect(parsed.project.requests).toEqual(["[[REQ-2026-014]]"]);
    expect(parsed.project.milestones).toHaveLength(3);
    expect(parsed.project.deliverables).toHaveLength(1);
  });

  it("starts the engine's clock at `started`, because nobody handed a project in", () => {
    // `received` is what dwell.ts reads. A project has no arrival date, so this
    // is the seam where the two note shapes meet.
    const parsed = project();
    expect(parsed.received).not.toBeNull();
    expect(parsed.received).toBe(parsed.started);
  });

  it("carries no external_ref, so nothing claims it is unreconciled", () => {
    // §5.15: a project has no upstream record of truth. An empty string here
    // would read as "never reconciled", which is a different and untrue claim.
    expect(project().externalRef).toBeUndefined();
  });

  it("accepts a single study as a list of one", () => {
    expect(project({ studies: "[[EuroHeart]]" }).studies).toEqual(["[[EuroHeart]]"]);
  });

  it("says so when the note has no stage", () => {
    const { problems } = parseProject(projectFrontmatter({ stage: "" }));
    expect(problems.some((p) => p.includes("no `stage`"))).toBe(true);
  });

  it("says so when the stage disagrees with the last history entry", () => {
    const { problems } = parseProject(projectFrontmatter({ stage: "embedding" }));
    expect(problems.some((p) => p.includes("does not match the last history entry"))).toBe(true);
  });
});

describe("milestones", () => {
  it("ignores a milestone with no id, because blocked_by would have nothing to name", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({ milestones: [{ title: "Nameless", due: "2026-09-30" }] }),
    );
    expect(note.milestones).toHaveLength(0);
    expect(only(problems, "problem")).toContain("has no `id`");
  });

  it("ignores a repeated id rather than guessing which one an edge means", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({
        milestones: [
          { id: "M1", title: "First" },
          { id: "M1", title: "Also first" },
        ],
      }),
    );
    expect(note.milestones).toHaveLength(1);
    expect(at(note.milestones, 0).title).toBe("First");
    expect(only(problems, "problem")).toContain('repeats the id "M1"');
  });

  it("drops an edge to a milestone that does not exist, and names it", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({
        milestones: [
          { id: "M1", title: "First" },
          { id: "M2", title: "Second", blocked_by: ["M1", "M9"] },
        ],
      }),
    );
    expect(at(note.milestones, 1).blockedBy).toEqual(["M1"]);
    expect(only(problems, "problem")).toContain("M9");
  });

  it("reads `done` as a date, never as a flag", () => {
    // §5.15 declines percent-complete. A milestone landed on a day or it has not.
    expect(at(project().milestones, 0).done).not.toBeNull();
    expect(at(project().milestones, 1).done).toBeNull();
  });
});

describe("blocked_by cycles", () => {
  it("refuses a cycle at parse time and names the loop", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({
        milestones: [
          { id: "M1", title: "First", blocked_by: ["M3"] },
          { id: "M2", title: "Second", blocked_by: ["M1"] },
          { id: "M3", title: "Third", blocked_by: ["M2"] },
        ],
      }),
    );
    const problem = only(problems, "problem");
    expect(problem).toContain("cycle");
    expect(problem).toContain("→");
    for (const id of ["M1", "M2", "M3"]) expect(problem).toContain(id);
    // Refused means the edges are gone: nothing downstream can walk a loop.
    expect(note.milestones.every((m) => m.blockedBy.length === 0)).toBe(true);
  });

  it("refuses a milestone that blocks itself", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({ milestones: [{ id: "M1", title: "First", blocked_by: ["M1"] }] }),
    );
    expect(only(problems, "problem")).toContain("M1 → M1");
    expect(at(note.milestones, 0).blockedBy).toEqual([]);
  });

  it("leaves an honest chain alone", () => {
    const { project: note, problems } = parseProject(projectFrontmatter());
    expect(problems).toEqual([]);
    expect(at(note.milestones, 1).blockedBy).toEqual(["M1"]);
    expect(at(note.milestones, 2).blockedBy).toEqual(["M2"]);
  });

  it("leaves a diamond alone — two paths to one milestone is not a cycle", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({
        milestones: [
          { id: "M1", title: "Root" },
          { id: "M2", title: "Left", blocked_by: ["M1"] },
          { id: "M3", title: "Right", blocked_by: ["M1"] },
          { id: "M4", title: "Join", blocked_by: ["M2", "M3"] },
        ],
      }),
    );
    expect(problems).toEqual([]);
    expect(at(note.milestones, 3).blockedBy).toEqual(["M2", "M3"]);
  });
});

describe("malformed notes", () => {
  it("reads a note with no frontmatter at all without throwing", () => {
    const { project: note, problems } = parseProject(undefined);
    expect(note.milestones).toEqual([]);
    expect(problems.some((p) => p.includes("no frontmatter"))).toBe(true);
  });

  it("says so when milestones is not a list", () => {
    const { problems } = parseProject(projectFrontmatter({ milestones: "M1, M2" }));
    expect(problems.some((p) => p.includes("`milestones` is not a list"))).toBe(true);
  });

  it("says so when a deliverable has no title", () => {
    const { project: note, problems } = parseProject(
      projectFrontmatter({ deliverables: [{ kind: "report" }] }),
    );
    expect(note.deliverables).toHaveLength(0);
    expect(problems.some((p) => p.includes("no `title`"))).toBe(true);
  });
});
