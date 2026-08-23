import { describe, expect, it } from "vitest";
import { itemKey, matchPerson, scanMinutes, type MinutesInput } from "./minutes";

const PEOPLE = ["Dr A Tan", "Example Coordinator", "Prof Invented Approver"];
const WED = "2026-08-19";

function scan(body: string, overrides: Partial<MinutesInput> = {}) {
  return scanMinutes({ content: body, anchor: WED, people: PEOPLE, ...overrides });
}

describe("scanMinutes — what counts as an item", () => {
  it("reads each marker as its own kind", () => {
    const { items } = scan(
      [
        "ACTION: chase the DUA",
        "DECISION: cohort extended to 2026",
        "DEADLINE: DSRB continuing review",
      ].join("\n"),
    );
    expect(items.map((item) => item.kind)).toEqual(["action", "decision", "deadline"]);
  });

  it("accepts the separators and dressing minutes are actually written in", () => {
    const { items } = scan(
      [
        "- **Action:** chase the DUA",
        "#### Decided - cohort extended",
        "> 1. TODO — write the SOP",
        "* Agreed) publish the list",
      ].join("\n"),
    );
    expect(items.map((item) => item.text)).toEqual([
      "chase the DUA",
      "cohort extended",
      "write the SOP",
      "publish the list",
    ]);
  });

  it("treats an unticked checkbox as an action and leaves a ticked one alone", () => {
    const result = scan(["- [ ] draft the note", "- [x] already sent the file"].join("\n"));
    expect(result.items.map((item) => item.text)).toEqual(["draft the note"]);
    expect(result.done).toBe(1);
  });

  it("does not treat AI: as an action item", () => {
    expect(scan("AI: consider a triage model").items).toEqual([]);
  });

  it("ignores a marker word used in a sentence rather than as a label", () => {
    expect(scan("Action items were discussed at length.").items).toEqual([]);
  });

  it("skips a marker that records there was nothing", () => {
    expect(scan(["Actions: none", "Decisions: N/A"].join("\n")).items).toEqual([]);
  });

  it("counts a line once when the same sentence is minuted twice", () => {
    const { items } = scan(["ACTION: chase the DUA", "Action - Chase the DUA."].join("\n"));
    expect(items).toHaveLength(1);
    expect(items[0]?.line).toBe(1);
  });
});

describe("scanMinutes — line numbers", () => {
  it("counts from the start of the body, not of the file", () => {
    const content = ["---", "type: meeting", "date: 2026-08-19", "---", "", "ACTION: chase"].join(
      "\n",
    );
    expect(scan(content).items[0]?.line).toBe(2);
  });

  it("does not move when frontmatter grows — which is what extraction itself does", () => {
    // Eight items add roughly fifty lines of manifest above the prose. A
    // file-relative number frozen onto a created note would be wrong the
    // moment the run that wrote it finished.
    const body = ["", "ACTION: chase"];
    const before = ["---", "type: meeting", "---", ...body].join("\n");
    const after = ["---", "type: meeting", "extractions:", "  - key: abc", "---", ...body].join(
      "\n",
    );
    expect(scan(after).items[0]?.line).toBe(scan(before).items[0]?.line);
  });

  it("does not read frontmatter as minutes", () => {
    const content = ["---", "title: Action: something", "---", "ACTION: real one"].join("\n");
    expect(scan(content).items.map((item) => item.text)).toEqual(["real one"]);
  });
});

describe("scanMinutes — who owns it", () => {
  it("honours a wikilink the user typed", () => {
    const { items } = scan("ACTION: [[Dr A Tan]] to countersign the DUA");
    expect(items[0]?.owner).toEqual({ ref: "[[Dr A Tan]]", name: "Dr A Tan", known: true });
    expect(items[0]?.text).toBe("countersign the DUA");
  });

  it("keeps a link to someone with no note, and says so rather than dropping it", () => {
    const { items } = scan("ACTION: [[Dr Nobody]] to review");
    expect(items[0]?.owner).toEqual({ ref: "[[Dr Nobody]]", name: "Dr Nobody", known: false });
    expect(items[0]?.problems[0]?.message).toMatch(/no note for Dr Nobody/);
  });

  it("resolves a surname against the people the vault knows", () => {
    const { items } = scan("ACTION: Tan to countersign the DUA");
    expect(items[0]?.owner).toEqual({ ref: "[[Dr A Tan]]", name: "Dr A Tan", known: true });
    expect(items[0]?.text).toBe("countersign the DUA");
  });

  it("refuses to pick between two people with the same surname", () => {
    const { items } = scan("ACTION: Tan to countersign", { people: ["Dr A Tan", "Dr B Tan"] });
    expect(items[0]?.owner).toBeNull();
    expect(items[0]?.problems[0]?.message).toMatch(/More than one person is called "Tan"/);
  });

  it("invents nobody from a name the vault has never heard of", () => {
    const { items } = scan("ACTION: Everyone to review the draft");
    expect(items[0]?.owner).toBeNull();
    expect(items[0]?.text).toBe("Everyone to review the draft");
    expect(items[0]?.problems).toEqual([]);
  });

  it("resolves an @handle by initials, and complains when it matches nobody", () => {
    expect(scan("ACTION: @AT to sign").items[0]?.owner?.name).toBe("Dr A Tan");
    expect(scan("ACTION: @zz to sign").items[0]?.problems[0]?.message).toMatch(/does not match anyone/);
  });
});

describe("matchPerson", () => {
  it("prefers a whole-name match over a surname one", () => {
    expect(matchPerson("A Tan", ["Dr A Tan", "Dr B Tan"])).toEqual({ name: "Dr A Tan" });
  });

  it("ignores honorifics on both sides", () => {
    expect(matchPerson("Dr Tan", PEOPLE)).toEqual({ name: "Dr A Tan" });
  });

  it("returns nothing rather than a partial guess", () => {
    expect(matchPerson("Lim", PEOPLE)).toBeNull();
    expect(matchPerson("", PEOPLE)).toBeNull();
  });
});

describe("scanMinutes — dates", () => {
  it("reads the deadline out and leaves a clean title", () => {
    const { items } = scan("ACTION: [[Dr A Tan]] to countersign the DUA by Friday");
    expect(items[0]?.due?.date).toBe("2026-08-21");
    expect(items[0]?.due?.from).toBe("weekday");
    expect(items[0]?.text).toBe("countersign the DUA");
  });

  it("leaves an action with no date undated rather than assuming one", () => {
    expect(scan("ACTION: draft the SOP").items[0]?.due).toBeNull();
  });

  it("passes the refusal to read an ambiguous date through to the item", () => {
    const { items } = scan("ACTION: chase by 03/04/2026");
    expect(items[0]?.due).toBeNull();
    expect(items[0]?.problems[0]?.message).toMatch(/day-first or month-first/);
  });

  it("refuses relative dates when the minutes carry no date of their own", () => {
    const { items } = scan("ACTION: chase by Friday", { anchor: "" });
    expect(items[0]?.due).toBeNull();
    expect(items[0]?.problems[0]?.message).toMatch(/minutes carry no date/);
  });
});

describe("itemKey", () => {
  it("is the same for the same words written differently", () => {
    expect(itemKey("action", "Chase the DUA.")).toBe(itemKey("action", "chase   the dua"));
  });

  it("differs by kind, so a decision and an action never collide", () => {
    expect(itemKey("action", "chase the DUA")).not.toBe(itemKey("decision", "chase the DUA"));
  });

  it("changes when the words change, so an edited line is offered again", () => {
    expect(itemKey("action", "chase the DUA")).not.toBe(itemKey("action", "chase the IRB"));
  });
});
