import { useEffect, useMemo, useState } from "preact/hooks";

import {
  STATE_LABELS,
  searchApps,
  summarise,
  type AppAssessment,
  type AppState,
} from "../domain/apps/register";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

/**
 * The vault-apps register (§5.13, §7 F3).
 *
 * Grouped by whether an app can run, worst first, so the two states that need
 * a decision from you sit at the top rather than in alphabetical order among
 * apps that are simply fine.
 *
 * Every card names what the app may reach *before* offering to run it, and the
 * code is one click away on the same card. That is rule 12 in the interface:
 * "showing what will run" is not satisfied by a Run button next to a title.
 *
 * Loads asynchronously for the same reason the forms board does — an app's
 * code lives in the note body, which the metadata cache does not hold.
 */

/** §6: state is colour *plus* a glyph, never colour alone. */
const STATE_CHIPS: Record<AppState, { cls: string; glyph: string }> = {
  broken: { cls: "scdb-chip scdb-chip--problem", glyph: "✕" },
  changed: { cls: "scdb-chip scdb-chip--overdue", glyph: "⚠" },
  consent: { cls: "scdb-chip scdb-chip--blocked", glyph: "🔒" },
  ready: { cls: "scdb-chip", glyph: "✓" },
};

function AppCard({ entry, plugin }: { entry: AppAssessment; plugin: ScdbCockpitPlugin }) {
  const [open, setOpen] = useState(false);
  const { manifest } = entry;
  const chip = STATE_CHIPS[entry.state];

  return (
    <li class="scdb-card scdb-card--stacked">
      <div class="scdb-card__row">
        <button
          type="button"
          class="scdb-card__main"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${manifest.id}`}
        >
          <span class="scdb-card__id">{manifest.id}</span>
          <span class="scdb-card__title">{manifest.title}</span>
          <span class="scdb-card__meta">
            <span class={chip.cls}>
              {chip.glyph} {STATE_LABELS[entry.state]}
            </span>
            <span class="scdb-muted">{entry.capabilities}</span>
            {entry.grant !== undefined && (
              <span class="scdb-muted scdb-num" title="When you allowed this app to run">
                allowed {entry.grant.at}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          class="scdb-card__action"
          disabled={entry.state === "broken"}
          title={
            entry.needsConsent
              ? "Shows what it may reach and the code it will run, before anything runs."
              : "Run this app in a sandboxed pane."
          }
          onClick={() => void plugin.runApp(manifest.path)}
        >
          {entry.needsConsent ? "Review and run…" : "Run"}
        </button>
        <button
          type="button"
          class="scdb-card__action"
          disabled={manifest.export === "denied" || manifest.source.trim() === ""}
          title={
            manifest.export === "denied"
              ? "This app's own note says export: denied."
              : "Write a self-contained HTML copy, with a snapshot of the data it may read."
          }
          onClick={() => void plugin.exportApp(manifest.path)}
        >
          Export…
        </button>
      </div>

      {open && (
        <div class="scdb-card__detail">
          {manifest.description !== "" && <p class="scdb-muted">{manifest.description}</p>}

          {entry.check.changes.length > 0 && (
            <ul class="scdb-list scdb-list--problems">
              {entry.check.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}

          {manifest.problems.length > 0 && (
            <ul class="scdb-list scdb-list--problems">
              {manifest.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          <dl class="scdb-deflist">
            <dt>Note</dt>
            <dd>
              <button
                type="button"
                class="scdb-linkish"
                onClick={() => plugin.openNote(manifest.path)}
              >
                {manifest.path}
              </button>
            </dd>
            <dt>May read</dt>
            <dd>
              {manifest.capabilities.query.length === 0
                ? "nothing"
                : manifest.capabilities.query.join(", ")}
            </dd>
            <dt>May write</dt>
            <dd>
              {manifest.capabilities.write === "propose"
                ? "may propose changes, which you confirm one at a time"
                : "nothing"}
            </dd>
            {entry.grant !== undefined && (
              <>
                <dt>Permission</dt>
                <dd>
                  given {entry.grant.at}{" "}
                  <button
                    type="button"
                    class="scdb-linkish"
                    title="Withdraw permission. The app will ask again before it next runs."
                    onClick={() => void plugin.revokeApp(manifest.path)}
                  >
                    withdraw
                  </button>
                </dd>
              </>
            )}
          </dl>

          <pre class="scdb-code" aria-label={`Code in ${manifest.title}`}>
            {manifest.source.trim() === "" ? "(no code)" : manifest.source.trim()}
          </pre>
        </div>
      )}
    </li>
  );
}

export function AppsBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const [query, setQuery] = useState("");
  const [register, setRegister] = useState<AppAssessment[] | null>(null);

  useEffect(() => {
    let live = true;
    void plugin.appsRegister().then((built) => {
      if (live) setRegister(built);
    });
    return () => {
      live = false;
    };
  }, [plugin, plugin.appsVersion]);

  const matching = useMemo(
    () => (register === null ? [] : searchApps(register, query)),
    [register, query],
  );

  if (register === null) return <p class="scdb-empty">Reading the app notes…</p>;

  if (register.length === 0) {
    return (
      <div class="scdb-stack">
        <p class="scdb-empty">
          No vault apps yet. An app is a note carrying <code>type: vault-app</code>, a{" "}
          <code>capabilities:</code> block saying what it may read, and its code in a{" "}
          <code>```js app</code> block. It runs in a sandbox that cannot reach the vault, the
          filesystem or the network — everything it reads comes back through the plugin, and only
          what you allowed.
        </p>
        <div class="scdb-toolbar">
          <button type="button" class="mod-cta" onClick={() => void plugin.newApp()}>
            New app
          </button>
          <button type="button" class="scdb-control" onClick={() => void plugin.openScratchpad()}>
            Open the scratchpad
          </button>
        </div>
      </div>
    );
  }

  const summary = summarise(register);
  const groups = (["broken", "changed", "consent", "ready"] as AppState[])
    .map((state) => ({ state, apps: matching.filter((entry) => entry.state === state) }))
    .filter((group) => group.apps.length > 0);

  return (
    <div class="scdb-stack">
      <div class="scdb-toolbar">
        <input
          type="search"
          class="scdb-catalogue__search"
          placeholder="Search app name, purpose or what it reads…"
          value={query}
          aria-label="Search the apps"
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
        <button type="button" class="scdb-control" onClick={() => void plugin.newApp()}>
          New app
        </button>
        <button type="button" class="scdb-control" onClick={() => void plugin.openScratchpad()}>
          Scratchpad
        </button>
      </div>

      <p class="scdb-muted scdb-num">
        {count(summary.total, "app")} · {summary.ready} ready ·{" "}
        {summary.awaiting} awaiting your decision
        {summary.broken > 0 ? ` · ${summary.broken} cannot run` : ""}
      </p>

      {summary.awaiting > 0 && (
        <ul class="scdb-list scdb-list--problems">
          <li>
            {count(summary.awaiting, "app")} cannot run until you say what it may reach. One that
            has been edited to ask for more will name exactly what changed.
          </li>
        </ul>
      )}

      {groups.length === 0 ? (
        <p class="scdb-empty">Nothing matches “{query}”.</p>
      ) : (
        groups.map((group) => (
          <section key={group.state} class="scdb-group">
            <h3 class="scdb-group__title">
              {STATE_LABELS[group.state]}
              <span class="scdb-group__sub">{count(group.apps.length, "app")}</span>
            </h3>
            <ul class="scdb-cards">
              {group.apps.map((entry) => (
                <AppCard key={entry.manifest.path} entry={entry} plugin={plugin} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
