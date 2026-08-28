import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { systemAdminMiddleware } from './middleware';

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
