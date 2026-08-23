/**
 * Workflow specifications (CLAUDE.md §5.2).
 *
 * The eData process is a real institutional workflow whose stages, owners, SLA
 * targets and gates live in a YAML file the user edits. Nothing about the
 * stages is hardcoded here — this module turns whatever that file says into a
 * validated in-memory shape, and reports what it could not make sense of
 * rather than throwing. A spec with one bad gate should still drive the other
 * eight stages, with the problem visible in diagnostics.
 *
 * Pure module: no Obsidian, no Node. The caller parses the YAML (via Obsidian's
 * core `parseYaml`) and hands the plain object in.
 */

export interface StageSpec {
  id: string;
  label: string;
  /** Free text: `scdb`, `approver`, `requester`. Whoever the institution says. */
  owner: string;
  /** Target days in this stage, or null when the spec sets none. */
  slaDays: number | null;
  /** A terminal stage cannot be left. */
  terminal: boolean;
  /** Declaration order. Drives "sent back" detection — see `isBackwardMove`. */
  order: number;
}

export interface TransitionRule {
  from: string[];
  to: string[];
}

export interface GateSpec {
  /** The stage being entered. */
  to: string;
  /** Every atom must hold. */
  require: string[];
  /** At least one atom must hold. */
  requireAny: string[];
  /** Plain-English refusal shown to the user. */
  message: string;
}

export interface WorkflowSpec {
  id: string;
  /** Bumped on any change to stage ids; notes carry the version they were valid under. */
  version: number;
  label: string;
  stages: StageSpec[];
  transitions: TransitionRule[];
  gates: GateSpec[];
  /** Superseded stage id → current stage id, so historical `history` still resolves. */
  retired: Record<string, string>;
}

export interface SpecProblem {
  severity: "error" | "warning";
  /** Where in the spec, in prose: `stages[2]`, `gates for "approved"`. */
  at: string;
  message: string;
}

export interface ParsedWorkflowSpec {
  /** Null when the spec is too broken to drive anything. */
  spec: WorkflowSpec | null;
  problems: SpecProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim());
}

