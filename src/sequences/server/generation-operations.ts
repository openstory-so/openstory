/**
 * Agent generation plans, replay-safe execution and operation status
 * (#1460). The MCP tools are thin adapters over these three functions.
 *
 * Planning reuses the editor's planners with no generation side effects:
 * - `stale`: Update all (`planUpdateAll`) up to a depth, for the sequence, a
 *   list of scenes or a list of shots. Never a first render.
 * - `missing`: Continue (`continueFromPlan` → `computePlan`) up to a stop,
 *   for the whole sequence, with its current switches and models.
 *
 * The plan row stores a digest of what will run and what it costs, the
 * estimate and the work it targets. Execute re-plans from live D1, requires
 * the same digest, rejects a live run and a short balance, then takes the row
 * `planned` → `executing` in one guarded UPDATE before launching through the
 * editor's launchers. A repeated or concurrent execute finds the row taken
 * and returns the same operation: no second launch, no second spend.
 */

import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  OpenStoryError,
  ValidationError,
} from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GenerationPlanRow, Sequence } from '@/platform/server/db/schema';
import { getWorkflowRunOutcome } from '@/platform/server/workflow/run-outcome';
import { requireCredits } from '@/billing/server/preflight';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { estimateImageCost, gateEstimate } from '@/billing/cost-estimation';
import type { Microdollars } from '@/billing/money';
import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/models/models';
import { sha256Hex } from '@/shots/input-hash';
import { planUpdateAll, computePlan } from '@/shots/server/update-stale-plan';
import type { UpdateStalePlan } from '@/shots/server/update-stale-plan';
import { buildUpdateStalePreview } from '@/shots/server/update-stale-preview';
import {
  launchUpdateStale,
  readUpdateStaleRun,
} from '@/shots/server/update-stale-run';
import type { UpdateStaleDepth } from '@/shots/update-stale-depth';
import type { GenerationStage } from '@/sequences/pipeline';
import { productionAccess } from './production-access';
import { computeGenerationPlan } from './generation-plan';
import { continueFromPlan, estimateContinueCost } from './continue-plan';
import { getSequenceRejectingActiveRun, triggerContinue } from './launchers';
import { readProductionStatus } from './production-status';

/** How long an approved plan may wait before execute refuses it. */
const PLAN_TTL_MS = 30 * 60 * 1000;
/** Suggested polling interval for get_operation_status. */
const OPERATION_POLL_SECONDS = 15;
/** An `executing` row older than this with no run lost its dispatch. */
const DISPATCH_GRACE_MS = 2 * 60 * 1000;
/** A run with no readable outcome this long after launch stops being polled. */
const UNKNOWN_GIVE_UP_MS = 24 * 60 * 60 * 1000;

type GenerationTarget =
  | { kind: 'sequence' }
  | { kind: 'scenes'; sceneIds: string[] }
  | { kind: 'shots'; shotIds: string[] };

export type GenerationRequest =
  | { mode: 'stale'; depth: UpdateStaleDepth; target: GenerationTarget }
  | { mode: 'missing'; stopAt: GenerationStage; target: GenerationTarget };

type Actor = { userId: string; teamId: string };

const shotList = z.array(z.string());
/** What a plan does, per stage — shown for approval, kept for polling. */
export const generationWorkSchema = z.object({
  targetShotIds: shotList,
  stages: z.object({
    visualPrompts: shotList,
    motionPrompts: shotList,
    specs: shotList,
    images: shotList,
    dialogue: shotList,
    videos: shotList,
  }),
  music: z.object({ prompt: z.boolean(), track: z.boolean() }).nullable(),
  skipped: z.array(z.object({ shotId: z.string(), reason: z.string() })),
  inFlightShotIds: shotList,
  referenceOnlyShotIds: shotList,
  models: z.object({
    image: z.string(),
    video: z.string(),
    perShotImage: z.record(z.string(), z.string()),
  }),
});
type GenerationWork = z.infer<typeof generationWorkSchema>;

