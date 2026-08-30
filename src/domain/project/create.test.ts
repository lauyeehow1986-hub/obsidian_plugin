import { describe, expect, it } from "vitest";
import { parseProject } from "./project";
import { newProject, newProjectBody, nextProjectId } from "./create";
import { NOW, projectSpec } from "./testFixtures";

const spec = projectSpec();

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

describe("allocating a project id", () => {
  it("starts at 001 in an empty year", () => {
    expect(nextProjectId([], 2026)).toBe("PRJ-2026-001");
  });

  it("takes the next number after the highest, ignoring request ids", () => {
    // One allocator serves both prefixes; a REQ- id must not push PRJ- along.
    expect(nextProjectId(["PRJ-2026-004", "REQ-2026-099", "PRJ-2025-020"], 2026)).toBe(
      "PRJ-2026-005",
    );
  });

  it("takes an owner segment, for when a second person allocates ids", () => {
    expect(nextProjectId(["PRJ-2026-YH-002"], 2026, { owner: "YH" })).toBe("PRJ-2026-YH-003");
  });
});

describe("creating a project note", () => {
  const input = {
    spec,
    now: NOW,
    actor: "yh",
    id: "PRJ-2026-004",
    title: "Research data governance rollout",
    uid: "01JZQ8MW5T3K7XBN2FHVCD9RGB",
  };

  it("opens in the spec's first stage and records it in history", () => {
    const created = newProject(input);
    expect(created.frontmatter["stage"]).toBe("scoping");
    expect(created.frontmatter["history"]).toEqual([{ at: "2026-07-28", to: "scoping", by: "yh" }]);
  });

  it("names the file after the human label", () => {
    expect(newProject(input).filename).toBe("PRJ-2026-004.md");
  });

  it("writes no key for a field the caller did not supply", () => {
    // An empty `sponsor:` reads as "asked and answered with nothing".
    const created = newProject(input);
    expect(created.frontmatter).not.toHaveProperty("sponsor");
    expect(created.frontmatter).not.toHaveProperty("due");
  });

  it("writes the empty lists, so the shape to fill in is visible from day one", () => {
    const created = newProject(input);
    expect(created.frontmatter["milestones"]).toEqual([]);
    expect(created.frontmatter["deliverables"]).toEqual([]);
  });

  it("logs the creation as a stage-change, exactly as a request does", () => {
    const created = newProject(input);
    expect(at(created.audit, 0)).toMatchObject({
      actor: "yh",
      action: "stage-change",
      subject: "PRJ-2026-004",
      detail: "(new)→scoping",
    });
  });

  it("logs no identifier-scope row, because a project releases no data", () => {
    // A request logs one from its first entry because the identifier scope is a
    // governance field. A project has none to set, and a row claiming otherwise
    // would be an audit entry about a decision nobody made.
    expect(newProject(input).audit).toHaveLength(1);
  });

  it("round-trips through the parser it was built for", () => {
    const { project, problems } = parseProject(newProject(input).frontmatter);
    expect(problems).toEqual([]);
    expect(project.id).toBe("PRJ-2026-004");
    expect(project.stage).toBe("scoping");
    expect(project.workflowVersion).toBe(spec.version);
    expect(project.milestones).toEqual([]);
  });

  it("starts a body with headings and no invented prose", () => {
    expect(newProjectBody({ title: "Rollout" })).toContain("# Rollout");
  });
});
