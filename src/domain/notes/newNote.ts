/**
 * The note kinds nothing else creates (§5 vault contract).
 *
 * Six of §5's folders had no command behind them — studies, people, policies,
 * meetings, profile items and publications — so the only way to start one was
 * to make the folder by hand and remember the frontmatter each board reads.
 * That is a documentation problem masquerading as a feature: the fields are
 * knowable, they are already parsed elsewhere in this codebase, and a person
 * typing them from memory gets them subtly wrong in the way that makes a board
 * silently show nothing.
 *
 * **One module rather than six** (§12: extend rather than parallel). Each kind
 * is a declarative spec — a folder, a `type:`, some fields — and `buildNote`
 * turns filled fields into the frontmatter, the body and the filename stem.
 * The dialog renders the spec and decides nothing; the writer takes the result
 * and touches the vault. So what a study note needs is stated once, here, in a
 * module that unit-tests in milliseconds.
 *
 * **What this deliberately does not do.** It invents no vocabulary. Every
 * `type:` and every closed option list below is imported from the reader on the
 * other side — `PUBLICATION_STAGES`, `POLICY_STATUSES`, `IDENTIFIER_SCOPES`,
 * §5.9's six profile types — never retyped. Where §5 fixes no vocabulary the
 * field is free text and says so, rather than a select that would quietly
 * become a vocabulary nothing agreed to.
 *
 * A handful of fields — a person's role and organisation, a meeting's
 * attendees — are conventional keys **nothing in this plugin computes on**.
 * They are here because a person note with no way to say who somebody is would
 * be a worse note, and they are called out so the next reader does not go
 * looking for the engine that consumes them.
 *
 * Pure module: no Obsidian, no Node.
 */

import { IDENTIFIER_SCOPES } from "../study/study";
import { POLICY_SCOPES, POLICY_STATUSES } from "../policy/policy";
import { PROFILE_TYPES } from "../profile/profile";
import { PUBLICATION_STAGES, STAGE_LABELS } from "../publication/publication";
import type { FolderKey } from "../settings/schema";
import { toVaultDate } from "../time/dates";

export const NEW_NOTE_KINDS = [
  "study",
  "person",
  "policy",
  "meeting",
  "profile",
  "publication",
] as const;
export type NewNoteKind = (typeof NEW_NOTE_KINDS)[number];

export type FieldKind = "text" | "date" | "select" | "textarea" | "checkbox" | "list";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  /**
   * The frontmatter key, dotted for a nested one: `governance.irb_ref` writes
   * under a `governance:` mapping, which is §5.1's shape and the shape
   * `parseStudy` reads.
   */
  key: string;
  label: string;
  kind: FieldKind;
  options?: readonly FieldOption[];
  initial?: string;
  placeholder?: string;
  hint?: string;
  /** Blocks the submit button while empty. */
  required?: boolean;
  /** Render only for these variants of a kind. Absent means always. */
  variants?: readonly string[];
}

/** Values as the dialog holds them: every field is a string, checkboxes "" or "yes". */
export type NoteValues = Readonly<Record<string, string>>;

export interface NoteKindSpec {
  id: NewNoteKind;
  /** The palette command, and the button label with "New " stripped. */
  commandName: string;
  title: string;
  folderKey: FolderKey;
  lede: string;
  /** The frontmatter `type:`. Empty when the variant field supplies it. */
  noteType: string;
  /** For kinds whose `type:` is chosen in the dialog — profile items, §5.9. */
  variantField?: FieldSpec;
  fields: readonly FieldSpec[];
  /** Fields tried in order to name the file. */
  stemFrom: readonly string[];
  fallbackStem: string;
  /** Frontmatter that is computed rather than typed. */
  extra?: (values: NoteValues, now: number) => Record<string, unknown>;
  body: (values: NoteValues) => string;
}

const IDENTIFIER_OPTIONS: readonly FieldOption[] = [
  { value: "", label: "Not recorded" },
  ...IDENTIFIER_SCOPES.map((scope) => ({ value: scope, label: scope })),
];

