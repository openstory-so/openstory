/**
 * Guards for the fal pricing client (#1069): batch splitting, one bad id not
 * losing its whole batch, non-positive prices never landing, and a transient
 * fal failure never being mistaken for "fal says there is no history".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFalBilledRates,
  fetchFalBillingEvents,
  fetchFalCatalogIds,
  fetchFalTypicalUnits,
  fetchFalUnitPrices,
  fetchFalAdvertisedCallUsd,
  llmsTxtPricingSection,
  parseAdvertisedImageUsd,
  parseSizeTableUsd,
} from './fal-pricing-fetch';

const MODELS_URL = 'https://api.fal.ai/v1/models';
const PRICING_URL = 'https://api.fal.ai/v1/models/pricing';
const ESTIMATE_URL = 'https://api.fal.ai/v1/models/pricing/estimate';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => Promise.resolve(handler(String(input))))
  );
}

function priceRow(overrides: {
  endpoint_id: string;
  unit: string;
  unit_price?: number;
}) {
  return { unit_price: 0.00167, currency: 'USD', ...overrides };
}

/** endpoint ids a pricing request asked about */
function requestedIds(url: string): string[] {
  const raw = new URL(url).searchParams.get('endpoint_id') ?? '';
  return raw ? raw.split(',') : [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchFalCatalogIds', () => {
  it('paginates with the cursor and deduplicates', async () => {
    stubFetch((url) => {
      const cursor = new URL(url).searchParams.get('cursor');
      if (!cursor) {
        return json({
          models: [{ endpoint_id: 'a/one' }, { endpoint_id: 'a/two' }],
          has_more: true,
          next_cursor: 'c1',
        });
      }
      return json({
        models: [{ endpoint_id: 'a/two' }, { endpoint_id: 'a/three' }],
        has_more: false,
        next_cursor: null,
      });
    });

    expect(await fetchFalCatalogIds('key')).toEqual([
      'a/one',
      'a/two',
      'a/three',
    ]);
  });

  it('throws on an API failure', async () => {
    stubFetch(() => json({ error: 'boom' }, 500));
    await expect(fetchFalCatalogIds('key')).rejects.toThrow(/HTTP 500/);
  });
});

