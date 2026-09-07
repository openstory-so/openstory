import { describe, expect, it } from 'vitest';
import {
  boundPromptImages,
  buildShotPromptPreview,
  imageUrlsFromFalInput,
  imageUrlsFromPromptParts,
  promptFromFalInput,
} from './optimised-prompt-preview';

describe('promptFromFalInput', () => {
  it('reads the prompt string off a fal request body', () => {
    expect(
      promptFromFalInput(
        { prompt: 'bound (Image 1) sheet', seed: 1 },
        'fallback'
      )
    ).toBe('bound (Image 1) sheet');
  });

  it('falls back when the body has no prompt string', () => {
    expect(promptFromFalInput({ image_urls: [] }, 'assembled')).toBe(
      'assembled'
    );
    expect(promptFromFalInput(null, 'assembled')).toBe('assembled');
  });
});

describe('boundPromptImages', () => {
  it('tags non-empty URLs in order', () => {
    expect(
      boundPromptImages(
        ['https://cdn.example/a.png', '', 'https://cdn.example/b.png'],
        (position) => `@Image${position}`
      )
    ).toEqual([
      { label: '@Image1', url: 'https://cdn.example/a.png' },
      { label: '@Image2', url: 'https://cdn.example/b.png' },
    ]);
  });
});

describe('imageUrlsFromFalInput', () => {
  it('reads image_urls ahead of image_url', () => {
    expect(
      imageUrlsFromFalInput({
        image_url: 'https://cdn.example/ignored.png',
        image_urls: [
          'https://cdn.example/still.png',
          'https://cdn.example/cast.png',
        ],
      })
    ).toEqual([
      'https://cdn.example/still.png',
      'https://cdn.example/cast.png',
    ]);
  });

  it('reads reference_image_urls when image_urls is absent', () => {
    expect(
      imageUrlsFromFalInput({
        reference_image_urls: [
          'https://cdn.example/still.png',
          'https://cdn.example/cast.png',
        ],
      })
    ).toEqual([
      'https://cdn.example/still.png',
      'https://cdn.example/cast.png',
    ]);
  });

  it('falls back to image_url plus Kling elements', () => {
    expect(
      imageUrlsFromFalInput({
        image_url: 'https://cdn.example/still.png',
        elements: [{ frontal_image_url: 'https://cdn.example/cast.png' }],
      })
    ).toEqual([
      'https://cdn.example/still.png',
      'https://cdn.example/cast.png',
    ]);
  });
});

describe('imageUrlsFromPromptParts', () => {
  it('pulls image source values in order', () => {
    expect(
      imageUrlsFromPromptParts([
        { type: 'text', content: 'hello' },
        { type: 'image', source: { value: 'https://cdn.example/a.png' } },
        { type: 'image', source: { value: 'https://cdn.example/b.png' } },
      ])
    ).toEqual(['https://cdn.example/a.png', 'https://cdn.example/b.png']);
  });
});

describe('buildShotPromptPreview', () => {
  it('builds the fal motion request the inspector used to assemble in the browser', () => {
    const result = buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'grok_imagine_video_1_5',
      imagePrompt: 'Sarah types at a sunlit coffee shop',
      motionPrompt: {
        fullPrompt: 'Camera dolly forward slowly',
        dialogue: null,
        audio: null,
      },
      motionPromptText: 'Camera dolly forward slowly',
      shotDurationMs: 5000,
      startFrameUrl: 'https://example.com/shot.jpg',
      usesStartFrame: true,
      generateAudio: true,
      aspectRatio: '16:9',
      scene: {
        originalScript: { extract: 'Sarah types.' },
        continuity: { characterTags: [] },
        metadata: { location: 'cafe' },
      },
      characters: [],
      elements: [],
      locations: [],
      byteplusEnabled: false,
    });

    expect(result.assembledMotionPrompt).toContain('Camera dolly forward');
    expect(result.motion).not.toBeNull();
    expect(result.motion?.json).toContain('https://example.com/shot.jpg');
    expect(result.motion?.endpointId).toContain('grok-imagine-video');
    expect(result.image).not.toBeNull();
    expect(result.image?.prompt).toContain('Sarah types');
    expect(result.motionHasReferenceImages).toBe(false);
  });

  it('returns no image preview when the visual prompt is empty', () => {
    const result = buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'grok_imagine_video_1_5',
      imagePrompt: '   ',
      motionPrompt: null,
      motionPromptText: null,
      shotDurationMs: 5000,
      startFrameUrl: null,
      usesStartFrame: true,
      generateAudio: true,
      scene: null,
      characters: [],
      elements: [],
      locations: [],
      byteplusEnabled: false,
    });
    expect(result.image).toBeNull();
  });
});