/** Turn a parsed YAML object into a validated spec. Never throws. */
export function parseWorkflowSpec(raw: unknown): ParsedWorkflowSpec {
  const problems: SpecProblem[] = [];
  const fail = (at: string, message: string) => problems.push({ severity: "error", at, message });
  const warn = (at: string, message: string) => problems.push({ severity: "warning", at, message });

  if (!isRecord(raw)) {
    fail("file", "The workflow file is empty or is not a YAML mapping.");
    return { spec: null, problems };
  }

  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  if (id === "") fail("id", "A workflow needs an `id`.");

  const rawVersion = raw["version"];
  const version = typeof rawVersion === "number" ? rawVersion : NaN;
  if (!Number.isInteger(version) || version < 1) {
    fail("version", "`version` must be a whole number of 1 or more. Bump it whenever a stage id changes.");
  }

  const label = typeof raw["label"] === "string" && raw["label"].trim() !== "" ? raw["label"].trim() : id;

  // --- stages ---------------------------------------------------------------
  const stages: StageSpec[] = [];
  const seen = new Set<string>();
  const rawStages = raw["stages"];
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    fail("stages", "A workflow needs at least one stage.");
  } else {
    rawStages.forEach((entry, index) => {
      const at = `stages[${index}]`;
      if (!isRecord(entry)) {
        fail(at, "Each stage must be a mapping with an `id`.");
        return;
      }
      const stageId = typeof entry["id"] === "string" ? entry["id"].trim() : "";
      if (stageId === "") {
        fail(at, "Stage has no `id`.");
        return;
      }
      if (seen.has(stageId)) {
        fail(at, `Duplicate stage id "${stageId}".`);
        return;
      }
      seen.add(stageId);

      const rawSla = entry["sla_days"];
      let slaDays: number | null = null;
      if (rawSla !== undefined && rawSla !== null) {
        if (typeof rawSla === "number" && Number.isFinite(rawSla) && rawSla >= 0) {
          slaDays = rawSla;
        } else {
          warn(at, `Stage "${stageId}" has an unreadable \`sla_days\`; treating it as no target.`);
        }
      }

      stages.push({
        id: stageId,
        label:
          typeof entry["label"] === "string" && entry["label"].trim() !== ""
            ? entry["label"].trim()
            : stageId,
        owner: typeof entry["owner"] === "string" ? entry["owner"].trim() : "",
        slaDays,
        terminal: entry["terminal"] === true,
        order: stages.length,
      });
    });
  }

  const known = new Set(stages.map((s) => s.id));

  // --- transitions ----------------------------------------------------------
  const transitions: TransitionRule[] = [];
  const rawTransitions = raw["transitions"];
  if (rawTransitions !== undefined && !Array.isArray(rawTransitions)) {
    fail("transitions", "`transitions` must be a list.");
  } else if (Array.isArray(rawTransitions)) {
    rawTransitions.forEach((entry, index) => {
      const at = `transitions[${index}]`;
      if (!isRecord(entry)) {
        fail(at, "Each transition must be a mapping with `from` and `to`.");
        return;
      }
      const from = asStringArray(entry["from"]);
      const to = asStringArray(entry["to"]);
      if (from.length === 0 || to.length === 0) {
        fail(at, "A transition needs at least one `from` stage and one `to` stage.");
        return;
      }
      for (const stageId of [...from, ...to]) {
        if (!known.has(stageId)) fail(at, `Unknown stage "${stageId}".`);
      }
      transitions.push({ from, to });
    });
  }

  // --- gates ----------------------------------------------------------------
  const gates: GateSpec[] = [];
  const rawGates = raw["gates"];
  if (rawGates !== undefined && !Array.isArray(rawGates)) {
    fail("gates", "`gates` must be a list.");
  } else if (Array.isArray(rawGates)) {
    rawGates.forEach((entry, index) => {
      const at = `gates[${index}]`;
      if (!isRecord(entry)) {
        fail(at, "Each gate must be a mapping with a `to` stage.");
        return;
      }
      const to = typeof entry["to"] === "string" ? entry["to"].trim() : "";
      if (to === "") {
        fail(at, "Gate has no `to` stage.");
        return;
      }
      if (!known.has(to)) fail(at, `Gate guards unknown stage "${to}".`);

      const require = asStringArray(entry["require"]);
      const requireAny = asStringArray(entry["require_any"]);
      if (require.length === 0 && requireAny.length === 0) {
        // A gate that requires nothing is almost certainly a typo, and a
        // governance control that silently passes is the worst kind.
        fail(at, `Gate on "${to}" requires nothing. Give it \`require\` or \`require_any\`.`);
        return;
      }
      gates.push({
        to,
        require,
        requireAny,
        message:
          typeof entry["message"] === "string" && entry["message"].trim() !== ""
            ? entry["message"].trim()
            : `Governance gate on "${to}" is not satisfied.`,
      });
    });
  }

  // --- retired --------------------------------------------------------------
  const retired: Record<string, string> = {};
  const rawRetired = raw["retired"];
  if (rawRetired !== undefined && rawRetired !== null) {
    if (!isRecord(rawRetired)) {
      fail("retired", "`retired` must be a mapping of old stage id to current stage id.");
    } else {
      for (const [oldId, target] of Object.entries(rawRetired)) {
        if (typeof target !== "string" || target.trim() === "") {
          fail("retired", `Retired stage "${oldId}" has no replacement stage.`);
          continue;
        }
        if (!known.has(target.trim())) {
          fail("retired", `Retired stage "${oldId}" maps to unknown stage "${target}".`);
          continue;
        }
        if (known.has(oldId)) {
          fail("retired", `"${oldId}" is listed as both a live stage and a retired one.`);
          continue;
        }
        retired[oldId] = target.trim();
      }
    }
  }

  // --- advisory -------------------------------------------------------------
  if (stages.length > 0 && transitions.length === 0) {
    warn(
      "transitions",
      "No transitions are declared, so every stage can move to every other stage.",
    );
  }
  for (const stage of stages) {
    if (stage.terminal && transitions.some((t) => t.from.includes(stage.id))) {
      warn(
        "transitions",
        `Stage "${stage.id}" is terminal but has outgoing transitions; the terminal flag wins and they will never fire.`,
      );
    }
    if (!stage.terminal && stage.slaDays === null) {
      warn("stages", `Stage "${stage.id}" has no \`sla_days\`, so nothing in it can breach.`);
    }
  }

  if (problems.some((p) => p.severity === "error")) {
    return { spec: null, problems };
  }

  return {
    spec: { id, version, label, stages, transitions, gates, retired },
    problems,
  };
}