async function shotIdsFor(
  scopedDb: ScopedDb,
  sequenceId: string,
  target: GenerationTarget
): Promise<string[] | undefined> {
  const access = productionAccess(scopedDb);
  if (target.kind === 'sequence') return undefined;
  if (target.kind === 'shots') {
    for (const id of target.shotIds) await access.shot(sequenceId, id);
    return target.shotIds;
  }
  for (const id of target.sceneIds) await access.scene(sequenceId, id);
  const sceneIds = new Set(target.sceneIds);
  return (await scopedDb.shots.listBySequence(sequenceId))
    .filter((shot) => shot.sceneId !== null && sceneIds.has(shot.sceneId))
    .map((shot) => shot.id);
}

/** Update all's floor (as `updateStaleShotsFn`): one image of the sequence model. */
async function oneImageFloor(sequence: Sequence): Promise<Microdollars> {
  const model = safeTextToImageModel(sequence.imageModel, DEFAULT_IMAGE_MODEL);
  return gateEstimate(
    estimateImageCost(model, sequence.aspectRatio, 1, {
      pricing: await getEffectiveFalPricing(),
      resolution: sequence.resolution,
    }),
    { model, operation: 'update-stale-shots' }
  );
}

/** Freeze the plan and price it, exactly as the editor would. */
async function buildPlan(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  request: GenerationRequest
): Promise<{
  sequence: Sequence;
  plan: UpdateStalePlan;
  shotIds: string[] | undefined;
  /** For display and the digest; null when a component has no price. */
  estimateMicros: Microdollars | null;
  /** What the balance must cover: the known parts, never skipped. */
  creditCheckMicros: Microdollars;
  /** Continue's effective stop (it can move past a switch lock). */
  stopAt?: GenerationStage;
}> {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const shotIds = await shotIdsFor(scopedDb, sequence.id, request.target);

  if (request.mode === 'stale') {
    const plan = await planUpdateAll({
      scopedDb,
      sequenceId: sequence.id,
      shotIds,
      depth: request.depth,
      userId: actor.userId,
    });
    const estimateMicros = buildUpdateStalePreview(
      plan,
      await getEffectiveFalPricing(),
      sequence.musicModel
    ).costByLevel[request.depth];
    const floor =
      request.depth === 'prompts' ? 0 : await oneImageFloor(sequence);
    return {
      sequence,
      plan,
      shotIds,
      estimateMicros,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- max of two Microdollars
      creditCheckMicros: Math.max(estimateMicros ?? 0, floor) as Microdollars,
    };
  }

  if (request.target.kind !== 'sequence') {
    throw new ValidationError(
      'mode "missing" (Continue) plans the whole sequence. Omit sceneIds/shotIds, or use mode "stale" for scenes or shots.'
    );
  }
  const generationPlan = await computeGenerationPlan(scopedDb, sequence.id);
  const switches = {
    generateStartFrames: sequence.generateStartFrames,
    generateVoices: sequence.generateVoices,
  };
  const { work, stopAt } = continueFromPlan({
    current: generationPlan,
    next: generationPlan,
    saved: switches,
    requested: switches,
    stopAt: request.stopAt,
  });
  const [plan, estimate] = await Promise.all([
    computePlan({
      scopedDb,
      sequenceId: sequence.id,
      units: work.map(({ kind, id }) => ({ kind, id })),
      userId: actor.userId,
    }),
    estimateContinueCost({
      sequence,
      shots: await scopedDb.shots.listBySequence(sequence.id),
      work,
      generateStartFrames: sequence.generateStartFrames,
      draftMotion: sequence.draftMotion,
    }),
  ]);
  return {
    sequence,
    plan,
    shotIds,
    stopAt,
    estimateMicros: estimate.priced ? estimate.micros : null,
    // The editor checks the partial sum when a part has no price; so do we.
    creditCheckMicros: estimate.micros,
  };
}

