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
    expect(result.packedSpanLabel).toBeNull();
    expect(result.packedShotIds).toBeNull();
    expect(result.packedDurationMs).toBeNull();
    expect(result.packedLimitWarning).toBeNull();
    expect(result.packedPromptOverflow).toBe(false);
  });

  it('packs Seedance 2.5 siblings into the in-clip request the model receives', () => {
    const result = buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'seedance_v2_5',
      imagePrompt: 'Sarah types',
      motionPrompt: {
        fullPrompt: 'the hallway beyond',
        dialogue: null,
        audio: null,
      },
      shotDurationMs: 6000,
      startFrameUrl: 'https://cdn.example/shot-2.jpg',
      usesStartFrame: true,
      generateAudio: true,
      aspectRatio: '16:9',
      scene: {
        originalScript: { extract: 'Sarah walks the hall.' },
        continuity: { characterTags: [] },
        metadata: { location: 'hall' },
      },
      characters: [],
      elements: [],
      locations: [],
      byteplusEnabled: false,
      packedMembers: [
        {
          shotId: 'shot-1',
          shotNumber: 1,
          durationMs: 4000,
          motionPrompt: {
            fullPrompt: 'opens the door',
            dialogue: null,
            audio: null,
          },
          usesStartFrame: true,
          startFrameUrl: 'https://cdn.example/shot-1.jpg',
        },
        {
          shotId: 'shot-2',
          shotNumber: 2,
          durationMs: 6000,
          motionPrompt: {
            fullPrompt: 'the hallway beyond',
            dialogue: null,
            audio: null,
          },
          usesStartFrame: true,
          startFrameUrl: 'https://cdn.example/shot-2.jpg',
        },
      ],
    });

    expect(result.packedSpanLabel).toBe('Shots 1–2');
    expect(result.packedShotIds).toEqual(['shot-1', 'shot-2']);
    expect(result.packedDurationMs).toBe(10_000);
    expect(result.packedLimitWarning).toBeNull();
    expect(result.packedPromptOverflow).toBe(false);
    expect(result.assembledMotionPrompt).toContain('Shot 1 (0-4s):');
    expect(result.assembledMotionPrompt).toContain('opens the door');
    expect(result.assembledMotionPrompt).not.toContain('cut to');
    expect(result.assembledMotionPrompt).toContain('Shot 2 (4-10s):');
    expect(result.assembledMotionPrompt).not.toContain(
      'Single continuous shot, no cuts.'
    );
    // Shot 1 still anchors i2v even when inspecting shot 2.
    expect(result.motion?.json).toContain('https://cdn.example/shot-1.jpg');
    expect(result.motion?.json).not.toContain('https://cdn.example/shot-2.jpg');
    expect(result.assembledMotionPrompt).toContain('No BGM');
    expect(result.assembledMotionPrompt?.split('No BGM').length).toBe(2);
  });

  it('warns when prompt length kept later shots out of the packed clip', () => {
    const result = buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'gemini_omni_flash',
      imagePrompt: 'Sarah types',
      motionPrompt: {
        fullPrompt: 'opens the door',
        dialogue: null,
        audio: null,
      },
      shotDurationMs: 4000,
      startFrameUrl: 'https://cdn.example/shot-1.jpg',
      usesStartFrame: true,
      generateAudio: true,
      aspectRatio: '16:9',
      scene: {
        metadata: { location: 'INT. HALLWAY - NIGHT' },
        continuity: { characterTags: ['sarah'] },
      },
      characters: [],
      elements: [],
      locations: [],
      byteplusEnabled: false,
      packedMembers: [
        {
          shotId: 'shot-1',
          shotNumber: 1,
          durationMs: 4000,
          motionPrompt: {
            fullPrompt: 'opens the door',
            dialogue: null,
            audio: null,
          },
          usesStartFrame: true,
          startFrameUrl: 'https://cdn.example/shot-1.jpg',
        },
        {
          shotId: 'shot-2',
          shotNumber: 2,
          durationMs: 4000,
          motionPrompt: {
            fullPrompt: 'the hallway beyond',
            dialogue: null,
            audio: null,
          },
          usesStartFrame: true,
          startFrameUrl: null,
        },
      ],
      packedDurationShotNumbers: [1, 2, 3],
    });

    expect(result.packedSpanLabel).toBe('Shots 1–2');
    expect(result.packedPromptOverflow).toBe(false);
    expect(result.packedLimitWarning).toContain(
      "Gemini Omni Flash 1.1's 20000-character prompt limit"
    );
    expect(result.packedLimitWarning).toContain('Shot 3');
    expect(result.assembledMotionPrompt).toContain('INT. HALLWAY - NIGHT');
  });

  it('blocks a persisted clip whose prompt does not fit, without dropping a shot', () => {
    // Over a ceiling the provider actually enforces (#1754) — Seedance has
    // none, so a blocking preview has to be tested on a model that does.
    const novel = 'x'.repeat(11000);
    const result = buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'gemini_omni_flash',
      imagePrompt: 'Sarah types',
      motionPrompt: { fullPrompt: novel, dialogue: null, audio: null },
      shotDurationMs: 4000,
      startFrameUrl: 'https://cdn.example/shot-1.jpg',
      usesStartFrame: true,
      generateAudio: true,
      aspectRatio: '16:9',
      scene: { metadata: { location: 'INT. HALLWAY - NIGHT' } },
      characters: [],
      elements: [],
      locations: [],
      byteplusEnabled: false,
      packedMembers: [
        {
          shotId: 'shot-1',
          shotNumber: 1,
          durationMs: 4000,
          motionPrompt: { fullPrompt: novel, dialogue: null, audio: null },
          usesStartFrame: true,
          startFrameUrl: 'https://cdn.example/shot-1.jpg',
        },
        {
          shotId: 'shot-2',
          shotNumber: 2,
          durationMs: 4000,
          motionPrompt: { fullPrompt: novel, dialogue: null, audio: null },
          usesStartFrame: true,
          startFrameUrl: null,
        },
      ],
      packedDurationShotNumbers: [1, 2],
    });

    expect(result.packedShotIds).toEqual(['shot-1', 'shot-2']);
    expect(result.packedPromptOverflow).toBe(true);
    expect(result.packedLimitWarning).toContain(
      "This 2-shot clip's prompt exceeds Gemini Omni Flash 1.1's 20000-character limit"
    );
    expect(result.packedLimitWarning).toContain(
      'Shorten a shot prompt to generate it as one clip'
    );
  });

  it('puts Kling packed shots on multi_prompt and omits prompt', () => {
    const result = buildShotPromptPreview({
      imageModel: 'nano_banana_2',
      videoModel: 'kling_v3_pro',
      imagePrompt: 'Sarah types',
      motionPrompt: {
        fullPrompt: 'the hallway beyond',
        dialogue: null,
        audio: null,
      },
      shotDurationMs: 6000,
      startFrameUrl: 'https://cdn.example/shot-1.jpg',
      usesStartFrame: true,
      generateAudio: true,
      aspectRatio: '16:9',
      scene: {
        originalScript: { extract: 'Sarah walks the hall.' },
        continuity: { characterTags: [] },
        metadata: { location: 'hall' },
      },
      characters: [],
      elements: [],
      locations: [],
      byteplusEnabled: false,
      packedMembers: [
        {
          shotId: 'shot-1',
          shotNumber: 1,
          durationMs: 4000,
          motionPrompt: {
            fullPrompt: 'opens the door',
            dialogue: null,
            audio: null,
          },
          usesStartFrame: true,
          startFrameUrl: 'https://cdn.example/shot-1.jpg',
        },
        {
          shotId: 'shot-2',
          shotNumber: 2,
          durationMs: 6000,
          motionPrompt: {
            fullPrompt: 'the hallway beyond',
            dialogue: null,
            audio: null,
          },
          usesStartFrame: true,
          startFrameUrl: 'https://cdn.example/shot-1.jpg',
        },
      ],
    });

    const parsed: unknown = JSON.parse(result.motion?.json ?? '{}');
    expect(parsed).toEqual(
      expect.objectContaining({
        multi_prompt: [
          expect.objectContaining({ duration: '4' }),
          expect.objectContaining({ duration: '6' }),
        ],
      })
    );
    expect(parsed).toEqual(
      expect.not.objectContaining({ prompt: expect.anything() })
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('multi_prompt' in parsed) ||
      !Array.isArray(parsed.multi_prompt)
    ) {
      throw new Error('expected Kling multi_prompt body');
    }
    const first = parsed.multi_prompt[0];
    const second = parsed.multi_prompt[1];
    expect(first).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining('opens the door'),
      })
    );
    expect(second).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining('the hallway beyond'),
      })
    );
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
