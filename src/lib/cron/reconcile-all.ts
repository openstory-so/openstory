/**
 * Broad reconciliation sweep for stuck generating-status rows.
 *
 * Driven by the Cloudflare Workers cron in `src/server.ts` (see
 * `wrangler.jsonc` `triggers.crons`). Scans every status-bearing table
 * directly and reconciles rows the user hasn't loaded — so idle accounts
 * get healed too. This is the only reconciler; the old on-load helper was
 * removed in #727.
 *
 * Two reconciliation shapes:
 *   A. Tables with a workflow_run_id column — query the workflow binding for
 *      the run's real state, and trust it (5min staleness threshold).
 *   B. Tables without a workflow_run_id column — blind-fail after a longer
 *      threshold (30min) because we can't verify run state.
 *
 * Each pass is capped at MAX_ROWS_PER_PASS to avoid hammering the workflow
 * bindings if a regression leaves many rows stuck.
 */

import { getDb } from '#db-client';
import {
  framePromptVersions,
  frameVariants,
  frames,
  generatedAssets,
  renderSegments,
  shotPromptVersions,
  shotVariants,
  sequenceElements,
  sequences,
  videoVariants,
} from '@/lib/db/schema';
import { resolveRunState, STALE_THRESHOLD_MS } from '@/lib/workflow/reconcile';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'cron', 'reconcile-all']);

const BLIND_FAIL_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_ROWS_PER_PASS = 100;

type Database = ReturnType<typeof getDb>;
type ReconcileCounts = Record<string, number>;

/** Sentinel returned per pass in `ReconcileCounts` when the pass threw. */
export const PASS_ERRORED = -1;

/**
 * Top-level entry: run every pass sequentially. Errors in one pass don't stop
 * the others — the cron is best-effort. A failed pass records
 * `PASS_ERRORED` in the returned counts, distinguishable from a zero-update
 * pass.
 *
 * Always emits one summary log line per sweep so observability/alerting has a
 * single high-signal event per cron tick — without it, a systemic failure
 * (e.g. a binding outage making every per-row check throw) would look
 * identical to a clean sweep with nothing to do.
 */
export async function reconcileAllStuckJobs(): Promise<ReconcileCounts> {
  const db = getDb();
  const counts: ReconcileCounts = {};

  const passes: Array<[string, () => Promise<number>]> = [
    // Image lives on frames / frame_variants now (#989).
    ['frames.image', () => reconcileFramesImagePass(db)],
    ['frame_variants.status', () => reconcileFrameVariantsPass(db)],
    // Pending artifact claims (#1085): a dead run must not leave rows that
    // read as "a job is fixing this" forever.
    [
      'frame_prompt_versions.claims',
      () => reconcilePromptClaimsPass(db, 'frame'),
    ],
    [
      'shot_prompt_versions.claims',
      () => reconcilePromptClaimsPass(db, 'shot'),
    ],
    ['frame_variants.claims', () => reconcileImageClaimsPass(db)],
    // Video versions live on video_variants now (#990) — without this pass a
    // dead motion run leaves a permanent "generating" chip on the Video tab
    // (#1076).
    ['video_variants.status', () => reconcileVideoVariantsPass(db)],
    ['shot_variants.status', () => reconcileShotVariantsPass(db, 'primary')],
    [
      'shot_variants.shot_variant',
      () => reconcileShotVariantsPass(db, 'shotVariant'),
    ],
    ['sequences.status', () => reconcileSequencesPass(db)],
    ['sequences.music', () => blindFailPass(db, 'sequencesMusic')],
    ['sequence_elements.vision', () => blindFailPass(db, 'sequenceElements')],
    // Direct model runs (#458) — verified pass plus an orphan pass for rows
    // whose trigger died before a workflowRunId was ever persisted.
    ['generated_assets.status', () => reconcileGeneratedAssetsPass(db)],
    ['generated_assets.orphaned', () => failOrphanedGeneratedAssetsPass(db)],
  ];

  for (const [name, run] of passes) {
    try {
      counts[name] = await run();
    } catch (error) {
      logger.error(`${name} pass failed:`, {
        data: error instanceof Error ? error.message : error,
      });
      counts[name] = PASS_ERRORED;
    }
  }

  const failedPasses = Object.entries(counts)
    .filter(([, n]) => n === PASS_ERRORED)
    .map(([name]) => name);
  const totalReconciled = Object.values(counts)
    .filter((n) => n > 0)
    .reduce((sum, n) => sum + n, 0);

  if (failedPasses.length === passes.length) {
    logger.error('ALL passes failed', { counts });
  } else if (failedPasses.length > 0) {
    logger.warn('partial failure', { failedPasses, counts });
  } else if (totalReconciled > 0) {
    logger.info(`sweep complete: ${totalReconciled} row(s) reconciled`, {
      counts,
    });
  }

  return counts;
}

