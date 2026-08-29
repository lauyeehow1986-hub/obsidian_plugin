import type { App } from "obsidian";
import { useMemo, useState } from "preact/hooks";
import { planRun, type RunDraft } from "../domain/script/recordRun";
import { RUN_EXITS, RUN_EXIT_LABELS, type RunExit } from "../domain/script/runRecord";
import {
  SCRIPT_LANGUAGES,
  languageLabel,
  scriptLabel,
  shortHash,
  type ScriptDoc,
} from "../domain/script/scriptDoc";
import { toVaultMinute } from "../domain/time/dates";
import { PreactModal } from "./PreactModal";
import type { NewScript } from "../services/scriptWriter";

/**
 * The two dialogs the script register needs (§5.12, §5.14, §7 C3): document a
 * script, and record that one was run.
 *
 * Both are presentational. The run dialog renders `planRun`'s refusals and
 * weaknesses rather than deciding anything itself, so the rule about what may
 * be recorded lives in one place and is unit-tested there.
 */

/**
 * A kind for an output path, from its extension.
 *
 * Inferred rather than asked for: `kind` on a §5.12 output is a label, and
 * making somebody type "table" beside every CSV is how a dialog stops being
 * used. Anything unrecognised is left blank rather than guessed at.
 */
function inferKind(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? "";
  if (["csv", "tsv", "xlsx", "rds", "parquet", "dta", "sav"].includes(extension)) return "table";
  if (["png", "svg", "jpg", "jpeg", "pdf"].includes(extension)) return "plot";
  if (["html", "docx", "md"].includes(extension)) return "report";
  return "";
}

/* --------------------------------------------------------------- new doc -- */

