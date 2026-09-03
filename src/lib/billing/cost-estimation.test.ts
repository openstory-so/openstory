import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import {
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  estimateAudioCost,
  estimateCharacterSheetCount,
  estimateImageCost,
  estimateReferenceSheetCost,
  estimateLLMCost,
  estimateLocationSheetCount,
  estimateStoryboardCost,
  estimateStoryboardRenderCost,
  estimateStudioVideoCost,
  estimateVideoCost,
  gateEstimate,
} from './cost-estimation';
import { micros } from './money';

const IMAGE_MODEL: TextToImageModel = 'nano_banana_2';
const VIDEO_A: ImageToVideoModel = 'kling_v3_pro';
const VIDEO_B: ImageToVideoModel = 'veo3_1';
// Two audio models with genuinely different pricing (ElevenLabs is billed
// per-minute, ACE-Step per-second) so a mixed selection can't be a flat
// multiple of either.
const AUDIO_A: AudioModel = 'elevenlabs_music';
const AUDIO_B: AudioModel = 'ace_step_1_5';
const SCENE_COUNT = 8;
const DURATION = 5;

// Every estimator now requires an explicit pricing map. These tests assert
// against the checked-in seed deliberately, so they name it rather than
// relying on a default that no longer exists.
const base = {
  imageModel: IMAGE_MODEL,
  aspectRatio: '16:9' as const,
  estimatedSceneCount: SCENE_COUNT,
  pricing: FAL_PRICING,
};

/** Per-shot motion cost a model contributes across the whole storyboard. */
const motionContribution = (model: ImageToVideoModel) =>
  Number(
    estimateVideoCost(model, DURATION, {
      pricing: FAL_PRICING,
      // Storyboard always prices with cast/location refs available.
      hasReferenceImages: true,
    })
  ) * SCENE_COUNT;

/**
 * Per-sequence music cost a single audio model adds to the storyboard.
 *
 * Computed INDEPENDENTLY of `estimateStoryboardCost`, like
 * `motionContribution` above. Defining it as a difference of the function
 * under test made every assertion below `X - Y === X - Y`: tripling the
 * per-model music cost left the whole suite green, so the magnitude was
 * untested and only the bookkeeping was checked.
 *
 * The duration mirrors the default the estimator derives when
 * `audioDurationSeconds` is omitted.
 */
const audioContribution = (model: AudioModel) =>
  Number(estimateAudioCost(model, SCENE_COUNT * 5, { pricing: FAL_PRICING }));

describe('estimateCharacterSheetCount / estimateLocationSheetCount', () => {
  it('scales sheet counts with board size instead of always billing 3+3', () => {
    expect(estimateCharacterSheetCount(1)).toBe(1);
    expect(estimateLocationSheetCount(1)).toBe(1);
    expect(estimateCharacterSheetCount(6)).toBe(3);
    expect(estimateLocationSheetCount(6)).toBe(2);
    expect(estimateCharacterSheetCount(12)).toBe(3);
    expect(estimateLocationSheetCount(12)).toBe(3);
  });
});

