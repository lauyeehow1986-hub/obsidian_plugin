/**
 * Collecting the diagnostics report (CLAUDE.md §7 A4).
 *
 * The shape and the wording live in `domain/diagnostics`; this file is the part
 * that has to touch Obsidian, the clock and the filesystem to find anything out.
 *
 * The organising rule is A4's: **probe rather than assume**. A re-index is
 * actually run and timed. The ledger chain is actually walked. Core Mermaid is
 * actually asked to render something, because "we call a documented API" is not
 * evidence that the API works on the Obsidian in front of you. Where a probe is
 * impossible, the check says `unavailable` and why — never `ok`.
 */

import { MarkdownRenderer, apiVersion, type Component } from "obsidian";
import { AuditLog } from "./auditLog";
import { backupAge, formatBytes } from "../domain/backup/snapshots";
import {
  check,
  specProblemStatus,
  type Check,
  type DiagnosticsReport,
  type ReportSection,
} from "../domain/diagnostics/report";
import { PUBLICATION_TYPE, parsePublication } from "../domain/publication/publication";
import { describeFindings, summariseIntegrity } from "../domain/integrity/links";
import { collectIntegrityFindings } from "./integrity";
import { toVaultMinute } from "../domain/time/dates";
import { formatMinutes } from "../domain/effort/aggregate";
import type ScdbCockpitPlugin from "../main.js";
import { describeAlerts, lapsed } from "../domain/events/schedule.js";

/** How long the Mermaid probe waits for an SVG before giving up. */
const MERMAID_TIMEOUT_MS = 2000;

export async function collectDiagnostics(plugin: ScdbCockpitPlugin): Promise<DiagnosticsReport> {
  const sections: ReportSection[] = [
    versions(plugin),
    await index(plugin),
    validation(plugin),
    await ledger(plugin),
    await effort(plugin),
    obligations(plugin),
    await integrity(plugin),
    await backup(plugin),
    await integrations(plugin),
  ];
  return { generatedAt: toVaultMinute(Date.now()), sections };
}

/* --------------------------------------------------------------- effort -- */

/**
 * The effort log (§7 B2).
 *
 * Reported because it is a set of plain markdown tables the user may type into,
 * and a row the parser skips is a row missing from a roll-up that will later be
 * put in front of a funding committee. Silence there is expensive.
 */
async function effort(plugin: ScdbCockpitPlugin): Promise<ReportSection> {
  const months = plugin.effort.months();
  const entries = await plugin.effort.allEntries(months);
  const minutes = entries.reduce((sum, entry) => sum + entry.mins, 0);
  const problems = await plugin.effort.problems();
  const skipped = problems.reduce((sum, file) => sum + file.problems.length, 0);
  const vocab = plugin.effort.vocabularies();
  const vocabProblems = plugin.effort.vocabularyProblems();
  const timer = plugin.timer.current();

  const checks: Check[] = [
    check(
      "Effort log",
      "ok",
      `${entries.length} entries across ${months.length} month${months.length === 1 ? "" : "s"} in ` +
        `${plugin.settings.folders.time} (${formatMinutes(minutes)}).`,
    ),
    check(
      "Rows the parser skipped",
      skipped === 0 ? "ok" : "warn",
      skipped === 0
        ? "None — every row reads as a time entry."
        : problems
            .map((file) => `${file.path}: ${file.problems.map((p) => `line ${p.line}`).join(", ")}`)
            .join("; "),
      skipped === 0
        ? undefined
        : "Those rows are not counted in any roll-up. Open the Effort tab, which names what is wrong with each.",
    ),
    check(
      "Activity vocabulary",
      vocabProblems.length === 0 ? "ok" : "warn",
      vocab.fromFile
        ? `${vocab.activities.length} activities from ${plugin.effort.vocabularyPath()}.`
        : `${vocab.activities.length} activities, the built-in list.`,
      vocabProblems.length === 0 ? undefined : vocabProblems.join(" "),
    ),
  ];

  if (timer !== null) {
    checks.push(
      check(
        "Timer",
        "ok",
        `${timer.status} on ${timer.binding.ref || timer.binding.activity}, ` +
          `${formatMinutes(Math.round(plugin.timer.elapsed() / 60000))} so far.`,
      ),
    );
  }

  return { title: "Time and effort", checks };
}

