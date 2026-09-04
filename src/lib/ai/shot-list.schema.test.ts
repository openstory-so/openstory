import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_SCENE_DURATION_SECONDS,
  MAX_SHOTS_PER_SCENE,
  MIN_SHOT_DURATION_SECONDS,
  sceneWithShotsResultSchema,
  sceneWithShotsSchema,
  shotListPassResultSchema,
  shotSpecSchema,
} from './shot-list.schema';

/**
 * Count union-typed parameters in the compiled JSON Schema grammar. Anthropic
 * caps strict structured output at 16; every `.optional()` / `.catch()` /
 * `.nullish()` compiles to an `anyOf` ([T, null]) union. This shot-list schema
 * MUST stay union-free so it never eats into the budget when sent to the model.
 */
function countUnions(schema: z.ZodType): number {
  const json = JSON.stringify(
    z.toJSONSchema(schema, { unrepresentable: 'any' })
  );
  return (json.match(/"anyOf"/g) ?? []).length;
}

describe('shot-list schema — union budget', () => {
  it('shotSpecSchema compiles to ZERO union-typed params', () => {
    expect(countUnions(shotSpecSchema)).toBe(0);
  });

  it('sceneWithShotsSchema compiles to ZERO union-typed params', () => {
    expect(countUnions(sceneWithShotsSchema)).toBe(0);
  });

  it('sceneWithShotsResultSchema compiles to ZERO union-typed params (well under the 16 cap)', () => {
    const unions = countUnions(sceneWithShotsResultSchema);
    expect(unions).toBe(0);
    expect(unions).toBeLessThanOrEqual(16);
  });

  it('shotListPassResultSchema compiles to ZERO union-typed params', () => {
    expect(countUnions(shotListPassResultSchema)).toBe(0);
  });

  it('has no optional/nullish/catch fields (all required, emptyable)', () => {
    const json = JSON.stringify(
      z.toJSONSchema(sceneWithShotsResultSchema, { unrepresentable: 'any' })
    );
    // A union-free schema never emits a "null" type branch.
    expect(json).not.toContain('"type":"null"');
  });
});

describe('shot-list schema — constraints', () => {
  it('caps a scene at the multi-shot render ceiling', () => {
    expect(MAX_SCENE_DURATION_SECONDS).toBe(15);
    expect(MIN_SHOT_DURATION_SECONDS).toBe(3);
    expect(MAX_SHOTS_PER_SCENE).toBe(5);
  });

  it('parses a single-shot scene (short-scene regression)', () => {
    const result = sceneWithShotsSchema.safeParse({
      sceneId: 's1',
      sceneNumber: 1,
      originalScript: { extract: 'A man walks in.', dialogue: [] },
      metadata: {
        title: 'Entrance',
        durationSeconds: 4,
        location: 'INT. OFFICE - DAY',
        timeOfDay: 'day',
        storyBeat: 'introduction',
      },
      continuity: {
        characterTags: ['man'],
        environmentTag: 'office',
        elementTags: [],
        colorPalette: 'warm',
        lightingSetup: 'soft daylight',
        styleTag: 'cinematic',
      },
      dialoguePresent: false,
      continuousFromPrevious: false,
      shots: [
        {
          shotNumber: 1,
          framing: {
            shotSize: 'wide',
            angle: 'eye level',
            composition: 'centered',
            subjectStartState: 'man stepping through the doorway',
          },
          action: 'he walks toward the desk',
          cameraMovement: { move: 'dolly', pacing: 'slow' },
          soundCue: 'footsteps',
          durationSeconds: 4,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shots).toHaveLength(1);
  });

  it('parses a multi-shot scene', () => {
    const shot = {
      shotNumber: 1,
      framing: {
        shotSize: 'medium',
        angle: 'eye level',
        composition: 'rule of thirds',
        subjectStartState: 'standing',
      },
      action: 'turns',
      cameraMovement: { move: 'pan', pacing: 'smooth' } as const,
      soundCue: '',
      durationSeconds: 3,
    };
    const result = sceneWithShotsSchema.safeParse({
      sceneId: 's2',
      sceneNumber: 2,
      originalScript: { extract: 'x', dialogue: [] },
      metadata: {
        title: 't',
        durationSeconds: 9,
        location: 'l',
        timeOfDay: 'night',
        storyBeat: 'b',
      },
      continuity: {
        characterTags: [],
        environmentTag: '',
        elementTags: [],
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
      dialoguePresent: false,
      continuousFromPrevious: true,
      shots: [shot, { ...shot, shotNumber: 2 }, { ...shot, shotNumber: 3 }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shots).toHaveLength(3);
  });

  it('rejects pacing adverbs outside slow/smooth/gradual', () => {
    const result = shotSpecSchema.shape.cameraMovement.safeParse({
      move: 'pan',
      pacing: 'fast',
    });
    expect(result.success).toBe(false);
  });

  it('enforces the 1..MAX shots-per-scene bound at parse time', () => {
    const validShot = {
      shotNumber: 1,
      framing: {
        shotSize: 'medium',
        angle: 'eye level',
        composition: 'centered',
        subjectStartState: 'standing',
      },
      action: 'turns',
      cameraMovement: { move: 'pan', pacing: 'smooth' as const },
      soundCue: '',
      durationSeconds: 3,
    };
    const shots = sceneWithShotsSchema.shape.shots;
    // Empty (zero shots) is rejected — a scene must own at least one shot.
    expect(shots.safeParse([]).success).toBe(false);
    // One shot is fine.
    expect(shots.safeParse([validShot]).success).toBe(true);
    // Over the ceiling is rejected (minItems/maxItems, still union-free).
    const tooMany = Array.from({ length: MAX_SHOTS_PER_SCENE + 1 }, (_, i) => ({
      ...validShot,
      shotNumber: i + 1,
    }));
    expect(shots.safeParse(tooMany).success).toBe(false);
  });
});
