import { describe, expect, it } from "vitest";
import { briefingDue, buildBriefing, type BriefingInput } from "./briefing";
import { partiesIn } from "../comms/party";
import { agedOutreach, type Thread } from "../comms/thread";
import type { Overview } from "../overview/overview";
import { parsePublication } from "../publication/publication";
import type { RequestView } from "../request/holdup";
import type { RequestMetrics } from "../request/dwell";
import type { RequestNote } from "../request/request";
import { DAY_MS } from "../time/dates";

const NOW = Date.parse("2026-08-23T09:00:00");
const day = (n: number) => NOW - n * DAY_MS;

function view(overrides: {
  id: string;
  title?: string;
  stage?: string;
  due?: number | null;
  blockedOn?: string | null;
  breached?: boolean;
  completed?: boolean;
}): RequestView {
  const request = {
    uid: `uid-${overrides.id}`,
    id: overrides.id,
    title: overrides.title ?? "A cohort",
    stage: overrides.stage ?? "awaiting-approval",
    due: overrides.due ?? null,
  } as RequestNote;

  const metrics = {
    currentDwellMs: 5 * DAY_MS,
    totalAgeMs: 30 * DAY_MS,
    completed: overrides.completed ?? false,
    segments: [],
    perStageMs: [],
    bounceCount: 0,
    revisitCount: 0,
    blockedOn: overrides.blockedOn ?? null,
    blockedForMs: 9 * DAY_MS,
    stageSla: { state: overrides.breached === true ? "breached" : "on-track" },
    dueSla: { state: "no-target" },
    problems: [],
  } as unknown as RequestMetrics;

  return { request, metrics };
}

const emptyOverview: Overview = {
  attention: [],
  deadlines: [],
  unscheduled: [],
  publications: [],
};

function input(overrides: Partial<BriefingInput> = {}): BriefingInput {
  return {
    now: NOW,
    actor: "yh",
    mode: "hod",
    overview: emptyOverview,
    outreach: [],
    views: [],
    ...overrides,
  };
}

