/**
 * The forms register — every `88 Forms/` note, assessed and grouped (§7 D2).
 *
 * The question the board answers is **which of these is ready to build in
 * REDCap**, so that is what it groups by, not by status and not by study. A
 * form's own `status:` is what a person asserts about it; its verdict here is
 * what the checks found, and when the two disagree the checks are the useful
 * half. Both are shown, in that order.
 *
 * Verdicts, worst first:
 *
 *   blocked   an identifier outside the study's approved scope. Governance
 *             stops this one; nothing else does.
 *   invalid   REDCap would reject or mangle the file.
 *   questions warnings, or governance findings that ask rather than refuse.
 *   ready     nothing to say.
 *
 * `blocked` outranks `invalid` deliberately. A malformed choice list is a
 * mistake, and the person will fix it in a minute; an unapproved identifier is
 * a decision somebody has to make, and burying it under twelve formatting
 * complaints is how it gets made by accident.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { VariableNote } from "../catalogue/variable";
import type { StudyNote } from "../study/study";
import { allFields, type FormSpec } from "./form";
import { assessGovernance, type GovernanceReport } from "./governance";
import { errorsOf, validateForm, warningsOf, type Finding } from "./validate";

export const VERDICTS = ["blocked", "invalid", "questions", "ready"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  blocked: "Blocked on governance",
  invalid: "REDCap would reject this",
  questions: "Questions to answer",
  ready: "Ready",
};

export interface FormAssessment {
  spec: FormSpec;
  verdict: Verdict;
  findings: Finding[];
  governance: GovernanceReport;
  errors: Finding[];
  warnings: Finding[];
  fieldCount: number;
  identifierCount: number;
  /** True when both halves pass. The export path checks this, not the verdict. */
  exportable: boolean;
}

export function assessForm(input: {
  spec: FormSpec;
  studies: readonly StudyNote[];
  variables: readonly VariableNote[];
}): FormAssessment {
  const findings = validateForm(input.spec);
  const governance = assessGovernance({
    spec: input.spec,
    studies: input.studies,
    variables: input.variables,
  });

  const errors = errorsOf(findings);
  const warnings = warningsOf(findings);
  const fields = allFields(input.spec);

  const verdict: Verdict = !governance.exportable
    ? "blocked"
    : errors.length > 0
      ? "invalid"
      : warnings.length > 0 || governance.findings.length > 0
        ? "questions"
        : "ready";

  return {
    spec: input.spec,
    verdict,
    findings,
    governance,
    errors,
    warnings,
    fieldCount: fields.length,
    identifierCount: governance.identifiers.length,
    exportable: governance.exportable && errors.length === 0,
  };
}

export interface FormGroup {
  verdict: Verdict;
  label: string;
  forms: FormAssessment[];
}

export interface FormsSummary {
  total: number;
  fields: number;
  identifiers: number;
  blocked: number;
  invalid: number;
  ready: number;
  /** Forms whose identifiers cannot be checked against any approved scope. */
  uncheckable: number;
}

export interface FormsRegister {
  groups: FormGroup[];
  forms: FormAssessment[];
  summary: FormsSummary;
}

export function buildRegister(input: {
  specs: readonly FormSpec[];
  studies: readonly StudyNote[];
  variables: readonly VariableNote[];
}): FormsRegister {
  const forms = input.specs
    .map((spec) => assessForm({ spec, studies: input.studies, variables: input.variables }))
    .sort((a, b) => {
      const rank = VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict);
      return rank !== 0 ? rank : a.spec.id.localeCompare(b.spec.id);
    });

  const groups: FormGroup[] = [];
  for (const verdict of VERDICTS) {
    const matching = forms.filter((form) => form.verdict === verdict);
    if (matching.length > 0) {
      groups.push({ verdict, label: VERDICT_LABELS[verdict], forms: matching });
    }
  }

  return {
    groups,
    forms,
    summary: {
      total: forms.length,
      fields: forms.reduce((sum, form) => sum + form.fieldCount, 0),
      identifiers: forms.reduce((sum, form) => sum + form.identifierCount, 0),
      blocked: forms.filter((form) => form.verdict === "blocked").length,
      invalid: forms.filter((form) => form.verdict === "invalid").length,
      ready: forms.filter((form) => form.verdict === "ready").length,
      uncheckable: forms.filter((form) =>
        form.governance.findings.some((finding) => finding.kind === "unknown-scope"),
      ).length,
    },
  };
}

/** Free-text search across the things a person would actually type. */
export function searchForms(forms: readonly FormAssessment[], query: string): FormAssessment[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...forms];

  return forms.filter((form) => {
    const haystack = [
      form.spec.id,
      form.spec.title,
      form.spec.study,
      form.spec.project,
      form.spec.status,
      ...form.spec.instruments.flatMap((instrument) => [instrument.name, instrument.label]),
      ...allFields(form.spec).flatMap((field) => [field.name, field.label, field.variable]),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
