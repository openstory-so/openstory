/** Image routes a trigger snapshots onto the payload: every Grok image model, since a run may switch to the content fallback. */

import {
  resolveGatewayRoutes,
  type GatewayRoutes,
} from '@/gateway/server/route';
import {
  getEffectiveFalPricing,
  type EffectiveFalPricing,
} from '@/billing/server/fal-pricing-live';
import { priceGatewayJob } from '@/gateway/server/price';
import { gatewayHoldMicros } from '@/gateway/server/submit-job';
import { nativeGrokImageModel } from '@/models/grok-native';
import { gatewayImageRequest } from '@/stills/server/image-generation';
import { getEditEndpoint, IMAGE_MODELS } from '@/models/models';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { typedEntries } from '@/platform/typed-object';

/** Grok only: the product builds no gateway body for fal, Seedream or Gemini stills yet (docs/architecture/model-gateway.md). */
export function imageGatewayRoutes(
  scopedDb: Pick<ScopedDb, 'apiKeys'>
): Promise<GatewayRoutes> {
  const ids = new Set(
    typedEntries(IMAGE_MODELS).flatMap(([key]) => {
      const id = nativeGrokImageModel(key);
      return id ? [id] : [];
    })
  );
  return resolveGatewayRoutes(
    scopedDb,
    [...ids].map((modelId) => ({ provider: 'grok' as const, modelId }))
  );
}

/**
 * The pricing map image quotes read: each endpoint a still would take is
 * priced by the run's own decision (`gatewayImageRequest`), so the hold where
 * it routes `openstory`; a quote with references reads the edit endpoint.
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
      // Grok's price reads only the count and quality, so one still's body prices every size.
      const request = gatewayImageRequest(
        {
          model: key,
          prompt: 'quote',
          imageSize: 'landscape_16_9',
          numImages: 1,
          referenceImageUrls,
        },
        routes
      );
      if (!request) continue;
      quoted[endpointId] = {
        unitPrice: gatewayHoldMicros(
          priceGatewayJob(request.model.card, request.body)
        ),
        unit: 'images',
        typicalUnitsPerCall: 1,
      };
    }
  }
  return quoted;
}

/** The image quote pricing for this organization: the fal map with its `openstory` stills at the hold. */
export async function imageQuotePricing(
  scopedDb: Pick<ScopedDb, 'apiKeys'>
): Promise<Record<string, EffectiveFalPricing>> {
  const [pricing, routes] = await Promise.all([
    getEffectiveFalPricing(),
    imageGatewayRoutes(scopedDb),
  ]);
  return withGatewayImageQuotes(pricing, routes);
}
