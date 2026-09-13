import type { RateCard } from '../rate-card.schema';

/**
 * https://docs.byteplus.com/en/docs/ModelArk/1544106 (Model pricing),
 * dola-seedream-5-0-pro-260628, read 2026-09-13 from the page's embedded
 * document JSON, USD per image:
 *
 * > Pricing varies by image generation scenario. Single image generation:
 * > ≤ 2.61 million pixels (1.5K or lower): 0.045; > 2.61 million pixels
 * > (higher than 1.5K): 0.09. Layer decomposition: ≤ 2.61 million pixels:
 * > 0.0225; > 2.61 million pixels: 0.045.
 *
 * Bound to the fal-shaped `image_size` the estimator builds — explicit
 * `{width, height}` for this model (`IMAGE_RESOLUTION.seedream_v5`), or a
 * fal preset name; the presets are fal's published sizes. Layer
 * decomposition is not a request we send. The tier boundary moved from the
 * 2.36 MP the retired single-number entry assumed: a 2048×1152 still is now
 * the lower tier, and the drift report says whether Ark agrees.
 */
export const BYTEPLUS_SEEDREAM_5_0_PRO: RateCard = {
  inputs: {
    image_size: {
      param: 'image_size',
      kind: 'dimensions',
      presets: {
        square_hd: [1024, 1024],
        square: [512, 512],
        portrait_4_3: [768, 1024],
        portrait_16_9: [576, 1024],
        landscape_4_3: [1024, 768],
        landscape_16_9: [1024, 576],
      },
      default: 'landscape_4_3',
    },
    num_images: { param: 'num_images', kind: 'number', default: 1 },
  },
  tables: {},
  price: {
    '*': [
      { var: 'num_images' },
      {
        if: [
          {
            '<=': [
              {
                '*': [
                  { var: 'image_size.width' },
                  { var: 'image_size.height' },
                ],
              },
              2_610_000,
            ],
          },
          0.045,
          0.09,
        ],
      },
    ],
  },
  examples: [
    {
      params: { image_size: { width: 1024, height: 1024 } },
      usd: 0.045,
      quote: '≤ 2.61 million pixels (1.5K or lower): 0.045',
    },
    {
      params: { image_size: { width: 2048, height: 2048 }, num_images: 2 },
      usd: 0.18,
      quote: '> 2.61 million pixels (higher than 1.5K): 0.09',
    },
  ],
  source: {
    url: 'https://docs.byteplus.com/en/docs/ModelArk/1544106',
    hash: '20d9e65536550bfa6183b4b49baccf1fc9b43cc000a4d93037d1954eb66b0d74',
    extractedAt: '2026-09-13T00:00:00Z',
  },
};
