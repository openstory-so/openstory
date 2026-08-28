import {
  getEffectiveFalPricing,
  getFalPricingUpdatedAt,
} from '@/lib/ai/fal-pricing-live';
import { catalogFalEndpointIds } from '@/lib/billing/catalog-endpoints';
import {
  buildFilmCostExamples,
  type FilmCostExamples,
} from '@/lib/billing/film-cost-examples';
import {
  buildPricingCatalog,
  type PricingCatalog,
} from '@/lib/billing/pricing-catalog';
import { createServerFn } from '@tanstack/react-start';

/** Public pricing catalog for the /pricing page, from live `model_pricing`. */
export const getPricingCatalogFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    PricingCatalog & { filmCosts: FilmCostExamples | null }
  > => {
    const [falPricing, falUpdatedAt] = await Promise.all([
      getEffectiveFalPricing(),
      getFalPricingUpdatedAt(),
    ]);
    return {
      ...buildPricingCatalog({ falPricing, falUpdatedAt }),
      filmCosts: buildFilmCostExamples(falPricing),
    };
  }
);

/**
 * Serializable catalog pricing for client-side ActionCost estimates (#1140).
 * Numbers only — the client re-brands unitPrice with `micros()`.
 */
export type CatalogFalPricingRow = {
  unitPriceMicros: number;
  unit: string;
  typicalUnitsPerCall?: number;
  observed?: { medianUnits: number; sampleCount: number };
};

export type CatalogFalPricingMap = Record<string, CatalogFalPricingRow>;

/** Public GET — catalog endpoints only (not the full fal table). */
export const getCatalogFalPricingFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CatalogFalPricingMap> => {
    const full = await getEffectiveFalPricing();
    const out: CatalogFalPricingMap = {};
    for (const endpointId of catalogFalEndpointIds()) {
      const row = full[endpointId];
      if (!row) continue;
      out[endpointId] = {
        unitPriceMicros: Number(row.unitPrice),
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
    return out;
  }
);
