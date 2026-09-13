import type { RateCard } from '../rate-card.schema';

/**
 * https://fal.ai/models/xai/grok-imagine-video/v1.5/reference-to-video/llms.txt
 * Pricing section, read 2026-09-13:
 *
 * > Priced per second of output video, by resolution: **480p** at
 * > **$0.08** per sec, **720p** at **$0.14** per sec. A 5-second 480p clip costs
 * > **$0.40**; 720p costs **$0.70**. Cost scales linearly with duration. Each
 * > reference image adds **$0.01** (1–7 supported). A reference audio clip,
 * > if provided, is included
 */
export const GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO: RateCard = {
  inputs: {
    duration: { param: 'duration', kind: 'number', default: 8 },
    resolution: {
      param: 'resolution',
      kind: 'enum',
      values: ['480p', '720p'],
      default: '480p',
    },
    reference_images: { param: 'reference_image_urls', kind: 'count' },
  },
  tables: {
    per_second: { '480p': 0.08, '720p': 0.14 },
  },
  price: {
    '+': [
      {
        '*': [
          { var: 'duration' },
          { lookup: { table: 'per_second', keys: [{ var: 'resolution' }] } },
        ],
      },
      { '*': [0.01, { var: 'reference_images' }] },
    ],
  },
  examples: [
    {
      params: { duration: 5, resolution: '480p' },
      usd: 0.4,
      quote: 'A 5-second 480p clip costs $0.40',
    },
    {
      params: { duration: 5, resolution: '720p' },
      usd: 0.7,
      quote: '720p costs $0.70',
    },
    {
      params: {
        duration: 5,
        resolution: '480p',
        reference_image_urls: ['a', 'b', 'c'],
      },
      usd: 0.43,
      quote: 'Each reference image adds $0.01',
    },
  ],
  source: {
    url: 'https://fal.ai/models/xai/grok-imagine-video/v1.5/reference-to-video/llms.txt',
    hash: '3ce2c54c0b5d2dedf865ee6e108f119332d729e388b0877a7e8fdde965610ad9',
    extractedAt: '2026-09-13T00:00:00Z',
  },
};
