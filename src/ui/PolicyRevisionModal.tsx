import type { App } from "obsidian";
import { useEffect, useMemo, useState } from "preact/hooks";
import { changedSections } from "../domain/policy/diff";
import { buildImpactMap, type ImpactMap, type RefResolver } from "../domain/policy/impact";
import { presentVerdict } from "../domain/report/present";
import { policyLabel, type PolicyEdge, type PolicyNote } from "../domain/policy/policy";
import { planRevision } from "../domain/policy/revision";
import { toVaultDate } from "../domain/time/dates";
import { PreactModal } from "./PreactModal";

export interface RevisionSubmission {
  incomingText: string;
  newVersion: string;
  summary: string;
  effective: string;
}

export interface RevisionModalOptions {
  policy: PolicyNote;
  /** The policy note as it stands, frontmatter and all. */
  currentText: string;
  policiesFolder: string;
  /** Markdown paths the incoming document could be read from. */
  sources: string[];
  readSource: (path: string) => Promise<string>;
  incoming: readonly PolicyEdge[];
  resolve: RefResolver;
  onSubmit: (submission: RevisionSubmission) => Promise<void>;
  now?: number;
}

function ImpactRows({ map }: { map: ImpactMap }) {
  if (map.rows.length === 0) {
    return <p class="scdb-empty">{map.headline}</p>;
  }
  return (
    <>
      <p class="scdb-modal__lede">{map.headline}</p>
      <table class="scdb-table">
        <thead>
          <tr>
            <th scope="col">Depends on</th>
            <th scope="col">Clause</th>
            <th scope="col">Verdict</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {map.rows.map((row) => (
            <tr key={`${row.edge.kind}${row.edge.ref}${row.edge.clause}`}>
              <td>
                {row.edge.label}
                {row.resolved === false && (
                  <span class="scdb-chip scdb-chip--problem" title="No note of that name">
                    not found
                  </span>
                )}
              </td>
              <td class="scdb-num">{row.edge.clause || "—"}</td>
              <td>
                <span class={`scdb-state ${presentVerdict(row.verdict).className}`}>
                  <span aria-hidden="true">{presentVerdict(row.verdict).glyph}</span>{" "}
                  {presentVerdict(row.verdict).label}
                </span>
              </td>
              <td class="scdb-muted">{row.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function RevisionPanel({
  options,
  onCancel,
}: {
  options: RevisionModalOptions;
  onCancel: () => void;
}) {
  const now = options.now ?? Date.now();
  const [mode, setMode] = useState<"note" | "paste">("note");
  const [sourcePath, setSourcePath] = useState("");
  const [pasted, setPasted] = useState("");
  const [loaded, setLoaded] = useState("");
  const [loadError, setLoadError] = useState("");
  const [newVersion, setNewVersion] = useState("");
  const [summary, setSummary] = useState("");
  const [effective, setEffective] = useState(toVaultDate(now));

  useEffect(() => {
    if (mode !== "note" || sourcePath.trim() === "") {
      setLoaded("");
      setLoadError("");
      return;
    }
    let live = true;
    setLoadError("");
    void options
      .readSource(sourcePath.trim())
      .then((text) => {
        if (live) setLoaded(text);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoaded("");
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [mode, sourcePath, options]);

  const incomingText = mode === "note" ? loaded : pasted;
  const haveText = incomingText.trim() !== "";

  const plan = useMemo(
    () =>
      haveText
        ? planRevision({
            policy: options.policy,
            currentText: options.currentText,
            incomingText,
            newVersion,
            policiesFolder: options.policiesFolder,
            at: now,
          })
        : null,
    [haveText, incomingText, newVersion, options, now],
  );

  const map = useMemo(
    () =>
      plan === null
        ? null
        : buildImpactMap({
            policy: options.policy,
            diff: plan.diff,
            incoming: options.incoming,
            resolve: options.resolve,
          }),
    [plan, options],
  );

  const changed = plan === null ? [] : changedSections(plan.diff);
  const summaryGiven = summary.trim() !== "";
  const canSubmit = plan !== null && plan.refusals.length === 0 && summaryGiven;

  return (
    <div class="scdb-modal__body scdb-policy">
      <p class="scdb-modal__lede">
        {policyLabel(options.policy)} is at version{" "}
        <strong>{options.policy.version || "(none)"}</strong>. The current text is frozen into{" "}
        <code>_revisions/</code> before anything is replaced.
      </p>

      <div class="scdb-segmented" role="group" aria-label="Where the new document is">
        <button
          type="button"
          class={`scdb-control${mode === "note" ? " is-active" : ""}`}
          onClick={() => setMode("note")}
        >
          From a note
        </button>
        <button
          type="button"
          class={`scdb-control${mode === "paste" ? " is-active" : ""}`}
          onClick={() => setMode("paste")}
        >
          Paste the text
        </button>
      </div>

      {mode === "note" ? (
        <label class="scdb-field">
          <span class="scdb-field__label">The new document</span>
          <input
            type="text"
            list="scdb-policy-sources"
            placeholder="40 Policies/_incoming/POL-DATA-REL-02 v5.md"
            value={sourcePath}
            onInput={(event) => setSourcePath((event.target as HTMLInputElement).value)}
          />
          <datalist id="scdb-policy-sources">
            {options.sources.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
          <span class="scdb-field__hint">
            Drop the new version anywhere in the vault and name it here. Its own frontmatter, if
            it has any, is discarded — the live note keeps its own.
          </span>
          {loadError !== "" && (
            <span class="scdb-field__hint scdb-field__hint--bad">{loadError}</span>
          )}
        </label>
      ) : (
        <label class="scdb-field">
          <span class="scdb-field__label">The new document</span>
          <textarea
            rows={8}
            placeholder="## 5.2 Onward transfer&#10;&#10;…"
            value={pasted}
            onInput={(event) => setPasted((event.target as HTMLTextAreaElement).value)}
          />
          <span class="scdb-field__hint">
            Headings carry the clause numbers. A document with no numbered headings can still be
            revised, but nothing that cites a clause will be flagged.
          </span>
        </label>
      )}

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">New version</span>
          <input
            type="text"
            placeholder="5"
            value={newVersion}
            onInput={(event) => setNewVersion((event.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">As printed on the document, not a number we invent.</span>
        </label>

        <label class="scdb-field">
          <span class="scdb-field__label">Effective from</span>
          <input
            type="date"
            value={effective}
            onInput={(event) => setEffective((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">What changed</span>
        <input
          type="text"
          placeholder="Countersignature by the data custodian added at 5.2."
          value={summary}
          onInput={(event) => setSummary((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Required. It goes on the frozen copy and into the revision record — a row saying only
          “changed” is one nobody can act on later.
        </span>
      </label>

      {plan !== null && plan.refusals.length > 0 && (
        <div class="scdb-gatereport">
          <ul class="scdb-gatereport__list">
            {plan.refusals.map((refusal) => (
              <li key={refusal} class="scdb-gatereport__item scdb-gatereport__item--hard">
                <span class="scdb-gatereport__badge">Blocked</span>
                <span>{refusal}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan?.warnings.map((warning) => (
        <p key={warning} class="scdb-gatereport__warning">
          {warning}
        </p>
      ))}

      {plan !== null && plan.refusals.length === 0 && (
        <>
          <h3 class="scdb-modal__heading">Sections that changed</h3>
          {changed.length === 0 ? (
            <p class="scdb-empty">Nothing but whitespace.</p>
          ) : (
            <table class="scdb-table">
              <thead>
                <tr>
                  <th scope="col">Section</th>
                  <th scope="col">Change</th>
                  <th scope="col" class="scdb-num">
                    +
                  </th>
                  <th scope="col" class="scdb-num">
                    −
                  </th>
                </tr>
              </thead>
              <tbody>
                {changed.map((section) => (
                  <tr key={section.key}>
                    <td>{section.label}</td>
                    <td>{section.kind}</td>
                    <td class="scdb-num">{section.addedLines}</td>
                    <td class="scdb-num">{section.removedLines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 class="scdb-modal__heading">What rests on it</h3>
          {map !== null && <ImpactRows map={map} />}
          {map !== null && map.unclaimedClauses.length > 0 && (
            <p class="scdb-gatereport__warning">
              {map.unclaimedClauses.join(", ")} changed, and nothing in the vault says it rests
              on {map.unclaimedClauses.length === 1 ? "it" : "them"}. More often an undeclared
              dependency than a free clause.
            </p>
          )}
        </>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!canSubmit}
          title={
            summaryGiven ? undefined : "Say in one line what changed before recording the revision."
          }
          onClick={() =>
            void options.onSubmit({
              incomingText,
              newVersion: newVersion.trim(),
              summary: summary.trim(),
              effective,
            })
          }
        >
          Freeze and replace
        </button>
      </div>
    </div>
  );
}

export class PolicyRevisionModal extends PreactModal {
  constructor(
    app: App,
    private readonly options: RevisionModalOptions,
  ) {
    super(app);
    // The dialog carries a diff summary and an impact table side by side, so
    // it uses the same wide-modal class as the report and diagnostics dialogs
    // rather than sizing itself — one rule decides how wide "wide" is.
    this.modalEl.addClass("scdb-modal--wide");
    this.titleEl.setText(`Revise ${options.policy.id || policyLabel(options.policy)}`);
  }

  protected body() {
    return (
      <RevisionPanel
        options={{
          ...this.options,
          onSubmit: async (submission) => {
            this.close();
            await this.options.onSubmit(submission);
          },
        }}
        onCancel={() => this.close()}
      />
    );
  }
}
