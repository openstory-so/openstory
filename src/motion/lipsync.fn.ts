/**
 * Lip-sync server functions (#2263). One shot, or every shot of a scene
 * that has a finished clip and a dialogue section.
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { startLipsync, startSceneLipsync } from '@/motion/server/lipsync-shot';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';

export const lipsyncShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(z.object({ sequenceId: ulidSchema, shotId: ulidSchema }))
  )
  .handler(({ context }) => startLipsync(context));

export const lipsyncSceneFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotIds: z.array(ulidSchema).min(1).max(40),
      })
    )
  )
  .handler(({ data, context }) =>
    startSceneLipsync(
      {
        scopedDb: context.scopedDb,
        user: context.user,
        organizationId: context.organizationId,
        sequenceId: context.sequence.id,
      },
      data.shotIds
    )
  );
