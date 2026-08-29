/**
 * The governance hook (§7 D2): "every field flagged as an identifier is
 * checked against the linked study's approved IRB scope, and unjustified
 * identifiers are flagged before the form ever reaches REDCap."
 *
 * This is the reason D2 is in this plugin rather than being a job for any of
 * the form builders that already exist. A data dictionary is a list of columns
 * until somebody asks which of them hold identifiable data and on whose
 * authority — and that question is answerable here, before the instrument is
 * built, because the vault already holds the study's approved scope (§5.1's
 * `governance.identifiers`) and the catalogue already holds what each variable
 * is and why it is kept (§5.8's `identifier` and `justification`).
 *
 * Four rules, and the order between them is the order of how bad they are:
 *
 *  1. **`unapproved`** — the field is flagged as an identifier and the study's
 *     approved scope is `none`. This is the only finding that blocks the
 *     export outright, because it is the only one where proceeding means
 *     building an instrument to collect something nobody approved collecting.
 *  2. **`unflagged`** — the field looks like a direct identifier by its name or
 *     label and is *not* flagged. A heuristic, and labelled as one everywhere
 *     it is shown. It is last in severity terms and first in practical value:
 *     an identifier nobody flagged is invisible to every other control here,
 *     including REDCap's own.
 *  3. **`unjustified`** — flagged, within scope, but neither the field nor the
 *     catalogue variable it collects says why it is held. §5.5's argument
 *     exactly: a bare `y` in a dictionary column is an unevidenced claim.
 *  4. **`unknown-scope`** — flagged, but the form names no study, or the study
 *     records no approved scope. **Not a pass.** Silence is not approval, the
 *     same rule C3 applies to a script with no recorded run.
 *
 * And one join back to C2: **`mismatch`**, where the field and the catalogue
 * variable it cites disagree about whether the thing is an identifier. Neither
 * is authoritative over the other — the point is that two records of the same
 * fact have drifted, and somebody has to say which is right.
 *
 * Pure module: no Obsidian, no Node.
 */

import { refMatchesVariable, type VariableNote } from "../catalogue/variable";
import { SCOPE_RANK, findStudy, type IdentifierScope, type StudyNote } from "../study/study";
import type { RedcapField } from "./field";
import type { FormSpec } from "./form";

export const GOVERNANCE_KINDS = [
  "unapproved",
  "unflagged",
  "unjustified",
  "unknown-scope",
  "mismatch",
] as const;
export type GovernanceKind = (typeof GOVERNANCE_KINDS)[number];

export const GOVERNANCE_LABELS: Record<GovernanceKind, string> = {
  unapproved: "Outside the approved scope",
  unflagged: "Looks like an identifier, not flagged",
  unjustified: "Identifier with no justification",
  "unknown-scope": "Approved scope not recorded",
  mismatch: "Disagrees with the catalogue",
};

export interface GovernanceFinding {
  kind: GovernanceKind;
  instrument: string;
  field: string;
  message: string;
  /** True only for `unapproved`: the one finding that stops an export. */
  blocking: boolean;
}

/**
 * Names and labels that mean a direct identifier in a clinical dataset.
 *
 * A heuristic, and it is only ever used to *raise* a question — never to clear
 * one, and never to set the flag itself. False positives are cheap here (a
 * field called `name_of_procedure` gets asked about once and dismissed); the
 * false negative it exists to catch is a column of NRIC numbers nobody marked,
 * which no other check in this system can see.
 *
 * Word-boundary matched, so `dob` does not fire on `dobutamine` — which is a
 * real echo variable and would otherwise be flagged on every stress protocol.
 */
const IDENTIFIER_HINTS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\b(nric|fin|passport|national[_ ]?id|identity[_ ]?card)\b/i, what: "a national identity number" },
  { pattern: /\b(mrn|hospital[_ ]?(no|num|number|id)|patient[_ ]?(id|no|number)|case[_ ]?note)\b/i, what: "a hospital record number" },
  { pattern: /\b(first|last|given|family|sur|full|patient|subject)[_ ]?name\b/i, what: "a person's name" },
  { pattern: /\bname[_ ]?(of[_ ]?)?(patient|subject|participant)\b/i, what: "a person's name" },
  { pattern: /\b(dob|date[_ ]?of[_ ]?birth|birth[_ ]?date)\b/i, what: "a date of birth" },
  { pattern: /\b(phone|mobile|telephone|contact[_ ]?(no|number))\b/i, what: "a telephone number" },
  { pattern: /\b(email|e[_ ]?mail)\b/i, what: "an email address" },
  { pattern: /\b(address|postcode|postal[_ ]?code|zip)\b/i, what: "an address" },
  { pattern: /\b(nok|next[_ ]?of[_ ]?kin)\b/i, what: "next-of-kin details" },
];