// Why we don't bump `updatedAt` on reconciler writes (applies to every pass
// in this file): the staleness predicate is `updated_at < cutoff`. If pass A
// updated `updated_at = now` while writing its status column, pass B's
// SELECT for the same row would see a fresh timestamp and skip it. So when a
// row is stuck across multiple pipelines simultaneously, only the first
// pass would reconcile. Leaving `updated_at` untouched lets sequential
// passes all see the row as stale until each one has flipped its own
// status column. The on-load reconciler doesn't have this issue because it
// collects all stale entries from in-memory data before writing.
/**
 * Reconcile stuck anchor-frame image generation (#989 — the old
 * `shots.thumbnail*` pass). Frame image status with a known workflow run id.
 */
async function reconcileFramesImagePass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await db
    .select({ id: frames.id, runId: frames.imageWorkflowRunId })
    .from(frames)
    .where(
      and(
        eq(frames.imageStatus, 'generating'),
        lt(frames.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(frames)
      .set({ imageStatus: next })
      .where(eq(frames.id, row.id));
    updated++;
  }
  return updated;
}

/**
 * Reconcile stuck `frame_variants` versions (model re-rolls + the 3×3 grid /
 * upscaled framing tiles) — the image-variant analog of the retired
 * `shots.variant_image` pass.
 */
async function reconcileFrameVariantsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await db
    .select({ id: frameVariants.id, runId: frameVariants.workflowRunId })
    .from(frameVariants)
    .where(
      and(
        eq(frameVariants.status, 'generating'),
        lt(frameVariants.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(frameVariants)
      .set({ status: next })
      .where(eq(frameVariants.id, row.id));
    // Drop auto-promote claim if this stuck version held it (#1070).
    if (next === 'failed') {
      await db
        .update(frames)
        .set({ pendingPromoteVersionId: null, updatedAt: new Date() })
        .where(eq(frames.pendingPromoteVersionId, row.id));
    }
    updated++;
  }
  return updated;
}

/**
 * Reconcile stuck `video_variants` versions (#990 / #1076) — the motion analog
 * of {@link reconcileFrameVariantsPass}. Dead motion runs that never hit
 * `onFailure` left permanent "generating" chips on the Video tab; heal them
 * from the workflow instance status and drop a failed version's auto-promote
 * claim on its render segment.
 */
async function reconcileVideoVariantsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await db
    .select({ id: videoVariants.id, runId: videoVariants.workflowRunId })
    .from(videoVariants)
    .where(
      and(
        eq(videoVariants.status, 'generating'),
        lt(videoVariants.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(videoVariants)
      .set({ status: next })
      .where(eq(videoVariants.id, row.id));
    // Drop auto-promote claim if this stuck version held it (#1070).
    if (next === 'failed') {
      await db
        .update(renderSegments)
        .set({ pendingPromoteVersionId: null, updatedAt: new Date() })
        .where(eq(renderSegments.pendingPromoteVersionId, row.id));
    }
    updated++;
  }
  return updated;
}

/**
 * Sweep zombie pending prompt claims (#1085) — `frame_prompt_versions` /
 * `shot_prompt_versions` rows still 'pending'/'generating' whose producing
 * instance is dead. The honest terminal state is always 'failed' (never
 * 'completed': a live claim on a terminal instance means the completion write
 * never landed, so there is no content). Failed frame-side claims cascade to
 * their dependent image claims. Rows with no run id (trigger died between
 * insert and the run-id stamp) blind-fail after the longer threshold.
 *
 * Cutoffs use `createdAt` — these tables have no `updatedAt`, and a claim's
 * whole lifecycle is minutes, so enqueue age is the right staleness signal.
 */
async function reconcilePromptClaimsPass(
  db: Database,
  side: 'frame' | 'shot'
): Promise<number> {
  const table = side === 'frame' ? framePromptVersions : shotPromptVersions;
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const blindCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);
  let updated = 0;

  const cascade = async (versionId: string) => {
    if (side !== 'frame') return;
    // No updatedAt bump — see the file-wide rule near the top.
    await db
      .update(frameVariants)
      .set({
        status: 'cancelled',
        error: 'Upstream visual prompt generation died',
      })
      .where(
        and(
          eq(frameVariants.dependsOnVersionId, versionId),
          inArray(frameVariants.status, ['pending', 'generating'])
        )
      );
  };

  const stuck = await db
    .select({ id: table.id, runId: table.workflowRunId })
    .from(table)
    .where(
      and(
        inArray(table.status, ['pending', 'generating']),
        isNotNull(table.workflowRunId),
        lt(table.createdAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    // Re-guard live status at write time: a long generation can complete the
    // claim between the SELECT above and this UPDATE (resolveRunState is a
    // network RPC). Without the predicate we'd overwrite completed content
    // with 'failed' and cascade-cancel dependent image claims.
    const transitioned = await db
      .update(table)
      .set({ status: 'failed' })
      .where(
        and(
          eq(table.id, row.id),
          inArray(table.status, ['pending', 'generating'])
        )
      )
      .returning({ id: table.id });
    if (transitioned.length === 0) continue;
    await cascade(row.id);
    updated++;
  }

  const orphaned = await db
    .update(table)
    .set({ status: 'failed' })
    .where(
      and(
        inArray(table.status, ['pending', 'generating']),
        isNull(table.workflowRunId),
        lt(table.createdAt, blindCutoff)
      )
    )
    .returning({ id: table.id });
  for (const row of orphaned) await cascade(row.id);

  return updated + orphaned.length;
}

/**
 * Sweep zombie 'pending' image claims (#1085). The existing
 * `frame_variants.status` pass covers 'generating' rows; claim rows that
 * never reached `set-generating-status` stay 'pending' with the enqueue-time
 * run id (or none, if the trigger died first). Terminal instance → 'failed';
 * no run id → blind-fail after the longer threshold.
 */
async function reconcileImageClaimsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const blindCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);
  let updated = 0;

  const stuck = await db
    .select({ id: frameVariants.id, runId: frameVariants.workflowRunId })
    .from(frameVariants)
    .where(
      and(
        eq(frameVariants.status, 'pending'),
        isNotNull(frameVariants.workflowRunId),
        lt(frameVariants.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    // 'failed' regardless of the instance verdict: a still-pending claim on a
    // terminal instance means no render ever landed on this row. Re-guard
    // status so a completion that raced the network lookup is never
    // overwritten (same TOCTOU as the prompt-claim pass).
    const transitioned = await db
      .update(frameVariants)
      .set({ status: 'failed', error: 'Generation died before starting' })
      .where(
        and(eq(frameVariants.id, row.id), eq(frameVariants.status, 'pending'))
      )
      .returning({ id: frameVariants.id });
    if (transitioned.length === 0) continue;
    updated++;
  }

  const orphaned = await db
    .update(frameVariants)
    .set({ status: 'failed', error: 'Generation could not be started' })
    .where(
      and(
        eq(frameVariants.status, 'pending'),
        isNull(frameVariants.workflowRunId),
        lt(frameVariants.updatedAt, blindCutoff)
      )
    )
    .returning({ id: frameVariants.id });

  return updated + orphaned.length;
}

type ShotVariantsPipeline = 'primary' | 'shotVariant';

async function reconcileShotVariantsPass(
  db: Database,
  pipeline: ShotVariantsPipeline
): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck =
    pipeline === 'primary'
      ? await db
          .select({ id: shotVariants.id, runId: shotVariants.workflowRunId })
          .from(shotVariants)
          .where(
            and(
              eq(shotVariants.status, 'generating'),
              lt(shotVariants.updatedAt, staleCutoff)
            )
          )
          .limit(MAX_ROWS_PER_PASS)
      : await db
          .select({
            id: shotVariants.id,
            runId: shotVariants.shotVariantWorkflowRunId,
          })
          .from(shotVariants)
          .where(
            and(
              eq(shotVariants.shotVariantStatus, 'generating'),
              lt(shotVariants.updatedAt, staleCutoff)
            )
          )
          .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    if (pipeline === 'primary') {
      await db
        .update(shotVariants)
        .set({ status: next })
        .where(eq(shotVariants.id, row.id));
    } else {
      await db
        .update(shotVariants)
        .set({ shotVariantStatus: next })
        .where(eq(shotVariants.id, row.id));
    }
    updated++;
  }
  return updated;
}

/**
 * Heal sequences stuck in 'processing' whose /storyboard workflow died
 * without persisting an outcome (engine abort, waitForEvent timeout with a
 * pre-#839 log-only onFailure, eviction). Verified against the CF instance's
 * real status via the persisted `workflowRunId` — rows whose instance is
 * still in flight return `null` from `resolveRunState` and are left alone,
 * so a legitimately slow (multi-hour) generation is never falsely failed.
 *
 * Rows with a NULL `workflowRunId` (created before the column existed, or
 * whose trigger-site write failed) are skipped entirely: without a run id we
 * can't distinguish slow-but-alive from dead, and 'processing' has no safe
 * blind-fail threshold now that full runs can legitimately take hours.
 */
// Narrowly typed so the compiler
// enforces the null/'unknown' skip in the loop below: dropping either guard
// makes this call fail typecheck instead of silently flipping a live (or
// unverifiable) sequence to 'completed'.
const setSequenceStatus = (next: 'failed' | 'completed') =>
  next === 'failed'
    ? {
        status: 'failed' as const,
        statusError: 'Generation was interrupted — use Retry to run it again.',
      }
    : { status: 'completed' as const };

async function reconcileSequencesPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: sequences.id, runId: sequences.workflowRunId })
    .from(sequences)
    .where(
      and(
        eq(sequences.status, 'processing'),
        isNotNull(sequences.workflowRunId),
        lt(sequences.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(sequences)
      .set(setSequenceStatus(next))
      .where(eq(sequences.id, row.id));
    updated++;
  }
  return updated;
}

// Narrowly typed like `setSequenceStatus` so dropping the null/'unknown'
// guard in the loop fails typecheck. A verified-'completed' instance whose
// row is still queued/running means `markCompleted` never landed — the
// outputs can't be recovered here, so the honest terminal state is 'failed'
// with a retry hint, never a fabricated 'completed' without outputs.
const setGeneratedAssetStatus = (next: 'failed' | 'completed') =>
  next === 'failed'
    ? {
        status: 'failed' as const,
        error: 'Generation was interrupted — run it again.',
      }
    : {
        status: 'failed' as const,
        error:
          'The generation finished but its result was not saved — run it again.',
      };

/**
 * Heal `generated_assets` rows stuck in 'queued'/'running' whose workflow
 * died without persisting an outcome, verified against the CF instance via
 * the persisted `workflowRunId` (same shape as the sequences pass).
 */
async function reconcileGeneratedAssetsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: generatedAssets.id, runId: generatedAssets.workflowRunId })
    .from(generatedAssets)
    .where(
      and(
        inArray(generatedAssets.status, ['queued', 'running']),
        isNotNull(generatedAssets.workflowRunId),
        lt(generatedAssets.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(generatedAssets)
      .set(setGeneratedAssetStatus(next))
      .where(eq(generatedAssets.id, row.id));
    updated++;
  }
  return updated;
}

/**
 * Blind-fail `generated_assets` rows stuck 'queued' with NO `workflowRunId`.
 * The create fn marks the row failed when the trigger throws, so this only
 * catches the residue (crash between insert and that catch, or a failed
 * `setWorkflowRunId` write whose workflow then also died before its own
 * first write). A live workflow flips the row to 'running' within seconds,
 * so 'queued' after 30 minutes with no run id is safely dead.
 */
async function failOrphanedGeneratedAssetsPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);

  const result = await db
    .update(generatedAssets)
    .set({
      status: 'failed',
      error: 'The generation could not be started — please try again.',
    })
    .where(
      and(
        eq(generatedAssets.status, 'queued'),
        isNull(generatedAssets.workflowRunId),
        lt(generatedAssets.updatedAt, staleCutoff)
      )
    )
    .returning({ id: generatedAssets.id });
  return result.length;
}