/* ---------------------------------------------------------- obligations -- */

/**
 * Deadlines and recurring obligations (§7 B3).
 *
 * The one section here that reports something a user cannot otherwise see at a
 * glance: a recurrence rule the engine cannot resolve produces no date, no
 * badge and no notice, which is silence in exactly the place §5.7 says silence
 * is dangerous. Counts and ids only, never a title (rule 7).
 */
function obligations(plugin: ScdbCockpitPlugin): ReportSection {
  const schedule = plugin.eventSchedule();
  const overdue = lapsed(schedule);
  const blind = schedule.filter((entry) => entry.state === "unscheduled" && entry.alerting);
  const unreadable = schedule.filter((entry) => entry.note.problems.length > 0);
  const plans = plugin.events.plans();

  const checks: Check[] = [
    check(
      "Notes watched",
      "ok",
      `${schedule.length} event and obligation note${schedule.length === 1 ? "" : "s"} in ` +
        `${plugin.settings.folders.events}. ${describeAlerts(schedule) || "Nothing pressing."}`,
    ),
    check(
      "Lapsed obligations",
      overdue.length === 0 ? "ok" : "warn",
      overdue.length === 0
        ? "None."
        : overdue.map((entry) => `${entry.note.id} (${-entry.inDays} days)`).join(", "),
      overdue.length === 0
        ? undefined
        : "Open the Deadlines board and record each as done, or move its date.",
    ),
    check(
      "Rules with no date",
      blind.length === 0 ? "ok" : "warn",
      blind.length === 0
        ? "Every recurrence rule resolves to a date."
        : blind.map((entry) => entry.note.id).join(", "),
      blind.length === 0
        ? undefined
        : "A rule with no anchor and no due date is watched by nothing. Add either.",
    ),
    check(
      "Notes the parser questioned",
      unreadable.length === 0 ? "ok" : "warn",
      unreadable.length === 0
        ? "None."
        : unreadable.map((entry) => `${entry.note.id}: ${entry.note.problems.join(" ")}`).join("; "),
    ),
    check(
      "Dates not yet written to notes",
      "ok",
      plans.length === 0
        ? "Every recurring obligation carries the date its rule computes."
        : `${plans.length} computed date${plans.length === 1 ? "" : "s"} not written to the note. ` +
          "The board uses them either way.",
    ),
    check(
      "Calendar file",
      "ok",
      plugin.app.vault.getAbstractFileByPath(plugin.events.calendarPath()) === null
        ? `Not written yet (${plugin.events.calendarPath()}).`
        : `${plugin.events.calendarPath()}, replaced on each export.`,
    ),
  ];

  return { title: "Deadlines and obligations", checks };
}

/* ------------------------------------------------------------- versions -- */

