/**
 * The publications tracker (CLAUDE.md §7 B5).
 *
 * Three panels behind one segmented control, because they answer three
 * different questions and showing all of them at once is the pile-of-views
 * problem §7 A3 set out to avoid:
 *
 *  - **In flight** — what is with a journal, and which decision is late. This
 *    is the daily one, so it opens first.
 *  - **List** — the formatted publication list, ready to paste into a CV or a
 *    report (§5.4).
 *  - **Impact** — the numbers that go in front of a funding committee.
 *
 * Everything about *which* items and *what* the numbers are lives in
 * `domain/publication`; this file paints.
 */

import { useState } from "preact/hooks";
import { NewNoteButton } from "./NewNoteButton";
import { CITATION_FORMATS, formatList, type CitationFormat } from "../domain/publication/citation";
import { impactReport } from "../domain/publication/metrics";
import {
  inFlight,
  publicationsInFlight,
  stageLabel,
  type PublicationNote,
} from "../domain/publication/publication";
import { nextStages } from "../domain/publication/stages";
import { DAY_MS } from "../domain/time/dates";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

type Panel = "flight" | "list" | "impact";

const PANELS: { id: Panel; label: string }[] = [
  { id: "flight", label: "In flight" },
  { id: "list", label: "List" },
  { id: "impact", label: "Impact" },
];

const FORMAT_LABEL: Record<CitationFormat, string> = {
  vancouver: "Vancouver",
  apa: "APA",
};

function Empty({ children }: { children: preact.ComponentChildren }) {
  return <p class="scdb-empty">{children}</p>;
}

/* --------------------------------------------------------------- in flight -- */

/** How late the journal's answer is, in the one phrasing the board uses. */
function decisionState(
  publication: PublicationNote,
  now: number,
): { label: string; className: string; glyph: string } | null {
  if (publication.decisionDue === null) return null;
  const days = Math.round((publication.decisionDue - now) / DAY_MS);
  if (days < 0) {
    return {
      label: `decision ${count(-days, "day")} overdue`,
      className: "scdb-state--overdue",
      glyph: "!",
    };
  }
  if (days <= 14) {
    return { label: `decision in ${count(days, "day")}`, className: "scdb-state--at-risk", glyph: "~" };
  }
  return { label: `decision in ${count(days, "day")}`, className: "scdb-state--on-track", glyph: "·" };
}

