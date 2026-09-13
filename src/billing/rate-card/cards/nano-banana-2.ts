import type { RateCard } from '../rate-card.schema';

/**
 * https://fal.ai/models/fal-ai/nano-banana-2/llms.txt
 * Pricing section, read 2026-09-13:
 *
 * > Your request will cost **$0.08** per image. For **$1.00**, you can run
 * > this model **12** times. 2K and 4K outputs will be charged at **1.5**
 * > times and **2** times the standard rate, respectively. 0.5K (512px)
 * > resolution outputs will be charged at **0.75** times the standard rate.
 * > If web search is used, an additional $0.015 will be charged. If high
 * > thinking is used, an additional $0.002 will be charged.
 *
 * The surcharges are worded per request, not per image. `thinking_level`
 * has no default in the input schema; the card assumes `minimal` when absent.
 */
export const NANO_BANANA_2: RateCard = {
  inputs: {
    num_images: { param: 'num_images', kind: 'number', default: 1 },
    resolution: {
      param: 'resolution',
      kind: 'enum',
      values: ['0.5K', '1K', '2K', '4K'],
      default: '1K',
    },
    enable_web_search: {
      param: 'enable_web_search',
      kind: 'boolean',
      default: false,
    },
    thinking_level: {
      param: 'thinking_level',
      kind: 'enum',
      values: ['minimal', 'high'],
      default: 'minimal',
    },
  },
  tables: {
    multiplier: { '0.5K': 0.75, '1K': 1, '2K': 1.5, '4K': 2 },
  },
  price: {
    '+': [
      {
        '*': [
          { var: 'num_images' },
          0.08,
          { lookup: { table: 'multiplier', keys: [{ var: 'resolution' }] } },
        ],
      },
      { if: [{ var: 'enable_web_search' }, 0.015, 0] },
      { if: [{ '==': [{ var: 'thinking_level' }, 'high'] }, 0.002, 0] },
    ],
  },
  examples: [
    { params: {}, usd: 0.08, quote: 'Your request will cost $0.08 per image' },
    {
      params: { num_images: 12 },
      usd: 0.96,
      quote: 'For $1.00, you can run this model 12 times',
    },
    {
      params: { resolution: '2K' },
      usd: 0.12,
      quote: '2K and 4K outputs will be charged at 1.5 times and 2 times',
    },
    {
      params: { resolution: '4K' },
      usd: 0.16,
      quote: '4K … 2 times the standard rate',
    },
    {
      params: { resolution: '0.5K' },
      usd: 0.06,
      quote: '0.5K (512px) resolution outputs will be charged at 0.75 times',
    },
    {
      params: { enable_web_search: true, thinking_level: 'high' },
      usd: 0.097,
      quote:
        'web search … an additional $0.015; high thinking … an additional $0.002',
    },
  ],
  source: {
    url: 'https://fal.ai/models/fal-ai/nano-banana-2/llms.txt',
    hash: '358538769b1d69da27a1856d1d039c71ca901a7fa0439672cb330f79202aaa9f',
    extractedAt: '2026-09-13T00:00:00Z',
  },
};
