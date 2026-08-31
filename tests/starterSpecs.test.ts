/**
 * The shipped starter specs have to be *usable*, not merely present.
 *
 * This exists because of a real failure: the plugin reached a fresh vault on
 * the work laptop with no `_config/workflows/` at all, so "New request" refused
 * and the whole request engine — the v1 core — was dead on arrival. Shipping a
 * spec fixes that only if the YAML in the bundle actually parses into a spec
 * the engine accepts, and the only way to know is to run it through the same
 * parser the vault path uses.
 *
 * A spec that parses with problems would be worse than none: the plugin would
 * write a file, report success, and still refuse every transition.
 */

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { planStarterInstall, starterSpecs } from "../src/domain/request/starterSpecs";
import { DEFAULT_APPLIES_TO, parseWorkflowSpec } from "../src/domain/request/workflow";

const specs = starterSpecs();

describe("the workflow specs a fresh vault starts with", () => {
  it("ships one for requests and one for projects", () => {
    expect(specs.map((s) => s.name)).toEqual(["edata-request.yaml", "project.yaml"]);
  });

  for (const starter of specs) {
    describe(starter.name, () => {
      const parsed = parseWorkflowSpec(load(starter.yaml));

      it("parses into a usable spec with no problems at all", () => {
        // Not "no errors" — no problems. A warning on a file we shipped is a
        // warning we chose to ship, and the reader cannot tell that from one
        // they caused themselves.
        expect(parsed.problems).toEqual([]);
        expect(parsed.spec).not.toBeNull();
      });

      it("says on its face that the stage names are invented (§5.2)", () => {
        // The vault copy has to carry the warning, because that is the file
        // somebody reads six months from now — not CLAUDE.md.
        expect(starter.yaml).toMatch(/PLACEHOLDER/);
        expect(starter.yaml.toLowerCase()).toMatch(/replace them|same footing/);
      });

      it("can actually be moved out of its first stage", () => {
        // The failure this whole file guards against is a spec that loads and
        // then refuses everything. A first stage with no way out would be
        // exactly that, and it would look fine in the diagnostics report.
        const spec = parsed.spec!;
        const first = spec.stages[0]!;
        const onward = spec.transitions.filter((t) => t.from.includes(first.id));
        expect(onward.length, `${first.id} has nowhere to go`).toBeGreaterThan(0);
      });

      it("names only real stages in its transitions and gates", () => {
        const spec = parsed.spec!;
        const ids = new Set(spec.stages.map((s) => s.id));
        for (const transition of spec.transitions) {
          for (const id of [...transition.from, ...transition.to]) {
            expect(ids, `transition names unknown stage ${id}`).toContain(id);
          }
        }
        for (const gate of spec.gates) {
          expect(ids, `gate names unknown stage ${gate.to}`).toContain(gate.to);
        }
      });

      it("has at least one terminal stage, so work can finish", () => {
        expect(parsed.spec!.stages.some((s) => s.terminal)).toBe(true);
      });
    });
  }

  it("keeps the request gates, because they are the point (§5.2)", () => {
    const request = parseWorkflowSpec(load(specs[0]!.yaml)).spec!;
    expect(request.gates.length).toBeGreaterThan(0);
    // Every gate must explain itself: a refusal with no reason is the failure
    // the whole governance argument rests on avoiding.
    for (const gate of request.gates) expect(gate.message).not.toBe("");
  });

  it("declares no gates on the project spec, and does not invent one", () => {
    // §11 asks whether a project stage needs a gate at all. Filling the space
    // to look complete is the placeholder mistake §5.2 warns about.
    expect(parseWorkflowSpec(load(specs[1]!.yaml)).spec!.gates).toEqual([]);
  });

  it("hands out a fresh copy each call, so one caller cannot edit the bundle", () => {
    const first = starterSpecs();
    first[0]!.yaml = "clobbered";
    expect(starterSpecs()[0]!.yaml).not.toBe("clobbered");
  });
});