const STAGE_OPTIONS: readonly FieldOption[] = PUBLICATION_STAGES.map((stage) => ({
  value: stage,
  label: STAGE_LABELS[stage],
}));

function plainOptions(values: readonly string[], blank?: string): readonly FieldOption[] {
  const options = values.map((value) => ({ value, label: value }));
  return blank === undefined ? options : [{ value: "", label: blank }, ...options];
}

/* ----------------------------------------------------------------- specs -- */

const STUDY: NoteKindSpec = {
  id: "study",
  commandName: "New study",
  title: "New study",
  folderKey: "studies",
  noteType: "study",
  lede:
    "A study note is what every request, publication and effort row links to. " +
    "The governance block is the approved scope — what this study is allowed to hold, " +
    "against which a request asks for something narrower.",
  fields: [
    { key: "title", label: "Title", kind: "text", required: true, placeholder: "EuroHeart" },
    {
      key: "id",
      label: "Id",
      kind: "text",
      hint: "Optional. The filename is used when this is empty.",
    },
    {
      key: "status",
      label: "Status",
      kind: "text",
      hint: "Free text — §5 fixes no vocabulary for this, so nothing here pretends to.",
    },
    {
      key: "governance.identifiers",
      label: "Approved identifier scope",
      kind: "select",
      options: IDENTIFIER_OPTIONS,
      // A study with no recorded scope is NOT a study scoped to `none`
      // (domain/study/study.ts). Leaving this at "Not recorded" writes no key
      // at all, so every later check reports "cannot be checked from here"
      // rather than inventing a pass.
      hint: "Left unrecorded, checks against it report that nobody wrote it down — never a pass.",
    },
    { key: "governance.irb_ref", label: "IRB / DSRB reference", kind: "text" },
    { key: "governance.irb_expiry", label: "IRB expiry", kind: "date" },
  ],
  stemFrom: ["title", "id"],
  fallbackStem: "Study",
  body: () =>
    [
      "What this study is, who runs it, and anything a person needs to know",
      "before extracting from it.",
      "",
      "The approved identifier scope in the frontmatter is the ceiling: a request",
      "asking for more than this is the case the governance gate exists to catch.",
      "",
    ].join("\n"),
};

const PERSON: NoteKindSpec = {
  id: "person",
  commandName: "New person",
  title: "New person",
  folderKey: "people",
  noteType: "person",
  lede:
    "The filename is the identity — every `blocked_on:`, `requester:` and `authors:` " +
    "wikilink resolves to it, and correspondence is matched on it exactly rather than fuzzily.",
  fields: [
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: true,
      placeholder: "Dr A Tan",
      hint: "Names the file. Write it the way you will link to it.",
    },
    { key: "email", label: "Email", kind: "text", placeholder: "a.tan@example.org" },
    {
      key: "teams",
      label: "Teams address",
      kind: "text",
      // 0.3.2: the Teams deep link resolves a UPN, which on many tenants is not
      // the SMTP address, and a mismatch opens a chat with nobody in it.
      hint: "Only if Teams uses a different address from the email. Usually the UPN.",
    },
    { key: "role", label: "Role", kind: "text", placeholder: "Consultant cardiologist" },
    { key: "organisation", label: "Organisation", kind: "text" },
  ],
  stemFrom: ["name"],
  fallbackStem: "Person",
  body: () =>
    ["Who they are, what they are responsible for, and how they prefer to be reached.", ""].join(
      "\n",
    ),
};

