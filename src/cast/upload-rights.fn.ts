/**
 * Upload rights server fns (#1581): the check's answer and the sign-off.
 * The check itself runs as a workflow the upload starts (#2192); every
 * finalize then only reads the ledger (`requireUploadRights`).
 */

import { readUploadCheck, retryUploadCheck } from '@/cast/server/upload-check';
import { attestUploads, requireCheckable } from '@/cast/server/upload-rights';
import {
  portraitAttestationSchema,
  uploadRefSchema,
  type UploadCheck,
} from '@/cast/upload-rights';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

function requestContext() {
  const request = getRequest();
  return {
    ipAddress: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent'),
  };
}

/**
 * The check's answer for one upload: the verdict on record, or `checking`
 * while its run goes. Asked again until it answers; a failed run throws.
 */
export const classifyUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(uploadRefSchema))
  .handler(({ context, data }): Promise<UploadCheck> =>
    readUploadCheck(context.scopedDb, data, requestContext())
  );

/** Run the check again after it failed. */
export const retryUploadCheckFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(uploadRefSchema))
  .handler(({ context, data }): Promise<UploadCheck> =>
    retryUploadCheck(context.scopedDb, data, requestContext())
  );

/** Record the portrait sign-off for real-person uploads. */
export const attestUploadsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        attestations: z.array(portraitAttestationSchema).min(1).max(20),
      })
    )
  )
  .handler(async ({ context, data }) => {
    for (const claim of data.attestations) {
      requireCheckable(claim.url, context.teamId);
    }
    await attestUploads(context.scopedDb, data.attestations, requestContext());
    return { attested: data.attestations.length };
  });
