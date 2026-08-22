import { describe, expect, it } from "vitest";
import { el, escapeAttr, escapeText, textOf, toHtml } from "./element";

describe("serialising a tree", () => {
  it("nests elements and text", () => {
    expect(toHtml(el("p", { class: "x" }, "hello ", el("strong", {}, "world")))).toBe(
      '<p class="x">hello <strong>world</strong></p>',
    );
  });

  it("skips a closing tag for void elements", () => {
    expect(toHtml(el("br"))).toBe("<br>");
    expect(toHtml(el("meta", { charset: "utf-8" }))).toBe('<meta charset="utf-8">');
  });

  it("drops undefined and false attributes, and writes true as a bare one", () => {
    expect(toHtml(el("input", { hidden: true, disabled: false, value: undefined }))).toBe(
      "<input hidden>",
    );
  });

  it("renders numbers, and treats null, undefined and false as nothing", () => {
    expect(toHtml(el("p", {}, 42, null, undefined, false))).toBe("<p>42</p>");
  });
});

describe("escaping, which is the whole point of the serialiser", () => {
  // Every value in a tree comes from a note. §8: vault-derived content never
  // goes near raw markup.
  it("escapes text content", () => {
    expect(escapeText('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(\"x\")&lt;/script&gt;",
    );
  });

  it("escapes quotes in attributes, so a value cannot close its own quoting", () => {
    expect(escapeAttr('" onload="evil()')).toBe("&quot; onload=&quot;evil()");
  });

  it("carries both through a real tree", () => {
    const html = toHtml(el("div", { title: 'a" b' }, "<b>not bold</b>"));
    expect(html).toBe('<div title="a&quot; b">&lt;b&gt;not bold&lt;/b&gt;</div>');
    expect(html).not.toContain("<b>");
  });

  it("escapes the ampersand first, so an escape is not double-escaped wrongly", () => {
    expect(escapeText("&lt;")).toBe("&amp;lt;");
  });
});

describe("textOf", () => {
  it("collects the words a chart shows, for assertions about labelling", () => {
    expect(textOf(el("p", {}, "a", el("span", {}, "b"), null))).toBe("a b");
  });
});
