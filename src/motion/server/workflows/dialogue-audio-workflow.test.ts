import { describe, expect, test } from 'vitest';
import {
  collectDialogueResults,
  planSceneAdoption,
} from './dialogue-audio-workflow';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import { dialogueClipSourceKey } from '@/motion/dialogue-tts';
import type { SceneVoicedLine } from '@/shots/shot-dialogue';

const voiced = (
  shotId: string,
  index: number,
  text: string
): SceneVoicedLine => ({
  index,
  shotId,
  token: 'DIALOGUE',
  voiceId: 'voice-1',
  text,
  tone: '',
  ttsModel: 'eleven_v3',
  character: 'Maya',
});

const clip = (
  id: string,
  lines: SceneVoicedLine[],
  recordingId?: string
): MotionAudioClip => ({
  id,
  url: `/r2/${id}.wav`,
  token: 'DIALOGUE',
  durationSeconds: 2,
  sourceKey: dialogueClipSourceKey(lines),
  ...(recordingId ? { recordingId } : {}),
});

describe('collectDialogueResults', () => {
  const fulfilled = (
    clips: Record<string, MotionAudioClip[]>
  ): PromiseSettledResult<Record<string, MotionAudioClip[]>> => ({
    status: 'fulfilled',
    value: clips,
  });

  test('merges every scene’s clips, keyed by shot', () => {
    const a = [voiced('shot-a', 0, 'Hi')];
    const b = [voiced('shot-b', 0, 'Bye')];
    const { clipsByShotId: clips } = collectDialogueResults(
      [
        fulfilled({ 'shot-a': [clip('c1', a, 't1')] }),
        fulfilled({ 'shot-b': [clip('c2', b, 't2')] }),
      ],
      [{ voiced: a }, { voiced: b }]
    );
    expect(Object.keys(clips)).toEqual(['shot-a', 'shot-b']);
    expect(clips['shot-a']?.[0]?.id).toBe('c1');
  });

  test('keeps the scenes that recorded and names a failed one by its first shot', () => {
    const a = [voiced('shot-a', 0, 'Hi')];
    const result = collectDialogueResults(
      [
        fulfilled({ 'shot-a': [clip('c1', a, 't1')] }),
        { status: 'rejected', reason: new Error('elevenlabs 429') },
      ],
      [{ voiced: a }, { voiced: [{ shotId: 'shot-b' }] }]
    );
    expect(Object.keys(result.clipsByShotId)).toEqual(['shot-a']);
    expect(result.failures).toEqual([
      { name: 'shot-b', reason: 'elevenlabs 429' },
    ]);
  });
});

describe('planSceneAdoption', () => {
  const lines = [voiced('shot-a', 0, 'Hi'), voiced('shot-b', 0, 'Bye')];
  const shotLines = (shotId: string) =>
    lines.filter((line) => line.shotId === shotId);

  test('adopts nobody when every shot’s clip still matches its lines', () => {
    const plan = planSceneAdoption({ voiced: lines, forceAdoptShotIds: [] }, [
      { id: 'shot-a', audioClips: [clip('c1', shotLines('shot-a'), 'rec-1')] },
      { id: 'shot-b', audioClips: [clip('c2', shotLines('shot-b'), 'rec-2')] },
    ]);
    // Sections of different recordings are fine: selection is per shot.
    expect(plan.adoptShotIds).toEqual([]);
    expect(Object.keys(plan.kept)).toEqual(['shot-a', 'shot-b']);
  });

  test('adopts only the shot whose lines moved — its neighbour keeps its clip', () => {
    const kept = clip('c2', shotLines('shot-b'), 'rec-1');
    const plan = planSceneAdoption({ voiced: lines, forceAdoptShotIds: [] }, [
      {
        id: 'shot-a',
        audioClips: [clip('c1', [voiced('shot-a', 0, 'Different')], 'rec-1')],
      },
      { id: 'shot-b', audioClips: [kept] },
    ]);
    expect(plan.adoptShotIds).toEqual(['shot-a']);
    expect(plan.kept).toEqual({ 'shot-b': [kept] });
  });

  test('adopts a forced shot whose clip still matches — "Regenerate dialogue"', () => {
    const kept = clip('c2', shotLines('shot-b'), 'rec-1');
    const plan = planSceneAdoption(
      { voiced: lines, forceAdoptShotIds: ['shot-a'] },
      [
        {
          id: 'shot-a',
          audioClips: [clip('c1', shotLines('shot-a'), 'rec-1')],
        },
        { id: 'shot-b', audioClips: [kept] },
      ]
    );
    expect(plan.adoptShotIds).toEqual(['shot-a']);
    expect(plan.kept).toEqual({ 'shot-b': [kept] });
  });

  test('keeps a matching clip from before recordings (no recordingId)', () => {
    const plan = planSceneAdoption({ voiced: lines, forceAdoptShotIds: [] }, [
      { id: 'shot-a', audioClips: [clip('c1', shotLines('shot-a'))] },
      { id: 'shot-b', audioClips: [clip('c2', shotLines('shot-b'))] },
    ]);
    expect(plan.adoptShotIds).toEqual([]);
  });

  test('adopts a shot with no clip, and one that is gone', () => {
    const plan = planSceneAdoption({ voiced: lines, forceAdoptShotIds: [] }, [
      { id: 'shot-a', audioClips: null },
    ]);
    expect(plan.adoptShotIds).toEqual(['shot-a', 'shot-b']);
    expect(plan.kept).toEqual({});
  });
});
