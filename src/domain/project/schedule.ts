/**
 * Milestones as events (CLAUDE.md §5.15, §7 B8).
 *
 * "A milestone with a `due` is an event (§5.7): it appears in the daily
 * briefing and on the deadline board like any other date. It is not a second
 * reminder system, and building one would mean two places to look for what is
 * late — which is the failure this whole plugin exists to avoid."
 *
 * So this module builds no reminder machinery. It projects a milestone into the
 * `EventNote` shape the scheduler already consumes, and stops. Everything
 * downstream — `buildSchedule`, the deadline board, the briefing, the ICS feed
 * — then treats it as what it is: a dated commitment, handled by the one engine
 * that handles dated commitments.
 *
 * These notes are **virtual**: no file on disk answers to them. That is why
 * they are kept out of `EventStore.all()` and mixed in only on the read path.
 * `materialisePlan` already skips anything with no recurrence rule, so a
 * milestone can never become a write target, but relying on that alone would
 * be one refactor away from writing a computed `due` into a project note.
 *
 * Pure module: no Obsidian, no Node.
 */

import type { EventNote } from "../events/event";
import { toVaultDate } from "../time/dates";
import type { ProjectNote } from "./project";

/** A project and where its note lives, since `ProjectNote` carries no path. */
export interface ProjectAt {
  project: ProjectNote;
  path: string;
}

/**
 * What breaks if this milestone slips, in the milestone's own terms.
 *
 * §5.7 asks every reminder to say what breaks, on the grounds that one which
 * does not gets ignored. For an obligation that is a lapsed approval; for a
 * milestone it is whatever is waiting behind it. When nothing is waiting there
 * is nothing true to say, and this returns "" rather than filling the space —
 * a manufactured consequence is worse than a blank one, because the next
 * reminder that really does matter reads the same.
 */
function consequenceOf(project: ProjectNote, milestoneId: string): string {
  const waiting = project.milestones.filter(
    (other) => other.done === null && other.blockedBy.includes(milestoneId),
  );
  if (waiting.length === 0) return "";

  const names = waiting.map((m) => (m.title.trim() === "" ? m.id : `${m.id} (${m.title.trim()})`));
  return `${names.join(" and ")} cannot start until this lands.`;
}

/**
 * Every open, dated milestone across these projects, as event notes.
 *
 * Landed milestones are dropped: a date that has been met is not a deadline,
 * and leaving it on the board would push the ones that still matter down.
 * Dateless milestones are dropped too — the deadline board is about dates, and
 * a milestone with no date belongs on the portfolio board, where it shows as
 * open.
 */
export function milestoneEvents(projects: readonly ProjectAt[]): EventNote[] {
  const events: EventNote[] = [];

  for (const { project, path } of projects) {
    for (const milestone of project.milestones) {
      if (milestone.done !== null || milestone.due === null) continue;

      const label = milestone.title.trim() === "" ? milestone.id : milestone.title.trim();
      const projectLabel = project.title.trim() === "" ? project.id : project.title.trim();

      events.push({
        path,
        // `event`, never `obligation`: a milestone does not recur, and the
        // obligation type carries a required `consequence` this cannot always
        // honestly supply.
        type: "event",
        recurring: false,
        // Deterministic and unique, so re-reading the vault does not produce a
        // second copy, and so a future integrity check can name the milestone
        // an entry came from.
        uid: `${project.uid}#${milestone.id}`,
        id: `${project.id || project.uid} ${milestone.id}`.trim(),
        title: `${projectLabel} — ${label}`,
        due: toVaultDate(milestone.due),
        starts: "",
        ends: "",
        recurrence: null,
        leadDays: [],
        owner: project.owner,
        study: project.studies[0] ?? "",
        consequence: consequenceOf(project, milestone.id),
        lastCompleted: "",
        icsUid: "",
        problems: [],
        // No file answers to this occurrence. Anything that would write to
        // `path` has to notice that first — see `EventNote.derivedFrom`.
        derivedFrom: { kind: "milestone", noteUid: project.uid, itemId: milestone.id },
      });
    }
  }

  return events;
}