function versions(plugin: ScdbCockpitPlugin): ReportSection {
  // `apiVersion` is the documented export and the number that actually decides
  // whether an API exists here. `app.appVersion` is not part of the public API
  // and reads as undefined on 1.12, which is how this first shipped saying
  // "unknown" — so it is a fallback now, not the source.
  const app = (plugin.app as unknown as { appVersion?: string }).appVersion;
  const obsidian = apiVersion || app || "unknown";

  const checks: Check[] = [
    check("Plugin version", "ok", `${plugin.manifest.id} ${plugin.manifest.version}`),
    check(
      "Obsidian",
      obsidian === "unknown" ? "warn" : "ok",
      `${obsidian} (plugin declares minAppVersion ${plugin.manifest.minAppVersion ?? "unset"})`,
      obsidian === "unknown" ? "Could not read a version from this build." : undefined,
    ),
    check("Platform", "ok", `${navigator.userAgent.includes("Windows") ? "Windows" : "other"}, Electron`),
    check(
      "Core Bases",
      plugin.basesAvailable ? "ok" : "unavailable",
      plugin.basesAvailable
        ? "Available; the browse layer and the two SCDB board view types are offered."
        : plugin.settings.bases === "off"
          ? "Turned off in settings. Every cockpit view still works — Bases is never a dependency."
          : "Not in this Obsidian. Every cockpit view still works — Bases is never a dependency.",
    ),
    check(
      "Settings schema",
      "ok",
      `v${plugin.settings.schemaVersion}, actor "${plugin.settings.actor || "(unset)"}"`,
      plugin.settings.actor.trim() === ""
        ? "Set your initials in settings — exports and snapshots are refused without an actor to log them against."
        : undefined,
    ),
  ];

  // Only reported when it is not the ordinary case. A line saying "the file
  // read fine" every time trains the reader to skip the section.
  if (plugin.settingsRead !== "loaded") {
    const unreadable = plugin.settingsRead === "unreadable";
    checks.push(
      check(
        "Settings file",
        unreadable ? "problem" : "ok",
        unreadable
          ? `${plugin.settingsFilePath()} exists but could not be read; running on defaults.`
          : `No settings file yet (${plugin.settingsFilePath()}); running on defaults.`,
        unreadable
          ? "Repair or delete that file and reload. Nothing has been overwritten — the file on disk is still whatever it was."
          : "Normal on a fresh install. Nothing is written until the first change.",
      ),
    );
  }

  // Suppressed unless the read was ordinary. migrateSettings cannot tell an
  // absent file from an unreadable one, so its note says "no stored settings
  // found" — which directly contradicts the row above when there IS a file.
  // The dedicated row knows better; two rows disagreeing is worse than one.
  if (plugin.settingsRead === "loaded" && plugin.migrationNotes.length > 0) {
    checks.push(
      check(
        "Settings migration",
        "warn",
        `${plugin.migrationNotes.length} note(s) from the last load: ${plugin.migrationNotes.join(" ")}`,
      ),
    );
  }

  return { title: "Versions", checks };
}

/* ---------------------------------------------------------------- index -- */

async function index(plugin: ScdbCockpitPlugin): Promise<ReportSection> {
  // Actually rebuild it. A2's budget is "under a second on 5,000 notes", and
  // the only way to know whether that still holds on this machine is to do it.
  const started = performance.now();
  await plugin.reindex();
  const ms = Math.round(performance.now() - started);

  const specs = plugin.workflows.all();
  const problems = plugin.workflows.problems();

  return {
    title: "Index and workflow specs",
    checks: [
      check(
        "Re-index time",
        ms > 1000 ? "warn" : "ok",
        `${plugin.notes.size} typed notes (${plugin.index.size} requests) in ${ms} ms`,
        ms > 1000 ? "Over the one-second budget in CLAUDE.md §7 A2." : undefined,
      ),
      check(
        "Note types present",
        plugin.notes.size === 0 ? "warn" : "ok",
        plugin.notes
          .types()
          .map((entry) => `${entry.type} ${entry.count}`)
          .join(", ") || "none",
        plugin.notes.size === 0
          ? "No note carries a `type:` field, so every board will be empty."
          : undefined,
      ),
      check(
        "Workflow specs",
        specs.length === 0 ? "problem" : "ok",
        `${specs.length} loaded from ${plugin.settings.folders.config}/workflows/`,
        specs.length === 0
          ? "Without a spec no request can change stage. Add one and re-run."
          : undefined,
      ),
      // The spec loader already grades these: an `error` means the spec was
      // refused and no request governed by it can move, a `warning` means it
      // loaded and something is worth a look. Flattening both to PROBLEM told
      // the reader a placeholder stage with no SLA target was as serious as an
      // unusable workflow — and a report that cries wolf stops being read.
      check(
        "Spec problems",
        specProblemStatus(problems),
        problems.length === 0
          ? "None."
          : problems
              .map(
                (entry) =>
                  `${entry.problem.severity === "error" ? "error" : "advisory"} — ` +
                  `${entry.path}: ${entry.problem.message}`,
              )
              .join("; "),
        problems.some((entry) => entry.problem.severity === "error")
          ? "A spec with an error is not loaded; requests governed by it cannot change stage until it is fixed."
          : problems.length > 0
            ? "Advisory only — the spec loaded and is in use."
            : undefined,
      ),
    ],
  };
}

