import { isBytePlusConfigured } from '@/lib/ai/byteplus-config';
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
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/shared/ai/models';
import { estimateImageCost } from '@/shared/billing/cost-estimation';
import { estimateStoryboardPreflightCost } from '@/shared/billing/storyboard-preflight-cost';
import { aspectRatioSchema } from '@/shared/constants/aspect-ratios';
import {
  generationStageSchema,
  includesStage,
} from '@/shared/generation/pipeline';
import { resolutionSchema } from '@/shared/constants/resolutions';

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
      ...buildPricingCatalog({
        falPricing,
        falUpdatedAt,
        byteplusEnabled: isBytePlusConfigured(),
      }),
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

const estimateDraftGenerationInputSchema = z.object({
  script: z.string(),
  imageModels: z.array(z.string()).min(1),
  videoModels: z.array(z.string()).min(1),
  audioModels: z.array(z.string()).min(1),
  aspectRatio: aspectRatioSchema,
  resolution: resolutionSchema.optional(),
  stopAt: generationStageSchema,
  generateStartFrames: z.boolean(),
  targetDurationSeconds: z.number().int().positive().optional(),
});

/** Live Generate-dialog estimate. Public: catalog rates only, no secrets. */
export const estimateDraftGenerationFn = createServerFn({ method: 'POST' })
  .validator(zodValidator(estimateDraftGenerationInputSchema))
  .handler(async ({ data }) => {
    if (!data.script.trim()) return { estimateMicros: null };
    const pricing = await getEffectiveFalPricing();
    const imageModel = safeTextToImageModel(
      data.imageModels[0],
      DEFAULT_IMAGE_MODEL
    );
    if (
      includesStage(data.stopAt, 'images') &&
      estimateImageCost(imageModel, data.aspectRatio, 1, { pricing }) === null
    ) {
      return { estimateMicros: null };
    }
    const estimate = estimateStoryboardPreflightCost({
      script: data.script,
      imageModel,
      imageModelCount: data.imageModels.length,
      aspectRatio: data.aspectRatio,
      resolution: data.resolution,
      stopAt: data.stopAt,
      videoModels: data.videoModels.map((model) =>
        safeImageToVideoModel(model, DEFAULT_VIDEO_MODEL)
      ),
      audioModels: data.audioModels.map((model) =>
        safeAudioModel(model, DEFAULT_MUSIC_MODEL)
      ),
      autoGenerateMotion: true,
      autoGenerateMusic: true,
      referenceOnly: !data.generateStartFrames,
      targetDurationSeconds: data.targetDurationSeconds,
      pricing,
    });
    return { estimateMicros: Number(estimate) };
  });
