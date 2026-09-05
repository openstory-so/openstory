/**
 * Shared heuristic for "is this script thin enough that we should expand it?".
 * Used by the new-sequence page (the short-script enhance nudge) and the public
 * API's `enhance: 'auto'` mode, so the UI and API agree on the threshold.
 */

/** Scripts shorter than this read as briefs / one-liners worth enhancing. */
export const SCRIPT_SHORT_THRESHOLD = 1000;

export function isShortScript(script: string): boolean {
  return script.trim().length < SCRIPT_SHORT_THRESHOLD;
}
