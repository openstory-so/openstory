/**
 * Storyboard auto-motion batch shots must pin the still + motion-prompt
 * version ids the render actually consumed (#1380). Omitting them stamps
 * `video_variants.manifest` with nulls, so every clip is born Stale.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL } from '@/models/models';
import {
  dialogueClipSourceKey,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import type { MotionPrompt, Scene } from '@/shots/scene-analysis.schema';
import type {
  CharacterMinimal,
  SequenceLocationMinimal,
} from '@/platform/server/db/schema';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import { buildStoryboardMotionBatchShots } from './storyboard-motion-batch-shots';

function scene(
  sceneId: string,
  durationSeconds = 5,
  extra: Record<string, unknown> = {}
): Scene {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only reads sceneId, metadata.durationSeconds, continuity.characterTags
  return {
    sceneId,
    sceneNumber: 1,
    originalScript: { extract: 'a beat', lineNumber: 1 },
    metadata: { title: sceneId, durationSeconds },
    continuity: { characterTags: [] },
    ...extra,
  } as unknown as Scene;
}

const prompt = (fullPrompt: string): MotionPrompt => ({
  fullPrompt,
  dialogue: { presence: false, lines: [] },
  audio: { ambientSound: '', soundEffects: [] },
});

describe('buildStoryboardMotionBatchShots', () => {
  it('pins frameVersionId and motionPromptVersionId on each shot', () => {
    const shots = buildStoryboardMotionBatchShots({
      scenes: [scene('sc-1'), scene('sc-2')],
      shotMapping: [
        { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
        { analysisSceneId: 'sc-2', shotId: 'shot-2', frameId: 'fr-2' },
      ],
      imageUrls: ['https://cdn/a.png', 'https://cdn/b.png'],
      frameVersionIds: ['fv-1', 'fv-2'],
      motionPromptsBySceneId: {
        'sc-1': prompt('pan across the dock'),
        'sc-2': prompt('push in on the door'),
      },
      motionPromptVersionIdsBySceneId: {
        'sc-1': 'mpv-1',
        'sc-2': 'mpv-2',
      },
      videoModel: DEFAULT_VIDEO_MODEL,
      aspectRatio: '16:9',
      characters: [],
      elements: [],
    });

    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({
      shotId: 'shot-1',
      sceneId: 'sc-1',
      imageUrl: 'https://cdn/a.png',
      frameVersionId: 'fv-1',
      motionPromptVersionId: 'mpv-1',
    });
    expect(shots[1]).toMatchObject({
      shotId: 'shot-2',
      imageUrl: 'https://cdn/b.png',
      frameVersionId: 'fv-2',
      motionPromptVersionId: 'mpv-2',
    });
  });

  it('skips a scene whose still failed rather than throwing', () => {
    const shots = buildStoryboardMotionBatchShots({
      scenes: [scene('sc-1'), scene('sc-2')],
      shotMapping: [
        { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
        { analysisSceneId: 'sc-2', shotId: 'shot-2', frameId: 'fr-2' },
      ],
      imageUrls: [null, 'https://cdn/b.png'],
      frameVersionIds: [null, 'fv-2'],
      motionPromptsBySceneId: {
        'sc-2': prompt('push in on the door'),
      },
      motionPromptVersionIdsBySceneId: { 'sc-2': 'mpv-2' },
      videoModel: DEFAULT_VIDEO_MODEL,
      aspectRatio: '16:9',
      characters: [],
      elements: [],
    });

    expect(shots).toHaveLength(1);
    expect(shots[0]?.shotId).toBe('shot-2');
    expect(shots[0]?.frameVersionId).toBe('fv-2');
    expect(shots[0]?.motionPromptVersionId).toBe('mpv-2');
  });

  it('emits one clip per mapping row, using each shot duration (#1486)', () => {
    const shots = buildStoryboardMotionBatchShots({
      scenes: [
        scene('sc-1', 13, {
          shots: [
            {
              shotNumber: 1,
              framing: {
                shotSize: 'wide',
                angle: 'eye level',
                composition: '',
                subjectStartState: '',
              },
              action: 'opens the door',
              cameraMovement: { move: 'static', pacing: 'slow' },
              soundCue: '',
              dialogue: [],
              durationSeconds: 7,
            },
            {
              shotNumber: 2,
              framing: {
                shotSize: 'medium',
                angle: 'eye level',
                composition: '',
                subjectStartState: '',
              },
              action: 'cut to the hallway',
              cameraMovement: { move: 'truck', pacing: 'smooth' },
              soundCue: '',
              dialogue: [],
              durationSeconds: 6,
            },
          ],
        }),
      ],
      shotMapping: [
        {
          analysisSceneId: 'sc-1',
          shotId: 'shot-1',
          frameId: 'fr-1',
          shotNumber: 1,
        },
        {
          analysisSceneId: 'sc-1',
          shotId: 'shot-1b',
          frameId: 'fr-1b',
          shotNumber: 2,
        },
      ],
      imageUrls: ['https://cdn/a.png', 'https://cdn/b.png'],
      frameVersionIds: ['fv-1', 'fv-1b'],
      motionPromptsBySceneId: {
        'sc-1': prompt('pan across the dock'),
      },
      motionPromptsByShotId: {
        'shot-1': prompt('pan across the dock'),
        'shot-1b': prompt('cut to the hallway. Camera: smooth truck'),
      },
      motionPromptVersionIdsBySceneId: { 'sc-1': 'mpv-1' },
      motionPromptVersionIdsByShotId: {
        'shot-1': 'mpv-1',
        'shot-1b': 'mpv-1b',
      },
      videoModel: DEFAULT_VIDEO_MODEL,
      aspectRatio: '16:9',
      characters: [],
      elements: [],
    });

    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({
      shotId: 'shot-1',
      imageUrl: 'https://cdn/a.png',
      frameVersionId: 'fv-1',
      motionPromptVersionId: 'mpv-1',
      duration: 7,
    });
    expect(shots[1]).toMatchObject({
      shotId: 'shot-1b',
      imageUrl: 'https://cdn/b.png',
      frameVersionId: 'fv-1b',
      motionPromptVersionId: 'mpv-1b',
      duration: 6,
    });
  });

  it('throws when a still exists but the motion prompt does not', () => {
    expect(() =>
      buildStoryboardMotionBatchShots({
        scenes: [scene('sc-1')],
        shotMapping: [
          { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
        ],
        imageUrls: ['https://cdn/a.png'],
        frameVersionIds: ['fv-1'],
        motionPromptsBySceneId: {},
        motionPromptVersionIdsBySceneId: {},
        videoModel: DEFAULT_VIDEO_MODEL,
        aspectRatio: '16:9',
        characters: [],
        elements: [],
      })
    ).toThrow(WorkflowValidationError);
  });

  it('attaches matching References-stage dialogue clips (#1554)', () => {
    const dialogue = {
      presence: true as const,
      lines: [{ character: 'SARAH', line: 'Stay down.', tone: 'urgent' }],
    };
    const motion: MotionPrompt = {
      fullPrompt: 'two shot',
      dialogue,
      audio: { ambientSound: '', soundEffects: [] },
    };
    const voiced = voicedDialogueLines(dialogue, [
      { name: 'SARAH', voiceId: 'voice-sarah' },
    ]);
    const clip = {
      id: 'clip-1',
      url: '/r2/a.wav',
      token: 'DIALOGUE',
      durationSeconds: 2.2,
      sourceKey: dialogueClipSourceKey(voiced),
    };
    const shots = buildStoryboardMotionBatchShots({
      scenes: [scene('sc-1')],
      shotMapping: [
        { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
      ],
      imageUrls: ['https://cdn/a.png'],
      frameVersionIds: ['fv-1'],
      motionPromptsBySceneId: { 'sc-1': motion },
      motionPromptVersionIdsBySceneId: { 'sc-1': 'mpv-1' },
      videoModel: 'seedance_v2_5',
      aspectRatio: '16:9',
      characters: [
        {
          id: 'c1',
          characterId: 'char_001',
          name: 'SARAH',
          sheetImageUrl: null,
          sheetStatus: 'completed',
          sheetInputHash: null,
          selectedSheetVersionId: null,
          physicalDescription: null,
          voiceOnly: false,
          consistencyTag: 'sarah',
          voiceId: 'voice-sarah',
        },
      ],
      elements: [],
      dialogueClipsByShotId: { 'shot-1': [clip] },
    });
    expect(shots[0]?.audioClips).toEqual([clip]);
    expect(shots[0]?.voicedLines).toHaveLength(1);
  });
});

describe('buildStoryboardMotionBatchShots — reference-only', () => {
  const referenceOnlyArgs = {
    scenes: [scene('sc-1'), scene('sc-2')],
    shotMapping: [
      { analysisSceneId: 'sc-1', shotId: 'shot-1', frameId: 'fr-1' },
      { analysisSceneId: 'sc-2', shotId: 'shot-2', frameId: 'fr-2' },
    ],
    // No image pass ran, so both slot arrays are empty.
    imageUrls: [] as (string | null)[],
    frameVersionIds: [] as (string | null)[],
    motionPromptsBySceneId: {
      'sc-1': prompt('pan across the dock'),
      'sc-2': prompt('push in on the door'),
    },
    motionPromptVersionIdsBySceneId: { 'sc-1': 'mpv-1', 'sc-2': 'mpv-2' },
    videoModel: DEFAULT_VIDEO_MODEL,
    aspectRatio: '16:9' as const,
    characters: [],
    elements: [],
    referenceOnly: true,
  };

  it('keeps every shot despite there being no stills', () => {
    const shots = buildStoryboardMotionBatchShots(referenceOnlyArgs);

    expect(shots).toHaveLength(2);
    expect(shots.map((s) => s.shotId)).toEqual(['shot-1', 'shot-2']);
  });

  it('carries the flag and no still, leaving frameVersionId null', () => {
    const [shot] = buildStoryboardMotionBatchShots(referenceOnlyArgs);

    expect(shot?.referenceOnly).toBe(true);
    expect(shot?.imageUrl).toBeUndefined();
    // A null frameVersionId in the manifest is the documented encoding of
    // "reference-driven shot with no dedicated first frame".
    expect(shot?.frameVersionId).toBeNull();
  });

  it('attaches the location sheet first when there is no still', () => {
    const [shot] = buildStoryboardMotionBatchShots({
      ...referenceOnlyArgs,
      scenes: [
        scene('sc-1', 5, {
          continuity: { characterTags: ['Alice'], environmentTag: 'Rooftop' },
          metadata: { title: 'sc-1', durationSeconds: 5, location: 'Rooftop' },
        }),
      ],
      characters: [
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- matcher reads name/tag + sheet url only
        {
          id: 'ch-alice',
          characterId: 'alice',
          name: 'Alice',
          consistencyTag: 'alice',
          sheetImageUrl: 'https://cdn/alice.png',
          sheetStatus: 'completed',
        } as unknown as CharacterMinimal,
      ],
      locations: [
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- matcher reads name/tag + reference url only
        {
          id: 'loc-rooftop',
          locationId: 'rooftop',
          name: 'Rooftop',
          referenceImageUrl: 'https://cdn/rooftop.png',
          referenceStatus: 'completed',
          consistencyTag: 'rooftop',
        } as unknown as SequenceLocationMinimal,
      ],
    });

    // Location leads: the reference budget is spent in order, so the set
    // survives a cast that overflows it.
    expect(shot?.referenceImages?.map((r) => r.role)).toEqual([
      'location',
      'character',
    ]);
    expect(shot?.referenceImages?.[0]?.referenceImageUrl).toBe(
      'https://cdn/rooftop.png'
    );
  });

  it('leaves the location sheet out when the mode is off', () => {
    const [shot] = buildStoryboardMotionBatchShots({
      ...referenceOnlyArgs,
      imageUrls: ['https://cdn/a.png', 'https://cdn/b.png'],
      frameVersionIds: ['fv-1', 'fv-2'],
      referenceOnly: false,
      scenes: [
        scene('sc-1', 5, {
          continuity: { characterTags: [], environmentTag: 'Rooftop' },
          metadata: { title: 'sc-1', durationSeconds: 5, location: 'Rooftop' },
        }),
      ],
      locations: [
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- matcher reads name/tag + reference url only
        {
          id: 'loc-rooftop',
          locationId: 'rooftop',
          name: 'Rooftop',
          referenceImageUrl: 'https://cdn/rooftop.png',
          referenceStatus: 'completed',
          consistencyTag: 'rooftop',
        } as unknown as SequenceLocationMinimal,
      ],
    });

    expect(shot?.referenceImages ?? []).toEqual([]);
  });

  it('still drops a shot whose still failed when the mode is off', () => {
    const shots = buildStoryboardMotionBatchShots({
      ...referenceOnlyArgs,
      imageUrls: ['https://cdn/a.png', null],
      frameVersionIds: ['fv-1', null],
      referenceOnly: false,
    });

    expect(shots).toHaveLength(1);
    expect(shots[0]?.shotId).toBe('shot-1');
  });
});
