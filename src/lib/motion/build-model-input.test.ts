import { describe, expect, it } from 'vitest';
import {
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  type ImageToVideoModel,
} from '../ai/models';
import { typedEntries } from '../utils/typed-object';
import { buildModelInput, buildMotionRequest } from './build-model-input';
import type { GenerateMotionOptions } from './motion-generation';

const baseOptions: GenerateMotionOptions = {
  prompt: 'Camera dolly forward slowly',
  imageUrl: 'https://example.com/shot.jpg',
  duration: 5,
  aspectRatio: '16:9',
};

function build<T extends ImageToVideoModel>(
  modelKey: T,
  overrides: Partial<GenerateMotionOptions> = {}
) {
  return buildModelInput<T>(
    { ...baseOptions, ...overrides },
    IMAGE_TO_VIDEO_MODELS[modelKey],
    modelKey
  );
}

describe('buildModelInput', () => {
  describe('Kling v3 Pro (audio)', () => {
    it('uses start_image_url (not image_url)', () => {
      const result = build('kling_v3_pro');
      expect(result).toHaveProperty('start_image_url', baseOptions.imageUrl);
      expect(result).not.toHaveProperty('image_url');
    });

    it('applies the schema default for cfg_scale', () => {
      const result = build('kling_v3_pro');
      expect(result.cfg_scale).toBe(0.5);
    });

    // Supplying a negative prompt replaces fal's default rather than extending
    // it, so the quality terms have to be carried over alongside the music
    // suppression (#1165).
    it('suppresses music via negative_prompt, keeping the default quality terms', () => {
      const result = build('kling_v3_pro');
      expect(result.negative_prompt).toBe(
        'blur, distort, and low quality, background music, musical score, soundtrack'
      );
    });

    it('sets generate_audio to true from schema default', () => {
      const result = build('kling_v3_pro');
      expect(result.generate_audio).toBe(true);
    });

    it('forwards generate_audio=false when caller suppresses audio', () => {
      const result = build('kling_v3_pro', { generateAudio: false });
      expect(result.generate_audio).toBe(false);
    });
  });

  describe('Grok Imagine Video 1.5 (default)', () => {
    it('uses image_url and strips aspect_ratio (schema has none)', () => {
      // v1.5's fal schema dropped aspect_ratio; the output ratio is driven by
      // the input image instead. The transform must strip the aspect_ratio we
      // pass so no unsupported param reaches the API.
      const result = build('grok_imagine_video_1_5');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
      expect(result).not.toHaveProperty('start_image_url');
      expect(result).not.toHaveProperty('aspect_ratio');
      expect(result.resolution).toBe('720p'); // schema default
    });
  });

  describe('Veo 3.1 (audio)', () => {
    it('overrides resolution to 1080p', () => {
      const result = build('veo3_1');
      expect(result.resolution).toBe('1080p');
    });

    it('sets generate_audio to true from schema default', () => {
      const result = build('veo3_1');
      expect(result.generate_audio).toBe(true);
    });

    it('forwards generate_audio=false when caller suppresses audio', () => {
      const result = build('veo3_1', { generateAudio: false });
      expect(result.generate_audio).toBe(false);
    });

    it('uses image_url', () => {
      const result = build('veo3_1');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('suppresses music via negative_prompt', () => {
      const result = build('veo3_1');
      expect(result.negative_prompt).toBe(
        'background music, musical score, soundtrack'
      );
    });
  });

  describe('MiniMax Hailuo 2.3', () => {
    it('uses image_url', () => {
      const result = build('minimax_hailuo_02');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('includes prompt', () => {
      const result = build('minimax_hailuo_02');
      expect(result.prompt).toBe(baseOptions.prompt);
    });
  });

  describe('MiniMax H3 Max', () => {
    it('uses image_url and keeps fal defaults (768P, balanced expansion)', () => {
      const result = build('minimax_h3_max');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
      expect(result.prompt).toBe(baseOptions.prompt);
      expect(result).toMatchObject({
        resolution: '768P',
        prompt_expansion_mode: 'balanced',
      });
    });
  });

  describe('LTX 2.3 Pro', () => {
    it('uses image_url', () => {
      const result = build('ltx_2_3_pro');
      expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
    });

    it('includes prompt', () => {
      const result = build('ltx_2_3_pro');
      expect(result.prompt).toBe(baseOptions.prompt);
    });
  });

  describe.each(['seedance_v2', 'seedance_v2_5'] as const)(
    '%s (audio)',
    (model) => {
      it('uses image_url', () => {
        const result = build(model);
        expect(result).toHaveProperty('image_url', baseOptions.imageUrl);
      });

      it('sets generate_audio to true from schema default', () => {
        const result = build(model);
        expect(result.generate_audio).toBe(true);
      });

      // Seedance has no negative_prompt field — its only music lever is the
      // in-prompt constraint from assembleMotionPrompt (#1165).
      it('sends no negative_prompt', () => {
        expect(build(model)).not.toHaveProperty('negative_prompt');
      });

      it('forwards generate_audio=false when caller suppresses audio', () => {
        const result = build(model, { generateAudio: false });
        expect(result.generate_audio).toBe(false);
      });
    }
  );

  describe('duration snapping (1–30s)', () => {
    const valid: Record<ImageToVideoModel, readonly (string | number)[]> = {
      kling_v3_pro: [
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
      ],
      grok_imagine_video_1_5: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      ],
      veo3_1: ['4s', '6s', '8s'],
      ltx_2_3_pro: [6, 8, 10],
      seedance_v2: Array.from({ length: 12 }, (_, i) => String(i + 4)),
      seedance_v2_5: Array.from({ length: 27 }, (_, i) => String(i + 4)),
      minimax_hailuo_02: [],
      minimax_h3_max: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      gemini_omni_flash: [3, 4, 5, 6, 7, 8, 9, 10],
    };

    for (const [model, allowed] of typedEntries(valid)) {
      it(model, () => {
        for (let d = 1; d <= 30; d++) {
          const modelInputResult = build(model, { duration: d });
          const duration =
            'duration' in modelInputResult
              ? modelInputResult.duration
              : undefined;

          if (typeof duration === 'undefined') {
            expect(allowed).toHaveLength(0);
          } else {
            expect(allowed).toContain(duration);
          }
        }
      });
    }
  });

  describe('reference images (#873)', () => {
    const referenceImages = [
      {
        referenceImageUrl: 'https://example.com/jack-sheet.png',
        description: 'Jack - tall man with a scar',
        role: 'character' as const,
      },
      {
        referenceImageUrl: 'https://example.com/logo.png',
        description: 'ACME_LOGO - red circular badge',
        role: 'element' as const,
      },
    ];

    it('Kling emits an elements array with frontal + reference images', () => {
      const result = build('kling_v3_pro', { referenceImages });
      expect(result.elements).toEqual([
        {
          frontal_image_url: 'https://example.com/jack-sheet.png',
          reference_image_urls: ['https://example.com/jack-sheet.png'],
        },
        {
          frontal_image_url: 'https://example.com/logo.png',
          reference_image_urls: ['https://example.com/logo.png'],
        },
      ]);
    });

    it('Kling appends an @ElementN legend matching the elements order', () => {
      const result = build('kling_v3_pro', { referenceImages });
      expect(result.prompt).toContain(baseOptions.prompt);
      expect(result.prompt).toContain('@Element1: Jack - tall man with a scar');
      expect(result.prompt).toContain(
        '@Element2: ACME_LOGO - red circular badge'
      );
    });

    it('Kling without references is unchanged (no elements key)', () => {
      const result = build('kling_v3_pro');
      expect(result).not.toHaveProperty('elements');
      expect(result.prompt).toBe(baseOptions.prompt);
    });

    it('non-Kling models get no elements key and an unchanged prompt when no tokens are mentioned', () => {
      for (const key of Object.keys(IMAGE_TO_VIDEO_MODELS)) {
        if (key === 'kling_v3_pro') continue;
        const result = build(safeImageToVideoModel(key), { referenceImages });
        expect(result).not.toHaveProperty('elements');
        expect(result.prompt).toBe(baseOptions.prompt);
      }
    });

    it('non-Kling models substitute mentioned tokens with descriptions', () => {
      const tokenRefs = [
        {
          referenceImageUrl: 'https://example.com/jack-sheet.png',
          description: 'Jack - tall man with a scar',
          role: 'character' as const,
          token: 'Jack',
        },
        {
          referenceImageUrl: 'https://example.com/logo.png',
          description: 'ACME_LOGO - red circular badge',
          role: 'element' as const,
          token: 'ACME_LOGO',
        },
      ];
      const result = build('grok_imagine_video_1_5', {
        prompt: 'JACK holds up the ACME_LOGO to the camera',
        referenceImages: tokenRefs,
      });
      expect(result).not.toHaveProperty('elements');
      expect(result.prompt).toBe(
        'Jack (tall man with a scar) holds up the ACME_LOGO (red circular badge) to the camera'
      );
    });
  });

  describe.each(['seedance_v2', 'seedance_v2_5'] as const)(
    'buildMotionRequest reference-to-video (#873 %s)',
    (model) => {
      const referenceImages = [
        {
          referenceImageUrl: 'https://example.com/jack-sheet.png',
          description: 'Jack - tall man with a scar',
          role: 'character' as const,
        },
        {
          referenceImageUrl: 'https://example.com/logo.png',
          description: 'ACME_LOGO - red circular badge',
          role: 'element' as const,
        },
      ];

      const buildRef = (overrides: Partial<GenerateMotionOptions> = {}) => {
        const { input } = buildMotionRequest(
          { ...baseOptions, referenceImages, ...overrides },
          model
        );
        if (!('image_urls' in input)) {
          throw new Error('expected Seedance reference-to-video input');
        }
        return input;
      };

      it('puts the still as @Image1 in image_urls and omits image_url', () => {
        const result = buildRef();
        expect(result).not.toHaveProperty('image_url');
        expect(result.image_urls).toEqual([
          baseOptions.imageUrl,
          'https://example.com/jack-sheet.png',
          'https://example.com/logo.png',
        ]);
      });

      it('declares the still as the starting frame and legends unmentioned refs', () => {
        const result = buildRef();
        expect(result.prompt).toContain(baseOptions.prompt);
        expect(
          typeof result.prompt === 'string' &&
            result.prompt.startsWith('Use @Image1 as the starting frame.')
        ).toBe(true);
        expect(result.prompt).toContain('@Image2: Jack - tall man with a scar');
        expect(result.prompt).toContain(
          '@Image3: ACME_LOGO - red circular badge'
        );
      });

      it('applies the seedance resolution quality override', () => {
        expect(buildRef().resolution).toBe('720p');
      });

      it('forwards generate_audio=false when caller suppresses audio', () => {
        expect(buildRef({ generateAudio: false }).generate_audio).toBe(false);
      });
    }
  );

  describe('buildMotionRequest reference-to-video (minimax_h3_max)', () => {
    const referenceImages = [
      {
        referenceImageUrl: 'https://example.com/jack-sheet.png',
        description: 'Jack - tall man with a scar',
        role: 'character' as const,
      },
      {
        referenceImageUrl: 'https://example.com/logo.png',
        description: 'ACME_LOGO - red circular badge',
        role: 'element' as const,
      },
    ];

    const buildRef = (overrides: Partial<GenerateMotionOptions> = {}) => {
      const { endpointId, input } = buildMotionRequest(
        { ...baseOptions, referenceImages, ...overrides },
        'minimax_h3_max'
      );
      if (!('reference_image_urls' in input)) {
        throw new Error('expected H3 Max reference-to-video input');
      }
      return { endpointId, input };
    };

    it('routes to the r2v sibling and puts stills in reference_image_urls', () => {
      const { endpointId, input } = buildRef();
      expect(endpointId).toBe('minimax/h3-max/reference-to-video');
      expect(input).not.toHaveProperty('image_url');
      expect(input).not.toHaveProperty('image_urls');
      expect(input.reference_image_urls).toEqual([
        baseOptions.imageUrl,
        'https://example.com/jack-sheet.png',
        'https://example.com/logo.png',
      ]);
    });

    it('declares the still as Image 1 and legends unmentioned refs', () => {
      const { input } = buildRef();
      expect(
        typeof input.prompt === 'string' &&
          input.prompt.startsWith('Use Image 1 as the starting frame.')
      ).toBe(true);
      expect(input.prompt).toContain('Image 2: Jack - tall man with a scar');
      expect(input.prompt).toContain('Image 3: ACME_LOGO - red circular badge');
    });

    it('keeps 768P and balanced prompt expansion', () => {
      const { input } = buildRef();
      expect(input).toMatchObject({
        resolution: '768P',
        prompt_expansion_mode: 'balanced',
      });
    });
  });

  describe('common behavior', () => {
    it('always includes prompt', () => {
      for (const key of Object.keys(IMAGE_TO_VIDEO_MODELS)) {
        const result = build(safeImageToVideoModel(key));
        expect(result.prompt).toBe(baseOptions.prompt);
      }
    });

    it.each(['seedance_v2', 'seedance_v2_5'] as const)(
      'passes aspect_ratio from options (%s)',
      (model) => {
        const result = build(model, { aspectRatio: '9:16' });
        expect(result.aspect_ratio).toBe('9:16');
      }
    );

    it.each(['seedance_v2', 'seedance_v2_5'] as const)(
      'falls back to the schema default for aspect_ratio when not provided (%s)',
      (model) => {
        const result = build(model, { aspectRatio: undefined });
        expect(result.aspect_ratio).toBe('auto');
      }
    );
  });
});