/* ----------------------------------------------------------- validation -- */

/** A note's most useful handle: its `id` where it has one, its path where not. */
function handle(id: string, path: string): string {
  return id.trim() === "" ? path : id.trim();
}

function validation(plugin: ScdbCockpitPlugin): ReportSection {
  const unreadable: string[] = [];
  const stranded: string[] = [];
  for (const entry of plugin.index.all()) {
    const label = handle(entry.request.id, entry.file.path);
    if (entry.problems.length > 0) unreadable.push(label);
    if (plugin.needsMigration(entry.request)) stranded.push(label);
  }

  const badPublications: string[] = [];
  for (const entry of plugin.notes.byType(PUBLICATION_TYPE)) {
    const publication = parsePublication(entry.file.path, entry.frontmatter);
    if (publication.problems.length > 0) {
      badPublications.push(handle(publication.id, entry.file.path));
    }
  }

  const untyped = plugin.app.vault.getMarkdownFiles().length - plugin.notes.size;

  return {
    title: "Notes that need attention",
    checks: [
      check(
        "Requests the parser could not fully read",
        unreadable.length === 0 ? "ok" : "problem",
        unreadable.length === 0 ? "None." : `${unreadable.length}: ${unreadable.join(", ")}`,
        unreadable.length === 0
          ? undefined
          : "Every dwell time and SLA state on these is computed from fields that did not parse.",
      ),
      check(
        "Requests stranded by a workflow change",
        stranded.length === 0 ? "ok" : "warn",
        stranded.length === 0 ? "None." : `${stranded.length}: ${stranded.join(", ")}`,
        stranded.length === 0 ? undefined : "They cannot change stage until migrated (§5.2).",
      ),
      check(
        "Publications with unreadable fields",
        badPublications.length === 0 ? "ok" : "warn",
        badPublications.length === 0 ? "None." : badPublications.join(", "),
      ),
      check(
        "Markdown notes with no `type:`",
        "ok",
        `${untyped} of ${plugin.app.vault.getMarkdownFiles().length} — these are ordinary notes and are not indexed.`,
      ),
    ],
  };
}

/* --------------------------------------------------------------- ledger -- */