const POLICY: NoteKindSpec = {
  id: "policy",
  commandName: "New policy",
  title: "New policy or SOP",
  folderKey: "policies",
  noteType: "policy",
  lede:
    "The register reads the version printed on the document, not a number the plugin allocates. " +
    "Paste the policy text into the body — revising it later freezes exactly what is there now.",
  fields: [
    {
      key: "title",
      label: "Title",
      kind: "text",
      required: true,
      placeholder: "SCDB data extraction SOP",
    },
    { key: "id", label: "Id", kind: "text", placeholder: "POL-SCDB-01" },
    {
      key: "version",
      label: "Version",
      kind: "text",
      required: true,
      placeholder: "3",
      // parsePolicy: without a version a revision cannot be frozen under a
      // name, so requiring it here is cheaper than the refusal later.
      hint: "As printed on the document. A revision is frozen under this name.",
    },
    {
      key: "status",
      label: "Status",
      kind: "select",
      options: plainOptions(POLICY_STATUSES),
      initial: "current",
    },
    {
      key: "scope",
      label: "Scope",
      kind: "select",
      options: plainOptions(POLICY_SCOPES, "Not recorded"),
    },
    { key: "authority", label: "Authority", kind: "text", placeholder: "[[Research Committee]]" },
    { key: "effective", label: "Effective from", kind: "date" },
    {
      key: "review_due",
      label: "Review due",
      kind: "date",
      hint: "What the register nags about. A policy with no review date never nags.",
    },
  ],
  stemFrom: ["title", "id"],
  fallbackStem: "Policy",
  body: () =>
    [
      "Paste the policy or SOP text here.",
      "",
      "## What rests on this",
      "",
      "Add a `governs:` list to the frontmatter, one entry per thing this policy",
      "controls, each naming the `clause:` it depends on:",
      "",
      "```yaml",
      "governs:",
      '  - { note: "[[SOP-extraction]]", clause: "4.2" }',
      "```",
      "",
      "That list is what a revision's impact map is built from. A dependency with",
      "no clause can only ever be reported as “review” — the map cannot say whether",
      "the part it relied on is the part that moved.",
      "",
    ].join("\n"),
};

const MEETING: NoteKindSpec = {
  id: "meeting",
  commandName: "New meeting note",
  title: "New meeting note",
  folderKey: "meetings",
  noteType: "meeting",
  lede:
    "The date matters more than it looks: “by Friday” in the minutes is resolved against " +
    "the meeting's own date, never against today, so a note extracted three weeks later " +
    "still produces the right deadline.",
  fields: [
    {
      key: "title",
      label: "Title",
      kind: "text",
      required: true,
      placeholder: "SCDB governance committee",
    },
    { key: "date", label: "Date", kind: "date", required: true },
    {
      key: "attendees",
      label: "Attendees",
      kind: "list",
      placeholder: "[[Dr A Tan]], [[Coordinator B]]",
      hint: "Comma-separated. Owners are matched against notes in the people folder.",
    },
  ],
  stemFrom: ["title"],
  fallbackStem: "Meeting",
  body: () =>
    [
      "## Minutes",
      "",
      "Write the meeting up however you write meetings up. Start a line with one of",
      "the marker words below and “Extract actions from these minutes” will find it:",
      "",
      "- **Action:** Dr Tan to countersign the DUA",
      "- **Decision:** extraction proceeds once the DUA is signed",
      "- **Deadline:** by Friday",
      "",
      "Extraction never touches this body — it writes what it found into the",
      "frontmatter as a manifest, so re-running it does nothing twice.",
      "",
    ].join("\n"),
};

