import { describe, expect, it } from "vitest";

import { NEVER_OPEN, parseLaunchTargets } from "./target";

/** Indexing under `noUncheckedIndexedAccess`: fail loudly rather than on undefined. */
function only<T>(items: readonly T[], what: string): T {
  const [first] = items;
  if (first === undefined) throw new Error(`expected at least one ${what}`);
  return first;
}

/** The nth item, with the same guarantee. */
function at<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`expected an item at ${index}`);
  return found;
}


function parse(yamlish: unknown) {
  return parseLaunchTargets(yamlish);
}

const URL_TARGET = {
  id: "edata",
  label: "Open in eData",
  kind: "url",
  template: "https://edata.example.org/request/{external_ref}",
  applies_to: "scdb-request",
  field: "external_ref",
  pattern: "^[A-Za-z0-9-]{3,40}$",
};

const FILE_TARGET = {
  id: "sop-library",
  label: "Open SOP",
  kind: "file",
  root: "\\\\fileserver\\SOPs",
  extensions: ["pdf", "docx"],
};

describe("reading _config/launchers.yaml", () => {
  it("takes a well-formed url target", () => {
    const { targets, problems } = parse({ targets: [URL_TARGET] });
    expect(problems).toEqual([]);
    expect(targets).toHaveLength(1);
    expect(only(targets, "target").id).toBe("edata");
    expect(only(targets, "target").appliesTo).toBe("scdb-request");
    expect(only(targets, "target").pattern?.source).toBe("^[A-Za-z0-9-]{3,40}$");
  });

  it("takes file and folder targets", () => {
    const { targets, problems } = parse({
      targets: [FILE_TARGET, { id: "sop-folder", kind: "folder", root: "\\\\fileserver\\SOPs" }],
    });
    expect(problems).toEqual([]);
    expect(targets.map((t) => t.kind)).toEqual(["file", "folder"]);
    // A folder needs no extensions: it opens a file manager, not a document.
    expect(at(targets, 1).extensions).toEqual([]);
  });

  it("says so rather than throwing when the file is not a mapping", () => {
    expect(only(parse("hello").problems, "problem").message).toContain("not a YAML mapping");
    expect(only(parse({ nothing: 1 }).problems, "problem").message).toContain("targets:");
  });

  it("is empty and silent on an empty file", () => {
    // An absent config is the default state, not a misconfiguration.
    expect(parse(null)).toEqual({ targets: [], problems: [] });
  });
});

describe("refusals that keep a config mistake from becoming a launch", () => {
  it("drops both targets when two share an id", () => {
    const { targets, problems } = parse({
      targets: [URL_TARGET, { ...URL_TARGET, template: "https://elsewhere.example.org/{external_ref}" }],
    });
    expect(targets).toEqual([]);
    expect(only(problems, "problem").message).toContain('share the id "edata"');
  });

  it("refuses a template that is not https", () => {
    for (const template of [
      "http://edata.example.org/{external_ref}",
      "file:///C:/somewhere/{external_ref}",
      "javascript:alert(1)",
    ]) {
      const { targets, problems } = parse({ targets: [{ ...URL_TARGET, template }] });
      expect(targets).toEqual([]);
      expect(only(problems, "problem").message).toContain("https://");
    }
  });

  it("refuses a placeholder in the host, where a note would choose the server", () => {
    const { targets, problems } = parse({
      targets: [{ ...URL_TARGET, template: "https://{external_ref}.example.org/r" }],
    });
    expect(targets).toEqual([]);
    expect(only(problems, "problem").message).toContain("in the host");
  });

  it("refuses more than one placeholder, so exactly one part is checked", () => {
    const { targets, problems } = parse({
      targets: [{ ...URL_TARGET, template: "https://e.example.org/{external_ref}/{id}" }],
    });
    expect(targets).toEqual([]);
    expect(only(problems, "problem").message).toContain("at most one field");
  });

  it("refuses a placeholder the field does not name", () => {
    const { targets, problems } = parse({
      targets: [{ ...URL_TARGET, template: "https://e.example.org/{uid}" }],
    });
    expect(targets).toEqual([]);
    expect(only(problems, "problem").message).toContain("{uid}");
  });

  it("refuses a pattern that is not a regular expression", () => {
    const { targets, problems } = parse({ targets: [{ ...URL_TARGET, pattern: "^[unclosed" }] });
    expect(targets).toEqual([]);
    expect(only(problems, "problem").message).toContain("not a valid regular expression");
  });

  it("refuses a file or folder target with no root", () => {
    for (const kind of ["file", "folder"]) {
      const { targets, problems } = parse({ targets: [{ id: "x", kind, extensions: ["pdf"] }] });
      expect(targets).toEqual([]);
      expect(only(problems, "problem").message).toContain("`root`");
    }
  });

  it("refuses a file target with no extensions", () => {
    const { targets, problems } = parse({ targets: [{ ...FILE_TARGET, extensions: [] }] });
    expect(targets).toEqual([]);
    expect(only(problems, "problem").message).toContain("non-empty `extensions`");
  });

  it("refuses every executable extension by name, however the config asks", () => {
    // Not silently dropped: someone wrote it down meaning it, and a config that
    // looks accepted but never fires is worse than one that says why.
    for (const ext of ["exe", "bat", "ps1", "lnk", "hta", "js", "msi", "url", "scr"]) {
      expect(NEVER_OPEN).toContain(ext);
      const { targets, problems } = parse({ targets: [{ ...FILE_TARGET, extensions: ["pdf", ext] }] });
      expect(targets, `${ext} should not produce a usable target`).toEqual([]);
      expect(only(problems, "problem").message).toContain(ext);
      expect(only(problems, "problem").message).toContain("executes when opened");
    }
  });

  it("keeps the good targets when one entry is bad", () => {
    const { targets, problems } = parse({ targets: [URL_TARGET, { id: "bad", kind: "wat" }] });
    expect(targets.map((t) => t.id)).toEqual(["edata"]);
    expect(problems).toHaveLength(1);
  });

  it("normalises extensions and drops duplicates", () => {
    const { targets } = parse({ targets: [{ ...FILE_TARGET, extensions: [".PDF", "pdf", "Docx"] }] });
    expect(only(targets, "target").extensions).toEqual(["pdf", "docx"]);
  });
});
