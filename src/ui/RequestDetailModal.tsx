import type { App } from "obsidian";
import { useEffect, useState } from "preact/hooks";
import type { EstimateComparison } from "../domain/effort/aggregate";
import type { RequestMetrics } from "../domain/request/dwell";
import type { RequestNote } from "../domain/request/request";
import { resolveStage, type WorkflowSpec } from "../domain/request/workflow";
import { toVaultDate } from "../domain/time/dates";
import { PreactModal } from "./PreactModal";
import { count, displayName, duration, presentState } from "./format";

interface Props {
  request: RequestNote;
  metrics: RequestMetrics;
  spec: WorkflowSpec | null;
  onOpenNote: () => void;
  onMove: () => void;
  /** Time recorded against this request, read from `80 Time/` on open (§7 B2). */
  loadEffort: () => Promise<EstimateComparison>;
  onStartTimer: () => void;
}

function Fact({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function DetailPanel({
  request,
  metrics,
  spec,
  onOpenNote,
  onMove,
  loadEffort,
  onStartTimer,
}: Props) {
  const stage = spec ? resolveStage(spec, request.stage) : null;
  // Loaded rather than passed: the effort log is a set of monthly files, not
  // part of the note index, so reading it is a file read and not free.
  const [effort, setEffort] = useState<EstimateComparison | null>(null);
  useEffect(() => {
    let live = true;
    void loadEffort().then((result) => {
      if (live) setEffort(result);
    });
    return () => {
      live = false;
    };
  }, [loadEffort]);

  const state = presentState(metrics.stageSla.state);
  const dueState = presentState(metrics.dueSla.state);

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">{request.title || "(untitled)"}</p>

      <dl class="scdb-facts">
        <Fact label="Stage">
          {stage?.label ?? request.stage}{" "}
          <span class={`scdb-state ${state.className}`}>
            <span aria-hidden="true">{state.glyph}</span> {state.label}
          </span>
        </Fact>
        <Fact label="In this stage">
          {duration(metrics.currentDwellMs)}
          {metrics.stageSla.targetDays !== null && (
            <span class="scdb-muted"> of {metrics.stageSla.targetDays} days</span>
          )}
        </Fact>
        <Fact label="Total age">
          {duration(metrics.totalAgeMs)}
          {metrics.completed && <span class="scdb-muted"> (complete)</span>}
        </Fact>
        <Fact label="Bounced">
          {metrics.bounceCount === 0
            ? "never"
            : `${count(metrics.bounceCount, "time")} — rework`}
        </Fact>
        <Fact label="Waiting on">
          {displayName(metrics.blockedOn)}
          {metrics.blockedForMs !== null && (
            <span class="scdb-muted"> for {duration(metrics.blockedForMs)}</span>
          )}
        </Fact>
        <Fact label="Due">
          {request.due === null ? "—" : toVaultDate(request.due)}{" "}
          {request.due !== null && (
            <span class={`scdb-state ${dueState.className}`}>
              <span aria-hidden="true">{dueState.glyph}</span> {dueState.label}
            </span>
          )}
        </Fact>
        <Fact label="Effort">
          {effort === null ? (
            <span class="scdb-muted">reading the effort log…</span>
          ) : (
            <>
              {effort.text}
              {effort.state === "over" && (
                <span class="scdb-state scdb-state--at-risk">
                  <span aria-hidden="true">!</span> over estimate
                </span>
              )}
            </>
          )}
        </Fact>
        <Fact label="Requester">{displayName(request.requester)}</Fact>
        <Fact label="Study">{displayName(request.study)}</Fact>
        <Fact label="eData ref">
          {request.externalRef || "—"}
          <span class="scdb-muted">
            {request.externalRef === ""
              ? ""
              : request.lastReconciled === null
                ? " · never reconciled"
                : ` · reconciled ${toVaultDate(request.lastReconciled)}`}
          </span>
        </Fact>
        <Fact label="Identifiers">
          {String(
            (request.raw["governance"] as Record<string, unknown> | undefined)?.["identifiers"] ??
              "—",
          )}
        </Fact>
      </dl>

      {metrics.perStageMs.length > 0 && (
        <section class="scdb-section">
          <h3 class="scdb-section__title">Time per stage</h3>
          <table class="scdb-table">
            <tbody>
              {metrics.perStageMs.map((row) => (
                <tr key={row.stageId}>
                  <td>{spec ? (resolveStage(spec, row.stageId)?.label ?? row.stageId) : row.stageId}</td>
                  <td class="scdb-num">{duration(row.ms)}</td>
                  <td class="scdb-num scdb-muted">
                    {row.visits > 1 ? `${row.visits} visits` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {request.evidence.length > 0 && (
        <section class="scdb-section">
          <h3 class="scdb-section__title">Evidence</h3>
          <ul class="scdb-list">
            {request.evidence.map((record, index) => (
              <li key={`${record.claim}-${index}`}>
                <strong>{record.claim}</strong> — {record.via ?? "no method recorded"}
                {record.on !== null && `, ${toVaultDate(record.on)}`}
                {record.by !== "" && `, by ${displayName(record.by)}`}
                {!record.hard && (
                  <span class="scdb-state scdb-state--at-risk">
                    <span aria-hidden="true">~</span> cannot satisfy a gate alone
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="scdb-section">
        <h3 class="scdb-section__title">History</h3>
        <table class="scdb-table">
          <tbody>
            {request.history.map((entry, index) => (
              <tr key={`${entry.at}-${index}`}>
                <td class="scdb-muted">{toVaultDate(entry.at)}</td>
                <td>{spec ? (resolveStage(spec, entry.to)?.label ?? entry.to) : entry.to}</td>
                <td class="scdb-muted">{entry.by}</td>
                <td class="scdb-muted">{displayName(entry.blockedOn)}</td>
              </tr>
            ))}
            {request.history.length === 0 && (
              <tr>
                <td class="scdb-muted">No history recorded.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {metrics.problems.length > 0 && (
        <section class="scdb-section scdb-section--problems">
          <h3 class="scdb-section__title">This note needs attention</h3>
          <ul class="scdb-list">
            {metrics.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </section>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onOpenNote}>
          Open note
        </button>
        <button type="button" class="scdb-control" onClick={onStartTimer}>
          Start timer
        </button>
        <button type="button" class="mod-cta" onClick={onMove}>
          Move stage
        </button>
      </div>
    </div>
  );
}

export class RequestDetailModal extends PreactModal {
  constructor(
    app: App,
    private readonly options: Props,
  ) {
    super(app);
    this.titleEl.setText(options.request.id || options.request.uid || "Request");
  }

  protected body() {
    return (
      <DetailPanel
        {...this.options}
        onOpenNote={() => {
          this.close();
          this.options.onOpenNote();
        }}
        onMove={() => {
          this.close();
          this.options.onMove();
        }}
        onStartTimer={() => {
          this.close();
          this.options.onStartTimer();
        }}
      />
    );
  }
}
