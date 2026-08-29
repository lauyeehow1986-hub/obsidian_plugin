/**
 * The allowlist every outbound request is checked against (CLAUDE.md rule 3).
 *
 * Pure — no Obsidian, no network. This module decides; `services/httpGateway`
 * is the only thing that acts on the decision, and it is the only module in the
 * plugin permitted to call `requestUrl`.
 *
 * **The allowlist is a constant in code, not a setting.** That is the whole
 * point of it. A host the user can type into settings is a host a colleague can
 * talk them into typing, and a host a note can suggest; the allowlist would then
 * be documentation rather than a control. §11 asks which external hosts the
 * *target machine can reach* — that is a question about firewalls, and a
 * different question from which hosts this plugin is willing to talk to.
 * Adding one here is a code change, a review and a changelog entry.
 *
 * Settings say which **sources** are switched on. Nothing on a fresh install is.
 */

/** The sources §7 E1 names, minus one. See `MISSING_SOURCE` below. */
export const SOURCE_IDS = ["pubmed", "ctgov"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface SourceSpec {
  id: SourceId;
  label: string;
  /** The single host this source may reach. Compared exactly, never by suffix. */
  host: string;
  /** Shown in settings and in the confirmation, so the choice is informed. */
  operator: string;
}

export const SOURCES: Record<SourceId, SourceSpec> = {
  pubmed: {
    id: "pubmed",
    label: "PubMed",
    host: "eutils.ncbi.nlm.nih.gov",
    operator: "US National Library of Medicine",
  },
  ctgov: {
    id: "ctgov",
    label: "ClinicalTrials.gov",
    host: "clinicaltrials.gov",
    operator: "US National Library of Medicine",
  },
};

/**
 * Why §7's third source is absent.
 *
 * §7 E1 says "PubMed, ClinicalTrials.gov and guideline feeds". The first two
 * name a service; "guideline feeds" names a category, and there is no host to
 * put in the list above. Choosing one would be inventing an allowlist entry —
 * the same objection §5.2 makes about inventing a workflow stage to make a
 * feature work. It stays out until the user names the source, and §11 carries
 * the question.
 */
export const MISSING_SOURCE =
  "Guideline feeds are not built: §7 names the category but no host, and the allowlist takes hosts.";

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === "string" && (SOURCE_IDS as readonly string[]).includes(value);
}

export type GateDecision = { ok: true; source: SourceId } | { ok: false; why: string };

/**
 * Check a fully built URL immediately before it is fetched.
 *
 * Deliberately takes the finished string rather than the parts that made it,
 * for the reason `services/protocol` gives about `shell.openExternal`: the
 * parts are validated somewhere else, and a refactor can separate the two. The
 * only check that cannot drift is the one applied to what actually goes out.
 *
 * Refusals are specific because a silent "no" is indistinguishable from a bug.
 */
export function checkUrl(url: string): GateDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, why: "That is not a URL the plugin can parse, so it will not be opened." };
  }

  // http: would send the query in clear text across an institutional network.
  if (parsed.protocol !== "https:") {
    return { ok: false, why: `Only https is allowed, and that URL is ${parsed.protocol}` };
  }

  // `https://eutils.ncbi.nlm.nih.gov@evil.example/` parses with hostname
  // evil.example, so credentials in the authority are refused outright rather
  // than stripped — there is no legitimate use for them here.
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, why: "That URL carries a username or password, which is never expected." };
  }

  // A non-default port on a known host is not something these APIs ask for,
  // and allowing it would let a redirect target an internal service.
  if (parsed.port !== "") {
    return { ok: false, why: "That URL names a port, and only the default https port is allowed." };
  }

  const host = parsed.hostname.toLowerCase();
  const match = SOURCE_IDS.find((id) => SOURCES[id].host === host);
  if (match === undefined) {
    // Exact match only. Suffix matching would accept `notclinicaltrials.gov`
    // and `clinicaltrials.gov.evil.example` — the classic way an allowlist
    // stops being one.
    return { ok: false, why: `${parsed.hostname} is not on the allowlist, so nothing was sent.` };
  }

  return { ok: true, source: match };
}

/**
 * What the confirmation dialog shows before anything leaves (rule 4).
 *
 * The literal URL, not a description of it. A summary that says "searches
 * PubMed for your term" is exactly the thing the user cannot check.
 */
export interface RequestPreview {
  source: SourceId;
  label: string;
  operator: string;
  host: string;
  url: string;
  /** One line naming what the request carries, in the user's words. */
  carries: string;
}

export function previewRequest(url: string, carries: string): RequestPreview | { why: string } {
  const decision = checkUrl(url);
  if (!decision.ok) return { why: decision.why };
  const spec = SOURCES[decision.source];
  return {
    source: spec.id,
    label: spec.label,
    operator: spec.operator,
    host: spec.host,
    url,
    carries,
  };
}

/**
 * Politeness limits, per host, in milliseconds between requests.
 *
 * NCBI's usage policy is three requests a second without an API key and
 * blocking is their documented response to exceeding it. Being blocked would
 * present to the user as "the feature is broken" on a machine with no way to
 * diagnose it, so the ceiling is enforced here rather than hoped for.
 */
export const MIN_INTERVAL_MS: Record<SourceId, number> = {
  pubmed: 350,
  ctgov: 250,
};

/** Cap on results per search, so one action cannot pull down a whole database. */
export const MAX_RESULTS = 50;
export const DEFAULT_RESULTS = 20;
