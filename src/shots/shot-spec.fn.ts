/**
 * Read and edit a shot's spec (#1929). Saving a spec rebuilds the prompts
 * from it for free; a written prompt is replaced only when the user said so.
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import { shotSpecEditSchema } from '@/shots/shot-list.schema';
import { readShotSpec, saveShotSpec } from '@/shots/server/shot-content-edit';

const shotInput = z.object({ sequenceId: ulidSchema, shotId: ulidSchema });

export const getShotSpecFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotInput))
  .handler(async ({ context }) => readShotSpec(context));

export const saveShotSpecFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(
    zodValidator(
      shotInput.extend({
        spec: shotSpecEditSchema,
        /** Written prompts to replace with text rebuilt from the new spec. */
        replace: z.object({ visual: z.boolean(), motion: z.boolean() }),
      })
    )
  )
  .handler(async ({ context, data }) =>
    saveShotSpec(context, data.spec, data.replace)
  );
