import { describe, expect, it } from "vitest";
import { agendaCandidates, buildAgenda, summariseAgenda, type AgendaNote } from "./agenda";
import {
  composeMessage,
  DEFAULT_CHASE_TEMPLATE,
  draftSummary,
  fillTemplate,
  itemLine,
  messageFields,
  MESSAGE_FIELDS,
  readTemplate,
} from "./message";
import { partiesIn } from "./party";
import type { Thread } from "./thread";
import { parsePublication, type PublicationNote } from "../publication/publication";
import type { RequestView } from "../request/holdup";
import type { RequestMetrics } from "../request/dwell";
import type { RequestNote } from "../request/request";
import { DAY_MS, formatDuration } from "../time/dates";

const NOW = Date.parse("2026-07-24T10:00:00Z");
const day = (n: number) => NOW - n * DAY_MS;

function view(overrides: {
  id: string;
  stage?: string;
  title?: string;
  blockedOn?: string | null;
  blockedForMs?: number | null;
  breached?: boolean;
  completed?: boolean;
}): RequestView {
  const request = {
    uid: `uid-${overrides.id}`,
    id: overrides.id,
    title: overrides.title ?? "A cohort",
    stage: overrides.stage ?? "awaiting-approval",
  } as RequestNote;

  const metrics = {
    currentDwellMs: 5 * DAY_MS,
    totalAgeMs: 30 * DAY_MS,
    turnaroundMs: null,
    completed: overrides.completed ?? false,
    segments: [],
    perStageMs: [],
    bounceCount: 0,
    revisitCount: 0,
    blockedOn: overrides.blockedOn ?? null,
    blockedForMs: overrides.blockedForMs ?? 9 * DAY_MS,
    stageSla: { state: overrides.breached === true ? "breached" : "on-track" },
    dueSla: { state: "no-target" },
    problems: [],
  } as unknown as RequestMetrics;

  return { request, metrics };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    uid: "u",
    id: "THR-2026-0091",
    channel: "email",
    subject: "RE: cohort",
    threadKey: "",
    with: partiesIn(["[[Dr A Tan]]"]),
    requests: ["[[REQ-2026-014]]"],
    directionLast: "outbound",
    lastOutbound: day(9),
    lastInbound: null,
    awaiting: "them",
    state: "open",
    messages: [],
    raw: {},
    ...overrides,
  };
}

const publication = (raw: Record<string, unknown>): PublicationNote =>
  parsePublication("85 Publications/PUB-2026-007.md", raw);

