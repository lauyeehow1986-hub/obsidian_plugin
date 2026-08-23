import type { Overview } from "../domain/overview/overview";
import type { RequestView } from "../domain/request/holdup";
import type ScdbCockpitPlugin from "../main.js";
import { count, duration } from "./format";

/**
 * The cockpit overview (CLAUDE.md §7 A3).
 *
 * Three lists in one pane, in the order you would read them: what needs
 * attention, what falls due, what is in flight. Everything about *which* items
 * and *in what order* is decided in `domain/overview`; this file only paints.
 *
 * The queue-as-columns board stays on its own tab. Putting the stage columns
 * here too would make the overview scroll before it said anything, and the
 * first screen of a cockpit has to be the summary, not the whole cockpit.
 */

const REASON_LABEL: Record<string, string> = {
  problem: "check the note",
  stranded: "needs migrating",
  overdue: "overdue",
  blocked: "blocked",
  "at-risk": "at risk",
};

function Empty({ children }: { children: preact.ComponentChildren }) {
  return <p class="scdb-empty">{children}</p>;
}

function AttentionRow({
  item,
  plugin,
}: {
  item: Overview["attention"][number];
  plugin: ScdbCockpitPlugin;
}) {
  const { request, metrics } = item.view;
  return (
    <li class="scdb-attention">
      <button
        type="button"
        class="scdb-attention__main"
        onClick={() => plugin.showRequest(request)}
      >
        <span class="scdb-attention__head">
          <span class="scdb-card__id">{request.id || request.uid.slice(0, 8)}</span>
          <span class="scdb-card__title">{request.title || "(untitled)"}</span>
        </span>
        <span class="scdb-attention__why">
          {/* Every reason, not just the worst: overdue *and* stranded *and*
              waiting on somebody is a different problem, not a worse one. */}
          {item.reasons.map((reason) => (
            <span
              key={reason.reason}
              class={
                reason.reason === "at-risk"
                  ? "scdb-chip"
                  : "scdb-chip scdb-chip--problem"
              }
              title={reason.detail}
            >
              {REASON_LABEL[reason.reason] ?? reason.reason}
            </span>
          ))}
          <span class="scdb-muted scdb-num">
            {duration(metrics.currentDwellMs)} here · {duration(metrics.totalAgeMs)} old
          </span>
        </span>
      </button>
      <button
        type="button"
        class="scdb-card__action"
        onClick={() => plugin.moveRequest(request)}
        title="Move to another stage"
      >
        Move
      </button>
    </li>
  );
}

export function OverviewBoard({
  views,
  plugin,
}: {
  views: RequestView[];
  plugin: ScdbCockpitPlugin;
}) {
  const overview = plugin.overview(views);
  const shown = overview.attention.slice(0, 12);
  const more = overview.attention.length - shown.length;

  return (
    <div class="scdb-overview">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Needs attention
          <span class="scdb-group__sub">
            {overview.attention.length === 0
              ? "nothing"
              : `${count(overview.attention.length, "request")}, worst first`}
          </span>
        </h3>
        {overview.attention.length === 0 ? (
          <Empty>
            Nothing is overdue, blocked, stranded or unreadable. The queue is in good order.
          </Empty>
        ) : (
          <>
            <ul class="scdb-cards">
              {shown.map((item) => (
                <AttentionRow key={item.view.request.uid} item={item} plugin={plugin} />
              ))}
            </ul>
            {more > 0 && (
              <p class="scdb-muted">
                {count(more, "more request")} on the Ageing and Holdup boards.
              </p>
            )}
          </>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Falling due
          <span class="scdb-group__sub">next 60 days, any note with a date</span>
        </h3>
        {overview.deadlines.length === 0 ? (
          <Empty>
            Nothing falls due in the next 60 days. Add a <code>due</code> date to an event or
            obligation note and it appears here.
          </Empty>
        ) : (
          <ul class="scdb-list">
            {overview.deadlines.map((deadline) => (
              <li key={deadline.path}>
                <button
                  type="button"
                  class="scdb-link"
                  onClick={() => plugin.openNote(deadline.path)}
                >
                  {deadline.id}
                </button>
                {deadline.title === "" ? "" : ` — ${deadline.title}`}{" "}
                <span class={deadline.overdue ? "scdb-state--overdue" : "scdb-muted"}>
                  {deadline.what}{" "}
                  {deadline.overdue
                    ? `${Math.abs(deadline.inDays)} days ago`
                    : `in ${deadline.inDays} days`}
                </span>
                {deadline.consequence !== "" && " "}
                {deadline.consequence !== "" && (
                  // §5.7: a reminder that does not say what breaks gets ignored.
                  <span class="scdb-chip scdb-chip--problem" title={deadline.consequence}>
                    {deadline.consequence}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {overview.unscheduled.length > 0 && (
          <p class="scdb-muted">
            {/* Everything the recurrence engine can date is already in the list
                above, computed. What is left here is a rule it cannot resolve —
                no anchor, or one it could not read. */}
            {count(overview.unscheduled.length, "obligation")}{" "}
            {overview.unscheduled.length === 1 ? "carries" : "carry"} a recurrence rule the
            engine cannot work a date from. The Deadlines tab says which and why.
          </p>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Publications in flight
          <span class="scdb-group__sub">soonest decision first</span>
        </h3>
        {overview.publications.length === 0 ? (
          <Empty>
            Nothing in flight. A note with <code>type: publication</code> in{" "}
            {plugin.settings.folders.publications}/ appears here until it is published,
            rejected or shelved.
          </Empty>
        ) : (
          <ul class="scdb-list">
            {overview.publications.map((publication) => (
              <li key={publication.path}>
                <button
                  type="button"
                  class="scdb-link"
                  onClick={() => plugin.openNote(publication.path)}
                >
                  {publication.id || publication.title}
                </button>{" "}
                <span class="scdb-muted">
                  {publication.stage}
                  {publication.journal === "" ? "" : ` · ${publication.journal}`}
                </span>
                {publication.scdbSupported && " "}
                {publication.scdbSupported && (
                  <span class="scdb-chip" title="SCDB contributed data to this paper (§5.4)">
                    SCDB
                  </span>
                )}
                {publication.problems.length > 0 && " "}
                {publication.problems.length > 0 && (
                  <span class="scdb-chip scdb-chip--problem" title={publication.problems.join(" ")}>
                    check the note
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p class="scdb-empty">
        Blocking parties, ageing and stage columns have their own tabs — this pane is the
        first look, not every board at once.
      </p>
    </div>
  );
}
