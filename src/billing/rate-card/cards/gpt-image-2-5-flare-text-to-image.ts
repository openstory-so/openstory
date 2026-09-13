import type { Expr, RateCard } from '../rate-card.schema';

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
 * the model runs), so the card prices the canonical table. The endpoint
 * accepts any size (multiples of 16, 655,360–8,294,400 pixels) and the app
 * sends `landscape_16_9` / `portrait_16_9` or the tier's pixels (1280×720,
 * 1072×1072, …) — none of which is a canonical row, and the table is not
 * linear in area (1920×1080 costs less than 1024×1024), so a size cannot be
 * priced from the token rate. A request is therefore quoted at the
 * canonical row of its **size band**: the three large rows by pixel area
 * (≥ 6 MP → 3840×2160, ≥ 2.8 MP → 2560×1440, ≥ 1.8 MP → 1920×1080), the
 * 1024 rows by orientation. That is the page's nearest stated figure for
 * the shape, not a neighbouring endpoint's price; calibration corrects the
 * band once billed samples exist. `quality: auto` still refuses.
 *
 * Presets are fal's standard sizes (square 512², square_hd 1024²,
 * portrait_4_3 768×1024, portrait_16_9 576×1024, landscape_4_3 1024×768,
 * landscape_16_9 1024×576) and land in the band of their orientation.
 */

const W: Expr = { var: 'image_size.width' };
const H: Expr = { var: 'image_size.height' };
const AREA: Expr = { '*': [W, H] };

/** The canonical row a size falls in — see the header. */
const SIZE_BAND: Expr = {
  if: [
    { '>=': [AREA, 6_000_000] },
    '3840x2160',
    { '>=': [AREA, 2_800_000] },
    '2560x1440',
    { '>=': [AREA, 1_800_000] },
    '1920x1080',
    { '==': [W, H] },
    '1024x1024',
    { '>': [W, H] },
    '1024x768',
    '1024x1536',
  ],
};

const SIZE_QUALITY = {
  '1024x768': {
    low: 0.00402,
    medium: 0.00903,
    high: 0.03612,
    xhigh: 0.0642,
    max: 0.14445,
  },
  '1024x1024': {
    low: 0.00588,
    medium: 0.01317,
    high: 0.05268,
    xhigh: 0.09366,
    max: 0.21072,
  },
  '1024x1536': {
    low: 0.00474,
    medium: 0.01029,
    high: 0.04116,
    xhigh: 0.07377,
    max: 0.16464,
  },
  '1920x1080': {
    low: 0.00441,
    medium: 0.01029,
    high: 0.0396,
    xhigh: 0.07041,
    max: 0.1584,
  },
  '2560x1440': {
    low: 0.00615,
    medium: 0.01434,
    high: 0.05529,
    xhigh: 0.09828,
    max: 0.2211,
  },
  '3840x2160': {
    low: 0.01113,
    medium: 0.02595,
    high: 0.10008,
    xhigh: 0.1779,
    max: 0.40026,
  },
};

const PRESETS: Record<string, [number, number]> = {
  square: [512, 512],
  square_hd: [1024, 1024],
  portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1024, 576],
};

const EXTRACTED_AT = '2026-09-13T00:00:00Z';

const gptImageCard = (opts: {
  url: string;
  hash: string;
  /** Text-to-image defaults to `landscape_4_3`; edit defaults to `auto`. */
  defaultSize?: string;
}): RateCard => ({
  inputs: {
    image_size: {
      param: 'image_size',
      kind: 'dimensions',
      presets: PRESETS,
      ...(opts.defaultSize && { default: opts.defaultSize }),
    },
    quality: {
      param: 'quality',
      kind: 'enum',
      values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
      default: 'high',
    },
    num_images: { param: 'num_images', kind: 'number', default: 1 },
  },
  tables: { size_quality: SIZE_QUALITY },
  price: {
    '*': [
      { var: 'num_images' },
      {
        lookup: {
          table: 'size_quality',
          keys: [SIZE_BAND, { var: 'quality' }],
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
      params: { image_size: 'landscape_4_3' },
      usd: 0.03612,
      quote:
        'by default we use high; landscape_4_3 → | 1024×768 | … | $0.03612',
    },
    {
      params: { image_size: { width: 1024, height: 1536 }, quality: 'high' },
      usd: 0.04116,
      quote: '| 1024×1536 | … | $0.04116 (high)',
    },
    {
      params: { image_size: { width: 1920, height: 1080 }, quality: 'high' },
      usd: 0.0396,
      quote: '| 1920×1080 | … | $0.03960 (high)',
    },
    {
      params: { image_size: { width: 2560, height: 1440 }, quality: 'medium' },
      usd: 0.01434,
      quote: '| 2560×1440 | … | $0.01434 (medium)',
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
  source: { url: opts.url, hash: opts.hash, extractedAt: EXTRACTED_AT },
});

export const GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE = gptImageCard({
  url: 'https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/llms.txt',
  hash: '77ffefb96ae0c0100093d522d788b0da4319808f97d9712aa4442e218d3fff4c',
  defaultSize: 'landscape_4_3',
});

/**
 * https://fal.ai/models/openai/gpt-image-2.5/flare/edit/llms.txt — the same
 * token rates, and the playground description carries the same table,
 * "including one input image". Extra reference images cost input image
 * tokens the page does not size, so a many-reference edit under-quotes by
 * that much; calibration is where it shows. `image_size` defaults to `auto`
 * (sized from the input), which the card cannot price — the app always
 * sends a size.
 */
export const GPT_IMAGE_2_5_FLARE_EDIT = gptImageCard({
  url: 'https://fal.ai/models/openai/gpt-image-2.5/flare/edit/llms.txt',
  hash: '038a0011d47a8323cf52fcea46d5ea33e924313fb028dcd3b5a4a8d8de2178a8',
});
