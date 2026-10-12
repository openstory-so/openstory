/**
 * `playbackClipsKey` must stay stable when only non-URL shot fields change.
 * SequencePlayer used to depend on `clips` identity; a shots refetch of the
 * same URLs disposed a playing engine (stuck at 0:00, #1284).
 */
import { describe, expect, it } from 'vitest';

import { playbackClipsKey } from '@openstory/stitch-player';
import {
  groupPlaybackShots,
  shotCues,
  shotIdAtSequenceTime,
  shotVideoSubtitlesVtt,
  subtitleTrackRevision,
  toPlaybackClips,
} from './playback-clips';
import type { AspectRatio } from '@/models/aspect-ratios';

const toClips = (
  shots: Parameters<typeof toPlaybackClips>[0],
  aspectRatio: AspectRatio = '16:9'
) => toPlaybackClips(shots, aspectRatio);

const shot = (url: string | null, extra?: { status?: string }) => ({
  id: `shot-${url ?? 'still'}`,
  shotNumber: null,
  video: url ? { url, status: extra?.status } : null,
  image: null,
  previewThumbnailUrl: null,
  durationMs: 5000,
  audioClips: null,
  dialogue: null,
  dialogueTiming: null,
});

describe('toPlaybackClips', () => {
  it('keeps completed clips and fills missing videos with timed stills', () => {
    expect(
      toClips([shot('/a.mp4'), shot(null), shot('/c.mp4'), shot(null)])
    ).toEqual([
      { videoUrl: '/a.mp4', posterUrl: null, cues: [] },
      expect.objectContaining({
        imageUrl: null,
        durationSeconds: 5,
        audioUrls: [],
      }),
      { videoUrl: '/c.mp4', posterUrl: null, cues: [] },
      expect.objectContaining({ imageUrl: null }),
    ]);
  });

  it('collapses consecutive packed-segment copies into one clip (#1510)', () => {
    expect(
      toClips([shot('/packed.mp4'), shot('/packed.mp4'), shot('/b.mp4')])
    ).toEqual([
      { videoUrl: '/packed.mp4', posterUrl: null, cues: [] },
      { videoUrl: '/b.mp4', posterUrl: null, cues: [] },
    ]);
  });
});

describe('playbackClipsKey', () => {
  it('is identical for two shot lists that only differ in non-url fields', () => {
    const a = toClips([
      shot('/a.mp4', { status: 'completed' }),
      shot(null),
      shot('/c.mp4', { status: 'completed' }),
    ]);
    const b = toClips([
      shot('/a.mp4', { status: 'completed' }),
      shot(null, { status: 'generating' }),
      shot('/c.mp4', { status: 'completed' }),
    ]);
    expect(playbackClipsKey(a)).toBe(playbackClipsKey(b));
    expect(a).not.toBe(b);
  });

  it('changes when a new clip lands', () => {
    const before = playbackClipsKey(toClips([shot('/a.mp4'), shot(null)]));
    const after = playbackClipsKey(toClips([shot('/a.mp4'), shot('/b.mp4')]));
    expect(before).not.toBe(after);
  });

  it('changes when a clip url is replaced', () => {
    expect(playbackClipsKey(toClips([shot('/a.mp4')]))).not.toBe(
      playbackClipsKey(toClips([shot('/a-v2.mp4')]))
    );
  });
});

it('does not collapse rendered clips across a missing shot', () => {
  expect(
    toClips([shot('/packed.mp4'), shot(null), shot('/packed.mp4')])
  ).toHaveLength(3);
});
it('prefers the selected still and plays its recorded take only when there is no video', () => {
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
      },
    ],
  };
  expect(toClips([input])[0]).toMatchObject({
    imageUrl: '/still.png',
    fallbackImageUrl: '/preview.png',
    audioUrls: ['/take.wav'],
  });
  expect(toClips([{ ...input, video: { url: '/render.mp4' } }])).toEqual([
    {
      videoUrl: '/render.mp4',
      posterUrl: '/still.png',
      cues: [],
    },
  ]);
});

