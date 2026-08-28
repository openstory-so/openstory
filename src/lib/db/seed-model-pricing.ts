/**
 * Local/test `model_pricing` seed. Production stays cron-only (#1069);
 * `bun dev` and Playwright never run `scheduled()`, so without this the
 * table is empty: estimates floor at $0.10 and completed fal calls bill $0
 * (`reportMissingBillingCost`).
 *
 * Called from `scripts/seed.ts --local` / `--test`, the e2e worker fetch
 * self-seed, and workflow start when `E2E_TEST=true`. Never `--d1` / prod.
 */

import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import { FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP } from '@/lib/ai/fal-typical-units';
import { usdToMicros } from '@/lib/billing/money';
import { modelPricing } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { SeedDb } from './seed-system-templates';

type SeedPrice = {
  unit: string;
  unitPriceUsd: number;
  typicalUnitsPerCall?: number;
};

const img = (unitPriceUsd: number, typicalUnitsPerCall = 1): SeedPrice => ({
  unit: 'images',
  unitPriceUsd,
  typicalUnitsPerCall,
});

const units = (unitPriceUsd: number, typicalUnitsPerCall = 1): SeedPrice => ({
  unit: 'units',
  unitPriceUsd,
  typicalUnitsPerCall,
});

/**
 * Indicative rates for every endpoint `getFalEndpointIds()` returns.
 * Grok Imagine is billed in `units` at $0.01 (2.0 ≈ 4 → $0.04; Quality 2K ≈ 7)
 * — not the pricing-API "compute seconds" lie (#1069). Edit endpoints share
 * the sibling t2i unit/price so a reference-image still has a row.
 */
