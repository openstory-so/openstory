import { describe, expect, it } from 'vitest';

import { playAttemptUiState, settlePlayWait } from './play-attempt';

describe('settlePlayWait', () => {
  it('cancels a stale generation without treating it as the live request (#1284 pause-then-play)', () => {
    // The newer play() has already set playRequested; the older await must
    // not see that flag as "still requested" and start a second engine.
    expect(
      settlePlayWait({
        attemptGeneration: 1,
        currentGeneration: 2,
        playRequested: true,
        disposed: false,
      })
    ).toBe('cancelled');
  });

  it('cancels when the user paused the live attempt', () => {
    expect(
      settlePlayWait({
        attemptGeneration: 1,
        currentGeneration: 1,
        playRequested: false,
        disposed: false,
      })
    ).toBe('cancelled');
  });

  it('reports disposed when the live attempt was torn down', () => {
    expect(
      settlePlayWait({
        attemptGeneration: 1,
        currentGeneration: 1,
        playRequested: true,
        disposed: true,
      })
    ).toBe('disposed');
  });

  it('proceeds only for the live, still-requested attempt', () => {
    expect(
      settlePlayWait({
        attemptGeneration: 1,
        currentGeneration: 1,
        playRequested: true,
        disposed: false,
      })
    ).toBe('proceed');
  });
});

describe('playAttemptUiState', () => {
  it('keeps Pause for a successful or already-running play', () => {
    expect(playAttemptUiState('playing')).toEqual({
      playing: true,
      failureReason: null,
    });
    expect(playAttemptUiState('already-playing')).toEqual({
      playing: true,
      failureReason: null,
    });
  });

  it('does not treat a user-cancel as a failed start', () => {
    expect(playAttemptUiState('cancelled')).toEqual({
      playing: false,
      failureReason: null,
    });
  });

  it('surfaces disposed and not-ready as failures', () => {
    expect(playAttemptUiState('disposed')).toEqual({
      playing: false,
      failureReason: 'disposed',
    });
    expect(playAttemptUiState('not-ready')).toEqual({
      playing: false,
      failureReason: 'not-ready',
    });
  });
});
