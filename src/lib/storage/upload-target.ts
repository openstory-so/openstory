/**
 * Shared validation + authorization for storage upload endpoints.
 *
 * Both the single-shot `/api/storage/upload` route and the multipart routes
 * accept the destination as query params (bucket, path, contentType) and must
 * enforce the same team-scoping rule: the path's owner segment has to name a
 * team the caller belongs to, so one team can't upload into another team's
 * prefix. Keeping this in one place avoids the check drifting between routes.
 */

import { isSystemAdmin } from '@/lib/auth/system-admin';
import { getUserTeamMembership } from '@/lib/db/scoped';
import { STORAGE_BUCKETS, type StorageBucket } from './buckets';

const bucketByName = new Map<string, StorageBucket>(
  Object.values(STORAGE_BUCKETS).map((b) => [b, b])
);

type UploadTarget = {
  bucket: StorageBucket;
  path: string;
  contentType: string;
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

  // Anchor the team-scope check. A bare substring test (`path.includes(teamId)`)
  // is bypassable: an attacker could put their own team id in the filename and
  // still write into another team's prefix (e.g.
  // `teams/<victim>/…/<myTeamId>.mp4`). Instead read the team id from the
  // *leading owner segment* — segment 0, or segment 1 when the path is under a
  // `teams/` prefix (exports use `teams/<id>/…`; talent/location/element use
  // `<id>/…`) — reject traversal / empty segments, and require membership.
  if (path.startsWith('/') || path.includes('//') || path.includes('..')) {
    return fail('Invalid upload path', 400);
  }
  const segments = path.split('/');
  const ownerSegment = segments[0] === 'teams' ? segments[1] : segments[0];
  // Authorize against the team the PATH names, not "the caller's team": the
  // reservation that minted this path was scoped to the resource's team (e.g.
  // `sequenceAccessMiddleware` uses the sequence's), so resolving one team per
  // user 403'd every upload by a member of more than one team — and every
  // system-admin upload against a customer's sequence, which rides the same
  // cross-team hatch `sequenceAccessMiddleware` opens to mint the path.
  if (!ownerSegment) return fail('Invalid upload path', 400);
  const authorized =
    isSystemAdmin(user.email) ||
    (await getUserTeamMembership(user.id, ownerSegment)) !== null;
  if (!authorized) {
    return fail('Path must be within your team prefix', 403);
  }

  return { ok: true, target: { bucket: validBucket, path, contentType } };
}
