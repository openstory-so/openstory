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
    '- **`num_images`** (`integer`, _optional_): Default value: `1`\n- **`quality`** (`QualityEnum`, _optional_): Default value: `"high"`',
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
    expect(result.status === 'rejected' && result.transient).toBe(false);
  });

  it('marks a failed call transient so the same text is retried tomorrow', async () => {
    vi.resetModules();
    vi.doMock('@/platform/logger', () => ({ getLogger: () => logged }));
    vi.doMock('@tanstack/ai', async () => ({
      ...(await vi.importActual<typeof import('@tanstack/ai')>('@tanstack/ai')),
      chat: () =>
        (async function* () {
          yield* [];
          throw new Error('502 upstream');
        })(),
    }));
    vi.doMock('@/models/server/create-adapter', () => ({
      createAdapter: () => ({}),
    }));
    const { extractRateCard } = await import('./rate-card-extract');
    const result = await extractRateCard(SOURCE, {
      llmKey: { key: 'k', via: 'openrouter' },
      now: NOW,
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.transient).toBe(true);
    expect(result.reason).toContain('502 upstream');
  });

  // The model writes both the card and the examples, so a lever it invents
  // is "verified" by examples nobody could send. Real request: the H3 Max
  // card that bound `reference_tokens` and dropped the reference surcharge.
  it('rejects a lever bound to a param the Input Schema does not declare', async () => {
    const result = await extract(
      perImageCard({
        inputs: {
          num_images: { param: 'num_images', kind: 'number', default: 1 },
          tokens: { param: 'reference_tokens', kind: 'number', default: 0 },
        },
        price: {
          '+': [
            { '*': [{ var: 'num_images' }, 0.08] },
            { '*': [{ var: 'tokens' }, 0.00002] },
          ],
        },
        examples: [
          { params: {}, usd: 0.08, quote: '$0.08 per image' },
          { params: { reference_tokens: 1000 }, usd: 0.1, quote: 'invented' },
        ],
      })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('reference_tokens');
  });

  it('rejects an example keyed by a param the Input Schema does not declare', async () => {
    const result = await extract(
      perImageCard({
        examples: [
          { params: { output_tokens: 5 }, usd: 0.08, quote: 'made up' },
        ],
      })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('output_tokens');
  });

  // The Kling / H3 Max hand cards bind card-level levers (`voice_control`,
  // `reference_image_pixels`); an extraction may not — the live H3 Max run
  // bound the pixels lever as a total budget and dropped the URL count.
  it('rejects a card-level lever a hand card may bind', async () => {
    const result = await extract(
      perImageCard({
        inputs: {
          num_images: { param: 'num_images', kind: 'number', default: 1 },
          voice: { param: 'voice_control', kind: 'boolean', default: false },
        },
        price: {
          '*': [{ var: 'num_images' }, { if: [{ var: 'voice' }, 0.1, 0.08] }],
        },
      })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('voice_control');
  });

  it('rejects a lookup with a default — an unpriced shape must refuse', async () => {
    const result = await extract(
      perImageCard({
        inputs: {
          num_images: { param: 'num_images', kind: 'number', default: 1 },
          quality: {
            param: 'quality',
            kind: 'enum',
            values: ['low', 'high'],
            default: 'high',
          },
        },
        tables: { per_image: { high: 0.08 } },
        price: {
          '*': [
            { var: 'num_images' },
            {
              lookup: {
                table: 'per_image',
                keys: [{ var: 'quality' }],
                default: 0.08,
              },
            },
          ],
        },
      })
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toContain('lookup');
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
