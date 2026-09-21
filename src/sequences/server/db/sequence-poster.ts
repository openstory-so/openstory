import type { Database } from '@/platform/server/db/client';
import type { Sequence } from '@/platform/server/db/schema';
import {
  frames,
  frameVariants,
  renderSegments,
  scenes,
  shots,
  videoVariants,
} from '@/platform/server/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getLatestPreviewByFrameIds } from '@/stills/server/db/frame-variants';
import { videoPosterUrl } from '@/look/cloudflare-video';
import { toCdnUrl } from '@/platform/server/storage/buckets';

/**
 * Decorate an authorized list with first-shot posters, without writes or media
 * downloads. Cloudflare extracts/caches the video JPEG; its source URL changes
 * with the selected video version. D1 returns only one narrow row per sequence.
 */
export async function withSequencePosters<
  T extends Pick<Sequence, 'id' | 'posterUrl'>,
>(db: Database, sequences: T[]): Promise<T[]> {
  const posters = new Map<string, string>();
  // Stay below D1's 100 bind parameters, including the selection predicates.
  for (let offset = 0; offset < sequences.length; offset += 80) {
    const ids = sequences.slice(offset, offset + 80).map((s) => s.id);
    const orderedShots = db
      .select({
        id: shots.id,
        sequenceId: shots.sequenceId,
        segmentId: shots.renderSegmentId,
        position:
          sql<number>`row_number() over (partition by ${shots.sequenceId} order by ${scenes.orderIndex} ASC NULLS LAST, ${shots.shotNumber}, ${shots.id})`.as(
            'position'
          ),
      })
      .from(shots)
      .leftJoin(scenes, eq(scenes.id, shots.sceneId))
      .where(and(inArray(shots.sequenceId, ids), isNull(shots.deletedAt)))
      .as('ordered_shots');
    const firstShots = await db
      .select({
        sequenceId: orderedShots.sequenceId,
        frameId: frames.id,
        imageUrl: frameVariants.url,
        videoUrl: videoVariants.url,
      })
      .from(orderedShots)
      .leftJoin(
        frames,
        and(
          eq(frames.shotId, orderedShots.id),
          eq(frames.sequenceId, orderedShots.sequenceId),
          eq(frames.orderIndex, 0)
        )
      )
      .leftJoin(
        frameVariants,
        and(
          eq(frameVariants.id, frames.selectedImageVersionId),
          eq(frameVariants.frameId, frames.id),
          eq(frameVariants.status, 'completed'),
          isNull(frameVariants.discardedAt)
        )
      )
      .leftJoin(
        renderSegments,
        and(
          eq(renderSegments.id, orderedShots.segmentId),
          eq(renderSegments.sequenceId, orderedShots.sequenceId)
        )
      )
      .leftJoin(
        videoVariants,
        and(
          eq(videoVariants.id, renderSegments.selectedVideoVersionId),
          eq(videoVariants.renderSegmentId, renderSegments.id),
          eq(videoVariants.status, 'completed'),
          isNull(videoVariants.discardedAt)
        )
      )
      .where(eq(orderedShots.position, 1));
    for (const shot of firstShots) {
      const videoPoster = shot.videoUrl
        ? videoPosterUrl(toCdnUrl(shot.videoUrl) ?? shot.videoUrl)
        : undefined;
      const poster = videoPoster ?? shot.imageUrl;
      if (poster) posters.set(shot.sequenceId, poster);
    }
    const missing = firstShots.filter(
      (s) => s.frameId && !posters.has(s.sequenceId)
    );
    const previews = await getLatestPreviewByFrameIds(
      db,
      missing.flatMap((s) => (s.frameId ? [s.frameId] : []))
    );
    for (const shot of missing) {
      const preview = shot.frameId ? previews.get(shot.frameId)?.url : null;
      if (preview) posters.set(shot.sequenceId, preview);
    }
  }
  return sequences.map((s) => ({
    ...s,
    posterUrl: posters.get(s.id) ?? s.posterUrl,
  }));
}