describe('fetchFalUnitPrices', () => {
  it('keeps the raw unit string verbatim', async () => {
    stubFetch(() =>
      json({
        prices: [
          priceRow({ endpoint_id: 'fal-ai/flux-2', unit: 'Compute Seconds' }),
        ],
      })
    );

    const { prices } = await fetchFalUnitPrices('key', ['fal-ai/flux-2']);
    expect(prices[0]?.unit).toBe('Compute Seconds');
  });

  it('splits requests into batches of 50 (the API cap)', async () => {
    vi.useFakeTimers();
    try {
      const batches: string[][] = [];
      stubFetch((url) => {
        const ids = requestedIds(url);
        batches.push(ids);
        return json({
          prices: ids.map((id) =>
            priceRow({ endpoint_id: id, unit: 'images' })
          ),
        });
      });

      const ids = Array.from({ length: 120 }, (_, i) => `m/${i}`);
      const pending = fetchFalUnitPrices('key', ids);
      await vi.runAllTimersAsync();
      const { prices } = await pending;

      expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
      expect(prices).toHaveLength(120);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bisects a failing batch so one bad id cannot lose the other prices', async () => {
    stubFetch((url) => {
      const ids = requestedIds(url);
      // The API errors on any batch containing the poisoned id.
      if (ids.includes('m/bad')) return json({ error: 'nope' }, 404);
      return json({
        prices: ids.map((id) => priceRow({ endpoint_id: id, unit: 'images' })),
      });
    });

    const { prices, failedEndpoints } = await fetchFalUnitPrices('key', [
      'm/one',
      'm/bad',
      'm/two',
      'm/three',
    ]);
    expect(prices.map((p) => p.endpointId).sort()).toEqual([
      'm/one',
      'm/three',
      'm/two',
    ]);
    expect(failedEndpoints).toEqual(['m/bad']);
  });

  it('skips a non-positive unit_price rather than storing it', async () => {
    // A 0 or null price would bill every generation on that endpoint as free.
    stubFetch(() =>
      json({
        prices: [
          priceRow({ endpoint_id: 'm/free', unit: 'images', unit_price: 0 }),
          priceRow({ endpoint_id: 'm/ok', unit: 'images' }),
        ],
      })
    );

    const { prices } = await fetchFalUnitPrices('key', ['m/free', 'm/ok']);
    expect(prices.map((p) => p.endpointId)).toEqual(['m/ok']);
  });
});

describe('fetchFalBilledRates', () => {
  const USAGE_URL = 'https://api.fal.ai/v1/models/usage';

  it('returns the billed unit and price per endpoint', async () => {
    // The whole point: the pricing API said Grok bills "compute seconds" ×
    // $0.00017; the bill says "units" × $0.01. The bill wins.
    stubFetch((url) =>
      url.startsWith(USAGE_URL)
        ? json({
            summary: [
              {
                endpoint_id: 'xai/grok-imagine-image/quality/text-to-image',
                unit: 'units',
                unit_price: 0.01,
                cost: 0.4,
              },
            ],
          })
        : json({})
    );

    const rates = await fetchFalBilledRates('admin-key');
    expect(rates).toEqual([
      {
        endpointId: 'xai/grok-imagine-image/quality/text-to-image',
        unit: 'units',
        unitPriceUsd: 0.01,
        costUsd: 0.4,
      },
    ]);
  });

  it('keeps the higher-spend entry when one endpoint shows two units', async () => {
    stubFetch(() =>
      json({
        summary: [
          { endpoint_id: 'a/b', unit: 'seconds', unit_price: 0.1, cost: 0.2 },
          { endpoint_id: 'a/b', unit: 'units', unit_price: 0.01, cost: 5 },
        ],
      })
    );

    const rates = await fetchFalBilledRates('admin-key');
    expect(rates).toHaveLength(1);
    expect(rates[0]?.unit).toBe('units');
  });

  it('throws on an API failure', async () => {
    stubFetch(() => json({ error: 'nope' }, 403));
    await expect(fetchFalBilledRates('admin-key')).rejects.toThrow(/HTTP 403/);
  });
});

describe('fetchFalBillingEvents', () => {
  const EVENTS_URL = 'https://api.fal.ai/v1/models/billing-events';

  it('maps events and follows the cursor', async () => {
    stubFetch((url) => {
      if (!url.startsWith(EVENTS_URL)) return json({});
      const cursor = new URL(url).searchParams.get('cursor');
      if (!cursor) {
        return json({
          billing_events: [
            {
              request_id: 'r1',
              endpoint_id: 'a/b',
              timestamp: '2026-07-31T06:00:00Z',
              output_units: 7,
              unit_price: 0.01,
              cost_total: 0.07,
              cost_estimate_nano_usd: 70_000_000,
            },
          ],
          next_cursor: 'c1',
          has_more: true,
        });
      }
      return json({
        billing_events: [
          {
            request_id: 'r2',
            endpoint_id: 'a/b',
            timestamp: '2026-07-31T06:01:00Z',
            output_units: 9,
            unit_price: 0.01,
            cost_total: 0.09,
            cost_estimate_nano_usd: 90_000_000,
          },
        ],
        has_more: false,
      });
    });

    const events = await fetchFalBillingEvents(
      'admin',
      new Date('2026-07-31T05:00:00Z'),
      new Date('2026-07-31T07:00:00Z')
    );
    expect(events.map((e) => e.requestId)).toEqual(['r1', 'r2']);
    expect(events[0]?.costMicros).toBe(70_000);
  });

  it('throws on an API failure', async () => {
    stubFetch(() => json({ error: 'nope' }, 403));
    await expect(
      fetchFalBillingEvents('admin', new Date(0), new Date(1))
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe('fetchFalTypicalUnits', () => {
  const price = {
    endpointId: 'fal-ai/flux-2',
    unitPriceUsd: 0.5,
    unit: 'images',
  };

  it('reports an HTTP failure as failed, not as "no history"', async () => {
    // Collapsing the two nulls the stored typicalUnitsPerCall on one blip, and
    // gpt-image-2 then gates at $1.00/image instead of $0.22 (#1062).
    stubFetch((url) =>
      url === ESTIMATE_URL ? json({ error: 'boom' }, 500) : json({})
    );

    const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
      'key',
      [price]
    );
    expect(failedEndpoints.has('fal-ai/flux-2')).toBe(true);
    expect(typicalUnits.has('fal-ai/flux-2')).toBe(false);
  });

  it('retries a 429 rather than recording it as a failure', async () => {
    // fal 429s this endpoint after ~3 requests even strictly sequential;
    // without a retry the refresh could never record a typicalUnitsPerCall.
    vi.useFakeTimers();
    try {
      let calls = 0;
      stubFetch((url) => {
        if (url !== ESTIMATE_URL) return json({});
        calls++;
        return calls < 3
          ? json({ error: 'Too Many Requests' }, 429)
          : json({ total_cost: 0.11 });
      });

      const pending = fetchFalTypicalUnits('key', [price]);
      await vi.runAllTimersAsync();
      const { typicalUnits, failedEndpoints } = await pending;

      expect(calls).toBe(3);
      expect(failedEndpoints.size).toBe(0);
      expect(typicalUnits.get('fal-ai/flux-2')).toBeCloseTo(0.22, 6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the retry budget and preserves stored data', async () => {
    vi.useFakeTimers();
    try {
      stubFetch((url) =>
        url === ESTIMATE_URL
          ? json({ error: 'Too Many Requests' }, 429)
          : json({})
      );

      const pending = fetchFalTypicalUnits('key', [price]);
      await vi.runAllTimersAsync();
      const { typicalUnits, failedEndpoints } = await pending;

      // `failed`, never `no-history` — the caller must keep what it has.
      expect(failedEndpoints.has('fal-ai/flux-2')).toBe(true);
      expect(typicalUnits.has('fal-ai/flux-2')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an unparseable 200 body as failed instead of rejecting', async () => {
    // A CDN error page served as 200 text/html must not abort the whole run.
    stubFetch((url) =>
      url === ESTIMATE_URL
        ? new Response('<html>502</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : json({})
    );

    const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
      'key',
      [price]
    );
    expect(failedEndpoints.has('fal-ai/flux-2')).toBe(true);
    expect(typicalUnits.has('fal-ai/flux-2')).toBe(false);
  });

  it('converts a historical cost to units and leaves a no-history endpoint absent from both', async () => {
    stubFetch((url) =>
      url === ESTIMATE_URL ? json({ total_cost: 0.11 }) : json({})
    );
    const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
      'key',
      [price]
    );
    expect(typicalUnits.get('fal-ai/flux-2')).toBeCloseTo(0.22, 6);

    stubFetch((url) =>
      url === ESTIMATE_URL ? json({ total_cost: 0 }) : json({})
    );
    const zero = await fetchFalTypicalUnits('key', [price]);
    expect(zero.typicalUnits.has('fal-ai/flux-2')).toBe(false);
    expect(zero.failedEndpoints.has('fal-ai/flux-2')).toBe(false);
    expect(failedEndpoints.size).toBe(0);
  });
});

describe('the pricing URL is unchanged', () => {
  it('requests the endpoints it was asked about', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return json({
        prices: [priceRow({ endpoint_id: 'fal-ai/flux-2', unit: 'images' })],
      });
    });

    await fetchFalUnitPrices('key', ['fal-ai/flux-2']);
    expect(seen[0]?.startsWith(PRICING_URL)).toBe(true);
    expect(seen[0]).toContain('endpoint_id=fal-ai%2Fflux-2');
  });

  it('lists the catalog from the models URL', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return json({ models: [], has_more: false, next_cursor: null });
    });
    await fetchFalCatalogIds('key');
    expect(seen[0]?.startsWith(MODELS_URL)).toBe(true);
  });
});

describe('llms.txt advertised price (#1605)', () => {
  const LLMS = (pricing: string) =>
    `# Model\n\n## Overview\n\nText.\n\n## Pricing\n\n${pricing}\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).\n\n## API Information\n\nStuff.\n`;

  it('reads the Pricing section only', () => {
    expect(
      llmsTxtPricingSection(LLMS('Your request will cost **$0.08** per image.'))
    ).toBe(
      'Your request will cost **$0.08** per image.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).'
    );
    expect(
      llmsTxtPricingSection('# Model\n\n## Overview\n\nno pricing')
    ).toBeNull();
  });

  it.each([
    [
      'Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times.',
      0.08,
    ],
    ['- **Price**: $0.075 per images', 0.075],
    [
      'Your request will cost **$0.09** per 1K image and **$0.18** per 4K image.',
      0.09,
    ],
    ['Your request with cost **$0.05 per output image** for 1K', 0.05],
    // A figure with a qualifier between it and the noun is not a price.
    [
      'Your request will cost **$0.04** (low) or **$0.06** (medium) per image for 1K',
      null,
    ],
    [
      'Tentative pricing is **$0.0675+ $(0.0045 x number of additional input images)** per output image',
      null,
    ],
    [
      'Text tokens (per 1M): **$5.00** input. Image tokens (per 1M): **$30.00** output.',
      null,
    ],
    ['Video costs **$0.02** per second at **768p**.', null],
  ])('%s → %s', (section, expected) => {
    expect(parseAdvertisedImageUsd(section)).toBe(expected);
  });

  // The GPT Image 2.5 description as the playground HTML embeds it: rows
  // joined by a literal backslash-n inside a JSON string, not newlines.
  const ESCAPED_TABLE =
    'standpoint.\\\\n| Size | low | medium | high | xhigh | max |\\\\n|---|---:|---:|---:|---:|---:|' +
    '\\\\n| 1024×768 | $0.00402 | $0.00903 | $0.03612 | $0.06420 | $0.14445 |' +
    '\\\\n| 1024×1024 | $0.00588 | $0.01317 | $0.05268 | $0.09366 | $0.21072 |' +
    '\\\\n| 1920×1080 | $0.00441 | $0.01029 | $0.03960 | $0.07041 | $0.15840 |\\\\n\\\\n**This implies**';

  it('reads the 1024×1024 row at the default quality from an escaped table', () => {
    expect(parseSizeTableUsd(ESCAPED_TABLE, 'high')).toBe(0.05268);
    expect(parseSizeTableUsd(ESCAPED_TABLE, 'medium')).toBe(0.01317);
    expect(parseSizeTableUsd(ESCAPED_TABLE, 'ultra')).toBeNull();
  });

  it('reads a plain markdown table too', () => {
    expect(
      parseSizeTableUsd(
        '| Size | High |\n|---|---|\n| 1024x1024 | $0.5 |\n',
        'high'
      )
    ).toBe(0.5);
  });

  it('token-rate sections fall through to the page description table', async () => {
    const html = `<html>${ESCAPED_TABLE}</html>`;
    stubFetch((url) => {
      if (url.endsWith('/llms.txt')) {
        return new Response(
          LLMS(
            'Image tokens (per 1M): **$30.00** output. Changing the **quality** parameter significantly affects cost; by default we use **high**.'
          )
        );
      }
      if (
        url === 'https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image'
      ) {
        return new Response(html);
      }
      return new Response('nope', { status: 404 });
    });
    const { advertised, failedEndpoints } = await fetchFalAdvertisedCallUsd([
      'openai/gpt-image-2.5/flare/text-to-image',
    ]);
    expect(advertised.get('openai/gpt-image-2.5/flare/text-to-image')).toBe(
      0.05268
    );
    expect(failedEndpoints.size).toBe(0);
  });

  it('a 404 is a failed fetch; an unparseable section is an honest absence', async () => {
    stubFetch((url) =>
      url.includes('gone')
        ? new Response('', { status: 404 })
        : new Response(LLMS('Video costs **$0.02** per second at **768p**.'))
    );
    const { advertised, failedEndpoints } = await fetchFalAdvertisedCallUsd([
      'fal-ai/gone',
      'minimax/h3-max/image-to-video',
    ]);
    expect(advertised.size).toBe(0);
    expect([...failedEndpoints]).toEqual(['fal-ai/gone']);
  });
});
