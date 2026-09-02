import { EDIT_ENDPOINTS } from '@/lib/ai/models';
import { typedEntries } from '@/lib/utils/typed-object';
import { describe, expect, it } from 'vitest';
import {
  buildGeminiImageRequest,
  buildGrokImageRequest,
  buildImageRequest,
} from './build-image-request';

const REFS = ['https://example.com/a.png', 'https://example.com/b.png'];

const editModels = typedEntries(EDIT_ENDPOINTS).map(([model]) => model);

describe('buildImageRequest — edit endpoints carry their reference images', () => {
  /**
   * Routing and payload are decided in two different places: the endpoint is
   * picked from EDIT_ENDPOINTS whenever references exist, but `image_urls` is
   * spread per-model in the switch. flux_2_turbo was the one case that routed
   * to `/edit` while omitting them, so fal rejected every reference render with
   * a 422 "Field required". Assert the pair stays consistent for every model
   * rather than for one — the next model added is the next place to forget.
   */
  it.each(editModels)(
    '%s sends image_urls when it routes to its edit endpoint',
    (model) => {
      const { endpointId, input } = buildImageRequest({
        model,
        prompt: 'a lighthouse at dusk',
        referenceImageUrls: REFS,
      });

      expect(endpointId).toBe(EDIT_ENDPOINTS[model]);
      expect(input).toMatchObject({ image_urls: REFS });
    }
  );

  /**
   * fal rejects an over-limit request outright — flux-2/turbo/edit's schema
   * claims "only the first 4 will be used", but the API answers "Number of
   * image URLs must be less than or equal to 4" and fails the shot. A scene
   * with two characters, a location and a prop clears 4 without trying.
   */
  it('omits resolution on Nano Banana 2 Lite (fixed 1K)', () => {
    const generate = buildImageRequest({
      model: 'nano_banana_2_lite',
      prompt: 'a lighthouse at dusk',
    });
    expect(generate.endpointId).toBe('google/nano-banana-2-lite');
    expect(generate.input).not.toHaveProperty('resolution');
    expect(generate.input.aspect_ratio).toBe('16:9');

    const edit = buildImageRequest({
      model: 'nano_banana_2_lite',
      prompt: 'a lighthouse at dusk',
      referenceImageUrls: REFS,
    });
    expect(edit.endpointId).toBe('google/nano-banana-lite/edit');
    expect(edit.input).not.toHaveProperty('resolution');
    expect(edit.input.image_urls).toEqual(REFS);
  });

  it('routes FLUX.2 Flash to its edit endpoint and omits inference steps', () => {
    const generate = buildImageRequest({
      model: 'flux_2_flash',
      prompt: 'a lighthouse at dusk',
    });
    expect(generate.endpointId).toBe('fal-ai/flux-2/flash');
    expect(generate.input).not.toHaveProperty('num_inference_steps');

    const many = Array.from(
      { length: 6 },
      (_, i) => `https://example.com/${i}.png`
    );
    const edit = buildImageRequest({
      model: 'flux_2_flash',
      prompt: 'a lighthouse at dusk',
      referenceImageUrls: many,
    });
    expect(edit.endpointId).toBe('fal-ai/flux-2/flash/edit');
    expect(edit.input.image_urls).toEqual(many.slice(0, 4));
    expect(edit.input).not.toHaveProperty('num_inference_steps');
  });

  it('caps reference images at the model limit', () => {
    const many = Array.from(
      { length: 7 },
      (_, i) => `https://example.com/${i}.png`
    );

    const { input } = buildImageRequest({
      model: 'flux_2_turbo',
      prompt: 'a lighthouse at dusk',
      referenceImageUrls: many,
    });

    expect(input.image_urls).toEqual(many.slice(0, 4));
  });

  it('caps Grok Imagine 2.0 edit refs at 3', () => {
    const many = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/${i}.png`
    );

    const { endpointId, input } = buildImageRequest({
      model: 'grok_imagine_image',
      prompt: 'a lighthouse at dusk',
      referenceImageUrls: many,
    });

    expect(endpointId).toBe('xai/grok-imagine-image/v2.0/edit');
    expect(input.image_urls).toEqual(many.slice(0, 3));
    expect(input.quality).toBe('medium');
  });

  it('leaves references untouched for a model with no known cap', () => {
    const many = Array.from(
      { length: 7 },
      (_, i) => `https://example.com/${i}.png`
    );

    const { input } = buildImageRequest({
      model: 'nano_banana_2',
      prompt: 'a lighthouse at dusk',
      referenceImageUrls: many,
    });

    expect(input.image_urls).toEqual(many);
  });

  it.each(editModels)(
    '%s omits image_urls and stays on text-to-image without references',
    (model) => {
      const { endpointId, input } = buildImageRequest({
        model,
        prompt: 'a lighthouse at dusk',
      });

      expect(endpointId).not.toBe(EDIT_ENDPOINTS[model]);
      expect(input).not.toHaveProperty('image_urls');
    }
  );

  it('routes grok text-to-image to Imagine 2.0', () => {
    const { endpointId, input } = buildImageRequest({
      model: 'grok_imagine_image',
      prompt: 'a lighthouse at dusk',
    });
    expect(endpointId).toBe('xai/grok-imagine-image/v2.0/text-to-image');
    expect(input.quality).toBe('medium');
  });

  it('routes Quality Mode to the quality fal endpoints without a quality knob', () => {
    const generate = buildImageRequest({
      model: 'grok_imagine_image_quality',
      prompt: 'a lighthouse at dusk',
    });
    expect(generate.endpointId).toBe(
      'xai/grok-imagine-image/quality/text-to-image'
    );
    expect(generate.input).not.toHaveProperty('quality');

    const edit = buildImageRequest({
      model: 'grok_imagine_image_quality',
      prompt: 'a lighthouse at dusk',
      referenceImageUrls: ['https://example.com/a.png'],
    });
    expect(edit.endpointId).toBe('xai/grok-imagine-image/quality/edit');
    expect(edit.input).not.toHaveProperty('quality');
  });
});

