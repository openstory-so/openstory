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

// #1559 — the preview matched references against the raw prompt while submit
// matched the assembled one, so a voice bound to a dialogue line showed as a
// raw `MATEO_SHOT_1` here while the provider got `Audio 1` and the file.
describe('buildShotPromptPreview with a bound voice', () => {
  const voice = {
    id: 'el-voice',
    token: 'MATEO_SHOT_1',
    description: null,
    imageUrl: 'https://cdn.example/mateo.m4a',
    consistencyTag: null,
    kind: 'audio' as const,
    durationSeconds: 3.75,
  };
  const preview = () =>
    buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'minimax_h3_max',
      imagePrompt: 'Mateo on a sidewalk',
      motionPrompt: {
        fullPrompt: 'Handheld push-in on Mateo.',
        dialogue: {
          presence: true,
          lines: [
            {
              character: 'Mateo',
              line: 'Wait, right now?',
              tone: 'surprised',
              voiceToken: 'MATEO_SHOT_1',
            },
          ],
        },
        audio: null,
      },
      shotDurationMs: 6000,
      startFrameUrl: 'https://cdn.example/still.jpg',
      usesStartFrame: true,
      generateAudio: true,
      aspectRatio: '16:9',
      scene: {
        originalScript: { extract: 'Mateo is stopped mid-stride.' },
        continuity: { characterTags: [] },
        metadata: { location: 'sidewalk' },
      },
      characters: [],
      elements: [voice],
      locations: [],
      byteplusEnabled: false,
    });

  it('binds the voice by the tag the provider reads', () => {
    const motion = preview().motion;
    expect(motion?.prompt).toContain('exactly as recorded in Audio 1');
    expect(motion?.prompt).not.toContain('MATEO_SHOT_1');
  });

  it('lists the audio file under that same tag', () => {
    expect(preview().motion?.audio).toEqual([
      { label: 'Audio 1', url: 'https://cdn.example/mateo.m4a' },
    ]);
  });
});
