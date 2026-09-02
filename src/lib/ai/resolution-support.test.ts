import { describe, expect, it } from 'vitest';
import {
  availableResolutions,
  resolutionCeilingNote,
} from './resolution-support';

describe('availableResolutions', () => {
  it('offers only what a video model can render', () => {
    // Veo 3.1 serves all three; Seedance 2.5 stops at 1080p.
    expect(availableResolutions({ videoModels: ['veo3_1'] })).toEqual([
      '720p',
      '1080p',
      '4k',
    ]);
    expect(availableResolutions({ videoModels: ['seedance_v2_5'] })).toEqual([
      '720p',
      '1080p',
    ]);
    // H3 Max is the Turbo default and tops out at 768P.
    expect(availableResolutions({ videoModels: ['minimax_h3_max'] })).toEqual([
      '720p',
    ]);
  });

  it('offers nothing for a model with a fixed output', () => {
    // Kling v3 Pro's schema has no resolution field at all.
    expect(availableResolutions({ videoModels: ['kling_v3_pro'] })).toEqual([]);
    // Nano Banana 2 Lite is fixed 1K.
    expect(
      availableResolutions({ imageModels: ['nano_banana_2_lite'] })
    ).toEqual([]);
  });

  it('does not offer 4K on an image model that cannot reach it', () => {
    // FLUX.2 stops at 2048 per edge — a 4K pill would promise a size it
    // never returns.
    expect(availableResolutions({ imageModels: ['flux_2_dev'] })).toEqual([
      '720p',
      '1080p',
    ]);
    expect(availableResolutions({ imageModels: ['gpt_image_2'] })).toEqual([
      '720p',
      '1080p',
      '4k',
    ]);
  });

  it('unions the selection — a capped video model keeps 4K stills available', () => {
    expect(
      availableResolutions({
        imageModels: ['gpt_image_2'],
        videoModels: ['seedance_v2_5'],
      })
    ).toEqual(['720p', '1080p', '4k']);
  });
});

describe('resolutionCeilingNote', () => {
  it('is silent when every model serves the tier', () => {
    expect(
      resolutionCeilingNote('1080p', { videoModels: ['veo3_1'] })
    ).toBeNull();
  });

  it('names the model that will render below the tier', () => {
    expect(
      resolutionCeilingNote('4k', {
        imageModels: ['gpt_image_2'],
        videoModels: ['seedance_v2_5'],
      })
    ).toBe('Seedance 2.5 renders below 4K');
  });

  it('keeps fixed-size apart from lower — 1K is not "below 720p"', () => {
    expect(
      resolutionCeilingNote('720p', {
        imageModels: ['nano_banana_2_lite'],
        videoModels: ['veo3_1'],
      })
    ).toBe('Nano Banana 2 Lite renders at a fixed size');
    expect(
      resolutionCeilingNote('4k', {
        imageModels: ['gpt_image_2', 'nano_banana_2_lite'],
        videoModels: ['seedance_v2_5'],
      })
    ).toBe(
      'Seedance 2.5 renders below 4K · Nano Banana 2 Lite renders at a fixed size'
    );
  });

  it('collapses a long selection rather than wrapping the caption', () => {
    // GPT Image 2 keeps 4K on offer; the other three can't reach it.
    const note = resolutionCeilingNote('4k', {
      imageModels: [
        'gpt_image_2',
        'flux_2_dev',
        'flux_2_flash',
        'flux_2_turbo',
      ],
    });
    expect(note).toMatch(/and 1 more render below 4K/);
  });
});
