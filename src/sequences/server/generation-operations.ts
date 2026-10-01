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
 * The plan row stores a digest of the frozen plan, its estimate and what it
 * targets. Execute re-plans from live D1, requires the same digest (a moved
 * selection, model or target changes it; an unrelated timestamp does not),
 * rechecks the balance, then takes the row `planned` → `executing` in one
 * guarded UPDATE before launching through the editor's launchers. A repeated
 * or concurrent execute finds the row taken and returns the same operation:
 * no second launch, no second spend. A lost dispatch (`executing` with no run
 * id) is reported, never relaunched.
 */

import {
  ConflictError,
  NotFoundError,
  OpenStoryError,
  ValidationError,
} from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GenerationPlanRow } from '@/platform/server/db/schema';
import { getWorkflowRunOutcome } from '@/platform/server/workflow/run-outcome';
import { requireCredits } from '@/billing/server/preflight';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import type { Microdollars } from '@/billing/money';
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
import { triggerContinue } from './launchers';

/** How long an approved plan may wait before execute refuses it. */
const PLAN_TTL_MS = 30 * 60 * 1000;
/** Suggested polling interval for get_operation_status. */
const OPERATION_POLL_SECONDS = 15;
/** An `executing` row older than this with no run id lost its dispatch. */
const DISPATCH_GRACE_MS = 2 * 60 * 1000;

type GenerationTarget =
  | { kind: 'sequence' }
  | { kind: 'scenes'; sceneIds: string[] }
  | { kind: 'shots'; shotIds: string[] };

export type GenerationRequest =
  | { mode: 'stale'; depth: UpdateStaleDepth; target: GenerationTarget }
  | { mode: 'missing'; stopAt: GenerationStage; target: GenerationTarget };

type Actor = { userId: string; teamId: string };

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

/** Freeze the plan and price it, exactly as the editor would. */
async function buildPlan(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  request: GenerationRequest
): Promise<{
  plan: UpdateStalePlan;
  estimateMicros: Microdollars | null;
  inFlightShotIds: string[];
  /** Continue's effective stop (it can move past a switch lock). */
  stopAt?: GenerationStage;
}> {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  const shotIds = await shotIdsFor(scopedDb, sequence.id, request.target);
  const generationPlan = await computeGenerationPlan(scopedDb, sequence.id);
  const inScope = (id: string) => !shotIds || shotIds.includes(id);
  const inFlightShotIds = [
    ...new Set(
      generationPlan
        .filter((u) => u.state === 'running' && inScope(u.id))
        .map((u) => u.id)
    ),
  ];

  if (request.mode === 'stale') {
    const plan = await planUpdateAll({
      scopedDb,
      sequenceId: sequence.id,
      shotIds,
      depth: request.depth,
      userId: actor.userId,
    });
    const preview = buildUpdateStalePreview(
      plan,
      await getEffectiveFalPricing(),
      sequence.musicModel
    );
    return {
      plan,
      estimateMicros: preview.costByLevel[request.depth],
      inFlightShotIds,
    };
  }

  if (request.target.kind !== 'sequence') {
    throw new ValidationError(
      'mode "missing" (Continue) plans the whole sequence. Use target {"kind":"sequence"}, or mode "stale" for scenes or shots.'
    );
  }
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
    plan,
    stopAt,
    estimateMicros: estimate.priced ? estimate.micros : null,
    inFlightShotIds,
  };
}

