/**
 * Diagrams drawn from data the vault already holds (§7 D1).
 *
 * This is the module that makes a diagram builder worth having. draw.io is
 * better at drawing boxes than this will ever be; what it cannot do is draw the
 * process you actually run, from the spec that governs it, or the path one
 * request actually took, from its own history. A hand-drawn lifecycle diagram
 * is out of date the day the workflow spec changes and nobody notices. A
 * generated one is re-runnable, and carries `generated_from` so a stale copy is
 * detectable rather than merely wrong.
 *
 * Three generators, each answering a question somebody actually asks:
 *
 *  - `workflowDiagram` — "what is the process?" Drawn from the spec, so it is
 *    the process as configured, not as remembered.
 *  - `requestPathDiagram` — "what happened to this one?" Drawn from `history`,
 *    including the bounces, which is the part a tidy lifecycle diagram hides.
 *  - `dataFlowDiagram` — "where does the data go?" The picture a governance
 *    submission asks for, built from the request's own governance fields.
 *
 * Pure module: no Obsidian, no Node.
 */

import { formatDuration } from "../time/dates";
import type { RequestNote } from "../request/request";
import { effectiveHistory, stageSegments } from "../request/dwell";
import {
  isBackwardMove,
  resolveStage,
  stageLabelOf,
  type WorkflowSpec,
} from "../request/workflow";
import {
  emptyDiagram,
  slugId,
  type DiagramEdge,
  type DiagramNode,
  type DiagramSpec,
  type DiagramState,
} from "./diagram";

/** `YYYY-MM-DD` for the `generated_at` stamp. */
function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The process as the spec describes it.
 *
 * Edges come from `transitions` where the spec declares them. Where a stage
 * declares none, the spec's own rule is that anything goes (`isTransitionDeclared`
 * returns true for an unconstrained stage) — and drawing an arrow from that
 * stage to all eleven others produces a hairball, not a diagram. So an
 * unconstrained stage gets one arrow to the next stage in declaration order,
 * drawn dotted and labelled, saying plainly that the spec does not constrain it.
 * Inventing a constraint the spec does not state would be exactly the quiet
 * invention §5.2 forbids; saying "unconstrained" out loud is not.
 */