type BlindFailPipeline = 'sequencesMusic' | 'sequenceElements';

/**
 * Tables without a workflow_run_id column: we can't ask the engine what
 * happened.
 * After a longer threshold we mark them failed so the user can retry.
 *
 * Why 30min vs the 5min run-verified threshold: with no run id we can't
 * distinguish a slow-but-alive run from a dead one, so we wait long enough
 * that any reasonable workflow would have completed (the slowest current
 * workflows — music gen and element vision — finish well under 30min).
 * Note we can only flip to 'failed' here, never 'completed' — without a run
 * id, success requires the workflow's own update step to have persisted, and
 * if that didn't happen the artifact URL won't be there either.
 */
async function blindFailPass(
  db: Database,
  pipeline: BlindFailPipeline
): Promise<number> {
  const staleCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);

  if (pipeline === 'sequencesMusic') {
    const result = await db
      .update(sequences)
      .set({ musicStatus: 'failed' })
      .where(
        and(
          eq(sequences.musicStatus, 'generating'),
          lt(sequences.updatedAt, staleCutoff)
        )
      )
      .returning({ id: sequences.id });
    return result.length;
  }

  // sequenceElements
  const result = await db
    .update(sequenceElements)
    .set({ visionStatus: 'failed' })
    .where(
      and(
        eq(sequenceElements.visionStatus, 'analyzing'),
        lt(sequenceElements.updatedAt, staleCutoff)
      )
    )
    .returning({ id: sequenceElements.id });
  return result.length;
}
