import { afterEach, describe, expect, test, vi } from 'vitest';

const card = {
  inputs: {
    resolution: {
      param: 'resolution',
      bound: 'request',
      kind: 'enum',
      values: ['1K', '2K'],
      default: '1K',
    },
  },
  tables: { multiplier: { '1K': 1, '2K': 1.5 } },
  price: {
    '*': [
      0.08,
      { lookup: { table: 'multiplier', keys: [{ var: 'resolution' }] } },
    ],
  },
  examples: [],
  source: {
    url: 'https://fal.ai/models/fal-ai/nano-banana-2/llms.txt',
    hash: 'a'.repeat(64),
    extractedAt: '2026-10-22T00:00:00.000Z',
  },
};

describe('fetchFalRateCards', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('stores a card and skips an endpoint whose pricing is not a card', async () => {
    vi.doMock('#env', () => ({ getEnv: () => ({}) }));
    const fetchMock = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      if (id === 'fal-ai/nano-banana-2') {
        return new Response(JSON.stringify({ pricing: card }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ pricing: { currency: 'USD', per: 'image' } }),
        {
          status: 200,
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchFalRateCards } = await import('./fetch-rate-cards');

    const cards = await fetchFalRateCards([
      'fal-ai/nano-banana-2',
      'openai/gpt-image-2.5/flare/text-to-image',
    ]);

    expect(cards.size).toBe(1);
    expect(cards.get('fal-ai/nano-banana-2')?.source.hash).toBe('a'.repeat(64));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://modelschemas.com/v1/models/fal/fal-ai%2Fnano-banana-2',
      expect.objectContaining({ headers: { Accept: 'application/json' } })
    );
  });

  test('a failed fetch leaves that endpoint out', async () => {
    vi.doMock('#env', () => ({ getEnv: () => ({}) }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    const { fetchFalRateCards } = await import('./fetch-rate-cards');

    const cards = await fetchFalRateCards(['fal-ai/nano-banana-2']);

    expect(cards.size).toBe(0);
  });
});
