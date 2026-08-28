import { describe, expect, it } from "vitest";
import { emptyDiagram, type DiagramSpec } from "./diagram";
import { FALLBACK_PALETTE, escapeLabel, safeColour, toMermaid, toMermaidBlock } from "./mermaid";

function spec(over: Partial<DiagramSpec> = {}): DiagramSpec {
  return {
    ...emptyDiagram("T"),
    nodes: [
      { id: "a", label: "Intake", shape: "box", state: "none", note: "" },
      { id: "b", label: "Triage", shape: "diamond", state: "none", note: "" },
    ],
    edges: [{ from: "a", to: "b", label: "", style: "solid" }],
    ...over,
  };
}

describe("escapeLabel — the injection surface", () => {
  it("escapes the hash first, and does not re-escape its own output", () => {
    // A second pass over the string would turn the "#" of "#34;" into "#35;34;".
    expect(escapeLabel('a"b')).toBe("a#34;b");
    expect(escapeLabel("C#")).toBe("C#35;");
  });

  it("neutralises markup that would otherwise reach an HTML label", () => {
    const out = escapeLabel('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain('"');
    expect(out).toContain("#60;");
  });

  it("neutralises characters that would close the label or become syntax", () => {
    for (const char of ["[", "]", "(", ")", "{", "}", "|", "`"]) {
      expect(escapeLabel(`x${char}y`)).not.toContain(char);
    }
    // A semicolon is the one that cannot be checked that way: every escape this
    // function emits ends in one.
    expect(escapeLabel("x;y")).toBe("x#59;y");
  });

  it("collapses newlines rather than emitting a line-break tag", () => {
    expect(escapeLabel("one\ntwo\tthree")).toBe("one two three");
    expect(escapeLabel("one\ntwo")).not.toContain("br");
  });

  it("leaves ordinary text, accents and dashes alone", () => {
    expect(escapeLabel("Awaiting approval – Zoë Müller")).toBe("Awaiting approval – Zoë Müller");
  });
});

describe("safeColour", () => {
  it("keeps hex and bare keywords", () => {
    expect(safeColour("#b3261e", "x")).toBe("#b3261e");
    expect(safeColour("#fff", "x")).toBe("#fff");
    expect(safeColour("transparent", "x")).toBe("transparent");
  });

  it("refuses anything carrying a comma, a space or a semicolon", () => {
    expect(safeColour("hsl(258, 88%, 66%)", "#fallback")).toBe("#fallback");
    expect(safeColour("rgb(1, 2, 3)", "#fallback")).toBe("#fallback");
    expect(safeColour("rgba(1,2,3,0.5)", "#fallback")).toBe("#fallback");
    expect(safeColour("red;stroke:blue", "#fallback")).toBe("#fallback");
    expect(safeColour("", "#fallback")).toBe("#fallback");
  });
});

describe("toMermaid", () => {
  it("opens with the direction and draws each node in its shape", () => {
    const out = toMermaid(spec());
    expect(out.split("\n")[0]).toBe("flowchart TD");
    expect(out).toContain('a["Intake"]');
    expect(out).toContain('b{"Triage"}');
    expect(out).toContain("a --> b");
  });

  it("labels an edge without letting the label escape the pipes", () => {
    const out = toMermaid(spec({ edges: [{ from: "a", to: "b", label: "3 days|x", style: "dotted" }] }));
    expect(out).toContain('a -.->|"3 days#124;x"| b');
  });

  it("reduces an id that would otherwise be syntax", () => {
    const out = toMermaid(
      spec({
        nodes: [
          { id: "a-->b", label: "Sneaky", shape: "box", state: "none", note: "" },
          { id: "b", label: "Real", shape: "box", state: "none", note: "" },
        ],
        edges: [{ from: "a-->b", to: "b", label: "", style: "solid" }],
      }),
    );
    expect(out).not.toContain("a-->b[");
    expect(out).toContain('a___b["Sneaky"]');
    expect(out).toContain("a___b --> b");
  });

  it("keeps two ids apart when they sanitise to the same thing", () => {
    const out = toMermaid(
      spec({
        nodes: [
          { id: "a.b", label: "One", shape: "box", state: "none", note: "" },
          { id: "a b", label: "Two", shape: "box", state: "none", note: "" },
        ],
        edges: [],
      }),
    );
    expect(out).toContain('a_b["One"]');
    expect(out).toContain('a_b_2["Two"]');
  });

  it("never draws a node an edge invented", () => {
    // parseDiagram drops dangling edges, but a hand-built spec can carry one and
    // Mermaid would happily invent a box for it.
    const out = toMermaid(spec({ edges: [{ from: "a", to: "ghost", label: "", style: "solid" }] }));
    expect(out).not.toContain("ghost");
  });

  it("prefixes a glyph so state is never colour alone", () => {
    const out = toMermaid(
      spec({
        nodes: [{ id: "a", label: "Approval", shape: "box", state: "overdue", note: "" }],
        edges: [],
      }),
    );
    expect(out).toContain('a["! Approval"]');
    expect(out).toContain("classDef scdbOverdue");
    expect(out).toContain("class a scdbOverdue");
  });

  it("carries no colour machinery when nothing is coloured", () => {
    expect(toMermaid(spec())).not.toContain("classDef");
  });

  it("quiets the uncoloured nodes once anything else is coloured", () => {
    // Left to Mermaid's own theme an uncoloured node is a confident lavender,
    // which reads louder than the states that mean something. Only worth doing
    // when there is something to contrast with — hence the test above.
    const out = toMermaid(
      spec({
        nodes: [
          { id: "a", label: "Plain", shape: "box", state: "none", note: "" },
          { id: "b", label: "Late", shape: "box", state: "overdue", note: "" },
        ],
        edges: [],
      }),
    );
    expect(out).toContain("classDef scdbNone");
    expect(out).toContain("class a scdbNone");
    // The neutral is declared before the states that have to stand out against it.
    expect(out.indexOf("classDef scdbNone")).toBeLessThan(out.indexOf("classDef scdbOverdue"));
  });

  it("uses the palette it is handed, so an export is self-contained", () => {
    const out = toMermaid(
      spec({
        nodes: [{ id: "a", label: "A", shape: "box", state: "done", note: "" }],
        edges: [],
      }),
      {
        palette: {
          ...{
            none: { fill: "a", stroke: "b", text: "c" },
            overdue: { fill: "a", stroke: "b", text: "c" },
            "at-risk": { fill: "a", stroke: "b", text: "c" },
            "on-track": { fill: "a", stroke: "b", text: "c" },
            blocked: { fill: "a", stroke: "b", text: "c" },
          },
          done: { fill: "#111", stroke: "#222", text: "#333" },
        },
      },
    );
    expect(out).toContain("classDef scdbDone fill:#111,stroke:#222,color:#333");
  });

  it("refuses a palette colour that would break the classDef parser", () => {
    // The failure that only showed up in Obsidian: the default theme's accent
    // resolves to `hsl(258, 88%, 66%)`, and `classDef` is a comma-separated
    // list, so those two commas turned one declaration into four and Mermaid
    // failed the entire diagram with a parse error.
    const out = toMermaid(
      spec({
        nodes: [{ id: "a", label: "A", shape: "box", state: "blocked", note: "" }],
        edges: [],
      }),
      {
        palette: {
          ...FALLBACK_PALETTE,
          blocked: { fill: "hsl(258, 88%, 66%)", stroke: "rgb(1, 2, 3)", text: "#123456" },
        },
      },
    );
    const classDef = out.split("\n").find((line) => line.includes("classDef"))!;
    expect(classDef).not.toContain("hsl");
    expect(classDef).not.toContain("rgb");
    expect(classDef).toContain("color:#123456");
    // Four declarations, no more: fill, stroke, color, stroke-width.
    expect(classDef.trim().split(",")).toHaveLength(4);
  });

  it("wraps in a fence Obsidian renders", () => {
    const block = toMermaidBlock(spec());
    expect(block.startsWith("```mermaid\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
  });
});
