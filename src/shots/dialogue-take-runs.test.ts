import { describe, expect, it } from 'vitest';
import { dialogueTakeRuns } from './dialogue-take-runs';

const shot = (id: string, speechId?: string, source?: 'generated' | 'mic') => ({
  id,
  audioClips: speechId
    ? [
        {
          id: `section-${id}`,
          url: '',
          token: '',
          durationSeconds: 1,
          speechId,
          source,
        },
      ]
    : null,
});

const summary = (shots: ReturnType<typeof shot>[]) =>
  dialogueTakeRuns(shots).map((run) => [run.shots.map((s) => s.id), run.label]);

describe('dialogueTakeRuns', () => {
  it('brackets a scene recorded as one take', () => {
    expect(
      summary([shot('a', 'S2'), shot('b', 'S2'), shot('c', 'S2')])
    ).toEqual([[['a', 'b', 'c'], 'One take · 3 shots']]);
  });

  it('breaks out an older take, a mic take and a lone regeneration', () => {
    expect(
      summary([
        shot('a', 'S2'),
        shot('b', 'S1'),
        shot('c', 'S2'),
        shot('d', 'S3', 'mic'),
        shot('e', 'S4'),
        shot('f'),
      ])
    ).toEqual([
      [['a'], 'One take · 2 shots'],
      [['b'], 'Older take · 1 shot'],
      [['c'], 'One take · 2 shots'],
      [['d'], 'Your take'],
      [['e'], 'Regenerated alone'],
      [['f'], 'No audio yet'],
    ]);
  });
});
