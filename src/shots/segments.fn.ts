/**
 * Render-segment reads for the Scenes editor (#986 / #990).
 *
 * A scene's video renders per **segment** (a contiguous shot-subset), not per
 * shot. `getSequenceSegmentsFn` returns every segment in a sequence with its
 * ordered membership, its version history, the selected version, and a
 * staleness flag — the source of truth the shot-strip lane and the segment-aware
 * Video tab both read. Selection + writes already run through
 * `video_variants` / `render_segments`; this is the matching read surface.
 * Assembly itself is pure (`assembleSequenceSegments`) and unit-tested.
 */

import { createServerFn } from '@tanstack/react-start';
import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import type { SequenceSegment } from './scene-segments';
import { loadSequenceSegments } from './server/sequence-segments';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'segments']);

/**
 * Every render segment in a sequence, with its ordered shot membership, version
 * history (non-discarded, oldest-first), the selected version, and staleness.
 * Membership order comes from `shots.orderIndex`; a segment with no shots
 * currently pointing at it (its shots were re-tiled away) is still returned with
 * an empty `shotIds` so a dangling selection stays inspectable.
 */
export const getSequenceSegmentsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }): Promise<SequenceSegment[]> => {
    const { scopedDb, sequence } = context;
    const { assembled } = await loadSequenceSegments(
      scopedDb,
      sequence,
      await scopedDb.shots.listBySequence(sequence.id)
    );

    for (const segment of assembled) {
      if (
        segment.selectedVersionId != null &&
        segment.selectedVersion === null
      ) {
        // Data inconsistency: the selection points at a discarded/missing
        // version. The UI shows it as "nothing selected" — make it findable.
        logger.warn('segment selection dangles at a missing version', {
          sequenceId: sequence.id,
          segmentId: segment.id,
          selectedVersionId: segment.selectedVersionId,
        });
      }
    }

    return assembled;
  });
