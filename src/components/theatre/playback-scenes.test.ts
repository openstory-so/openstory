/**
 * `scenePlaybackKey` must stay stable when only non-URL shot fields change.
 * SequencePlayer used to depend on `scenes` identity; a shots refetch of the
 * same URLs disposed a playing engine (stuck at 0:00, #1284).
 */
import { describe, expect, it } from 'vitest';

import { scenePlaybackKey, toPlaybackScenes } from './playback-scenes';

const shot = (url: string | null, extra?: { status?: string }) => ({
  video: url ? { url, status: extra?.status } : null,
});

describe('toPlaybackScenes', () => {
  it('keeps completed clips in list order and drops shots with no video url', () => {
    expect(
      toPlaybackScenes([
        shot('/a.mp4'),
        shot(null),
        shot('/c.mp4'),
        { video: { url: undefined } },
      ])
    ).toEqual([
      { orderIndex: 0, videoUrl: '/a.mp4' },
      { orderIndex: 1, videoUrl: '/c.mp4' },
    ]);
  });
});

describe('scenePlaybackKey', () => {
  it('is identical for two shot lists that only differ in non-url fields', () => {
    const a = toPlaybackScenes([
      shot('/a.mp4', { status: 'completed' }),
      shot(null),
      shot('/c.mp4', { status: 'completed' }),
    ]);
    const b = toPlaybackScenes([
      shot('/a.mp4', { status: 'completed' }),
      shot(null, { status: 'generating' }),
      shot('/c.mp4', { status: 'completed' }),
    ]);
    expect(scenePlaybackKey(a)).toBe(scenePlaybackKey(b));
    expect(a).not.toBe(b);
  });

  it('changes when a new clip lands', () => {
    const before = scenePlaybackKey(
      toPlaybackScenes([shot('/a.mp4'), shot(null)])
    );
    const after = scenePlaybackKey(
      toPlaybackScenes([shot('/a.mp4'), shot('/b.mp4')])
    );
    expect(before).not.toBe(after);
  });

  it('changes when a clip url is replaced', () => {
    expect(scenePlaybackKey(toPlaybackScenes([shot('/a.mp4')]))).not.toBe(
      scenePlaybackKey(toPlaybackScenes([shot('/a-v2.mp4')]))
    );
  });
});