it('uses the preview when there is no selected still', () => {
  expect(
    toClips([{ ...shot(null), previewThumbnailUrl: '/preview.png' }])[0]
  ).toMatchObject({
    imageUrl: '/preview.png',
    fallbackImageUrl: null,
  });
});
it('updates identity when a still, recording, duration or aspect ratio changes', () => {
  const input = { ...shot(null), image: { url: '/still.png' } };
  const key = playbackClipsKey(toClips([input]));
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
    expect(playbackClipsKey(toClips([changed]))).not.toBe(key);
  }
  expect(playbackClipsKey(toClips([input], '9:16'))).not.toBe(key);
});

describe('shotIdAtSequenceTime (#1771)', () => {
  const timed = (id: string, url: string | null, durationMs = 5000) => ({
    id,
    shotNumber: null,
    durationMs,
    video: url ? { url } : null,
  });
  // Clips: packed clip (s1 4s + s2 6s), still s3 (3s), clip s4 (5s).
  const shots = [
    timed('s1', '/packed.mp4', 4000),
    timed('s2', '/packed.mp4', 6000),
    timed('s3', null, 3000),
    timed('s4', '/d.mp4'),
  ];

  it('groups adjacent shots that share a clip', () => {
    expect(
      groupPlaybackShots(shots).map((group) => group.map((s) => s.id))
    ).toEqual([['s1', 's2'], ['s3'], ['s4']]);
  });

  it('splits a measured clip by the members’ own durations', () => {
    // The packed clip really runs 12s, the still 3s, the last clip 5.5s.
    const offsets = [0, 12, 15];
    expect(shotIdAtSequenceTime(shots, 0, offsets)).toBe('s1');
    expect(shotIdAtSequenceTime(shots, 4.7, offsets)).toBe('s1');
    expect(shotIdAtSequenceTime(shots, 4.9, offsets)).toBe('s2');
    expect(shotIdAtSequenceTime(shots, 12, offsets)).toBe('s3');
    expect(shotIdAtSequenceTime(shots, 15, offsets)).toBe('s4');
    expect(shotIdAtSequenceTime(shots, 99, offsets)).toBe('s4');
  });

  it('falls back to the plain estimate with no offsets', () => {
    expect(shotIdAtSequenceTime(shots, 10.5)).toBe('s3');
    expect(shotIdAtSequenceTime([], 0)).toBeUndefined();
  });
});

