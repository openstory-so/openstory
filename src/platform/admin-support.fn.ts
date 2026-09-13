import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { systemAdminMiddleware } from './middleware.fn';

export const getAllAdminSequencesFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        search: z.string().max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.admin.getAllSequences(data);
  });

export const getAdminShotsFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.admin.getShotsForSequence(data.sequenceId);
  });

export const getAllAdminStudioAssetsFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        activity: z.enum(['image', 'video']).optional(),
        search: z.string().max(200).optional(),
        favoritesOnly: z.boolean().optional(),
        order: z.enum(['newest', 'oldest']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: ulidSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.admin.getAllStudioAssets(data);
  });
