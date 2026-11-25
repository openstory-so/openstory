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

describe('startGatewayRun', () => {
  it('stores nothing when the model returns more outputs than the request held', async () => {
    const media = { url: 'https://a.example/1.png', contentType: 'image/png' };
    start.mockResolvedValue({
      result: { media: [media, media, media], usage: null, requestId: null },
    });
    const store = vi.fn();
    await expect(
      startGatewayRun({ ...RUN, input: { ...RUN.input, n: 2 } }, {}, store)
    ).rejects.toThrow('The model returned 3 outputs; the request held 2');
    await expect(startGatewayRun(RUN, {}, store)).rejects.toThrow(
      'the request held 1'
    );
    expect(store).not.toHaveBeenCalled();
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
