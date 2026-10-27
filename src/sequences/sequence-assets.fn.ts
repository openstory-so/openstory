/**
 * The asset manifest for the sequence page (#2209). Same list as
 * `GET /api/v1/sequences/$id/assets`.
 */
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { assetScopeSchema } from '@/sequences/sequence-assets';
import { listSequenceAssets } from '@/sequences/server/sequence-assets';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

export const getSequenceAssetsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        scope: assetScopeSchema.default('selected'),
        includeExports: z.boolean().default(false),
      })
    )
  )
  .handler(async ({ data, context }) => {
    return await listSequenceAssets(context.scopedDb, context.sequence.id, {
      scope: data.scope,
      includeExports: data.includeExports,
    });
  });
