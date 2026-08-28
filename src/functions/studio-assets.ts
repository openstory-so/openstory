/**
 * Images and Videos (#1274).
 *
 * Team-scoped create/list/favorite/delete for studio `generated_assets`.
 * Always on — unlike `/models` this is not gated by MODELS_ENABLED. Create
 * lives in `@/lib/studio/create-studio-asset` so the Start compiler does not
 * ship the workflow client into the browser bundle (#1257).
 */

import {
  draftStudioPrompt,
  STUDIO_DRAFT_MODEL,
} from '@/lib/ai/studio-prompt-draft';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { InsufficientCreditsError } from '@/lib/errors';
import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { getLogger } from '@/lib/observability/logger';
import { STORAGE_BUCKETS, r2KeyFromUrl } from '@/lib/storage/buckets';
import { deleteFile } from '@/lib/storage/storage-cloudflare';
import { createStudioAssets } from '@/lib/studio/create-studio-asset';
import {
  studioActivitySchema,
  studioCreateInputSchema,
  studioReferenceKindSchema,
  studioSortSchema,
} from '@/lib/studio/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const logger = getLogger(['openstory', 'serverFn', 'studio-assets']);

export const createStudioAssetsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(studioCreateInputSchema))
  .handler(async ({ context, data }) => {
    return createStudioAssets(context.scopedDb, data);
  });

const listStudioAssetsInputSchema = z.object({
  activity: studioActivitySchema.optional(),
  favoritesOnly: z.boolean().optional(),
  order: studioSortSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: ulidSchema.optional(),
});

export const listStudioAssetsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(listStudioAssetsInputSchema.optional()))
  .handler(async ({ context, data }) => {
    return context.scopedDb.generatedAssets.list({
      source: 'studio',
      activity: data?.activity,
      favoritesOnly: data?.favoritesOnly,
      order: data?.order,
      limit: data?.limit,
      cursor: data?.cursor,
    });
  });

export const setStudioAssetFavoriteFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        id: ulidSchema,
        isFavorite: z.boolean(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset || asset.source !== 'studio') {
      throw new Error('Generated asset not found');
    }
    await context.scopedDb.generatedAssets.setFavorite(
      data.id,
      data.isFavorite
    );
    return { id: data.id, isFavorite: data.isFavorite };
  });

export const deleteStudioAssetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ id: ulidSchema })))
  .handler(async ({ context, data }) => {
    const asset = await context.scopedDb.generatedAssets.getById(data.id);
    if (!asset || asset.source !== 'studio') {
      throw new Error('Generated asset not found');
    }
    await context.scopedDb.generatedAssets.delete(data.id);
    // Storage deletion is best-effort: a leaked object beats a failed delete.
    for (const { url } of asset.outputs ?? []) {
      const key = r2KeyFromUrl(url);
      if (!key) continue;
      const bucket = key.startsWith(`${STORAGE_BUCKETS.VIDEOS}/`)
        ? STORAGE_BUCKETS.VIDEOS
        : STORAGE_BUCKETS.THUMBNAILS;
      await deleteFile(bucket, key.slice(bucket.length + 1)).catch((err) =>
        logger.warn('Failed to delete studio asset object', { err, key })
      );
    }
    return { id: data.id };
  });

const draftReferenceSchema = z.object({
  url: mediaUrlSchema,
  label: z.string().min(1).max(200),
  kind: studioReferenceKindSchema,
});

/**
 * Draft a prompt from the attached references. Billed like element vision:
 * credit-gated on the platform key, charged from reported usage.
 */
export const draftStudioPromptFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        activity: studioActivitySchema,
        references: z.array(draftReferenceSchema).max(15).default([]),
        startImageUrl: mediaUrlSchema.optional(),
        endImageUrl: mediaUrlSchema.optional(),
        currentPrompt: z.string().max(5000).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const { scopedDb } = context;
    const llmKey = await scopedDb.apiKeys.resolveLlmKey();
    if (llmKey.source !== 'team') {
      const canAfford = await scopedDb.billing.hasEnoughCredits(
        estimateLLMCost(1)
      );
      if (!canAfford) {
        throw new InsufficientCreditsError(
          'Insufficient credits to draft a prompt'
        );
      }
    }

    const result = await draftStudioPrompt({
      ...data,
      llmKey,
      observability: { userId: context.user.id, tags: ['studio', 'draft'] },
    });

    if (!result.usedOwnKey) {
      if (result.costMicros > 0) {
        await scopedDb.billing.deductCredits(result.costMicros, {
          description: `Studio prompt draft (${STUDIO_DRAFT_MODEL})`,
          metadata: { model: STUDIO_DRAFT_MODEL },
        });
      } else {
        reportMissingBillingCost({
          source: 'studio-prompt-draft',
          modelId: STUDIO_DRAFT_MODEL,
          metadata: { references: data.references.length },
        });
      }
    }
    return { prompt: result.prompt };
  });
