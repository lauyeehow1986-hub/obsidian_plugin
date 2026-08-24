/**
 * The only place policy notes and their frozen revisions are written (§7 C1).
 *
 * Same two rules as the request and publication writers, and one more that is
 * particular to this feature:
 *
 *  - **Consequential actions are logged** (rule 9). The ledger entry goes in
 *    before anything is touched, so a crash between the two leaves a recorded
 *    intent rather than a silent change; a failed write appends a `correction`
 *    saying so.
 *  - **Never destroy data you did not write** (rule 8). Frontmatter merges key
 *    by key; the old frontmatter is carried into the frozen copy verbatim.
 *  - **Freeze first, replace second.** A crash between the two leaves a frozen
 *    copy that duplicates the live note, which is harmless. The other order
 *    loses the prior text — the one thing this track exists to preserve. The
 *    order is not an implementation detail and must not be "tidied".
 */

import { TFile, type App } from "obsidian";
import { correctionEntry, type AuditEntry } from "../domain/audit/ledger";
import { buildImpactMap, type ImpactMap, type RefResolver } from "../domain/policy/impact";
import { parsePolicy, policyLabel, type PolicyNote } from "../domain/policy/policy";
import {
  buildFrozenNote,
  frontmatterBlock,
  impactReportPath,
  planRevision,
  renderImpactReport,
  revisionPath,
  revisionRecord,
  type RevisionPlan,
} from "../domain/policy/revision";
import { stripFrontmatter } from "../domain/policy/sections";
import { toVaultDate, toVaultMinute } from "../domain/time/dates";
import { ensureFolder } from "../data/vaultPaths";
import type { AuditLog } from "./auditLog";

export interface PolicyWriterContext {
  app: App;
  audit: AuditLog;
  actor: () => string;
  /** The policies folder, read fresh so a settings change takes effect. */
  policiesFolder: () => string;
  /** Called after a successful write so the index repaints. */
  reindex: (file: TFile) => void;
}

export interface ReviseInput {
  file: TFile;
  policy: PolicyNote;
  /** The replacement document, as text. Any frontmatter on it is discarded. */
  incomingText: string;
  newVersion: string;
  /** One line on what changed. Required — see `revise`. */
  summary: string;
  /** `YYYY-MM-DD` for the new version's `effective`, or empty to leave it. */
  effective?: string;
  /** Edges other notes declare pointing at this policy. */
  incoming?: readonly import("../domain/policy/policy").PolicyEdge[];
  resolve?: RefResolver;
  now?: number;
}

export interface ReviseResult {
  plan: RevisionPlan;
  map: ImpactMap;
  frozenPath: string;
  reportPath: string;
  /**
   * The impact report as a `TFile`, so a caller can open it.
   *
   * Returned rather than looked up by path afterwards: the note index is fed
   * by Obsidian's asynchronous metadata cache, so a file written a moment ago
   * is not in it yet and `openNote` silently does nothing. The report
   * exporter hit the same thing.
   */
  reportFile: TFile;
}

/** Thrown when a revision cannot proceed. Carries every reason, not the first. */
export class RevisionRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
    this.name = "RevisionRefused";
  }
}

export class PolicyWriter {
  constructor(private readonly ctx: PolicyWriterContext) {}

  private actorOrThrow(): string {
    const actor = this.ctx.actor().trim();
    if (actor === "") {
      throw new Error(
        "Set your initials as the actor in SCDB Cockpit settings first — every logged action needs to name who did it.",
      );
    }
    return actor;
  }

  private taken = (path: string): boolean =>
    this.ctx.app.vault.getAbstractFileByPath(path) !== null;

  /** Read a policy note fresh from disk, so the plan is not built on stale text. */
  async currentText(file: TFile): Promise<string> {
    return this.ctx.app.vault.read(file);
  }

  /**
   * What a revision would do, without doing it.
   *
   * Called by the dialog to render the diff, the impact map and the refusals
   * before anything is written, and again by `revise` so the decision is made
   * against the text on disk rather than the text the dialog opened with.
   */
  async preview(input: ReviseInput): Promise<{ plan: RevisionPlan; map: ImpactMap }> {
    const now = input.now ?? Date.now();
    const currentText = await this.currentText(input.file);

    const plan = planRevision({
      policy: input.policy,
      currentText,
      incomingText: input.incomingText,
      newVersion: input.newVersion,
      policiesFolder: this.ctx.policiesFolder(),
      at: now,
      taken: this.taken,
    });

    const map = buildImpactMap({
      policy: input.policy,
      diff: plan.diff,
      ...(input.incoming === undefined ? {} : { incoming: input.incoming }),
      ...(input.resolve === undefined ? {} : { resolve: input.resolve }),
    });

    return { plan, map };
  }

  /**
   * Freeze the prior version, replace the text, record the revision, and write
   * the impact report.
   *
   * A summary is required for the same reason §5.6 requires a typed reason on
   * a gate override: a revision record that says only "changed" is a row
   * nobody can act on six months later.
   */
  async revise(input: ReviseInput): Promise<ReviseResult> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();

    const summary = input.summary.trim();
    if (summary === "") {
      throw new RevisionRefused([
        "Say in one line what changed. A revision record without one cannot be acted on later.",
      ]);
    }

    const currentText = await this.currentText(input.file);
    const { plan, map } = await this.preview({ ...input, now });
    if (plan.refusals.length > 0) throw new RevisionRefused(plan.refusals);

    const subject = input.policy.id || input.file.path;
    const reportPath = impactReportPath(plan.frozenPath);
    let reportFile: TFile | null = null;