describe("buildAgenda", () => {
  it("joins requests, outreach, manuscripts and obligations for one person", () => {
    // The whole value is the join: these four live in four folders under four
    // differently-named fields, and today the answer is assembled by memory.
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [view({ id: "REQ-2026-014", blockedOn: "[[Dr A Tan]]" })],
      threads: [thread()],
      publications: [
        publication({
          id: "PUB-2026-007",
          title: "Readmission paper",
          stage: "internal-review",
          authors: ["[[Dr A Tan]]"],
        }),
      ],
      notes: [
        {
          path: "60 Events/OBL-2026-001.md",
          type: "obligation",
          frontmatter: {
            id: "OBL-2026-001",
            title: "DSRB continuing review",
            owner: "[[Dr A Tan]]",
            due: "2026-07-01",
            consequence: "Study suspended if lapsed.",
          },
        },
      ],
    });

    expect(agenda.items.map((item) => item.kind).sort()).toEqual([
      "obligation",
      "outreach",
      "publication",
      "request",
    ]);
    expect(summariseAgenda(agenda)).toContain("1 request");
  });

  it("matches a person however the field spells them", () => {
    const agenda = buildAgenda({
      party: "Dr A Tan",
      now: NOW,
      views: [view({ id: "R1", blockedOn: "[[30 People/Dr A Tan|Tan]]" })],
    });
    expect(agenda.items).toHaveLength(1);
  });

  it("leaves out anyone else's items", () => {
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [view({ id: "R1", blockedOn: "[[Dr B Lim]]" })],
      threads: [thread({ with: partiesIn(["[[Dr B Lim]]"]) })],
    });
    expect(agenda.items).toEqual([]);
    expect(summariseAgenda(agenda)).toBe("Nothing open with this person.");
  });

  it("leaves out completed requests and settled notes", () => {
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [view({ id: "R1", blockedOn: "[[Dr A Tan]]", completed: true })],
      notes: [
        {
          path: "60 Events/E.md",
          type: "obligation",
          frontmatter: { owner: "[[Dr A Tan]]", status: "Completed" },
        },
      ],
    });
    expect(agenda.items).toEqual([]);
  });

  it("does not count a request twice through the generic scan", () => {
    // A request note carries `blocked_on`, which is also a responsibility
    // field; without the exclusion it would appear as a request and again as
    // an item.
    const notes: AgendaNote[] = [
      {
        path: "10 Requests/REQ-2026-014.md",
        type: "scdb-request",
        frontmatter: { id: "REQ-2026-014", blocked_on: "[[Dr A Tan]]" },
      },
    ];
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [view({ id: "REQ-2026-014", blockedOn: "[[Dr A Tan]]" })],
      notes,
    });
    expect(agenda.items).toHaveLength(1);
  });

  it("only lists a manuscript that is actually with them", () => {
    // A paper under review at a journal is waiting on the journal. Putting it
    // on a co-author's agenda asks them for something they cannot give.
    const authored = { authors: ["[[Dr A Tan]]"], id: "P" };
    const agendaFor = (stage: string) =>
      buildAgenda({
        party: "[[Dr A Tan]]",
        now: NOW,
        publications: [publication({ ...authored, stage })],
      }).items;

    expect(agendaFor("internal-review")).toHaveLength(1);
    expect(agendaFor("under-review")).toHaveLength(0);
    expect(agendaFor("published")).toHaveLength(0);
  });

  it("puts the urgent first, then the longest wait", () => {
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [
        view({ id: "fresh", blockedOn: "[[Dr A Tan]]", blockedForMs: 2 * DAY_MS }),
        view({ id: "old", blockedOn: "[[Dr A Tan]]", blockedForMs: 40 * DAY_MS }),
        view({
          id: "breached",
          blockedOn: "[[Dr A Tan]]",
          blockedForMs: 1 * DAY_MS,
          breached: true,
        }),
      ],
    });
    expect(agenda.items.map((item) => item.link)).toEqual(["breached", "old", "fresh"]);
    expect(agenda.urgentCount).toBe(1);
    expect(agenda.longestWaitMs).toBe(40 * DAY_MS);
  });

  it("carries an obligation's consequence through verbatim", () => {
    // §5.7: a reminder that does not say what breaks gets ignored.
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      notes: [
        {
          path: "60 Events/E.md",
          type: "obligation",
          frontmatter: {
            id: "OBL-1",
            owner: "[[Dr A Tan]]",
            due: "2026-07-01",
            consequence: "Study suspended if lapsed.",
          },
        },
      ],
    });
    expect(agenda.items[0]?.context).toContain("Study suspended if lapsed.");
    expect(agenda.items[0]?.urgent).toBe(true);
  });

  it("returns nothing for an empty person rather than everything", () => {
    expect(
      buildAgenda({ party: "  ", now: NOW, views: [view({ id: "R", blockedOn: "x" })] }).items,
    ).toEqual([]);
  });
});

describe("composeMessage", () => {
  const agenda = buildAgenda({
    party: "[[Dr A Tan]]",
    now: NOW,
    views: [view({ id: "REQ-2026-014", blockedOn: "[[Dr A Tan]]", title: "HF cohort" })],
  });

  it("fills the built-in chase-up", () => {
    const draft = composeMessage(DEFAULT_CHASE_TEMPLATE, { agenda, now: NOW, actor: "YH" });
    expect(draft.subject).toBe("Outstanding items — 1");
    expect(draft.body).toContain("Dear Dr A Tan,");
    expect(draft.body).toContain("REQ-2026-014 — HF cohort");
    expect(draft.body).toContain("YH");
    expect(draft.unknown).toEqual([]);
  });

  it("offers only the closed set of fields", () => {
    // §5.11 rule 5, enforced by construction: there is no {{body}} or
    // {{note}}, so no template can reach clinical content.
    const fields = messageFields({ agenda, now: NOW, actor: "YH" });
    expect(Object.keys(fields).sort()).toEqual([...MESSAGE_FIELDS].sort());
  });

  it("leaves an unknown placeholder visible instead of blanking it", () => {
    // "please reply by ." gets sent; "please reply by {{deadline}}" gets fixed.
    const result = fillTemplate("Reply by {{deadline}} please, {{name}}", {
      name: "Dr A Tan",
    });
    expect(result.text).toBe("Reply by {{deadline}} please, Dr A Tan");
    expect(result.unknown).toEqual(["deadline"]);
  });

  it("tolerates spacing and case in a placeholder", () => {
    expect(fillTemplate("{{ NAME }}", { name: "Tan" }).text).toBe("Tan");
  });

  it("counts the overflow rather than truncating in silence", () => {
    const many = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: Array.from({ length: 20 }, (_unused, index) =>
        view({ id: `R${index}`, blockedOn: "[[Dr A Tan]]" }),
      ),
    });
    const fields = messageFields({ agenda: many, now: NOW, actor: "YH", maxItems: 5 });
    expect(fields.items.split("\n")).toHaveLength(6);
    expect(fields.items).toContain("and 15 more");
    expect(fields.count).toBe("20");
  });

  it("renders a duration exactly as every board renders it", () => {
    // The holdup board once said "51 days here" about the request the agenda
    // called "52 days": a local Math.round against formatDuration's floor.
    // §6 asks for one formatter, and this is the guard that keeps it one.
    const blockedFor = 51.6 * DAY_MS;
    const one = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [view({ id: "R1", blockedOn: "[[Dr A Tan]]", blockedForMs: blockedFor })],
    });
    expect(one.items[0]?.context).toContain(`Blocked ${formatDuration(blockedFor)};`);
    expect(one.items[0]?.context).toContain("Blocked 51 days;");
  });

  it("puts ids, stages and dates in a line, and nothing else", () => {
    const line = itemLine(agenda.items[0]!);
    expect(line).toContain("REQ-2026-014");
    expect(line).toContain("awaiting-approval");
    expect(line).not.toContain("[[");
  });
});

