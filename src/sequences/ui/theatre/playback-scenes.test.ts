/**
 * `scenePlaybackKey` must stay stable when only non-URL shot fields change.
 * SequencePlayer used to depend on `scenes` identity; a shots refetch of the
 * same URLs disposed a playing engine (stuck at 0:00, #1284).
 */
import { describe, expect, it } from 'vitest';

import { scenePlaybackKey, toPlaybackScenes } from './playback-scenes';

const shot = (url: string | null, extra?: { status?: string }) => ({
  video: url ? { url, status: extra?.status } : null,
  image: null,
  previewThumbnailUrl: null,
  durationMs: 5000,
  audioClips: null,
  dialogue: null,
});

describe('toPlaybackScenes', () => {
  it('keeps completed clips and fills missing videos with timed stills', () => {
    expect(
      toPlaybackScenes([shot('/a.mp4'), shot(null), shot('/c.mp4'), shot(null)])
    ).toEqual([
      { orderIndex: 0, videoUrl: '/a.mp4' },
      expect.objectContaining({
        orderIndex: 1,
        imageUrl: null,
        durationSeconds: 5,
        audioUrls: [],
      }),
      { orderIndex: 2, videoUrl: '/c.mp4' },
      expect.objectContaining({ orderIndex: 3, imageUrl: null }),
    ]);
  });

  it('collapses consecutive packed-segment copies into one clip (#1510)', () => {
    expect(
      toPlaybackScenes([
        shot('/packed.mp4'),
        shot('/packed.mp4'),
        shot('/b.mp4'),
      ])
    ).toEqual([
      { orderIndex: 0, videoUrl: '/packed.mp4' },
      { orderIndex: 1, videoUrl: '/b.mp4' },
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

it('does not collapse rendered clips across a missing shot', () => {
  expect(
    toPlaybackScenes([shot('/packed.mp4'), shot(null), shot('/packed.mp4')])
  ).toHaveLength(3);
});
it('prefers the storyboard, includes selected dialogue and recorded wording only for stills', () => {
  const input = {
    ...shot(null),
    previewThumbnailUrl: '/preview.png',
    image: { url: '/still.png' },
    audioClips: [
      {
        id: 'take',
        url: '/take.wav',
        token: 'DIALOGUE',
        durationSeconds: 2,
        spokenLines: [{ index: 0, text: 'Hi' }],
      },
    ],
    dialogue: {
      presence: true,
      lines: [{ character: 'Ana', line: 'Hello there', tone: '' }],
    },
  };
  expect(toPlaybackScenes([input])[0]).toMatchObject({
    imageUrl: '/preview.png',
    fallbackImageUrl: '/still.png',
    audioUrls: ['/take.wav'],
    captions: ['Ana: Hi'],
  });
  expect(
    toPlaybackScenes([{ ...input, video: { url: '/render.mp4' } }])
  ).toEqual([{ orderIndex: 0, videoUrl: '/render.mp4' }]);
});
it('updates identity when a still, recording, duration or aspect ratio changes', () => {
  const input = { ...shot(null), image: { url: '/still.png' } };
  const key = scenePlaybackKey(toPlaybackScenes([input]));
  for (const changed of [
    { ...input, image: { url: '/new.png' } },
    { ...input, durationMs: 8000 },
    {
      ...input,
      audioClips: [
        { id: 'take', url: '/take.wav', token: 'DIALOGUE', durationSeconds: 2 },
      ],
    },
  ]) {
    expect(scenePlaybackKey(toPlaybackScenes([changed]))).not.toBe(key);
  }
  expect(scenePlaybackKey(toPlaybackScenes([input], '9:16'))).not.toBe(key);
});
