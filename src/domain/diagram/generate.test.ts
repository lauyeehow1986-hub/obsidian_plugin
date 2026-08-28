import { describe, expect, it } from "vitest";
import { parseRequest } from "../request/request";
import { NOW, requestFrontmatter, testSpec } from "../request/testFixtures";
import { dataFlowDiagram, requestPathDiagram, workflowDiagram } from "./generate";
import { toMermaid } from "./mermaid";

function request(overrides: Record<string, unknown> = {}) {
  return parseRequest(requestFrontmatter(overrides)).request;
}

describe("workflowDiagram", () => {
  const spec = testSpec();
  const diagram = workflowDiagram(spec, NOW);

  it("draws the process the spec describes, not one of its own", () => {
    expect(diagram.nodes.map((node) => node.id)).toEqual(spec.stages.map((stage) => stage.id));
    expect(diagram.source).toBe("workflow");
  });

  it("stamps the spec version, so a stale copy is detectable", () => {
    expect(diagram.generatedFrom).toBe("edata-request@1");
    expect(diagram.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("puts the owner and the SLA target on the box", () => {
    const triage = diagram.nodes.find((node) => node.id === "triage");
    expect(triage?.label).toBe("SCDB triage (scdb, 3d)");
  });

  it("marks a gated stage and carries the refusal message as the note", () => {
    const approved = diagram.nodes.find((node) => node.id === "approved");
    expect(approved?.state).toBe("blocked");
    expect(approved?.note).toContain("current IRB/DSRB reference");
  });

  it("draws terminal stages as terminal", () => {
    const delivered = diagram.nodes.find((node) => node.id === "delivered");
    expect(delivered).toMatchObject({ shape: "stadium", state: "done" });
  });

  it("draws a declared transition, and dots the ones that go backwards", () => {
    expect(diagram.edges).toContainEqual({
      from: "triage",
      to: "awaiting-approval",
      label: "",
      style: "solid",
    });
    // The arrow into a gated stage says so, because that is where a request stops.
    expect(diagram.edges).toContainEqual({
      from: "awaiting-approval",
      to: "approved",
      label: "gate",
      style: "solid",
    });
    // qc -> extraction is a send-back: earlier in declaration order, and
    // extraction is itself gated, so the arrow carries both facts.
    expect(diagram.edges).toContainEqual({
      from: "qc",
      to: "extraction",
      label: "gate",
      style: "dotted",
    });
  });

  it("says a stage is unconstrained rather than inventing a constraint", () => {
    // The fixture constrains every non-terminal stage, so remove one and check
    // the generator does not silently fill in eight arrows or none.
    const loose = testSpec({
      transitions: [{ from: ["intake"], to: ["triage"] }],
    });
    const out = workflowDiagram(loose, NOW);
    const fromTriage = out.edges.filter((edge) => edge.from === "triage");
    expect(fromTriage).toEqual([
      { from: "triage", to: "awaiting-approval", label: "unconstrained", style: "dotted" },
    ]);
  });

  it("compiles to Mermaid without inventing a node", () => {
    const source = toMermaid(diagram);
    expect(source.startsWith("flowchart TD")).toBe(true);
    for (const edge of diagram.edges) {
      expect(diagram.nodes.some((node) => node.id === edge.to)).toBe(true);
    }
  });
});

describe("requestPathDiagram", () => {
  const spec = testSpec();

  it("draws the stages the request actually visited, in order", () => {
    const out = requestPathDiagram(request(), spec, NOW);
    expect(out.nodes.map((node) => node.id)).toEqual(["intake", "triage", "awaiting-approval"]);
    expect(out.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      "intake>triage",
      "triage>awaiting-approval",
    ]);
    expect(out.source).toBe("request-path");
  });

  it("labels each arrow with what the stage it left had cost", () => {
    const out = requestPathDiagram(request(), spec, NOW);
    expect(out.edges[0]?.label).toBe("2 days");
  });

  it("says where the request is now and how long it has been there", () => {
    const out = requestPathDiagram(request(), spec, NOW);
    const here = out.nodes.find((node) => node.id === "awaiting-approval");
    expect(here?.label).toContain("here now");
    expect(here?.label).toContain("10 days");
    expect(here?.state).toBe("at-risk");
  });

  it("shows a bounce as a dotted arrow and counts it in the title", () => {
    const out = requestPathDiagram(
      request({
        stage: "triage",
        history: [
          { at: "2026-07-14", to: "intake", by: "yh" },
          { at: "2026-07-16", to: "triage", by: "yh" },
          { at: "2026-07-18", to: "awaiting-approval", by: "yh" },
          { at: "2026-07-20", to: "triage", by: "yh" },
        ],
      }),
      spec,
      NOW,
    );
    const sentBack = out.edges.find((edge) => edge.from === "awaiting-approval");
    expect(sentBack).toMatchObject({ to: "triage", style: "dotted" });
    expect(sentBack?.label).toContain("sent back");
    expect(out.title).toContain("1 bounce");
    // The stage is drawn once, visited twice, and says so.
    expect(out.nodes.filter((node) => node.id === "triage")).toHaveLength(1);
    expect(out.nodes.find((node) => node.id === "triage")?.label).toContain("visit 2");
  });

  it("does not draw a migration relabel as a journey the request took", () => {
    const out = requestPathDiagram(
      request({
        stage: "triage",
        history: [
          { at: "2026-07-14", to: "intake", by: "yh" },
          { at: "2026-07-16", to: "triage", by: "yh", migration: true, from: "screening" },
        ],
      }),
      spec,
      NOW,
    );
    expect(out.nodes.map((node) => node.id)).not.toContain("screening");
  });

  it("stops the clock at a terminal stage rather than ageing a delivered request", () => {
    const out = requestPathDiagram(
      request({
        stage: "delivered",
        history: [
          { at: "2026-07-14", to: "intake", by: "yh" },
          { at: "2026-07-16", to: "delivered", by: "yh" },
        ],
      }),
      spec,
      NOW,
    );
    const end = out.nodes.find((node) => node.id === "delivered");
    expect(end?.state).toBe("done");
    expect(end?.label).not.toContain("12 days");
  });

  it("says there is no history rather than drawing an empty box", () => {
    const out = requestPathDiagram(request({ history: [] }), spec, NOW);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]?.label).toContain("No history");
    expect(out.edges).toEqual([]);
  });
});

