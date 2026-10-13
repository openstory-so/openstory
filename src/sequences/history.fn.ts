import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const historyScopeSchema = z.union([
  z.object({ shotId: ulidSchema }),
  z.object({ sceneIds: z.array(ulidSchema).min(1).max(50).readonly() }),
]);

const historyInputSchema = z.object({
  sequenceId: ulidSchema,
  before: ulidSchema.optional(),
  scope: historyScopeSchema.optional(),
});

/** Newest-first activity for one sequence. `before` is the oldest id already shown. */
export const getSequenceHistoryFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(historyInputSchema))
  .handler(async ({ data, context }) => {
    return context.scopedDb.sequenceEvents.listHistory(context.sequence.id, {
      before: data.before,
      scope: data.scope,
    });
  });
