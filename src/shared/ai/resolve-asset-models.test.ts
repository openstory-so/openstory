import { describe, expect, it } from 'vitest';
import {
  resolveImageModel,
  resolveUpscaleModel,
  resolveVideoModel,
  UPSCALE_FALLBACK_MODEL,
} from './resolve-asset-models';

describe('resolveImageModel', () => {
  it('prefers the explicit per-request model', () => {
    expect(
      resolveImageModel({
        explicit: 'gpt_image_2',
        lastFailedAttemptModel: 'phota',
        selectedVersionModel: 'nano_banana_pro',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('gpt_image_2');
  });

  it('prefers the last failed attempt over the selected version', () => {
    // The shot succeeded on nano_banana_pro, the user then tried phota and it
    // failed. A retry must re-run phota, not silently fall back to the older
    // successful model.
    expect(
      resolveImageModel({
        lastFailedAttemptModel: 'phota',
        selectedVersionModel: 'nano_banana_pro',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('phota');
  });

  it('uses the selected version when there is no failed attempt', () => {
    expect(
      resolveImageModel({
        selectedVersionModel: 'nano_banana_pro',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('nano_banana_pro');
  });

  it('falls back to the sequence default with no selected version', () => {
    expect(
      resolveImageModel({
        selectedVersionModel: null,
        sequenceModel: 'flux_2_max',
      })
    ).toBe('flux_2_max');
  });

  it('falls back to the app default when the sequence has not loaded', () => {
    expect(resolveImageModel({ sequenceModel: undefined })).toBe('gpt_image_2');
  });

  it('falls through to the NEXT tier when a tier is set but retired', () => {
    // A model id retired after the version was written must not skip the
    // user's sequence choice for the global app default.
    expect(
      resolveImageModel({
        selectedVersionModel: 'retired_model',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('flux_2_max');
  });

  it('falls through a retired failed attempt to the selected version', () => {
    expect(
      resolveImageModel({
        lastFailedAttemptModel: 'retired_model',
        selectedVersionModel: 'nano_banana_pro',
        sequenceModel: 'flux_2_max',
      })
    ).toBe('nano_banana_pro');
  });

  it('falls back to the app default when every tier is invalid/empty', () => {
    expect(
      resolveImageModel({
        selectedVersionModel: 'also_not_a_model',
        sequenceModel: '',
      })
    ).toBe('gpt_image_2');
  });
});

describe('resolveVideoModel', () => {
  it('prefers the explicit per-request model', () => {
    expect(
      resolveVideoModel({
        explicit: 'seedance_v2',
        selectedVersionModel: 'kling_v3_pro',
        sequenceModel: 'kling_v3_pro',
      })
    ).toBe('seedance_v2');
  });

  it('prefers the last failed attempt over the selected version', () => {
    expect(
      resolveVideoModel({
        lastFailedAttemptModel: 'veo3_1',
        selectedVersionModel: 'kling_v3_pro',
        sequenceModel: 'seedance_v2',
      })
    ).toBe('veo3_1');
  });

  it('uses the selected version when there is no failed attempt', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: 'kling_v3_pro',
        sequenceModel: 'seedance_v2',
      })
    ).toBe('kling_v3_pro');
  });

  it('falls back to the sequence default with no selected version', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: null,
        sequenceModel: 'kling_v3_pro',
      })
    ).toBe('kling_v3_pro');
  });

  it('falls back to the app default when the sequence has not loaded', () => {
    expect(resolveVideoModel({ sequenceModel: undefined })).toBe('seedance_v2');
  });

  it('falls through to the NEXT tier when a tier is set but retired', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: 'retired_model',
        sequenceModel: 'kling_v3_pro',
      })
    ).toBe('kling_v3_pro');
  });

  it('falls back to the app default when every tier is invalid/empty', () => {
    expect(
      resolveVideoModel({
        selectedVersionModel: 'bogus',
        sequenceModel: '',
      })
    ).toBe('seedance_v2');
  });
});

describe('resolveUpscaleModel', () => {
  it('upscales on the model that generated the grid', () => {
    // The upscale is an edit of that model's own tile — rendering it on a
    // different model restyles the shot AND (since the resulting version
    // becomes the frame's selection) rewrites the shot's resolved model.
    expect(resolveUpscaleModel('gpt_image_2')).toBe('gpt_image_2');
    expect(resolveUpscaleModel('flux_2_max')).toBe('flux_2_max');
  });

  it('falls back for a model with no edit endpoint', () => {
    // hidream_i1 has no EDIT_ENDPOINTS entry, so an upscale request would be
    // routed to its text-to-image endpoint, ignore the tile, and return a
    // fresh render instead of an upscale.
    expect(resolveUpscaleModel('hidream_i1')).toBe(UPSCALE_FALLBACK_MODEL);
  });

  it('falls back for a missing or retired source model', () => {
    expect(resolveUpscaleModel(null)).toBe(UPSCALE_FALLBACK_MODEL);
    expect(resolveUpscaleModel(undefined)).toBe(UPSCALE_FALLBACK_MODEL);
    expect(resolveUpscaleModel('retired_model')).toBe(UPSCALE_FALLBACK_MODEL);
  });
});
