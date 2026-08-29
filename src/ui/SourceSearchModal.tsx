import { Notice, type App, type TFile } from "obsidian";
import { useCallback, useMemo, useState } from "preact/hooks";
import type { TrialRecord } from "../domain/sources/ctgov";
import { TRIAL_STATUSES, humanPhase, humanStatus } from "../domain/sources/ctgov";
import { MISSING_SOURCE, SOURCES, type SourceId } from "../domain/sources/gateway";
import type { PubmedRecord } from "../domain/sources/pubmed";
import type { SourceSearch } from "../services/sourceSearch";
import type { SourceWriter } from "../services/sourceWriter";
import { PreactModal } from "./PreactModal";

/**
 * Searching an external source (§7 E1).
 *
 * The dialog carries rules 3 and 4 between them, and the second is the one
 * worth being careful about. Rule 4 says note content never leaves implicitly,
 * and that "any feature that would send note text anywhere external needs
 * explicit per-action confirmation **with the payload shown first**".
 *
 * So the confirmation shows the **literal URL**. Not "searches PubMed for your
 * term" — a sentence describing a request is exactly the thing the reader
 * cannot check. If the address includes your email because you put one in
 * settings, it is visible in that string, which is the point.
 *
 * Nothing is written until results are back and you have chosen what to keep.
 */
export class SourceSearchModal extends PreactModal {
  constructor(
    app: App,
    private readonly input: {
      search: SourceSearch;
      writer: SourceWriter;
      enabled: (source: SourceId) => boolean;
      today: () => { date: string; minute: string };
      onWritten: (file: TFile) => void;
    },
  ) {
    super(app);
  }

  protected body() {
    return (
      <SearchForm
        {...this.input}
        close={() => {
          this.close();
        }}
      />
    );
  }
}

type Phase = "form" | "confirm" | "running" | "results";

interface Results {
  source: SourceId;
  query: string;
  url: string;
  total: number;
  papers: PubmedRecord[];
  trials: TrialRecord[];
  warnings: string[];
  translation: string;
}

