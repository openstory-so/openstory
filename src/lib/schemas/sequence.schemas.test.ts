import { describe, expect, it } from 'vitest';
import {
  createSequenceSchema,
  REFERENCE_ONLY_MODEL_ERROR,
} from './sequence.schemas';

describe('createSequenceSchema', () => {
  it('defaults motion and music ON when omitted (product aha path)', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoGenerateMotion).toBe(true);
      expect(result.data.autoGenerateMusic).toBe(true);
    }
  });

  it('accepts targetDurationSeconds for pre-flight scene count', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      targetDurationSeconds: 30,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetDurationSeconds).toBe(30);
    }
  });

  it('rejects music without motion', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      autoGenerateMotion: false,
      autoGenerateMusic: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === 'autoGenerateMusic'
      );
      expect(issue?.message).toContain('requires motion');
    }
  });

  it('accepts music when motion is enabled', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      autoGenerateMotion: true,
      autoGenerateMusic: true,
    });

    expect(result.success).toBe(true);
  });
});

describe('createSequenceSchema — reference-only', () => {
  const base = {
    script: 'A valid length script here.',
    styleId: 'style_1',
    aspectRatio: '16:9' as const,
  };

  it('defaults off', () => {
    const result = createSequenceSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.generateStartFrames).toBe(false);
  });

  it('accepts a model with a reference-to-video route', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: false,
      videoModel: 'seedance_v2_5',
      videoModels: ['seedance_v2_5'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a model that needs a start frame', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: false,
      videoModel: 'kling_v3_pro',
      videoModels: ['kling_v3_pro'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(REFERENCE_ONLY_MODEL_ERROR);
    }
  });

  it('rejects when only a VARIANT model lacks the route', () => {
    // Reference-only renders every selected model, not just the primary — a
    // variant without a reference route would fail every shot it rendered.
    const result = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: false,
      videoModel: 'seedance_v2_5',
      videoModels: ['seedance_v2_5', 'veo3_1'],
    });
    expect(result.success).toBe(false);
  });

  it('leaves motion model selection alone when start frames are on', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: true,
      videoModel: 'kling_v3_pro',
      videoModels: ['kling_v3_pro'],
    });
    expect(result.success).toBe(true);
  });
});
