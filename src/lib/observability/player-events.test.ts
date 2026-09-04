import { describe, expect, it, vi } from 'vitest';

import {
  captureSequenceReadySeen,
  captureVideoPlay,
  captureVideoPlayFailed,
  captureVideoWatched,
  createPlaybackTracker,
} from './player-events';

describe('player events', () => {
  it('captures video_play with the player source', () => {
    const capture = vi.fn();
    captureVideoPlay(
      { capture },
      { source: 'canvas', sequence_id: 'seq_1', shot_id: 'shot_1' }
    );
    expect(capture).toHaveBeenCalledWith('video_play', {
      source: 'canvas',
      sequence_id: 'seq_1',
      shot_id: 'shot_1',
    });
  });

  it('captures video_play_failed with a reason', () => {
    const capture = vi.fn();
    captureVideoPlayFailed(
      { capture },
      { source: 'theatre', reason: 'engine_disposed', sequence_id: 'seq_1' }
    );
    expect(capture).toHaveBeenCalledWith('video_play_failed', {
      source: 'theatre',
      reason: 'engine_disposed',
      sequence_id: 'seq_1',
    });
  });

  it('captures video_watched and sequence_ready_seen', () => {
    const capture = vi.fn();
    captureVideoWatched(
      { capture },
      { source: 'theatre', seconds_watched: 4.2, completed: false }
    );
    captureSequenceReadySeen(
      { capture },
      {
        sequence_id: 'seq_1',
        first_sequence_for_team: true,
        seconds_since_generate: 90,
      }
    );
    expect(capture).toHaveBeenCalledWith('video_watched', {
      source: 'theatre',
      seconds_watched: 4.2,
      completed: false,
    });
    expect(capture).toHaveBeenCalledWith('sequence_ready_seen', {
      sequence_id: 'seq_1',
      first_sequence_for_team: true,
      seconds_since_generate: 90,
    });
  });

  it('is a no-op when posthog is missing so play never depends on analytics', () => {
    expect(() => captureVideoPlay(null, { source: 'modal' })).not.toThrow();
    expect(() =>
      captureVideoPlayFailed(undefined, {
        source: 'canvas',
        reason: 'media_error',
      })
    ).not.toThrow();
  });

  it('swallows capture() throws so analytics cannot flip play state', () => {
    const capture = vi.fn(() => {
      throw new Error('posthog down');
    });
    expect(() =>
      captureVideoPlay({ capture }, { source: 'theatre', sequence_id: 'seq_1' })
    ).not.toThrow();
    expect(() =>
      captureVideoWatched(
        { capture },
        { source: 'theatre', seconds_watched: 1, completed: true }
      )
    ).not.toThrow();
  });
});

describe('createPlaybackTracker', () => {
  it('sums timeupdate deltas, ignores seeks, and infers completion', () => {
    const tracker = createPlaybackTracker({ onStall: vi.fn() });
    tracker.setDuration(10);
    tracker.start();
    tracker.tick(0);
    tracker.tick(0.5);
    tracker.tick(1.0);
    tracker.tick(8.0); // seek — not watched
    tracker.tick(8.5);
    expect(tracker.stop()).toEqual({ seconds_watched: 1.5, completed: false });
    // Nothing in progress → nothing to report (no double pause/ended event).
    expect(tracker.stop()).toBeNull();

    tracker.start();
    tracker.tick(9.2);
    tracker.tick(9.9);
    expect(tracker.stop()).toEqual({ seconds_watched: 0.7, completed: true });
  });

  it('reports a stall when playback never advances, and not when it does', () => {
    vi.useFakeTimers();
    try {
      const onStall = vi.fn();
      const tracker = createPlaybackTracker({ onStall });
      tracker.start();
      tracker.tick(0);
      vi.advanceTimersByTime(3_000);
      expect(onStall).toHaveBeenCalledTimes(1);

      tracker.start();
      tracker.tick(0);
      tracker.tick(0.1);
      vi.advanceTimersByTime(3_000);
      expect(onStall).toHaveBeenCalledTimes(1);

      tracker.start();
      tracker.stop(false);
      vi.advanceTimersByTime(3_000);
      expect(onStall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
