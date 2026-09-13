import { describe, expect, test } from 'vitest';
import { collectDialogueResults } from './dialogue-audio-workflow';
import type { MotionAudioClip } from '@/platform/server/db/schema';

describe('collectDialogueResults', () => {
  const clip = (id: string): MotionAudioClip => ({
    id,
    url: `/r2/${id}.wav`,
    token: 'DIALOGUE',
    durationSeconds: 2,
    sourceKey: 'k',
  });
  const fulfilled = (
    shotId: string,
    id: string
  ): PromiseSettledResult<{ shotId: string; clips: MotionAudioClip[] }> => ({
    status: 'fulfilled',
    value: { shotId, clips: [clip(id)] },
  });
  const rejected = (
    reason: Error | string
  ): PromiseSettledResult<{ shotId: string; clips: MotionAudioClip[] }> => ({
    status: 'rejected',
    reason,
  });

  test('returns clips keyed by shot when every shot succeeded', () => {
    const clips = collectDialogueResults(
      [fulfilled('shot-a', 'c1'), fulfilled('shot-b', 'c2')],
      [{ shotId: 'shot-a' }, { shotId: 'shot-b' }]
    );
    expect(Object.keys(clips)).toEqual(['shot-a', 'shot-b']);
    expect(clips['shot-a']?.[0]?.id).toBe('c1');
  });

  test('throws naming the failed shot when any entry failed', () => {
    expect(() =>
      collectDialogueResults(
        [fulfilled('shot-a', 'c1'), rejected(new Error('elevenlabs 429'))],
        [{ shotId: 'shot-a' }, { shotId: 'shot-b' }]
      )
    ).toThrow(/1\/2.*shot-b: elevenlabs 429/);
  });
});
