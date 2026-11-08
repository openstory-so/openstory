import { describe, expect, it } from 'vitest';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { z } from 'zod';
import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/models/models';
import { motionResolutionTiers } from '@/motion/model-capabilities';
import { estimateVideoCost } from './cost-estimation';
import type { EffectiveFalPricing } from './fal-cost';
import { usdToMicros } from './money';
import cards from './motion-rate-cards.fixture.json';

// modelschemas cards for our motion endpoints, as fetched on 2026-11-07.
const CARDS = z.record(z.string(), rateCardSchema).parse(cards);

// Per-second rate each card lists for the token submit sends at each tier.
const EXPECTED_PER_SECOND: Partial<
  Record<ImageToVideoModel, Partial<Record<string, number>>>
> = {
  grok_imagine_video_1_5: { '720p': 0.14, '1080p': 0.25 },
  gemini_omni_flash: { '720p': 0.0819, '1080p': 0.1229, '4k': 0.2457 },
  kling_v4: { '720p': 0.157, '1080p': 0.235 },
  minimax_h3_max: { '720p': 0.056, '1080p': 0.112 },
  seedance_v2_mini: { '720p': 0.1547 },
  seedance_v2_5: { '720p': 0.473, '1080p': 1.164 },
};

/** A busy endpoint: an observed median that knows nothing about tiers. */
function pricingFor(endpointId: string): Record<string, EffectiveFalPricing> {
  return {
    [endpointId]: {
      unitPrice: usdToMicros(0.1),
      unit: 'seconds',
      observed: { medianUnits: 5, sampleCount: 50 },
      rateCard: CARDS[endpointId],
    },
  };
}

describe('motion estimates follow the modelschemas card per tier', () => {
  const models: ImageToVideoModel[] = [
    'grok_imagine_video_1_5',
    'gemini_omni_flash',
    'kling_v4',
    'minimax_h3_max',
    'seedance_v2_mini',
    'seedance_v2_5',
  ];

  it.each(models)('%s prices every tier the picker offers', (model) => {
    const endpointId = IMAGE_TO_VIDEO_MODELS[model].id;
    expect(CARDS[endpointId]).toBeDefined();
    for (const tier of motionResolutionTiers(model)) {
      const perSecond = EXPECTED_PER_SECOND[model]?.[tier];
      expect(perSecond, `${model} ${tier}`).toBeDefined();
      const cost = estimateVideoCost(model, 5, {
        pricing: pricingFor(endpointId),
        resolution: tier,
      });
      expect(cost, `${model} ${tier}`).toBe(usdToMicros(5 * (perSecond ?? 0)));
    }
  });

  it('prices an H3 Max 720p ask at the 768P it renders', () => {
    const endpointId = IMAGE_TO_VIDEO_MODELS.minimax_h3_max.id;
    const cost = estimateVideoCost('minimax_h3_max', 5, {
      pricing: pricingFor(endpointId),
      resolution: '720p',
    });
    expect(cost).toBe(usdToMicros(0.28));
  });

  it('prices an H3 Max reference shot on its own card', () => {
    const endpointId = 'minimax/h3-max/reference-to-video';
    const cost = estimateVideoCost('minimax_h3_max', 5, {
      pricing: pricingFor(endpointId),
      resolution: '1080p',
      hasReferenceImages: true,
    });
    expect(cost).toBe(usdToMicros(0.8));
  });

  it('keeps the observed median where the card has no resolution lever', () => {
    const endpointId = IMAGE_TO_VIDEO_MODELS.kling_v3_pro.id;
    const cost = estimateVideoCost('kling_v3_pro', 5, {
      pricing: pricingFor(endpointId),
      resolution: '1080p',
    });
    expect(cost).toBe(usdToMicros(0.5));
  });
});
