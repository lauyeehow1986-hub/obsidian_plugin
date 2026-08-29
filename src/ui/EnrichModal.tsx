import { Notice, type App, type TFile } from "obsidian";
import { useCallback, useState } from "preact/hooks";
import type { FieldProposal, PubmedRecord } from "../domain/sources/pubmed";
import type { SourceSearch } from "../services/sourceSearch";
import type { SourceWriter } from "../services/sourceWriter";
import { PreactModal } from "./PreactModal";

/**
 * Filling in a publication note from PubMed (§7 E1, "always on explicit
 * request, never automatically").
 *
 * The shape here is rule 5's, applied to a fetch rather than to a model:
 * **fetched data populates a form; it does not change a note.** Every field is
 * a tick box showing what the note says now and what PubMed says, and a field
 * where the two disagree is marked as a conflict and starts **unticked**.
 * Silently replacing a journal name somebody typed with one a service returned
 * is the failure this dialog exists to prevent.
 *
 * `authors`, `position` and `corresponding` are never offered. §5.4 stores
 * authors as wikilinks into the people folder, and your author position is a
 * fact no external record holds.
 */
export class EnrichModal extends PreactModal {
  constructor(
    app: App,
    private readonly input: {
      search: SourceSearch;
      writer: SourceWriter;
      file: TFile;
      frontmatter: Readonly<Record<string, unknown>>;
      /** PMID or DOI already on the note, if there is one. */
      seed: string;
      onDone: () => void;
    },
  ) {
    super(app);
  }

  protected body() {
    return (
      <EnrichForm
        {...this.input}
        close={() => {
          this.close();
        }}
      />
    );
  }
}

type Phase = "form" | "confirm" | "running" | "review";

function EnrichForm(props: {
  search: SourceSearch;
  writer: SourceWriter;
  file: TFile;
  frontmatter: Readonly<Record<string, unknown>>;
  seed: string;
  onDone: () => void;
  close: () => void;
}) {
  const [reference, setReference] = useState(props.seed);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [record, setRecord] = useState<PubmedRecord | null>(null);
  const [proposals, setProposals] = useState<FieldProposal[]>([]);
  const [accept, setAccept] = useState<Set<string>>(new Set());

  const preview = props.search.previewLookup(reference);

  const run = useCallback(() => {
    setPhase("running");
    setError("");
    void props.search.lookup(reference).then(
      (outcome) => {
        if (!outcome.ok) {
          setError(outcome.why);
          setPhase("form");
          return;
        }
        const found = props.search.propose(outcome.value, props.frontmatter);
        setRecord(outcome.value);
        setProposals(found);
        // A field that only fills a gap is ticked; one that would overwrite
        // something is not. The default should never be the destructive one.
        setAccept(new Set(found.filter((p) => !p.conflict).map((p) => p.field)));
        setPhase("review");
      },
      (thrown: unknown) => {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        setPhase("form");
      },
    );
  }, [props, reference]);

  const apply = useCallback(() => {
    if (record === null) return;
    const chosen = proposals.filter((proposal) => accept.has(proposal.field));
    void props.writer
      .enrich(props.file, chosen, { pmid: record.pmid, from: "PubMed" })
      .then(
        () => {
          new Notice(
            chosen.length === 0
              ? "SCDB: nothing was changed."
              : `SCDB: updated ${chosen.length} field${chosen.length === 1 ? "" : "s"} on ${props.file.basename}.`,
            6000,
          );
          props.onDone();
          props.close();
        },
        (thrown: unknown) => {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        },
      );
  }, [props, record, proposals, accept]);

  const toggle = (field: string): void => {
    const next = new Set(accept);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    setAccept(next);
  };

  return (
    <div class="scdb-modal__body scdb-sources">
      <h3>Fill in from PubMed</h3>

      {phase === "form" && (
        <>
          <p class="scdb-modal__lede">
            Looks up <strong>{props.file.basename}</strong> by its PubMed identifier or DOI. Only
            that identifier is sent — nothing else from the note.
          </p>

          <label class="scdb-field">
            <span class="scdb-field__label">PMID or DOI</span>
            <input
              type="text"
              value={reference}
              placeholder="29562234 or 10.1038/nature26140"
              onInput={(event) => setReference((event.currentTarget as HTMLInputElement).value)}
            />
            <small class="scdb-field__hint">
              A DOI is looked up through PubMed rather than a third service, which keeps the
              allowlist at two hosts. A DOI PubMed has never indexed will not be found — that is a
              limit of where we looked, not evidence the DOI is wrong.
            </small>
          </label>

          {error !== "" && <p class="scdb-modal__error">{error}</p>}

          <div class="scdb-modal__actions">
            <button class="scdb-control" onClick={props.close}>Cancel</button>
            <button
              class="mod-cta"
              disabled={reference.trim() === ""}
              onClick={() => setPhase("confirm")}
            >
              Show me what would be sent
            </button>
          </div>
        </>
      )}

      {phase === "confirm" &&
        ("why" in preview ? (
          <>
            <p class="scdb-modal__error">{preview.why}</p>
            <div class="scdb-modal__actions">
              <button class="scdb-control" onClick={() => setPhase("form")}>Back</button>
            </div>
          </>
        ) : (
          <>
            <p class="scdb-modal__lede">
              Nothing has left this machine yet. This is the exact address that would be requested.
            </p>
            <pre class="scdb-code scdb-code--wrap">{preview.url}</pre>
            <dl class="scdb-deflist">
              <dt>Goes to</dt>
              <dd>
                {preview.host} — {preview.operator}
              </dd>
              <dt>Carries</dt>
              <dd>{preview.carries}.</dd>
            </dl>
            <div class="scdb-modal__actions">
              <button class="scdb-control" onClick={() => setPhase("form")}>Back</button>
              <button class="mod-cta" onClick={run}>
                Send this request
              </button>
            </div>
          </>
        ))}

      {phase === "running" && <p class="scdb-modal__lede">Waiting for PubMed…</p>}

      {phase === "review" && record !== null && (
        <>
          <p class="scdb-modal__lede">
            PubMed returned PMID {record.pmid}. Nothing has been written. Tick what should go into
            the note.
          </p>

          {proposals.length === 0 ? (
            <p class="scdb-empty">
              The note already says everything PubMed does. Nothing to change.
            </p>
          ) : (
            <table class="scdb-table scdb-sources__fields">
              <thead>
                <tr>
                  <th />
                  <th>Field</th>
                  <th>The note says</th>
                  <th>PubMed says</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((proposal) => (
                  <tr key={proposal.field} class={proposal.conflict ? "scdb-row--conflict" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        checked={accept.has(proposal.field)}
                        onChange={() => toggle(proposal.field)}
                      />
                    </td>
                    <td>
                      {proposal.field}
                      {proposal.conflict && (
                        <span class="scdb-badge scdb-badge--warn" title="These disagree">
                          ! differs
                        </span>
                      )}
                    </td>
                    <td>{proposal.current === "" ? "—" : proposal.current}</td>
                    <td>{proposal.proposed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p class="scdb-muted">
            Authors are not offered: the note stores them as links to people notes, and PubMed
            returns eighteen surnames. Your author position is not offered either — no external
            record holds it.
          </p>

          {error !== "" && <p class="scdb-modal__error">{error}</p>}

          <div class="scdb-modal__actions">
            <button class="scdb-control" onClick={props.close}>Cancel</button>
            <button class="mod-cta" disabled={accept.size === 0} onClick={apply}>
              Write {accept.size} field{accept.size === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
