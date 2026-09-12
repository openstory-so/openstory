/**
 * Images and Videos (#1274).
 *
 * Team-scoped create/list/favorite/delete for studio `generated_assets`.
 * Always on — unlike `/models` this is not gated by MODELS_ENABLED. Create
 * lives in `@/studio/server/create-studio-asset` so the Start compiler does not
 * ship the workflow client into the browser bundle (#1257).
 */

import {
  draftStudioPrompt,
  STUDIO_DRAFT_MODEL,
} from '@/studio/server/studio-prompt-draft';
import { reportMissingBillingCost } from '@/billing/billing-observability';
import { estimateLLMCost } from '@/billing/cost-estimation';
import { InsufficientCreditsError } from '@/platform/errors';
import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { getLogger } from '@/platform/logger';
import {
  STORAGE_BUCKETS,
  r2KeyFromUrl,
} from '@/platform/server/storage/buckets';
import {
  deleteFile,
  listFiles,
} from '@/platform/server/storage/storage-cloudflare';
import { attestStudioReferences } from '@/studio/server/reference-attestation';
import { createStudioAssets } from '@/studio/server/create-studio-asset';
import { analyzeTalentMediaForTeam } from '@/cast/server/talent/analyze-talent-media';
import { sha256Hex } from '@/platform/compliance/hash';
import { LIKENESS_CLEARED_V1 } from '@/platform/compliance/attestations';
import { recordPortraitAttestation } from '@/cast/server/likeness-upload';
import { needsReferenceAttestation } from '@/studio/reference-rights';
import { getRequest } from '@tanstack/react-start/server';
import {
  referenceAttestationSchema,
  studioActivitySchema,
  studioCreateInputSchema,
  studioReferenceKindSchema,
  studioSortSchema,
} from './schema';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';

const logger = getLogger(['openstory', 'serverFn', 'studio-assets']);

export const createStudioAssetsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(studioCreateInputSchema))
  .handler(async ({ context, data }) => {
    return createStudioAssets(context.scopedDb, data);
  });

/**
 * Record the sign-off for gated reference images (#1581) — Confirm in the
 * composer. Generate then only checks the ledger.
 */
export const attestStudioReferencesFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        attestations: z.array(referenceAttestationSchema).min(1).max(11),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const request = getRequest();
    await attestStudioReferences(context.scopedDb, data.attestations, {
      ipAddress: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    });
    return { attested: data.attestations.length };
  });

/**
 * Everything this team has uploaded to the composer (or dropped on the talent
 * dialog and never saved), newest first. Temp uploads have no DB row: the
 * R2 prefix is the record, and the ULID key orders them by time.
 */
export const listStudioUploadsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const files = await listFiles(
      STORAGE_BUCKETS.TALENT,
      `${context.teamId}/temp`,
      { limit: 1000 }
    );
    return files
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, 100)
      .flatMap((file) => {
        const kind = (['image', 'video', 'audio'] as const).find((k) =>
          file.metadata.mimetype.startsWith(`${k}/`)
        );
        return kind ? [{ url: `/r2/${file.id}`, label: file.name, kind }] : [];
      });
  });

/**
 * Rights check for one gated reference image (#1581): already on record
 * for this team (no vision call), or classified. A real person comes back
 * unattested so the composer asks for the portrait sign-off; anything else
 * is cleared on the spot — the finding is written to the ledger so Generate
 * never has to look again. Never defaults to human: the classifier decides.
 */
export const classifyStudioReferenceFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ url: mediaUrlSchema })))
  .handler(async ({ context, data }) => {
    if (!needsReferenceAttestation(data.url)) {
      throw new Error('This reference needs no rights check');
    }
    const subjectId = await sha256Hex(data.url);
    const [latest] =
      await context.scopedDb.compliance.attestations.listForSubject(
        'studio_reference',
        subjectId
      );
    if (latest) {
      return { attested: true, depictsRealPerson: latest.depictsRealPerson };
    }
    const analysis = await analyzeTalentMediaForTeam({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      imageUrls: [data.url],
      idempotencyKey: `studio-vision:${data.url}`,
    });
    if (analysis.subjectKind === 'human') {
      return { attested: false, depictsRealPerson: true };
    }
    const request = getRequest();
    await recordPortraitAttestation({
      scopedDb: context.scopedDb,
      subjectType: 'studio_reference',
      subjectId,
      attestation: {
        statementVersion: LIKENESS_CLEARED_V1.version,
        authorizationBasis: '',
      },
      request: {
        ipAddress: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
      },
      depictsRealPerson: false,
    });
    return { attested: true, depictsRealPerson: false };
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
    const llmKey = await scopedDb.apiKeys.resolveLlmKey(STUDIO_DRAFT_MODEL);
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
