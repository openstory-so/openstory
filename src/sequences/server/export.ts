/**
 * Server-side MP4 export (#968, #1402, #1461): the one operation behind
 * `POST /api/v1/sequences/$id/exports` and MCP `start_export`.
 *
 * The cut is resolved here, before anything is reserved: the workflow renders
 * this snapshot and reads no DB. A ready MP4 whose `sourceShotsHash` matches
 * the cut is reused as-is; otherwise the export coalesces onto the live
 * processing row (one per sequence), fails a stale one, or reserves a row and
 * starts `SequenceExportWorkflow`.
 */

import { generateId } from '@/platform/id';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { SequenceExport } from '@/platform/server/db/schema';
import { decideExistingExport } from '@/platform/server/api-v1/export-reuse';
import type { SequenceExportDocument } from '@/platform/server/api-v1/state';
import {
  STORAGE_BUCKETS,
  getPublicUrl,
  toShareableUrl,
} from '@/platform/server/storage/buckets';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { SequenceExportWorkflowInput } from '@/platform/server/workflow/types';
import {
  effectiveExportMusicUrl,
  hashSequenceExportInputs,
} from '@/sequences/ui/theatre/source-shots-hash';
import { collapseConsecutiveUrls } from '@/sequences/ui/theatre/playback-clips';
import { getLogger } from '@/platform/logger';
import { productionAccess } from './production-access';

const logger = getLogger(['openstory', 'sequences', 'export']);

const EXPORT_FILENAME_SUFFIX = '_openstory.mp4';

// A `processing` row older than the workflow's worst-case render time is
// assumed dead (the worker crashed before `onFailure` ran). The render step is
// `timeout: 15m` with one retry (+10s delay), so a live export can legitimately
// run ~30m; pad past that so we only reconcile genuinely-orphaned rows. Such a
// stale row is marked `failed` (freeing the one-processing-row slot) rather
// than blocking new exports forever.
export const STALE_PROCESSING_MS = 35 * 60 * 1000;

export type ExportCut = {
  scenes: { orderIndex: number; videoUrl: string }[];
  musicUrl: string | null;
  sourceShotsHash: string;
};

/** The current cut of a sequence, or a 4xx when it is not renderable yet. */
export async function resolveExportCut(
  scopedDb: ScopedDb,
  sequenceId: string
): Promise<ExportCut> {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const shots = await scopedDb.shots.listBySequence(sequence.id, {
    orderBy: 'sceneOrder',
    ascending: true,
  });
  if (shots.length === 0) {
    throw new ValidationError('Sequence has no shots yet');
  }
  // Each shot's video is the version its render segment points at
  // (#1067 phase 2d) — one batched read for the whole sequence.
  const selectedVideoByShot = await scopedDb.videoVariants.getSelectedByShotIds(
    shots.map((s) => s.id)
  );
  const shotUrls = shots.map((s) => selectedVideoByShot.get(s.id)?.url ?? null);
  if (shotUrls.some((url) => !url)) {
    const missing = shotUrls.filter((url) => !url).length;
    throw new ValidationError(
      missing === shots.length
        ? 'No scene videos are ready yet'
        : `${missing} of ${shots.length} scenes are still generating`
    );
  }
  // Packed in-clip renders share one URL across covered shots (#1510).
  const scenes = collapseConsecutiveUrls(
    shotUrls.filter((url): url is string => Boolean(url))
  ).map((videoUrl, orderIndex) => ({ orderIndex, videoUrl }));
  // Hash is computed here, not accepted from the client — a wrong client
  // cache key would mark a stale MP4 as current (#1253 / #1406).
  const musicUrl = effectiveExportMusicUrl(
    sequence.includeMusic,
    sequence.musicUrl
  );
  const sourceShotsHash = await hashSequenceExportInputs({
    sceneUrls: scenes.map((s) => s.videoUrl),
    musicUrl,
  });
  return { scenes, musicUrl, sourceShotsHash };
}

async function decide(scopedDb: ScopedDb, sequenceId: string, hash: string) {
  return decideExistingExport(
    await scopedDb.sequenceExports.listAllBySequence(sequenceId),
    hash,
    Date.now(),
    STALE_PROCESSING_MS
  );
}

