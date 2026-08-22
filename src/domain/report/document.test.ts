import { describe, expect, it } from "vitest";
import { renderDocument, type ReportDocument } from "./document";
import { el } from "./element";

function doc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    title: "Request queue",
    subtitle: "9 live requests · 2 overdue",
    generatedAt: "2026-08-22 14:03",
    sections: [{ heading: "SCDB triage", lede: "3 requests", body: el("p", {}, "body") }],
    ...overrides,
  };
}

describe("the exported file is self-contained", () => {
  // The whole point of the export is a file that opens on a machine with no
  // Obsidian, no plugin and no network (§7 A3). Each of these would break that.
  const html = renderDocument(doc());

  it("carries its own stylesheet inline", () => {
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link");
  });

  it("makes no external request of any kind", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bsrc=/);
    expect(html).not.toContain("@import");
  });

  it("runs no script", () => {
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("is a complete document a browser will render in standards mode", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>Request queue</title>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("includes a print stylesheet, because this gets printed", () => {
    expect(html).toContain("@media print");
    expect(html).toContain("print-color-adjust: exact");
  });
});

describe("provenance", () => {
  it("says when it was generated and refuses to pose as the official record", () => {
    // §5.1: the institutional eData system is authoritative. A generated
    // document that implies otherwise is worse than no document.
    const html = renderDocument(doc());
    expect(html).toContain("2026-08-22 14:03");
    expect(html).toContain("not an official record");
    expect(html).toContain("eData system remains authoritative");
  });

  it("states the scope when the board was filtered", () => {
    const html = renderDocument(doc({ scope: "Head of SCDB work only; 4 not shown" }));
    expect(html).toContain("Head of SCDB work only; 4 not shown");
  });
});

describe("escaping", () => {
  it("escapes a title that came out of a note", () => {
    const html = renderDocument(doc({ title: "</title><script>alert(1)</script>" }));
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes section content", () => {
    const html = renderDocument(
      doc({ sections: [{ heading: "<b>h</b>", body: el("p", {}, "<i>x</i>") }] }),
    );
    expect(html).not.toContain("<b>h</b>");
    expect(html).not.toContain("<i>x</i>");
  });
});
