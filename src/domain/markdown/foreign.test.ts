import { describe, expect, it } from "vitest";
import { collapse, foreignLine, foreignText, startOfLine } from "./foreign";

describe("neutralising text from outside the vault", () => {
  it("stops a fetched title becoming a link to a real person", () => {
    const out = foreignText("Outcomes reported by [[Dr A Tan]]");
    expect(out).not.toContain("[[");
    expect(out).toBe("Outcomes reported by \\[\\[Dr A Tan\\]\\]");
  });

  it("stops a fetched title embedding a note", () => {
    // The one that matters most: an embed would transclude the contents of a
    // request note into the briefing, inside a vault §5.10 calls a regulated
    // data store.
    const out = foreignText("A study ![[10 Requests/REQ-2026-014]]");
    expect(out).not.toMatch(/!\[\[/);
  });

  it("stops a pipe reshaping a table row", () => {
    expect(foreignText("Phase II | see notes")).toBe("Phase II \\| see notes");
  });

  it("stops a backtick swallowing the rest of the line", () => {
    expect(foreignText("Effect of `code` on outcome")).toBe("Effect of \\`code\\` on outcome");
  });

  it("escapes the backslash itself, so an escape cannot be smuggled in", () => {
    // Without this, a title containing \[[x]] would emerge as \\[[x]] and the
    // wikilink would be live again.
    expect(foreignText("a \\[[x]]")).toBe("a \\\\\\[\\[x\\]\\]");
  });

  it("stops a fetched value becoming live HTML", () => {
    // Obsidian renders inline HTML inside a note, so an angle bracket arriving
    // from outside is markup rather than text. This surfaced with the RSS
    // guideline feeds, where a title may legitimately carry an escaped tag
    // that the XML decode then turns back into a real one.
    expect(foreignText("<script>alert(1)</script>")).toBe(
      // The slash is not escaped, and should not be: it carries no markdown
      // meaning, and escaping more than necessary makes titles unreadable.
      "\\<script\\>alert(1)\\</script\\>",
    );
    // Asserted as the escaped form rather than "does not contain `<img`":
    // `\<img` contains that substring too, so the negative would pass on
    // unescaped output as well and prove nothing.
    expect(foreignText('<img src=x onerror="go()">')).toBe('\\<img src=x onerror="go()"\\>');
  });

  it("keeps a comparison operator readable in a title", () => {
    // The escape must not make ordinary scientific prose look broken: a
    // backslash renders as nothing, and the character survives.
    expect(foreignText("LVEF <40%")).toBe("LVEF \\<40%");
  });

  it("keeps the text readable rather than stripping it", () => {
    // A title someone will compare against the source has to survive intact.
    expect(foreignText("[Article in French]")).toBe("\\[Article in French\\]");
    expect(foreignText("Phase I/II dose finding")).toBe("Phase I/II dose finding");
  });

  it("flattens a value that spans lines", () => {
    expect(foreignText("Two\nlines\there")).toBe("Two lines here");
  });

  it("removes control characters without joining words", () => {
    // A NUL or a bell is deleted outright; a newline becomes the space that
    // keeps "a" and "b" two words rather than one.
    expect(foreignText("a\u0000\u0007b")).toBe("ab");
    expect(foreignText("a\nb")).toBe("a b");
    expect(foreignText("a\u007Fb")).toBe("ab");
  });
});

describe("text that starts a line", () => {
  it("stops a leading marker changing the block type", () => {
    expect(foreignLine("# Not a deeper heading")).toBe("\\# Not a deeper heading");
    expect(foreignLine("> quoted")).toBe("\\> quoted");
    expect(foreignLine("- item")).toBe("\\- item");
    expect(foreignLine("1. item")).toBe("\\1. item");
  });

  it("does not escape a marker that cannot open a block", () => {
    // The defect this replaced: `*` was escaped unconditionally, which ate the
    // emphasis marker the briefing writes around a journal name and produced
    // a stray backslash with no italics. In CommonMark a bullet needs
    // whitespace after the marker; emphasis is not a list.
    expect(startOfLine("*Annals of medicine*")).toBe("*Annals of medicine*");
    expect(startOfLine("#hashtag")).toBe("#hashtag");
    expect(startOfLine("2026 Dec")).toBe("2026 Dec");
    expect(foreignLine("Grade 3 - 4 toxicity")).toBe("Grade 3 - 4 toxicity");
  });

  it("still escapes the forms that do open a block", () => {
    expect(startOfLine("* bulleted")).toBe("\\* bulleted");
    expect(startOfLine("## A subheading")).toBe("\\## A subheading");
    expect(startOfLine("=")).toBe("\\=");
  });

  it("escapes once, because one backslash makes it a paragraph", () => {
    // After the first character is escaped the line cannot open a block at
    // all, so escaping the rest would only add visible backslashes.
    expect(startOfLine("## A subheading")).not.toContain("\\#\\#");
  });

  it("leaves already-escaped text alone when only the line start matters", () => {
    // startOfLine is for joins of values foreignText has already handled;
    // running foreignText again would escape its own backslashes.
    expect(startOfLine("\\[a\\] and \\[b\\]")).toBe("\\[a\\] and \\[b\\]");
    expect(startOfLine("- \\[a\\]")).toBe("\\- \\[a\\]");
  });

  it("leaves an ordinary title alone", () => {
    expect(foreignLine("Left ventricular ejection fraction")).toBe(
      "Left ventricular ejection fraction",
    );
  });
});

describe("collapse, for frontmatter", () => {
  it("does not escape, because YAML would store the backslashes", () => {
    expect(collapse("[Article in French]")).toBe("[Article in French]");
  });

  it("still flattens and trims", () => {
    expect(collapse("  a \n\n b  ")).toBe("a b");
  });
});