describe("readTemplate", () => {
  it("uses the note's subject and body", () => {
    const template = readTemplate("nudge", { subject: "About {{count}} items" }, "Hi {{name}}");
    expect(template.subject).toBe("About {{count}} items");
    expect(template.body).toBe("Hi {{name}}");
  });

  it("falls back rather than composing an empty message", () => {
    const template = readTemplate("nudge", {}, "   ");
    expect(template.subject).toBe(DEFAULT_CHASE_TEMPLATE.subject);
    expect(template.body).toBe(DEFAULT_CHASE_TEMPLATE.body);
  });
});

describe("draftSummary", () => {
  it("says what was chased, for the thread's message log", () => {
    const agenda = buildAgenda({
      party: "[[Dr A Tan]]",
      now: NOW,
      views: [view({ id: "R1", blockedOn: "[[Dr A Tan]]" })],
    });
    expect(draftSummary(agenda)).toBe("Chased 1 request");
    expect(draftSummary(buildAgenda({ party: "[[X]]", now: NOW }))).toContain("nothing open");
  });
});

describe("agendaCandidates", () => {
  it("lists everyone with something open, busiest first", () => {
    const candidates = agendaCandidates({
      now: NOW,
      views: [
        view({ id: "R1", blockedOn: "[[Dr A Tan]]" }),
        view({ id: "R2", blockedOn: "[[Dr A Tan]]" }),
        view({ id: "R3", blockedOn: "[[Dr B Lim]]" }),
      ],
    });
    expect(candidates.map((c) => c.party.name)).toEqual(["Dr A Tan", "Dr B Lim"]);
    expect(candidates[0]?.count).toBe(2);
    expect(candidates[0]?.detail).toBe("2 requests");
  });

  it("puts whoever is holding up something overdue at the top", () => {
    const candidates = agendaCandidates({
      now: NOW,
      views: [
        view({ id: "R1", blockedOn: "[[Busy]]" }),
        view({ id: "R2", blockedOn: "[[Busy]]" }),
        view({ id: "R3", blockedOn: "[[Busy]]" }),
        view({ id: "R4", blockedOn: "[[Late]]", breached: true }),
      ],
    });
    expect(candidates.map((c) => c.party.name)).toEqual(["Late", "Busy"]);
  });

  it("merges the spellings of one person into one row", () => {
    const candidates = agendaCandidates({
      now: NOW,
      views: [
        view({ id: "R1", blockedOn: "[[Dr A Tan]]" }),
        view({ id: "R2", blockedOn: "[[30 People/Dr A Tan|Tan]]" }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.count).toBe(2);
  });

  it("agrees with the agenda it will produce", () => {
    // The count in the picker and the list behind it come from one pass, so
    // they cannot drift apart.
    const input = {
      now: NOW,
      views: [view({ id: "R1", blockedOn: "[[Dr A Tan]]" })],
      threads: [thread()],
    };
    const candidate = agendaCandidates(input)[0]!;
    expect(buildAgenda({ ...input, party: candidate.party.raw }).items).toHaveLength(
      candidate.count,
    );
  });

  it("counts one note naming a person twice as one item", () => {
    const candidates = agendaCandidates({
      now: NOW,
      notes: [
        {
          path: "60 Events/E.md",
          type: "obligation",
          frontmatter: { id: "OBL-1", owner: "[[Dr A Tan]]", assignee: "[[Dr A Tan]]" },
        },
      ],
    });
    expect(candidates[0]?.count).toBe(1);
    expect(candidates[0]?.detail).toBe("1 obligation");
  });

  it("is empty when nothing is waiting on anybody", () => {
    expect(agendaCandidates({ now: NOW })).toEqual([]);
  });
});
