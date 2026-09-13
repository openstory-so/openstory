import type { RateCard } from '../rate-card.schema';

/**
 * https://fal.ai/models/minimax/h3-max/image-to-video/llms.txt and the
 * text-to-video sibling (identical text), Pricing section, read 2026-09-13:
 *
 * > Video costs **$0.0125** per second at **480p**, **$0.02** per second at
 * > **768p**, and **$0.04** per second at **1080p**.
 * > Note: these are promotional launch rates, **75%** off for a limited
 * > time. The discount ends **September 14**, after which **480p** is
 * > **$0.05** per second, **768p** is **$0.08** per second, and **1080p** is
 * > **$0.16** per second.
 *
 * Priced at the promo rate, which is what fal bills today; `expiresAt` is
 * the end of September 14 (UTC — the page names no time zone), after which
 * the card reads as unverified until the cron re-extracts the post-promo
 * text. This replaces the hand-kept "8 units per 5s clip" fallback (#1382):
 * the 768P default is the per-second row, no unit arithmetic.
 */
function h3MaxCard(url: string): RateCard {
  return {
    inputs: {
      duration: { param: 'duration', kind: 'number', default: 5 },
      resolution: {
        param: 'resolution',
        kind: 'enum',
        values: ['480P', '768P', '1080P'],
        default: '768P',
      },
    },
    tables: {
      per_second: { '480P': 0.0125, '768P': 0.02, '1080P': 0.04 },
    },
    price: {
      '*': [
        { var: 'duration' },
        { lookup: { table: 'per_second', keys: [{ var: 'resolution' }] } },
      ],
    },
    examples: [
      {
        params: { duration: 5, resolution: '768P' },
        usd: 0.1,
        quote: '$0.02 per second at 768p — 5s',
      },
      {
        params: { duration: 5, resolution: '480P' },
        usd: 0.0625,
        quote: '$0.0125 per second at 480p — 5s',
      },
      {
        params: { duration: 5, resolution: '1080P' },
        usd: 0.2,
        quote: '$0.04 per second at 1080p — 5s',
      },
    ],
    source: {
      url,
      hash: 'f26bf042b21b651431a4b298e6344fa9590cebe89d91e0a1729cc22dc4c7bdc5',
      extractedAt: '2026-09-13T00:00:00Z',
      expiresAt: '2026-09-15T00:00:00Z',
    },
  };
}

export const H3_MAX_IMAGE_TO_VIDEO = h3MaxCard(
  'https://fal.ai/models/minimax/h3-max/image-to-video/llms.txt'
);

export const H3_MAX_TEXT_TO_VIDEO = h3MaxCard(
  'https://fal.ai/models/minimax/h3-max/text-to-video/llms.txt'
);
