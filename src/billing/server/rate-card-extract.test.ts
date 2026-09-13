/**
 * The extractor's output is a trust boundary (#1605): a card the model wrote
 * is stored only when it fits the schema, reproduces every worked example
 * and prices a default request sanely. Mocked at the `chat()` boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import { rateCardSchema } from '@/billing/rate-card/rate-card.schema';
import type { RateCardSource } from './rate-card-source';

const SOURCE: RateCardSource = {
  endpointId: 'fal-ai/nano-banana-2',
  url: 'https://fal.ai/models/fal-ai/nano-banana-2/llms.txt',
  pricingSection: 'Your request will cost **$0.08** per image.',
  inputSchemaSection:
    '- **`num_images`** (`integer`, _optional_): Default value: `1`',
  text: 'Your request will cost **$0.08** per image.',
  hash: 'a'.repeat(64),
};

/** A per-image card the model might write for SOURCE. */
const perImageCard = (overrides: Record<string, unknown> = {}) => ({
  inputs: { num_images: { param: 'num_images', kind: 'number', default: 1 } },
  tables: {},
  price: { '*': [{ var: 'num_images' }, 0.08] },
  examples: [
    { params: {}, usd: 0.08, quote: 'Your request will cost $0.08 per image' },
  ],
  ...overrides,
});

const NOW = new Date('2026-09-13T00:00:00Z');

const logged = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** Load the module with `chat()` yielding `text` and the adapter stubbed. */
async function load(text: string) {
  vi.resetModules();
  vi.doMock('@/platform/logger', () => ({ getLogger: () => logged }));
  vi.doMock('@tanstack/ai', async () => ({
    ...(await vi.importActual<typeof import('@tanstack/ai')>('@tanstack/ai')),
    chat: () =>
      (async function* () {
        yield { type: 'TEXT_MESSAGE_CONTENT', delta: text };
        yield {
          type: 'RUN_FINISHED',
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            cost: 0.01,
          },
        };
      })(),
  }));
  vi.doMock('@/models/server/create-adapter', () => ({
    createAdapter: () => ({}),
  }));
  return await import('./rate-card-extract');
}

const extract = async (output: unknown, previous?: unknown) => {
  const { extractRateCard } = await load(
    typeof output === 'string' ? output : JSON.stringify(output)
  );
  return extractRateCard(SOURCE, {
    llmKey: { key: 'k', via: 'openrouter' },
    now: NOW,
    ...(previous !== undefined && {
      previous: rateCardSchema.parse(previous),
    }),
  });
};

describe('extractRateCard', () => {
  it('stores a card that reproduces its worked examples, stamped with the source', async () => {
    const result = await extract(perImageCard());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.verified).toBe(true);
    expect(result.card.source).toEqual({
      url: SOURCE.url,
      hash: SOURCE.hash,
      extractedAt: NOW.toISOString(),
    });
    expect(Number(result.costMicros)).toBe(10_000);
  });

  it('tolerates a ```json fence around the object', async () => {
    const result = await extract(
      '```json\n' + JSON.stringify(perImageCard()) + '\n```'
    );
    expect(result.status).toBe('ok');
  });

  it('rejects a card whose worked example does not reproduce, naming it', async () => {
    const result = await extract(
      perImageCard({ price: { '*': [{ var: 'num_images' }, 0.09] } })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('$0.08 per image');
    expect(result.reason).toContain('expected 0.08, got 0.09');
  });

  it('stores a card with no examples as unverified', async () => {
    const result = await extract(perImageCard({ examples: [] }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.verified).toBe(false);
  });

  it('rejects output outside the rate-card vocabulary', async () => {
    const result = await extract(
      perImageCard({ price: { pow: [{ var: 'num_images' }, 2] } })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('schema');
  });

  it('rejects a default request priced outside the sanity bounds', async () => {
    const result = await extract(
      perImageCard({
        price: { '*': [{ var: 'num_images' }, 80] },
        examples: [{ params: {}, usd: 80, quote: 'eighty' }],
      })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('$80');
  });

  it('keeps a future promo end as expiresAt and drops one already behind us', async () => {
    const future = await extract(
      perImageCard({ expiresAt: '2026-09-17T14:00:00+08:00' })
    );
    expect(future.status === 'ok' && future.card.source.expiresAt).toBe(
      '2026-09-17T06:00:00.000Z'
    );
    const past = await extract(
      perImageCard({ expiresAt: '2026-09-01T00:00:00Z' })
    );
    expect(past.status === 'ok' && past.card.source.expiresAt).toBeUndefined();
  });

  it('reports a model failure as a rejection, not a throw', async () => {
    const result = await extract('not json at all');
    expect(result.status).toBe('rejected');
  });

  it('warns when a re-extraction changes the card without the text changing', async () => {
    const previous = {
      ...perImageCard({ price: { '*': [{ var: 'num_images' }, 0.07] } }),
      source: {
        url: SOURCE.url,
        hash: SOURCE.hash,
        extractedAt: '2026-09-01T00:00:00Z',
      },
    };
    const result = await extract(perImageCard(), previous);
    expect(result.status).toBe('ok');
    expect(
      logged.warn.mock.calls.some(([message]) =>
        String(message).includes('without the source text changing')
      )
    ).toBe(true);
  });
});
