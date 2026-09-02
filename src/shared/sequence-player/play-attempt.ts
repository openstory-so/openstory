/**
 * Outcomes of SequencePlayerEngine.play() so the UI can tell a user-cancel
 * from a failed start, and ignore a stale attempt after pause-then-play.
 */

export type PlayAttemptResult =
  | 'playing'
  | 'already-playing'
  | 'cancelled'
  | 'disposed'
  | 'not-ready';

export type PlayWaitSettlement = 'cancelled' | 'disposed' | 'proceed';

/**
 * After `play()` finishes waiting on audio resume / dialogue decode, decide
 * whether this attempt is still the live one. A newer play() bumps
 * `currentGeneration`; the stale attempt must return cancelled *without*
 * clearing the live attempt's `playRequested` flag.
 */
export function settlePlayWait(args: {
  attemptGeneration: number;
  currentGeneration: number;
  playRequested: boolean;
  disposed: boolean;
}): PlayWaitSettlement {
  if (args.attemptGeneration !== args.currentGeneration) return 'cancelled';
  if (!args.playRequested) return 'cancelled';
  if (args.disposed) return 'disposed';
  return 'proceed';
}

export function playAttemptUiState(result: PlayAttemptResult): {
  playing: boolean;
  failureReason: string | null;
} {
  if (result === 'playing' || result === 'already-playing') {
    return { playing: true, failureReason: null };
  }
  if (result === 'cancelled') {
    return { playing: false, failureReason: null };
  }
  return { playing: false, failureReason: result };
}
