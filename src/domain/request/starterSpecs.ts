/**
 * The workflow specs a fresh vault starts with (CLAUDE.md §5.2, §5.15).
 *
 * **Why these ship in the bundle at all.** The engine is stage-agnostic by
 * design: it reads `_config/workflows/*.yaml` and has no opinion about what a
 * stage is called. That is the right architecture and it had one consequence
 * nobody noticed until the plugin met a real vault — with no spec file present,
 * *every* request feature is dead. "New request" refuses, no stage can change,
 * and the diagnostics report says only that zero specs loaded. The vault
 * contract is documented prose, so the first user has to author YAML from the
 * documentation before the core of the product does anything at all.
 *
 * So the placeholders travel with the plugin. They are written **only when
 * asked** — never on load, never on install — because a plugin that writes
 * config into a vault unbidden is the surprise rule 12 forbids, and because
 * an existing spec must never be overwritten (rule 8).
 *
 * **They stay placeholders, loudly.** §5.2 forbids quietly inventing stages to
 * make a feature work, and shipping these must not become a way to do that by
 * the back door. Each file opens with a header saying the names are invented
 * and must be replaced, so the copy in the vault carries the warning the
 * documentation carries — the person who finds this file six months from now
 * reads it there, not in CLAUDE.md. The real eData stages are still an open
 * question in §11 and nothing here answers it.
 */

/** A spec file as it would be written into `<config>/workflows/`. */
export interface StarterSpec {
  /** Filename within the workflows folder. */
  name: string;
  yaml: string;
}

const EDATA_REQUEST = `# PLACEHOLDER workflow — the stage names below are INVENTED (CLAUDE.md §5.2).
#
# They exist so the engine has something to drive on a new vault. They are not
# a claim about how any real request process runs. Replace them with the real
# stage names, owning parties, gates and target durations before real use.
#
# Changing this file is a migration, not an edit: bump \`version\`, then run
# "Migrate requests to the current workflow version" to move the in-flight
# notes across. Keep any renamed stage id under \`retired:\` with its mapping so
# dwell-time maths over past history still resolves.

id: edata-request
version: 1
label: eData request

stages:
  - { id: intake,            label: Intake,             owner: scdb,      sla_days: 2 }
  - { id: triage,            label: SCDB triage,        owner: scdb,      sla_days: 3 }
  - { id: awaiting-approval, label: Awaiting approval,  owner: approver,  sla_days: 14 }
  - { id: approved,          label: Approved,           owner: scdb,      sla_days: 1 }
  - { id: extraction,        label: Extraction,         owner: scdb,      sla_days: 10 }
  - { id: qc,                label: QC,                 owner: scdb,      sla_days: 3 }
  - { id: delivered,         label: Delivered,          owner: scdb,      terminal: true }
  - { id: on-hold,           label: On hold,            owner: scdb,      parked: true }
  - { id: withdrawn,         label: Withdrawn,          owner: requester, terminal: true }

transitions:
  - { from: [intake],            to: [triage, withdrawn] }
  - { from: [triage],            to: [awaiting-approval, on-hold, withdrawn] }
  - { from: [awaiting-approval], to: [approved, on-hold, withdrawn] }
  - { from: [approved],          to: [extraction, on-hold] }
  - { from: [extraction],        to: [qc, on-hold] }
  - { from: [qc],                to: [delivered, extraction] }
  - { from: [on-hold],           to: [triage, awaiting-approval, extraction, withdrawn] }

# Governance gates are the point (§5.2): they are what turn a task tracker into
# a research-data-governance instrument. A refused transition gives a reason.
# Adding or changing one is a deliberate, documented decision.
gates:
  - to: approved
    require: [governance.irb_ref, governance.irb_expiry_in_future]
    message: Cannot approve without a current IRB/DSRB reference.
  - to: extraction
    require_any: ["governance.identifiers == none", "governance.dua_signed == true"]
    message: Identifiable extraction requires a signed DUA.
  - to: delivered
    require: ["outputs.length > 0", "delivery_method"]
    message: Cannot mark delivered without a recorded output and a delivery method.

retired: {}
`;

const PROJECT = `# PLACEHOLDER workflow for \`type: project\` notes (CLAUDE.md §5.15, §7 B8).
#
# On exactly the same footing as the stages in \`edata-request.yaml\`: invented,
# present so the portfolio board has something to show, and to be replaced with
# the stages your real projects actually pass through.
#
# Note what is *not* here: no gates. A governance gate guards the release of
# data, which is a request concern. Whether a project stage needs one at all is
# an open question in CLAUDE.md §11, and inventing one to fill the space would
# be the placeholder mistake §5.2 warns about.

id: project
applies_to: project
version: 1
label: Project

stages:
  - { id: scoping,   label: Scoping,          owner: owner,   sla_days: 30 }
  - { id: approval,  label: Sponsor sign-off, owner: sponsor, sla_days: 21 }
  - { id: delivery,  label: Delivery,         owner: owner,   sla_days: 180 }
  - { id: embedding, label: Embedding,        owner: owner,   sla_days: 60 }
  - { id: closed,    label: Closed,           owner: owner,   terminal: true }
  - { id: paused,    label: Paused,           owner: owner,   parked: true }
  - { id: abandoned, label: Abandoned,        owner: owner,   terminal: true }

transitions:
  - { from: [scoping],   to: [approval, paused, abandoned] }
  - { from: [approval],  to: [delivery, scoping, paused, abandoned] }
  - { from: [delivery],  to: [embedding, paused, abandoned] }
  - { from: [embedding], to: [closed, delivery, paused] }
  - { from: [paused],    to: [scoping, approval, delivery, embedding, abandoned] }

gates: []
retired: {}
`;

/**
 * The starter specs, in the order they should be offered.
 *
 * A function rather than a frozen array so a caller cannot mutate the shipped
 * text of one and have every later caller see the change.
 */
export function starterSpecs(): StarterSpec[] {
  return [
    { name: "edata-request.yaml", yaml: EDATA_REQUEST },
    { name: "project.yaml", yaml: PROJECT },
  ];
}

/** One starter spec resolved against a folder, ready to write. */
export interface PlannedSpec extends StarterSpec {
  path: string;
}

export interface StarterPlan {
  /** Files to create, in order. */
  create: PlannedSpec[];
  /** Paths already present, which must be left exactly as they are. */
  keep: string[];
}

/**
 * Decide what an install would write, without writing anything.
 *
 * Pure so the **never-overwrite** rule is testable. That rule is not a nicety:
 * a spec file holds the real stage names and every governance gate, so
 * replacing an edited one with a placeholder would discard the institution's
 * process and silently re-open every gate the user had tightened (rule 8).
 * A guarantee that lives only inside a vault-writing method is a guarantee
 * nothing can check.
 *
 * `existingPaths` is whatever the vault already holds under the folder; the
 * comparison is on the full path, so a spec of the same name elsewhere is not
 * mistaken for this one.
 */
export function planStarterInstall(
  folder: string,
  existingPaths: readonly string[],
): StarterPlan {
  const present = new Set(existingPaths);
  const plan: StarterPlan = { create: [], keep: [] };

  for (const starter of starterSpecs()) {
    const path = `${folder}/${starter.name}`;
    if (present.has(path)) plan.keep.push(path);
    else plan.create.push({ ...starter, path });
  }
  return plan;
}
