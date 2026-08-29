import { ItemView, type WorkspaceLeaf } from "obsidian";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { stageDwellStats } from "../domain/request/dwell";
import {
  ageing,
  groupByBlockingParty,
  groupByStage,
  rowState,
  summarise,
  type RequestView,
} from "../domain/request/holdup";
import { stageLabelOf } from "../domain/request/workflow";
import { allModes, modeInfo, unhatted } from "../domain/settings/mode";
import type ScdbCockpitPlugin from "../main.js";
import { boardTitle, type BoardId } from "../domain/report/boards";
import { AnalyticsBoard } from "./AnalyticsBoard";
import { OverviewBoard } from "./OverviewBoard";
import { count, displayName, duration, presentState } from "./format";
import { MigrationBoard, strandedCount } from "./MigrationBoard";
import { QueryBoard } from "./QueryBoard";
import { EffortBoard } from "./EffortBoard";
import { PublicationsBoard } from "./PublicationsBoard";
import { PolicyBoard } from "./PolicyBoard";
import { CatalogueBoard } from "./CatalogueBoard";
import { ScriptBoard } from "./ScriptBoard";
import { DeadlinesBoard } from "./DeadlinesBoard";
import { lapsed } from "../domain/events/schedule";
import { groupOutreachByParty, type AgedThread } from "../domain/comms/thread";
import { describeHoldup, mergeHoldup } from "../domain/comms/holdup";

export const COCKPIT_VIEW_TYPE = "scdb-cockpit-view";

export type CockpitTab =
  | "overview"
  | "queue"
  | "holdup"
  | "ageing"
  | "analytics"
  | "explore"
  | "effort"
  | "publications"
  | "policies"
  | "catalogue"
  | "scripts"
  | "deadlines"
  | "migration"
  | "health";

const TABS: { id: CockpitTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "queue", label: "Queue" },
  { id: "holdup", label: "Holdup" },
  { id: "ageing", label: "Ageing" },
  { id: "analytics", label: "Analytics" },
  { id: "explore", label: "Explore" },
  { id: "effort", label: "Effort" },
  { id: "publications", label: "Publications" },
  { id: "policies", label: "Policies" },
  { id: "catalogue", label: "Catalogue" },
  { id: "scripts", label: "Scripts" },
  { id: "deadlines", label: "Deadlines" },
  { id: "migration", label: "Migration" },
  { id: "health", label: "Health" },
];

/**
 * Tabs that export to a static HTML file (§7 A3).
 *
 * Explore is not among them — it has its own CSV and markdown export, which is
 * the right shape for a query result. Migration is a worksheet, not a report.
 */
const EXPORTABLE: BoardId[] = ["queue", "holdup", "ageing", "analytics", "health"];

