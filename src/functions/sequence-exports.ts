/**
 * Server functions for `sequence_exports`. Rows are written by
 * `POST /api/v1/sequences/$id/exports` (`SequenceExportWorkflow`). Theatre
 * reuse is hash-matched on `sourceShotsHash`, not "newest ready".
 *
 *   - `listSequenceExportsFn`     — ready-only, newest-first, for the theatre cache.
 *   - `isServerExportAvailableFn` — whether the container (or local bunny URL)
 *     can render an export.
 */

import { ulidSchema } from '@/lib/schemas/id.schemas';
import { isServerExportAvailable } from '@/shared/sequence-player/server-export-available';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

export const listSequenceExportsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return await context.scopedDb.sequenceExports.listBySequence(
      context.sequence.id
    );
  });

export const isServerExportAvailableFn = createServerFn({
  method: 'GET',
}).handler(() => isServerExportAvailable());
