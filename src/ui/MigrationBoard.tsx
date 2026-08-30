/**
 * The migration view (CLAUDE.md §5.2).
 *
 * Renaming or removing a stage strands every in-flight request sitting in it,
 * and the placeholder eData stages *will* be replaced with the real ones, so
 * this is guaranteed to happen at least once. Those notes are quarantined from
 * stage actions by the transition engine; this is where they get unstuck.
 *
 * The screen is deliberately a worksheet rather than a wizard: old stage →
 * proposed new stage, every proposal editable, nothing written until Apply.
 */

import { useState } from "preact/hooks";
import {
  planMigration,
  type MigrationItem,
  type MigrationPlan,
} from "../domain/request/migration";
import type { WorkflowNote } from "../domain/request/request";
import type { WorkflowSpec } from "../domain/request/workflow";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

/** Group the indexed requests by the spec that governs them. */
/**
 * Every note the workflow engine governs, requests and projects alike.
 *
 * A project strands exactly as a request does — its spec's stages get renamed
 * and its `workflow_version` falls behind — so it belongs on this board rather
 * than in a second migration view. `planMigration` is generic over the note
 * type for this reason (§5.15).
 */
function buildPlans(plugin: ScdbCockpitPlugin): {
  plans: MigrationPlan<WorkflowNote>[];
  orphans: WorkflowNote[];
} {
  const bySpec = new Map<string, { spec: WorkflowSpec; requests: WorkflowNote[] }>();
  const orphans: WorkflowNote[] = [];

  const governed: WorkflowNote[] = [
    ...plugin.index.all().map((entry) => entry.request),
    ...plugin.projects().map((entry) => entry.project),
  ];

  for (const note of governed) {
    const spec = plugin.workflows.forRequest(note.workflow);
    if (spec === null) {
      orphans.push(note);
      continue;
    }
    const group = bySpec.get(spec.id) ?? { spec, requests: [] };
    group.requests.push(note);
    bySpec.set(spec.id, group);
  }

  const plans = [...bySpec.values()]
    .map((group) => planMigration(group.requests, group.spec))
    .filter((plan) => plan.items.length > 0 || plan.ahead.length > 0);

  return { plans, orphans };
}

/** How many notes across every spec are waiting to be migrated. */
export function strandedCount(plugin: ScdbCockpitPlugin): number {
  return buildPlans(plugin).plans.reduce((total, plan) => total + plan.items.length, 0);
}