/** Look up a stage, following `retired:` so historical entries still resolve. */
export function resolveStage(spec: WorkflowSpec, stageId: string): StageSpec | null {
  const direct = spec.stages.find((s) => s.id === stageId);
  if (direct) return direct;
  const mapped = spec.retired[stageId];
  return mapped ? (spec.stages.find((s) => s.id === mapped) ?? null) : null;
}

/**
 * The label to print for a stage id, for a board or a chart.
 *
 * Deliberately does **not** follow `retired:`. A request sitting in a stage the
 * spec has dropped is *humanised, not resolved*: `pending-approval` prints as
 * "Pending approval", never as "Awaiting approval". Printing the successor's
 * label would show two different stages under one name and hide the fact that a
 * note needs migrating.
 *
 * Humanising is presentation only, and it costs nothing that was load-bearing.
 * The signal that a note is stranded is carried explicitly — the migration
 * board, the "migrate" chip on a cockpit card, the "not in v2" marker on the
 * health table (§5.2) — not by leaving a slug on screen and trusting the reader
 * to notice a hyphen. A dropped stage still reads as a stage nobody declared,
 * because its name is not one of the declared ones.
 */
export function stageLabelOf(spec: WorkflowSpec | null, stageId: string): string {
  const declared = spec?.stages.find((stage) => stage.id === stageId);
  return declared ? declared.label : humaniseStageId(stageId);
}

/**
 * `pending-approval` → "Pending approval".
 *
 * Sentence case, not title case, because the declared labels are sentence case
 * ("SCDB triage", "Awaiting approval"); a fallback in Title Case would read as a
 * different kind of thing sitting in the same column. An id that humanises to
 * nothing (empty, or punctuation only) is returned untouched — a blank cell
 * would be worse than an ugly one.
 */
export function humaniseStageId(stageId: string): string {
  const words = stageId.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (words === "") return stageId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when the spec knows this stage id, live or retired. */
export function isKnownStage(spec: WorkflowSpec, stageId: string): boolean {
  return resolveStage(spec, stageId) !== null;
}

/**
 * Is `from → to` permitted by the declared transitions?
 *
 * When no rule mentions `from`, the move is **unconstrained and allowed**.
 * Defaulting to deny would freeze every stage the user has not written a rule
 * for — including all of them, since `transitions:` is optional. The parser
 * warns when the list is empty so this is visible rather than surprising.
 */
export function isTransitionDeclared(spec: WorkflowSpec, from: string, to: string): boolean {
  const rules = spec.transitions.filter((t) => t.from.includes(from));
  if (rules.length === 0) return true;
  return rules.some((t) => t.to.includes(to));
}

/** The stages reachable from `from`, for building the UI's stage picker. */
export function allowedTargets(spec: WorkflowSpec, from: string): StageSpec[] {
  const current = resolveStage(spec, from);
  if (current?.terminal) return [];
  return spec.stages.filter((s) => s.id !== from && isTransitionDeclared(spec, from, s.id));
}

/**
 * A move to an earlier stage in declaration order — "sent back". This is the
 * rework signal that a bounce count measures (§5.1): a request returned twice
 * looks fresh on current dwell alone.
 */
export function isBackwardMove(spec: WorkflowSpec, from: string, to: string): boolean {
  const a = resolveStage(spec, from);
  const b = resolveStage(spec, to);
  if (!a || !b) return false;
  return b.order < a.order;
}
