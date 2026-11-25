/** Image routes a trigger snapshots onto the payload: every Grok image model, since a run may switch to the content fallback. */

import {
  gatewayRouteKey,
  resolveGatewayRoute,
  type GatewayRoutes,
} from '@/gateway/server/route';
import { nativeGrokImageModel } from '@/models/grok-native';
import { IMAGE_MODELS } from '@/models/models';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { typedEntries } from '@/platform/typed-object';

/** Grok only: the product builds no gateway body for fal, Seedream or Gemini stills yet (docs/architecture/model-gateway.md). */
export async function imageGatewayRoutes(
  scopedDb: Pick<ScopedDb, 'apiKeys'>
): Promise<GatewayRoutes> {
  const ids = new Set(
    typedEntries(IMAGE_MODELS).flatMap(([key]) => {
      const id = nativeGrokImageModel(key);
      return id ? [id] : [];
    })
  );
  const routes = await Promise.all(
    [...ids].map(
      async (modelId) =>
        [
          gatewayRouteKey('grok', modelId),
          await resolveGatewayRoute({
            scopedDb,
            provider: 'grok',
            modelId,
            body: null,
          }),
        ] as const
    )
  );
  return Object.fromEntries(routes);
}