describe('estimateStoryboardCost', () => {
  it('does not pad a one-scene board with three cast and location sheets', () => {
    const oneScene = Number(
      estimateStoryboardCost({
        ...base,
        estimatedSceneCount: 1,
        autoGenerateMotion: false,
        autoGenerateMusic: false,
      })
    );
    const sheetsIfAlwaysThree =
      Number(
        estimateImageCost(IMAGE_MODEL, '16:9', 3, { pricing: FAL_PRICING })
      ) * 2;
    const sheetsScaled =
      Number(
        estimateImageCost(IMAGE_MODEL, '16:9', 1, { pricing: FAL_PRICING })
      ) * 2;
    // Total for 1 scene stills-only = llm + 1 char + 1 loc + 1 shot.
    // If we still billed 3+3 sheets, cost would jump by (3-1)+(3-1) sheet gens.
    const oneShot = Number(
      estimateImageCost(IMAGE_MODEL, base.aspectRatio, 1, {
        pricing: FAL_PRICING,
      })
    );
    const llm = Number(estimateLLMCost(3));
    expect(oneScene).toBe(llm + sheetsScaled + oneShot);
    expect(oneScene).toBeLessThan(llm + sheetsIfAlwaysThree + oneShot);
  });

  it('adds exactly one extra per-shot image pass per image model', () => {
    const one = Number(estimateStoryboardCost({ ...base, imageModelCount: 1 }));
    const two = Number(estimateStoryboardCost({ ...base, imageModelCount: 2 }));
    // Only per-shot images scale with model count — the character/location
    // sheets and LLM analysis are charged once regardless.
    const perShotImagePass = Number(
      estimateImageCost(IMAGE_MODEL, base.aspectRatio, SCENE_COUNT, {
        pricing: FAL_PRICING,
      })
    );
    expect(two - one).toBe(perShotImagePass);
  });

  it('sums each selected video model’s own per-shot motion cost', () => {
    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    const oneModel = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A],
      })
    );
    const twoModels = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A, VIDEO_B],
      })
    );

    expect(oneModel - noMotion).toBe(motionContribution(VIDEO_A));
    expect(twoModels - noMotion).toBe(
      motionContribution(VIDEO_A) + motionContribution(VIDEO_B)
    );
  });

  it('prices a mixed selection per model, not as a flat multiple of the primary', () => {
    // Guards the regression where N models were charged at N× the primary's
    // rate. These two models have genuinely different parameter-based pricing,
    // so the true sum diverges from the flat-multiplier estimate.
    expect(motionContribution(VIDEO_A)).not.toBe(motionContribution(VIDEO_B));

    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    const mixed = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A, VIDEO_B],
      })
    );

    const trueSum = motionContribution(VIDEO_A) + motionContribution(VIDEO_B);
    const flatMultiplierEstimate = motionContribution(VIDEO_A) * 2;
    expect(mixed - noMotion).toBe(trueSum);
    expect(mixed - noMotion).not.toBe(flatMultiplierEstimate);
  });

  it('sums each selected audio model’s own per-sequence music cost', () => {
    const noMusic = Number(
      estimateStoryboardCost({ ...base, autoGenerateMusic: false })
    );
    const oneModel = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMusic: true,
        audioModels: [AUDIO_A],
      })
    );
    const twoModels = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMusic: true,
        audioModels: [AUDIO_A, AUDIO_B],
      })
    );

    expect(oneModel - noMusic).toBe(audioContribution(AUDIO_A));
    expect(twoModels - noMusic).toBe(
      audioContribution(AUDIO_A) + audioContribution(AUDIO_B)
    );
  });

  it('prices a mixed audio selection per model, not as a flat multiple of the primary', () => {
    // Guards the regression where every audio model was priced at the primary's
    // rate × count. These two models have different pricing, so the true sum
    // diverges from the flat-multiplier estimate.
    expect(audioContribution(AUDIO_A)).not.toBe(audioContribution(AUDIO_B));

    const noMusic = Number(
      estimateStoryboardCost({ ...base, autoGenerateMusic: false })
    );
    const mixed = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMusic: true,
        audioModels: [AUDIO_A, AUDIO_B],
      })
    );

    const trueSum = audioContribution(AUDIO_A) + audioContribution(AUDIO_B);
    const flatMultiplierEstimate = audioContribution(AUDIO_A) * 2;
    expect(mixed - noMusic).toBe(trueSum);
    expect(mixed - noMusic).not.toBe(flatMultiplierEstimate);
  });

  it('adds no music cost when music is off or no models are selected', () => {
    const noMusic = Number(
      estimateStoryboardCost({ ...base, autoGenerateMusic: false })
    );
    // autoGenerateMusic true but no models / empty list → nothing to bill.
    expect(
      Number(estimateStoryboardCost({ ...base, autoGenerateMusic: true }))
    ).toBe(noMusic);
    expect(
      Number(
        estimateStoryboardCost({
          ...base,
          autoGenerateMusic: true,
          audioModels: [],
        })
      )
    ).toBe(noMusic);
  });

  it('drops the shot-stills line in reference-only', () => {
    const opts = {
      ...base,
      autoGenerateMotion: true,
      videoModels: [VIDEO_A],
    };
    const withStills = Number(estimateStoryboardRenderCost(opts));
    const referenceOnly = Number(
      estimateStoryboardRenderCost({ ...opts, referenceOnly: true })
    );
    const stills = Number(
      estimateImageCost(IMAGE_MODEL, base.aspectRatio, SCENE_COUNT, {
        pricing: FAL_PRICING,
      })
    );

    expect(stills).toBeGreaterThan(0);
    expect(referenceOnly).toBe(withStills - stills);
  });

  it('prices reference-only motion at the reference-to-video rate', () => {
    // Unequal i2v vs r2v rates so a route regression cannot hide behind a
    // model that happens to price both the same (VIDEO_A does).
    const pricing = {
      ...FAL_PRICING,
      'bytedance/seedance-2.5/image-to-video': {
        unitPrice: micros(10_000),
        unit: 'units',
      },
      'bytedance/seedance-2.5/reference-to-video': {
        unitPrice: micros(20_000),
        unit: 'units',
      },
    };
    const model: ImageToVideoModel = 'seedance_v2_5';
    const perShotAtR2v = Number(
      estimateVideoCost(model, DURATION, {
        pricing,
        hasReferenceImages: true,
        referenceOnly: true,
      })
    );
    const perShotAtI2v = Number(
      estimateVideoCost(model, DURATION, { pricing, hasReferenceImages: false })
    );
    expect(perShotAtR2v).not.toBe(perShotAtI2v);

    const referenceOnly = Number(
      estimateStoryboardRenderCost({
        ...base,
        pricing,
        autoGenerateMotion: true,
        videoModels: [model],
        referenceOnly: true,
      })
    );
    // No stills line at all: the whole render is SCENE_COUNT clips at r2v.
    expect(referenceOnly).toBe(perShotAtR2v * SCENE_COUNT);
  });

  it('render cost is stills + motion + music, excluding analysis sheets and LLM', () => {
    const total = Number(
      estimateStoryboardCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A],
        autoGenerateMusic: true,
        audioModels: [AUDIO_A],
      })
    );
    const render = Number(
      estimateStoryboardRenderCost({
        ...base,
        autoGenerateMotion: true,
        videoModels: [VIDEO_A],
        autoGenerateMusic: true,
        audioModels: [AUDIO_A],
      })
    );
    const sheets =
      Number(
        estimateImageCost(
          IMAGE_MODEL,
          '16:9',
          estimateCharacterSheetCount(SCENE_COUNT),
          {
            pricing: FAL_PRICING,
          }
        )
      ) +
      Number(
        estimateImageCost(
          IMAGE_MODEL,
          '16:9',
          estimateLocationSheetCount(SCENE_COUNT),
          {
            pricing: FAL_PRICING,
          }
        )
      );
    const analysis = Number(estimateLLMCost(3)) + sheets;
    const stills = Number(
      estimateImageCost(IMAGE_MODEL, base.aspectRatio, SCENE_COUNT, {
        pricing: FAL_PRICING,
      })
    );
    expect(render).toBe(
      stills + motionContribution(VIDEO_A) + audioContribution(AUDIO_A)
    );
    expect(total).toBe(render + analysis);
  });

  it('adds no motion cost when motion is off or no models are selected', () => {
    const noMotion = Number(
      estimateStoryboardCost({ ...base, autoGenerateMotion: false })
    );
    // autoGenerateMotion true but no models / empty list → nothing to bill.
    expect(
      Number(estimateStoryboardCost({ ...base, autoGenerateMotion: true }))
    ).toBe(noMotion);
    expect(
      Number(
        estimateStoryboardCost({
          ...base,
          autoGenerateMotion: true,
          videoModels: [],
        })
      )
    ).toBe(noMotion);
    // Models present but motion disabled → still no motion cost.
    expect(
      Number(
        estimateStoryboardCost({
          ...base,
          autoGenerateMotion: false,
          videoModels: [VIDEO_A, VIDEO_B],
        })
      )
    ).toBe(noMotion);
  });
});

