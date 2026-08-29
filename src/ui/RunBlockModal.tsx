import { Notice, type App, type TFile } from "obsidian";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { describeBlock, LANGUAGE_LABELS, type RunnableBlock } from "../domain/compute/block";
import { formatDuration } from "../domain/compute/outcome";
import { PreactModal } from "./PreactModal";
import { RunBlocked, type ComputeRunner, type RunReport, type RunTicket } from "../services/computeRunner";

/**
 * The dialog that stands between a note and a running process (§7 F1, rule 12).
 *
 * Rule 12 says code never runs by surprise: "only on an explicit action,
 * showing what will run". Both halves are here, and the second half is the one
 * that is easy to short-change —
 *
 *  - **the code is shown, in full, before the button.** Not a summary, not the
 *    first line. A block in a note somebody sent you is untrusted input, and
 *    the only defence against that is a person reading it;
 *  - **so is the interpreter**, because "run this Python" means nothing until
 *    you know which Python;
 *  - **so is the working directory**, because a block that writes a file does
 *    not write it where the author probably assumed.
 *
 * The provenance fields are optional and deliberately few. A dialog that
 * demanded a dataset version before it would run anything would be closed, and
 * a run recorded without one is still worth more than a run not recorded.
 */
export class RunBlockModal extends PreactModal {
  constructor(
    app: App,
    private readonly input: {
      runner: ComputeRunner;
      file: TFile;
      block: RunnableBlock;
      /** Seeded from the note when it happens to be a script doc. */
      seed: { request: string; inputs: { dataset: string; version: string }[]; variables: string[] };
      onDone: (report: RunReport) => void;
    },
  ) {
    super(app);
  }

  protected body() {
    return (
      <RunBlockForm
        {...this.input}
        close={() => {
          this.close();
        }}
      />
    );
  }
}

type Phase = "ready" | "running" | "done";

function RunBlockForm(props: {
  runner: ComputeRunner;
  file: TFile;
  block: RunnableBlock;
  seed: { request: string; inputs: { dataset: string; version: string }[]; variables: string[] };
  onDone: (report: RunReport) => void;
  close: () => void;
}) {
  const { runner, file, block } = props;

  const [phase, setPhase] = useState<Phase>("ready");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [request, setRequest] = useState(props.seed.request);
  const [dataset, setDataset] = useState(props.seed.inputs[0]?.dataset ?? "");
  const [version, setVersion] = useState(props.seed.inputs[0]?.version ?? "");

  const ticket = useRef<RunTicket | null>(null);

  const blockers = useMemo(() => runner.blockers(block.language), [runner, block.language]);
  const interpreter = runner.interpreterFor(block.language);

  useEffect(() => {
    if (phase !== "running") return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  const run = useCallback(() => {
    setError([]);
    setPhase("running");

    const started = runner.start({
      file,
      block,
      request: request.trim(),
      inputs: dataset.trim() === "" ? [] : [{ dataset: dataset.trim(), version: version.trim() }],
      variables: props.seed.variables,
    });
    ticket.current = started;

    void started.done.then(
      (result) => {
        setReport(result);
        setPhase("done");
        props.onDone(result);
      },
      (thrown: unknown) => {
        setError(
          thrown instanceof RunBlocked
            ? thrown.reasons
            : [thrown instanceof Error ? thrown.message : String(thrown)],
        );
        setPhase("ready");
      },
    );
  }, [runner, file, block, request, dataset, version, props]);

  const stop = useCallback(() => {
    ticket.current?.stop();
    new Notice("Stopping the run…");
  }, []);

  return (
    <div class="scdb-modal__body scdb-run-dialog">
      <h3>Run {LANGUAGE_LABELS[block.language]} block</h3>
      <p class="scdb-modal__lede">
        {describeBlock(block)} of <strong>{file.basename}</strong>. Read it before you run it —
        a block in a note is code somebody wrote, and this is the only thing standing between it
        and your machine.
      </p>

      <pre class="scdb-code scdb-code--tall">{block.source.replace(/\s+$/, "")}</pre>

      <dl class="scdb-deflist">
        <dt>Interpreter</dt>
        <dd>{interpreter === "" ? "not configured" : interpreter}</dd>
        <dt>Working directory</dt>
        <dd>
          A temporary folder outside the vault. A file the block writes lands there and is
          discarded; only plots come back.
        </dd>
        <dt>Provenance</dt>
        <dd>
          Output goes under the block, and a run record is written to the runs folder and logged
          as <code>code-run</code>.
        </dd>
      </dl>

      {blockers.length > 0 && (
        <ul class="scdb-list scdb-list--problems">
          {blockers.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {error.length > 0 && (
        <ul class="scdb-list scdb-list--problems">
          {error.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {phase === "ready" && blockers.length === 0 && (
        <details class="scdb-run-extra">
          <summary>Tie this run to a request or a dataset (optional)</summary>
          <div class="scdb-field-row">
            <label class="scdb-field">
              <span class="scdb-field__label">Request</span>
              <input
                type="text"
                placeholder="[[REQ-2026-014]]"
                value={request}
                onInput={(event) => setRequest((event.target as HTMLInputElement).value)}
              />
            </label>
          </div>
          <div class="scdb-field-row">
            <label class="scdb-field">
              <span class="scdb-field__label">Dataset</span>
              <input
                type="text"
                value={dataset}
                onInput={(event) => setDataset((event.target as HTMLInputElement).value)}
              />
            </label>
            <label class="scdb-field">
              <span class="scdb-field__label">Version</span>
              <input
                type="text"
                placeholder="2026-Q2"
                value={version}
                onInput={(event) => setVersion((event.target as HTMLInputElement).value)}
              />
            </label>
          </div>
          <p class="scdb-field__hint">
            Without these the record still pins the code and the interpreter, but not the data —
            and "which extract was this" is the question that gets asked.
          </p>
        </details>
      )}

      {phase === "running" && (
        <p class="scdb-modal__lede">
          Running — {formatDuration(elapsed)} so far. It is a separate process, so Obsidian stays
          responsive and stopping it costs nothing.
        </p>
      )}

      {phase === "done" && report !== null && <Result report={report} />}

      <div class="scdb-modal__actions">
        {phase === "running" ? (
          <>
            <button class="scdb-control" onClick={stop}>
              Stop
            </button>
            <button class="mod-cta" disabled>
              Running…
            </button>
          </>
        ) : phase === "done" ? (
          <button class="mod-cta" onClick={props.close}>
            Close
          </button>
        ) : (
          <>
            <button class="scdb-control" onClick={props.close}>
              Cancel
            </button>
            <button class="mod-cta" disabled={blockers.length > 0} onClick={run}>
              Run it
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Result(props: { report: RunReport }) {
  const { outcome, plan } = props.report;
  const failed = outcome.exit !== "ok";

  return (
    <div class="scdb-run-result">
      <p class="scdb-modal__lede">
        <strong>
          {failed ? "✕" : "✓"} {plan.id}
        </strong>{" "}
        · {outcome.exit} · {formatDuration(outcome.durationMs)} ·{" "}
        {outcome.figures.length === 0
          ? "no figures"
          : `${outcome.figures.length} figure${outcome.figures.length === 1 ? "" : "s"}`}
      </p>
      <p class="scdb-field__hint">
        The output is under the block in the note. {props.report.replaced ? "It replaced the previous run's." : ""}
      </p>
      {plan.weaknesses.length > 0 && (
        <ul class="scdb-list scdb-list--advisory">
          {plan.weaknesses.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
