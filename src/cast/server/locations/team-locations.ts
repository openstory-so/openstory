/**
 * Locations made and fed from no sequence (#1695): the Locations page, the
 * public API and the MCP tools. A location is the team's; any number of
 * uploaded photos are input to its sheet, and the sheet is drawn by the same
 * `/location-sheet` run a sequence starts.
 */

import { regenerateLocationSheet } from '@/cast/server/cast-generation';
import { requireUploadRights } from '@/cast/server/upload-rights';
import { assertTeamUserUploadAttachable } from '@/cast/server/team-user-upload';
import { NotFoundError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { LocationWithReference } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';

const logger = getLogger(['openstory', 'locations', 'team-locations']);

export type ProcessedImage = { url: string; path: string };

/**
 * Accept already-uploaded location photos. Every photo a location takes goes
 * through here, so this is where the likeness gate runs (#1581): each still
 * must be cleared or signed. The object stays at its `uploads/` key (#1634).
 */
export async function attachLocationReferenceImages(
  scopedDb: ScopedDb,
  uploadUrls: string[],
  teamId: string
): Promise<ProcessedImage[]> {
  await requireUploadRights(scopedDb, uploadUrls);
  const results: ProcessedImage[] = [];

  for (const url of uploadUrls) {
    results.push(
      await assertTeamUserUploadAttachable({
        url,
        bucket: STORAGE_BUCKETS.LOCATIONS,
        teamId,
      })
    );
  }

  return results;
}

/**
 * Take the reference claim (#1113) and start the location's sheet run from
 * no sequence. Returns the workflow run id.
 */
export async function triggerTeamLocationSheet(
  scopedDb: ScopedDb,
  ctx: { userId: string; teamId: string; locationId: string }
): Promise<string> {
  const { workflowRunId } = await regenerateLocationSheet(
    scopedDb,
    { userId: ctx.userId },
    null,
    { locationDbId: ctx.locationId }
  );
  return workflowRunId;
}

/**
 * Make a location with no sequence: its bible, its photos and, when
 * `triggerSheet`, its first sheet run. The public API passes false and
 * starts the run itself once the sequence exists.
 */
export async function createTeamLocation(
  scopedDb: ScopedDb,
  input: {
    name: string;
    description: string | null;
    rendering: string;
    /** User-upload URLs in the LOCATIONS bucket (`uploads/`); not moved. */
    photoUrls: string[];
  },
  ctx: { userId: string; teamId: string; triggerSheet: boolean }
): Promise<LocationWithReference> {
  // Gated before anything is written: a refused photo makes no location.
  const photos = await attachLocationReferenceImages(
    scopedDb,
    input.photoUrls,
    ctx.teamId
  );
  const location = await scopedDb.locations.createForTeam(
    {
      name: input.name,
      description: input.description,
      rendering: input.rendering,
    },
    { createdBy: ctx.userId }
  );
  await scopedDb.locations.addPhotos(location.id, photos);
  if (!ctx.triggerSheet) return location;

  try {
    await triggerTeamLocationSheet(scopedDb, {
      userId: ctx.userId,
      teamId: ctx.teamId,
      locationId: location.id,
    });
  } catch (error) {
    // The location is made. A run that did not start left it `failed` with
    // the reason (`failReferenceClaim`), which its page shows with Generate;
    // throwing here would have the caller make it twice.
    logger.error('Failed to start the location sheet run', {
      err: error,
      locationId: location.id,
    });
  }
  const current = await scopedDb.locations.getCurrent(location.id);
  if (!current) throw new NotFoundError('Location not found');
  return current;
}