function summarize(
  plan: UpdateStalePlan,
  inFlightShotIds: string[]
): GenerationWork {
  const shots = (flag: keyof UpdateStalePlan['targets'][number]) =>
    plan.targets.filter((t) => t[flag] === true).map((t) => t.shotId);
  return {
    targetShotIds: plan.targets.map((t) => t.shotId),
    stages: {
      visualPrompts: shots('regenVisual'),
      motionPrompts: shots('regenMotion'),
      specs: shots('rewriteSpec'),
      images: shots('regenImage'),
      dialogue: shots('regenDialogue'),
      videos: shots('regenVideo'),
    },
    music: plan.music
      ? { prompt: plan.music.regenPrompt, track: plan.music.regenTrack }
      : null,
    skipped: plan.skipped,
    inFlightShotIds,
    referenceOnlyShotIds: plan.targets
      .filter((t) => !t.usesStartFrame)
      .map((t) => t.shotId),
    models: {
      image: plan.sequence.imageModel,
      video: plan.sequence.videoModel,
      perShotImage: Object.fromEntries(
        plan.targets.map((t) => [t.shotId, t.imageModel])
      ),
    },
  };
}

/**
 * The digest binds what runs and what it costs: the request, every target
 * (ids, flags, pinned versions, input hashes, models), music, skips, the
 * render-affecting sequence settings and the estimate. Display fields (the
 * sequence title, the reference rows) and Dates are left out, so a rename or
 * a touched timestamp does not change it.
 */
function planDigest(
  request: GenerationRequest,
  built: Pick<
    Awaited<ReturnType<typeof buildPlan>>,
    'plan' | 'estimateMicros' | 'stopAt'
  >
) {
  const { plan } = built;
  const material = JSON.stringify(
    {
      request,
      targets: plan.targets,
      music: plan.music,
      skipped: plan.skipped,
      sequence: {
        imageModel: plan.sequence.imageModel,
        videoModel: plan.sequence.videoModel,
        generateStartFrames: plan.sequence.generateStartFrames,
        draftMotion: plan.sequence.draftMotion,
        aspectRatio: plan.aspectRatio,
        resolution: plan.resolution,
      },
      estimateMicros: built.estimateMicros,
      stopAt: built.stopAt ?? null,
    },
    // `undefined` optionals are dropped; so are timestamps.
    function (this: Record<string, unknown>, key: string, value: unknown) {
      return this[key] instanceof Date ? undefined : value;
    }
  );
  return sha256Hex(JSON.parse(material));
}

function hasWork(plan: UpdateStalePlan) {
  return (
    plan.targets.length > 0 ||
    (plan.music !== null && (plan.music.regenPrompt || plan.music.regenTrack))
  );
}

export async function planGeneration(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  request: GenerationRequest
) {
  const built = await buildPlan(scopedDb, actor, sequenceId, request);
  const { sequence, plan, shotIds, estimateMicros } = built;
  const inFlightShotIds = [
    ...new Set(
      (await computeGenerationPlan(scopedDb, sequence.id))
        .filter(
          (u) => u.state === 'running' && (!shotIds || shotIds.includes(u.id))
        )
        .map((u) => u.id)
    ),
  ];
  const work = summarize(plan, inFlightShotIds);
  const blockers: { code: string; message: string }[] = [];
  if (sequence.status === 'processing') {
    blockers.push({
      code: 'GENERATION_IN_PROGRESS',
      message: 'A run is generating this sequence; execute after it finishes.',
    });
  }
  if (!hasWork(plan)) {
    blockers.push({ code: 'NOTHING_TO_DO', message: 'Nothing to generate.' });
  }
  // Reported, not thrown: funds can still change before execute.
  try {
    await requireCredits(scopedDb, built.creditCheckMicros, {
      providers: ['fal', 'openrouter'],
    });
  } catch (error) {
    if (!(error instanceof OpenStoryError)) throw error;
    blockers.push({ code: error.code, message: error.message });
  }
  const row = await scopedDb.generationPlans.create({
    sequenceId,
    actorId: actor.userId,
    request,
    digest: await planDigest(request, built),
    estimateMicros,
    work,
    expiresAt: new Date(Date.now() + PLAN_TTL_MS),
  });
  return {
    planId: row.id,
    sequenceId,
    digest: row.digest,
    expiresAt: row.expiresAt.toISOString(),
    estimate: {
      micros: estimateMicros,
      usd: estimateMicros === null ? null : estimateMicros / 1e6,
    },
    work,
    blockers,
  };
}

