/**
 * Deadlines and recurring obligations (CLAUDE.md §7 B3).
 *
 * The lapsed list sits at the top, on its own, whatever else is on the board —
 * §7 B3 asks for an alarm that outranks everything else in the UI, and a
 * lapsed obligation buried three sections down is not one. Everything about
 * which items and in what order is decided in `domain/events/schedule`; this
 * file paints.
 */

import { useState } from "preact/hooks";
import { describeRecurrence } from "../domain/events/recurrence";
import type { Occurrence, OccurrenceState } from "../domain/events/schedule";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

const STATE_LABEL: Record<OccurrenceState, string> = {
  lapsed: "lapsed",
  unscheduled: "no date",
  today: "today",
  soon: "coming up",
  upcoming: "upcoming",
  far: "later",
  passed: "passed",
};

function Empty({ children }: { children: preact.ComponentChildren }) {
  return <p class="scdb-empty">{children}</p>;
}

/** "in 23 days", "12 days ago", "today". One phrasing across the board. */
function when(occurrence: Occurrence): string {
  if (occurrence.date === "") return "no date";
  if (occurrence.inDays === 0) return "today";
  return occurrence.inDays > 0
    ? `in ${count(occurrence.inDays, "day")}`
    : `${count(-occurrence.inDays, "day")} ago`;
}

