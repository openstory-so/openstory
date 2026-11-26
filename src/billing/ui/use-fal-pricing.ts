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
  getOrganizationFalPricingFn,
  type CatalogFalPricingMap,
} from '@/billing/pricing.fn';
import type { RateCard } from '@modelschemas/rate-card/evaluator';
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { micros } from '@/billing/money';
import { useAuthSession } from '@/platform/ui/auth/session-query';

function parseRateCard(json: string): RateCard | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || !('price' in parsed)) {
      return undefined;
    }
    // The cron only stores a schema-checked card. The client trusts that copy.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded to an object with price; evaluateCard refuses a bad card
    return parsed as RateCard;
  } catch {
    return undefined;
  }
}

const FAL_PRICING_QUERY_KEY = ['fal-catalog-pricing'] as const;
/** Keyed by organization below; an own key changes the route, so key saves invalidate it. */
export const ORGANIZATION_PRICING_QUERY_KEY = [
  'fal-organization-pricing',
] as const;

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
      ...(row.rateCardJson && {
        rateCard: parseRateCard(row.rateCardJson),
      }),
      ...(row.gatewayHolds && {
        gatewayHolds: Object.fromEntries(
          Object.entries(row.gatewayHolds).map(([shape, hold]) => [
            shape,
            micros(hold),
          ])
        ),
      }),
    };
  }
  return map;
}

/** Public catalog prices: signed-out pages. A signed-in page uses `useOrganizationFalPricing`. */
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

/** The organization's prices: a still the gateway runs is quoted at its hold, not the fal price. */
export function useOrganizationFalPricing() {
  const { data: session } = useAuthSession();
  const query = useQuery({
    queryKey: [
      ...ORGANIZATION_PRICING_QUERY_KEY,
      session?.session.activeOrganizationId ?? null,
    ],
    queryFn: async () => hydratePricingMap(await getOrganizationFalPricingFn()),
    staleTime: 5 * 60 * 1000,
  });

  return {
    ...query,
    pricing: query.data ?? null,
  };
}
