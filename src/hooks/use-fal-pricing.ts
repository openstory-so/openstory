/**
 * Live fal catalog pricing for client-side cost hints (#1140).
 *
 * Server pre-flight remains the authority; this feeds ActionCost labels
 * only. Catalog-scoped (our image/video/audio endpoints) so the payload
 * stays small. 5-minute staleTime matches the server isolate cache.
 */

import { useQuery } from '@tanstack/react-query';
import {
  getCatalogFalPricingFn,
  type CatalogFalPricingMap,
} from '@/functions/pricing';
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { micros } from '@/lib/billing/money';

const FAL_PRICING_QUERY_KEY = ['fal-catalog-pricing'] as const;

/** Re-brand unit prices after JSON round-trip. */
function hydratePricingMap(
  raw: CatalogFalPricingMap
): Record<string, EffectiveFalPricing> {
  const map: Record<string, EffectiveFalPricing> = {};
  for (const [endpointId, row] of Object.entries(raw)) {
    map[endpointId] = {
      unitPrice: micros(row.unitPriceMicros),
      unit: row.unit,
      ...(row.typicalUnitsPerCall != null && {
        typicalUnitsPerCall: row.typicalUnitsPerCall,
      }),
      ...(row.observed && {
        observed: {
          medianUnits: row.observed.medianUnits,
          sampleCount: row.observed.sampleCount,
        },
      }),
    };
  }
  return map;
}

export function useFalPricing() {
  const query = useQuery({
    queryKey: [...FAL_PRICING_QUERY_KEY],
    queryFn: async () => hydratePricingMap(await getCatalogFalPricingFn()),
    staleTime: 5 * 60 * 1000,
    // Pricing is public — no session required (signed-out generate CTA).
  });

  return {
    ...query,
    pricing: query.data ?? null,
  };
}
