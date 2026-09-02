/**
 * Video-variant projection (#990) — a compatibility view that presents the new
 * flat `video_variants` rows in the legacy per-(shot, model) `ShotVariant`
 * shape the existing video readers (scenes-view switcher, model coverage, the
 * "Set Video" UI) consume.
 *
 * A `video_variants` row covers a render SEGMENT (its `manifest` lists the
 * shotIds), whereas the old `shot_variants` video row was per-shot. The
 * projection fans each version out into one synthetic per-shot row per covered
 * shot, and collapses to the **latest** version per `(shotId, model)` (versions
 * arrive oldest-first, so last write wins) — mirroring the old "one primary row
 * per (shot, model)" shape. `divergedAt` is always `null` (the divergence model
 * is retired; selection is a pointer now), so the readers' `divergedAt === null`
 * filters pass through unchanged.
 *
 * This keeps the Phase-4/5 UI re-route off the critical path: the display layer
 * keeps working on `ShotVariant` while the write + selection paths run on
 * `video_variants`.
 */

import type { ShotVariant, VideoVariant } from '@/lib/db/schema';

/** Build the synthetic `ShotVariant` for one covered shot of a version. */
function projectEntry(
  version: VideoVariant,
  shotId: string,
  durationMs: number
): ShotVariant {
  return {
    id: version.id,
    shotId,
    sequenceId: version.sequenceId,
    variantType: 'video',
    model: version.model,
    url: version.url,
    storagePath: version.storagePath,
    // The 3×3 grid was image-only; never set for video.
    shotVariantUrl: null,
    shotVariantPath: null,
    shotVariantStatus: 'pending',
    shotVariantWorkflowRunId: null,
    // VERBATIM (#1108): 'cancelled' passes through — mapping it to 'failed'
    // here would re-arm every retry/eligibility path that reads this
    // projection, defeating the cancel.
    status: version.status,
    workflowRunId: version.workflowRunId,
    generatedAt: version.generatedAt,
    error: version.error,
    // Retired for video: prompt staleness now folds into the manifest inputHash.
    promptHash: null,
    inputHash: version.inputHash,
    // Selection-as-pointer: no per-row divergence flag anymore.
    divergedAt: null,
    discardedAt: version.discardedAt,
    durationMs,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

/**
 * The latest-per-(shot, model) collapse key. `JSON.stringify` of the pair keeps
 * the two fields unambiguously separated without a sentinel delimiter (a raw
 * control char here previously made the whole file read as binary to git).
 */
function shotModelKey(shotId: string, model: string): string {
  return JSON.stringify([shotId, model]);
}

/**
 * Project flat `video_variants` versions into legacy per-(shot, model)
 * `ShotVariant` rows, keeping only the latest version per `(shotId, model)`.
 * Input is expected oldest-first (the scoped `listBySequence` orders by ULID).
 */
export function projectVideoVariants(
  versions: readonly VideoVariant[]
): ShotVariant[] {
  const latestByShotModel = new Map<string, ShotVariant>();
  for (const version of versions) {
    for (const entry of version.manifest) {
      const key = shotModelKey(entry.shotId, version.model);
      latestByShotModel.set(
        key,
        projectEntry(version, entry.shotId, entry.durationMs)
      );
    }
  }
  return [...latestByShotModel.values()];
}
