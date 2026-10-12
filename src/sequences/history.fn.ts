import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const historyInputSchema = z.object({
  sequenceId: ulidSchema,
  before: z.string().optional(),
});

/** Newest-first activity for one sequence. `before` is the oldest id already shown. */
export const getSequenceHistoryFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(historyInputSchema))
  .handler(async ({ data, context }) => {
    return context.scopedDb.sequenceEvents.listHistory(context.sequence.id, {
      before: data.before,
    });
  });
