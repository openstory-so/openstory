import { describe, expect, it } from 'vitest';

import {
  PromptTooLongError,
  assertPromptWithinHardLimit,
  isPromptTooLongError,
  measurePrompt,
  promptLengthTooltip,
  promptLengthUnit,
} from './prompt-length';
import { IMAGE_TO_VIDEO_MODELS, videoPromptHardLimit } from './models';

describe('hard limits vs recommendations (#1754)', () => {
  it('refuses only where a via documents a ceiling', () => {
    // Ark documents none for Seedance, and fal's schemas declare no
    // `maxLength` on its prompt — so nothing may refuse a long one.
    expect(videoPromptHardLimit('seedance_v2_5')).toBeUndefined();
    expect(videoPromptHardLimit('seedance_v2')).toBeUndefined();
    expect(videoPromptHardLimit('kling_v3_pro')).toBe(2500);
    expect(videoPromptHardLimit('grok_imagine_video_1_5')).toBe(4096);
  });

  it('warns on Seedance above 5500 characters, and says why the unit is not the docs', () => {
    const seedance = IMAGE_TO_VIDEO_MODELS.seedance_v2_5;
    expect(seedance.maxPromptLength).toBe(5500);
    expect(IMAGE_TO_VIDEO_MODELS.seedance_v2.maxPromptLength).toBe(5500);
    expect(IMAGE_TO_VIDEO_MODELS.seedance_v2_mini.maxPromptLength).toBe(5500);
    expect(promptLengthUnit(seedance)).toBe('characters');
    // Whitespace is characters too — the old word count of this string was 4.
    expect(measurePrompt('one two  three\nfour ', seedance)).toBe(20);
    const over = promptLengthTooltip({
      modelName: seedance.name,
      recommendation: seedance,
      overRecommended: true,
    });
    expect(over).toContain('5500 characters');
    expect(over).toContain('still sent in full');
    expect(over).toContain('1,000 English words');
    expect(over).toContain('matches the rest of the interface');
    const under = promptLengthTooltip({
      modelName: seedance.name,
      recommendation: seedance,
      overRecommended: false,
    });
    expect(under).toContain('recommends up to 5500 characters');
    expect(under).toContain('1,000 English words');
    // Everyone else counts characters, and never gets Seedance's note.
    const kling = IMAGE_TO_VIDEO_MODELS.kling_v3_pro;
    expect(promptLengthUnit(kling)).toBe('characters');
    expect(measurePrompt('one two', kling)).toBe(7);
    expect(
      promptLengthTooltip({
        modelName: kling.name,
        recommendation: kling,
        overRecommended: false,
        hardLimit: 2500,
        overHard: true,
      })
    ).toBe('Kling 3.0 Omni maxes out at 2500 characters.');
  });

  it('throws with both numbers, and passes when there is no limit', () => {
    expect(() =>
      assertPromptWithinHardLimit('x'.repeat(2501), 2500, 'Kling')
    ).toThrow(PromptTooLongError);
    expect(() =>
      assertPromptWithinHardLimit('x'.repeat(99999), undefined, 'Seedance')
    ).not.toThrow();
  });
});

describe('isPromptTooLongError', () => {
  it('recognises our own refusal', () => {
    expect(
      isPromptTooLongError(new PromptTooLongError(3000, 2500, 'Kling'))
    ).toBe(true);
  });

  it('recognises xAI’s 400, which is how #1754 was found in the wild', () => {
    expect(
      isPromptTooLongError(
        new Error(
          'grok: /videos/generations request failed (400 Bad Request): Prompt length exceeds the maximum allowed length of 4096'
        )
      )
    ).toBe(true);
  });

  it('recognises a provider phrasing, including one wrapped in a cause', () => {
    expect(
      isPromptTooLongError(
        new Error('body.prompt: String should have at most 2500 characters')
      )
    ).toBe(true);
    expect(
      isPromptTooLongError(
        new Error('Motion job submission rejected (422)', {
          cause: new Error('prompt is too long'),
        })
      )
    ).toBe(true);
  });

  it('does not claim a content rejection is a length problem', () => {
    expect(
      isPromptTooLongError(
        new Error('body.prompt: flagged as sensitive content')
      )
    ).toBe(false);
    expect(isPromptTooLongError('a string, not an error')).toBe(false);
  });
});
