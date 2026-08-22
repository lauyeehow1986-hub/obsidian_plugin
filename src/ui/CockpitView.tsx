import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { useState } from "preact/hooks";
import { stageDwellStats } from "../domain/request/dwell";
import {
  ageing,
  groupByBlockingParty,
  groupByStage,
  rowState,
  summarise,
  type RequestView,
} from "../domain/request/holdup";
import { resolveStage } from "../domain/request/workflow";
import type ScdbCockpitPlugin from "../main.js";
import { count, displayName, duration, presentState } from "./format";

export const COCKPIT_VIEW_TYPE = "scdb-cockpit-view";

type Tab = "queue" | "holdup" | "ageing" | "health";

const TABS: { id: Tab; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "holdup", label: "Holdup" },
  { id: "ageing", label: "Ageing" },
  { id: "health", label: "Health" },
];

function StateBadge({ view }: { view: RequestView }) {
  const state = presentState(rowState(view));
  return (
    <span class={`scdb-state ${state.className}`} title={state.label}>
      <span aria-hidden="true">{state.glyph}</span> {state.label}
    </span>
  );
}

function RequestCard({ view, plugin }: { view: RequestView; plugin: ScdbCockpitPlugin }) {
  const { request, metrics } = view;
  return (
    <li class="scdb-card">
      <button
        type="button"
        class="scdb-card__main"
        onClick={() => plugin.showRequest(request)}
        aria-label={`Open ${request.id}`}
      >
        <span class="scdb-card__id">{request.id || request.uid.slice(0, 8)}</span>
        <span class="scdb-card__title">{request.title || "(untitled)"}</span>
        <span class="scdb-card__meta">
          <StateBadge view={view} />
          <span class="scdb-num">{duration(metrics.currentDwellMs)} here</span>
          <span class="scdb-muted scdb-num">{duration(metrics.totalAgeMs)} old</span>
          {metrics.bounceCount > 0 && (
            <span class="scdb-chip" title="Sent back — rework">
              ↩ {metrics.bounceCount}
            </span>
          )}
          {metrics.blockedOn !== null && (
            <span class="scdb-chip scdb-chip--blocked">
              waiting on {displayName(metrics.blockedOn)}
            </span>
          )}
          {metrics.problems.length > 0 && (
            <span class="scdb-chip scdb-chip--problem" title={metrics.problems.join("\n")}>
              needs attention
            </span>
          )}
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

function Empty({ children }: { children: preact.ComponentChildren }) {
  return <p class="scdb-empty">{children}</p>;
}

function QueueBoard({ views, plugin }: { views: RequestView[]; plugin: ScdbCockpitPlugin }) {
  const spec = plugin.workflows.only();
  const groups = groupByStage(views, spec).filter(
    (group) => group.views.length > 0 || spec !== null,
  );

  if (views.length === 0) {
    return (
      <Empty>
        No requests yet. Run <strong>SCDB: New request</strong> to open the first one, or add a
        note with <code>type: scdb-request</code> to {plugin.settings.folders.requests}/.
      </Empty>
    );
  }

  return (
    <div class="scdb-columns">
      {groups.map((group) => (
        <section key={group.stageId} class="scdb-column">
          <h3 class="scdb-column__title">
            {group.label}
            <span class="scdb-column__count">{group.views.length}</span>
          </h3>
          <p class="scdb-column__sub">
            {group.views.length === 0
              ? "empty"
              : `longest ${duration(group.longestDwellMs)}${group.breachedCount > 0 ? ` · ${group.breachedCount} overdue` : ""}`}
          </p>
          <ul class="scdb-cards">
            {group.views.map((view) => (
              <RequestCard key={view.request.uid} view={view} plugin={plugin} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HoldupBoard({ views, plugin }: { views: RequestView[]; plugin: ScdbCockpitPlugin }) {
  const groups = groupByBlockingParty(views);
  if (groups.length === 0) {
    return (
      <Empty>
        Nothing is waiting on anybody. Set <code>blocked_on</code> when you move a request, and
        this becomes the list of people to chase.
      </Empty>
    );
  }
  return (
    <div class="scdb-stack">
      {groups.map((group) => (
        <section key={group.party} class="scdb-group">
          <h3 class="scdb-group__title">
            {displayName(group.party)}
            <span class="scdb-group__sub">
              {count(group.views.length, "request")} · longest{" "}
              {duration(group.longestBlockedMs)}
              {group.breachedCount > 0 ? ` · ${group.breachedCount} overdue` : ""}
            </span>
          </h3>
          <ul class="scdb-cards">
            {group.views.map((view) => (
              <RequestCard key={view.request.uid} view={view} plugin={plugin} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AgeingBoard({ views, plugin }: { views: RequestView[]; plugin: ScdbCockpitPlugin }) {
  const [all, setAll] = useState(false);
  const rows = ageing(views, { includeOnTrack: all });

  return (
    <div class="scdb-stack">
      <label class="scdb-toggle">
        <input
          type="checkbox"
          checked={all}
          onChange={(event) => setAll((event.target as HTMLInputElement).checked)}
        />
        Show requests that are on track too
      </label>

      {rows.length === 0 ? (
        <Empty>
          {all
            ? "There is nothing in the queue."
            : "Nothing is overdue or close to it. The queue is healthy."}
        </Empty>
      ) : (
        <ul class="scdb-cards">
          {rows.map((view) => (
            <RequestCard key={view.request.uid} view={view} plugin={plugin} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HealthBoard({ views, plugin }: { views: RequestView[]; plugin: ScdbCockpitPlugin }) {
  const spec = plugin.workflows.only();
  const stats = stageDwellStats(
    views.map((v) => ({ request: v.request, metrics: v.metrics })),
    spec,
  ).filter((s) => s.closedCount > 0 || s.openCount > 0);

  const specProblems = plugin.workflows.problems();
  const noteProblems = views.filter((v) => v.metrics.problems.length > 0);

  return (
    <div class="scdb-stack">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Median dwell per stage
          <span class="scdb-group__sub">completed occupancies only</span>
        </h3>
        {stats.length === 0 ? (
          <Empty>No stage has been left yet, so there is nothing to average.</Empty>
        ) : (
          <table class="scdb-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th class="scdb-num">Median</th>
                <th class="scdb-num">Completed</th>
                <th class="scdb-num">Open now</th>
                <th class="scdb-num">Longest open</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.stageId}>
                  <td>{spec ? (resolveStage(spec, row.stageId)?.label ?? row.stageId) : row.stageId}</td>
                  <td class="scdb-num">{duration(row.medianClosedMs)}</td>
                  <td class="scdb-num">{row.closedCount}</td>
                  <td class="scdb-num">{row.openCount}</td>
                  <td class="scdb-num">{duration(row.longestOpenMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">Workflow specifications</h3>
        {plugin.workflows.all().length === 0 ? (
          <Empty>
            No workflow found in {plugin.settings.folders.config}/workflows/. Add a YAML spec
            there and the boards will follow its stages.
          </Empty>
        ) : (
          <ul class="scdb-list">
            {plugin.workflows.all().map((loaded) => (
              <li key={loaded.path}>
                <code>{loaded.path}</code> —{" "}
                {loaded.spec
                  ? `${loaded.spec.label} v${loaded.spec.version}, ${count(loaded.spec.stages.length, "stage")}`
                  : "could not be loaded"}
              </li>
            ))}
          </ul>
        )}
        {specProblems.length > 0 && (
          <ul class="scdb-list scdb-list--problems">
            {specProblems.map(({ path, problem }, index) => (
              <li key={`${path}-${index}`}>
                <strong>{problem.severity === "error" ? "Error" : "Warning"}</strong> in {path} at{" "}
                {problem.at}: {problem.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">Notes that need attention</h3>
        {noteProblems.length === 0 ? (
          <Empty>Every request note reads cleanly.</Empty>
        ) : (
          <ul class="scdb-list scdb-list--problems">
            {noteProblems.map((view) => (
              <li key={view.request.uid}>
                <button type="button" class="scdb-link" onClick={() => plugin.showRequest(view.request)}>
                  {view.request.id || view.request.uid}
                </button>
                : {view.metrics.problems.join(" ")}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function CockpitPanel({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [tab, setTab] = useState<Tab>("queue");
  const views = plugin.index.views({ now: Date.now() });
  const summary = summarise(views);

  return (
    <div class="scdb-cockpit">
      <header class="scdb-cockpit__header">
        <div>
          <h2 class="scdb-cockpit__title">SCDB Cockpit</h2>
          <p class="scdb-cockpit__summary">
            {count(summary.live, "live request")} · {summary.breached} overdue ·{" "}
            {summary.atRisk} at risk · {summary.blocked} waiting on someone
            {summary.bounced > 0 && ` · ${summary.bounced} bounced`}
            {summary.completed > 0 && ` · ${summary.completed} complete`}
          </p>
        </div>
        <button type="button" class="mod-cta" onClick={() => plugin.startIntake()}>
          New request
        </button>
      </header>

      <nav class="scdb-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            class={tab === entry.id ? "scdb-tab scdb-tab--active" : "scdb-tab"}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div class="scdb-cockpit__body">
        {tab === "queue" && <QueueBoard views={views} plugin={plugin} />}
        {tab === "holdup" && <HoldupBoard views={views} plugin={plugin} />}
        {tab === "ageing" && <AgeingBoard views={views} plugin={plugin} />}
        {tab === "health" && <HealthBoard views={views} plugin={plugin} />}
      </div>
    </div>
  );
}

export class CockpitView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ScdbCockpitPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return COCKPIT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "SCDB Cockpit";
  }

  override getIcon(): string {
    return "layout-dashboard";
  }

  /** Re-render in place. Preact diffs, so tab and scroll state survive. */
  refresh(): void {
    render(<CockpitPanel plugin={this.plugin} />, this.contentEl);
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("scdb-root");
    this.refresh();
  }

  override async onClose(): Promise<void> {
    // Preact needs an explicit unmount or the tree leaks when the leaf closes.
    render(null, this.contentEl);
  }
}
