import { describe, expect, it } from 'vitest';

import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Shot } from '@/platform/server/db/schema';
import { asStub } from '@/test/as-stub';

import { loadShotSubtitlesVtt } from './shot-subtitles';

const line = { character: 'Ann', line: 'Hello there.', tone: 'warm' };

function shot(id: string, extra?: Partial<Shot>): Shot {
  return asStub<Shot>({
    id,
    sceneId: 'scene-1',
    shotNumber: 1,
    durationMs: 4000,
    renderSegmentId: 'segment-1',
    audioClips: null,
    deletedAt: null,
    ...extra,
  });
}

function db(shots: Shot[], withLines = true): ScopedDb {
  return asStub<ScopedDb>({
    shots: { listBySequence: async () => shots },
    shotDialogue: {
      getSelectedBySequence: async () =>
        withLines
          ? shots.map((row) => ({ shotId: row.id, lines: [line] }))
          : [],
      getSelectedSectionsBySequence: async () => [],
    },
    shotPromptVersions: {
      getSelectedMotionByShots: async () => new Map(),
    },
    scenes: { listBySequence: async () => [] },
    sceneScriptVersions: { listSelectedBySequence: async () => [] },
  });
}

describe('loadShotSubtitlesVtt', () => {
  it('returns the shot’s lines as WebVTT', async () => {
    const vtt = await loadShotSubtitlesVtt(db([shot('a')]), 'seq', 'a');
    expect(vtt).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nAnn: Hello there.\n'
    );
  });

  it('places a packed partner after the first shot’s window', async () => {
    const vtt = await loadShotSubtitlesVtt(
      db([
        shot('a'),
        shot('b', {
          shotNumber: 2,
          durationMs: 2000,
        }),
      ]),
      'seq',
      'b'
    );
    expect(vtt).toContain('00:00:00.000 --> 00:00:04.000\nAnn: Hello there.');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000\nAnn: Hello there.');
  });

  it('is null when the shot has nothing to say', async () => {
    expect(
      await loadShotSubtitlesVtt(db([shot('a')], false), 'seq', 'a')
    ).toBeNull();
  });

  it('rejects a shot that is not in the sequence', async () => {
    await expect(
      loadShotSubtitlesVtt(db([shot('a')]), 'seq', 'missing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