describe("buildBriefing", () => {
  it("says so, once, when there is nothing to report", () => {
    const briefing = buildBriefing(input());
    expect(briefing.quiet).toBe(true);
    expect(briefing.body).toContain("Nothing is overdue, stuck or falling due");
    expect(briefing.date).toBe("2026-08-23");
  });

  it("gives every empty section a line saying what it would hold", () => {
    // §6: empty states matter. A blank heading reads like a bug.
    const briefing = buildBriefing(input());
    expect(briefing.body).toContain("*No request is waiting on anybody.*");
    expect(briefing.body).toContain("*Nothing falls due today.*");
    expect(briefing.body.split("\n## ")).toHaveLength(8);
  });

  it("lists what is due today and nothing that is due tomorrow", () => {
    const briefing = buildBriefing(
      input({
        views: [
          view({ id: "REQ-today", due: NOW }),
          view({ id: "REQ-tomorrow", due: NOW + DAY_MS }),
        ],
      }),
    );
    expect(briefing.body).toContain("[[REQ-today]]");
    expect(briefing.body).not.toContain("[[REQ-tomorrow]]");
  });

  it("leaves completed requests out of due today", () => {
    const briefing = buildBriefing(
      input({ views: [view({ id: "REQ-done", due: NOW, completed: true })] }),
    );
    expect(briefing.body).not.toContain("[[REQ-done]]");
  });

  it("groups the stuck by person, so one email covers several", () => {
    const briefing = buildBriefing(
      input({
        views: [
          view({ id: "REQ-1", blockedOn: "[[Dr A Tan]]" }),
          view({ id: "REQ-2", blockedOn: "[[Dr A Tan]]" }),
          view({ id: "REQ-3", blockedOn: "[[Dr B Lim]]" }),
        ],
      }),
    );
    expect(briefing.body).toContain("**[[Dr A Tan]]** — 2 requests");
    expect(briefing.body).toContain("**[[Dr B Lim]]** — 1 request,");
  });

  it("takes the SLA verdict from the attention list rather than recomputing it", () => {
    // The briefing and the cockpit must never disagree about what is overdue.
    const breached = view({ id: "REQ-late", breached: true });
    const briefing = buildBriefing(
      input({
        views: [breached],
        overview: {
          ...emptyOverview,
          attention: [
            { view: breached, reasons: [{ reason: "overdue", detail: "Past its SLA target." }] },
          ],
        },
      }),
    );
    expect(briefing.body).toContain("**Breached** · [[REQ-late]]");
  });

  it("says 'no reply recorded', not 'no reply'", () => {
    // Tier 0 knows what it composed and nothing else. A reply that arrived and
    // was never logged looks identical to no reply.
    const thread: Thread = {
      uid: "u",
      id: "THR-2026-0091",
      channel: "email",
      subject: "RE: cohort",
      threadKey: "",
      with: partiesIn(["[[Dr A Tan]]"]),
      requests: [],
      directionLast: "outbound",
      lastOutbound: day(9),
      lastInbound: null,
      awaiting: "them",
      state: "open",
      messages: [],
      raw: {},
    };
    const briefing = buildBriefing(
      input({ outreach: agedOutreach([thread], { now: NOW }) }),
    );
    expect(briefing.body).toContain("composed 9 days ago, no reply recorded");
    expect(briefing.body).toContain("[[THR-2026-0091]]");
  });

  it("reports a decision that is already overdue as overdue", () => {
    const briefing = buildBriefing(
      input({
        overview: {
          ...emptyOverview,
          publications: [
            parsePublication("85 Publications/P.md", {
              id: "PUB-2026-007",
              title: "Readmission paper",
              stage: "under-review",
              journal: "EHJ",
              decision_due: "2026-08-01",
            }),
          ],
        },
      }),
    );
    expect(briefing.body).toContain("22 days overdue");
  });

  it("flags an obligation with a rule but no next date", () => {
    // §5.7's whole point: the lapsed obligation is the one that must never be
    // silently missed, and nothing is watching this one.
    const briefing = buildBriefing(
      input({
        overview: {
          ...emptyOverview,
          unscheduled: [
            {
              path: "60 Events/OBL-2026-002.md",
              type: "obligation",
              frontmatter: { id: "OBL-2026-002", title: "DUA renewal" },
            },
          ],
        },
      }),
    );
    expect(briefing.body).toContain("**Unscheduled** · [[OBL-2026-002]] — DUA renewal");
    expect(briefing.body).toContain("nothing is watching it");
  });

  it("carries a consequence through, because a reminder without one is ignored", () => {
    const briefing = buildBriefing(
      input({
        overview: {
          ...emptyOverview,
          deadlines: [
            {
              path: "60 Events/OBL.md",
              type: "obligation",
              id: "OBL-1",
              title: "DSRB continuing review",
              what: "due",
              at: NOW + 30 * DAY_MS,
              inDays: 30,
              overdue: false,
              consequence: "Study suspended if lapsed.",
            },
          ],
        },
      }),
    );
    expect(briefing.body).toContain("Study suspended if lapsed.");
  });

  it("names the mode and the actor, so a later reader knows what was filtered", () => {
    const briefing = buildBriefing(input({ mode: "biostat", actor: "yh" }));
    expect(briefing.frontmatter["mode"]).toBe("biostat");
    expect(briefing.frontmatter["generated_by"]).toBe("yh");
    expect(briefing.frontmatter["type"]).toBe("briefing");
  });

  it("never presents itself as the record of truth", () => {
    // §5.1: a governance instrument that quietly contradicts the system of
    // record is worse than no instrument.
    const briefing = buildBriefing(input({ views: [view({ id: "R", due: NOW })] }));
    expect(briefing.body).toContain("record of truth");
  });

  it("strips a .md that arrives where an id was expected", () => {
    const briefing = buildBriefing(
      input({
        overview: {
          ...emptyOverview,
          unscheduled: [
            { path: "60 Events/OBL-2026-002.md", type: "obligation", frontmatter: {} },
          ],
        },
      }),
    );
    expect(briefing.body).toContain("[[60 Events/OBL-2026-002]]");
    expect(briefing.body).not.toContain(".md]]");
  });
});

describe("briefingDue", () => {
  it("is due once a day and not again", () => {
    expect(briefingDue("", NOW)).toBe(true);
    expect(briefingDue("2026-08-22", NOW)).toBe(true);
    expect(briefingDue("2026-08-23", NOW)).toBe(false);
  });
});