const PROFILE: NoteKindSpec = {
  id: "profile",
  commandName: "New profile item",
  title: "New profile item",
  folderKey: "profile",
  noteType: "",
  lede:
    "One note per item, added when it happens. The CV is a query over these, so an item " +
    "typed in ten seconds today is a CV line that is never out of date.",
  variantField: {
    key: "type",
    label: "Kind",
    kind: "select",
    options: PROFILE_TYPES.map((type) => ({ value: type, label: type })),
    initial: "grant",
  },
  fields: [
    {
      key: "title",
      label: "Title",
      kind: "text",
      required: true,
      placeholder: "Readmission after heart failure",
    },
    {
      key: "period",
      label: "Period",
      kind: "text",
      placeholder: "2024–2027",
      // readPeriod accepts a year, a month, a date, or a range of any of them,
      // and a bare year is a legitimate precision rather than a lazy one.
      hint: "A year, a month, a date, or a range. An item with no period sorts to the end of its section.",
    },
    {
      key: "role",
      label: "Role or position",
      kind: "text",
      // `role`, never `position`, for a service item: Obsidian's metadata cache
      // overwrites `position` with the frontmatter block's own line range, so a
      // `position:` typed here would never reach the CV. `parseProfileNote`
      // reads `role` first for exactly that reason.
      variants: ["grant", "service", "teaching", "supervision"],
    },
    { key: "agency", label: "Agency", kind: "text", variants: ["grant"] },
    { key: "ref", label: "Reference", kind: "text", variants: ["grant"] },
    { key: "amount", label: "Amount", kind: "text", variants: ["grant"] },
    { key: "currency", label: "Currency", kind: "text", variants: ["grant"] },
    { key: "status", label: "Status", kind: "text", variants: ["grant"] },
    { key: "organisation", label: "Organisation", kind: "text", variants: ["service"] },
    {
      key: "scope",
      label: "Scope",
      kind: "text",
      placeholder: "institutional",
      variants: ["service"],
    },
    { key: "institution", label: "Institution", kind: "text", variants: ["teaching"] },
    { key: "level", label: "Level", kind: "text", variants: ["teaching"] },
    { key: "hours", label: "Hours", kind: "text", variants: ["teaching"] },
    { key: "trainee", label: "Trainee", kind: "text", variants: ["supervision"] },
    { key: "degree", label: "Degree", kind: "text", variants: ["supervision"] },
    { key: "outcome", label: "Outcome", kind: "text", variants: ["supervision"] },
    { key: "meeting", label: "Meeting", kind: "text", variants: ["presentation"] },
    { key: "location", label: "Location", kind: "text", variants: ["presentation"] },
    { key: "date", label: "Date", kind: "date", variants: ["presentation"] },
    { key: "format", label: "Format", kind: "text", placeholder: "oral", variants: ["presentation"] },
    { key: "invited", label: "Invited", kind: "checkbox", variants: ["presentation"] },
    { key: "body", label: "Awarded by", kind: "text", variants: ["award"] },
  ],
  stemFrom: ["title"],
  fallbackStem: "Profile item",
  body: () =>
    ["Anything about this item that a CV line cannot carry but you will want later.", ""].join(
      "\n",
    ),
};

const PUBLICATION: NoteKindSpec = {
  id: "publication",
  commandName: "New publication",
  title: "New publication",
  folderKey: "publications",
  noteType: "publication",
  lede:
    "`scdb_supported` is the one to get right: “papers this facility made possible” is the " +
    "single most useful number to put in front of a funding committee, and it can only be " +
    "counted if it was recorded at the time.",
  fields: [
    { key: "title", label: "Title", kind: "text", required: true },
    { key: "id", label: "Id", kind: "text", placeholder: "PUB-2026-007" },
    {
      key: "stage",
      label: "Stage",
      kind: "select",
      options: STAGE_OPTIONS,
      initial: "drafting",
      hint: "The first history entry is stamped with today, so time-to-decision can be measured.",
    },
    { key: "journal", label: "Journal", kind: "text" },
    {
      key: "authors",
      label: "Authors",
      kind: "list",
      placeholder: "[[Dr A Tan]], [[Owner]]",
      hint: "Comma-separated, in author order.",
    },
    { key: "studies", label: "Studies", kind: "list", placeholder: "[[EuroHeart]]" },
    {
      key: "scdb_supported",
      label: "SCDB supported",
      kind: "checkbox",
      hint: "Did the facility contribute data? This drives the impact report.",
    },
  ],
  stemFrom: ["title", "id"],
  fallbackStem: "Publication",
  extra: (values, now) => {
    const stage = (values["stage"] ?? "").trim();
    // Metrics read `history`, not `stage` alone: without a first entry a
    // manuscript has no measurable time in any stage, and the number is
    // unrecoverable afterwards because nothing recorded when it started.
    return stage === "" ? {} : { history: [{ at: toVaultDate(now), to: stage }] };
  },
  body: () =>
    [
      "Where the manuscript lives, what is outstanding, and who is waiting on whom.",
      "",
      "Move it between stages from the publications board rather than editing",
      "`stage` here — the board appends to `history`, which is what every metric",
      "on that board is computed from.",
      "",
    ].join("\n"),
};

