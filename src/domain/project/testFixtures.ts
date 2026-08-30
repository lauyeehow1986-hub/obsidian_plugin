/**
 * Shared fixtures for the project tests.
 *
 * Invented data only — no vault content ever enters this repository (rule 1).
 * Not imported by `main.ts`, so it never reaches the bundle.
 */

import { parseWorkflowSpec, type WorkflowSpec } from "../request/workflow";

/** Mirrors `test-vault/_config/workflows/project.yaml`, as already-parsed YAML. */
export const RAW_PROJECT_SPEC: Record<string, unknown> = {
  id: "project",
  version: 1,
  label: "Project",
  stages: [
    { id: "scoping", label: "Scoping", owner: "owner", sla_days: 30 },
    { id: "approval", label: "Sponsor sign-off", owner: "sponsor", sla_days: 21 },
    { id: "delivery", label: "Delivery", owner: "owner", sla_days: 180 },
    { id: "embedding", label: "Embedding", owner: "owner", sla_days: 60 },
    { id: "closed", label: "Closed", owner: "owner", terminal: true },
    { id: "paused", label: "Paused", owner: "owner" },
    { id: "abandoned", label: "Abandoned", owner: "owner", terminal: true },
  ],
  transitions: [
    { from: ["scoping"], to: ["approval", "paused", "abandoned"] },
    { from: ["approval"], to: ["delivery", "scoping", "paused", "abandoned"] },
    { from: ["delivery"], to: ["embedding", "paused", "abandoned"] },
    { from: ["embedding"], to: ["closed", "delivery", "paused"] },
    { from: ["paused"], to: ["scoping", "approval", "delivery", "embedding", "abandoned"] },
  ],
  gates: [],
  retired: {},
};

export function projectSpec(overrides: Record<string, unknown> = {}): WorkflowSpec {
  const { spec, problems } = parseWorkflowSpec({ ...RAW_PROJECT_SPEC, ...overrides });
  if (!spec) throw new Error(`fixture spec is invalid: ${JSON.stringify(problems)}`);
  return spec;
}

/** A project note's frontmatter, as the metadata cache would hand it over. */
export function projectFrontmatter(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "project",
    uid: "01JZQ8MW5T3K7XBN2FHVCD9RGB",
    id: "PRJ-2026-004",
    title: "Research data governance rollout",
    workflow: "project",
    workflow_version: 1,
    stage: "delivery",
    hat: "research-core",
    owner: "[[Owner]]",
    sponsor: "[[Prof C Lim]]",
    started: "2026-05-01",
    due: "2026-12-31",
    studies: ["[[EuroHeart]]"],
    requests: ["[[REQ-2026-014]]"],
    effort_estimate_hours: 40,
    milestones: [
      { id: "M1", title: "Baseline audit complete", due: "2026-06-30", done: "2026-06-27" },
      { id: "M2", title: "SOP approved by committee", due: "2026-09-30", blocked_by: ["M1"] },
      { id: "M3", title: "Training rolled out", due: "2026-11-30", blocked_by: ["M2"] },
    ],
    deliverables: [
      { title: "Departmental data flow map", kind: "diagram", note: "[[DIA-dataflow]]" },
    ],
    history: [
      { at: "2026-05-01", to: "scoping", by: "yh" },
      { at: "2026-06-02", to: "approval", by: "yh" },
      { at: "2026-07-01", to: "delivery", by: "yh" },
    ],
    ...overrides,
  };
}

/** Fixed "now" for deterministic maths: 2026-07-28, local noon. Matches the request fixtures. */
export const NOW = new Date(2026, 6, 28, 12, 0).getTime();