describe("planning an install against a vault that may already have specs", () => {
  const FOLDER = "_config/workflows";

  it("writes both into an empty folder", () => {
    const plan = planStarterInstall(FOLDER, []);
    expect(plan.create.map((s) => s.path)).toEqual([
      "_config/workflows/edata-request.yaml",
      "_config/workflows/project.yaml",
    ]);
    expect(plan.keep).toEqual([]);
  });

  it("never overwrites an existing spec (rule 8)", () => {
    // The one that matters. A spec holds the real stage names and every gate;
    // replacing an edited one with a placeholder would discard the process and
    // silently re-open every gate the user had tightened.
    const plan = planStarterInstall(FOLDER, ["_config/workflows/edata-request.yaml"]);
    expect(plan.keep).toEqual(["_config/workflows/edata-request.yaml"]);
    expect(plan.create.map((s) => s.name)).toEqual(["project.yaml"]);
  });

  it("does nothing at all on a vault that already has both", () => {
    const plan = planStarterInstall(FOLDER, [
      "_config/workflows/edata-request.yaml",
      "_config/workflows/project.yaml",
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.keep).toHaveLength(2);
  });

  it("matches on the full path, not the filename", () => {
    // A spec of the same name in another folder is a different file, and
    // treating it as this one would skip a write the vault actually needs.
    const plan = planStarterInstall(FOLDER, ["somewhere/else/edata-request.yaml"]);
    expect(plan.create).toHaveLength(2);
    expect(plan.keep).toEqual([]);
  });

  it("honours a renamed config folder", () => {
    const plan = planStarterInstall("cfg/flows", []);
    expect(plan.create[0]!.path).toBe("cfg/flows/edata-request.yaml");
  });

  it("carries the shipped bytes, so the writer needs no second source", () => {
    const plan = planStarterInstall(FOLDER, []);
    expect(plan.create[0]!.yaml).toBe(starterSpecs()[0]!.yaml);
  });
});

describe("which note type each spec governs (the B8 regression)", () => {
  // The bug this guards: B8 added project.yaml beside the request spec, and
  // every "the only workflow installed" lookup started returning nothing. On a
  // vault holding exactly one request workflow, intake refused with "more than
  // one workflow is installed" — true, useless, and it made the whole request
  // core unreachable. Shipping both starters would have reproduced it on the
  // first vault that ran the new command, which is how it was found.
  const parsed = specs.map((s) => parseWorkflowSpec(load(s.yaml)).spec!);

  it("has exactly one spec governing requests", () => {
    const requestSpecs = parsed.filter((s) => s.appliesTo === "scdb-request");
    expect(requestSpecs.map((s) => s.id)).toEqual(["edata-request"]);
  });

  it("has exactly one spec governing projects", () => {
    const projectSpecs = parsed.filter((s) => s.appliesTo === "project");
    expect(projectSpecs.map((s) => s.id)).toEqual(["project"]);
  });

  it("never lets two shipped specs claim the same note type", () => {
    // The general form, so a third starter cannot reintroduce the collision.
    const types = parsed.map((s) => s.appliesTo);
    expect(new Set(types).size, `duplicate applies_to among ${types.join(", ")}`).toBe(
      types.length,
    );
  });

  it("defaults a spec with no applies_to to requests, so old files keep working", () => {
    // Backwards compatibility is mandatory (§10): a spec written before this
    // field existed governs requests, which is what it always did.
    const legacy = parseWorkflowSpec(
      load("id: legacy\nversion: 1\nstages:\n  - { id: a, sla_days: 1 }\n  - { id: b, terminal: true }\ntransitions:\n  - { from: [a], to: [b] }\n"),
    ).spec!;
    expect(legacy.appliesTo).toBe(DEFAULT_APPLIES_TO);
    expect(DEFAULT_APPLIES_TO).toBe("scdb-request");
  });
});
