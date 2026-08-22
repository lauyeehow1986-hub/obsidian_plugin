/**
 * Shared fixtures for the request-engine tests.
 *
 * Invented data only — no vault content ever enters this repository (rule 1).
 * Not imported by `main.ts`, so it never reaches the bundle.
 */

import { parseWorkflowSpec, type WorkflowSpec } from "./workflow";

/** Mirrors `test-vault/_config/workflows/edata-request.yaml`, as already-parsed YAML. */
export const RAW_SPEC: Record<string, unknown> = {
  id: "edata-request",
  version: 1,
  label: "eData request",
  stages: [
    { id: "intake", label: "Intake", owner: "scdb", sla_days: 2 },
    { id: "triage", label: "SCDB triage", owner: "scdb", sla_days: 3 },
    { id: "awaiting-approval", label: "Awaiting approval", owner: "approver", sla_days: 14 },
    { id: "approved", label: "Approved", owner: "scdb", sla_days: 1 },
    { id: "extraction", label: "Extraction", owner: "scdb", sla_days: 10 },
    { id: "qc", label: "QC", owner: "scdb", sla_days: 3 },
    { id: "delivered", label: "Delivered", owner: "scdb", terminal: true },
    { id: "on-hold", label: "On hold", owner: "scdb" },
    { id: "withdrawn", label: "Withdrawn", owner: "requester", terminal: true },
  ],
  transitions: [
    { from: ["intake"], to: ["triage", "withdrawn"] },
    { from: ["triage"], to: ["awaiting-approval", "on-hold", "withdrawn"] },
    { from: ["awaiting-approval"], to: ["approved", "on-hold", "withdrawn"] },
    { from: ["approved"], to: ["extraction", "on-hold"] },
    { from: ["extraction"], to: ["qc", "on-hold"] },
    { from: ["qc"], to: ["delivered", "extraction"] },
    { from: ["on-hold"], to: ["triage", "awaiting-approval", "extraction", "withdrawn"] },
  ],
  gates: [
    {
      to: "approved",
      require: ["governance.irb_ref", "governance.irb_expiry_in_future"],
      message: "Cannot approve without a current IRB/DSRB reference.",
    },
    {
      to: "extraction",
      require_any: ["governance.identifiers == none", "governance.dua_signed == true"],
      message: "Identifiable extraction requires a signed DUA.",
    },
    {
      to: "delivered",
      require: ["outputs.length > 0", "delivery_method"],
      message: "Cannot mark delivered with no recorded output.",
    },
  ],
  retired: {},
};

export function testSpec(overrides: Record<string, unknown> = {}): WorkflowSpec {
  const { spec, problems } = parseWorkflowSpec({ ...RAW_SPEC, ...overrides });
  if (!spec) throw new Error(`fixture spec is invalid: ${JSON.stringify(problems)}`);
  return spec;
}

/** A request note's frontmatter, as the metadata cache would hand it over. */
export function requestFrontmatter(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "scdb-request",
    uid: "01JZQ8MW5T3K7XBN2FHVCD9RGA",
    id: "REQ-2026-014",
    external_ref: "EDR-2026-00871",
    title: "Readmission cohort for the HF service",
    workflow: "edata-request",
    workflow_version: 1,
    stage: "awaiting-approval",
    blocked_on: "[[Dr A Tan]]",
    blocked_since: "2026-07-18",
    requester: "[[Dr A Tan]]",
    study: "[[EuroHeart]]",
    hat: "hod",
    received: "2026-07-14",
    due: "2026-08-04",
    sla_days: 21,
    priority: "normal",
    assignee: "[[Coordinator B]]",
    effort_estimate_hours: 6,
    governance: {
      identifiers: "indirect",
      irb_ref: "DSRB-2026-0142",
      irb_expiry: "2027-03-31",
      pdpa_basis: "research-exemption",
      dua: { status: "pending" },
    },
    evidence: [],
    outputs: [],
    history: [
      { at: "2026-07-14", to: "intake", by: "yh" },
      { at: "2026-07-16", to: "triage", by: "yh" },
      { at: "2026-07-18", to: "awaiting-approval", by: "yh", blocked_on: "[[Dr A Tan]]" },
    ],
    ...overrides,
  };
}

/** Fixed "now" for deterministic dwell maths: 2026-07-28, local noon. */
export const NOW = new Date(2026, 6, 28, 12, 0).getTime();
