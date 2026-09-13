import { describe, expect, it } from 'vitest';
import {
  createSequenceSchema,
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

  it('has no target ceiling — a pasted feature script is as long as it is (#1593)', () => {
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      targetDurationSeconds: 90 * 60,
    });
    expect(result.success).toBe(true);
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

  it('accepts an element upload with no token (the public API omits it)', () => {
    // The API documents `elements[].token` as optional and attach derives one
    // from the filename, but this schema used to require it — so every
    // token-less API create 400'd here before the two shapes were shared.
    const result = createSequenceSchema.safeParse({
      script: 'A valid length script here.',
      styleId: 'style_1',
      aspectRatio: '16:9',
      elementUploads: [
        {
          tempPath: 'elements/team-1/uploads/up-1.png',
          tempPublicUrl: '/r2/elements/team-1/uploads/up-1.png',
          filename: 'logo.png',
        },
      ],
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

  // Every catalog model renders reference-only on some via (#1511), so the
  // reject path has no model to exercise it with; the schema still asks
  // `referenceOnlyCapableWith` for every selected model.

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

// #1559 — a reference no selected model can take is refused at submit, which
// on a full run lands after script, references and images are already paid
// for. Catch it at create instead.
describe('createSequenceSchema over-long reference gate', () => {
  const base = {
    script: 'A valid length script here.',
    styleId: 'style_1',
    aspectRatio: '16:9' as const,
  };
  const upload = (durationSeconds: number | null) => ({
    tempPath: 'elements/team_1/temp/x.mp4',
    tempPublicUrl: 'https://example.com/x.mp4',
    filename: 'puppet_walk.mp4',
    token: 'PUPPET_WALK',
    durationSeconds,
  });

  it('rejects a clip longer than a selected model accepts', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      videoModels: ['gemini_omni_flash'],
      elementUploads: [upload(10)],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toContain(
        "can't use PUPPET_WALK — 10s, over its 3s limit"
      );
      expect(message).toContain('3s');
      expect(message).toContain('Trim it');
    }
  });

  it('rejects when ANY selected variant model is too short', () => {
    // A variant that cannot take the reference fails every shot mentioning it.
    const result = createSequenceSchema.safeParse({
      ...base,
      videoModels: ['seedance_v2_5', 'gemini_omni_flash'],
      elementUploads: [upload(10)],
    });
    expect(result.success).toBe(false);
  });

  it('accepts the same clip on a model with room for it', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      videoModels: ['seedance_v2_5'],
      elementUploads: [upload(10)],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a clip whose length was never measured', () => {
    const result = createSequenceSchema.safeParse({
      ...base,
      videoModels: ['gemini_omni_flash'],
      elementUploads: [upload(null)],
    });
    expect(result.success).toBe(true);
  });

  it('does not gate a run that stops before motion', () => {
    // Nothing renders, so nothing can be refused for being too long.
    const result = createSequenceSchema.safeParse({
      ...base,
      videoModels: ['gemini_omni_flash'],
      stopAt: 'images',
      elementUploads: [upload(10)],
    });
    expect(result.success).toBe(true);
  });
});
