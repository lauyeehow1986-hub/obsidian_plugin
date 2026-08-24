import { useMemo } from "preact/hooks";
import { policyLabel, statusLabel } from "../domain/policy/policy";
import { buildRegister, type RegisterRow } from "../domain/policy/register";
import { presentReview } from "../domain/report/present";
import type ScdbCockpitPlugin from "../main.js";
import { count } from "./format";

function ReviewBadge({ row }: { row: RegisterRow }) {
  const state = presentReview(row.reviewState);
  const when =
    row.reviewInDays === null
      ? ""
      : row.reviewInDays < 0
        ? ` ${Math.abs(row.reviewInDays)}d ago`
        : ` in ${row.reviewInDays}d`;
  return (
    <span class={`scdb-state ${state.className}`} title={state.label}>
      <span aria-hidden="true">{state.glyph}</span> {state.label}
      {when}
    </span>
  );
}

function PolicyCard({ row, plugin }: { row: RegisterRow; plugin: ScdbCockpitPlugin }) {
  const { policy } = row;
  return (
    <li class="scdb-card">
      <button
        type="button"
        class="scdb-card__main"
        onClick={() => plugin.openNote(policy.path)}
        aria-label={`Open ${policyLabel(policy)}`}
      >
        <span class="scdb-card__id">
          {policy.id || "(no id)"} · v{policy.version || "?"}
        </span>
        <span class="scdb-card__title">{policy.title || "(untitled)"}</span>
        <span class="scdb-card__meta">
          <ReviewBadge row={row} />
          <span class="scdb-chip">{statusLabel(policy.status)}</span>
          <span
            class="scdb-muted scdb-num"
            title="Everything declared against it, from either end. The number in brackets names the clause it rests on — only those can be told apart when a clause changes."
          >
            {count(row.edges.length, "dependant")}
            {row.edges.length > 0 && ` (${row.withClause} by clause)`}
          </span>
          <span class="scdb-muted scdb-num">{count(row.frozen, "frozen version")}</span>
          {row.problems.length > 0 && (
            <span class="scdb-chip scdb-chip--problem" title={row.problems.join("\n\n")}>
              needs attention
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        class="scdb-card__action"
        title="Freeze the current text and replace it with a new version"
        onClick={() => plugin.revisePolicy(policy)}
      >
        Revise
      </button>
      <button
        type="button"
        class="scdb-card__action"
        disabled={policy.version.trim() === ""}
        title={
          policy.version.trim() === ""
            ? "Add the version printed on the document first — a frozen copy is filed under it."
            : "Snapshot the current text without changing it, so a first revision has something to diff against"
        }
        onClick={() => plugin.freezePolicyBaseline(policy)}
      >
        Freeze
      </button>
    </li>
  );
}

export function PolicyBoard({ plugin }: { plugin: ScdbCockpitPlugin }) {
  const policies = plugin.policies();
  const register = useMemo(
    () => buildRegister({ policies, incoming: plugin.policyIncomingEdges(), now: Date.now() }),
    [policies, plugin],
  );

  if (register.rows.length === 0) {
    return (
      <div class="scdb-stack">
        <p class="scdb-empty">
          No policies yet. Add a note to <code>{plugin.settings.folders.policies}</code> with{" "}
          <code>type: policy</code>, an <code>id</code>, the <code>version</code> printed on the
          document, and a <code>review_due</code> date. List what rests on it under{" "}
          <code>governs:</code>, each with the <code>clause:</code> it depends on — that list is
          what a revision's impact map is built from, and a dependency with no clause can only ever
          be reported as “review”.
        </p>
      </div>
    );
  }

  const { summary } = register;
  return (
    <div class="scdb-stack">
      <section class="scdb-group">
        <h3 class="scdb-group__title">
          Policy register
          <span class="scdb-group__sub">
            {count(summary.total, "policy", "policies")}, {summary.inForce} in force
          </span>
        </h3>

        {(summary.overdue > 0 || summary.undeclared > 0 || summary.neverFrozen > 0) && (
          <ul class="scdb-list scdb-list--problems">
            {summary.overdue > 0 && (
              <li>{count(summary.overdue, "policy", "policies")} overdue for review.</li>
            )}
            {summary.undeclared > 0 && (
              <li>
                {count(summary.undeclared, "policy", "policies")} in force with nothing declared
                against them — revising one would produce an empty impact map.
              </li>
            )}
            {summary.neverFrozen > 0 && (
              <li>
                {count(summary.neverFrozen, "policy", "policies")} in force never frozen, so a
                first revision has nothing to diff against.
              </li>
            )}
          </ul>
        )}

        <ul class="scdb-cards">
          {register.rows.map((row) => (
            <PolicyCard key={row.policy.path} row={row} plugin={plugin} />
          ))}
        </ul>
      </section>
    </div>
  );
}
