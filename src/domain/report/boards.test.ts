import { describe, expect, it } from "vitest";
import { requestMetrics } from "../request/dwell";
import type { RequestView } from "../request/holdup";
import { parseRequest } from "../request/request";
import { NOW, requestFrontmatter, testSpec } from "../request/testFixtures";
import { DAY_MS } from "../time/dates";
import { boardRowCount, boardTitle, buildBoardDocument, type BoardContext } from "./boards";
import { renderDocument } from "./document";

const spec = testSpec();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();

function stuck(
  id: string,
  stage: string,
  days: number,
  extra: Record<string, unknown> = {},
): RequestView {
  const built = requestFrontmatter({
    id,
    stage,
    due: "2099-01-01",
    history: [{ at: iso(days), to: stage, by: "yh" }],
    ...extra,
  });
  if (extra["blocked_on"] === undefined) {
    delete built["blocked_on"];
    delete built["blocked_since"];
  }
  const { request } = parseRequest(built);
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

const VIEWS = [
  stuck("REQ-1", "triage", 1),
  stuck("REQ-2", "awaiting-approval", 40, {
    blocked_on: "[[Dr A Tan]]",
    blocked_since: iso(40),
  }),
  stuck("REQ-3", "extraction", 3),
];

function context(overrides: Partial<BoardContext> = {}): BoardContext {
  return {
    views: VIEWS,
    allViews: VIEWS,
    spec,
    hats: [{ id: "hod", label: "Head of SCDB" }],
    now: NOW,
    generatedAt: "2026-07-28 12:00",
    scope: "",
    ...overrides,
  };
}

const BOARDS = ["queue", "holdup", "ageing", "analytics", "health"] as const;

describe("every board builds a document", () => {
  it.each(BOARDS)("%s", (board) => {
    const document = buildBoardDocument(board, context());
    expect(document.title).toBe(boardTitle(board));
    expect(document.sections.length).toBeGreaterThan(0);
    expect(document.subtitle).toContain("live request");
    // Renders without throwing, and produces something a browser will open.
    expect(renderDocument(document).startsWith("<!doctype html>")).toBe(true);
  });

  it.each(BOARDS)("%s survives an empty vault with an explanation, not a blank page", (board) => {
    const document = buildBoardDocument(board, context({ views: [], allViews: [] }));
    const html = renderDocument(document);
    expect(html).toContain("scdb-empty");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });
});

describe("what a board document says", () => {
  it("uses the same words as the screen for a state", () => {
    // Not "breached". The vocabulary is shared with the UI on purpose.
    const html = renderDocument(buildBoardDocument("queue", context()));
    expect(html).toContain("Overdue");
    expect(html).not.toContain("breached");
  });

  it("shows dwell, age and bounces together, as §5.1 requires", () => {
    const html = renderDocument(buildBoardDocument("queue", context()));
    expect(html).toContain("Here");
    expect(html).toContain("Age");
    expect(html).toContain("Bounces");
  });

  it("resolves stage ids to spec labels", () => {
    const html = renderDocument(buildBoardDocument("queue", context()));
    expect(html).toContain("Awaiting approval");
    expect(html).not.toContain("awaiting-approval");
  });

  it("carries the hat scope into the document when one was applied", () => {
    const document = buildBoardDocument("queue", context({ scope: "Head of SCDB work only" }));
    expect(renderDocument(document)).toContain("Head of SCDB work only");
  });

  it("escapes a request title that came out of a note", () => {
    const nasty = stuck("REQ-X", "triage", 1, { title: '<script>alert("x")</script>' });
    const html = renderDocument(
      buildBoardDocument("queue", context({ views: [nasty], allViews: [nasty] })),
    );
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("boardRowCount", () => {
  it("counts what the document is about, not the rows it happens to draw", () => {
    // The confirmation and the ledger entry both use this number, so it has to
    // mean the same thing to the person confirming and to a later auditor.
    expect(boardRowCount("queue", context())).toBe(3);
    expect(boardRowCount("holdup", context())).toBe(1);
    expect(boardRowCount("ageing", context())).toBe(1);
  });

  it("is zero on an empty vault", () => {
    for (const board of BOARDS) {
      expect(boardRowCount(board, context({ views: [], allViews: [] }))).toBe(0);
    }
  });
});
