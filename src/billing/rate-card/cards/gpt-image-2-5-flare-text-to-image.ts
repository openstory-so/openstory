import type { RateCard } from '../rate-card.schema';

/**
 * https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/llms.txt
 * Pricing section, read 2026-09-13:
 *
 * > Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00**
 * > output. Image tokens (per 1M): **$8.00** input, **$2.00** cached,
 * > **$30.00** output. Changing the **quality** parameter significantly
 * > affects cost; by default we use **high**. Adjust it to your preference.
 * > See the description at the bottom of this page for more details on how
 * > much canonical image sizes cost. Total cost is rounded up to the closest
 * > hundredth of a cent ($0.0001.)
 *
 * The size × quality table lives only in the model description on the
 * playground page (https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image),
 * read the same day:
 *
 * > | Size      | low      | medium   | high     | xhigh    | max      |
 * > | 1024×768  | $0.00402 | $0.00903 | $0.03612 | $0.06420 | $0.14445 |
 * > | 1024×1024 | $0.00588 | $0.01317 | $0.05268 | $0.09366 | $0.21072 |
 * > | 1024×1536 | $0.00474 | $0.01029 | $0.04116 | $0.07377 | $0.16464 |
 * > | 1920×1080 | $0.00441 | $0.01029 | $0.03960 | $0.07041 | $0.15840 |
 * > | 2560×1440 | $0.00615 | $0.01434 | $0.05529 | $0.09828 | $0.22110 |
 * > | 3840×2160 | $0.01113 | $0.02595 | $0.10008 | $0.17790 | $0.40026 |
 *
 * Token rates are not a request-time lever (prompt length is unknown until
 * the model runs), so the card prices the canonical table. A size outside
 * it, or `quality: auto`, refuses rather than picks a neighbour. Presets:
 * the default `landscape_4_3` is the table's 1024×768 row, `square_hd` its
 * 1024×1024 row; the other fal presets are not in the table.
 */
export const GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE: RateCard = {
  inputs: {
    image_size: {
      param: 'image_size',
      kind: 'dimensions',
      presets: { landscape_4_3: [1024, 768], square_hd: [1024, 1024] },
      default: 'landscape_4_3',
    },
    quality: {
      param: 'quality',
      kind: 'enum',
      values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
      default: 'high',
    },
    num_images: { param: 'num_images', kind: 'number', default: 1 },
  },
  tables: {
    // [width][height][quality] → USD per image
    size_quality: {
      '1024': {
        '768': {
          low: 0.00402,
          medium: 0.00903,
          high: 0.03612,
          xhigh: 0.0642,
          max: 0.14445,
        },
        '1024': {
          low: 0.00588,
          medium: 0.01317,
          high: 0.05268,
          xhigh: 0.09366,
          max: 0.21072,
        },
        '1536': {
          low: 0.00474,
          medium: 0.01029,
          high: 0.04116,
          xhigh: 0.07377,
          max: 0.16464,
        },
      },
      '1920': {
        '1080': {
          low: 0.00441,
          medium: 0.01029,
          high: 0.0396,
          xhigh: 0.07041,
          max: 0.1584,
        },
      },
      '2560': {
        '1440': {
          low: 0.00615,
          medium: 0.01434,
          high: 0.05529,
          xhigh: 0.09828,
          max: 0.2211,
        },
      },
      '3840': {
        '2160': {
          low: 0.01113,
          medium: 0.02595,
          high: 0.10008,
          xhigh: 0.1779,
          max: 0.40026,
        },
      },
    },
  },
  price: {
    '*': [
      { var: 'num_images' },
      {
        lookup: {
          table: 'size_quality',
          keys: [
            { var: 'image_size.width' },
            { var: 'image_size.height' },
            { var: 'quality' },
          ],
        },
      },
    ],
  },
  examples: [
    {
      params: { image_size: { width: 1024, height: 1024 }, quality: 'high' },
      usd: 0.05268,
      quote: '| 1024×1024 | … | $0.05268 (high)',
    },
    {
      params: { image_size: 'square_hd', quality: 'low' },
      usd: 0.00588,
      quote: '| 1024×1024 | $0.00588 (low)',
    },
    {
      params: {},
      usd: 0.03612,
      quote:
        'by default we use high; default image_size landscape_4_3 → | 1024×768 | … | $0.03612',
    },
    {
      params: {
        image_size: { width: 3840, height: 2160 },
        quality: 'max',
        num_images: 2,
      },
      usd: 0.80052,
      quote: '| 3840×2160 | … | $0.40026 (max)',
    },
  ],
  source: {
    url: 'https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/llms.txt',
    hash: 'dd47d93739dae1f5ca0ae4351b04fc569223dff324b3c0c143fb1223b0879228',
    extractedAt: '2026-09-13T00:00:00Z',
  },
};
