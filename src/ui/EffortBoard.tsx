/**
 * The effort table and its roll-ups (CLAUDE.md §7 B2).
 *
 * Two things on one board, because they answer each other. The table is where
 * a forgotten timer gets fixed; the roll-ups are why fixing it matters. Putting
 * them on separate screens would make the correction feel like bookkeeping
 * rather than like the thing that makes next month's number defensible.
 */

import { useEffect, useState } from "preact/hooks";
import {
  DIMENSION_LABELS,
  EFFORT_DIMENSIONS,
  formatMinutes,
  rollUp,
  rollUpCsv,
  totalMins,
  type EffortDimension,
} from "../domain/effort/aggregate";
import { StaleEffortEdit, type EffortEdit } from "../domain/effort/edit";
import { formatClock, parseClock, type TimeEntry } from "../domain/effort/entry";
import { toVaultMonth } from "../domain/time/dates";
import type ScdbCockpitPlugin from "../main.js";
import type { EffortMonth } from "../services/effortLog";
import { confirm } from "./ConfirmModal";
import { askEntry, askSplitTime } from "./TimerModals";

function monthLabel(month: string): string {
  const [year, index] = month.split("-");
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const name = names[Number(index) - 1];
  return name === undefined ? month : `${name} ${year}`;
}

export function EffortBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const thisMonth = toVaultMonth(Date.now());
  const known = plugin.effort.months();
  const months = known.includes(thisMonth) ? known : [...known, thisMonth].sort();

  const [month, setMonth] = useState(thisMonth);
  const [dimension, setDimension] = useState<EffortDimension>("activity");
  const [data, setData] = useState<EffortMonth | null>(null);
  const [reload, setReload] = useState(0);

  // `effortVersion` is what makes a write by the timer show up here: the month
  // files are read whole, not indexed, so a re-render on its own has nothing to
  // re-read from.
  const version = plugin.effortVersion;
  useEffect(() => {
    let live = true;
    void plugin.effort.read(month).then((loaded) => {
      if (live) setData(loaded);
    });
    return () => {
      live = false;
    };
  }, [month, reload, version, plugin]);

  const refresh = () => setReload((n) => n + 1);

  /** Apply one edit, reporting a file that moved rather than fighting it. */
  const apply = async (edit: EffortEdit): Promise<void> => {
    try {
      await plugin.effort.edit(month, [edit]);
    } catch (error) {
      const message =
        error instanceof StaleEffortEdit
          ? error.message
          : `That change was not made: ${error instanceof Error ? error.message : String(error)}`;
      plugin.notify(message, 9000);
    }
    refresh();
  };

  const vocab = plugin.effort.vocabularies();

  const editRow = async (row: { entry: TimeEntry; line: number; text: string }): Promise<void> => {
    const outcome = await askEntry(plugin.app, row.entry, {
      title: "Edit time entry",
      lede: "Changing a recorded entry is logged to the audit ledger, in counts only.",
      submitLabel: "Save",
      discardLabel: "Delete this entry",
      activities: vocab.activities,
      costCentres: vocab.costCentres,
    });
    if (outcome.kind === "cancel") return;
    if (outcome.kind === "discard") {
      // An entry added by hand carries no clock times, and "2026-08-23 –, 45m"
      // reads as a rendering fault in the one dialog that has to be clear.
      const when =
        row.entry.start === "" && row.entry.end === ""
          ? row.entry.date
          : `${row.entry.date} ${row.entry.start}–${row.entry.end}`;
      const ok = await confirm(
        plugin.app,
        `Delete this entry?\n\n• ${when}, ${formatMinutes(row.entry.mins)}, ${row.entry.activity}\n\nThis is logged to the audit ledger.`,
        "Delete",
      );
      if (!ok) return;
      await apply({ kind: "remove", line: row.line, was: row.text });
      return;
    }
    await apply({ kind: "replace", line: row.line, was: row.text, entry: outcome.entry });
  };

  const splitRow = async (row: {
    entry: TimeEntry;
    line: number;
    text: string;
  }): Promise<void> => {
    const start = parseClock(row.entry.start);
    const end = parseClock(row.entry.end);
    if (start === null || end === null) {
      plugin.notify("That entry has no clock times, so there is nothing to split it at.", 6000);
      return;
    }
    // Offered at the midpoint: a starting value, editable, never applied
    // without the user pressing Save on the halves it produces.
    const midpoint = formatClock(start + Math.round(((end >= start ? end : end + 1440) - start) / 2));
    const at = await askSplitTime(
      plugin.app,
      `${row.entry.start}–${row.entry.end}. The ${formatMinutes(row.entry.mins)} recorded is shared between the two halves in proportion, so the total does not change.`,
      midpoint,
    );
    if (at === null) return;
    await apply({ kind: "split", line: row.line, was: row.text, at });
  };

  const entries = data?.entries ?? [];
  const buckets = rollUp(entries, dimension);
  const total = totalMins(entries);

  return (
    <div class="scdb-stack scdb-effort">
      <div class="scdb-toolbar">
        <label class="scdb-field scdb-field--inline">
          <span class="scdb-field__label">Month</span>
          <select
            class="dropdown"
            value={month}
            onChange={(event) => setMonth((event.target as HTMLSelectElement).value)}
          >
            {months.map((option) => (
              <option key={option} value={option}>
                {monthLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" class="scdb-control" onClick={() => void plugin.addTimeEntry(month)}>
          Add entry
        </button>
        <button
          type="button"
          class="scdb-control"
          disabled={entries.length === 0}
          onClick={() => void plugin.exportEffortRollUp(month, buckets, dimension)}
        >
          Export roll-up
        </button>
        <span class="scdb-toolbar__spacer" />
        <span class="scdb-muted">
          {entries.length === 0
            ? "Nothing recorded"
            : `${formatMinutes(total)} across ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
        </span>
      </div>

      {data !== null && data.problems.length > 0 && (
        <section class="scdb-section scdb-section--problems">
          <h3 class="scdb-section__title">
            {data.problems.length} row{data.problems.length === 1 ? "" : "s"} need a look
          </h3>
          <ul class="scdb-modal__list">
            {data.problems.map((problem) => (
              <li key={`${problem.line}-${problem.message}`}>
                Line {problem.line}: {problem.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          {monthLabel(month)}
          <span class="scdb-group__sub">{data?.path ?? ""}</span>
        </h3>

        {entries.length === 0 ? (
          <p class="scdb-empty">
            No time recorded for {monthLabel(month)}. Start the timer from the status bar, or add an
            entry for work already done.
          </p>
        ) : (
          <table class="scdb-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th class="scdb-num">Mins</th>
                <th>Reference</th>
                <th>Activity</th>
                <th>Study</th>
                <th>Cost centre</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((row) => (
                <tr key={`${row.line}-${row.text}`}>
                  <td>{row.entry.date}</td>
                  <td>
                    {row.entry.start === "" && row.entry.end === ""
                      ? "—"
                      : `${row.entry.start}–${row.entry.end}`}
                  </td>
                  <td class="scdb-num">{row.entry.mins}</td>
                  <td>{row.entry.ref}</td>
                  <td>{row.entry.activity}</td>
                  <td>{row.entry.study}</td>
                  <td>{row.entry.costCentre}</td>
                  <td>{row.entry.note}</td>
                  <td class="scdb-rowactions">
                    <button type="button" class="scdb-control" onClick={() => void editRow(row)}>
                      Edit
                    </button>
                    <button type="button" class="scdb-control" onClick={() => void splitRow(row)}>
                      Split
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Roll-up
          <span class="scdb-group__sub">
            every bucket counted, including the unset one — the columns must sum to the total
          </span>
        </h3>
        <div class="scdb-toolbar">
          <label class="scdb-field scdb-field--inline">
            <span class="scdb-field__label">By</span>
            <select
              class="dropdown"
              value={dimension}
              onChange={(event) =>
                setDimension((event.target as HTMLSelectElement).value as EffortDimension)
              }
            >
              {EFFORT_DIMENSIONS.map((option) => (
                <option key={option} value={option}>
                  {DIMENSION_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {buckets.length === 0 ? (
          <p class="scdb-empty">Nothing to roll up yet.</p>
        ) : (
          <table class="scdb-table">
            <thead>
              <tr>
                <th>{DIMENSION_LABELS[dimension]}</th>
                <th class="scdb-num">Entries</th>
                <th class="scdb-num">Time</th>
                <th class="scdb-num">Share</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.key}>
                  <td>{bucket.label}</td>
                  <td class="scdb-num">{bucket.count}</td>
                  <td class="scdb-num">{formatMinutes(bucket.mins)}</td>
                  <td class="scdb-num">
                    {total === 0 ? "—" : `${Math.round((bucket.mins / total) * 100)}%`}
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td class="scdb-num">{entries.length}</td>
                <td class="scdb-num">
                  <strong>{formatMinutes(total)}</strong>
                </td>
                <td class="scdb-num">100%</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** Exposed for the export command, so the CSV is exactly what the board shows. */
export { rollUpCsv };