    await this.ctx.audit.append([
      {
        ts: toVaultMinute(now),
        actor,
        action: "policy-revision",
        subject,
        // IDs and counts only (rule 7). The summary is the user's own words
        // about a policy document, not note content about a person.
        detail: `${plan.frozenVersion}→${input.newVersion.trim()}; ${map.counts["clause-gone"]} clause-gone, ${map.counts.affected} affected, ${map.counts.review} to review; frozen ${plan.frozenPath}`,
      },
    ]);

    try {
      await ensureFolder(this.ctx.app, plan.frozenPath.split("/").slice(0, -1).join("/"));

      // 1. Freeze. Before anything else, always.
      await this.ctx.app.vault.create(
        plan.frozenPath,
        buildFrozenNote({
          policy: input.policy,
          currentText,
          version: plan.frozenVersion,
          at: now,
          actor,
          summary,
          frontmatterYaml: frontmatterBlock(currentText),
        }),
      );

      // 2. Replace the body, keeping the note's own frontmatter block intact.
      const body = stripFrontmatter(input.incomingText).replace(/^\n+/, "").trimEnd();
      await this.ctx.app.vault.process(input.file, (text) => {
        const block = frontmatterBlock(text);
        return block === "" ? `${body}\n` : `---\n${block}---\n\n${body}\n`;
      });

      // 3. Record it on the live note.
      await this.ctx.app.fileManager.processFrontMatter(input.file, (frontmatter) => {
        frontmatter["version"] = input.newVersion.trim();
        if (input.effective !== undefined && input.effective !== "") {
          frontmatter["effective"] = input.effective;
        }
        const supersedesId = input.policy.id === "" ? "" : `${input.policy.id}@${plan.frozenVersion}`;
        if (supersedesId !== "") frontmatter["supersedes"] = supersedesId;

        const existing: unknown = frontmatter["revisions"];
        frontmatter["revisions"] = [
          ...(Array.isArray(existing) ? existing : []),
          revisionRecord({
            version: plan.frozenVersion,
            frozen: plan.frozenPath,
            at: now,
            actor,
            summary,
          }),
        ];
      });

      // 4. The deliverable.
      reportFile = await this.ctx.app.vault.create(
        reportPath,
        renderImpactReport({
          map,
          diff: plan.diff,
          fromVersion: plan.frozenVersion,
          toVersion: input.newVersion.trim(),
          frozenPath: plan.frozenPath,
          at: now,
          actor,
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `the revision did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }

    this.ctx.reindex(input.file);
    if (reportFile === null) {
      // Unreachable: `vault.create` either returns a file or throws, and a
      // throw is caught above. Narrowing rather than asserting, because a
      // non-null assertion here would outlive the reason for it.
      throw new Error(`The impact map at "${reportPath}" was not created.`);
    }
    return { plan, map, frozenPath: plan.frozenPath, reportPath, reportFile };
  }

  /**
   * Freeze the current text without changing it — a baseline.
   *
   * The register nags about a policy that has never been frozen, because the
   * first real revision would then have nothing to diff against. This is how
   * that is answered without inventing a change.
   */
  async freezeBaseline(input: {
    file: TFile;
    policy: PolicyNote;
    summary?: string;
    now?: number;
  }): Promise<string> {
    const actor = this.actorOrThrow();
    const now = input.now ?? Date.now();

    if (input.policy.version.trim() === "") {
      throw new RevisionRefused([
        "The policy note has no `version`, so the frozen copy has nothing to be filed under. Add the version printed on the current document first.",
      ]);
    }

    const currentText = await this.currentText(input.file);
    const path = revisionPath(
      this.ctx.policiesFolder(),
      input.policy,
      input.policy.version,
      now,
      this.taken,
    );
    const summary = input.summary?.trim() || `Baseline snapshot taken ${toVaultDate(now)}.`;
    const subject = input.policy.id || input.file.path;

    await this.ctx.audit.append([
      {
        ts: toVaultMinute(now),
        actor,
        action: "policy-revision",
        subject,
        detail: `baseline at ${input.policy.version}; frozen ${path}`,
      },
    ]);

    try {
      await ensureFolder(this.ctx.app, path.split("/").slice(0, -1).join("/"));
      await this.ctx.app.vault.create(
        path,
        buildFrozenNote({
          policy: input.policy,
          currentText,
          version: input.policy.version,
          at: now,
          actor,
          summary,
          frontmatterYaml: frontmatterBlock(currentText),
        }),
      );
      await this.ctx.app.fileManager.processFrontMatter(input.file, (frontmatter) => {
        const existing: unknown = frontmatter["revisions"];
        frontmatter["revisions"] = [
          ...(Array.isArray(existing) ? existing : []),
          revisionRecord({ version: input.policy.version, frozen: path, at: now, actor, summary }),
        ];
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ctx.audit.append([
        correctionEntry({
          ts: toVaultMinute(Date.now()),
          actor,
          subject,
          correctsChain: "the entry above",
          reason: `the baseline freeze did not complete: ${reason}`,
        }),
      ]);
      throw error;
    }

    this.ctx.reindex(input.file);
    return path;
  }

  /** Re-read a policy note from the vault, for a caller holding only a file. */
  policyFor(file: TFile): PolicyNote | null {
    const cache = this.ctx.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter) return null;
    const { position: _position, ...rest } = frontmatter as Record<string, unknown>;
    return parsePolicy(file.path, rest);
  }

  /** How a policy is named in a notice. */
  static label(policy: PolicyNote): string {
    return policyLabel(policy);
  }
}

export type { AuditEntry };