function SearchForm(props: {
  search: SourceSearch;
  writer: SourceWriter;
  enabled: (source: SourceId) => boolean;
  today: () => { date: string; minute: string };
  onWritten: (file: TFile) => void;
  close: () => void;
}) {
  const available = useMemo(
    () => (["pubmed", "ctgov"] as const).filter((id) => props.enabled(id)),
    [props],
  );

  const [source, setSource] = useState<SourceId>(available[0] ?? "pubmed");
  const [query, setQuery] = useState("");
  const [condition, setCondition] = useState("");
  const [status, setStatus] = useState<string>("");
  const [recent, setRecent] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());

  const dates = useMemo(() => {
    if (!recent) return {};
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const stamp = (d: Date): string =>
      `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    return { from: stamp(from), to: stamp(to) };
  }, [recent]);

  const preview = useMemo(() => {
    if (source === "pubmed") return props.search.previewPubmed({ query, sort: "pub_date", ...dates });
    return props.search.previewCtgov({
      condition,
      term: query,
      status: status as (typeof TRIAL_STATUSES)[number] | "",
    });
  }, [props.search, source, query, condition, status, dates]);

  const ready =
    source === "pubmed" ? query.trim() !== "" : condition.trim() !== "" || query.trim() !== "";

  const run = useCallback(() => {
    setPhase("running");
    setError("");
    const label = source === "pubmed" ? query : [condition, query].filter((p) => p !== "").join(" / ");

    const done =
      source === "pubmed"
        ? props.search
            .pubmed({ query, sort: "pub_date", ...dates })
            .then((outcome) =>
              outcome.ok
                ? {
                    ok: true as const,
                    value: {
                      source,
                      query: label,
                      url: outcome.value.url,
                      total: outcome.value.total,
                      papers: outcome.value.papers,
                      trials: [],
                      warnings: outcome.value.warnings,
                      translation: outcome.value.translation,
                    },
                  }
                : outcome,
            )
        : props.search
            .ctgov({
              condition,
              term: query,
              status: status as (typeof TRIAL_STATUSES)[number] | "",
            })
            .then((outcome) =>
              outcome.ok
                ? {
                    ok: true as const,
                    value: {
                      source,
                      query: label,
                      url: outcome.value.url,
                      total: outcome.value.total,
                      papers: [],
                      trials: outcome.value.trials,
                      warnings: [],
                      translation: "",
                    },
                  }
                : outcome,
            );

    void done.then(
      (outcome) => {
        if (!outcome.ok) {
          setError(outcome.why);
          setPhase("form");
          return;
        }
        setResults(outcome.value);
        // Everything ticked to begin with: the common case is keeping the lot,
        // and unticking three is less work than ticking seventeen.
        setKeep(new Set(idsOf(outcome.value)));
        setPhase("results");
      },
      (thrown: unknown) => {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        setPhase("form");
      },
    );
  }, [props.search, source, query, condition, status, dates]);

  const write = useCallback(() => {
    if (results === null) return;
    const stamp = props.today();
    void props.writer
      .briefing({
        source: results.source,
        query: results.query,
        url: results.url,
        fetchedAt: stamp.minute,
        date: stamp.date,
        total: results.total,
        papers: results.papers.filter((paper) => keep.has(paper.pmid)),
        trials: results.trials.filter((trial) => keep.has(trial.nctId)),
      })
      .then(
        (file) => {
          new Notice(`SCDB: wrote ${file.basename}.`, 6000);
          props.onWritten(file);
          props.close();
        },
        (thrown: unknown) => {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        },
      );
  }, [props, results, keep]);

  if (available.length === 0) {
    return (
      <div class="scdb-modal__body">
        <h3>No external source is switched on</h3>
        <p class="scdb-modal__lede">
          This is the only part of the plugin that reaches a network, and it is off until you turn
          a source on in settings. Nothing has been sent.
        </p>
        <p class="scdb-muted">{MISSING_SOURCE}</p>
        <div class="scdb-modal__actions">
          <button class="scdb-control" onClick={props.close}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div class="scdb-modal__body scdb-sources">
      <h3>Search an external source</h3>

      {phase === "form" && (
        <>
          <p class="scdb-modal__lede">
            Read-only, and nothing is written until you have seen what came back and chosen what to
            keep.
          </p>

          <label class="scdb-field">
            <span class="scdb-field__label">Source</span>
            <select
              value={source}
              onChange={(event) => setSource((event.currentTarget as HTMLSelectElement).value as SourceId)}
            >
              {available.map((id) => (
                <option key={id} value={id}>
                  {SOURCES[id].label}
                </option>
              ))}
            </select>
          </label>

          {source === "ctgov" && (
            <label class="scdb-field">
              <span class="scdb-field__label">Condition</span>
              <input
                type="text"
                value={condition}
                placeholder="heart failure"
                onInput={(event) => setCondition((event.currentTarget as HTMLInputElement).value)}
              />
              <small class="scdb-field__hint">
                Kept separate from the words below because it is what makes the results relevant —
                searching both as free text returns trials about other diseases entirely.
              </small>
            </label>
          )}

          <label class="scdb-field">
            <span class="scdb-field__label">{source === "ctgov" ? "Other words" : "Search"}</span>
            <input
              type="text"
              value={query}
              placeholder={source === "pubmed" ? "30-day readmission heart failure" : "readmission"}
              onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
            />
          </label>

          {source === "pubmed" && (
            <label class="scdb-check">
              <input
                type="checkbox"
                checked={recent}
                onChange={(event) => setRecent((event.currentTarget as HTMLInputElement).checked)}
              />
              <span>Published in the last year only</span>
            </label>
          )}

          {source === "ctgov" && (
            <label class="scdb-field">
              <span class="scdb-field__label">Status</span>
              <select
                value={status}
                onChange={(event) => setStatus((event.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">Any</option>
                {TRIAL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {humanStatus(value)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error !== "" && <p class="scdb-modal__error">{error}</p>}

          <div class="scdb-modal__actions">
            <button class="scdb-control" onClick={props.close}>Cancel</button>
            <button class="mod-cta" disabled={!ready} onClick={() => setPhase("confirm")}>
              Show me what would be sent
            </button>
          </div>
        </>
      )}

      {phase === "confirm" && (
        <ConfirmSend
          preview={preview}
          onBack={() => setPhase("form")}
          onSend={run}
        />
      )}

      {phase === "running" && <p class="scdb-modal__lede">Waiting for {SOURCES[source].label}…</p>}

      {phase === "results" && results !== null && (
        <ResultList
          results={results}
          keep={keep}
          setKeep={setKeep}
          error={error}
          onBack={() => setPhase("form")}
          onWrite={write}
        />
      )}
    </div>
  );
}

function ConfirmSend(props: {
  preview: ReturnType<SourceSearch["previewPubmed"]>;
  onBack: () => void;
  onSend: () => void;
}) {
  if ("why" in props.preview) {
    return (
      <>
        <p class="scdb-modal__error">{props.preview.why}</p>
        <div class="scdb-modal__actions">
          <button class="scdb-control" onClick={props.onBack}>Back</button>
        </div>
      </>
    );
  }

  const { preview } = props;
  return (
    <>
      <p class="scdb-modal__lede">
        Nothing has left this machine yet. This is the exact address that would be requested — read
        it, because a description of a request is the one thing you cannot check.
      </p>

      <pre class="scdb-code scdb-code--wrap">{preview.url}</pre>

      <dl class="scdb-deflist">
        <dt>Goes to</dt>
        <dd>
          {preview.host} — {preview.operator}
        </dd>
        <dt>Carries</dt>
        <dd>{preview.carries}. No note text, no vault content, no patient data.</dd>
        <dt>Comes back</dt>
        <dd>
          {preview.source === "pubmed"
            ? "Titles, journals, dates and identifiers — no abstracts."
            : "Trial titles, status, sponsor, enrolment and countries."}{" "}
          Shown to you before anything is written.
        </dd>
        <dt>Recorded</dt>
        <dd>
          A <code>source-fetch</code> row in the audit ledger, naming the host and this search —
          whether it succeeds or not.
        </dd>
      </dl>

      <div class="scdb-modal__actions">
        <button class="scdb-control" onClick={props.onBack}>Back</button>
        <button class="mod-cta" onClick={props.onSend}>
          Send this request
        </button>
      </div>
    </>
  );
}

function ResultList(props: {
  results: Results;
  keep: Set<string>;
  setKeep: (next: Set<string>) => void;
  error: string;
  onBack: () => void;
  onWrite: () => void;
}) {
  const { results, keep } = props;
  const toggle = (id: string): void => {
    const next = new Set(keep);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.setKeep(next);
  };

  const rows = idsOf(results);

  return (
    <>
      <p class="scdb-modal__lede">
        {SOURCES[results.source].label} reported {results.total.toLocaleString("en-GB")} matches and
        returned {rows.length}. Tick what is worth keeping.
      </p>

      {results.warnings.length > 0 && (
        <ul class="scdb-list scdb-list--problems">
          {results.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {results.translation !== "" && (
        <details class="scdb-details">
          <summary>How PubMed read your search</summary>
          <pre class="scdb-code scdb-code--wrap">{results.translation}</pre>
        </details>
      )}

      {rows.length === 0 && <p class="scdb-empty">Nothing came back. Nothing was written.</p>}

      <ul class="scdb-list scdb-sources__results">
        {results.papers.map((paper) => (
          <li key={paper.pmid}>
            <label class="scdb-check">
              <input
                type="checkbox"
                checked={keep.has(paper.pmid)}
                onChange={() => toggle(paper.pmid)}
              />
              <span>
                <strong>{paper.title}</strong>
                <small class="scdb-field__hint">
                  {[paper.fullJournal === "" ? paper.journal : paper.fullJournal, paper.pubdate]
                    .filter((part) => part !== "")
                    .join(" · ")}
                </small>
              </span>
            </label>
          </li>
        ))}
        {results.trials.map((trial) => (
          <li key={trial.nctId}>
            <label class="scdb-check">
              <input
                type="checkbox"
                checked={keep.has(trial.nctId)}
                onChange={() => toggle(trial.nctId)}
              />
              <span>
                <strong>{trial.title}</strong>
                <small class="scdb-field__hint">
                  {[humanStatus(trial.status), humanPhase(trial.phases), trial.sponsor]
                    .filter((part) => part !== "")
                    .join(" · ")}
                </small>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {props.error !== "" && <p class="scdb-modal__error">{props.error}</p>}

      <div class="scdb-modal__actions">
        <button class="scdb-control" onClick={props.onBack}>Search again</button>
        <button class="mod-cta" disabled={keep.size === 0} onClick={props.onWrite}>
          Write a briefing with {keep.size}
        </button>
      </div>
    </>
  );
}

function idsOf(results: Results): string[] {
  return [...results.papers.map((paper) => paper.pmid), ...results.trials.map((trial) => trial.nctId)];
}
