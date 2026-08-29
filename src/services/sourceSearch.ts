/**
 * Orchestrating one search: build a URL, ask the gateway, parse the reply.
 *
 * Sits between the modal and `httpGateway` so the modal stays presentational
 * (§8) and so the two-request shape of a PubMed search — ids, then summaries —
 * is in one place rather than spread through a component.
 *
 * Nothing here decides to fetch. Every method is called after the user has
 * seen the literal URL and said yes.
 */

import {
  ctgovSearchUrl,
  parseCtgovSearch,
  type CtgovSearchOptions,
  type TrialRecord,
} from "../domain/sources/ctgov";
import type { FeedEntry } from "../domain/sources/feeds";
import {
  previewRequest,
  SOURCES,
  type RequestPreview,
  type SourceId,
} from "../domain/sources/gateway";
import {
  GUIDELINE_SOURCES,
  parseGuidelines,
  type GuidelineSourceId,
} from "../domain/sources/guidelines";
import {
  parsePubmedSearch,
  parsePubmedSummaries,
  proposeFields,
  pubmedDoiUrl,
  pubmedSearchUrl,
  pubmedSummaryUrl,
  looksLikeDoi,
  isPmid,
  type FieldProposal,
  type PubmedRecord,
  type PubmedSearchOptions,
} from "../domain/sources/pubmed";
import type { HttpGateway } from "./httpGateway";

export interface SearchDeps {
  gateway: HttpGateway;
  contactEmail: () => string;
  maxResults: () => number;
}

export interface PubmedSearchOutcome {
  papers: PubmedRecord[];
  total: number;
  url: string;
  /**
   * Things PubMed did quietly that change what the results mean.
   *
   * The one that matters: a quoted phrase it cannot find is **dropped**, and
   * the search runs without it. You get results, none of which contain the
   * phrase you asked for. Verified against the live service.
   */
  warnings: string[];
  translation: string;
}

export interface GuidelineOutcome {
  entries: FeedEntry[];
  /** Everything the source offered before the cap, so the note can say so. */
  total: number;
  url: string;
  caveat: string;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; why: string };

export class SourceSearch {
  constructor(private readonly deps: SearchDeps) {}

  private identity(): { email: string } {
    return { email: this.deps.contactEmail() };
  }

  /** The URL a search *would* use, for the confirmation. Sends nothing. */
  previewPubmed(options: PubmedSearchOptions): RequestPreview | { why: string } {
    const url = pubmedSearchUrl(
      { ...options, retmax: options.retmax ?? this.deps.maxResults() },
      this.identity(),
    );
    const email = this.identity().email.trim();
    return previewRequest(
      url,
      `the words you typed${email === "" ? "" : `, and your address (${email})`}`,
    );
  }

  previewCtgov(options: CtgovSearchOptions): RequestPreview | { why: string } {
    const url = ctgovSearchUrl({ ...options, pageSize: options.pageSize ?? this.deps.maxResults() });
    return previewRequest(url, "the words you typed");
  }

  /**
   * A guideline fetch carries **nothing**, which is worth saying out loud.
   *
   * The other sources send words the user typed. This asks a society's server
   * for a document it publishes at a fixed address, so the only thing that
   * leaves is the request itself. The confirmation says that rather than
   * leaving the user to infer it.
   */
  previewGuidelines(source: GuidelineSourceId): RequestPreview | { why: string } {
    return previewRequest(GUIDELINE_SOURCES[source].url(), "nothing from your vault — only the request");
  }

  previewLookup(reference: string): RequestPreview | { why: string } {
    const built = this.lookupUrl(reference);
    if ("why" in built) return built;
    return previewRequest(built.url, `one ${built.kind}, and nothing else from the note`);
  }

  /**
   * A PubMed search is two requests: ids, then the records for those ids.
   *
   * Both are made only after one confirmation, and the confirmation names the
   * search URL. That is deliberate rather than sloppy: the second request
   * carries nothing the first did not — it asks for the ids the first returned
   * — so a second dialog would be ceremony without information. The ledger
   * records both.
   */
  async pubmed(options: PubmedSearchOptions): Promise<Outcome<PubmedSearchOutcome>> {
    const retmax = options.retmax ?? this.deps.maxResults();
    const url = pubmedSearchUrl({ ...options, retmax }, this.identity());
    const found = await this.deps.gateway.fetch(url, `PubMed search: ${options.query}`);
    if (!found.ok) return { ok: false, why: found.why };

    const search = parsePubmedSearch(found.body);
    if ("why" in search) return { ok: false, why: search.why };
    if (search.ids.length === 0) {
      return {
        ok: true,
        value: { papers: [], total: search.total, url, warnings: search.warnings, translation: search.translation },
      };
    }

    const papers = await this.summaries(search.ids, `PubMed records for ${search.ids.length} ids`);
    if (!papers.ok) return papers;
    return {
      ok: true,
      value: {
        papers: papers.value,
        total: search.total,
        url,
        warnings: search.warnings,
        translation: search.translation,
      },
    };
  }