function operationOf(row: GenerationPlanRow) {
  return {
    operationId: row.id,
    sequenceId: row.sequenceId,
    status: row.status,
    workflowRunIds: row.workflowRunIds,
    pollAfterSeconds: OPERATION_POLL_SECONDS,
  };
}

async function ownPlan(
  scopedDb: ScopedDb,
  sequenceId: string,
  planId: string
): Promise<GenerationPlanRow> {
  await productionAccess(scopedDb).sequence(sequenceId);
  const row = await scopedDb.generationPlans.getById(planId);
  if (!row || row.sequenceId !== sequenceId) {
    throw new NotFoundError('Plan not found for this sequence');
  }
  return row;
}

/** The mutex refusals are plain Errors; give them a code the agent can act on. */
async function rejectActiveRun(scopedDb: ScopedDb, sequenceId: string) {
  try {
    await getSequenceRejectingActiveRun(scopedDb, sequenceId);
  } catch (error) {
    if (error instanceof OpenStoryError) throw error;
    throw new OpenStoryError(
      error instanceof Error ? error.message : String(error),
      'GENERATION_IN_PROGRESS',
      409
    );
  }
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by planGeneration from a GenerationRequest
const requestOf = (row: GenerationPlanRow) => row.request as GenerationRequest;

export async function executeGeneration(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  planId: string
) {
  const row = await ownPlan(scopedDb, sequenceId, planId);
  if (row.actorId !== actor.userId) {
    throw new NotFoundError('Plan not found for this sequence');
  }
  const request = requestOf(row);

  if (
    row.status === 'executing' &&
    row.workflowRunIds.length === 0 &&
    request.mode === 'stale'
  ) {
    // A lost Update all dispatch is re-sent with the same run key: the
    // trigger reuses a live or finished instance, so nothing runs twice. A
    // lost Continue dispatch is not (its mutex claim id is per call).
    const lost = await scopedDb.generationPlans.reclaimLostDispatch(
      planId,
      new Date(Date.now() - DISPATCH_GRACE_MS)
    );
    if (!lost) return operationOf(row);
    const { plan } = await buildPlan(scopedDb, actor, sequenceId, request);
    return launch(scopedDb, actor, lost, request, plan);
  }
  // Already executed (or executing): the same operation, never a relaunch.
  if (row.status !== 'planned') return operationOf(row);
  if (row.expiresAt.getTime() < Date.now()) {
    throw new OpenStoryError(
      'This plan expired. Call plan_generation again and approve the new plan.',
      'PLAN_EXPIRED',
      409
    );
  }
  const built = await buildPlan(scopedDb, actor, sequenceId, request);
  if ((await planDigest(request, built)) !== row.digest) {
    throw new ConflictError(
      'The work changed since it was planned. Call plan_generation again and approve the new plan.',
      { code: 'PLAN_CHANGED' }
    );
  }
  if (!hasWork(built.plan)) throw new ValidationError('Nothing to generate.');
  // Refusals before the claim leave the plan executable.
  await rejectActiveRun(scopedDb, sequenceId);
  await requireCredits(scopedDb, built.creditCheckMicros, {
    providers: ['fal', 'openrouter'],
  });

  const claimed = await scopedDb.generationPlans.claimExecution(planId);
  if (!claimed) {
    return operationOf((await scopedDb.generationPlans.getById(planId)) ?? row);
  }
  return launch(scopedDb, actor, claimed, request, built.plan, built);
}

async function launch(
  scopedDb: ScopedDb,
  actor: Actor,
  row: GenerationPlanRow,
  request: GenerationRequest,
  plan: UpdateStalePlan,
  built?: { sequence: Sequence; stopAt?: GenerationStage }
) {
  let workflowRunId: string;
  try {
    if (request.mode === 'stale') {
      workflowRunId = await launchUpdateStale({
        userId: actor.userId,
        teamId: actor.teamId,
        sequenceId: row.sequenceId,
        plan,
        runKey: `${row.sequenceId}-plan-${row.id}`,
      });
    } else {
      const sequence =
        built?.sequence ??
        (await productionAccess(scopedDb).sequence(row.sequenceId));
      ({ workflowRunId } = await triggerContinue(scopedDb, {
        userId: actor.userId,
        teamId: actor.teamId,
        sequence,
        plan,
        stopAt: built?.stopAt ?? request.stopAt,
      }));
    }
  } catch (error) {
    // Only a launch that threw is a failed dispatch.
    await scopedDb.generationPlans.markDispatchFailed(
      row.id,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  // Outside the try: a bookkeeping failure must not mark a live run failed.
  await scopedDb.generationPlans.addRun(row.id, workflowRunId);
  await scopedDb.generationPlans.markLaunched(row.id);
  return operationOf({
    ...row,
    status: 'launched',
    workflowRunIds: [workflowRunId],
  });
}

/**
 * One operation's state, from its own run — not a sequence aggregate.
 * Terminal: `completed`, `partially_failed`, `failed`, `dispatch_failed`,
 * `dispatch_unknown`, `unknown` (no readable outcome a day after launch).
 */
export async function getOperationStatus(
  scopedDb: ScopedDb,
  sequenceId: string,
  operationId: string
) {
  const row = await ownPlan(scopedDb, sequenceId, operationId);
  const targeted = generationWorkSchema.parse(row.work);
  const base = { ...operationOf(row), targeted };
  const done = (state: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    state,
    terminal: true,
    ...extra,
  });
  const pending = (state: string) => ({ ...base, state, terminal: false });
  const executedMs = row.executedAt?.getTime() ?? 0;
  const stale = requestOf(row).mode === 'stale';

  if (row.status === 'planned') return pending('not_started');
  if (row.status === 'dispatch_failed') {
    return done('dispatch_failed', { error: row.error });
  }
  const [runId] = row.workflowRunIds;
  if (!runId) {
    if (Date.now() - executedMs <= DISPATCH_GRACE_MS) {
      return pending('dispatching');
    }
    // Update all re-sends safely: call execute_generation again.
    if (stale) return pending('dispatch_lost');
    return done('dispatch_unknown', {
      error:
        'The launch was not confirmed and is not retried. Check get_sequence_status, then plan again if the work is still owed.',
    });
  }
  const run = stale
    ? await readUpdateStaleRun(sequenceId, runId)
    : await getWorkflowRunOutcome(runId);
  if (run.state === 'running') return pending('running');
  if (run.state === 'failed') return done('failed', { error: run.error });
  if (run.state === 'unknown') {
    return Date.now() - executedMs > UNKNOWN_GIVE_UP_MS
      ? done('unknown')
      : pending('unknown');
  }
  if ('result' in run) {
    const { failures, skipped } = run.result;
    return done(failures.length > 0 ? 'partially_failed' : 'completed', {
      result: run.result,
      failures,
      skipped,
    });
  }
  // A Continue run reports run-level success; its targets' own failures are
  // read from their current state.
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const targets = new Set(targeted.targetShotIds);
  const failures = (
    (await readProductionStatus(scopedDb, sequence, true)).failures ?? []
  ).flatMap((f) =>
    f.shotId && targets.has(f.shotId)
      ? [{ shotId: f.shotId, stage: f.stage, error: f.error ?? 'failed' }]
      : []
  );
  return done(failures.length > 0 ? 'partially_failed' : 'completed', {
    failures,
  });
}
