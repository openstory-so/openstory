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
const snapshot = vi.fn(async (_provider: string, id: string) =>
  id === 'missing' ? null : id === UNPRICED.id ? UNPRICED : HOLDABLE
);
vi.doMock('./catalog', () => ({
  ...actual,
  getSnapshotGatewayModel: snapshot,
}));
const providers =
  await vi.importActual<typeof import('./providers')>('./providers');
const configured = vi.fn((_endpointId: string) => true);
vi.doMock('./providers', () => ({
  ...providers,
  GATEWAY_DRIVERS: Object.fromEntries(
    Object.entries(providers.GATEWAY_DRIVERS).map(([provider, driver]) => [
      provider,
      { ...driver, configured },
    ])
  ),
}));
let remoteKey = false;
const remoteConfig =
  await vi.importActual<typeof import('./remote-config')>('./remote-config');
vi.doMock('./remote-config', () => ({
  ...remoteConfig,
  remoteGatewayConfigured: () => remoteKey,
}));
const {
  gatewayCannotRun,
  gatewayRunRoute,
  resolveGatewayRoute,
  resolveGatewayRoutes,
} = await import('./route');

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

  it('leaves a body built only in the run to the call', async () => {
    const route = await resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider: 'grok',
      modelId: HOLDABLE.id,
      body: null,
    });
    expect(route.via).toBe('openstory');
  });

  it('keeps a model whose provider has no platform key here on the direct path', async () => {
    configured.mockReturnValueOnce(false);
    const route = await resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider: 'grok',
      modelId: HOLDABLE.id,
      body: { n: 1 },
    });
    expect(route).toEqual({
      via: 'direct',
      reason: 'not configured on this server',
    });
    expect(configured).toHaveBeenCalledWith(HOLDABLE.endpointId);
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

describe('gatewayCannotRun', () => {
  const withSchema: GatewayModel = {
    ...HOLDABLE,
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, n: { type: 'number' } },
    },
  };

  it('runs a body the schema and card accept', () => {
    expect(gatewayCannotRun(withSchema, { prompt: 'a', n: 1 })).toBeNull();
  });

  it('names a field the endpoint does not take, such as reference images', () => {
    expect(
      gatewayCannotRun(withSchema, { prompt: 'a', n: 1, image: { url: 'x' } })
    ).toMatch(/no field named image/);
  });
});

describe('the stored snapshot only', () => {
  it('routes a model missing from the snapshot direct, with no fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const route = await resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider: 'grok',
      modelId: 'missing',
      body: null,
    });
    expect(route).toEqual({
      via: 'direct',
      reason: 'not in the gateway snapshot',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('still resolves every route while modelschemas is unreachable', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('modelschemas is down'));
    const routes = await resolveGatewayRoutes(scopedDb(false), [
      { provider: 'grok', modelId: HOLDABLE.id },
      { provider: 'grok', modelId: 'missing' },
    ]);
    expect(routes['grok/grok-imagine-image']?.via).toBe('openstory');
    expect(routes['grok/missing']?.via).toBe('direct');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('gatewayRunRoute', () => {
  const target = { provider: 'grok', modelId: HOLDABLE.id } as const;
  const routes = {
    'grok/grok-imagine-image': {
      via: 'openstory' as const,
      model: JSON.stringify(HOLDABLE),
    },
  };

  it('runs a payload from before routes existed direct', () => {
    expect(gatewayRunRoute(undefined, target, { n: 1 })).toEqual({
      via: 'direct',
      reason: 'triggered before routes',
    });
  });

  it('runs a model the trigger did not route direct', () => {
    expect(
      gatewayRunRoute(routes, { provider: 'grok', modelId: 'other' }, { n: 1 })
    ).toEqual({ via: 'direct', reason: 'not routed at the trigger' });
  });

  it('gives a step retry the same route from the same payload and body, with no read', () => {
    snapshot.mockClear();
    const first = gatewayRunRoute(routes, target, { n: 1 });
    const retry = gatewayRunRoute(routes, target, { n: 1 });
    expect(first).toEqual({ via: 'openstory', model: HOLDABLE });
    expect(retry).toEqual(first);
    expect(gatewayRunRoute(routes, target, {})).toEqual(
      gatewayRunRoute(routes, target, {})
    );
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('self-hosted on one key (#2438)', () => {
  const resolve = (provider: 'grok' | 'elevenlabs', modelId: string) =>
    resolveGatewayRoute({
      scopedDb: scopedDb(false),
      provider,
      modelId,
      body: { n: 1 },
    });

  it('sends a provider with no key here to the hosted gateway, snapshot or not', async () => {
    remoteKey = true;
    configured.mockReturnValue(false);
    try {
      expect(await resolve('grok', HOLDABLE.id)).toEqual({
        via: 'remote',
        target: { provider: 'grok', modelId: HOLDABLE.id },
      });
      expect((await resolve('grok', 'missing')).via).toBe('remote');
    } finally {
      remoteKey = false;
      configured.mockReturnValue(true);
    }
  });

  it('keeps a provider key on this install winning over the OpenStory key', async () => {
    remoteKey = true;
    try {
      expect((await resolve('grok', HOLDABLE.id)).via).toBe('openstory');
      expect(await resolve('grok', 'missing')).toEqual({
        via: 'direct',
        reason: 'not in the gateway snapshot',
      });
    } finally {
      remoteKey = false;
    }
  });

  it('keeps an organization key on the direct path', async () => {
    remoteKey = true;
    configured.mockReturnValue(false);
    try {
      const route = await resolveGatewayRoute({
        scopedDb: scopedDb(true),
        provider: 'grok',
        modelId: HOLDABLE.id,
        body: { n: 1 },
      });
      expect(route.via).toBe('direct');
    } finally {
      remoteKey = false;
      configured.mockReturnValue(true);
    }
  });

  it('never sends ElevenLabs to the hosted gateway', async () => {
    remoteKey = true;
    configured.mockReturnValue(false);
    try {
      expect(await resolve('elevenlabs', 'music_v1')).toMatchObject({
        via: 'direct',
        reason: expect.stringMatching(/saved voices/),
      });
    } finally {
      remoteKey = false;
      configured.mockReturnValue(true);
    }
  });

  it('carries the remote route on the payload and skips the local body check in the run', async () => {
    remoteKey = true;
    configured.mockReturnValue(false);
    try {
      const routes = await resolveGatewayRoutes(scopedDb(false), [
        { provider: 'grok', modelId: HOLDABLE.id },
      ]);
      expect(routes).toEqual({ 'grok/grok-imagine-image': { via: 'remote' } });
      expect(
        gatewayRunRoute(
          routes,
          { provider: 'grok', modelId: HOLDABLE.id },
          { anything: 'the hosted side checks it' }
        )
      ).toEqual({
        via: 'remote',
        target: { provider: 'grok', modelId: HOLDABLE.id },
      });
    } finally {
      remoteKey = false;
      configured.mockReturnValue(true);
    }
  });
});