/**
 * The unknown-estimate floor (#1069). Grok Imagine is a real, selectable model
 * whose compute-seconds endpoint has no fal historical estimate, so
 * `estimateFalCost` returns null for it until observations accumulate — the
 * floor IS its production credit gate. Every other test here uses a priced
 * model, so `gateEstimate`'s null branch would otherwise never execute.
 */
describe('estimateVideoCost endpoint routing', () => {
  it('prices Seedance reference-to-video higher when ref endpoint is more expensive', () => {
    // Unequal rates prove we hit resolveMotionEndpoint — equal fixture prices
    // made this assertion tautological (#1140 review).
    const pricing = {
      ...FAL_PRICING,
      'bytedance/seedance-2.5/image-to-video': {
        unitPrice: micros(10_000),
        unit: 'units',
      },
      'bytedance/seedance-2.5/reference-to-video': {
        unitPrice: micros(20_000),
        unit: 'units',
      },
    };
    const i2v = estimateVideoCost('seedance_v2_5', 5, {
      pricing,
      hasReferenceImages: false,
    });
    const ref = estimateVideoCost('seedance_v2_5', 5, {
      pricing,
      hasReferenceImages: true,
    });
    expect(i2v).not.toBeNull();
    expect(ref).not.toBeNull();
    expect(ref).not.toBe(i2v);
    expect(Number(ref)).toBeGreaterThan(Number(i2v));
  });

  it('storyboard motion with Seedance tracks the ref endpoint rate', () => {
    const pricing = {
      ...FAL_PRICING,
      'bytedance/seedance-2.5/image-to-video': {
        unitPrice: micros(10_000),
        unit: 'units',
      },
      'bytedance/seedance-2.5/reference-to-video': {
        unitPrice: micros(20_000),
        unit: 'units',
      },
    };
    const stillsOnly = Number(
      estimateStoryboardCost({
        ...base,
        pricing,
        autoGenerateMotion: false,
      })
    );
    const withMotion = Number(
      estimateStoryboardCost({
        ...base,
        pricing,
        autoGenerateMotion: true,
        videoModels: ['seedance_v2_5'],
        videoDurationSeconds: DURATION,
      })
    );
    const refPerShot = Number(
      estimateVideoCost('seedance_v2_5', DURATION, {
        pricing,
        hasReferenceImages: true,
      })
    );
    expect(withMotion - stillsOnly).toBe(refPerShot * SCENE_COUNT);
  });

  it('leaves Kling on image-to-video even with refs (inline elements path)', () => {
    const withRefs = estimateVideoCost('kling_v3_pro', 5, {
      pricing: FAL_PRICING,
      hasReferenceImages: true,
    });
    const without = estimateVideoCost('kling_v3_pro', 5, {
      pricing: FAL_PRICING,
      hasReferenceImages: false,
    });
    expect(withRefs).toBe(without);
    expect(withRefs).toBe(micros(5 * 70_000));
  });

  it('prices a 5s H3 Max clip at $0.20 (8 billed units, not duration)', () => {
    expect(
      estimateVideoCost('minimax_h3_max', 5, { pricing: FAL_PRICING })
    ).toBe(micros(200_000));
    expect(
      estimateStudioVideoCost('minimax_h3_max', 5, {
        pricing: FAL_PRICING,
        mode: 'text',
      })
    ).toBe(micros(200_000));
  });

  it('prices H3 Max reference-to-video at the advertised $0.08/s', () => {
    expect(
      estimateVideoCost('minimax_h3_max', 5, {
        pricing: FAL_PRICING,
        hasReferenceImages: true,
      })
    ).toBe(micros(400_000));
    expect(
      estimateStudioVideoCost('minimax_h3_max', 5, {
        pricing: FAL_PRICING,
        mode: 'reference',
      })
    ).toBe(micros(400_000));
  });
});

