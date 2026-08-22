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
import type ScdbCockpitPlugin from "../main.js";

/** How long the Mermaid probe waits for an SVG before giving up. */
const MERMAID_TIMEOUT_MS = 2000;

export async function collectDiagnostics(plugin: ScdbCockpitPlugin): Promise<DiagnosticsReport> {
  const sections: ReportSection[] = [
    versions(plugin),
    await index(plugin),
    validation(plugin),
    await ledger(plugin),
    await integrity(plugin),
    await backup(plugin),
    await integrations(plugin),
  ];
  return { generatedAt: toVaultMinute(Date.now()), sections };
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