/** What the heuristic thinks this field holds, or "" when it has no opinion. */
export function identifierHint(field: RedcapField): string {
  for (const hint of IDENTIFIER_HINTS) {
    if (hint.pattern.test(field.name) || hint.pattern.test(field.label)) return hint.what;
  }
  return "";
}

export interface GovernanceInput {
  spec: FormSpec;
  studies: readonly StudyNote[];
  variables: readonly VariableNote[];
}

export interface GovernanceReport {
  /** The study the form names, resolved. Null when it names none or none matches. */
  study: StudyNote | null;
  /** What the study approves, or null when nobody wrote it down. */
  approved: IdentifierScope | null;
  findings: GovernanceFinding[];
  /** Fields flagged as identifiers, in dictionary order. */
  identifiers: RedcapField[];
  /** True when nothing blocks; `unapproved` is the only finding that does. */
  exportable: boolean;
}

/** The catalogue variable a field cites, or null. */
function findVariable(ref: string, variables: readonly VariableNote[]): VariableNote | null {
  return variables.find((variable) => refMatchesVariable(ref, variable)) ?? null;
}

export function assessGovernance(input: GovernanceInput): GovernanceReport {
  const { spec, studies, variables } = input;
  const study = spec.study === "" ? null : findStudy(spec.study, studies);
  const approved = study?.approved ?? null;

  const findings: GovernanceFinding[] = [];
  const identifiers: RedcapField[] = [];

  for (const instrument of spec.instruments) {
    for (const field of instrument.fields) {
      if (field.name === "") continue;

      const variable = field.variable === "" ? null : findVariable(field.variable, variables);

      /* -- the catalogue disagrees -------------------------------------- */

      if (variable !== null && variable.identifier !== field.identifier) {
        findings.push({
          kind: "mismatch",
          instrument: instrument.name,
          field: field.name,
          message: field.identifier
            ? `${field.name} is flagged as an identifier, but the catalogue says ${variable.id} is not. One of the two is wrong.`
            : `${field.name} is not flagged as an identifier, but the catalogue says ${variable.id} is. One of the two is wrong.`,
          blocking: false,
        });
      }

      /* -- not flagged, but it looks like one --------------------------- */

      if (!field.identifier) {
        const hint = identifierHint(field);
        if (hint !== "" && (variable === null || !variable.identifier)) {
          findings.push({
            kind: "unflagged",
            instrument: instrument.name,
            field: field.name,
            message: `${field.name} looks like it holds ${hint} but is not flagged as an identifier. Check it — this is a guess from the name, not a reading of the data.`,
            blocking: false,
          });
        }
        continue;
      }

      identifiers.push(field);

      /* -- flagged: is it within what the study approved? ---------------- */

      if (approved === null) {
        findings.push({
          kind: "unknown-scope",
          instrument: instrument.name,
          field: field.name,
          message:
            study === null
              ? spec.study === ""
                ? `${field.name} is an identifier, and this form names no study, so there is no approved scope to check it against.`
                : `${field.name} is an identifier, and the study "${spec.study}" was not found, so there is no approved scope to check it against.`
              : `${field.name} is an identifier, and ${study.id} records no approved identifier scope. Not recorded is not the same as approved.`,
          blocking: false,
        });
      } else if (SCOPE_RANK[approved] === 0) {
        findings.push({
          kind: "unapproved",
          instrument: instrument.name,
          field: field.name,
          message: `${field.name} is flagged as an identifier, but ${study?.id ?? "the study"} is approved to collect no identifiers at all.`,
          blocking: true,
        });
      }

      /* -- flagged: does anything say why? ------------------------------ */

      const justified =
        field.justification !== "" || (variable !== null && variable.justification !== "");
      if (!justified) {
        findings.push({
          kind: "unjustified",
          instrument: instrument.name,
          field: field.name,
          message:
            variable === null
              ? `${field.name} is an identifier with no justification, and it cites no catalogue variable that could carry one.`
              : `${field.name} is an identifier, and neither the field nor ${variable.id} says why it is held.`,
          blocking: false,
        });
      }
    }
  }

  findings.sort(
    (a, b) => GOVERNANCE_KINDS.indexOf(a.kind) - GOVERNANCE_KINDS.indexOf(b.kind),
  );

  return {
    study,
    approved,
    findings,
    identifiers,
    exportable: !findings.some((finding) => finding.blocking),
  };
}

export function blockingOf(report: GovernanceReport): GovernanceFinding[] {
  return report.findings.filter((finding) => finding.blocking);
}