describe('turbo default image (nano_banana_2_lite)', () => {
  it('returns null on fal’s $1/unit catalog stub so the gate floors at $0.10', () => {
    const stub = {
      ...FAL_PRICING,
      'google/nano-banana-2-lite': {
        unitPrice: micros(1_000_000),
        unit: 'units',
      },
    };
    expect(
      estimateImageCost('nano_banana_2_lite', '16:9', 1, { pricing: stub })
    ).toBeNull();
  });
});

describe('the resolution tier sizes the estimate (#1449)', () => {
  // The tier is one click for the user and a multiple on the bill. Left out of
  // the estimate, a 4K run is quoted — and credit-gated — at the flat stand-in
  // size, so preflight reserves a fraction of what the render actually spends.
  // qwen_image is megapixel-billed AND documents a pixel range, so the tier
  // genuinely moves both the request and the charge.
  const MEGAPIXEL_PRICED = {
    ...FAL_PRICING,
    'fal-ai/qwen-image-2/pro/text-to-image': {
      unitPrice: micros(70_000),
      unit: 'megapixels',
    },
  };

  it('prices a megapixel-billed image from the tier, not a flat size', () => {
    const at720 = estimateImageCost('qwen_image', '16:9', 1, {
      pricing: MEGAPIXEL_PRICED,
      resolution: '720p',
    });
    const at1080 = estimateImageCost('qwen_image', '16:9', 1, {
      pricing: MEGAPIXEL_PRICED,
      resolution: '1080p',
    });
    expect(at720).not.toBeNull();
    // 1920×1080 against 1280×720 — 2.25× the pixels, 2.25× the bill.
    expect(Number(at1080)).toBeCloseTo(Number(at720) * 2.25, 0);
  });

  it("leaves a model the tier can't resize quoted at its own size", () => {
    // FLUX.2 Max publishes no range, so the request keeps its preset and the
    // estimate must not pretend a 4K ask buys 4K pixels.
    const at720 = estimateImageCost('flux_2_max', '16:9', 1, {
      pricing: FAL_PRICING,
      resolution: '720p',
    });
    const at4k = estimateImageCost('flux_2_max', '16:9', 1, {
      pricing: FAL_PRICING,
      resolution: '4k',
    });
    expect(at720).not.toBeNull();
    expect(at4k).toEqual(at720);
  });

  it('prices a token-billed clip from the tier', () => {
    const tokenPriced = {
      ...FAL_PRICING,
      'fal-ai/veo3.1/image-to-video': {
        unitPrice: micros(1_000),
        unit: '1000 tokens',
      },
    };
    const at720 = estimateVideoCost('veo3_1', DURATION, {
      pricing: tokenPriced,
      resolution: '720p',
    });
    const at4k = estimateVideoCost('veo3_1', DURATION, {
      pricing: tokenPriced,
      resolution: '4k',
    });
    expect(at720).not.toBeNull();
    // 3840×2160 against 1280×720 — nine times the pixels, nine times the bill.
    expect(Number(at4k)).toBeCloseTo(Number(at720) * 9, 0);
  });
});

