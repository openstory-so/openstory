/**
 * Publish to social (#1267) — server functions behind the theatre's Publish
 * button. Everything goes through Upload-Post (`src/lib/social/upload-post`)
 * on the team's own API key (`team_api_keys`, provider `upload_post`); the
 * key is resolved server-side and never reaches the browser.
 *
 * Three handlers:
 *   - `listSocialProfilesFn`      — profiles + connected platforms, or
 *                                    `configured: false` when the team has no key.
 *   - `publishSequenceExportFn`   — hand a `ready` `sequence_exports` row to
 *                                    Upload-Post by URL; returns the request id.
 *   - `getSocialPublishStatusFn`  — poll the per-platform outcome.
 */

import { getEnv } from '#env';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  getUploadPostStatus,
  listUploadPostProfiles,
  publishUploadPostVideo,
  SOCIAL_PLATFORM_IDS,
  type SocialProfile,
} from '@/lib/social/upload-post';
import { toShareableUrl } from '@/lib/storage/buckets';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  sequenceAccessMiddleware,
  teamMemberAccessMiddleware,
} from './middleware';

const NO_KEY_MESSAGE =
  'Connect an Upload-Post API key in Settings → API Keys to publish to social media.';

// Upload-Post's title is the caption on most platforms; YouTube's hard limit
// (100) is the tightest, everything else is more generous.
const TITLE_MAX = 2200;
const DESCRIPTION_MAX = 5000;

type ScopedApiKeys = {
  resolveOptionalKey: (
    provider: 'upload_post'
  ) => Promise<{ key: string } | undefined>;
};

async function requireUploadPostKey(apiKeys: ScopedApiKeys): Promise<string> {
  const resolved = await apiKeys.resolveOptionalKey('upload_post');
  if (!resolved) throw new Error(NO_KEY_MESSAGE);
  return resolved.key;
}

// ============================================================================
// List profiles
// ============================================================================

export const listSocialProfilesFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(zodValidator(z.object({ teamId: ulidSchema })))
  .handler(
    async ({
      context,
    }): Promise<
      | { configured: false; profiles: [] }
      | { configured: true; profiles: SocialProfile[] }
    > => {
      const resolved =
        await context.scopedDb.apiKeys.resolveOptionalKey('upload_post');
      if (!resolved) return { configured: false, profiles: [] };
      return {
        configured: true,
        profiles: await listUploadPostProfiles(resolved.key),
      };
    }
  );

// ============================================================================
// Publish an export
// ============================================================================

const publishInputSchema = z.object({
  sequenceId: ulidSchema,
  exportId: ulidSchema,
  profile: z.string().trim().min(1, 'Pick an Upload-Post profile'),
  platforms: z
    .array(z.enum(SOCIAL_PLATFORM_IDS))
    .min(1, 'Pick at least one platform'),
  title: z.string().trim().min(1, 'A caption is required').max(TITLE_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).optional(),
});

export const publishSequenceExportFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(publishInputSchema))
  .handler(async ({ context, data }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);

    // The export must belong to the sequence the middleware just authorised —
    // `getById` alone would let a caller publish another team's file.
    const exportRow = await context.scopedDb.sequenceExports.getById(
      data.exportId
    );
    if (!exportRow || exportRow.sequenceId !== context.sequence.id) {
      throw new Error('Export not found for this sequence');
    }
    if (exportRow.status !== 'ready') {
      throw new Error(`Export is ${exportRow.status}, not ready to publish`);
    }

    // Stored URLs are origin-relative (#894). Upload-Post fetches the MP4 from
    // its side, so absolutize exactly as the server export workflow does for
    // the container: CDN domain in prod, else the worker origin.
    const videoUrl = toShareableUrl(exportRow.url, getEnv().VITE_APP_URL);

    const { requestId } = await publishUploadPostVideo(apiKey, {
      profile: data.profile,
      platforms: data.platforms,
      videoUrl,
      title: data.title,
      description: data.description,
      externalId: exportRow.id,
    });
    return { requestId };
  });

// ============================================================================
// Poll status
// ============================================================================

export const getSocialPublishStatusFn = createServerFn({ method: 'GET' })
  .middleware([teamMemberAccessMiddleware])
  .validator(
    zodValidator(
      z.object({ teamId: ulidSchema, requestId: z.string().trim().min(1) })
    )
  )
  .handler(async ({ context, data }) => {
    const apiKey = await requireUploadPostKey(context.scopedDb.apiKeys);
    return getUploadPostStatus(apiKey, data.requestId);
  });
