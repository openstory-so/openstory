/**
 * Shared validation + authorization for storage upload endpoints.
 *
 * Both the single-shot `/api/storage/upload` route and the multipart routes
 * accept the destination as query params (bucket, path, contentType) and must
 * enforce the same organization-scoping rule: the path's owner segment has to name a
 * organization the caller belongs to, so one organization can't upload into another organization's
 * prefix. Keeping this in one place avoids the check drifting between routes.
 */

import { keyOwner } from './buckets';
import { fileExists } from '#storage';
import { isSystemAdmin } from '@/platform/server/auth/system-admin';
import { getUserOrganizationMembership } from '@/platform/server/db/scoped';
import {
  LIKENESS_CHECKED_BUCKETS,
  STORAGE_BUCKETS,
  type StorageBucket,
} from './buckets';

const bucketByName = new Map<string, StorageBucket>(
  Object.values(STORAGE_BUCKETS).map((b) => [b, b])
);

type UploadTarget = {
  bucket: StorageBucket;
  path: string;
  contentType: string;
  /** The organization the path's owner segment names; the caller is a member. */
  organizationId: string;
};

type Resolved =
  | { ok: true; target: UploadTarget }
  | { ok: false; response: Response };

const fail = (error: string, status: number): Resolved => ({
  ok: false,
  response: Response.json({ success: false, error }, { status }),
});

/**
 * Resolve and authorize the upload target from request query params. Returns
 * either the validated target or a ready-to-return error Response.
 *
 * `contentType` defaults to `application/octet-stream` (callers that require an
 * explicit type, like the single upload, should check it themselves).
 */
export async function resolveUploadTarget(
  request: Request,
  user: { id: string; email: string }
): Promise<Resolved> {
  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket');
  const path = url.searchParams.get('path');
  const contentType =
    url.searchParams.get('contentType') ?? 'application/octet-stream';

  if (!bucket || !path) {
    return fail('Missing required query params: bucket, path', 400);
  }

  const validBucket = bucketByName.get(bucket);
  if (!validBucket) return fail(`Invalid bucket: ${bucket}`, 400);

  // Anchor the organization-scope check. A bare substring test (`path.includes(organizationId)`)
  // is bypassable: an attacker could put their own organization id in the filename and
  // still write into another organization's prefix (e.g.
  // `teams/<victim>/…/<myOrganizationId>.mp4`). Instead read the organization id from the
  // *leading owner segment* (`keyOwner`), reject traversal / empty segments,
  // and require membership.
  if (path.startsWith('/') || path.includes('//') || path.includes('..')) {
    return fail('Invalid upload path', 400);
  }
  const segments = path.split('/');
  const ownerSegment = keyOwner(segments);
  // Authorize against the organization the PATH names, not "the caller's organization": the
  // reservation that minted this path was scoped to the resource's organization (e.g.
  // `sequenceAccessMiddleware` uses the sequence's), so resolving one organization per
  // user 403'd every upload by a member of more than one organization — and every
  // system-admin upload against a customer's sequence, which rides the same
  // cross-organization hatch `sequenceAccessMiddleware` opens to mint the path.
  if (!ownerSegment) return fail('Invalid upload path', 400);
  const authorized =
    isSystemAdmin(user.email) ||
    (await getUserOrganizationMembership(user.id, ownerSegment)) !== null;
  if (!authorized) {
    return fail('Path must be within your organization prefix', 403);
  }

  // A shared stitch's file is written once (#2127). Its page is public and
  // its stills pass the real-person check at publish, so an overwrite after
  // that would put an unchecked image on a live page. A failed PUT leaves no
  // object, so a retry is still a first write.
  if (
    validBucket === STORAGE_BUCKETS.STITCHES &&
    (await fileExists(validBucket, path))
  ) {
    return fail('A stitch file cannot be replaced; share the cut again', 409);
  }
  // Same for an upload the likeness check judged (#2192): its verdict is
  // keyed by URL, so new bytes under the old key would keep it. Every upload
  // path ends in a fresh id, so only a replay writes here twice.
  // ponytail: exists-then-put race; an R2 conditional put closes it if needed.
  if (
    LIKENESS_CHECKED_BUCKETS.has(validBucket) &&
    (await fileExists(validBucket, path))
  ) {
    return fail('This file is already uploaded; upload it again', 409);
  }

  return {
    ok: true,
    target: {
      bucket: validBucket,
      path,
      contentType,
      organizationId: ownerSegment,
    },
  };
}