export const NOTE_KIND_SPECS: Readonly<Record<NewNoteKind, NoteKindSpec>> = {
  study: STUDY,
  person: PERSON,
  policy: POLICY,
  meeting: MEETING,
  profile: PROFILE,
  publication: PUBLICATION,
};

export function isNewNoteKind(value: unknown): value is NewNoteKind {
  return typeof value === "string" && (NEW_NOTE_KINDS as readonly string[]).includes(value);
}

/** The fields a spec shows for a variant, in order, with the variant field first. */
export function fieldsFor(spec: NoteKindSpec, variant: string): FieldSpec[] {
  const fields = spec.fields.filter(
    (field) => field.variants === undefined || field.variants.includes(variant),
  );
  return spec.variantField === undefined ? fields : [spec.variantField, ...fields];
}

/** The initial value of every field a spec can show, variant fields included. */
export function initialValues(spec: NoteKindSpec, now: number): Record<string, string> {
  const values: Record<string, string> = {};
  if (spec.variantField !== undefined) {
    values[spec.variantField.key] = spec.variantField.initial ?? "";
  }
  for (const field of spec.fields) {
    values[field.key] = field.initial ?? (field.kind === "date" && field.required ? toVaultDate(now) : "");
  }
  return values;
}

/* ----------------------------------------------------------------- build -- */

export interface BuiltNote {
  /** The filename without folder or extension, already safe for a vault path. */
  stem: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Required fields left empty. The dialog blocks on these; nothing writes with any. */
  missing: string[];
}

/**
 * Characters Obsidian refuses in a filename, plus the ones that would turn a
 * name into a wikilink or a heading when it is linked to later.
 */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

export function safeStem(value: string): string {
  return value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  const dot = key.indexOf(".");
  if (dot === -1) {
    target[key] = value;
    return;
  }
  const head = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  const existing = target[head];
  const nested: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  assign(nested, rest, value);
  target[head] = nested;
}

/**
 * Turn filled fields into a note.
 *
 * Empty fields write **no key at all** rather than an empty one. That is not
 * tidiness: several readers here distinguish "absent" from "empty" and mean
 * different things by them — a study with no recorded identifier scope is not
 * a study scoped to `none`, and a project with an empty `external_ref` reads as
 * "never reconciled", which is a different and untrue claim.
 */
export function buildNote(spec: NoteKindSpec, values: NoteValues, now: number): BuiltNote {
  const variant = spec.variantField === undefined ? "" : (values[spec.variantField.key] ?? "").trim();
  const shown = fieldsFor(spec, variant);

  const missing = shown
    .filter((field) => field.required === true && (values[field.key] ?? "").trim() === "")
    .map((field) => field.label);

  const frontmatter: Record<string, unknown> = {};
  const type = variant !== "" ? variant : spec.noteType;
  if (type !== "") frontmatter["type"] = type;

  for (const field of shown) {
    if (spec.variantField !== undefined && field.key === spec.variantField.key) continue;
    const raw = (values[field.key] ?? "").trim();

    if (field.kind === "checkbox") {
      // Written either way, unlike the others: `scdb_supported: false` is a
      // recorded answer, and a key you can see is a key you can flip later.
      frontmatter[field.key] = raw !== "";
      continue;
    }
    if (raw === "") continue;

    if (field.kind === "list") {
      const items = raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      if (items.length > 0) assign(frontmatter, field.key, items);
      continue;
    }
    assign(frontmatter, field.key, raw);
  }

  if (spec.extra !== undefined) {
    for (const [key, value] of Object.entries(spec.extra(values, now))) {
      assign(frontmatter, key, value);
    }
  }

  let stem = "";
  for (const key of spec.stemFrom) {
    stem = safeStem(values[key] ?? "");
    if (stem !== "") break;
  }

  return {
    stem: stem === "" ? spec.fallbackStem : stem,
    frontmatter,
    body: spec.body(values),
    missing,
  };
}