function NewScriptPanel({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: NewScript) => Promise<void>;
  onCancel: () => void;
}) {
  const [id, setId] = useState("SCRIPT-");
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [language, setLanguage] = useState("r");
  const [file, setFile] = useState("");
  const [study, setStudy] = useState("");
  const [datasets, setDatasets] = useState("");
  const [variables, setVariables] = useState("");

  const ready = id.trim().length > 7 && purpose.trim() !== "" && file.trim() !== "";

  const inputs = useMemo(
    () =>
      datasets
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          // "SCDB-echo | 2026-Q2 | 2026-06-30" — a pipe, because a dataset name
          // may well contain a comma and none of them contain a pipe.
          const [dataset = "", version = "", changed = ""] = line.split("|").map((part) => part.trim());
          return { dataset, version, changed };
        }),
    [datasets],
  );

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        The register flags a script when an input dataset or a catalogue definition moves after
        the last recorded run. Both halves of that need a date, so list the inputs with theirs —
        a dataset with no date can never raise a flag.
      </p>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">ID</span>
          <input
            type="text"
            value={id}
            onInput={(event) => setId((event.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">What a run record points at.</span>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Language</span>
          <select
            value={language}
            onChange={(event) => setLanguage((event.target as HTMLSelectElement).value)}
          >
            {SCRIPT_LANGUAGES.map((entry) => (
              <option key={entry} value={entry}>
                {languageLabel(entry)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Title</span>
        <input
          type="text"
          placeholder="30-day readmission cohort build"
          value={title}
          onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Purpose</span>
        <textarea
          rows={2}
          placeholder="Builds the analysis cohort from the echo and admissions extracts."
          value={purpose}
          onInput={(event) => setPurpose((event.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">
          The field that ages worst. Write it for whoever inherits this.
        </span>
      </label>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">File</span>
          <input
            type="text"
            placeholder="50 Scripts/cohort-build.R"
            value={file}
            onInput={(event) => setFile((event.target as HTMLInputElement).value)}
          />
          <span class="scdb-field__hint">
            Inside the vault, its hash can be checked from here. Outside, it cannot.
          </span>
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Study</span>
          <input
            type="text"
            placeholder="[[EuroHeart]]"
            value={study}
            onInput={(event) => setStudy((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Inputs</span>
        <textarea
          rows={3}
          placeholder={"SCDB-echo | 2026-Q2 | 2026-06-30\nSCDB-admissions | 2026-Q1 | 2026-04-02"}
          value={datasets}
          onInput={(event) => setDatasets((event.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">
          One per line: dataset | version | the date that version came into being.
        </span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Variables consumed</span>
        <textarea
          rows={2}
          placeholder={"[[VAR-LVEF]]\n[[VAR-NYHA]]"}
          value={variables}
          onInput={(event) => setVariables((event.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">
          One per line. This is the join to the catalogue, in both directions.
        </span>
      </label>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={!ready}
          onClick={() =>
            void onSubmit({
              id: id.trim(),
              title: title.trim(),
              purpose: purpose.trim(),
              language,
              file: file.trim(),
              study: study.trim(),
              inputs,
              variables: variables
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== ""),
            })
          }
        >
          Create
        </button>
      </div>
    </div>
  );
}

export class NewScriptModal extends PreactModal {
  constructor(
    app: App,
    private readonly onSubmit: (input: NewScript) => Promise<void>,
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText("New script documentation");
    return (
      <NewScriptPanel
        onSubmit={async (input) => {
          this.close();
          await this.onSubmit(input);
        }}
        onCancel={() => this.close()}
      />
    );
  }
}

/* ------------------------------------------------------------ record run -- */

function RecordRunPanel({
  doc,
  actor,
  now,
  onSubmit,
  onCancel,
}: {
  doc: ScriptDoc;
  actor: string;
  now: number;
  onSubmit: (draft: RunDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [started, setStarted] = useState(toVaultMinute(now));
  const [durationS, setDurationS] = useState("");
  const [exit, setExit] = useState<RunExit>("ok");
  const [interpreter, setInterpreter] = useState("");
  const [scriptHash, setScriptHash] = useState("");
  const [request, setRequest] = useState(doc.requests[0] ?? "");
  const [versions, setVersions] = useState<Record<string, string>>(
    Object.fromEntries(doc.inputs.map((input) => [input.dataset, input.version])),
  );
  const [outputs, setOutputs] = useState("");

  const draft = useMemo<RunDraft>(() => {
    const parsedStart = started.trim() === "" ? null : Date.parse(started);
    const parsedDuration = durationS.trim() === "" ? null : Number(durationS);
    return {
      started: parsedStart === null || Number.isNaN(parsedStart) ? null : parsedStart,
      durationS: parsedDuration !== null && Number.isFinite(parsedDuration) ? parsedDuration : null,
      exit,
      interpreter,
      scriptHash,
      inputs: doc.inputs.map((input) => ({
        dataset: input.dataset,
        version: versions[input.dataset] ?? "",
        rows: null,
      })),
      outputs: outputs
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((path) => ({ kind: inferKind(path), path })),
      request,
    };
  }, [started, durationS, exit, interpreter, scriptHash, versions, outputs, request, doc]);

  const plan = useMemo(
    () => planRun({ doc, draft, actor, sequence: 1 }),
    [doc, draft, actor],
  );

  return (
    <div class="scdb-modal__body">
      <p class="scdb-modal__lede">
        This writes a provenance record for a run that has already happened. The plugin did not
        run anything and the record says so — it is logged as <code>run-recorded</code>, never as
        code the plugin executed.
      </p>

      <div class="scdb-field-row">
        <label class="scdb-field">
          <span class="scdb-field__label">Started</span>
          <input
            type="datetime-local"
            value={started}
            onInput={(event) => setStarted((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Duration (s)</span>
          <input
            type="number"
            min="0"
            value={durationS}
            onInput={(event) => setDurationS((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="scdb-field">
          <span class="scdb-field__label">Outcome</span>
          <select
            value={exit}
            onChange={(event) => setExit((event.target as HTMLSelectElement).value as RunExit)}
          >
            {RUN_EXITS.map((entry) => (
              <option key={entry} value={entry}>
                {RUN_EXIT_LABELS[entry]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label class="scdb-field">
        <span class="scdb-field__label">Interpreter</span>
        <input
          type="text"
          placeholder="R 4.4.1 (portable, D:\R-portable\bin\Rscript.exe)"
          value={interpreter}
          onInput={(event) => setInterpreter((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Verbatim, version included. Six months from now this is what makes the numbers
          reproducible.
        </span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Script hash</span>
        <input
          type="text"
          placeholder={
            doc.fileHash === ""
              ? "sha256 of the file that ran"
              : `defaults to the documented ${shortHash(doc.fileHash)}…`
          }
          value={scriptHash}
          onInput={(event) => setScriptHash((event.target as HTMLInputElement).value)}
        />
        <span class="scdb-field__hint">
          Leave blank to use the hash on the note. Fill it in when what ran was not what the note
          documents.
        </span>
      </label>

      {doc.inputs.length > 0 && (
        <>
          <h3 class="scdb-modal__heading">Data versions this run saw</h3>
          <div class="scdb-field-row">
            {doc.inputs.map((input) => (
              <label key={input.dataset} class="scdb-field">
                <span class="scdb-field__label">{input.dataset}</span>
                <input
                  type="text"
                  value={versions[input.dataset] ?? ""}
                  onInput={(event) =>
                    setVersions({
                      ...versions,
                      [input.dataset]: (event.target as HTMLInputElement).value,
                    })
                  }
                />
              </label>
            ))}
          </div>
        </>
      )}

      <label class="scdb-field">
        <span class="scdb-field__label">Outputs</span>
        <textarea
          rows={3}
          placeholder={"94 Runs/RUN-table1.csv\n94 Runs/RUN-fig1.png"}
          value={outputs}
          onInput={(event) => setOutputs((event.target as HTMLTextAreaElement).value)}
        />
        <span class="scdb-field__hint">One path per line. The kind is read from the extension.</span>
      </label>

      <label class="scdb-field">
        <span class="scdb-field__label">Request this answers</span>
        <input
          type="text"
          placeholder="[[REQ-2026-014]]"
          value={request}
          onInput={(event) => setRequest((event.target as HTMLInputElement).value)}
        />
      </label>

      {plan.refusals.length > 0 && (
        <ul class="scdb-list scdb-list--problems">
          {plan.refusals.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {plan.refusals.length === 0 && plan.weaknesses.length > 0 && (
        <>
          <h3 class="scdb-modal__heading">What this record will not be able to say</h3>
          <ul class="scdb-list scdb-list--problems">
            {plan.weaknesses.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      )}

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          disabled={plan.refusals.length > 0}
          onClick={() => void onSubmit(draft)}
        >
          Record the run
        </button>
      </div>
    </div>
  );
}

export class RecordRunModal extends PreactModal {
  constructor(
    app: App,
    private readonly doc: ScriptDoc,
    private readonly actor: string,
    private readonly onSubmit: (draft: RunDraft) => Promise<void>,
    private readonly now = Date.now(),
  ) {
    super(app);
  }

  protected body() {
    this.titleEl.setText(`Record a run — ${scriptLabel(this.doc)}`);
    return (
      <RecordRunPanel
        doc={this.doc}
        actor={this.actor}
        now={this.now}
        onSubmit={async (draft) => {
          this.close();
          await this.onSubmit(draft);
        }}
        onCancel={() => this.close()}
      />
    );
  }
}