async function ledger(plugin: ScdbCockpitPlugin): Promise<ReportSection> {
  try {
    const result = await plugin.audit.verify();
    return {
      title: "Audit ledger",
      checks: [
        check(
          "Chain verification",
          result.ok ? (result.malformed.length > 0 ? "warn" : "ok") : "problem",
          AuditLog.describe(result),
        ),
      ],
    };
  } catch (error) {
    return {
      title: "Audit ledger",
      checks: [
        check(
          "Chain verification",
          "problem",
          `Could not be read: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

/* ------------------------------------------------------------ integrity -- */

/**
 * The reference-integrity summary, as one row of the report.
 *
 * Counts only here — the full list has its own command and its own dialog. A
 * self-test that dumped forty unresolved links into the middle of a report
 * would stop the report being readable, which is the only thing it is for.
 */
async function integrity(plugin: ScdbCockpitPlugin): Promise<ReportSection> {
  let subjects: string[] = [];
  try {
    subjects = await plugin.audit.subjects();
  } catch {
    // The ledger check above has already reported this properly.
  }

  const summary = summariseIntegrity(collectIntegrityFindings(plugin, subjects));
  const breaking = summary.byKind.filter(
    (entry) => entry.kind === "duplicate-uid" || entry.kind === "dangling-uid",
  );

  return {
    title: "Links and references",
    checks: [
      check(
        "Reference integrity",
        summary.total === 0 ? "ok" : breaking.length > 0 ? "problem" : "warn",
        summary.total === 0
          ? "Every frontmatter link resolves and every uid is unique."
          : summary.byKind.map((entry) => describeFindings(entry.kind, entry.count)).join(", "),
        summary.total === 0
          ? undefined
          : 'Run "Check link and reference integrity" for the list and the repairs on offer.',
      ),
    ],
  };
}

/* --------------------------------------------------------------- backup -- */

async function backup(plugin: ScdbCockpitPlugin): Promise<ReportSection> {
  const config = plugin.settings.backup;
  const problem = await plugin.backup.destinationProblem();

  const parsed = config.lastAt === "" ? NaN : Date.parse(config.lastAt);
  const age = backupAge(
    Number.isNaN(parsed) ? null : parsed,
    config.intervalDays,
    Date.now(),
  );

  const checks: Check[] = [
    check(
      "Destination",
      problem === null ? "ok" : config.destination.trim() === "" ? "warn" : "problem",
      problem ?? config.destination,
      // A vault with no backup at all is the single most consequential thing
      // this report can tell you, so it is said as an instruction, not a note.
      config.destination.trim() === ""
        ? "Nothing in this vault is being backed up. Set a folder in settings."
        : undefined,
    ),
    check("Age", age.stale ? "warn" : "ok", age.text),
  ];

  if (problem === null) {
    const snapshots = await plugin.backup.list();
    const newest = snapshots[0];
    checks.push(
      check(
        "Snapshots held",
        snapshots.length === 0 ? "warn" : "ok",
        snapshots.length === 0
          ? "None in the destination folder."
          : `${snapshots.length} (keeping ${config.keep}); newest ${newest!.name}, ${formatBytes(newest!.bytes)}`,
      ),
    );
  }

  checks.push(
    check(
      "Restore rehearsal",
      "unavailable",
      "Not something the plugin can check for you.",
      'Run "Verify a backup snapshot" — a backup nobody has ever opened is not a backup.',
    ),
  );

  return { title: "Encrypted backup", checks };
}

/* --------------------------------------------------------- integrations -- */

async function integrations(plugin: ScdbCockpitPlugin): Promise<ReportSection> {
  return {
    title: "Integrations",
    checks: [
      await mermaidProbe(plugin),
      clipboardProbe(),
      protocolCheck(plugin),
      emailImportCheck(plugin),
      check(
        "R and Python interpreters",
        "unavailable",
        "Not built yet — running scripts is phase F1.",
        "Their paths on this machine are an open question in CLAUDE.md §11.",
      ),
      check(
        "Network",
        "ok",
        "No outbound request is possible: no module that could make one is enabled, and none ships enabled (rule 3).",
      ),
    ],
  };
}

/**
 * Whether a draft can be handed to the OS at all.
 *
 * Deliberately **not** a launch. §7 A4's rule is probe-don't-assume, but a
 * self-test that opens a mail window every time it runs is a self-test people
 * stop running. What can be established without side effects is whether
 * Electron's shell is reachable at all; whether *Outlook specifically* is
 * registered for `mailto:` is a question only the machine can answer, and
 * settings carries the button that asks it (CLAUDE.md §11).
 */
function protocolCheck(plugin: ScdbCockpitPlugin): Check {
  const reachable = shellReachable();
  const ceiling = plugin.settings.comms.uriCeiling;

  return check(
    "Protocol handlers (mailto:, Teams)",
    reachable ? "ok" : "problem",
    reachable
      ? `Electron's shell is reachable; drafts longer than ${ceiling} characters go to the clipboard instead of being opened.`
      : "Electron's shell is not reachable, so no draft can be opened. Every message falls back to the clipboard.",
    reachable
      ? 'Whether Outlook is the registered mailto: handler is a question only this machine can answer — "Test mailto:" in settings opens a throwaway draft so you can see.'
      : "Nothing is lost: the composer still copies. This is expected on anything that is not desktop Obsidian.",
  );
}

/**
 * Whether saved email can be imported, and whether there is anything to import.
 *
 * Both halves matter on a machine with no console. "Nothing happened when I ran
 * it" has two causes — no addresses configured, so the importer refuses, and no
 * `.eml` in the vault, so there is nothing to read — and they look identical
 * from the outside.
 */
function emailImportCheck(plugin: ScdbCockpitPlugin): Check {
  const addresses = plugin.settings.comms.myAddresses.length;
  const counted = { eml: 0, msg: 0 };
  for (const file of plugin.app.vault.getFiles()) {
    const extension = file.extension.toLowerCase();
    if (extension === "eml" || extension === "msg") counted[extension] += 1;
  }
  const files = counted.eml + counted.msg;

  if (addresses === 0) {
    return check(
      "Importing saved email",
      "unavailable",
      "No addresses of your own are set, so the importer refuses: it cannot tell a message you sent from one you received.",
      "Settings → Importing saved email. Getting the direction wrong would silently close follow-ups that are still open, so it asks rather than guesses.",
    );
  }

  return check(
    "Importing saved email",
    "ok",
    `${addresses} address${addresses === 1 ? "" : "es"} configured; ` +
      `${counted.eml} .eml and ${counted.msg} .msg file${files === 1 ? "" : "s"} in the vault.`,
    files === 0
      ? "Drag a message out of Outlook into the vault and run the import. Either format works: new Outlook and the web app save .eml, classic Outlook saves .msg."
      : "Messages already recorded are skipped on their Message-ID, so running the import again is safe.",
  );
}

/** The same reach `services/protocol` uses, without opening anything. */
function shellReachable(): boolean {
  try {
    const electron = (globalThis as { require?: (id: string) => unknown }).require?.("electron");
    const shell = (electron as { shell?: { openExternal?: unknown } } | undefined)?.shell;
    return typeof shell?.openExternal === "function";
  } catch {
    return false;
  }
}

/**
 * Ask core Mermaid to render something and look for an SVG.
 *
 * D1 renders diagrams through `MarkdownRenderer.render` rather than bundling a
 * diagram library, which makes core Mermaid a real runtime assumption — and
 * §7 A4 asks for it to be probed rather than assumed. Rendering is asynchronous
 * beyond the promise this awaits, so the element is polled and a timeout is
 * reported as "could not confirm" rather than as a failure: a slow machine is
 * not a broken Obsidian.
 */
async function mermaidProbe(plugin: ScdbCockpitPlugin): Promise<Check> {
  const host = createDiv();
  try {
    await MarkdownRenderer.render(
      plugin.app,
      "```mermaid\nflowchart LR\n  a --> b\n```",
      host,
      "",
      plugin as unknown as Component,
    );

    const deadline = Date.now() + MERMAID_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (host.querySelector("svg") !== null) {
        return check("Core Mermaid rendering", "ok", "Rendered a test flowchart to SVG.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check(
      "Core Mermaid rendering",
      "warn",
      `No SVG appeared within ${MERMAID_TIMEOUT_MS} ms.`,
      "Could not confirm; the diagram builder (D1) depends on this.",
    );
  } catch (error) {
    return check(
      "Core Mermaid rendering",
      "problem",
      `Threw: ${error instanceof Error ? error.message : String(error)}`,
      "The diagram builder (D1) depends on this.",
    );
  } finally {
    host.remove();
  }
}

/**
 * Report whether the clipboard image API exists — without using it.
 *
 * D1's "copy PNG to the clipboard" is the feature that matters for pasting into
 * a slide, so its availability is worth knowing. Actually writing to the
 * clipboard during a diagnostics run would destroy whatever the user had
 * copied, which is a surprise a self-test has no business causing.
 */
function clipboardProbe(): Check {
  const write = typeof navigator.clipboard?.write === "function";
  const item = typeof (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem === "function";
  return check(
    "Clipboard image write",
    write && item ? "ok" : "warn",
    write && item
      ? "navigator.clipboard.write and ClipboardItem are both present (capability checked, not exercised)."
      : `Missing: ${[!write && "navigator.clipboard.write", !item && "ClipboardItem"].filter(Boolean).join(", ")}.`,
    write && item ? undefined : "Copying a diagram to the clipboard (D1) would not work here.",
  );
}
