/**
 * Shot access middleware (#1489). Lives in the shots domain because it
 * resolves the shot's scene script — a domain read `platform/middleware.fn.ts`
 * may not make. Builds on `sequenceAccessMiddleware`, which already loaded
 * the sequence and re-scoped the db for a system admin crossing teams, so
 * this one never mints a scoped db itself.
 */
import {
  sequenceAccessMiddleware,
  type TeamContext,
} from '@/platform/middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { loadShotTarget, type ShotTarget } from '@/shots/server/shot-context';
import { createMiddleware } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

export type ShotContext = TeamContext & ShotTarget;

/**
 * Shot access middleware
 * Loads shot with its sequence and verifies team access
 * Requires sequenceId and shotId in input data
 */
export const shotAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(z.looseObject({ sequenceId: ulidSchema, shotId: ulidSchema }))
  )
  .server(async ({ next, context, data }) =>
    next({
      context: await loadShotTarget(
        context.scopedDb,
        context.sequence.id,
        data.shotId
      ),
    })
  );