function isExportable(tab: CockpitTab): tab is BoardId {
  return (EXPORTABLE as string[]).includes(tab);
}

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
          {plugin.settings.hatFilter === "mode" && unhatted(request.hat) && (
            <span
              class="scdb-chip"
              title="No `hat` in the frontmatter, so this shows under every mode. Set one to file it."
            >
              no hat
            </span>
          )}
          {plugin.needsMigration(request) && (
            <span
              class="scdb-chip scdb-chip--problem"
              title="On an older workflow version; it cannot change stage until it is migrated."
            >
              migrate
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

/**
 * One unanswered message, as a card.
 *
 * The same shape as a request card on purpose: this board's whole argument is
 * that a stalled request and an unanswered email about it are the same problem,
 * and two card designs would say otherwise.
 */
function ThreadCard({ entry, plugin }: { entry: AgedThread; plugin: ScdbCockpitPlugin }) {
  return (
    <li class="scdb-card">
      <button
        type="button"
        class="scdb-card__main"
        onClick={() => void plugin.openThreadNote(entry.thread)}
        aria-label={`Open ${entry.thread.id}`}
      >
        <span class="scdb-card__id">{entry.thread.id}</span>
        <span class="scdb-card__title">{entry.thread.subject || "(no subject)"}</span>
        <span class="scdb-card__meta">
          {/* Glyph and word as well as colour (§6). */}
          <span
            class={`scdb-state ${entry.overdue ? "scdb-state--overdue" : "scdb-state--at-risk"}`}
          >
            <span aria-hidden="true">{entry.overdue ? "!" : "~"}</span>
            {entry.overdue ? "No reply" : "Waiting"}
          </span>
          {/* "Recorded" is load-bearing: Tier 0 knows what it composed and
              nothing else, so a reply logged nowhere reads the same as no reply
              at all (§5.10). */}
          <span class="scdb-num">{duration(entry.waitingMs)} with no reply recorded</span>
          <span class="scdb-chip">{entry.thread.channel}</span>
        </span>
      </button>
      <button
        type="button"
        class="scdb-card__action"
        onClick={() => void plugin.answerThread(entry.thread)}
        title="They have replied — close the loop"
      >
        Answered
      </button>
    </li>
  );
}

/**
 * Who the holdup is with — requests and unanswered outreach, one row per person.
 *
 * Merged rather than listed separately (see `domain/comms/holdup`): the same
 * name under two adjacent headings is how the second half gets missed, and
 * missing half of it is the failure this board exists to prevent.
 */
export function HoldupBoard({ views, plugin }: { views: RequestView[]; plugin: ScdbCockpitPlugin }) {
  const people = mergeHoldup(
    groupByBlockingParty(views),
    groupOutreachByParty(plugin.agedThreads()),
  );

  if (people.length === 0) {
    return (
      <Empty>
        Nothing is waiting on anybody. Set <code>blocked_on</code> when you move a request, and
        this becomes the list of people to chase.
      </Empty>
    );
  }

  return (
    <div class="scdb-stack">
      {people.map((person) => (
        <section key={person.party.key} class="scdb-group">
          <h3 class="scdb-group__title">
            {person.party.name}
            <span class="scdb-group__sub">
              {describeHoldup(person)} · longest {duration(person.longestMs)}
              {person.breachedCount > 0 ? ` · ${person.breachedCount} overdue` : ""}
            </span>
            <button
              type="button"
              class="scdb-control scdb-group__action"
              onClick={() => void plugin.openAgenda(person.party.raw)}
            >
              Chase up
            </button>
          </h3>
          <ul class="scdb-cards">
            {person.views.map((view) => (
              <RequestCard key={view.request.uid} view={view} plugin={plugin} />
            ))}
            {person.threads.map((entry) => (
              <ThreadCard key={entry.thread.uid || entry.thread.id} entry={entry} plugin={plugin} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function AgeingBoard({ views, plugin }: { views: RequestView[]; plugin: ScdbCockpitPlugin }) {
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
                  <td>
                    {stageLabelOf(spec, row.stageId)}
                    {/* The label is humanised now, so "pending-approval" no longer
                        announces itself as a dropped stage by looking like a slug.
                        Say it outright instead: this row is dwell time accumulated
                        in a stage the current spec does not declare. */}
                    {spec !== null && !spec.stages.some((s) => s.id === row.stageId) ? (
                      <span class="scdb-muted"> · not in v{spec.version}</span>
                    ) : null}
                  </td>
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

/**
 * The hat being worn, and what it is holding back.
 *
 * Mode filtering is the organising metaphor (§7 A3), but a filter you cannot
 * see is a filter that loses work. So the count of hidden requests is stated
 * next to the switch that reveals them, always — never only when it is zero.
 */
function ModeBar({
  plugin,
  hidden,
  filtered,
}: {
  plugin: ScdbCockpitPlugin;
  hidden: number;
  filtered: boolean;
}) {
  const current = plugin.settings.mode;
  return (
    <div class="scdb-modebar">
      <div class="scdb-modebar__hats" role="group" aria-label="Hat">
        {allModes().map((info) => (
          <button
            key={info.id}
            type="button"
            class={info.id === current ? "scdb-hat scdb-hat--active" : "scdb-hat"}
            aria-pressed={info.id === current}
            title={info.blurb}
            onClick={() => void plugin.setMode(info.id)}
          >
            <span aria-hidden="true">{info.glyph}</span>
            <span>{info.short}</span>
          </button>
        ))}
      </div>
      <p class="scdb-modebar__note">
        {filtered ? (
          <>
            Showing {modeInfo(current).label} work
            {hidden > 0 ? ` · ${count(hidden, "request")} under another hat` : " · nothing hidden"}
          </>
        ) : (
          <>Showing every hat</>
        )}{" "}
        <button
          type="button"
          class="scdb-link"
          onClick={() => void plugin.setHatFilter(filtered ? "all" : "mode")}
        >
          {filtered ? "show all" : `show only ${modeInfo(current).short}`}
        </button>
      </p>
    </div>
  );
}

/** A tab the view has been asked to show. `token` changes on every request. */
export interface TabFocus {
  tab: CockpitTab;
  token: number;
  /** A phrase for the Explore board's English box, when a command supplied one. */
  search?: string;
}

export function CockpitPanel({
  plugin,
  focus,
}: {
  plugin: ScdbCockpitPlugin;
  focus: TabFocus;
}) {
  const [tab, setTab] = useState<CockpitTab>(focus.tab);
  const { views, hidden, filtered } = plugin.visibleRequests();
  const summary = summarise(views);
  const stranded = strandedCount(plugin);
  // The lapsed count rides on the tab as well as the status bar: §7 B3 wants
  // this outranking everything, and the cockpit is where the eye lands first.
  const overdueObligations = lapsed(plugin.eventSchedule()).length;

  // A command may ask for a tab the user has since navigated away from, so the
  // token — not the tab id — is what makes a repeat request take effect.
  useEffect(() => setTab(focus.tab), [focus.token]);

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
            {stranded > 0 && ` · ${stranded} awaiting migration`}
          </p>
        </div>
        <div class="scdb-cockpit__actions">
          {isExportable(tab) && (
            <button
              type="button"
              class="scdb-control"
              title={`Write "${boardTitle(tab)}" to ${plugin.settings.folders.exports}/ as a self-contained HTML file`}
              onClick={() => void plugin.exportBoard(tab)}
            >
              Export board
            </button>
          )}
          <button type="button" class="mod-cta" onClick={() => plugin.startIntake()}>
            New request
          </button>
        </div>
      </header>

      <ModeBar plugin={plugin} hidden={hidden} filtered={filtered} />

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
            {entry.id === "migration" && stranded > 0 && (
              <span class="scdb-tab__count">{stranded}</span>
            )}
            {entry.id === "deadlines" && overdueObligations > 0 && (
              <span class="scdb-tab__count" title="Obligations past their date">
                {overdueObligations}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div class="scdb-cockpit__body">
        {tab === "overview" && <OverviewBoard views={views} plugin={plugin} />}
        {tab === "queue" && <QueueBoard views={views} plugin={plugin} />}
        {tab === "holdup" && <HoldupBoard views={views} plugin={plugin} />}
        {tab === "ageing" && <AgeingBoard views={views} plugin={plugin} />}
        {tab === "analytics" && <AnalyticsBoard views={views} plugin={plugin} />}
        {tab === "explore" && (
          <QueryBoard
            plugin={plugin}
            {...(focus.search === undefined
              ? {}
              : { search: { text: focus.search, token: focus.token } })}
          />
        )}
        {tab === "effort" && <EffortBoard plugin={plugin} />}
        {tab === "publications" && <PublicationsBoard plugin={plugin} />}
        {tab === "policies" && <PolicyBoard plugin={plugin} />}
        {tab === "catalogue" && <CatalogueBoard plugin={plugin} />}
        {tab === "scripts" && <ScriptBoard plugin={plugin} />}
        {tab === "deadlines" && <DeadlinesBoard plugin={plugin} />}
        {tab === "migration" && <MigrationBoard plugin={plugin} />}
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

  private focus: TabFocus = { tab: "overview", token: 0 };

  /** Re-render in place. Preact diffs, so tab and scroll state survive. */
  refresh(): void {
    render(<CockpitPanel plugin={this.plugin} focus={this.focus} />, this.contentEl);
  }

  /** Show one tab — used by the commands that open the cockpit at a board. */
  focusTab(tab: CockpitTab, search?: string): void {
    this.focus =
      search === undefined
        ? { tab, token: this.focus.token + 1 }
        : { tab, token: this.focus.token + 1, search };
    this.refresh();
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
