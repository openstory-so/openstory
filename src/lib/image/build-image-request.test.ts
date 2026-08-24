import { EDIT_ENDPOINTS } from '@/lib/ai/models';
import { typedEntries } from '@/lib/utils/typed-object';
import { describe, expect, it } from 'vitest';
import { buildImageRequest } from './build-image-request';

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
});
