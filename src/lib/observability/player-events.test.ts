import { describe, expect, it, vi } from 'vitest';

import {
  captureSequenceReadySeen,
  captureVideoPlay,
  captureVideoPlayFailed,
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

  it('captures sequence_ready_seen once the player can accept play', () => {
    const capture = vi.fn();
    captureSequenceReadySeen(
      { capture },
      { sequence_id: 'seq_1', scene_count: 6 }
    );
    expect(capture).toHaveBeenCalledWith('sequence_ready_seen', {
      sequence_id: 'seq_1',
      scene_count: 6,
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
    expect(() =>
      captureSequenceReadySeen(null, { sequence_id: 'seq_1', scene_count: 0 })
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
      captureVideoPlayFailed(
        { capture },
        { source: 'theatre', reason: 'disposed', sequence_id: 'seq_1' }
      )
    ).not.toThrow();
    expect(() =>
      captureSequenceReadySeen(
        { capture },
        { sequence_id: 'seq_1', scene_count: 3 }
      )
    ).not.toThrow();
  });
});