  async ctgov(
    options: CtgovSearchOptions,
  ): Promise<Outcome<{ trials: TrialRecord[]; total: number; url: string }>> {
    const url = ctgovSearchUrl({ ...options, pageSize: options.pageSize ?? this.deps.maxResults() });
    const label = [options.condition, options.term].filter((part) => (part ?? "") !== "").join(" / ");
    const found = await this.deps.gateway.fetch(url, `ClinicalTrials.gov search: ${label}`);
    if (!found.ok) return { ok: false, why: found.why };

    const parsed = parseCtgovSearch(found.body);
    if ("why" in parsed) return { ok: false, why: parsed.why };
    return { ok: true, value: { trials: parsed.studies, total: parsed.total, url } };
  }

  /**
   * One guideline source, one request.
   *
   * The ESC sitemap is the whole site and gets filtered down here rather than
   * at the far end; that is the cost of a source with no feed, and it is paid
   * once per check rather than by the user.
   */
  async guidelines(source: GuidelineSourceId): Promise<Outcome<GuidelineOutcome>> {
    const spec = GUIDELINE_SOURCES[source];
    const url = spec.url();
    // The ledger's subject column already carries the host, so this says what
    // was asked for rather than repeating it. `source` is the raw id and would
    // read as "eacts guideline list".
    const found = await this.deps.gateway.fetch(url, `${SOURCES[source].label}, the published list`);
    if (!found.ok) return { ok: false, why: found.why };

    const parsed = parseGuidelines(source, found.body, this.deps.maxResults());
    if ("why" in parsed) return { ok: false, why: parsed.why };

    return {
      ok: true,
      value: { entries: parsed.entries, total: parsed.total, url, caveat: spec.caveat },
    };
  }

  /**
   * Look one publication up by PMID or DOI.
   *
   * A DOI is resolved through PubMed's own index rather than through Crossref,
   * which keeps Crossref off the allowlist. The cost is honest and worth
   * stating in the UI: a DOI PubMed has never indexed — a book chapter, a
   * non-biomedical journal — will not be found, and that is a limit of where we
   * looked rather than evidence the DOI is wrong.
   */
  async lookup(reference: string): Promise<Outcome<PubmedRecord>> {
    const built = this.lookupUrl(reference);
    if ("why" in built) return { ok: false, why: built.why };

    let pmid = built.pmid;
    if (pmid === "") {
      const found = await this.deps.gateway.fetch(built.url, `DOI lookup: ${built.doi}`);
      if (!found.ok) return { ok: false, why: found.why };
      const search = parsePubmedSearch(found.body);
      if ("why" in search) return { ok: false, why: search.why };
      const first = search.ids[0];
      if (first === undefined) {
        return {
          ok: false,
          why: `PubMed has no record with the DOI ${built.doi}. That may mean the DOI is wrong, or simply that PubMed does not index it.`,
        };
      }
      pmid = first;
    }

    const records = await this.summaries([pmid], `PubMed record for PMID ${pmid}`);
    if (!records.ok) return records;
    const record = records.value[0];
    if (record === undefined) {
      return { ok: false, why: `PubMed returned no usable record for PMID ${pmid}.` };
    }
    return { ok: true, value: record };
  }

  /** The fields a fetched record would propose onto a note. Pure; sends nothing. */
  propose(record: PubmedRecord, current: Readonly<Record<string, unknown>>): FieldProposal[] {
    return proposeFields(record, current);
  }

  private async summaries(ids: readonly string[], carries: string): Promise<Outcome<PubmedRecord[]>> {
    const url = pubmedSummaryUrl(ids, this.identity());
    const found = await this.deps.gateway.fetch(url, carries);
    if (!found.ok) return { ok: false, why: found.why };
    const records = parsePubmedSummaries(found.body);
    if ("why" in records) return { ok: false, why: records.why };
    return { ok: true, value: records };
  }

  private lookupUrl(
    reference: string,
  ): { url: string; kind: string; pmid: string; doi: string } | { why: string } {
    const raw = reference.trim();
    if (isPmid(raw)) {
      return {
        url: pubmedSummaryUrl([raw], this.identity()),
        kind: "PubMed identifier",
        pmid: raw,
        doi: "",
      };
    }
    if (looksLikeDoi(raw)) {
      return { url: pubmedDoiUrl(raw, this.identity()), kind: "DOI", pmid: "", doi: raw };
    }
    return {
      why: "That is neither a PMID (digits) nor a DOI (starting 10.). Nothing was sent.",
    };
  }
}
