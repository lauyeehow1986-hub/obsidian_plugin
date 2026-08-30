import { useEffect, useMemo, useState } from "preact/hooks";
import type { TimeEntry } from "../domain/effort/entry";
import { buildPortfolio, type ProjectSummary } from "../domain/project/portfolio";
import type { MilestoneStatus } from "../domain/project/milestones";
import type ScdbCockpitPlugin from "../main.js";
import { count, duration, presentMilestone, presentState } from "./format";

/**
 * The portfolio board (CLAUDE.md §7 B8).
 *
 * One board, deliberately: every project by stage, what each is waiting on,
 * which milestones are late, and effort to date against estimate. B8 says a
 * milestone reaches the briefing through the *event* engine, so nothing here
 * reminds anybody of anything — this is the place you come to look, not a
 * second thing that shouts.
 *
 * No Gantt chart, no percent-complete, no burndown (§5.15). A milestone landed
 * or it has not.
 */

function MilestoneRow({ status }: { status: MilestoneStatus }) {
  const state = presentMilestone(status.state);
  return (
    <li class="scdb-milestone">
      <span class={`scdb-state ${state.className}`} title={state.label}>
        <span aria-hidden="true">{state.glyph}</span> {state.label}
      </span>
      <span class="scdb-milestone__id">{status.milestone.id}</span>
      <span class="scdb-milestone__title">{status.explanation}</span>
      {status.overdueByMs > 0 && (
        <span class="scdb-muted scdb-num" title="Past its date">
          {duration(status.overdueByMs)} over
        </span>
      )}
    </li>
  );
}

function ProjectCard({
  summary,
  plugin,
}: {
  summary: ProjectSummary;
  plugin: ScdbCockpitPlugin;
}) {
  const { project, metrics } = summary;
  const sla = presentState(metrics.dueSla.state);
  // Landed milestones are folded away by default: the board is about what is
  // outstanding, and a finished project would otherwise be the longest card.
  const outstanding = summary.milestones.filter((status) => status.state !== "done");

  return (
    <li class="scdb-card">
      <button
        type="button"
        class="scdb-card__main"
        onClick={() => plugin.showProject(project)}
        aria-label={`Open ${project.id || project.title}`}
      >
        <span class="scdb-card__id">{project.id || "(no id)"}</span>
        <span class="scdb-card__title">{project.title || "(untitled)"}</span>
        <span class="scdb-card__meta">
          <span class={`scdb-state ${sla.className}`} title={sla.label}>
            <span aria-hidden="true">{sla.glyph}</span> {sla.label}
          </span>
          <span class="scdb-muted scdb-num" title="Time in the current stage">
            {duration(metrics.currentDwellMs)} in {summary.stageLabel.toLowerCase()}
          </span>
          <span class="scdb-muted scdb-num" title="Milestones landed of the total">
            {summary.landedMilestones}/{summary.milestones.length} landed
          </span>
          <span class="scdb-muted scdb-num" title={summary.effort.text}>
            {summary.effort.text}
          </span>
        </span>
        <span class="scdb-card__note">{summary.waitingOn}</span>
      </button>

      {outstanding.length > 0 && (
        <ul class="scdb-list scdb-milestones">
          {outstanding.map((status) => (
            <MilestoneRow key={status.milestone.id} status={status} />
          ))}
        </ul>
      )}

      <button
        type="button"
        class="scdb-card__action"
        title="Move this project to another stage"
        onClick={() => plugin.moveProject(project)}
      >
        Move
      </button>
    </li>
  );
}

export function PortfolioBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const projects = plugin.projects();

  // The effort log is a set of monthly files, so reading it is asynchronous.
  // The board renders before they arrive and says "no time recorded" for a
  // moment, which is honest — it is what we know at that instant — rather than
  // blocking the whole portfolio on a file read.
  const [entries, setEntries] = useState<readonly TimeEntry[]>([]);
  useEffect(() => {
    let live = true;
    void plugin.allEffortEntries().then((loaded) => {
      if (live) setEntries(loaded);
    });
    return () => {
      live = false;
    };
  }, [plugin]);

  const board = useMemo(
    () =>
      buildPortfolio(
        projects.map((entry) => entry.project),
        plugin.workflows.forRequest("project"),
        entries,
        { now: Date.now() },
      ),
    [projects, entries, plugin],
  );

  if (board.totals.projects === 0) {
    return (
      <div class="scdb-stack">
        <p class="scdb-empty">
          No projects yet. A project is the months-long shape of work — a rollout, a catalogue
          build, a grant submission — with milestones rather than a requester and an SLA. Run{" "}
          <em>New project</em>, or add a note to <code>{plugin.settings.folders.projects}</code>{" "}
          with <code>type: project</code>, a <code>stage</code> from{" "}
          <code>_config/workflows/project.yaml</code>, and a <code>milestones</code> list.
        </p>
      </div>
    );
  }

  const { totals } = board;
  const columns = board.columns.filter((column) => column.projects.length > 0);

  return (
    <div class="scdb-stack">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Portfolio
          <span class="scdb-group__sub">
            {count(totals.projects, "project")}
            {totals.overdueMilestones > 0 &&
              `, ${count(totals.overdueMilestones, "milestone")} overdue`}
            {totals.blockedMilestones > 0 &&
              `, ${count(totals.blockedMilestones, "milestone")} waiting on a predecessor`}
          </span>
        </h3>

        {board.stranded.length > 0 && (
          <ul class="scdb-list scdb-list--problems">
            <li>
              {count(board.stranded.length, "project")} in a stage the workflow spec does not
              declare: {board.stranded.map((s) => s.project.id || s.project.uid).join(", ")}. Run{" "}
              <em>Migrate stranded notes</em>, or fix the stage in the note.
            </li>
          </ul>
        )}

        {columns.map((column) => (
          <section key={column.stageId} class="scdb-group scdb-group--nested">
            <h4 class="scdb-group__title">
              {column.label}
              <span class="scdb-group__sub">{count(column.projects.length, "project")}</span>
            </h4>
            <ul class="scdb-cards">
              {column.projects.map((summary) => (
                <ProjectCard key={summary.project.uid} summary={summary} plugin={plugin} />
              ))}
            </ul>
          </section>
        ))}
      </section>
    </div>
  );
}
