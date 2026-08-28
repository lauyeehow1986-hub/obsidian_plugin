import { describe, expect, it } from "vitest";
import {
  diagramFrontmatter,
  MAX_EDGES,
  MAX_NODES,
  orphanNodes,
  parseDiagram,
  slugId,
} from "./diagram";

const GOOD = {
  type: "diagram",
  id: "DIA-2026-001",
  title: "Lifecycle",
  direction: "lr",
  source: "workflow",
  generated_from: "edata-request@3",
  nodes: [
    { id: "a", label: "Intake", shape: "stadium", state: "on-track" },
    { id: "b", label: "Triage" },
  ],
  edges: [{ from: "a", to: "b", label: "3d", style: "thick" }],
};

describe("parseDiagram", () => {
  it("reads a well-formed diagram", () => {
    const { spec, problems } = parseDiagram(GOOD);
    expect(problems).toEqual([]);
    expect(spec.direction).toBe("LR");
    expect(spec.source).toBe("workflow");
    expect(spec.generatedFrom).toBe("edata-request@3");
    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes[0]).toMatchObject({ shape: "stadium", state: "on-track" });
    expect(spec.nodes[1]).toMatchObject({ shape: "box", state: "none" });
    expect(spec.edges[0]).toMatchObject({ style: "thick", label: "3d" });
  });

  it("falls back rather than failing on a value it does not recognise", () => {
    const { spec } = parseDiagram({ ...GOOD, direction: "sideways", nodes: [{ id: "a", label: "A", shape: "hexagon", state: "puce" }] });
    expect(spec.direction).toBe("TD");
    expect(spec.nodes[0]).toMatchObject({ shape: "box", state: "none" });
  });

  it("drops an edge pointing at a node nobody declared, and says which", () => {
    const { spec, problems } = parseDiagram({
      ...GOOD,
      edges: [{ from: "a", to: "ghost" }],
    });
    expect(spec.edges).toEqual([]);
    expect(problems[0]).toContain('"ghost"');
    expect(problems[0]).toContain("dropped");
  });

  it("drops the second of two nodes sharing an id", () => {
    const { spec, problems } = parseDiagram({
      ...GOOD,
      nodes: [
        { id: "a", label: "One" },
        { id: "a", label: "Two" },
      ],
      edges: [],
    });
    expect(spec.nodes).toHaveLength(1);
    expect(spec.nodes[0]?.label).toBe("One");
    expect(problems[0]).toContain("share the id");
  });

  it("keeps a self-edge, because a loop back to the same stage is rework", () => {
    const { spec, problems } = parseDiagram({ ...GOOD, edges: [{ from: "a", to: "a" }] });
    expect(spec.edges).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("names a node that has an id but no label, and one that has neither", () => {
    const { spec, problems } = parseDiagram({
      ...GOOD,
      nodes: [{ id: "solo" }, { shape: "box" }],
      edges: [],
    });
    expect(spec.nodes).toHaveLength(1);
    expect(spec.nodes[0]).toMatchObject({ id: "solo", label: "solo" });
    expect(problems[0]).toContain("neither an id nor a label");
  });

  it("derives an id from the label when only a label is given", () => {
    const { spec } = parseDiagram({ ...GOOD, nodes: [{ label: "Awaiting approval" }], edges: [] });
    expect(spec.nodes[0]?.id).toBe("awaiting_approval");
  });

  it("caps the node count rather than wedging the renderer", () => {
    const nodes = Array.from({ length: MAX_NODES + 5 }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    const { spec, problems } = parseDiagram({ ...GOOD, nodes, edges: [] });
    expect(spec.nodes).toHaveLength(MAX_NODES);
    expect(problems.join(" ")).toContain(`first ${MAX_NODES} nodes`);
  });

  it("caps the edge count too", () => {
    const nodes = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    const edges = Array.from({ length: MAX_EDGES + 3 }, () => ({ from: "a", to: "b" }));
    const { spec, problems } = parseDiagram({ ...GOOD, nodes, edges });
    expect(spec.edges).toHaveLength(MAX_EDGES);
    expect(problems.join(" ")).toContain(`first ${MAX_EDGES} edges`);
  });

  it("says so rather than throwing when there is no frontmatter at all", () => {
    const { spec, problems } = parseDiagram(null);
    expect(spec.nodes).toEqual([]);
    expect(problems[0]).toContain("no frontmatter");
  });

  it("reports a nodes key that is not a list", () => {
    const { problems } = parseDiagram({ ...GOOD, nodes: "a, b" });
    expect(problems.join(" ")).toContain("not a list");
  });
});

describe("diagramFrontmatter", () => {
  it("round-trips through a parse", () => {
    const { spec } = parseDiagram(GOOD);
    const again = parseDiagram(diagramFrontmatter(spec));
    expect(again.problems).toEqual([]);
    expect(again.spec).toEqual(spec);
  });

  it("leaves out the keys that carry nothing", () => {
    const { spec } = parseDiagram({ type: "diagram", title: "T", nodes: [], edges: [] });
    const out = diagramFrontmatter(spec);
    expect(out).not.toHaveProperty("generated_from");
    expect(out).not.toHaveProperty("generated_at");
    expect(out).not.toHaveProperty("id");
  });
});

describe("slugId", () => {
  it("folds a label into an id and walks collisions", () => {
    expect(slugId("Awaiting approval")).toBe("awaiting_approval");
    expect(slugId("Awaiting approval", new Set(["awaiting_approval"]))).toBe("awaiting_approval_2");
  });

  it("never starts with a digit", () => {
    expect(slugId("2026 review").startsWith("n_")).toBe(true);
  });
});

describe("orphanNodes", () => {
  it("names nodes no arrow touches", () => {
    const { spec } = parseDiagram({
      ...GOOD,
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      edges: [{ from: "a", to: "b" }],
    });
    expect(orphanNodes(spec).map((node) => node.id)).toEqual(["c"]);
  });
});