function FlightRow({
  publication,
  plugin,
  now,
}: {
  publication: PublicationNote;
  plugin: ScdbCockpitPlugin;
  now: number;
}) {
  const decision = decisionState(publication, now);
  const moves = nextStages(publication.stage);

  return (
    <li class="scdb-card">
      <button
        type="button"
        class="scdb-card__main"
        onClick={() => plugin.openNote(publication.path)}
        aria-label={`Open ${publication.id}`}
      >
        <span class="scdb-card__id">{publication.id || "(no id)"}</span>
        <span class="scdb-card__title">{publication.title || "(untitled)"}</span>
        <span class="scdb-card__meta">
          {/* Glyph and word as well as colour (§6). */}
          <span class="scdb-chip">{stageLabel(publication.stage)}</span>
          {publication.journal !== "" && <span class="scdb-chip">{publication.journal}</span>}
          {decision === null ? (
            <span class="scdb-muted">no decision date recorded</span>
          ) : (
            <span class={`scdb-state ${decision.className}`}>
              <span aria-hidden="true">{decision.glyph}</span> {decision.label}
            </span>
          )}
          {publication.scdbSupported && (
            <span class="scdb-chip" title="The facility contributed data to this manuscript.">
              SCDB
            </span>
          )}
          {publication.problems.length > 0 && (
            <span class="scdb-chip scdb-chip--problem" title={publication.problems.join("\n")}>
              check the note
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        class="scdb-card__action"
        disabled={moves.length === 0}
        title={
          moves.length === 0
            ? "A published manuscript has nowhere left to go."
            : `Move to ${moves.map(stageLabel).join(", ")}`
        }
        onClick={() => plugin.movePublication(publication)}
      >
        Move
      </button>
    </li>
  );
}

function FlightPanel({
  publications,
  plugin,
}: {
  publications: readonly PublicationNote[];
  plugin: ScdbCockpitPlugin;
}) {
  const now = Date.now();
  const live = publicationsInFlight(publications);
  const overdue = live.filter(
    (publication) => publication.decisionDue !== null && publication.decisionDue < now,
  );
  const rest = live.filter((publication) => !overdue.includes(publication));

  return (
    <div class="scdb-stack">
      <section class={overdue.length > 0 ? "scdb-group scdb-group--alarm" : "scdb-group"}>
        <h3 class="scdb-group__title">
          Decision overdue
          <span class="scdb-group__sub">
            {overdue.length === 0 ? "nothing is late" : "the journal was due to answer"}
          </span>
        </h3>
        {overdue.length === 0 ? (
          <Empty>No decision has passed its expected date. Chase-ups appear here first.</Empty>
        ) : (
          <ul class="scdb-cards">
            {overdue.map((publication) => (
              <FlightRow
                key={publication.path}
                publication={publication}
                plugin={plugin}
                now={now}
              />
            ))}
          </ul>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          In flight
          <span class="scdb-group__sub">
            {rest.length === 0 ? "nothing outstanding" : "soonest decision first"}
          </span>
        </h3>
        {rest.length === 0 ? (
          // Two different emptinesses. Saying "nothing is in flight" while the
          // section above lists two overdue manuscripts is simply untrue.
          <>
            <Empty>
              {overdue.length > 0
                ? "Everything in flight is in the overdue list above."
                : `No manuscript is in drafting, review or press. Add a note with type: publication in ${plugin.settings.folders.publications}/ to track one.`}
            </Empty>
            {overdue.length === 0 && (
              <div class="scdb-modal__actions">
                <NewNoteButton plugin={plugin} kind="publication" primary />
              </div>
            )}
          </>
        ) : (
          <ul class="scdb-cards">
            {rest.map((publication) => (
              <FlightRow
                key={publication.path}
                publication={publication}
                plugin={plugin}
                now={now}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------- list -- */

function ListPanel({
  publications,
  plugin,
  format,
  scdbOnly,
}: {
  publications: readonly PublicationNote[];
  plugin: ScdbCockpitPlugin;
  format: CitationFormat;
  scdbOnly: boolean;
}) {
  const groups = formatList(publications, { format, scdbOnly });
  const total = groups.reduce((sum, group) => sum + group.citations.length, 0);
  const uncertain = groups.flatMap((group) =>
    group.citations.flatMap((citation) => citation.uncertain),
  );

  if (total === 0) {
    return (
      <Empty>
        {scdbOnly
          ? "No SCDB-supported manuscript has been accepted, gone to press or been published yet."
          : "No manuscript has been accepted, gone to press or been published yet. Work still in drafting is deliberately left out — a draft is not a publication."}
      </Empty>
    );
  }

  return (
    <div class="scdb-stack">
      {uncertain.length > 0 && (
        // A CV that silently renames a collaborator is worse than one that asks.
        <p class="scdb-warning">
          {count(uncertain.length, "author name")} could not be split into surname and initials
          with confidence: {[...new Set(uncertain.map((name) => name.raw))].join(", ")}. Check the
          formatted names before this goes anywhere.
        </p>
      )}
      {groups.map((group) => (
        <section class="scdb-group" key={String(group.year)}>
          <h3 class="scdb-group__title">
            {group.year === null ? "Undated" : group.year}
            <span class="scdb-group__sub">{count(group.citations.length, "item")}</span>
          </h3>
          <ol class="scdb-citations">
            {group.citations.map((citation) => (
              <li key={citation.publication.path}>
                <button
                  type="button"
                  class="scdb-citation"
                  onClick={() => plugin.openNote(citation.publication.path)}
                >
                  {citation.text}
                </button>
                {citation.year.from !== "published" && (
                  <span
                    class="scdb-chip scdb-chip--problem"
                    title={
                      citation.year.from === "submitted"
                        ? "This is the year it was submitted; the note carries no publication date."
                        : "Taken from the note's history, not a `published` date."
                    }
                  >
                    year from {citation.year.from}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ impact -- */

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="scdb-stat">
      <span class="scdb-stat__value">{value}</span>
      <span class="scdb-stat__label">{label}</span>
      {sub !== undefined && <span class="scdb-stat__sub">{sub}</span>}
    </div>
  );
}

function ImpactPanel({ publications }: { publications: readonly PublicationNote[] }) {
  const report = impactReport(publications);
  const stages = report.byStage.counts.filter((entry) => entry.count > 0);

  return (
    <div class="scdb-stack">
      <div class="scdb-stats">
        <Stat
          label="SCDB-supported"
          value={String(report.scdbSupported)}
          sub={`of ${count(report.total, "manuscript")}`}
        />
        <Stat
          label="of those, in print"
          value={String(report.scdbPublished)}
          sub="accepted, in press or published"
        />
        <Stat
          label="median days to first decision"
          value={report.decision.days === null ? "—" : String(report.decision.days)}
          sub={
            report.decision.days === null
              ? "nothing has been answered yet"
              : `over ${count(report.decision.measured, "manuscript")}` +
                (report.decision.awaiting > 0 ? `, ${report.decision.awaiting} still waiting` : "")
          }
        />
      </div>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          By stage
          <span class="scdb-group__sub">{count(report.total, "manuscript")} in all</span>
        </h3>
        {stages.length === 0 ? (
          <Empty>No manuscript carries a stage yet.</Empty>
        ) : (
          <table class="scdb-table">
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col" class="scdb-num">
                  Manuscripts
                </th>
              </tr>
            </thead>
            <tbody>
              {stages.map((entry) => (
                <tr key={entry.stage}>
                  <td>{entry.label}</td>
                  <td class="scdb-num">{entry.count}</td>
                </tr>
              ))}
              {report.byStage.unrecognised.map((entry) => (
                <tr key={entry.stage}>
                  <td>
                    {entry.stage}{" "}
                    <span class="scdb-chip scdb-chip--problem" title="Not one of the §5.4 stages.">
                      unrecognised
                    </span>
                  </td>
                  <td class="scdb-num">{entry.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Where the work lands
          <span class="scdb-group__sub">acceptances and rejections, per journal</span>
        </h3>
        {report.journals.length === 0 ? (
          <Empty>No manuscript has been accepted or rejected by a named journal yet.</Empty>
        ) : (
          <table class="scdb-table">
            <thead>
              <tr>
                <th scope="col">Journal</th>
                <th scope="col" class="scdb-num">
                  Landed
                </th>
                <th scope="col" class="scdb-num">
                  Rejected
                </th>
                <th scope="col" class="scdb-num">
                  SCDB
                </th>
              </tr>
            </thead>
            <tbody>
              {report.journals.map((entry) => (
                <tr key={entry.journal}>
                  <td>{entry.journal}</td>
                  <td class="scdb-num">{entry.landed}</td>
                  <td class="scdb-num">{entry.rejected}</td>
                  <td class="scdb-num">{entry.scdbSupported}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Resubmissions
          <span class="scdb-group__sub">the rework a current stage does not show</span>
        </h3>
        {report.resubmissions.length === 0 ? (
          <Empty>
            No manuscript has been sent out more than once — or none records its submissions in{" "}
            <code>history</code>.
          </Empty>
        ) : (
          <ul class="scdb-cards">
            {report.resubmissions.map((entry) => (
              <li class="scdb-card" key={entry.publication.path}>
                <span class="scdb-card__main">
                  <span class="scdb-card__id">{entry.publication.id}</span>
                  <span class="scdb-card__title">{entry.publication.title}</span>
                  <span class="scdb-card__meta">
                    <span class="scdb-chip">
                      {count(entry.count, "resubmission")}
                    </span>
                    {entry.journeys.length > 0 && (
                      <span class="scdb-muted">{entry.journeys.join(" → ")}</span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Output per year
          <span class="scdb-group__sub">accepted, in press or published</span>
        </h3>
        {report.perYear.length === 0 ? (
          <Empty>Nothing is in print yet.</Empty>
        ) : (
          <table class="scdb-table">
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col" class="scdb-num">
                  All
                </th>
                <th scope="col" class="scdb-num">
                  SCDB-supported
                </th>
              </tr>
            </thead>
            <tbody>
              {report.perYear.map((entry) => (
                <tr key={String(entry.year)}>
                  <td>{entry.year ?? "undated"}</td>
                  <td class="scdb-num">{entry.total}</td>
                  <td class="scdb-num">{entry.scdbSupported}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- board -- */

export function PublicationsBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [panel, setPanel] = useState<Panel>("flight");
  const [format, setFormat] = useState<CitationFormat>(plugin.settings.publications.citationFormat);
  const [scdbOnly, setScdbOnly] = useState(false);

  const publications = plugin.publications();
  const live = publications.filter(inFlight).length;

  return (
    <div class="scdb-stack scdb-publications">
      <div class="scdb-toolbar">
        <div class="scdb-segment" role="tablist" aria-label="Publication panel">
          {PANELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={panel === entry.id}
              class={panel === entry.id ? "scdb-segment__on" : "scdb-segment__off"}
              onClick={() => setPanel(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {panel === "list" && (
          <>
            <label class="scdb-control">
              Format{" "}
              <select
                value={format}
                onChange={(event) =>
                  setFormat((event.currentTarget as HTMLSelectElement).value as CitationFormat)
                }
              >
                {CITATION_FORMATS.map((entry) => (
                  <option key={entry} value={entry}>
                    {FORMAT_LABEL[entry]}
                  </option>
                ))}
              </select>
            </label>
            <label class="scdb-control" title="Papers this facility made possible (§5.4).">
              <input
                type="checkbox"
                checked={scdbOnly}
                onChange={(event) => setScdbOnly((event.currentTarget as HTMLInputElement).checked)}
              />{" "}
              SCDB-supported only
            </label>
            <button
              type="button"
              class="scdb-control"
              onClick={() => void plugin.copyPublicationList({ format, scdbOnly })}
            >
              Copy list
            </button>
          </>
        )}

        <span class="scdb-toolbar__spacer" />
        <span class="scdb-muted">
          {publications.length === 0
            ? "No publication notes"
            : `${count(publications.length, "manuscript")} · ${live} in flight`}
        </span>
      </div>

      {panel === "flight" && <FlightPanel publications={publications} plugin={plugin} />}
      {panel === "list" && (
        <ListPanel
          publications={publications}
          plugin={plugin}
          format={format}
          scdbOnly={scdbOnly}
        />
      )}
      {panel === "impact" && <ImpactPanel publications={publications} />}
    </div>
  );
}
