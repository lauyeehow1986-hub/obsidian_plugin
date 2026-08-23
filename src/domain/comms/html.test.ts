import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "./html";

describe("entities", () => {
  it("decodes the named ones mail is full of", () => {
    expect(decodeEntities("Tom &amp; Jerry &ndash; &ldquo;quoted&rdquo;")).toBe(
      "Tom & Jerry – “quoted”",
    );
  });

  it("decodes decimal and hex references", () => {
    expect(decodeEntities("&#8364;20 and &#x2019;s")).toBe("€20 and ’s");
  });

  it("leaves an out-of-range reference alone rather than throwing", () => {
    // `String.fromCodePoint` throws on these, and an importer that dies on one
    // malformed entity is one nobody can complete or explain.
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
  });

  it("leaves an entity it does not know alone", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("htmlToText", () => {
  it("turns block ends into line breaks", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\n\nTwo");
  });

  it("keeps a line break", () => {
    expect(htmlToText("Regards,<br>A Tan")).toBe("Regards,\nA Tan");
  });

  it("marks list items so a list stays legible", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  });

  it("drops script and style content entirely", () => {
    // Not merely the tags: the content is code, and leaving it in would put a
    // block of JavaScript into the vault as though it were prose.
    expect(htmlToText("<style>p{color:red}</style><p>Hello</p>")).toBe("Hello");
    expect(htmlToText("<script>alert(1)</script><p>Hello</p>")).toBe("Hello");
  });

  it("drops comments, where mail clients hide conditional markup", () => {
    expect(htmlToText("<!--[if mso]><p>outlook</p><![endif]--><p>Hello</p>")).toBe("Hello");
  });

  it("does not fetch anything for an image", () => {
    // The whole reason this is string work: constructing a DOM would load the
    // remote image, which is a network call on content a sender chose (rule 3).
    expect(htmlToText('<p>Hi</p><img src="https://tracker.example/x.gif">')).toBe("Hi");
  });

  it("collapses the indentation a mail client's HTML is full of", () => {
    const html = "<div>\n    <p>\n      Approved.\n    </p>\n</div>";
    expect(htmlToText(html)).toBe("Approved.");
  });

  it("collapses a run of blank lines to one", () => {
    expect(htmlToText("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
  });

  it("removes a non-breaking space that would fake an indent", () => {
    expect(htmlToText("<p>&nbsp;&nbsp;spaced</p>")).toBe("spaced");
  });

  it("separates table cells rather than running the words together", () => {
    expect(htmlToText("<table><tr><td>REQ-2026-014</td><td>approved</td></tr></table>")).toBe(
      "REQ-2026-014 approved",
    );
  });

  it("returns nothing for markup with no text in it", () => {
    expect(htmlToText("<html><head><title>x</title></head><body></body></html>")).toBe("");
  });
});
