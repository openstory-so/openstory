/**
 * Launch and read an "Update all" run (#1077, #1819). Shared by the editor
 * (`updateStaleShotsFn`, `getUpdateStaleShotsRunFn`) and agent operations
 * (#1460).
 */

import { z } from 'zod';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { getWorkflowRunOutcome } from '@/platform/server/workflow/run-outcome';
import { workflowNameFromRunId } from '@/platform/server/workflow/trigger-bindings';
import type { UpdateStaleShotsWorkflowInput } from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
import { getChannelHistory, getGenerationChannel } from '@/platform/realtime';
import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/models/models';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { estimateImageCost, gateEstimate } from '@/billing/cost-estimation';
import { ZERO_MICROS, type Microdollars } from '@/billing/money';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import type { UpdateStaleDepth } from '@/shots/update-stale-depth';
import type { PlanUnit } from '@/sequences/generation-plan';
import { planUpdateAll, type UpdateStalePlan } from './update-stale-plan';

const logger = getLogger(['openstory', 'update-stale-run']);

/**
 * Shape of `UpdateStaleShotsWorkflow`'s return value. Parsed rather than cast:
 * it crosses the Cloudflare Workflows boundary as `unknown`, and a run from a
 * previously-deployed version of the workflow can legitimately not match.
 */
const updateStaleShotsResultSchema = z.object({
  totalShots: z.number(),
  visualPrompts: z.number(),
  motionPrompts: z.number(),
  images: z.number(),
  // Depth-picker levels (#1085). Defaulted so a run from a pre-picker
  // deployment still parses during version skew.
  videos: z.number().default(0),
  // Dialogue depth (#1703/#1740), defaulted for the same version skew.
  dialogues: z.number().default(0),
  musicPrompts: z.number().default(0),
  musicTracks: z.number().default(0),
  failures: z.array(
    z.object({ shotId: z.string(), stage: z.string(), error: z.string() })
  ),
  skipped: z.array(z.object({ shotId: z.string(), reason: z.string() })),
});

/**
 * The one gate and plan for "Update all", shared by the editor and MCP so the
 * two can never disagree on whether a run may start.
 *
 * Never races the pipeline (#1121): while a storyboard run owns the sequence
 * it is rewriting these artifacts anyway, so an Update all run would bill for
 * work about to be overwritten. Shot artifacts are versioned and land through
 * claims, so nothing else needs to be idle.
 *
 * `creditFloorMicros` is what the balance must cover before launch: a floor,
 * not a quote — one artifact of the most expensive level. 'prompts' has no
 * render cost; LLM spend is deducted inside the workflow as always. The
 * caller enforces it (the editor refuses, an agent plan reports a blocker).
 */
/** Whose keys waive the floor: Update all's renders are fal's. */
export const UPDATE_STALE_CREDIT_PROVIDERS = ['fal'] as const;

export async function prepareUpdateStale(args: {
  scopedDb: ScopedDb;
  userId: string;
  sequence: Pick<
    Sequence,
    'id' | 'status' | 'imageModel' | 'aspectRatio' | 'resolution'
  >;
  depth: UpdateStaleDepth;
  sceneId?: string;
  shotId?: string;
  shotIds?: readonly string[];
  /** The live plan, when the caller already computed it (agent plans). */
  generationPlan?: readonly PlanUnit[];
}): Promise<{ plan: UpdateStalePlan; creditFloorMicros: Microdollars }> {
  const { scopedDb, sequence, depth } = args;
  if (sequence.status === 'processing') {
    throw new ValidationError(
      'This sequence is still generating — wait for the run to finish before updating out-of-date shots.'
    );
  }
  const model = safeTextToImageModel(sequence.imageModel, DEFAULT_IMAGE_MODEL);
  const creditFloorMicros =
    depth === 'prompts'
      ? ZERO_MICROS
      : gateEstimate(
          estimateImageCost(model, sequence.aspectRatio, 1, {
            pricing: await getEffectiveFalPricing(),
            resolution: sequence.resolution,
          }),
          { model, operation: 'update-stale-shots' }
        );
  const plan = await planUpdateAll({
    scopedDb,
    sequenceId: sequence.id,
    sceneId: args.sceneId,
    shotId: args.shotId,
    shotIds: args.shotIds,
    depth,
    userId: args.userId,
    generationPlan: args.generationPlan,
  });
  return { plan, creditFloorMicros };
}

/**
 * Enqueue the frozen plan. `runKey` must start with the sequence id: the
 * instance id embeds it, and `readUpdateStaleRun` requires it before reading a
 * caller-supplied run id. A stable key makes the trigger idempotent while the
 * instance lives.
 */
export async function launchUpdateStale(input: {
  userId: string;
  teamId: string;
  sequenceId: string;
  plan: UpdateStalePlan;
  runKey: string;
}): Promise<string> {
  const workflowRunId = await triggerWorkflow<UpdateStaleShotsWorkflowInput>(
    '/update-stale-shots',
    {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId: input.sequenceId,
      plan: input.plan,
    },
    { deduplicationId: input.runKey }
  );
  // Open editors adopt the run from this event, whoever started it. Logged,
  // not thrown: the run is already enqueued.
  try {
    await getGenerationChannel(input.sequenceId).emit(
      'generation.update-stale:start',
      { workflowRunId }
    );
  } catch (error) {
    logger.error('update-stale:start not emitted', {
      sequenceId: input.sequenceId,
      err: error,
    });
  }
  return workflowRunId;
}

const startedRunSchema = z.object({ workflowRunId: z.string().min(1) });

/**
 * The Update all run still in flight on this sequence, from the channel's
 * replayable history: the newest announced run, if it is still running. Lets
 * an editor opened mid-run show the run it did not start.
 */
export async function findRunningUpdateStale(
  sequenceId: string
): Promise<string | null> {
  const history = await getChannelHistory(sequenceId);
  const started = [...history]
    .reverse()
    .find((row) => row.event === 'generation.update-stale:start');
  if (!started) return null;
  let data: unknown;
  try {
    data = JSON.parse(started.data);
  } catch {
    return null;
  }
  const parsed = startedRunSchema.safeParse(data);
  if (!parsed.success) return null;
  const { state } = await readUpdateStaleRun(
    sequenceId,
    parsed.data.workflowRunId
  );
  return state === 'running' ? parsed.data.workflowRunId : null;
}

/**
 * Terminal outcome of one Update all run, or `unknown` when the id is not an
 * Update all run of this sequence (it is caller-supplied).
 */
export async function readUpdateStaleRun(sequenceId: string, runId: string) {
  if (
    workflowNameFromRunId(runId) !== 'update-stale-shots' ||
    !runId.includes(sequenceId)
  ) {
    return { state: 'unknown' as const };
  }
  const outcome = await getWorkflowRunOutcome(runId);
  if (outcome.state !== 'complete') return outcome;
  const parsed = updateStaleShotsResultSchema.safeParse(outcome.output);
  // A complete run whose output we can't read is not a failure to report as
  // one — fall back to 'unknown' so the UI defers to the staleness map.
  if (!parsed.success) {
    logger.error(`readUpdateStaleRun: unrecognised output for ${runId}`, {
      issues: parsed.error.issues,
    });
    return { state: 'unknown' as const };
  }
  return { state: 'complete' as const, result: parsed.data };
}
