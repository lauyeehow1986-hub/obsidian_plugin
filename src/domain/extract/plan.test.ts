import { describe, expect, it } from "vitest";
import { scanMinutes, type ExtractedItem } from "./minutes";
import {
  auditDetail,
  destinationFor,
  planExtraction,
  readExtractions,
  recordFor,
  type ExtractionRecord,
} from "./plan";

const PEOPLE = ["Dr A Tan"];
const WED = "2026-08-19";
const NOON = new Date(2026, 7, 24, 12, 30).getTime();

function items(body: string): ExtractedItem[] {
  return scanMinutes({ content: body, anchor: WED, people: PEOPLE }).items;
}

const MINUTES = [
  "ACTION: [[Dr A Tan]] to countersign the DUA by Friday",
  "ACTION: draft the extraction SOP",
  "DECISION: cohort extended to 2026",
].join("\n");

function allKeys(list: readonly ExtractedItem[]): Set<string> {
  return new Set(list.map((item) => item.key));
}

describe("destinationFor", () => {
  it("sends a dated action to the events folder and an undated one to the inbox", () => {
    const [dated, undated] = items(MINUTES);
    expect(destinationFor(dated!)).toBe("event");
    expect(destinationFor(undated!)).toBe("capture");
  });

  it("gives a decision no note of its own", () => {
    expect(destinationFor(items(MINUTES)[2]!)).toBe("decision");
  });

  it("sends an undated deadline to the inbox, because nothing can watch a date that is missing", () => {
    expect(destinationFor(items("DEADLINE: the annual report")[0]!)).toBe("capture");
  });
});

describe("planExtraction", () => {
  it("plans only what is ticked", () => {
    const found = items(MINUTES);
    const plan = planExtraction(found, new Set([found[0]!.key]), []);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.title).toBe("countersign the DUA");
    expect(plan.duplicates).toEqual([]);
  });

  it("holds back anything the meeting note has already been through", () => {
    const found = items(MINUTES);
    const existing: ExtractionRecord[] = [
      { key: found[0]!.key, kind: "action", line: 1, at: "2026-08-20T09:00", text: "…", to: "[[EVT-2026-001]]" },
    ];
    const plan = planExtraction(found, allKeys(found), existing);
    expect(plan.writes.map((write) => write.item.key)).toEqual([found[1]!.key, found[2]!.key]);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]?.record.to).toBe("[[EVT-2026-001]]");
  });

  it("holds a duplicate back even when it is ticked, because a tick cannot undo a write", () => {
    const found = items(MINUTES);
    const existing = [recordFor({ item: found[0]!, destination: "event", title: "x" }, "[[EVT-1]]", NOON)];
    expect(planExtraction(found, allKeys(found), existing).writes).toHaveLength(2);
  });

  it("plans nothing at all on a second run with nothing edited", () => {
    const found = items(MINUTES);
    const existing = found.map((item) =>
      recordFor({ item, destination: destinationFor(item), title: item.text }, "", NOON),
    );
    expect(planExtraction(found, allKeys(found), existing).writes).toEqual([]);
  });
});

describe("readExtractions", () => {
  it("reads the manifest back off a note", () => {
    expect(
      readExtractions([
        { key: "abc123", kind: "action", line: 4, at: "2026-08-24T12:30", text: "chase", to: "[[EVT-2026-001]]" },
      ]),
    ).toEqual([
      { key: "abc123", kind: "action", line: 4, at: "2026-08-24T12:30", text: "chase", to: "[[EVT-2026-001]]" },
    ]);
  });

  it("drops only the row somebody mangled, never the whole check", () => {
    const rows = readExtractions([{ kind: "action" }, "not a row", { key: "kept" }]);
    expect(rows.map((row) => row.key)).toEqual(["kept"]);
  });

  it("treats a note that has never been extracted as having nothing recorded", () => {
    expect(readExtractions(undefined)).toEqual([]);
    expect(readExtractions("extractions")).toEqual([]);
  });

  it("omits the link for a decision rather than writing an empty one", () => {
    const record = recordFor(
      { item: items(MINUTES)[2]!, destination: "decision", title: "cohort extended to 2026" },
      "",
      NOON,
    );
    expect(record).not.toHaveProperty("to");
    expect(record.at).toBe("2026-08-24T12:30");
    expect(record.text).toBe("cohort extended to 2026");
  });
});

describe("auditDetail", () => {
  it("records counts by destination and no note content", () => {
    const found = items(MINUTES);
    const plan = planExtraction(found, allKeys(found), []);
    expect(auditDetail(plan.writes)).toBe("1 deadline, 1 action to inbox, 1 decision");
    expect(auditDetail(plan.writes)).not.toMatch(/DUA|cohort|Tan/);
  });

  it("says so when a run wrote nothing", () => {
    expect(auditDetail([])).toBe("nothing extracted");
  });
});
