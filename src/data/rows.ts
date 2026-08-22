/**
 * Turning indexed notes into query rows (§7 A2).
 *
 * Requests have a **declared** catalogue (`domain/request/queryFields.ts`),
 * because their interesting fields are computed and no amount of looking at
 * frontmatter would reveal `dwell` or `bounces`. Every other type gets one
 * **inferred** by `domain/query/infer.ts`. Declared always wins.
 */

import { flattenFrontmatter, inferFields } from "../domain/query/infer";
import type { FieldDef, Row } from "../domain/query/model";
import { requestMetrics } from "../domain/request/dwell";
import { REQUEST_FIELDS, requestRow } from "../domain/request/queryFields";
import type { NoteIndex } from "./noteIndex";
import { REQUEST_TYPE, type RequestIndex } from "./requestIndex";
import type { WorkflowStore } from "./workflowStore";

/** Types whose fields we declare rather than infer. */
const DECLARED: Record<string, readonly FieldDef[]> = {
  [REQUEST_TYPE]: REQUEST_FIELDS,
};

/* ----------------------------------------------------------------- rows -- */

export interface RowSourceDeps {
  notes: NoteIndex;
  requests: RequestIndex;
  workflows: WorkflowStore;
}

/**
 * Rows for a set of types, or for everything when `types` is empty.
 *
 * Request rows come from the projection so dwell is computed once per note per
 * query — never cached, per §5.1, because a cached dwell time is a dwell time
 * that is wrong by tomorrow.
 */
export function buildRows(deps: RowSourceDeps, types: readonly string[], now: number): Row[] {
  const wanted = types.length === 0 ? null : new Set(types);
  const rows: Row[] = [];

  for (const entry of deps.notes.all()) {
    if (wanted && !wanted.has(entry.type)) continue;

    if (entry.type === REQUEST_TYPE) {
      const request = deps.requests.byPath(entry.file.path);
      if (!request) continue;
      const spec = deps.workflows.forRequest(request.request.workflow);
      rows.push(
        requestRow({
          key: entry.file.path,
          request: request.request,
          metrics: requestMetrics(request.request, spec, { now }),
          spec,
          problems: request.problems,
          now,
        }),
      );
      continue;
    }

    rows.push({
      key: entry.file.path,
      type: entry.type,
      fields: flattenFrontmatter(entry.frontmatter),
    });
  }

  return rows;
}

/**
 * The field catalogue for a set of types.
 *
 * Querying several types at once unions their catalogues, with the declared
 * definition winning on any id they share — a `stage` on a request means the
 * workflow stage, whatever a publication happens to call its own.
 */
export function catalogueFor(deps: RowSourceDeps, types: readonly string[]): FieldDef[] {
  const present = types.length === 0 ? deps.notes.types().map((entry) => entry.type) : types;
  const byId = new Map<string, FieldDef>();

  // Declared types first, so they claim their ids and keep their order — the
  // first few request fields are the default columns of an unconfigured table.
  for (const type of present) {
    for (const field of DECLARED[type] ?? []) byId.set(field.id, field);
  }
  for (const type of present) {
    if (type in DECLARED) continue;
    const frontmatters = deps.notes.byType(type).map((entry) => entry.frontmatter);
    for (const field of inferFields(frontmatters)) {
      if (!byId.has(field.id)) byId.set(field.id, field);
    }
  }

  return [...byId.values()];
}

/** True when this type's fields are declared rather than guessed. */
export function isDeclaredType(type: string): boolean {
  return type in DECLARED;
}
