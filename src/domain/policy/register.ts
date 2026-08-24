/**
 * The policy register (§7 C1) — the standing view over `40 Policies/`.
 *
 * The register answers what the impact map cannot, because the impact map only
 * exists on the day something is revised: which policies are in force, which
 * are overdue for review, and — the one that catches people out — which have
 * nothing declared against them at all. A policy with no declared dependants
 * is not a policy nothing rests on; it is a policy whose revision will produce
 * an empty impact map. That is a finding, and it is shown as one.
 *
 * Pure module: no Obsidian, no Node.
 */

import { DAY_MS } from "../time/dates";
import type { PolicyEdge, PolicyNote } from "./policy";
import { collectEdges } from "./impact";

export const REVIEW_STATES = ["overdue", "due-soon", "scheduled", "unset"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Labels and glyphs: `presentReview` in `domain/report/present`, as above. */

export interface RegisterRow {
  policy: PolicyNote;
  /** Everything declared against it, from both ends. */
  edges: PolicyEdge[];
  /** How many of those name the clause they rest on. */
  withClause: number;
  reviewState: ReviewState;
  /** Days until review; negative when passed. Null when there is no date. */
  reviewInDays: number | null;
  /** Frozen prior versions on record. */
  frozen: number;
  /** Plain-English notes, the note's own plus the register's. */
  problems: string[];
}

export interface RegisterSummary {
  total: number;
  inForce: number;
  overdue: number;
  /** In force, and nothing in the vault declares a dependency on it. */
  undeclared: number;
  /** In force, never frozen — a revision will have nothing to diff against. */
  neverFrozen: number;
}

export interface Register {
  rows: RegisterRow[];
  summary: RegisterSummary;
}

export interface RegisterInput {
  policies: readonly PolicyNote[];
  /** Edges other notes declare, keyed by the policy path they point at. */
  incoming?: ReadonlyMap<string, PolicyEdge[]>;
  now: number;
  /** How near a review date has to be to count as due. */
  dueWithinDays?: number;
}

function reviewStateOf(
  reviewDue: number | null,
  now: number,
  withinDays: number,
): { state: ReviewState; inDays: number | null } {
  if (reviewDue === null) return { state: "unset", inDays: null };
  const inDays = Math.round((reviewDue - now) / DAY_MS);
  if (reviewDue < now) return { state: "overdue", inDays };
  if (inDays <= withinDays) return { state: "due-soon", inDays };
  return { state: "scheduled", inDays };
}

const STATE_ORDER: Record<ReviewState, number> = {
  overdue: 0,
  "due-soon": 1,
  unset: 2,
  scheduled: 3,
};

export function buildRegister(input: RegisterInput): Register {
  const withinDays = input.dueWithinDays ?? 60;

  const rows: RegisterRow[] = input.policies.map((policy) => {
    const edges = collectEdges(policy, input.incoming?.get(policy.path) ?? []);
    const { state, inDays } = reviewStateOf(policy.reviewDue, input.now, withinDays);
    const problems = [...policy.problems];

    if (policy.status === "current" && edges.length === 0) {
      problems.push(
        "Nothing declares a dependency on this policy, so revising it will produce an empty impact map. Add `governs:` here, or `derives_from:` on whatever rests on it.",
      );
    }
    if (policy.status === "current" && policy.revisions.length === 0) {
      problems.push(
        "No prior version has been frozen, so the first revision will have nothing to diff against. “Freeze the current version” takes a baseline.",
      );
    }
    if (policy.status === "" ) {
      problems.push("No `status`, so the register cannot say whether this is in force.");
    }

    return {
      policy,
      edges,
      withClause: edges.filter((edge) => edge.clause !== "").length,
      reviewState: state,
      reviewInDays: inDays,
      frozen: policy.revisions.length,
      problems,
    };
  });

  rows.sort(
    (a, b) =>
      STATE_ORDER[a.reviewState] - STATE_ORDER[b.reviewState] ||
      (a.reviewInDays ?? Infinity) - (b.reviewInDays ?? Infinity) ||
      a.policy.id.localeCompare(b.policy.id) ||
      a.policy.path.localeCompare(b.policy.path),
  );

  const inForceRows = rows.filter((row) => row.policy.status === "current");

  return {
    rows,
    summary: {
      total: rows.length,
      inForce: inForceRows.length,
      overdue: rows.filter((row) => row.reviewState === "overdue").length,
      undeclared: inForceRows.filter((row) => row.edges.length === 0).length,
      neverFrozen: inForceRows.filter((row) => row.frozen === 0).length,
    },
  };
}

/**
 * Index incoming edges by the policy they point at.
 *
 * Kept here rather than in the caller so the matching rule — id, filename,
 * path or title, per `refMatchesPolicy` — has one home.
 */
export function indexIncoming(
  policies: readonly PolicyNote[],
  edges: readonly PolicyEdge[],
  matches: (ref: string, policy: PolicyNote) => boolean,
): Map<string, PolicyEdge[]> {
  const index = new Map<string, PolicyEdge[]>();
  for (const edge of edges) {
    for (const policy of policies) {
      if (!matches(edge.ref, policy)) continue;
      const list = index.get(policy.path) ?? [];
      // Turn the edge round. As written on the declaring note it points *at*
      // the policy; on that policy's impact map the thing that depends on it
      // is the note that wrote the line, so `ref` and `label` have to name
      // the declarer or the map reads "POL-DATA-REL-02 depends on
      // POL-DATA-REL-02". Found on screen, in the first real revision.
      // Turning it round also makes a dependency declared from both ends
      // dedupe in `collectEdges`, which keys on the ref.
      const stem = edge.declaredBy.replace(/\.md$/i, "");
      list.push({
        ...edge,
        ref: `[[${stem}]]`,
        label: stem.split("/").pop() ?? stem,
      });
      index.set(policy.path, list);
    }
  }
  return index;
}
