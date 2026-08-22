/**
 * Re-export of the shared presentation vocabulary.
 *
 * The definitions moved to `domain/report/present` when the static HTML export
 * arrived: the exported board has to say "Overdue" too, and a second copy of
 * those four words is a second copy that can drift. This shim keeps the short
 * import path the UI files already use.
 */

export {
  count,
  displayName,
  duration,
  presentState,
  type StatePresentation,
} from "../domain/report/present";