export function workflowDiagram(spec: WorkflowSpec, at: number): DiagramSpec {
  const nodes: DiagramNode[] = spec.stages.map((stage) => ({
    id: stage.id,
    label:
      stage.slaDays === null
        ? `${stage.label} (${stage.owner || "unowned"})`
        : `${stage.label} (${stage.owner || "unowned"}, ${stage.slaDays}d)`,
    shape: stage.terminal ? "stadium" : "box",
    // Terminal wins over gated. A gate on the way into `delivered` is real and
    // is carried on the arrow and in the note, but a diagram whose end state
    // reads as "blocked" tells the wrong story at a glance.
    state: stage.terminal ? "done" : gatedStages(spec).has(stage.id) ? "blocked" : "none",
    note: gateNoteFor(spec, stage.id),
  }));

  const known = new Set(spec.stages.map((stage) => stage.id));
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: DiagramEdge) => {
    const key = `${edge.from}>${edge.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const rule of spec.transitions) {
    for (const from of rule.from) {
      if (!known.has(from)) continue;
      for (const to of rule.to) {
        if (!known.has(to) || to === from) continue;
        push({
          from,
          to,
          label: gatedStages(spec).has(to) ? "gate" : "",
          style: isBackwardMove(spec, from, to) ? "dotted" : "solid",
        });
      }
    }
  }

  const constrained = new Set(spec.transitions.flatMap((rule) => rule.from));
  for (const [index, stage] of spec.stages.entries()) {
    if (stage.terminal || constrained.has(stage.id)) continue;
    const next = spec.stages[index + 1];
    if (next === undefined) continue;
    push({ from: stage.id, to: next.id, label: "unconstrained", style: "dotted" });
  }

  return {
    ...emptyDiagram(`${spec.label || spec.id} lifecycle`),
    direction: "TD",
    nodes,
    edges,
    source: "workflow",
    generatedFrom: `${spec.id}@${spec.version}`,
    generatedAt: stamp(at),
  };
}

/** Stages a gate guards the entry to. */
function gatedStages(spec: WorkflowSpec): Set<string> {
  return new Set(spec.gates.map((gate) => gate.to));
}

function gateNoteFor(spec: WorkflowSpec, stageId: string): string {
  return spec.gates
    .filter((gate) => gate.to === stageId)
    .map((gate) => gate.message || `requires ${[...gate.require, ...gate.requireAny].join(", ")}`)
    .join(" ");
}

/**
 * The path one request actually took.
 *
 * Deliberately not the lifecycle with a highlight on it. §5.1 asks for current
 * dwell, cumulative age **and bounce count** together, because a request sent
 * back twice looks fresh on current dwell alone. So repeated visits to a stage
 * are drawn as repeated arrows into the same box, each labelled with what the
 * previous stage cost — and a move backwards in declaration order is drawn
 * dotted, so the rework is visible at a glance rather than countable only by
 * reading the labels.
 *
 * Migration relabels are folded away first (`effectiveHistory`): renaming a
 * stage is not a journey the request took, and drawing it as one would put a
 * fictional step in a governance picture.
 */
export function requestPathDiagram(
  request: RequestNote,
  spec: WorkflowSpec | null,
  now: number,
): DiagramSpec {
  const history = effectiveHistory(request.history);
  const segments = stageSegments(request, spec, now);
  const base = emptyDiagram(`${request.id || request.uid}: what actually happened`);

  if (history.length === 0) {
    return {
      ...base,
      direction: "LR",
      nodes: [
        {
          id: "no_history",
          label: "No history recorded on this request",
          shape: "round",
          state: "at-risk",
          note: "",
        },
      ],
      edges: [],
      source: "request-path",
      generatedFrom: request.id || request.uid,
      generatedAt: stamp(now),
    };
  }

  const nodes: DiagramNode[] = [];
  const byStage = new Map<string, DiagramNode>();
  const visits = new Map<string, number>();
  for (const entry of history) {
    visits.set(entry.to, (visits.get(entry.to) ?? 0) + 1);
    if (byStage.has(entry.to)) continue;
    const node: DiagramNode = {
      id: entry.to,
      label: stageLabelOf(spec, entry.to),
      shape: (spec ? resolveStage(spec, entry.to)?.terminal : false) ? "stadium" : "box",
      state: "none",
      note: "",
    };
    byStage.set(entry.to, node);
    nodes.push(node);
  }

  // The stage it is sitting in now, and how long it has been there, is the
  // whole question the board asks. Mark it, and say how many times it landed
  // there if it landed there more than once.
  const current = history[history.length - 1]!;
  const currentNode = byStage.get(current.to);
  const currentVisits = visits.get(current.to) ?? 1;
  if (currentNode !== undefined) {
    const open = segments[segments.length - 1];
    const dwell = open !== undefined && open.open ? formatDuration(open.ms) : "";
    const terminal = spec ? (resolveStage(spec, current.to)?.terminal ?? false) : false;
    currentNode.state = terminal ? "done" : "at-risk";
    currentNode.label = terminal
      ? `${currentNode.label} - here now`
      : `${currentNode.label} - here now${dwell === "" ? "" : `, ${dwell}`}`;
    if (currentVisits > 1) currentNode.label += `, visit ${currentVisits}`;
  }

  const edges: DiagramEdge[] = [];
  for (let i = 1; i < history.length; i++) {
    const from = history[i - 1]!;
    const to = history[i]!;
    const spent = segments[i - 1];
    const backward = spec !== null && isBackwardMove(spec, from.to, to.to);
    edges.push({
      from: from.to,
      to: to.to,
      label: spent === undefined ? "" : `${formatDuration(spent.ms)}${backward ? ", sent back" : ""}`,
      style: backward ? "dotted" : "solid",
    });
  }

  const bounces = edges.filter((edge) => edge.style === "dotted").length;
  return {
    ...base,
    title:
      bounces === 0
        ? base.title
        : `${base.title} (${bounces} bounce${bounces === 1 ? "" : "s"})`,
    direction: "LR",
    nodes,
    edges,
    source: "request-path",
    generatedFrom: request.id || request.uid,
    generatedAt: stamp(now),
  };
}

/**
 * Where the data comes from, what happens to it, and who ends up holding it.
 *
 * The picture a governance submission or a DSRB query asks for, built only from
 * fields the request already carries. Two rules shape it:
 *
 *  - **Nothing clinical goes in.** §5.11 rule 5 keeps identifiers out of
 *    composed URIs for the same reason they stay out of here: a diagram is a
 *    file that travels, and this one is destined for a slide. Node labels carry
 *    the request id, the study, counts, year ranges and governance instrument
 *    states — never a name, a record id or a variable value.
 *  - **An unmet control is drawn, not omitted.** A missing DUA on an
 *    identifiable extraction is the single most important thing on the page, so
 *    it appears as a red box saying so. A data-flow diagram that quietly leaves
 *    out the control nobody obtained is worse than no diagram.
 */
export function dataFlowDiagram(request: RequestNote, now: number): DiagramSpec {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const taken = new Set<string>();
  const add = (label: string, shape: DiagramNode["shape"], state: DiagramState, note = "") => {
    const id = slugId(label, taken);
    taken.add(id);
    nodes.push({ id, label, shape, state, note });
    return id;
  };

  const governance = isRecord(request.raw["governance"]) ? request.raw["governance"] : {};
  const identifiers = str(governance["identifiers"]) || "not stated";
  const scope = isRecord(request.raw["data_scope"]) ? request.raw["data_scope"] : {};
  const years = Array.isArray(scope["years"]) ? scope["years"].map(String).join("–") : "";
  const records = scope["n_records_est"];

  const source = add(
    `SCDB collection${years === "" ? "" : `, ${years}`}`,
    "cylinder",
    "none",
    "The facility's own held data.",
  );
  const extraction = add(
    typeof records === "number"
      ? `Extraction: ${request.id || "this request"}, ~${records} records`
      : `Extraction: ${request.id || "this request"}`,
    "box",
    "none",
  );
  const identifierState: DiagramState =
    identifiers === "none" ? "on-track" : identifiers === "direct" ? "overdue" : "at-risk";
  const scoping = add(
    `Identifiers: ${identifiers}`,
    "diamond",
    identifierState,
    "governance.identifiers",
  );
  const recipient = add(
    `Recipient: ${displayName(request.requester) || "not stated"}`,
    "round",
    "none",
  );

  edges.push({ from: source, to: extraction, label: "", style: "solid" });
  edges.push({ from: extraction, to: scoping, label: "", style: "solid" });

  // Every governance instrument on the note, each as its own control on the
  // arrow out to the recipient. Unmet ones are red and say what is missing.
  const instruments: { id: string; unmet: boolean }[] = [];
  for (const [name, value] of Object.entries(governance)) {
    if (!isRecord(value)) continue;
    const status = str(value["status"]) || "not stated";
    const met = status === "signed" || status === "waived" || status === "not-required";
    instruments.push({
      id: add(
        `${humanise(name)}: ${status}`,
        "subroutine",
        met ? "on-track" : "overdue",
        met ? "" : "Not satisfied.",
      ),
      unmet: !met,
    });
  }
  const irbRef = str(governance["irb_ref"]);
  if (irbRef !== "") {
    instruments.push({ id: add(`IRB/DSRB: ${irbRef}`, "subroutine", "on-track"), unmet: false });
  }

  if (instruments.length === 0) {
    const none = add("No governance instrument recorded", "subroutine", "overdue");
    instruments.push({ id: none, unmet: true });
  }

  for (const instrument of instruments) {
    edges.push({ from: scoping, to: instrument.id, label: "", style: "solid" });
    edges.push({
      from: instrument.id,
      to: recipient,
      label: instrument.unmet ? "blocked" : "",
      style: instrument.unmet ? "dotted" : "solid",
    });
  }

  const outputs = Array.isArray(request.raw["outputs"]) ? request.raw["outputs"].length : 0;
  if (outputs > 0) {
    const delivered = add(`Delivered: ${outputs} output${outputs === 1 ? "" : "s"}`, "stadium", "done");
    edges.push({ from: recipient, to: delivered, label: "", style: "solid" });
  }

  return {
    ...emptyDiagram(`${request.id || request.uid}: data flow`),
    direction: "LR",
    nodes,
    edges,
    source: "data-flow",
    generatedFrom: request.id || request.uid,
    generatedAt: stamp(now),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `pdpa_basis` reads as "Pdpa basis" — good enough for a box, and honest. */
function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `[[Dr A Tan]]` is a link in a note and a name in a box. */
function displayName(value: string): string {
  const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(value.trim());
  return (match ? (match[2] ?? match[1] ?? "") : value).trim();
}
