import { describe, expect, it } from 'vitest';
import { apiEnhanceScriptSchema } from './enhance-input-schema';
import { apiCreateSequenceSchema } from './input-schema';

describe('apiCreateSequenceSchema', () => {
  it('defaults enhance to auto and motion/music to false', () => {
    const parsed = apiCreateSequenceSchema.parse({
      script: 'A short film about a robot learning to paint.',
    });
    expect(parsed.enhance).toBe('auto');
    expect(parsed.motion).toBe(false);
    expect(parsed.music).toBe(false);
  });

  it('rejects music without motion', () => {
    const result = apiCreateSequenceSchema.safeParse({
      script: 'A valid length script here.',
      motion: false,
      music: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'music');
      expect(issue?.message).toContain('requires motion');
    }
  });

  it('rejects music when motion is omitted (defaults to false)', () => {
    const result = apiCreateSequenceSchema.safeParse({
      script: 'A valid length script here.',
      music: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'music');
      expect(issue?.message).toContain('requires motion');
    }
  });

  it('accepts music with motion', () => {
    const result = apiCreateSequenceSchema.safeParse({
      script: 'A valid length script here.',
      motion: true,
      music: true,
    });

    expect(result.success).toBe(true);
  });

  it('rejects an invalid enhance mode', () => {
    expect(
      apiCreateSequenceSchema.safeParse({
        script: 'A valid length script here.',
        enhance: 'true',
      }).success
    ).toBe(false);
  });

  it('rejects scripts shorter than 10 characters', () => {
    const result = apiCreateSequenceSchema.safeParse({ script: 'short' });
    expect(result.success).toBe(false);
  });

  it('accepts a fully-specified request with unified cast/location lists', () => {
    const result = apiCreateSequenceSchema.safeParse({
      script: 'A sweeping documentary about deep-sea creatures.',
      title: 'Deep Sea',
      enhance: 'always',
      targetSeconds: 60,
      style: 'Cinematic Noir',
      aspectRatio: '9:16',
      analysisModels: ['anthropic/claude-haiku-4.5'],
      imageModels: ['flux-pro'],
      videoModels: ['kling/kling-v1'],
      motion: true,
      music: true,
      audioModels: ['lyria2'],
      // mixed: existing refs (strings) + inline create (objects)
      characters: [
        'Ada',
        'char-123',
        { name: 'Narrator', description: 'calm' },
      ],
      locations: ['Rooftop', { name: 'Submarine' }],
      elements: [{ url: 'https://cdn.example.com/logo.png', token: 'LOGO' }],
      webhookUrl: 'https://example.com/hook',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-URL element and webhook values', () => {
    expect(
      apiCreateSequenceSchema.safeParse({
        script: 'A valid length script here.',
        elements: [{ url: 'not-a-url' }],
      }).success
    ).toBe(false);

    expect(
      apiCreateSequenceSchema.safeParse({
        script: 'A valid length script here.',
        webhookUrl: 'not-a-url',
      }).success
    ).toBe(false);
  });

  it('bounds targetSeconds to 5–300 (max 5 minutes)', () => {
    const base = { script: 'A valid length script here.', enhance: 'always' };
    expect(
      apiCreateSequenceSchema.safeParse({ ...base, targetSeconds: 4 }).success
    ).toBe(false);
    expect(
      apiCreateSequenceSchema.safeParse({ ...base, targetSeconds: 301 }).success
    ).toBe(false);
    expect(
      apiCreateSequenceSchema.safeParse({ ...base, targetSeconds: 300 }).success
    ).toBe(true);
  });
});

describe('apiEnhanceScriptSchema', () => {
  it('bounds targetSeconds to 5–300, matching the 5m composer chip (#1423)', () => {
    const base = { script: 'A lighthouse keeper befriends a stranded whale.' };
    expect(
      apiEnhanceScriptSchema.safeParse({ ...base, targetSeconds: 300 }).success
    ).toBe(true);
    expect(
      apiEnhanceScriptSchema.safeParse({ ...base, targetSeconds: 301 }).success
    ).toBe(false);
  });
});