describe('shotCues (#1853)', () => {
  const dialogue = {
    presence: true,
    lines: [
      { character: 'Ann', line: 'Hello there.', tone: 'warm' },
      { character: '', line: 'Night falls.', tone: 'flat' },
    ],
  };
  const clip = {
    id: 'section',
    url: '/take.wav',
    token: 'DIALOGUE',
    durationSeconds: 6,
  };

  it('times each line by its reading, offset to the shot, in the spoken wording', () => {
    expect(
      shotCues(
        {
          dialogue,
          audioClips: [
            { ...clip, spokenLines: [{ index: 0, text: 'Hello.' }] },
          ],
          dialogueTiming: [
            { index: 0, startSeconds: 0.2, endSeconds: 1.4 },
            { index: 1, startSeconds: 1.6, endSeconds: 3 },
          ],
        },
        10,
        6
      )
    ).toEqual([
      { startSeconds: 10.2, endSeconds: 11.4, text: 'Ann: Hello.' },
      { startSeconds: 11.6, endSeconds: 13, text: 'Night falls.' },
    ]);
  });

  it('shows every line for the whole shot when there is no timing', () => {
    const whole = [
      {
        startSeconds: 0,
        endSeconds: 6,
        text: 'Ann: Hello there.\nNight falls.',
      },
    ];
    expect(
      shotCues({ dialogue, audioClips: [clip], dialogueTiming: null }, 0, 6)
    ).toEqual(whole);
    expect(
      shotCues({ dialogue, audioClips: null, dialogueTiming: [] }, 0, 6)
    ).toEqual(whole);
  });

  it('keeps a timed line and shows a later untimed line across the whole shot', () => {
    expect(
      shotCues(
        {
          dialogue,
          audioClips: null,
          dialogueTiming: [{ index: 0, startSeconds: 0.2, endSeconds: 1.4 }],
        },
        0,
        6
      )
    ).toEqual([
      { startSeconds: 0.2, endSeconds: 1.4, text: 'Ann: Hello there.' },
      { startSeconds: 0, endSeconds: 6, text: 'Night falls.' },
    ]);
  });

  it('clamps a timed line into the shot window', () => {
    expect(
      shotCues(
        {
          dialogue,
          audioClips: null,
          dialogueTiming: [
            { index: 0, startSeconds: 0.2, endSeconds: 8 },
            { index: 1, startSeconds: 6, endSeconds: 9 },
          ],
        },
        10,
        4
      )
    ).toEqual([
      { startSeconds: 10.2, endSeconds: 14, text: 'Ann: Hello there.' },
    ]);
  });

  it('is empty for a silent shot', () => {
    expect(
      shotCues(
        {
          dialogue: { presence: false, lines: [] },
          audioClips: null,
          dialogueTiming: null,
        },
        0,
        3
      )
    ).toEqual([]);
    expect(
      shotCues({ dialogue: null, audioClips: null, dialogueTiming: null }, 0, 3)
    ).toEqual([]);
  });

  it('places a packed clip’s cues at each member’s window and a still’s over its sound', () => {
    const a = { ...shot('/packed.mp4'), id: 'a', durationMs: 4000, dialogue };
    const b = {
      ...shot('/packed.mp4'),
      id: 'b',
      durationMs: 6000,
      dialogue: { presence: true, lines: dialogue.lines.slice(1) },
    };
    const [packed] = toClips([a, b]);
    expect(
      packed?.cues?.map((cue) => [cue.startSeconds, cue.endSeconds])
    ).toEqual([
      [0, 4],
      [4, 10],
    ]);
    const [still] = toClips([{ ...shot(null), dialogue, audioClips: [clip] }]);
    expect(still?.cues).toEqual([
      expect.objectContaining({ startSeconds: 0, endSeconds: 6 }),
    ]);
  });
});

describe('shotVideoSubtitlesVtt', () => {
  const dialogue = {
    presence: true,
    lines: [{ character: 'Ann', line: 'Hello there.', tone: 'warm' }],
  };

  it('is null when the shot has no lines', () => {
    expect(shotVideoSubtitlesVtt([shot('/a.mp4')])).toBeNull();
  });

  it('puts an untimed line across the shot on the file timeline', () => {
    const vtt = shotVideoSubtitlesVtt([
      { ...shot('/a.mp4'), dialogue, durationMs: 4000 },
    ]);
    expect(vtt).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nAnn: Hello there.\n'
    );
  });

  it('places each packed member in its own window', () => {
    const vtt = shotVideoSubtitlesVtt([
      { ...shot('/packed.mp4'), id: 'a', durationMs: 4000, dialogue },
      {
        ...shot('/packed.mp4'),
        id: 'b',
        durationMs: 2000,
        dialogue: {
          presence: true,
          lines: [{ character: 'Bo', line: 'Later.', tone: 'flat' }],
        },
      },
    ]);
    expect(vtt).toContain('00:00:00.000 --> 00:00:04.000\nAnn: Hello there.');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000\nBo: Later.');
  });
});

describe('subtitleTrackRevision', () => {
  it('changes when the cue text changes', () => {
    const a = subtitleTrackRevision(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n'
    );
    const b = subtitleTrackRevision(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nBye\n'
    );
    expect(a).not.toBe(b);
    expect(a).toBe(
      subtitleTrackRevision('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n')
    );
  });
});