describe('gateEstimate', () => {
  const UNPRICED: TextToImageModel = 'grok_imagine_image';

  it('returns the honest estimate untouched when one exists', () => {
    const honest = estimateImageCost(IMAGE_MODEL, '16:9', 1, {
      pricing: FAL_PRICING,
    });
    expect(honest).not.toBeNull();
    expect(
      gateEstimate(honest, { model: IMAGE_MODEL, operation: 'shot-image' })
    ).toBe(honest);
  });

  it('substitutes the $0.10/call floor when the model has no signal', () => {
    expect(
      estimateImageCost(UNPRICED, '16:9', 1, { pricing: FAL_PRICING })
    ).toBeNull();
    // Never ZERO_MICROS: gating an unpriced model at zero lets it generate
    // with no credit check at all.
    expect(
      Number(gateEstimate(null, { model: UNPRICED, operation: 'shot-image' }))
    ).toBe(100_000);
  });

  it('scales the floor by the call count', () => {
    expect(
      Number(
        gateEstimate(null, { model: UNPRICED, operation: 'shot-image' }, 3)
      )
    ).toBe(300_000);
  });

  it('keeps a storyboard total non-null and floored when the image model is unpriced', () => {
    // Character + location sheets (scaled by scene count) + one image per
    // scene, each gated at the floor, plus the flat LLM allowance.
    const total = Number(
      estimateStoryboardCost({ ...base, imageModel: UNPRICED })
    );
    const sheets =
      estimateCharacterSheetCount(SCENE_COUNT) +
      estimateLocationSheetCount(SCENE_COUNT);
    const flooredImages = (sheets + SCENE_COUNT) * 100_000;
    const llm = Number(estimateLLMCost(3));

    expect(total).toBe(flooredImages + llm);
  });
});

describe('estimateReferenceSheetCost', () => {
  const sheets = (count: number) =>
    Number(
      estimateImageCost(IMAGE_MODEL, '16:9', count, { pricing: FAL_PRICING })
    );

  it('prices character, location and element sheets as one image each', () => {
    const cost = Number(
      estimateReferenceSheetCost({
        imageModel: IMAGE_MODEL,
        characterSheets: 2,
        locationSheets: 3,
        elementSheets: 1,
        pricing: FAL_PRICING,
      })
    );
    expect(cost).toBe(sheets(2) + sheets(3) + sheets(1));
  });

  it('charges nothing for a count of zero', () => {
    // The in-run gate reaches this whenever every cast character reuses a
    // matched talent sheet — a storage copy, not a generation. A floored
    // estimate here would over-reserve and could refuse an affordable run.
    expect(
      Number(
        estimateReferenceSheetCost({
          imageModel: IMAGE_MODEL,
          characterSheets: 0,
          locationSheets: 0,
          elementSheets: 0,
          pricing: FAL_PRICING,
        })
      )
    ).toBe(0);
  });

  it('treats element sheets as optional', () => {
    const withoutElements = estimateReferenceSheetCost({
      imageModel: IMAGE_MODEL,
      characterSheets: 1,
      locationSheets: 1,
      pricing: FAL_PRICING,
    });
    const withZeroElements = estimateReferenceSheetCost({
      imageModel: IMAGE_MODEL,
      characterSheets: 1,
      locationSheets: 1,
      elementSheets: 0,
      pricing: FAL_PRICING,
    });
    expect(Number(withoutElements)).toBe(Number(withZeroElements));
  });
});
