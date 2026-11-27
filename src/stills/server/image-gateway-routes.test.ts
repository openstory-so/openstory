/** The trigger's still routes: the via the direct path would take, then the gateway's own-key rule (#2434). */

import { describe, expect, it, vi } from 'vitest';
import { asStub } from '@/test/as-stub';
import type { GatewayModel } from '@/gateway/server/catalog';
import type { ScopedDb } from '@/platform/server/db/scoped';

const FLUX: GatewayModel = {
  provider: 'fal',
  id: 'fal-ai/flux-2-max',
  name: 'FLUX.2 [max]',
  kind: 'image',
  endpointId: 'fal-ai/flux-2-max',
  inputSchema: {},
  card: {
    inputs: {},
    tables: {},
    price: 0.07,
    examples: [],
    source: {
      url: 'https://fal.ai/models/fal-ai/flux-2-max',
      hash: 'a'.repeat(64),
      extractedAt: '2026-11-01T00:00:00.000Z',
    },
  },
};

const catalog = await vi.importActual<
  typeof import('@/gateway/server/catalog')
>('@/gateway/server/catalog');
vi.doMock('@/gateway/server/catalog', () => ({
  ...catalog,
  getSnapshotGatewayModel: async (_provider: string, id: string) =>
    id === FLUX.id ? FLUX : null,
}));
const providers = await vi.importActual<
  typeof import('@/gateway/server/providers')
>('@/gateway/server/providers');
vi.doMock('@/gateway/server/providers', () => ({
  ...providers,
  GATEWAY_DRIVERS: Object.fromEntries(
    Object.entries(providers.GATEWAY_DRIVERS).map(([provider, driver]) => [
      provider,
      { ...driver, configured: () => true },
    ])
  ),
}));
const { imageGatewayRoutes } = await import('./image-gateway-routes');

const scopedDb = (ownFalKey: boolean) =>
  asStub<Pick<ScopedDb, 'userId' | 'apiKeys'>>({
    userId: 'user-1',
    apiKeys: {
      hasUsableKey: async (provider: string) => ownFalKey && provider === 'fal',
      resolveOptionalKey: async (provider: string) =>
        ownFalKey && provider === 'fal'
          ? { key: 'own', source: 'organization' }
          : undefined,
      resolveKey: async () => ({ key: 'platform', source: 'platform' }),
    },
  });

describe('imageGatewayRoutes', () => {
  it('routes a fal still the snapshot can hold through the gateway', async () => {
    const routes = await imageGatewayRoutes(scopedDb(false));
    expect(routes['fal/fal-ai/flux-2-max']?.via).toBe('openstory');
  });

  it('keeps every fal still direct for an organization with its own fal key', async () => {
    const routes = await imageGatewayRoutes(scopedDb(true));
    expect(routes['fal/fal-ai/flux-2-max']).toEqual({
      via: 'direct',
      reason: 'The organization has its own key',
    });
  });

  it('lists the edit endpoint as its own target', async () => {
    const routes = await imageGatewayRoutes(scopedDb(false));
    expect(routes['fal/fal-ai/flux-2-max/edit']).toEqual({
      via: 'direct',
      reason: 'not in the gateway snapshot',
    });
  });
});
