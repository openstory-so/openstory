/**
 * Publish to social (#1267) — server functions behind the Download menu's
 * "Publish to social…". Everything goes through Upload-Post
 * (`server/social/upload-post.ts`) on the team's own key (`team_api_keys`,
 * provider `upload_post`), resolved server-side; it never reaches the browser.
 *
 *   - `getSocialPublishingFn`     — `{ enabled }`: whether the team has an
 *                                   active, valid key. The menu item only
 *                                   exists when it does.
 *   - `listSocialProfilesFn`      — profiles + their connected platforms.
 *   - `publishSequenceExportFn`   — hand a `ready` export to Upload-Post by URL.
 *   - `getSocialPublishStatusFn`  — per-platform outcome of a publish.
 */

import { getRequest } from '@tanstack/react-start/server';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  sequenceAccessMiddleware,
  teamMemberAccessMiddleware,
} from '@/platform/middleware.fn';
import { getLogger } from '@/platform/logger';
import { requireTeamMemberAccess } from '@/platform/server/auth/action-utils';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { getProductionDeploymentAppUrl } from '@/platform/server/env/environment';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import {
  derivePublishRequestId,
  publishInputSchema,
  PUBLISH_REQUEST_ID_RE,
  type PublishOutcome,
} from '@/sequences/social-publish';
import {
  assertPublicVideoUrl,
  assertPublishableExport,
} from '@/sequences/server/social/publish-guards';
import {
  getUploadPostStatus,
  listUploadPostProfiles,
  publishUploadPostVideo,
} from '@/sequences/server/social/upload-post';

const logger = getLogger(['openstory', 'serverFn', 'social-publish']);

async function requireUploadPostKey(
  apiKeys: Pick<ScopedDb['apiKeys'], 'resolveOptionalKey' | 'hasInvalidKey'>
): Promise<string> {
  const resolved = await apiKeys.resolveOptionalKey('upload_post');
  if (resolved) return resolved.key;
  throw new Error(
    (await apiKeys.hasInvalidKey('upload_post'))
      ? 'Your Upload-Post API key failed its last check. Re-check or replace it in Settings → API Keys.'
      : 'Add an Upload-Post API key in Settings → API Keys to publish to social media.'
  );
}

export const getSocialPublishingFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(zodValidator(z.object({ teamId: ulidSchema })))
  .handler(async ({ context }) => ({
    enabled: await context.scopedDb.apiKeys.hasUsableKey('upload_post'),
  }));

export const listSocialProfilesFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(zodValidator(z.object({ teamId: ulidSchema })))
  .handler(async ({ context }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);
    return listUploadPostProfiles(apiKey);
  });

export const publishSequenceExportFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(publishInputSchema))
  .handler(async ({ context, data }): Promise<PublishOutcome> => {
    const { sequence, scopedDb } = context;
    let prepared: { apiKey: string; videoUrl: string; requestId: string };
    // Every refusal here happens before anything is sent, so it is `not_sent`
    // — the dialog treats a thrown error as "maybe sent" and keeps tracking.
    try {
      // A system admin opening another team's sequence gets that team's
      // scopedDb (and key). Reading is an admin power; posting on the team's
      // own social accounts is not.
      await requireTeamMemberAccess(context.user.id, sequence.teamId);
      const apiKey = await requireUploadPostKey(scopedDb.apiKeys);
      const exportRow = await scopedDb.sequenceExports.getById(data.exportId);
      assertPublishableExport(exportRow, sequence.id);
      // Stored URLs are origin-relative (#894): CDN domain in prod, else the
      // app URL.
      const videoUrl = toShareableUrl(
        exportRow.url,
        getProductionDeploymentAppUrl(getRequest())
      );
      assertPublicVideoUrl(videoUrl);
      const requestId = await derivePublishRequestId({
        ...data,
        teamId: sequence.teamId,
      });
      prepared = { apiKey, videoUrl, requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.info('Publish refused before sending', {
        teamId: sequence.teamId,
        exportId: data.exportId,
        message,
      });
      return { state: 'not_sent', message };
    }

    return publishUploadPostVideo(prepared.apiKey, {
      ...data,
      requestId: prepared.requestId,
      videoUrl: prepared.videoUrl,
      externalId: data.exportId,
    });
  });

export const getSocialPublishStatusFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        teamId: ulidSchema,
        requestId: z.string().regex(PUBLISH_REQUEST_ID_RE),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);
    return getUploadPostStatus(apiKey, data.requestId);
  });