/** What the plan does, per stage, for the agent to show and for polling. */
function summarize(plan: UpdateStalePlan, inFlightShotIds: string[]) {
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
 * The digest binds everything that changes what runs or what it costs:
 * the request, the frozen plan (ids, flags, pinned versions, input hashes,
 * models) and the estimate. Dates are left out, so a touched timestamp does
 * not change it.
 */
function planDigest(
  request: GenerationRequest,
  built: Pick<
    Awaited<ReturnType<typeof buildPlan>>,
    'plan' | 'estimateMicros' | 'stopAt'
  >
) {
  const material = JSON.stringify(
    {
      request,
      plan: built.plan,
      estimateMicros: built.estimateMicros,
      stopAt: built.stopAt ?? null,
    },
    // Timestamps are not what runs; `undefined` optionals are dropped.
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
  const { plan, estimateMicros, inFlightShotIds } = built;
  const work = summarize(plan, inFlightShotIds);
  const blockers: { code: string; message: string }[] = [];
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  if (sequence.status === 'processing') {
    blockers.push({
      code: 'GENERATION_IN_PROGRESS',
      message: 'A run is generating this sequence; execute after it finishes.',
    });
  }
  if (!hasWork(plan)) {
    blockers.push({ code: 'NOTHING_TO_DO', message: 'Nothing to generate.' });
  }
  if (estimateMicros !== null) {
    // Reported, not thrown: funds can still change before execute.
    try {
      await requireCredits(scopedDb, estimateMicros, {
        providers: ['fal', 'openrouter'],
      });
    } catch (error) {
      if (!(error instanceof OpenStoryError)) throw error;
      blockers.push({ code: error.code, message: error.message });
    }
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
    request,
    digest: row.digest,
    expiresAt: row.expiresAt.toISOString(),
    estimate: {
      micros: estimateMicros,
      usd: estimateMicros === null ? null : Number(estimateMicros) / 1e6,
      complete: estimateMicros !== null,
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
    workflowRunIds: row.workflowRunId ? [row.workflowRunId] : [],
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
  // Already executed (or executing): the same operation, never a relaunch.
  if (row.status !== 'planned') return operationOf(row);
  if (row.expiresAt.getTime() < Date.now()) {
    throw new OpenStoryError(
      'This plan expired. Call plan_generation again and approve the new plan.',
      'PLAN_EXPIRED',
      409
    );
  }
  // The request is the one this row was planned with.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by planGeneration from a GenerationRequest
  const request = row.request as GenerationRequest;
  const built = await buildPlan(scopedDb, actor, sequenceId, request);
  const { plan, estimateMicros } = built;
  if ((await planDigest(request, built)) !== row.digest) {
    throw new ConflictError(
      'The work changed since it was planned. Call plan_generation again and approve the new plan.',
      { code: 'PLAN_CHANGED' }
    );
  }
  if (!hasWork(plan)) throw new ValidationError('Nothing to generate.');
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  if (sequence.status === 'processing') {
    throw new ValidationError(
      'This sequence is still generating — execute after the run finishes.'
    );
  }
  if (estimateMicros !== null) {
    await requireCredits(scopedDb, estimateMicros, {
      providers: ['fal', 'openrouter'],
    });
  }

  const claimed = await scopedDb.generationPlans.claimExecution(planId);
  if (!claimed) {
    const current = await scopedDb.generationPlans.getById(planId);
    if (!current) throw new NotFoundError('Plan not found for this sequence');
    return operationOf(current);
  }
  try {
    const workflowRunId =
      request.mode === 'stale'
        ? await launchUpdateStale({
            userId: actor.userId,
            teamId: actor.teamId,
            sequenceId,
            plan,
            runKey: `${sequenceId}-plan-${planId}`,
          })
        : (
            await triggerContinue(scopedDb, {
              userId: actor.userId,
              teamId: actor.teamId,
              sequence,
              plan,
              stopAt: built.stopAt ?? request.stopAt,
            })
          ).workflowRunId;
    await scopedDb.generationPlans.markLaunched(planId, workflowRunId);
    return operationOf({ ...claimed, status: 'launched', workflowRunId });
  } catch (error) {
    await scopedDb.generationPlans.markDispatchFailed(
      planId,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

/**
 * One operation's state, from its own run — not a sequence aggregate.
 * Terminal states: `completed`, `partially_failed`, `failed`,
 * `dispatch_failed`, `dispatch_unknown`.
 */
export async function getOperationStatus(
  scopedDb: ScopedDb,
  sequenceId: string,
  operationId: string
) {
  const row = await ownPlan(scopedDb, sequenceId, operationId);
  const base = { ...operationOf(row), targeted: row.work };
  const done = (state: string, extra: Record<string, unknown> = {}) => ({
    ...base,
    state,
    terminal: true,
    ...extra,
  });
  const pending = (state: string) => ({ ...base, state, terminal: false });

  if (row.status === 'planned') return pending('not_started');
  if (row.status === 'dispatch_failed') {
    return done('dispatch_failed', { error: row.error });
  }
  if (!row.workflowRunId) {
    const since = row.executedAt?.getTime() ?? 0;
    return Date.now() - since > DISPATCH_GRACE_MS
      ? done('dispatch_unknown', {
          error:
            'The launch was not confirmed. It is not retried automatically: check get_sequence_status, then plan again if the work is still owed.',
        })
      : pending('dispatching');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by planGeneration from a GenerationRequest
  const request = row.request as GenerationRequest;
  if (request.mode === 'stale') {
    const run = await readUpdateStaleRun(sequenceId, row.workflowRunId);
    if (run.state === 'running') return pending('running');
    if (run.state === 'failed') return done('failed', { error: run.error });
    if (run.state === 'unknown') return pending('unknown');
    const { failures, skipped } = run.result;
    return done(failures.length > 0 ? 'partially_failed' : 'completed', {
      result: run.result,
      failures,
      skipped,
    });
  }
  const outcome = await getWorkflowRunOutcome(row.workflowRunId);
  if (outcome.state === 'running') return pending('running');
  if (outcome.state === 'failed')
    return done('failed', { error: outcome.error });
  if (outcome.state === 'unknown') return pending('unknown');
  return done('completed');
}