export const LOCAL_FAL_PRICING_SEED: Record<string, SeedPrice> = {
  'fal-ai/nano-banana-2': img(0.08, 1.5),
  'fal-ai/nano-banana-2/edit': img(0.08, 1.5),
  'fal-ai/nano-banana-pro': img(0.14, 1.5),
  'fal-ai/nano-banana-pro/edit': img(0.14, 1.5),
  'openai/gpt-image-2': units(1, 0.22),
  'openai/gpt-image-2/edit': units(1, 0.22),
  'xai/grok-imagine-image/v2.0/text-to-image': units(0.01, 4),
  'xai/grok-imagine-image/v2.0/edit': units(0.01, 4),
  'xai/grok-imagine-image/quality/text-to-image': units(0.01, 7),
  'xai/grok-imagine-image/quality/edit': units(0.01, 7),
  'fal-ai/flux-2-max': { unit: 'megapixels', unitPriceUsd: 0.07 },
  'fal-ai/flux-2-max/edit': { unit: 'megapixels', unitPriceUsd: 0.07 },
  'fal-ai/phota': img(0.05),
  'fal-ai/phota/edit': img(0.05),
  'fal-ai/hunyuan-image/v3/text-to-image': img(0.04),
  'fal-ai/hunyuan-image/v3/instruct/edit': img(0.04),
  'fal-ai/flux-2': { unit: 'megapixels', unitPriceUsd: 0.03 },
  'fal-ai/flux-2/edit': { unit: 'megapixels', unitPriceUsd: 0.03 },
  'fal-ai/qwen-image-2/pro/text-to-image': img(0.04),
  'fal-ai/qwen-image-2/pro/edit': img(0.04),
  'fal-ai/hidream-i1-full': img(0.04),
  'bytedance/seedream/v5/pro/text-to-image': img(0.135),
  'bytedance/seedream/v5/pro/edit': img(0.135),
  'fal-ai/flux-2/turbo': { unit: 'megapixels', unitPriceUsd: 0.01 },
  'fal-ai/flux-2/turbo/edit': { unit: 'megapixels', unitPriceUsd: 0.01 },
  'fal-ai/krea-2/turbo': { unit: 'megapixels', unitPriceUsd: 0.008 },
  'xai/grok-imagine-video/v1.5/image-to-video': {
    unit: 'videos',
    unitPriceUsd: 0.05,
    typicalUnitsPerCall: 1,
  },
  'xai/grok-imagine-video/v1.5/text-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.14,
  },
  'xai/grok-imagine-video/v1.5/reference-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.14,
  },
  'fal-ai/ltx-2.3/image-to-video': { unit: 'seconds', unitPriceUsd: 0.04 },
  'fal-ai/ltx-2.3/text-to-video': { unit: 'seconds', unitPriceUsd: 0.08 },
  'fal-ai/veo3.1/image-to-video': { unit: 'seconds', unitPriceUsd: 0.4 },
  'fal-ai/veo3.1': { unit: 'seconds', unitPriceUsd: 0.4 },
  'fal-ai/veo3.1/reference-to-video': { unit: 'seconds', unitPriceUsd: 0.4 },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.07,
  },
  'fal-ai/kling-video/v3/pro/text-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.168,
  },
  'fal-ai/kling-video/o3/pro/reference-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.14,
  },
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': units(0.49),
  'fal-ai/minimax/hailuo-2.3/pro/text-to-video': units(0.49),
  // Bill-verified unit is the 480p second ($0.025). 768P (our default) bills
  // 8 units for a 5s clip — not 5 (#1382). Same advertised rates on t2v.
  'minimax/h3-max/image-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.025,
    typicalUnitsPerCall:
      FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP['minimax/h3-max/image-to-video'] ?? 8,
  },
  'minimax/h3-max/text-to-video': {
    unit: 'seconds',
    unitPriceUsd: 0.025,
    typicalUnitsPerCall:
      FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP['minimax/h3-max/text-to-video'] ?? 8,
  },
  // Seedance 2.5 (sequences + studio). Advertised fal unit is ~$0.014–0.021
  // per 1000 tokens; local seed is a floor until the pricing cron runs.
  'bytedance/seedance-2.5/image-to-video': units(0.014),
  'bytedance/seedance-2.5/reference-to-video': units(0.014),
  'bytedance/seedance-2.5/text-to-video': units(0.014),
  // Seedance 2.0 enterprise (fal only — no Ark via).
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': units(0.014),
  'bytedance/seedance-2.0/enterprise/v2/text-to-video': units(0.014),
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': units(0.014),
  'fal-ai/elevenlabs/music': { unit: 'minutes', unitPriceUsd: 0.8 },
  'fal-ai/ace-step-1.5': units(0.0005),
  'fal-ai/ace-step/prompt-to-audio': units(0.0005),
};

/** D1 100-bind cap; 10 columns × 9 rows. */
const INSERT_CHUNK = 9;

/**
 * Insert seed rows for fal endpoints that have no `model_pricing` row yet.
 * Does not overwrite a live refresh.
 */
export async function ensureLocalModelPricingSeeded(
  db: SeedDb,
  log: (message: string) => void = () => {}
): Promise<number> {
  const existing = await db
    .select({ endpointId: modelPricing.endpointId })
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));
  const have = new Set(existing.map((row) => row.endpointId));

  const now = new Date();
  const rows = Object.entries(LOCAL_FAL_PRICING_SEED)
    .filter(([endpointId]) => !have.has(endpointId))
    .map(([endpointId, seed]) => ({
      provider: 'fal' as const,
      endpointId,
      unit: seed.unit,
      unitPriceMicros: usdToMicros(seed.unitPriceUsd),
      typicalUnitsPerCall: seed.typicalUnitsPerCall ?? null,
      observedMedianUnits: null,
      observedSampleCount: 0,
      fetchedAt: now,
      updatedAt: now,
    }));

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(modelPricing).values(rows.slice(i, i + INSERT_CHUNK));
  }

  if (rows.length > 0) {
    log(`💰 Seeded ${rows.length} model_pricing row(s) for local/test`);
  }
  return rows.length;
}

/** Endpoints we expose that have no seed row — empty means the catalog is complete. */
export function unseededFalEndpoints(): string[] {
  return getFalEndpointIds().filter((id) => !(id in LOCAL_FAL_PRICING_SEED));
}