function PlanTable({ plan, plugin }: { plan: MigrationPlan<WorkflowNote>; plugin: ScdbCockpitPlugin }) {
  const { spec, items } = plan;

  // Deselection rather than selection, so a note that appears while the board
  // is open arrives ready to migrate rather than silently skipped.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const targetFor = (item: MigrationItem<WorkflowNote>): string =>
    chosen[item.request.uid] ?? item.proposedStage;

  const selected = items.filter((item) => !skipped.has(item.request.uid));

  const unset = selected.filter((item) => targetFor(item) === "");
  const offProposal = selected.filter((item) => targetFor(item) !== item.proposedStage);
  // The engine enforces this too — the button only avoids offering a click that
  // is going to be refused.
  const needsReason = selected.some(
    (item) => item.proposalSource === "none" || targetFor(item) !== item.proposedStage,
  );

  const blocked =
    busy ||
    selected.length === 0 ||
    unset.length > 0 ||
    (needsReason && reason.trim() === "");

  const toggle = (uid: string) => {
    const next = new Set(skipped);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setSkipped(next);
  };

  const apply = async () => {
    setBusy(true);
    try {
      await plugin.migrateRequests(
        selected.map((item) => ({
          request: item.request,
          spec,
          toStage: targetFor(item),
          ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
        })),
      );
      setReason("");
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <section class="scdb-group scdb-migration">
      <h3 class="scdb-group__title">
        {spec.label} v{spec.version}
        <span class="scdb-group__sub">{count(items.length, "note")} stranded</span>
      </h3>
      <p class="scdb-migration__lede">
        These requests were last valid under an earlier version of this workflow, so the plugin
        will not change their stage until they are migrated. Nothing is written until you press
        Apply, and every migration is recorded in the audit ledger.
      </p>

      <table class="scdb-table">
        <thead>
          <tr>
            <th class="scdb-migration__pick">Migrate</th>
            <th>Note</th>
            <th>Now in</th>
            <th>Move to</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const uid = item.request.uid;
            const target = targetFor(item);
            const off = target !== "" && target !== item.proposedStage;
            return (
              <tr key={uid}>
                <td class="scdb-migration__pick">
                  <input
                    type="checkbox"
                    checked={!skipped.has(uid)}
                    disabled={busy}
                    aria-label={`Migrate ${item.request.id || uid}`}
                    onChange={() => toggle(uid)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    class="scdb-link"
                    onClick={() => plugin.showWorkflowNote(item.request)}
                  >
                    {item.request.id || uid.slice(0, 8)}
                  </button>
                  <div class="scdb-muted">{item.request.title || "(untitled)"}</div>
                </td>
                <td>
                  <code>{item.fromStage || "(none)"}</code>
                </td>
                <td>
                  <select
                    value={target}
                    disabled={busy}
                    aria-label={`New stage for ${item.request.id || uid}`}
                    onChange={(event) =>
                      setChosen({
                        ...chosen,
                        [uid]: (event.target as HTMLSelectElement).value,
                      })
                    }
                  >
                    {item.proposedStage === "" && <option value="">— choose a stage —</option>}
                    {spec.stages.map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.label}
                        {stage.id === item.proposedStage ? " (proposed)" : ""}
                      </option>
                    ))}
                  </select>
                  {off && <div class="scdb-field__error">Not the proposal — needs a reason.</div>}
                </td>
                <td class="scdb-muted">{item.explanation}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {needsReason && (
        <label class="scdb-field scdb-field--override">
          <span class="scdb-field__label">Why this mapping?</span>
          <span class="scdb-field__hint">
            {offProposal.length > 0
              ? "One or more targets differ from what the spec proposes."
              : "The spec does not say where these stages belong."}{" "}
            The reason is written to the audit ledger against every request in this batch.
          </span>
          <textarea
            rows={2}
            value={reason}
            disabled={busy}
            onInput={(event) => setReason((event.target as HTMLTextAreaElement).value)}
          />
        </label>
      )}

      <div class="scdb-migration__actions">
        <button
          type="button"
          class="scdb-link"
          disabled={busy}
          onClick={() =>
            setSkipped(
              skipped.size === items.length
                ? new Set()
                : new Set(items.map((item) => item.request.uid)),
            )
          }
        >
          {skipped.size === items.length ? "Select all" : "Select none"}
        </button>
        <button type="button" class="mod-cta" disabled={blocked} onClick={() => void apply()}>
          {busy ? "Migrating…" : `Migrate ${count(selected.length, "note")}`}
        </button>
      </div>
    </section>
  );
}

function AheadNotice({ plan }: { plan: MigrationPlan<WorkflowNote> }) {
  if (plan.ahead.length === 0) return null;
  return (
    <section class="scdb-group">
      <h3 class="scdb-group__title">Written under a newer specification</h3>
      <p class="scdb-migration__lede">
        These notes record a version of <strong>{plan.spec.label}</strong> newer than the v
        {plan.spec.version} installed here. The plugin will not rewrite them — writing an older
        shape over a newer one loses data. Install the newer specification instead.
      </p>
      <ul class="scdb-list scdb-list--problems">
        {plan.ahead.map((request) => (
          <li key={request.uid}>
            {request.id || request.uid} — records v{request.workflowVersion}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MigrationBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const { plans, orphans } = buildPlans(plugin);

  if (plans.length === 0 && orphans.length === 0) {
    return (
      <p class="scdb-empty">
        Nothing to migrate. Every request and project matches the version of the workflow it
        follows. When a stage is renamed or removed in{" "}
        <code>{plugin.settings.folders.config}/workflows/</code>, the notes stranded by the change
        are listed here.
      </p>
    );
  }

  return (
    <div class="scdb-stack">
      {plans.map((plan) => (
        <PlanTable key={plan.spec.id} plan={plan} plugin={plugin} />
      ))}
      {plans.map((plan) => (
        <AheadNotice key={`ahead-${plan.spec.id}`} plan={plan} />
      ))}

      {orphans.length > 0 && (
        <section class="scdb-group">
          <h3 class="scdb-group__title">No workflow specification</h3>
          <p class="scdb-migration__lede">
            These requests name a workflow that is not installed, so there is nothing to migrate
            them onto. Add the specification to{" "}
            <code>{plugin.settings.folders.config}/workflows/</code>, or correct the{" "}
            <code>workflow</code> field on the note.
          </p>
          <ul class="scdb-list scdb-list--problems">
            {orphans.map((request) => (
              <li key={request.uid}>
                <button type="button" class="scdb-link" onClick={() => plugin.showWorkflowNote(request)}>
                  {request.id || request.uid}
                </button>{" "}
                — names <code>{request.workflow || "(nothing)"}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
