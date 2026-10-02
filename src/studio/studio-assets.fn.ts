/**
 * Images and Videos (#1274).
 *
 * Team-scoped create/list/favorite/delete for studio `generated_assets`.
 * Always on — unlike `/models` this is not gated by MODELS_ENABLED. The work
 * lives in `@/studio/server/` (shared with the MCP Studio tools, #1985) so
 * the Start compiler does not ship the workflow client into the browser
 * bundle (#1257).
 */

import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { listFiles } from '@/platform/server/storage/storage-cloudflare';
import {
  createStudioAssets,
  editStudioAsset,
  renderStudioAssetAtQuality,
} from '@/studio/server/create-studio-asset';
import {
  deleteStudioAsset,
  draftStudioPromptForTeam,
  getStudioEditHistory,
  setStudioAssetFavorite,
} from '@/studio/server/studio-asset-actions';
import { TEAM_USER_UPLOAD_PREFIX } from '@/cast/server/team-user-upload';
import {
  studioActivitySchema,
  studioCreateInputSchema,
  studioPromptDraftInputSchema,
  studioSortSchema,
} from './schema';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';

export const createStudioAssetsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(studioCreateInputSchema))
  .handler(async ({ context, data }) => {
    return createStudioAssets(context.scopedDb, data);
  });

/**
 * Everything this team has uploaded to the composer (or dropped on the talent
 * dialog and never saved), newest first. Uploads have no DB row: the R2
 * prefix is the record, and the ULID key orders them by time.
 */
export const listStudioUploadsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const files = await listFiles(
      STORAGE_BUCKETS.TALENT,
      `${context.teamId}/${TEAM_USER_UPLOAD_PREFIX}`,
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

/** Render a finished Ark draft at 1080p from its task id (#1756). */
export const renderStudioAssetAtQualityFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ id: ulidSchema })))
  .handler(async ({ context, data }) => {
    return renderStudioAssetAtQuality(context.scopedDb, data.id);
  });

/** Rewrite a finished clip from a prompt (#1925); see `editStudioAsset`. */
export const editStudioAssetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        id: ulidSchema,
        prompt: z.string().trim().min(1, 'Enter a prompt').max(50_000),
        draft: z.boolean(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    return editStudioAsset(context.scopedDb, data.id, data.prompt, data.draft);
  });

/** The prompts a clip was made from (#1925); see `getStudioEditHistory`. */
export const getStudioEditHistoryFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ id: ulidSchema })))
  .handler(async ({ context, data }) => {
    return getStudioEditHistory(context.scopedDb, data.id);
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
    return setStudioAssetFavorite(context.scopedDb, data.id, data.isFavorite);
  });

export const deleteStudioAssetFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ id: ulidSchema })))
  .handler(async ({ context, data }) => {
    return deleteStudioAsset(context.scopedDb, data.id);
  });

/** Draft a prompt from the attached references; see `draftStudioPromptForTeam`. */
export const draftStudioPromptFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(studioPromptDraftInputSchema))
  .handler(async ({ context, data }) => {
    return draftStudioPromptForTeam(context.scopedDb, data);
  });
