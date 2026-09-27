/**
 * The generation plan (#1816) over the wire — thin RPC shell; the loader
 * lives in `@/sequences/server/generation-plan`.
 */

import { computeGenerationPlan } from '@/sequences/server/generation-plan';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';

export const getGenerationPlanFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(({ context }) =>
    computeGenerationPlan(context.scopedDb, context.sequence.id)
  );
