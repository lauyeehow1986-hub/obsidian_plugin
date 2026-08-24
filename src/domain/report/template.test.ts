import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATES } from "./builtins";
import { BLOCK_KINDS, parseTemplate, templateToPlain } from "./template";

describe("parseTemplate", () => {
  it("reads a template", () => {
    const { template, problems } = parseTemplate(
      {
        id: "demo",
        label: "Demo",
        period: "month",
        study: true,
        title: "Demo — {period}",
        sections: [
          { heading: "One", lede: "A line", blocks: [{ block: "request-queue" }] },
          { heading: "Two", blocks: ["Some prose."] },
        ],
      },
      "_config/reports/demo.yaml",
    );

    expect(problems).toEqual([]);
    expect(template?.period).toBe("month");
    expect(template?.study).toBe(true);
    expect(template?.path).toBe("_config/reports/demo.yaml");
    expect(template?.sections[1]?.blocks[0]).toEqual({ kind: "prose", text: "Some prose." });
  });

  it("refuses a file with no id, and one with no sections", () => {
    expect(parseTemplate({ sections: [] }).template).toBeNull();
    expect(parseTemplate({ id: "x" }).template).toBeNull();
    expect(parseTemplate("not a mapping").template).toBeNull();
  });

  it("names a block it does not recognise rather than interpreting it", () => {
    // Rule 12: a note may not become a way to make the plugin do something new.
    const { template, problems } = parseTemplate({
      id: "x",
      sections: [{ heading: "H", blocks: [{ block: "run-script" }, { block: "portfolio" }] }],
    });
    expect(problems[0]).toContain("run-script");
    expect(template?.sections[0]?.blocks).toEqual([{ kind: "portfolio" }]);
  });

  it("rejects an effort block with no dimension, naming the ones that exist", () => {
    const { problems } = parseTemplate({
      id: "x",
      sections: [{ heading: "H", blocks: [{ block: "effort" }, { block: "portfolio" }] }],
    });
    expect(problems[0]).toMatch(/activity/);
  });

  it("keeps an unheaded section that has blocks, and drops one that has neither", () => {
    const withBlock = parseTemplate({
      id: "x",
      sections: [{ heading: "", blocks: [{ block: "cv" }] }],
    });
    expect(withBlock.template?.sections).toHaveLength(1);

    const empty = parseTemplate({
      id: "x",
      sections: [{ lede: "orphan" }, { heading: "Real", blocks: [{ block: "portfolio" }] }],
    });
    expect(empty.problems[0]).toMatch(/neither a heading nor a block/);
    expect(empty.template?.sections).toHaveLength(1);
  });

  it("falls back to covering everything when the period is unreadable, and says so", () => {
    const { template, problems } = parseTemplate({
      id: "x",
      period: "fortnight",
      sections: [{ heading: "H", blocks: [{ block: "portfolio" }] }],
    });
    expect(template?.period).toBe("all");
    expect(problems[0]).toMatch(/fortnight/);
  });

  it("reads a query block through the saved-view parser", () => {
    const { template } = parseTemplate({
      id: "x",
      sections: [
        {
          heading: "H",
          blocks: [
            {
              block: "query",
              title: "Overdue",
              query: { types: ["scdb-request"], columns: ["id", "stage"] },
            },
          ],
        },
      ],
    });
    const block = template?.sections[0]?.blocks[0];
    expect(block?.kind).toBe("query");
    if (block?.kind !== "query") return;
    expect(block.query.types).toEqual(["scdb-request"]);
    expect(block.query.columns).toEqual(["id", "stage"]);
  });
});

describe("the built-in templates", () => {
  it("are the five B7 names", () => {
    expect(BUILT_IN_TEMPLATES.map((template) => template.id)).toEqual([
      "monthly-facility",
      "study-effort",
      "publication-list",
      "cv",
      "research-profile",
    ]);
  });

  it("round-trip through the YAML the user edits", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const { template: reread, problems } = parseTemplate(templateToPlain(template));
      expect(problems, template.id).toEqual([]);
      // `path` is where it was read from, so it is the one field that must
      // differ: a built-in has none until it is written out.
      expect({ ...reread, path: "" }, template.id).toEqual({ ...template, path: "" });
    }
  });

  it("only use blocks the engine knows", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      for (const section of template.sections) {
        for (const block of section.blocks) {
          expect(BLOCK_KINDS, `${template.id}/${block.kind}`).toContain(block.kind);
        }
      }
    }
  });

  it("declare a study parameter only where the title uses it", () => {
    for (const template of BUILT_IN_TEMPLATES) {
      expect(template.title.includes("{study}"), template.id).toBe(template.study);
    }
  });
});