function Row({ occurrence, plugin }: { occurrence: Occurrence; plugin: ScdbCockpitPlugin }) {
  const note = occurrence.note;
  const overdue = occurrence.state === "lapsed" || occurrence.state === "unscheduled";

  return (
    <li class="scdb-card">
      <button
        type="button"
        class="scdb-card__main"
        onClick={() => plugin.openNote(note.path)}
        aria-label={`Open ${note.id}`}
      >
        <span class="scdb-card__id">{note.id}</span>
        <span class="scdb-card__title">{note.title || "(untitled)"}</span>
        <span class="scdb-card__meta">
          {/* Glyph and word as well as colour (§6). */}
          <span
            class={`scdb-state ${overdue ? "scdb-state--overdue" : occurrence.state === "today" || occurrence.state === "soon" ? "scdb-state--at-risk" : "scdb-state--on-track"}`}
          >
            <span aria-hidden="true">{overdue ? "!" : occurrence.state === "today" ? "•" : "~"}</span>{" "}
            {STATE_LABEL[occurrence.state]}
          </span>
          <span class="scdb-num">
            {occurrence.date === "" ? "nothing scheduled" : `${occurrence.date} · ${when(occurrence)}`}
          </span>
          {occurrence.source === "computed" && (
            <span class="scdb-chip" title="Worked out from the recurrence rule; not written on the note.">
              computed
            </span>
          )}
          {note.recurrence !== null && (
            <span class="scdb-chip">{describeRecurrence(note.recurrence)}</span>
          )}
          {occurrence.leadFired !== null && (
            <span class="scdb-chip" title={`The ${occurrence.leadFired}-day reminder has fired.`}>
              {occurrence.leadFired}d warning
            </span>
          )}
          {note.owner !== "" && <span class="scdb-chip">{plainName(note.owner)}</span>}
          {note.consequence !== "" && (
            // §5.7: a reminder that does not say what breaks gets ignored.
            <span class="scdb-chip scdb-chip--problem" title={note.consequence}>
              {note.consequence}
            </span>
          )}
          {note.problems.length > 0 && (
            <span class="scdb-chip scdb-chip--problem" title={note.problems.join("\n")}>
              check the note
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        class="scdb-card__action"
        onClick={() => void plugin.completeObligation(note)}
        title={
          note.recurrence === null
            ? "Record it as done"
            : "Record it as done and move to the next occurrence"
        }
      >
        Done
      </button>
    </li>
  );
}

function plainName(value: string): string {
  return value.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|").pop()!.trim();
}

function Section({
  title,
  sub,
  rows,
  plugin,
  empty,
  alarm,
}: {
  title: string;
  sub: string;
  rows: Occurrence[];
  plugin: ScdbCockpitPlugin;
  empty: string;
  alarm?: boolean;
}) {
  return (
    <section class={alarm === true ? "scdb-group scdb-group--alarm" : "scdb-group"}>
      <h3 class="scdb-group__title">
        {title}
        <span class="scdb-group__sub">{sub}</span>
      </h3>
      {rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul class="scdb-cards">
          {rows.map((row) => (
            <Row key={row.note.path} occurrence={row} plugin={plugin} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DeadlinesBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [showLater, setShowLater] = useState(false);
  const schedule = plugin.eventSchedule();
  const plans = plugin.events.plans();

  const pick = (...states: OccurrenceState[]) =>
    schedule.filter((entry) => states.includes(entry.state));

  const lapsedRows = pick("lapsed");
  const blind = pick("unscheduled").filter((entry) => entry.alerting);
  const soonRows = pick("today", "soon");
  const upcomingRows = pick("upcoming");
  const laterRows = pick("far");
  const passedRows = pick("passed");
  const undated = pick("unscheduled").filter((entry) => !entry.alerting);

  return (
    <div class="scdb-stack scdb-deadlines">
      <div class="scdb-toolbar">
        <button type="button" class="mod-cta" onClick={() => void plugin.newObligation()}>
          New deadline
        </button>
        <button
          type="button"
          class="scdb-control"
          disabled={plans.length === 0}
          title="Write the computed next occurrence into each note's due date"
          onClick={() => void plugin.materialiseOccurrences()}
        >
          Materialise {plans.length > 0 ? `(${plans.length})` : ""}
        </button>
        <button
          type="button"
          class="scdb-control"
          title={`Write ${plugin.events.calendarPath()} for Outlook to import or subscribe to`}
          onClick={() => void plugin.exportCalendar()}
        >
          Export calendar
        </button>
        <button
          type="button"
          class="scdb-control"
          title="Read an .ics saved into this vault and create event notes from it"
          onClick={() => void plugin.importCalendar()}
        >
          Import calendar
        </button>
        <span class="scdb-toolbar__spacer" />
        <span class="scdb-muted">
          {schedule.length === 0
            ? "Nothing scheduled"
            : `${count(schedule.length, "note")} watched`}
        </span>
      </div>

      {/* The alarm §7 B3 asks for. Rendered first and unconditionally, so its
          absence is as legible as its presence. */}
      <Section
        alarm={lapsedRows.length > 0 || blind.length > 0}
        title="Lapsed"
        sub={
          lapsedRows.length + blind.length === 0
            ? "nothing has been missed"
            : "past its date, or with no date at all"
        }
        rows={[...lapsedRows, ...blind]}
        plugin={plugin}
        empty="No obligation has lapsed, and every recurring one has a date the engine can compute."
      />

      <Section
        title="Due now"
        sub="today, or inside a lead time"
        rows={soonRows}
        plugin={plugin}
        empty="Nothing falls due today and no lead time has been reached."
      />

      <Section
        title="Coming up"
        sub={`inside the next ${count(plugin.settings.briefing.horizonDays, "day")}`}
        rows={upcomingRows}
        plugin={plugin}
        empty="Nothing else falls due inside the horizon."
      />

      {(laterRows.length > 0 || passedRows.length > 0 || undated.length > 0) && (
        <section class="scdb-group">
          <h3 class="scdb-group__title">
            Beyond the horizon
            <span class="scdb-group__sub">
              {[
                laterRows.length > 0 ? `${count(laterRows.length, "date")} further out` : "",
                passedRows.length > 0 ? `${count(passedRows.length, "event")} already happened` : "",
                undated.length > 0 ? `${count(undated.length, "note")} with no date` : "",
              ]
                .filter((part) => part !== "")
                .join(" · ")}
            </span>
            <button
              type="button"
              class="scdb-control scdb-group__action"
              onClick={() => setShowLater((current) => !current)}
            >
              {showLater ? "Hide" : "Show"}
            </button>
          </h3>
          {showLater && (
            <ul class="scdb-cards">
              {[...laterRows, ...undated, ...passedRows].map((row) => (
                <Row key={row.note.path} occurrence={row} plugin={plugin} />
              ))}
            </ul>
          )}
        </section>
      )}

      <p class="scdb-empty">
        Reminders are in-app only — this board, a status-bar badge and a notice. Nothing is
        emailed and no OS notification is raised. The calendar file is written into{" "}
        {plugin.settings.folders.exports}/ and goes nowhere until you point Outlook at it.
      </p>
    </div>
  );
}
