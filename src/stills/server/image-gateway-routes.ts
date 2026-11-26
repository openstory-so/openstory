/** Image routes a trigger snapshots onto the payload: every still model, since a run may switch to the content fallback. */

import {
  gatewayRouteKey,
  resolveGatewayRoutes,
  type GatewayRoutes,
  type GatewayRouteTarget,
} from '@/gateway/server/route';
import {
  getEffectiveFalPricing,
  type EffectiveFalPricing,
} from '@/billing/server/fal-pricing-live';
import { priceGatewayJob } from '@/gateway/server/price';
import { gatewayHoldMicros } from '@/gateway/server/submit-job';
import { nativeGrokImageModel } from '@/models/grok-native';
import {
  imageGatewayRoute,
  resolveImageVia,
} from '@/stills/server/image-generation';
import { ASPECT_RATIOS, aspectRatioToImageSize } from '@/models/aspect-ratios';
import { RESOLUTIONS } from '@/models/resolutions';
import { gatewayHoldKey } from '@/billing/cost-estimation';
import { micros, type Microdollars } from '@/billing/money';
import type { CredentialScopedDb } from '@/platform/server/db/scoped-workflow';
import { getEditEndpoint, IMAGE_MODELS } from '@/models/models';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { typedEntries } from '@/platform/typed-object';

/**
 * The gateway targets of every still model, on the via the direct path would
 * take for this organization (`resolveImageVia`): native Grok on xAI, the fal
 * text-to-image and edit endpoints on fal. Google stills (TanStack/schemas#755)
 * and Seedream on Ark (portraits are registered on Ark by the product) get no
 * target, so they stay direct.
 */
export async function imageRouteTargets(
  scopedDb: Pick<ScopedDb, 'userId' | 'apiKeys'>
): Promise<GatewayRouteTarget[]> {
  const credentials: CredentialScopedDb = {
    userId: scopedDb.userId,
    resolveKey: (provider) => scopedDb.apiKeys.resolveKey(provider),
    resolveOptionalKey: (provider) =>
      scopedDb.apiKeys.resolveOptionalKey(provider),
  };
  const perModel = await Promise.all(
    typedEntries(IMAGE_MODELS).map(
      async ([key, model]): Promise<GatewayRouteTarget[]> => {
        const { via } = await resolveImageVia(key, credentials);
        const grokId = nativeGrokImageModel(key);
        if (via === 'xai' && grokId) {
          return [{ provider: 'grok', modelId: grokId }];
        }
        if (via !== 'fal') return [];
        const edit = getEditEndpoint(key);
        return [model.id, ...(edit ? [edit] : [])].map((modelId) => ({
          provider: 'fal' as const,
          modelId,
        }));
      }
    )
  );
  const unique = new Map(
    perModel.flat().map((t) => [gatewayRouteKey(t.provider, t.modelId), t])
  );
  return [...unique.values()];
}

export async function imageGatewayRoutes(
  scopedDb: Pick<ScopedDb, 'userId' | 'apiKeys'>
): Promise<GatewayRoutes> {
  return resolveGatewayRoutes(scopedDb, await imageRouteTargets(scopedDb));
}

/**
 * The pricing map image quotes read: for each endpoint a still can take, the
 * run's own decision (`imageGatewayRoute`) on the body each shape would send;
 * where it is `openstory`, that body's hold, by `gatewayHoldKey`.
 */
export function withGatewayImageQuotes(
  pricing: Record<string, EffectiveFalPricing>,
  routes: GatewayRoutes
): Record<string, EffectiveFalPricing> {
  const quoted = { ...pricing };
  for (const [key, model] of typedEntries(IMAGE_MODELS)) {
    const editId = getEditEndpoint(key);
    const endpoints: [string, string[]][] = [[model.id, []]];
    if (editId) endpoints.push([editId, ['/r2/quote.png']]);
    for (const [endpointId, referenceImageUrls] of endpoints) {
      const holds: Record<string, Microdollars> = {};
      for (const { value: aspectRatio } of ASPECT_RATIOS) {
        for (const resolution of [undefined, ...RESOLUTIONS]) {
          const { route, body } = imageGatewayRoute(
            {
              model: key,
              prompt: 'quote',
              imageSize: aspectRatioToImageSize(aspectRatio),
              numImages: 1,
              ...(resolution && { resolution }),
              referenceImageUrls,
            },
            routes
          );
          if (route.via !== 'openstory') continue;
          holds[gatewayHoldKey(aspectRatio, resolution)] = gatewayHoldMicros(
            priceGatewayJob(route.model.card, body)
          );
        }
      }
      if (Object.keys(holds).length === 0) continue;
      // A shape the gateway does not run keeps the fal price below.
      quoted[endpointId] = {
        ...(pricing[endpointId] ?? { unitPrice: micros(0), unit: 'images' }),
        gatewayHolds: holds,
      };
    }
  }
  return quoted;
}

/** This organization's image routes and the quote map priced from them, resolved once. */
export async function imageRoutesAndQuotes(
  scopedDb: Pick<ScopedDb, 'userId' | 'apiKeys'>
): Promise<{
  routes: GatewayRoutes;
  pricing: Record<string, EffectiveFalPricing>;
}> {
  const [pricing, routes] = await Promise.all([
    getEffectiveFalPricing(),
    imageGatewayRoutes(scopedDb),
  ]);
  return { routes, pricing: withGatewayImageQuotes(pricing, routes) };
}

/** The image quote pricing for this organization: the fal map with its `openstory` stills at the hold. */
export async function imageQuotePricing(
  scopedDb: Pick<ScopedDb, 'userId' | 'apiKeys'>
): Promise<Record<string, EffectiveFalPricing>> {
  return (await imageRoutesAndQuotes(scopedDb)).pricing;
}
