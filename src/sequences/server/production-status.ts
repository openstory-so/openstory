import { z } from 'zod';
import type {
  Frame,
  Sequence,
  SequenceExport,
} from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { ShotProductionReadiness } from './db/sequences';
import { usesStartFrame } from '@/shots/use-start-frame';

export const productionStatusSchema = z.object({
  sequenceId: z.string(),
  status: z.string(),
  sequenceStatus: z.string(),
  counts: z.object({
    shots: z.number(),
    imagesReady: z.number(),
    imagesFailed: z.number(),
    videosReady: z.number(),
    videosFailed: z.number(),
    renderSegments: z.number(),
  }),
  musicStatus: z.string().nullable(),
  workflowRunIds: z.array(z.string()),
  workflowsTruncated: z.boolean(),
  activeExports: z.array(
    z.object({ id: z.string(), workflowRunId: z.string().nullable() })
  ),
  exportsTruncated: z.boolean(),
  failures: z
    .array(
      z.object({
        stage: z.string(),
        id: z.string(),
        shotId: z.string().optional(),
        error: z.string().nullable(),
      })
    )
    .optional(),
  failuresTruncated: z.boolean().optional(),
});

type ProductionStatusRead = {
  rows: ShotProductionReadiness[];
  failedFrames: Frame[];
  exports: SequenceExport[];
};

/**
 * Status for one sequence from the reads the app already has: the narrow shot
 * readiness rows, the export list, and — only when failures are asked for —
 * the sequence's frames, so a failed non-anchor frame is reported too.
 */
export async function readProductionStatus(
  scopedDb: ScopedDb,
  sequence: Sequence,
  includeFailures: boolean
) {
  const [rows, exports, frames] = await Promise.all([
    scopedDb.sequences.listShotReadinessByIds([sequence.id]),
    scopedDb.sequenceExports.listAllBySequence(sequence.id),
    includeFailures ? scopedDb.frames.listBySequence(sequence.id) : [],
  ]);
  const liveShots = new Set(rows.map((row) => row.shotId));
  return buildProductionStatus(
    sequence,
    {
      rows,
      exports,
      failedFrames: frames.filter(
        (frame) => frame.imageStatus === 'failed' && liveShots.has(frame.shotId)
      ),
    },
    includeFailures
  );
}

/** Selected usability and last-attempt failures can both be true. No DB enum changes. */
export function buildProductionStatus(
  sequence: Sequence,
  read: ProductionStatusRead,
  includeFailures: boolean
) {
  const { rows, exports, failedFrames } = read;
  const counts = {
    shots: rows.length,
    imagesReady: rows.filter((r) => r.selectedImageUrl !== null).length,
    imagesFailed: rows.filter((r) => r.imageStatus === 'failed').length,
    videosReady: rows.filter((r) => r.selectedVideoUrl !== null).length,
    videosFailed: rows.filter((r) => r.primaryVideoStatus === 'failed').length,
    renderSegments: new Set(
      rows.flatMap((r) => (r.renderSegmentId ? [r.renderSegmentId] : []))
    ).size,
  };
  const hasFailures =
    counts.videosFailed > 0 ||
    (sequence.includeMusic && sequence.musicStatus === 'failed') ||
    rows.some((r) => r.imageStatus === 'failed' && usesStartFrame(r, sequence));
  const status =
    sequence.status === 'completed' && hasFailures
      ? 'partially_ready'
      : sequence.status;
  const workflowRunIds = new Set<string>();
  if (sequence.status === 'processing' && sequence.workflowRunId)
    workflowRunIds.add(sequence.workflowRunId);
  for (const r of rows) {
    if (r.imageStatus === 'generating' && r.imageWorkflowRunId)
      workflowRunIds.add(r.imageWorkflowRunId);
    if (
      (r.primaryVideoStatus === 'generating' ||
        r.primaryVideoStatus === 'pending') &&
      r.videoWorkflowRunId
    )
      workflowRunIds.add(r.videoWorkflowRunId);
  }
  const activeExports = exports.filter((e) => e.status === 'processing');
  for (const e of activeExports)
    if (e.workflowRunId) workflowRunIds.add(e.workflowRunId);
  const failures: {
    stage: string;
    id: string;
    shotId?: string;
    error: string | null;
  }[] = [];
  if (includeFailures) {
    if (sequence.status === 'failed')
      failures.push({
        stage: 'sequence',
        id: sequence.id,
        error: sequence.statusError,
      });
    for (const frame of failedFrames)
      failures.push({
        stage: 'image',
        id: frame.id,
        shotId: frame.shotId,
        error: frame.imageError,
      });
    const seenVideos = new Set<string>();
    for (const r of rows)
      if (
        r.primaryVideoStatus === 'failed' &&
        r.primaryVideoId &&
        !seenVideos.has(r.primaryVideoId)
      ) {
        seenVideos.add(r.primaryVideoId);
        failures.push({
          stage: 'motion',
          id: r.primaryVideoId,
          shotId: r.shotId,
          error: r.videoError,
        });
      }
    if (sequence.musicStatus === 'failed')
      failures.push({
        stage: 'music',
        id: sequence.id,
        error: sequence.musicError,
      });
    for (const e of exports)
      if (e.status === 'failed')
        failures.push({ stage: 'export', id: e.id, error: e.error });
  }
  return {
    sequenceId: sequence.id,
    status,
    sequenceStatus: sequence.status,
    counts,
    musicStatus: sequence.musicStatus,
    workflowRunIds: [...workflowRunIds].slice(0, 100),
    workflowsTruncated: workflowRunIds.size > 100,
    activeExports: activeExports
      .slice(0, 100)
      .map(({ id, workflowRunId }) => ({ id, workflowRunId })),
    exportsTruncated: activeExports.length > 100,
    ...(includeFailures
      ? {
          failures: failures
            .slice(0, 100)
            .map((f) => ({ ...f, error: f.error?.slice(0, 1000) ?? null })),
          failuresTruncated:
            failures.length > 100 ||
            failedFrames.length > 100 ||
            exports.filter((e) => e.status === 'failed').length > 100,
        }
      : {}),
  };
}
