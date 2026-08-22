import { describe, expect, it } from "vitest";
import { DAY_MS } from "../time/dates";
import { requestMetrics } from "./dwell";
import { ageing, groupByBlockingParty, groupByStage, rowState, summarise } from "./holdup";
import type { RequestView } from "./holdup";
import { parseRequest } from "./request";
import { NOW, requestFrontmatter, testSpec } from "./testFixtures";

const spec = testSpec();

function view(overrides: Record<string, unknown>): RequestView {
  const { request } = parseRequest(requestFrontmatter(overrides));
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

/** A request sitting in `stage` for `days`, blocked on `party`. */
function stuck(
  id: string,
  stage: string,
  days: number,
  party: string | null,
  extra: Record<string, unknown> = {},
): RequestView {
  const at = new Date(NOW - days * DAY_MS).toISOString();
  const frontmatter: Record<string, unknown> = {
    id,
    stage,
    due: "2099-01-01",
    history: [{ at, to: stage, by: "yh" }],
    ...extra,
  };
  if (party === null) delete frontmatter["blocked_on"];
  else {
    frontmatter["blocked_on"] = party;
    frontmatter["blocked_since"] = at;
  }
  const built = requestFrontmatter(frontmatter);
  if (party === null) delete built["blocked_on"];
  const { request } = parseRequest(built);
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

describe("groupByStage", () => {
  const views = [
    stuck("REQ-1", "triage", 1, null),
    stuck("REQ-2", "awaiting-approval", 20, "[[Dr A Tan]]"),
    stuck("REQ-3", "awaiting-approval", 2, "[[Dr B Lim]]"),
  ];

  it("keeps the spec's stage order and shows empty stages too", () => {
    const groups = groupByStage(views, spec);
    expect(groups.map((g) => g.stageId)).toEqual(spec.stages.map((s) => s.id));
    expect(groups.find((g) => g.stageId === "extraction")!.views).toEqual([]);
  });

  it("puts the worst request at the top of its column", () => {
    const approval = groupByStage(views, spec).find((g) => g.stageId === "awaiting-approval")!;
    expect(approval.views.map((v) => v.request.id)).toEqual(["REQ-2", "REQ-3"]);
    expect(approval.breachedCount).toBe(1);
    expect(approval.longestDwellMs).toBe(20 * DAY_MS);
  });

  it("leaves completed requests out of the queue", () => {
    const delivered = stuck("REQ-9", "delivered", 5, null, { outputs: [{ kind: "t" }] });
    const groups = groupByStage([...views, delivered], spec);
    expect(groups.find((g) => g.stageId === "delivered")!.views).toEqual([]);
    expect(
      groupByStage([...views, delivered], spec, { includeCompleted: true }).find(
        (g) => g.stageId === "delivered",
      )!.views,
    ).toHaveLength(1);
  });

  it("still shows a stage the spec no longer declares", () => {
    // Better a visible orphan column than a request that vanishes off the board.
    const orphan = stuck("REQ-X", "pre-triage", 3, null);
    expect(groupByStage([orphan], spec).map((g) => g.stageId)).toContain("pre-triage");
  });
});

describe("groupByBlockingParty", () => {
  const views = [
    stuck("REQ-1", "awaiting-approval", 20, "[[Dr A Tan]]"),
    stuck("REQ-2", "awaiting-approval", 9, "[[Dr A Tan]]"),
    stuck("REQ-3", "triage", 2, "[[Dr B Lim]]"),
    stuck("REQ-4", "triage", 1, null),
  ];

  it("collects everything one person is holding up", () => {
    // One chase-up email covers five requests — the point of the view.
    const groups = groupByBlockingParty(views);
    const tan = groups.find((g) => g.party === "[[Dr A Tan]]")!;
    expect(tan.views.map((v) => v.request.id)).toEqual(["REQ-1", "REQ-2"]);
    expect(tan.longestBlockedMs).toBe(20 * DAY_MS);
    expect(tan.breachedCount).toBe(1);
  });

  it("omits requests nobody is blocking", () => {
    expect(groupByBlockingParty(views).flatMap((g) => g.views.map((v) => v.request.id))).not.toContain(
      "REQ-4",
    );
  });

  it("puts the party with the most breaches first", () => {
    expect(groupByBlockingParty(views).map((g) => g.party)).toEqual([
      "[[Dr A Tan]]",
      "[[Dr B Lim]]",
    ]);
  });

  it("drops a party once their request is complete", () => {
    const done = stuck("REQ-5", "delivered", 30, "[[Dr C Ng]]", { outputs: [{ kind: "t" }] });
    expect(groupByBlockingParty([done])).toEqual([]);
  });
});

describe("ageing", () => {
  const views = [
    stuck("REQ-1", "awaiting-approval", 20, null), // breached (14-day target)
    stuck("REQ-2", "awaiting-approval", 12, null), // at risk
    stuck("REQ-3", "awaiting-approval", 1, null), // on track
  ];

  it("lists only what is late or nearly late, worst first", () => {
    expect(ageing(views).map((v) => v.request.id)).toEqual(["REQ-1", "REQ-2"]);
  });

  it("can show the whole queue when asked", () => {
    expect(ageing(views, { includeOnTrack: true }).map((v) => v.request.id)).toEqual([
      "REQ-1",
      "REQ-2",
      "REQ-3",
    ]);
  });

  it("takes the worse of the stage target and the due date", () => {
    const overdue = view({ due: "2026-07-01" });
    expect(rowState(overdue)).toBe("breached");
    expect(ageing([overdue])).toHaveLength(1);
  });
});

describe("summarise", () => {
  it("counts the queue the way the cockpit header reads it", () => {
    const summary = summarise([
      stuck("REQ-1", "awaiting-approval", 20, "[[Dr A Tan]]"),
      stuck("REQ-2", "awaiting-approval", 12, null),
      stuck("REQ-3", "triage", 1, null),
      stuck("REQ-4", "delivered", 5, null, { outputs: [{ kind: "t" }] }),
    ]);
    expect(summary).toMatchObject({
      total: 4,
      live: 3,
      completed: 1,
      breached: 1,
      atRisk: 1,
      blocked: 1,
    });
  });

  it("counts notes whose numbers cannot be trusted", () => {
    const broken = view({ history: [] });
    expect(summarise([broken]).withProblems).toBe(1);
  });

  it("counts bounced requests", () => {
    const bounced = view({
      stage: "extraction",
      history: [
        { at: "2026-07-01", to: "extraction" },
        { at: "2026-07-10", to: "qc" },
        { at: "2026-07-15", to: "extraction" },
      ],
    });
    expect(summarise([bounced]).bounced).toBe(1);
  });

  it("reports zeroes for an empty queue rather than failing", () => {
    expect(summarise([])).toMatchObject({ total: 0, live: 0, breached: 0 });
  });
});