/**
 * What starting an export of this cut would do now — no writes. A live
 * render of a different cut is `busy_other_cut`: joining it would hand back
 * an MP4 without the latest edits.
 */
export async function previewExport(
  scopedDb: ScopedDb,
  sequenceId: string,
  cut: ExportCut
) {
  const decision = await decide(scopedDb, sequenceId, cut.sourceShotsHash);
  if (decision.action === 'return-ready') {
    return { action: 'reuse_ready' as const, exportId: decision.row.id };
  }
  if (decision.action === 'return-processing') {
    return decision.row.sourceShotsHash === cut.sourceShotsHash
      ? { action: 'join_in_flight' as const, exportId: decision.row.id }
      : { action: 'busy_other_cut' as const, exportId: decision.row.id };
  }
  return { action: 'render' as const, exportId: null };
}

/**
 * Start (or reuse) the export of `cut`. `ready` is a reused MP4; `processing`
 * is either a new render (`workflowRunId` set) or the live one it joined.
 */
export async function startExport(
  scopedDb: ScopedDb,
  input: {
    userId: string;
    teamId: string;
    sequenceId: string;
    cut: ExportCut;
  }
): Promise<{ row: SequenceExport; workflowRunId: string | null }> {
  const { sequenceId, cut } = input;
  // Content-addressed reuse (#1402): a ready MP4 of this exact cut is
  // served as-is. Otherwise coalesce onto a live processing row, or fail a
  // stale one so it stops blocking new exports.
  const decision = await decide(scopedDb, sequenceId, cut.sourceShotsHash);
  if (
    decision.action === 'return-ready' ||
    decision.action === 'return-processing'
  ) {
    return { row: decision.row, workflowRunId: null };
  }
  if (decision.action === 'fail-stale-processing') {
    await scopedDb.sequenceExports.markFailed(
      decision.row.id,
      'Export timed out — no result from the render worker'
    );
  }

  // Reserve the row BEFORE triggering so a crash between the two leaves a
  // row the stale sweep above can reconcile. `created: false` means a
  // concurrent start won the one-processing-row race — coalesce onto its row
  // rather than starting a second workflow.
  const path = `teams/${input.teamId}/sequences/${sequenceId}/exports/${generateId().slice(-8)}${EXPORT_FILENAME_SUFFIX}`;
  const { row, created } = await scopedDb.sequenceExports.createProcessing({
    sequenceId,
    url: getPublicUrl(STORAGE_BUCKETS.VIDEOS, path),
    storagePath: path,
    sourceShotsHash: cut.sourceShotsHash,
  });
  if (!created) return { row, workflowRunId: null };

  let workflowRunId: string;
  try {
    workflowRunId = await triggerWorkflow<SequenceExportWorkflowInput>(
      'sequence-export',
      {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        exportId: row.id,
        storagePath: path,
        scenes: cut.scenes,
        musicUrl: cut.musicUrl,
      }
    );
  } catch (error) {
    // Free the one-processing-row slot now, not 35 minutes from now. A
    // failed cleanup is logged; the trigger error is the one to report.
    await scopedDb.sequenceExports
      .markFailed(row.id, 'The render could not be started. Try again.')
      .catch((cleanupError: unknown) =>
        logger.error('Export trigger cleanup failed', {
          err: cleanupError,
          exportId: row.id,
        })
      );
    throw error;
  }
  // The render is running; a lost run id only costs observability.
  await scopedDb.sequenceExports
    .setWorkflowRunId(row.id, workflowRunId)
    .catch((err: unknown) =>
      logger.error('Export run id not recorded', { err, exportId: row.id })
    );
  return { row, workflowRunId };
}

/** The public export document; the URL is absolute and only set when ready. */
export function formatExport(
  row: SequenceExport,
  origin: string
): SequenceExportDocument {
  return {
    id: row.id,
    status: row.status,
    url: row.status === 'ready' ? toShareableUrl(row.url, origin) : null,
    durationSeconds: row.durationSeconds,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}
