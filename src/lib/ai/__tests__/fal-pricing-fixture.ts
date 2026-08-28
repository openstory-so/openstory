/**
 * Test stand-in for the live `model_pricing` map, with realistic prices for
 * the endpoints unit tests exercise. Grok Imagine deliberately carries no
 * unit-count signal so the unknown-estimate (null → floor) path stays
 * covered.
 */
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { micros } from '@/lib/billing/money';

export const TEST_FAL_PRICING: Record<string, EffectiveFalPricing> = {
  // Image models
  'fal-ai/nano-banana-2': {
    unitPrice: micros(80_000),
    unit: 'images',
    typicalUnitsPerCall: 1.5,
  },
  'openai/gpt-image-2': {
    unitPrice: micros(1_000_000),
    unit: 'units',
    typicalUnitsPerCall: 0.22,
  },
  'xai/grok-imagine-image/v2.0/text-to-image': {
    unitPrice: micros(170),
    unit: 'compute seconds',
  },
  'fal-ai/flux-2-max': { unitPrice: micros(70_000), unit: 'megapixels' },
  // Video models
  'fal-ai/kling-video/v3/pro/image-to-video': {
    unitPrice: micros(70_000),
    unit: 'seconds',
  },
  'fal-ai/veo3.1/image-to-video': {
    unitPrice: micros(400_000),
    unit: 'seconds',
  },
  'fal-ai/ltx-2.3/image-to-video': {
    unitPrice: micros(40_000),
    unit: 'seconds',
  },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': {
    unitPrice: micros(490_000),
    unit: 'units',
    typicalUnitsPerCall: 1,
  },
  'minimax/h3-max/image-to-video': {
    unitPrice: micros(25_000),
    unit: 'seconds',
    typicalUnitsPerCall: 8,
  },
  'minimax/h3-max/text-to-video': {
    unitPrice: micros(25_000),
    unit: 'seconds',
    typicalUnitsPerCall: 8,
  },
  'bytedance/seedance-2.5/image-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  // Same unit rate as i2v today; listed so reference-route estimates resolve.
  'bytedance/seedance-2.5/reference-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  'bytedance/seedance-2.5/text-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  'bytedance/seedance-2.0/enterprise/v2/text-to-video': {
    unitPrice: micros(14_000),
    unit: 'units',
  },
  'xai/grok-imagine-video/v1.5/image-to-video': {
    unitPrice: micros(50_000),
    unit: 'videos',
    typicalUnitsPerCall: 1,
  },
  // Audio models
  'fal-ai/elevenlabs/music': { unitPrice: micros(800_000), unit: 'minutes' },
  'fal-ai/ace-step-1.5': { unitPrice: micros(500), unit: 'units' },
};
