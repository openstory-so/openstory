/** The run phases: more outputs than were held, and a card that refuses the usage. */

import { describe, expect, it, vi } from 'vitest';
import { micros } from '@/billing/money';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { asStub } from '@/test/as-stub';
import { rateCardSchema } from '@modelschemas/rate-card/schema';

const settleGatewayJob = vi.fn(async () => micros(0));
vi.doMock('./settle', () => ({ settleGatewayJob }));

const start = vi.fn();
vi.doMock('./providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers')>()),
  GATEWAY_DRIVERS: { grok: { start } },
}));

const { settleGatewayRun, startGatewayRun } = await import('./phases');
const { platformOnlyCredentials } = await import('./platform-credentials');
const CREDENTIALS = platformOnlyCredentials({
  organizationId: 'org-1',
  userId: 'user-1',
});

// $10 a million output tokens, read off the usage.
const PER_TOKEN = rateCardSchema.parse({
  inputs: {
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
  },
  tables: {},
  price: { '*': [{ var: 'output_tokens' }, 0.00001] },
  examples: [],
  source: {
    url: 'https://docs.example.com/pricing',
    hash: 'a'.repeat(64),
    extractedAt: '2026-11-01T00:00:00.000Z',
  },
});

const RUN = {
  jobId: 'job-1',
  provider: 'grok',
  kind: 'image',
  target: { modelId: 'grok-imagine-image', endpointId: 'v1/images' },
  card: PER_TOKEN,
  input: { prompt: 'Mara signs the ferry log' },
  estimateMicros: micros(20_000),
  platformFeeBps: 0,
  oauthClientId: null,
  reservationId: 'res-1',
} as const;

// $0.04 an image, priced off the request's `n`.
const PER_IMAGE = rateCardSchema.parse({
  inputs: { n: { param: 'n', bound: 'request', kind: 'number' } },
  tables: {},
  price: { '*': [{ var: 'n' }, 0.04] },
  examples: [],
  source: PER_TOKEN.source,
});

// $0.03 a megapixel, read off the usage: what Flux 2 Max's card charges.
const PER_MEGAPIXEL = rateCardSchema.parse({
  inputs: {
    megapixels: { param: 'megapixels', bound: 'usage', kind: 'number' },
  },
  tables: {},
  price: { '*': [{ var: 'megapixels' }, 0.03] },
  examples: [],
  source: PER_TOKEN.source,
});

// $0.04 a request plus $0.01 an input image: outputs are priced per request.
const PER_INPUT_IMAGE = rateCardSchema.parse({
  inputs: {
    n: { param: 'n', bound: 'request', kind: 'number' },
    input_images: { param: 'input_images', bound: 'usage', kind: 'number' },
  },
  tables: {},
  price: {
    '+': [
      { '*': [{ var: 'n' }, 0.04] },
      { '*': [{ var: 'input_images' }, 0.01] },
    ],
  },
  examples: [],
  source: PER_TOKEN.source,
});

describe('startGatewayRun', () => {
  it('stores and charges only the outputs the request held when the model returns more', async () => {
    const media = { url: 'https://a.example/1.png', contentType: 'image/png' };
    start.mockResolvedValue({
      result: { media: [media, media, media], usage: null, requestId: null },
    });
    const store = vi.fn(async (_media: unknown, index: number) => ({
      url: `/r2/output-${index}.png`,
      path: `output-${index}.png`,
      contentType: 'image/png',
    }));
    const run = { ...RUN, card: PER_IMAGE, input: { ...RUN.input, n: 2 } };

    const started = await startGatewayRun(run, CREDENTIALS, store);
    expect(store).toHaveBeenCalledTimes(2);
    if (!('stored' in started)) throw new Error('not stored');
    expect(started.stored.outputs).toHaveLength(2);

    await settleGatewayRun(
      asStub<WorkflowScopedDb>({}),
      run,
      started.stored,
      'run-1:gateway-settle'
    );
    expect(settleGatewayJob).toHaveBeenCalledTimes(1);
    expect(settleGatewayJob).toHaveBeenCalledWith(
      expect.objectContaining({ costMicros: micros(80_000) })
    );
  });

  it('stores and charges every output when the card charges from usage (Flux 2 Max, megapixels)', async () => {
    const media = { url: 'https://a.example/1.png', contentType: 'image/png' };
    start.mockResolvedValue({
      result: {
        media: [media, media, media],
        usage: { megapixels: 3 },
        requestId: null,
      },
    });
    const store = vi.fn(async (_media: unknown, index: number) => ({
      url: `/r2/output-${index}.png`,
      path: `output-${index}.png`,
      contentType: 'image/png',
    }));
    const run = { ...RUN, card: PER_MEGAPIXEL, input: { ...RUN.input, n: 1 } };

    const started = await startGatewayRun(run, CREDENTIALS, store);
    expect(store).toHaveBeenCalledTimes(3);
    if (!('stored' in started)) throw new Error('not stored');
    expect(started.stored.outputs).toHaveLength(3);

    await settleGatewayRun(
      asStub<WorkflowScopedDb>({}),
      run,
      started.stored,
      'run-1:gateway-settle'
    );
    expect(settleGatewayJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ costMicros: micros(90_000) })
    );
  });

  it('drops extra outputs when the only usage lever is an input quantity', async () => {
    const media = { url: 'https://a.example/1.png', contentType: 'image/png' };
    start.mockResolvedValue({
      result: {
        media: [media, media, media],
        usage: { input_images: 2 },
        requestId: null,
      },
    });
    const store = vi.fn(async (_media: unknown, index: number) => ({
      url: `/r2/output-${index}.png`,
      path: `output-${index}.png`,
      contentType: 'image/png',
    }));
    const run = {
      ...RUN,
      card: PER_INPUT_IMAGE,
      input: { ...RUN.input, n: 1 },
    };

    const started = await startGatewayRun(run, CREDENTIALS, store);
    expect(store).toHaveBeenCalledTimes(1);
    if (!('stored' in started)) throw new Error('not stored');
    expect(started.stored.outputs).toHaveLength(1);
  });
});

describe('settleGatewayRun', () => {
  it('settles at zero cost, so the held estimate is charged, when the card cannot read the usage', async () => {
    await settleGatewayRun(
      asStub<WorkflowScopedDb>({}),
      RUN,
      { outputs: [], requestId: 'req-1', usageJson: '{"seconds":5}' },
      'run-1:gateway-settle'
    );
    expect(settleGatewayJob).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(0),
        estimateMicros: micros(20_000),
        reservationId: 'res-1',
      })
    );
  });
});
