/**
 * Upload rights server fns (#1581): the check and the sign-off. Every
 * finalize then only reads the ledger (`requireUploadRights`).
 */

import { attestUploads, classifyUpload } from '@/cast/server/upload-rights';
import {
  needsLikenessCheck,
  portraitAttestationSchema,
  uploadRefSchema,
  type UploadRights,
} from '@/cast/upload-rights';
import { ValidationError } from '@/platform/errors';
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

/** A raw URL, or one of this team's own stored objects. */
function isCheckable(url: string, teamId: string): boolean {
  return url.startsWith('/r2/')
    ? url.includes(`/${teamId}/`)
    : needsLikenessCheck(url);
}

/**
 * Rights check for one image: what is on record for this team, or one
 * classifier call whose verdict is written so Generate never looks again.
 */
export const classifyUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(uploadRefSchema))
  .handler(async ({ context, data }): Promise<UploadRights> => {
    if (!isCheckable(data.url, context.teamId)) {
      throw new ValidationError('This image is not an upload of yours');
    }
    return classifyUpload({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      url: data.url,
      filename: data.filename,
      request: requestContext(),
    });
  });

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
      if (!isCheckable(claim.url, context.teamId)) {
        throw new ValidationError('This image is not an upload of yours');
      }
    }
    await attestUploads(context.scopedDb, data.attestations, requestContext());
    return { attested: data.attestations.length };
  });
