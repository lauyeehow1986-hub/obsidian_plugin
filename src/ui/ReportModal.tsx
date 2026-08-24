import type { App } from "obsidian";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ReportTemplate } from "../domain/report/template";
import type { ReportChoice } from "../services/reportBuilder";
import { PreactModal } from "./PreactModal";

/**
 * Choosing what to generate (CLAUDE.md §7 B7).
 *
 * A report is a file that leaves the vault and goes in front of somebody, so
 * the dialog does one thing beyond collecting four fields: it says, before you
 * press the button, **how many rows the report is about**. A monthly statement
 * that turns out to cover nothing because the study name was spelled
 * differently in the effort log is the failure this prevents, and it is not a
 * hypothetical — a study is a wikilink somebody typed.
 *
 * The count is computed by building the report for real and counting it, not
 * by a second estimate. An estimate that disagreed with the file would be
 * worse than no estimate at all.
 */

export interface ReportModalOptions {
  templates: readonly ReportTemplate[];
  /** Every study anything is recorded against, for the picker. */
  studies: readonly string[];
  /** `2026-08` — the month the dialog opens on. */
  defaultMonth: string;
  /** `2026`. */
  defaultYear: string;
  /** One line describing what the current choice would produce. */
  preview: (choice: ReportChoice) => Promise<string>;
  onSubmit: (choice: ReportChoice) => Promise<void>;
}

interface PanelProps extends ReportModalOptions {
  onClose: () => void;
}

function Panel({
  templates,
  studies,
  defaultMonth,
  defaultYear,
  preview,
  onSubmit,
  onClose,
}: PanelProps) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [month, setMonth] = useState(defaultMonth);
  const [year, setYear] = useState(defaultYear);
  const [study, setStudy] = useState(studies[0] ?? "");
  const [format, setFormat] = useState<"md" | "html">("md");
  const [summary, setSummary] = useState("Working out what this would contain…");

  const template = useMemo(
    () => templates.find((entry) => entry.id === templateId) ?? templates[0] ?? null,
    [templates, templateId],
  );

  const choice: ReportChoice = {
    templateId,
    period: template === null ? "" : template.period === "month" ? month : template.period === "year" ? year : "",
    study: template?.study === true ? study : "",
    format,
  };

  // Rebuilt on every change. It is the same work generating the report does,
  // and on a vault this size it is milliseconds; if that ever stops being true
  // the honest fix is to say so in the dialog, not to guess the number.
  const key = `${choice.templateId}|${choice.period}|${choice.study}|${choice.format}`;
  useEffect(() => {
    let live = true;
    setSummary("Working out what this would contain…");
    void preview(choice)
      .then((text) => {
        if (live) setSummary(text);
      })
      .catch((error: unknown) => {
        if (live) setSummary(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
    // `key` stands in for the whole choice: the effect depends on its
    // contents, not on the object identity a new render produces every time.
  }, [key]);

  if (template === null) {
    return (
      <div class="scdb-report">
        <p class="scdb-empty">
          No report template could be read. Check `_config/reports/` — or delete the files there
          to fall back to the built-in templates.
        </p>
        <div class="scdb-modal__actions">
          <button type="button" class="scdb-control" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="scdb-report">
      <label class="scdb-field">
        <span class="scdb-field__label">Report</span>
        <select
          value={templateId}
          onChange={(event) => setTemplateId((event.target as HTMLSelectElement).value)}
        >
          {templates.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
              {entry.path === "" ? "" : " (from _config)"}
            </option>
          ))}
        </select>
        {template.description === "" ? null : (
          <span class="scdb-field__hint">{template.description}</span>
        )}
      </label>

      <div class="scdb-field-row">
        {template.period === "month" ? (
          <label class="scdb-field">
            <span class="scdb-field__label">Month</span>
            <input
              type="month"
              value={month}
              onInput={(event) => setMonth((event.target as HTMLInputElement).value)}
            />
          </label>
        ) : null}

        {template.period === "year" ? (
          <label class="scdb-field">
            <span class="scdb-field__label">Year</span>
            <input
              type="number"
              min={1900}
              max={2999}
              step={1}
              value={year}
              onInput={(event) => setYear((event.target as HTMLInputElement).value)}
            />
          </label>
        ) : null}

        {template.study ? (
          <label class="scdb-field">
            <span class="scdb-field__label">Study</span>
            {studies.length === 0 ? (
              <input
                type="text"
                value={study}
                placeholder="No study is recorded against anything yet"
                onInput={(event) => setStudy((event.target as HTMLInputElement).value)}
              />
            ) : (
              <select
                value={study}
                onChange={(event) => setStudy((event.target as HTMLSelectElement).value)}
              >
                {studies.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            )}
            <span class="scdb-field__hint">
              Taken from the effort log, the queue and the publications — a study nothing is
              recorded against would produce an empty statement.
            </span>
          </label>
        ) : null}
      </div>

      <fieldset class="scdb-field">
        <span class="scdb-field__label">Write it as</span>
        <label class="scdb-field--inline scdb-field">
          <input
            type="radio"
            name="scdb-report-format"
            checked={format === "md"}
            onChange={() => setFormat("md")}
          />
          <span>
            A markdown note — tables you can edit and charts as embedded SVG. Stays in the vault
            and stays queryable.
          </span>
        </label>
        <label class="scdb-field--inline scdb-field">
          <input
            type="radio"
            name="scdb-report-format"
            checked={format === "html"}
            onChange={() => setFormat("html")}
          />
          <span>
            A self-contained HTML page — one file, no network, opens on a machine with no
            Obsidian. Print it, or export it to PDF from the browser.
          </span>
        </label>
      </fieldset>

      <p class="scdb-note">{summary}</p>

      <div class="scdb-modal__actions">
        <button type="button" class="scdb-control" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="mod-cta"
          onClick={() => {
            onClose();
            void onSubmit(choice);
          }}
        >
          Generate
        </button>
      </div>
    </div>
  );
}

export class ReportModal extends PreactModal {
  constructor(
    app: App,
    private readonly options: ReportModalOptions,
  ) {
    super(app);
    this.titleEl.setText("Generate a report");
  }

  override onOpen(): void {
    super.onOpen();
    this.modalEl.addClass("scdb-modal--wide");
  }

  protected body() {
    return <Panel {...this.options} onClose={() => this.close()} />;
  }
}
