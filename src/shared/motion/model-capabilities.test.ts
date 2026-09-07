import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
} from '@/shared/ai/models';
import { ASPECT_RATIOS } from '@/shared/constants/aspect-ratios';
import { MOTION_INPUT_SCHEMAS, MOTION_JSON_SCHEMAS } from './endpoint-map';
import { getDurationValues, numericOf } from './motion-transform';
import { motionResolutionTokens } from './build-model-input';
import {
  durationGridForModel,
  MOTION_ASPECT_RATIOS,
  MOTION_DURATION_GRID,
  MOTION_RESOLUTION_TOKENS,
  modelSupportsAspectRatio,
} from './model-capabilities';
import { z } from 'zod';

describe('baked motion capabilities stay in lockstep with fal schemas', () => {
  const keys = Object.keys(IMAGE_TO_VIDEO_MODELS).filter(
    isValidImageToVideoModel
  );

  it('duration grids match getDurationValues on the i2v schema', () => {
    for (const key of keys) {
      const id = IMAGE_TO_VIDEO_MODELS[key].id;
      const fromSchema = [
        ...new Set(
          getDurationValues(MOTION_JSON_SCHEMAS[id])
            .map(numericOf)
            .filter((n) => Number.isFinite(n) && n > 0)
        ),
      ].sort((a, b) => a - b);
      expect(durationGridForModel(key), key).toEqual(fromSchema);
    }
  });

  it('resolution tokens match the i2v schema enum', () => {
    for (const key of keys) {
      const id = IMAGE_TO_VIDEO_MODELS[key].id;
      expect([...MOTION_RESOLUTION_TOKENS[key]], key).toEqual(
        motionResolutionTokens(id)
      );
    }
  });

  it('aspect-ratio support matches the i2v Zod field', () => {
    for (const key of keys) {
      const id = IMAGE_TO_VIDEO_MODELS[key].id;
      const schema = MOTION_INPUT_SCHEMAS[id];
      for (const { value } of ASPECT_RATIOS) {
        const fromSchema =
          !('aspect_ratio' in schema.shape) ||
          z
            .object({ aspect_ratio: schema.shape.aspect_ratio })
            .safeParse({ aspect_ratio: value }).success;
        expect(modelSupportsAspectRatio(key, value), `${key} ${value}`).toBe(
          fromSchema
        );
      }
    }
  });

  it('covers every catalog model', () => {
    expect(Object.keys(MOTION_DURATION_GRID).sort()).toEqual(
      keys.slice().sort()
    );
    expect(Object.keys(MOTION_ASPECT_RATIOS).sort()).toEqual(
      keys.slice().sort()
    );
  });
});
