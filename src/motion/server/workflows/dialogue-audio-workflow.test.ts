import { describe, expect, test } from 'vitest';
import {
  collectDialogueResults,
  reusableSceneClips,
} from './dialogue-audio-workflow';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import { dialogueClipSourceKey } from '@/motion/dialogue-tts';
import type { SceneVoicedLine } from '@/shots/scene-dialogue';

const voiced = (
  shotId: string,
  index: number,
  lineIndex: number,
  text: string
): SceneVoicedLine => ({
  index,
  lineIndex,
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
  takeId?: string
): MotionAudioClip => ({
  id,
  url: `/r2/${id}.wav`,
  token: 'DIALOGUE',
  durationSeconds: 2,
  sourceKey: dialogueClipSourceKey(lines),
  ...(takeId ? { takeId } : {}),
});

describe('collectDialogueResults', () => {
  const fulfilled = (
    clips: Record<string, MotionAudioClip[]>
  ): PromiseSettledResult<Record<string, MotionAudioClip[]>> => ({
    status: 'fulfilled',
    value: clips,
  });

  test('merges every scene’s clips, keyed by shot', () => {
    const a = [voiced('shot-a', 0, 0, 'Hi')];
    const b = [voiced('shot-b', 0, 0, 'Bye')];
    const clips = collectDialogueResults(
      [
        fulfilled({ 'shot-a': [clip('c1', a, 't1')] }),
        fulfilled({ 'shot-b': [clip('c2', b, 't2')] }),
      ],
      [{ lines: a }, { lines: b }]
    );
    expect(Object.keys(clips)).toEqual(['shot-a', 'shot-b']);
    expect(clips['shot-a']?.[0]?.id).toBe('c1');
  });

  test('throws naming a failed scene by its first shot', () => {
    const a = [voiced('shot-a', 0, 0, 'Hi')];
    expect(() =>
      collectDialogueResults(
        [
          fulfilled({ 'shot-a': [clip('c1', a, 't1')] }),
          { status: 'rejected', reason: new Error('elevenlabs 429') },
        ],
        [{ lines: a }, { lines: [{ shotId: 'shot-b' }] }]
      )
    ).toThrow(/1\/2.*shot-b: elevenlabs 429/);
  });
});

describe('reusableSceneClips', () => {
  const lines = [voiced('shot-a', 0, 0, 'Hi'), voiced('shot-b', 0, 1, 'Bye')];
  const shotLines = (shotId: string) =>
    lines.filter((line) => line.shotId === shotId);

  test('reuses clips from one take that still match every shot', () => {
    const reuse = reusableSceneClips({ voiced: lines }, [
      { id: 'shot-a', audioClips: [clip('c1', shotLines('shot-a'), 'take-1')] },
      { id: 'shot-b', audioClips: [clip('c2', shotLines('shot-b'), 'take-1')] },
    ]);
    expect(Object.keys(reuse ?? {})).toEqual(['shot-a', 'shot-b']);
  });

  test('refuses when the shots hold slices of different takes', () => {
    expect(
      reusableSceneClips({ voiced: lines }, [
        {
          id: 'shot-a',
          audioClips: [clip('c1', shotLines('shot-a'), 'take-1')],
        },
        {
          id: 'shot-b',
          audioClips: [clip('c2', shotLines('shot-b'), 'take-2')],
        },
      ])
    ).toBeNull();
  });

  test('refuses a per-shot clip from before scene takes (no takeId)', () => {
    expect(
      reusableSceneClips({ voiced: lines }, [
        { id: 'shot-a', audioClips: [clip('c1', shotLines('shot-a'))] },
        { id: 'shot-b', audioClips: [clip('c2', shotLines('shot-b'))] },
      ])
    ).toBeNull();
  });

  test('refuses when a shot’s lines moved', () => {
    expect(
      reusableSceneClips({ voiced: lines }, [
        {
          id: 'shot-a',
          audioClips: [
            clip('c1', [voiced('shot-a', 0, 0, 'Different')], 'take-1'),
          ],
        },
        {
          id: 'shot-b',
          audioClips: [clip('c2', shotLines('shot-b'), 'take-1')],
        },
      ])
    ).toBeNull();
  });
});
