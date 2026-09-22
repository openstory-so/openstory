import { describe, expect, it } from 'vitest';

import {
  PromptTooLongError,
  assertPromptWithinHardLimit,
  isCjkPrompt,
  isPromptTooLongError,
  recommendedPromptLength,
} from './prompt-length';
import { IMAGE_TO_VIDEO_MODELS, videoPromptHardLimit } from './models';

describe('hard limits vs recommendations (#1754)', () => {
  it('refuses only where a via documents a ceiling', () => {
    // Ark documents none for Seedance, and fal's schemas declare no
    // `maxLength` on its prompt — so nothing may refuse a long one.
    expect(videoPromptHardLimit('seedance_v2_5')).toBeUndefined();
    expect(videoPromptHardLimit('seedance_v2')).toBeUndefined();
    expect(videoPromptHardLimit('kling_v3_pro')).toBe(2500);
    expect(videoPromptHardLimit('grok_imagine_video_1_5')).toBe(2500);
  });

  it('measures Seedance against Ark’s recommendation, not our old 4096', () => {
    expect(IMAGE_TO_VIDEO_MODELS.seedance_v2_5.maxPromptLength).toBe(6000);
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

describe('recommendedPromptLength', () => {
  it('keeps the model’s number for Latin prose', () => {
    expect(recommendedPromptLength('a slow dolly in', 6000)).toBe(6000);
  });

  it('switches to Ark’s 500-character figure for a CJK prompt', () => {
    expect(isCjkPrompt('镜头缓缓推进，女主角站在窗前')).toBe(true);
    expect(recommendedPromptLength('镜头缓缓推进，女主角站在窗前', 6000)).toBe(
      500
    );
  });

  it('does not misread a stray CJK name inside English prose', () => {
    const mostlyEnglish = `A slow dolly toward the window as 李 turns away, ${'the light shifts. '.repeat(5)}`;
    expect(isCjkPrompt(mostlyEnglish)).toBe(false);
  });

  it('never raises a limit that is already below the CJK figure', () => {
    expect(recommendedPromptLength('镜头推进', 200)).toBe(200);
  });
});

describe('isPromptTooLongError', () => {
  it('recognises our own refusal', () => {
    expect(
      isPromptTooLongError(new PromptTooLongError(3000, 2500, 'Kling'))
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
