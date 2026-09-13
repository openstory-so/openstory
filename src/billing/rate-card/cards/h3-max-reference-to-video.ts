import type { RateCard } from '../rate-card.schema';

/**
 * https://fal.ai/models/minimax/h3-max/reference-to-video/llms.txt
 * Pricing section, read 2026-09-13:
 *
 * > Billing is calculated per second of output video, plus a charge for
 * > reference inputs beyond an included allowance. Video costs **$0.05** per
 * > second at **480p**, **$0.08** per second at **768p**, and **$0.16** per
 * > second at **1080p**, so a **5-second** **768p** clip costs **$0.40**.
 * > Reference billing calculated as tokens. First **4096** tokens are
 * > included there will be no charge, after **4096** tokens each **1K**
 * > reference token cost will be **$0.02**. An **1024x1024** image is 1k
 * > tokens, so first **4** reference image will be free, then each
 * > **1024x1024** image will cost 1k token so **$0.02** An **2048x2048**
 * > image is **4k** tokens, so first image will be free then each will cost
 * > **$0.08**
 *
 * Reference tokens scale with pixels (1024² = 1K, 2048² = 4K). The request
 * carries URLs, not sizes, so `reference_image_pixels` is a card-level
 * lever the caller supplies from the sheets it uploaded; it defaults to
 * 1024². Excess tokens bill per started 1K — that is what makes both of the
 * page's per-image examples ($0.02 for the 5th 1024², $0.08 for the 2nd
 * 2048²) exact instead of 2–4% off.
 */
export const H3_MAX_REFERENCE_TO_VIDEO: RateCard = {
  inputs: {
    duration: { param: 'duration', kind: 'number', default: 5 },
    resolution: {
      param: 'resolution',
      kind: 'enum',
      values: ['480P', '768P', '1080P'],
      default: '768P',
    },
    reference_images: { param: 'reference_image_urls', kind: 'count' },
    reference_image_pixels: {
      param: 'reference_image_pixels',
      kind: 'number',
      default: 1024 * 1024,
    },
  },
  tables: {
    per_second: { '480P': 0.05, '768P': 0.08, '1080P': 0.16 },
  },
  price: {
    '+': [
      {
        '*': [
          { var: 'duration' },
          { lookup: { table: 'per_second', keys: [{ var: 'resolution' }] } },
        ],
      },
      {
        '*': [
          0.02,
          {
            ceil: [
              {
                '/': [
                  {
                    max: [
                      0,
                      {
                        '-': [
                          {
                            '*': [
                              { var: 'reference_images' },
                              {
                                '/': [
                                  { var: 'reference_image_pixels' },
                                  1024 * 1024,
                                ],
                              },
                              1000,
                            ],
                          },
                          4096,
                        ],
                      },
                    ],
                  },
                  1000,
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  examples: [
    {
      params: { duration: 5, resolution: '768P' },
      usd: 0.4,
      quote: 'a 5-second 768p clip costs $0.40',
    },
    {
      params: {
        duration: 5,
        resolution: '768P',
        reference_image_urls: ['1', '2', '3', '4'],
      },
      usd: 0.4,
      quote: 'first 4 reference image will be free',
    },
    {
      params: {
        duration: 5,
        resolution: '768P',
        reference_image_urls: ['1', '2', '3', '4', '5'],
      },
      usd: 0.42,
      quote: 'then each 1024x1024 image will cost 1k token so $0.02',
    },
    {
      params: {
        duration: 5,
        resolution: '768P',
        reference_image_urls: ['1', '2'],
        reference_image_pixels: 2048 * 2048,
      },
      usd: 0.48,
      quote:
        'An 2048x2048 image is 4k tokens, so first image will be free then each will cost $0.08',
    },
  ],
  source: {
    url: 'https://fal.ai/models/minimax/h3-max/reference-to-video/llms.txt',
    hash: 'e1d6d1c7b32bd92cbdfb8b2f1a4f116c2fbcdabec361a678343df2c6b0eae860',
    extractedAt: '2026-09-13T00:00:00Z',
  },
};
