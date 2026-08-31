import {
  describeGovernanceRisk,
  dwellDistribution,
  governanceRisk,
  medianDwellByStage,
  queueByStage,
  topBlockingParties,
  turnaroundTrend,
  workloadByHat,
} from "../domain/request/analytics";
import type { RequestView } from "../domain/request/holdup";
import { barChart, trendChart } from "../domain/report/charts";
import { allModes } from "../domain/settings/mode";
import type ScdbCockpitPlugin from "../main.js";
import { Chart } from "./charts/Chart";

/**
 * Bottleneck analytics (CLAUDE.md §7 A3).
 *
 * Every number here comes from `domain/request/analytics`, and every chart is
 * laid out by `domain/report/charts`, so what the export writes is what the
 * screen shows. This file only decides which charts appear and in what order.
 *
 * Order is deliberate: where the work is, then how long it sits, then who is
 * holding it, then whether governance is the reason. That is the sequence you
 * would follow to answer "why is the queue slow?" — and the last of those is
 * the one that turns a task tracker into a governance instrument (§5.2).
 */
export function AnalyticsBoard({
  views,
  plugin,
}: {
  views: RequestView[];
  plugin: ScdbCockpitPlugin;
}) {
  const spec = plugin.workflows.onlyRequestSpec();
  const now = Date.now();
  const hats = allModes().map((info) => ({ id: info.id, label: info.label }));

  // Hat workload reads every request, filter or no filter: the point of the
  // chart is to show what the hat you are not wearing is carrying.
  const everything = plugin.index.views({ now });
  const risk = governanceRisk(views, spec, now);

  return (
    <div class="scdb-stack">
      <div class="scdb-chartgrid">
        <Chart node={barChart(queueByStage(views, spec))} />
        <Chart node={barChart(medianDwellByStage(views, spec))} />
        <Chart node={barChart(dwellDistribution(views))} />
        <Chart node={barChart(topBlockingParties(views))} />
        <Chart node={barChart(workloadByHat(everything, hats))} />
        <Chart node={trendChart(turnaroundTrend(views, { now }))} />
      </div>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Governance
          <span class="scdb-group__sub">assessed against the workflow spec's own gates</span>
        </h3>
        <p class="scdb-chart__foot">{describeGovernanceRisk(risk)}</p>
        <Chart node={barChart(risk.byGate)} />
        {risk.blocked.length > 0 && (
          <ul class="scdb-list">
            {risk.blocked.map((view) => (
              <li key={view.request.uid}>
                <button
                  type="button"
                  class="scdb-link"
                  onClick={() => plugin.showRequest(view.request)}
                >
                  {view.request.id || view.request.uid}
                </button>{" "}
                — {view.request.title || "(untitled)"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p class="scdb-empty">
        Effort by activity is not here yet: it needs the effort log in{" "}
        {plugin.settings.folders.time}/, which arrives with the time HUD (B2).
      </p>
    </div>
  );
}
