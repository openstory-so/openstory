/** The three routes: own key -> direct; platform key and a holdable card -> openstory; else direct with why. */

import { describe, expect, it, vi } from 'vitest';
import type { GatewayModel } from '@/gateway/server/catalog';

const SOURCE = {
  url: 'https://docs.example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
};
const HOLDABLE: GatewayModel = {
  provider: 'grok',
  id: 'grok-imagine-image',
  name: 'Grok Imagine Image',
  kind: 'image',
  endpointId: 'v1/images/generations',
  inputSchema: {},
  card: {
    inputs: { n: { param: 'n', bound: 'request', kind: 'number' } },
    tables: {},
    price: { '*': [{ var: 'n' }, 0.02] },
    examples: [],
    source: SOURCE,
  },
};
const UNPRICED: GatewayModel = {
  ...HOLDABLE,
  id: 'tokens-model',
  card: {
    inputs: {
      output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
    },
    tables: {},
    price: { '*': [{ var: 'output_tokens' }, 0.00001] },
    examples: [],
    source: SOURCE,
  },
};

const actual = await vi.importActual<typeof import('./catalog')>('./catalog');
vi.doMock('./catalog', () => ({
  ...actual,
  getGatewayModel: async (_provider: string, id: string) =>
    id === UNPRICED.id ? UNPRICED : HOLDABLE,
}));
const { resolveGatewayRoute } = await import('./route');

const scopedDb = (ownKey: boolean) => ({
  apiKeys: { hasUsableKey: vi.fn(async () => ownKey) },
});

describe('resolveGatewayRoute', () => {
  it('keeps an organization with its own key on the direct path', async () => {
    const db = scopedDb(true);
    const route = await resolveGatewayRoute({
      scopedDb: db,
      provider: 'grok',
      modelId: HOLDABLE.id,
      body: { n: 1 },
    });
    expect(route.via).toBe('direct');
    expect(db.apiKeys.hasUsableKey).toHaveBeenCalledWith('xai');
  });

  it('sends a platform-key call the card can hold through the gateway', async () => {
    const route = await resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider: 'grok',
      modelId: HOLDABLE.id,
      body: { n: 1 },
    });
    expect(route).toEqual({ via: 'openstory', model: HOLDABLE });
  });

  it('keeps a model the card cannot hold on the direct path, saying why', async () => {
    const route = await resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider: 'grok',
      modelId: UNPRICED.id,
      body: {},
    });
    expect(route).toEqual({
      via: 'direct',
      reason: 'No price yet for this model',
    });
  });

  it('keeps a request the card cannot price on the direct path', async () => {
    const route = await resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider: 'grok',
      modelId: HOLDABLE.id,
      body: {},
    });
    expect(route.via).toBe('direct');
  });

  it('never checks an own key for platform-only BytePlus', async () => {
    const db = scopedDb(true);
    const route = await resolveGatewayRoute({
      scopedDb: db,
      provider: 'byteplus',
      modelId: HOLDABLE.id,
      body: { n: 1 },
    });
    expect(route.via).toBe('openstory');
    expect(db.apiKeys.hasUsableKey).not.toHaveBeenCalled();
  });
});
