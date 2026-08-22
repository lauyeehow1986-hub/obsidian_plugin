import { describe, expect, it } from "vitest";
import { parsePublication } from "../publication/publication";
import { requestMetrics } from "../request/dwell";
import type { RequestView } from "../request/holdup";
import { parseRequest } from "../request/request";
import { NOW, requestFrontmatter, testSpec } from "../request/testFixtures";
import { DAY_MS } from "../time/dates";
import { buildOverview, deadlines, needsAttention, type DatedNote } from "./overview";

const spec = testSpec();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();
const never = () => false;

function make(
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
  // The fixture's default `received` predates these synthetic histories, which
  // would give every request a spurious "the dates disagree" problem.
  delete built["received"];
  const { request } = parseRequest(built);
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

const base = { now: NOW, stranded: never, governanceBlocked: never };

describe("needsAttention", () => {
  it("leaves a healthy request off the list entirely", () => {
    expect(needsAttention([make("REQ-1", "triage", 1)], base)).toHaveLength(0);
  });

  it("never lists a completed request", () => {
    // A delivered request cannot breach anything; it is finished, not ignored.
    const done = make("REQ-1", "delivered", 400);
    expect(needsAttention([done], base)).toHaveLength(0);
  });

  it("lists every reason that applies, not only the worst", () => {
    // The request that is overdue *and* stranded *and* waiting on somebody is a
    // different problem, not a worse one. Collapsing to one reason hides it.
    const bad = make("REQ-1", "awaiting-approval", 40, {
      blocked_on: "[[Dr A Tan]]",
      blocked_since: iso(40),
    });
    const [item] = needsAttention([bad], { ...base, stranded: () => true });
    expect(item?.reasons.map((r) => r.reason)).toEqual(["stranded", "overdue", "blocked"]);
  });

  it("ranks an unreadable note above everything else", () => {
    // Every other judgement on this board depends on the dates being right.
    const broken = make("REQ-broken", "triage", 1, { history: "not a list" });
    const overdue = make("REQ-overdue", "triage", 40);
    const order = needsAttention([overdue, broken], base).map((i) => i.view.request.id);
    expect(order).toEqual(["REQ-broken", "REQ-overdue"]);
  });

  it("counts a governance block only when the caller says so", () => {
    const view = make("REQ-1", "triage", 1);
    expect(needsAttention([view], base)).toHaveLength(0);
    const [item] = needsAttention([view], { ...base, governanceBlocked: () => true });
    expect(item?.reasons[0]?.reason).toBe("blocked");
  });

  it("ignores a holdup that has not lasted long enough to chase", () => {
    const fresh = make("REQ-1", "triage", 1, {
      blocked_on: "[[Dr A Tan]]",
      blocked_since: iso(1),
    });
    expect(needsAttention([fresh], base)).toHaveLength(0);
    expect(needsAttention([fresh], { ...base, blockedDays: 0 })).toHaveLength(1);
  });

  it("breaks ties on how many things are wrong, then on age", () => {
    const one = make("REQ-one", "triage", 30);
    const two = make("REQ-two", "triage", 20, {
      blocked_on: "[[Dr A Tan]]",
      blocked_since: iso(20),
    });
    const order = needsAttention([one, two], base).map((i) => i.view.request.id);
    expect(order).toEqual(["REQ-two", "REQ-one"]);
  });
});

describe("deadlines", () => {
  const note = (path: string, type: string, frontmatter: Record<string, unknown>): DatedNote => ({
    path,
    type,
    frontmatter,
  });

  it("reads `due` from any note type, whatever it is", () => {
    // Generic on purpose: event and obligation notes work today, and when B3
    // materialises a next occurrence it lands as an ordinary date right here.
    const found = deadlines(
      [note("60 Events/E1.md", "obligation", { due: "2026-08-01", id: "OBL-1" })],
      { now: NOW },
    );
    expect(found.due).toHaveLength(1);
    expect(found.due[0]?.what).toBe("due");
    expect(found.due[0]?.id).toBe("OBL-1");
  });

  it("reads `decision_due` from a publication", () => {
    const found = deadlines(
      [note("85 Publications/P.md", "publication", { decision_due: "2026-08-01" })],
      { now: NOW },
    );
    expect(found.due[0]?.what).toBe("decision due");
  });

  it("marks what has already passed and counts the days either way", () => {
    const found = deadlines(
      [
        note("a.md", "event", { due: new Date(NOW - 5 * DAY_MS).toISOString() }),
        note("b.md", "event", { due: new Date(NOW + 5 * DAY_MS).toISOString() }),
      ],
      { now: NOW },
    );
    expect(found.due[0]?.overdue).toBe(true);
    expect(found.due[0]?.inDays).toBe(-5);
    expect(found.due[1]?.overdue).toBe(false);
    expect(found.due[1]?.inDays).toBe(5);
  });

  it("sorts soonest first, overdue at the top", () => {
    const at = (days: number) => new Date(NOW + days * DAY_MS).toISOString();
    const found = deadlines(
      [
        note("c.md", "event", { due: at(10) }),
        note("a.md", "event", { due: at(-3) }),
        note("b.md", "event", { due: at(2) }),
      ],
      { now: NOW },
    );
    expect(found.due.map((d) => d.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("drops anything beyond the window but keeps everything overdue", () => {
    const at = (days: number) => new Date(NOW + days * DAY_MS).toISOString();
    const found = deadlines(
      [note("far.md", "event", { due: at(400) }), note("old.md", "event", { due: at(-400) })],
      { now: NOW, withinDays: 30 },
    );
    expect(found.due.map((d) => d.path)).toEqual(["old.md"]);
  });

  it("reports a recurring obligation with no materialised date, rather than dropping it", () => {
    // §5.7's whole point is that a lapsed obligation must never be missed, so
    // one this build cannot schedule yet is named rather than quietly omitted.
    const found = deadlines(
      [note("60 Events/R.md", "obligation", { recurrence: { every: 1, unit: "year" } })],
      { now: NOW },
    );
    expect(found.due).toHaveLength(0);
    expect(found.unscheduled.map((n) => n.path)).toEqual(["60 Events/R.md"]);
  });

  it("ignores an undated note that claims no recurrence", () => {
    const found = deadlines([note("x.md", "study", { title: "A study" })], { now: NOW });
    expect(found.due).toHaveLength(0);
    expect(found.unscheduled).toHaveLength(0);
  });

  it("falls back to the filename when a note carries no id", () => {
    const found = deadlines([note("60 Events/DSRB renewal.md", "event", { due: "2026-08-01" })], {
      now: NOW,
    });
    expect(found.due[0]?.id).toBe("DSRB renewal");
  });

  it("carries the consequence through, because a reminder without one is ignored", () => {
    const found = deadlines(
      [note("o.md", "obligation", { due: "2026-08-01", consequence: "Study suspended." })],
      { now: NOW },
    );
    expect(found.due[0]?.consequence).toBe("Study suspended.");
  });
});

describe("buildOverview", () => {
  it("puts the three lists together and settles publications out", () => {
    const overview = buildOverview(
      [make("REQ-1", "triage", 40)],
      [{ path: "e.md", type: "event", frontmatter: { due: "2026-08-01" } }],
      [
        parsePublication("p1.md", { id: "PUB-1", stage: "under-review", decision_due: "2026-08-01" }),
        parsePublication("p2.md", { id: "PUB-2", stage: "published" }),
      ],
      base,
    );
    expect(overview.attention).toHaveLength(1);
    expect(overview.deadlines).toHaveLength(1);
    expect(overview.publications.map((p) => p.id)).toEqual(["PUB-1"]);
  });

  it("is empty and does not throw on an empty vault", () => {
    const overview = buildOverview([], [], [], base);
    expect(overview).toEqual({
      attention: [],
      deadlines: [],
      unscheduled: [],
      publications: [],
    });
  });
});
