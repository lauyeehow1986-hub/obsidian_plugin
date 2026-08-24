import { describe, expect, it } from "vitest";
import type { TimeEntry } from "../effort/entry";
import { parsePublication, type PublicationNote } from "../publication/publication";
import { requestMetrics } from "../request/dwell";
import type { RequestView } from "../request/holdup";
import { parseRequest } from "../request/request";
import { NOW, requestFrontmatter, testSpec } from "../request/testFixtures";
import { DAY_MS } from "../time/dates";
import { buildPortfolio, type PortfolioInput } from "./portfolio";
import { parseProfileNote, type ProfileNote } from "./profile";

const spec = testSpec();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();

function view(id: string, stage: string, days: number, study: string): RequestView {
  const built = requestFrontmatter({
    id,
    stage,
    study,
    due: "2099-01-01",
    history: [
      { at: iso(days + 20), to: "triage", by: "yh" },
      { at: iso(days), to: stage, by: "yh" },
    ],
  });
  delete built["blocked_on"];
  delete built["blocked_since"];
  const { request } = parseRequest(built);
  return { request, metrics: requestMetrics(request, spec, { now: NOW }) };
}

function publication(overrides: Record<string, unknown> = {}): PublicationNote {
  return parsePublication(`85 Publications/${String(overrides["id"] ?? "PUB-1")}.md`, {
    type: "publication",
    id: "PUB-1",
    title: "A synthetic paper",
    stage: "published",
    journal: "Journal of Invented Results",
    authors: ["[[A Author]]", "[[B Author]]"],
    studies: ["[[Example Registry]]"],
    published: "2026-02-01",
    scdb_supported: true,
    ...overrides,
  });
}

function profile(frontmatter: Record<string, unknown>, path = "84 Profile/x.md"): ProfileNote {
  const note = parseProfileNote(path, frontmatter);
  if (note === null) throw new Error("expected a profile note");
  return note;
}

function entry(mins: number, study: string): TimeEntry {
  return {
    date: "2026-07-14",
    start: "09:00",
    end: "10:00",
    mins,
    person: "yh",
    ref: "REQ-1",
    activity: "extraction",
    study,
    costCentre: "RC-2026-07",
    note: "",
  };
}

function input(overrides: Partial<PortfolioInput> = {}): PortfolioInput {
  return {
    publications: [publication(), publication({ id: "PUB-2", scdb_supported: false })],
    profile: [
      profile({ type: "grant", title: "G", amount: 250000, currency: "SGD", period: "2024-2027" }),
      profile({ type: "supervision", title: "T", trainee: "A Trainee", outcome: "passed" }, "s.md"),
    ],
    views: [view("REQ-1", "delivered", 2, "[[Example Registry]]"), view("REQ-2", "triage", 5, "")],
    entries: [entry(90, "[[Example Registry]]"), entry(30, "")],
    periodLabel: "all time",
    now: NOW,
    ...overrides,
  };
}

describe("buildPortfolio — headlines", () => {
  it("states the denominator on every number", () => {
    const portfolio = buildPortfolio(input());
    for (const headline of portfolio.headlines) {
      expect(headline.note).not.toBe("");
    }
  });

  it("counts papers in print, and the share the facility supported", () => {
    const portfolio = buildPortfolio(input());
    const inPrint = portfolio.headlines.find((h) => h.label === "Publications in print");
    expect(inPrint?.value).toBe("2");
    expect(portfolio.contribution.publicationsSupported).toBe(1);
    expect(portfolio.contribution.supportedShare).toBe(50);
  });

  it("keeps two currencies apart rather than adding them together", () => {
    const portfolio = buildPortfolio(
      input({
        profile: [
          profile({ type: "grant", title: "A", amount: 100, currency: "SGD" }, "a.md"),
          profile({ type: "grant", title: "B", amount: 200, currency: "GBP" }, "b.md"),
        ],
      }),
    );
    const grants = portfolio.headlines.find((h) => h.label === "Grants");
    expect(grants?.note).toContain("GBP 200");
    expect(grants?.note).toContain("SGD 100");
  });

  it("counts only awarded money as funding, and says how many are pending", () => {
    // Found by reading a generated profile: it read "SGD 298,000" with a
    // submitted application folded in. That is the kind of number somebody
    // repeats in a meeting.
    const portfolio = buildPortfolio(
      input({
        profile: [
          profile({ type: "grant", title: "A", amount: 250000, currency: "SGD" }, "a.md"),
          profile(
            { type: "grant", title: "B", amount: 48000, currency: "SGD", status: "submitted" },
            "b.md",
          ),
        ],
      }),
    );
    const grants = portfolio.headlines.find((h) => h.label === "Grants");
    expect(grants?.value).toBe("2");
    expect(grants?.note).toBe("SGD 250,000 awarded · 1 not yet awarded");
  });

  it("states the window the effort figure covers", () => {
    const portfolio = buildPortfolio(input({ periodLabel: "July 2026" }));
    expect(portfolio.headlines.find((h) => h.label === "Effort logged")?.note).toContain(
      "July 2026",
    );
  });

  it("leaves out a section the vault has nothing for", () => {
    const portfolio = buildPortfolio(input({ profile: [] }));
    expect(portfolio.headlines.map((h) => h.label)).not.toContain("Grants");
  });

  it("says so rather than dividing by zero when nothing is in print", () => {
    const portfolio = buildPortfolio(
      input({ publications: [publication({ stage: "under-review" })] }),
    );
    expect(portfolio.contribution.supportedShare).toBeNull();
    expect(portfolio.headlines.find((h) => h.label === "Papers the facility supported")?.note).toBe(
      "no papers in print yet",
    );
  });
});

describe("buildPortfolio — themes and collaborators", () => {
  it("groups on the studies the notes link to, across all three sources", () => {
    const portfolio = buildPortfolio(
      input({
        profile: [
          profile({
            type: "grant",
            title: "G",
            period: "2024",
            studies: ["[[Example Registry]]"],
          }),
        ],
      }),
    );
    const theme = portfolio.themes.find((entry) => entry.study === "Example Registry");
    expect(theme).toMatchObject({ publications: 2, requests: 1, grants: 1, scdbSupported: 1 });
  });

  it("counts every author named, including yours — the vault does not know which is you", () => {
    const portfolio = buildPortfolio(input());
    expect(portfolio.collaborators.map((person) => person.name).sort()).toEqual([
      "A Author",
      "B Author",
    ]);
    expect(portfolio.collaborators[0]?.publications).toBe(2);
  });
});

describe("buildPortfolio — contribution", () => {
  it("counts what reached a terminal stage and what is still open", () => {
    const { contribution } = buildPortfolio(input());
    expect(contribution.delivered).toBe(1);
    expect(contribution.live).toBe(1);
    expect(contribution.medianTurnaroundDays).toBeGreaterThan(0);
  });

  it("reports the hours it was handed, not the whole log", () => {
    expect(buildPortfolio(input()).contribution.hours).toBe(2);
  });

  it("is empty when the vault is", () => {
    const portfolio = buildPortfolio(
      input({ publications: [], profile: [], views: [], entries: [] }),
    );
    expect(portfolio.empty).toBe(true);
  });
});