describe('buildGrokImageRequest (issue #1167)', () => {
  const BASE = {
    model: 'grok_imagine_image',
    prompt: 'a lighthouse at dusk',
  } as const;

  it('renders the aspect-ratio_resolution size template xAI expects', () => {
    expect(
      buildGrokImageRequest({ ...BASE, imageSize: 'landscape_16_9' }).size
    ).toBe('16:9_2k');
    expect(
      buildGrokImageRequest({ ...BASE, imageSize: 'portrait_16_9' }).size
    ).toBe('9:16_2k');
    expect(
      buildGrokImageRequest({ ...BASE, imageSize: 'square_hd' }).size
    ).toBe('1:1_2k');
  });

  it('maps the resolution tiers onto the two xAI serves', () => {
    expect(buildGrokImageRequest({ ...BASE, resolution: '720p' }).size).toBe(
      '16:9_1k'
    );
    expect(buildGrokImageRequest({ ...BASE, resolution: '1080p' }).size).toBe(
      '16:9_2k'
    );
    // xAI has no 4K tier — asking for one lands on the highest it does serve
    // rather than being rejected outright.
    expect(buildGrokImageRequest({ ...BASE, resolution: '4k' }).size).toBe(
      '16:9_2k'
    );
  });

  it('truncates the prompt to the model’s limit, as the fal path does', () => {
    const longPrompt = 'x'.repeat(5000);
    const { prompt } = buildGrokImageRequest({ ...BASE, prompt: longPrompt });

    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt.endsWith('...')).toBe(true);
  });
});

describe('resolution tiers (#1449)', () => {
  const base = { prompt: 'a lighthouse at dusk' } as const;

  it('spells the tier in the model’s own resolution vocabulary', () => {
    expect(
      buildImageRequest({ ...base, model: 'nano_banana_2', resolution: '720p' })
        .input.resolution
    ).toBe('1K');
    expect(
      buildImageRequest({ ...base, model: 'nano_banana_2', resolution: '4k' })
        .input.resolution
    ).toBe('4K');
    // Phota serves 1K or 4K only.
    expect(
      buildImageRequest({ ...base, model: 'phota', resolution: '1080p' }).input
        .resolution
    ).toBe('1K');
  });

  it('leaves a fixed-size model without a resolution field', () => {
    expect(
      buildImageRequest({
        ...base,
        model: 'nano_banana_2_lite',
        resolution: '4k',
      }).input
    ).not.toHaveProperty('resolution');
  });

  it('sizes a pixel-sized model from the tier and the aspect ratio', () => {
    expect(
      buildImageRequest({
        ...base,
        model: 'gpt_image_2',
        imageSize: 'landscape_16_9',
        resolution: '4k',
      }).input.image_size
    ).toEqual({ width: 3840, height: 2160 });
    expect(
      buildImageRequest({
        ...base,
        model: 'gpt_image_2',
        imageSize: 'portrait_16_9',
        resolution: '720p',
      }).input.image_size
    ).toEqual({ width: 720, height: 1280 });
  });

  it('clamps a 4K ask into the model’s documented range', () => {
    // FLUX.2 tops out at 2048 per edge — a 4K ask must not 422.
    expect(
      buildImageRequest({
        ...base,
        model: 'flux_2_dev',
        imageSize: 'landscape_16_9',
        resolution: '4k',
      }).input.image_size
    ).toEqual({ width: 2048, height: 1152 });
  });

  it('keeps the preset when no tier is asked for', () => {
    expect(
      buildImageRequest({
        ...base,
        model: 'gpt_image_2',
        imageSize: 'landscape_16_9',
      }).input.image_size
    ).toBe('landscape_16_9');
  });
});

describe('buildGeminiImageRequest', () => {
  const BASE = {
    model: 'nano_banana_2_lite',
    prompt: 'a lighthouse at dusk',
  } as const;

  it('spells the tier in Google’s capital-K vocabulary', () => {
    expect(
      buildGeminiImageRequest({
        ...BASE,
        model: 'nano_banana_2',
        imageSize: 'landscape_16_9',
        resolution: '720p',
      }).size
    ).toBe('16:9_1K');
    expect(
      buildGeminiImageRequest({
        ...BASE,
        model: 'nano_banana_pro',
        imageSize: 'portrait_16_9',
        resolution: '4k',
      }).size
    ).toBe('9:16_4K');
  });

  it('resolves against Google’s tokens, not the fal enum', () => {
    // nano_banana_2's fal enum starts at 0.5K, which this via does not admit —
    // a 720p ask has to land on 1K here, never on a token Gemini rejects.
    expect(
      buildGeminiImageRequest({
        ...BASE,
        model: 'nano_banana_2',
        resolution: '720p',
      }).resolution
    ).toBe('1K');
  });

  it('snaps Lite to 1K even when a higher tier is requested', () => {
    expect(buildGeminiImageRequest({ ...BASE, resolution: '4k' }).size).toBe(
      '16:9_1K'
    );
    expect(
      buildGeminiImageRequest({ ...BASE, resolution: '1080p' }).nativeModel
    ).toBe('gemini-3.1-flash-lite-image');
  });

  it('defaults Pro/2 to 2K, matching the fal path', () => {
    expect(
      buildGeminiImageRequest({ ...BASE, model: 'nano_banana_2' }).size
    ).toBe('16:9_2K');
  });
});
