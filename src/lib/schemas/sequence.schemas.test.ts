import { describe, expect, it } from 'vitest';
import {
  createSequenceSchema,
  REFERENCE_ONLY_MODEL_ERROR,
  REFERENCE_ONLY_REQUIRES_MOTION_ERROR,
} from './sequence.schemas';

describe('createSequenceSchema', () => {
  it('defaults stop-at to music when omitted (product aha path)', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopAt).toBe('music');
      expect(result.data.autoGenerateMotion).toBe(true);
      expect(result.data.autoGenerateMusic).toBe(true);
    }
  });

  it('maps stopAt onto the legacy auto-generate flags', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      stopAt: 'references',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopAt).toBe('references');
      expect(result.data.autoGenerateMotion).toBe(false);
      expect(result.data.autoGenerateMusic).toBe(false);
    }
  });

  it('collapses motion-off flags to images when stopAt is omitted', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      // Reference-only renders nothing without motion, so the frame-based
      // workflow is the only mode where motion-off flags parse.
      generateStartFrames: true,
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopAt).toBe('images');
    }
  });

  it('rejects motion-off flags in reference-only when stopAt is omitted', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      autoGenerateMotion: false,
      autoGenerateMusic: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        REFERENCE_ONLY_REQUIRES_MOTION_ERROR
      );
    }
  });

  it('accepts an explicit early stop in reference-only', () => {
    // A stop-at is a deliberate partial run, not a motion-off flag.
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      stopAt: 'references',
    });
    expect(result.success).toBe(true);
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

  it('accepts Kling — reference-only routes to O3 Pro', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: false,
      videoModel: 'kling_v3_pro',
      videoModels: ['kling_v3_pro'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a model that needs a start frame', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      generateStartFrames: false,
      videoModel: 'veo3_1',
      videoModels: ['veo3_1'],
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