describe("dataFlowDiagram", () => {
  it("draws source, extraction, identifier scope and recipient", () => {
    const out = dataFlowDiagram(request(), NOW);
    const labels = out.nodes.map((node) => node.label);
    expect(labels.some((label) => label.startsWith("SCDB collection"))).toBe(true);
    expect(labels).toContain("Identifiers: indirect");
    expect(labels).toContain("Recipient: Dr A Tan");
    expect(out.source).toBe("data-flow");
  });

  it("draws an unmet control in red rather than leaving it out", () => {
    const out = dataFlowDiagram(request(), NOW);
    const dua = out.nodes.find((node) => node.label.startsWith("Dua:"));
    expect(dua).toMatchObject({ state: "overdue" });
    expect(out.edges.some((edge) => edge.from === dua?.id && edge.label === "blocked")).toBe(true);
  });

  it("clears a control that is satisfied", () => {
    const out = dataFlowDiagram(
      request({
        governance: { identifiers: "none", dua: { status: "not-required" } },
      }),
      NOW,
    );
    expect(out.nodes.find((node) => node.label.startsWith("Dua:"))?.state).toBe("on-track");
    expect(out.nodes.find((node) => node.label.startsWith("Identifiers:"))?.state).toBe("on-track");
  });

  it("says so when the note records no governance instrument at all", () => {
    const out = dataFlowDiagram(request({ governance: {} }), NOW);
    const none = out.nodes.find((node) => node.label.includes("No governance instrument"));
    expect(none?.state).toBe("overdue");
  });

  it("carries counts and scopes, never a name from the data itself", () => {
    const out = dataFlowDiagram(
      request({ data_scope: { years: [2019, 2025], n_records_est: 4200 } }),
      NOW,
    );
    expect(out.nodes.some((node) => node.label.includes("2019–2025"))).toBe(true);
    expect(out.nodes.some((node) => node.label.includes("~4200 records"))).toBe(true);
  });

  it("marks direct identifiers as the loudest thing on the page", () => {
    const out = dataFlowDiagram(request({ governance: { identifiers: "direct" } }), NOW);
    expect(out.nodes.find((node) => node.label === "Identifiers: direct")?.state).toBe("overdue");
  });
});
