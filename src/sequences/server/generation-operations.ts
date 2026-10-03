/**
 * Agent plans, replay-safe execution and operation status (#1460, #1461).
 * The MCP tools are thin adapters over these functions.
 *
 * Planning reuses the editor's planners with no generation side effects:
 * - `stale`: Update all (`planUpdateAll`) up to a depth, for the sequence, a
 *   list of scenes or a list of shots. Never a first render.
 * - `missing`: Continue (`continueFromPlan` → `computePlan`) up to a stop,
 *   for the whole sequence, with its current switches and models.
 * - `retry`: smart retry of failed work (`executeSmartRetry` dry run), or the
 *   full storyboard it falls back to when that is the only way to recover.
 *
 * Nothing is stored. A plan is a token the agent hands back: the request, a
 * digest of what will run and what it costs, and a random key. Execute
 * re-plans from live D1, requires the same digest, rejects a live run and a
 * short balance, then launches through the editor's own launchers with the
 * key as the runs' deduplication id. A repeated execute of the same token
 * re-triggers with the same ids and gets the same runs back: no second
 * launch, no second spend. Once the launched work has moved the sequence on,
 * the re-plan no longer matches and the repeat is `PLAN_CHANGED`.
 *
 * Status reads the runs an execute returned, never a stored operation.
 */

import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  OpenStoryError,
  ValidationError,
} from '@/platform/errors';
import { base64ToBytes, bytesToBase64 } from '@/platform/base64';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { getWorkflowRunOutcome } from '@/platform/server/workflow/run-outcome';
import { workflowNameFromRunId } from '@/platform/server/workflow/trigger-bindings';
import { requireCredits, type Provider } from '@/billing/server/preflight';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import type { Microdollars } from '@/billing/money';
import { sha256Hex } from '@/shots/input-hash';
import { computePlan } from '@/shots/server/update-stale-plan';
import type { UpdateStalePlan } from '@/shots/server/update-stale-plan';
import { buildUpdateStalePreview } from '@/shots/server/update-stale-preview';
import {
  launchUpdateStale,
  prepareUpdateStale,
  UPDATE_STALE_CREDIT_PROVIDERS,
  readUpdateStaleRun,
} from '@/shots/server/update-stale-run';
import { UPDATE_STALE_DEPTHS } from '@/shots/update-stale-depth';
import { GENERATION_STAGES } from '@/sequences/pipeline';
import { productionAccess } from './production-access';
import { computeGenerationPlan } from './generation-plan';
import { CONTINUE_CREDIT_PROVIDERS, prepareContinue } from './continue-plan';
import {
  GenerationInProgressError,
  GenerationStatusUnknownError,
  triggerContinue,
} from './launchers';
import { readProductionStatus } from './production-status';
import { executeSmartRetry } from './smart-retry';
import { previewExport, resolveExportCut, startExport } from './export';

/** Suggested polling interval for get_operation_status. */
const OPERATION_POLL_SECONDS = 15;

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sequence') }),
  z.object({ kind: z.literal('scenes'), sceneIds: z.array(z.string()) }),
  z.object({ kind: z.literal('shots'), shotIds: z.array(z.string()) }),
]);
const requestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('stale'),
    depth: z.enum(UPDATE_STALE_DEPTHS),
    target: targetSchema,
  }),
  z.object({
    mode: z.literal('missing'),
    stopAt: z.enum(GENERATION_STAGES),
    target: targetSchema,
  }),
  z.object({
    mode: z.literal('retry'),
    retry: z.enum(['smart', 'full_if_required']),
  }),
]);
export type GenerationRequest = z.infer<typeof requestSchema>;
type GenerationTarget = z.infer<typeof targetSchema>;

/**
 * What `plan_generation` hands the agent and `execute_generation` takes
 * back. Unsigned on purpose: it can only name work the holder could plan
 * directly, and execute re-plans and re-checks everything it says.
 */
const planTokenSchema = z.object({
  v: z.literal(1),
  sequenceId: z.string(),
  request: requestSchema,
  digest: z.string(),
  /** Random per plan; the launched runs are deduplicated on it. */
  key: z.string().min(1),
});
type PlanToken = z.infer<typeof planTokenSchema>;

function encodePlanToken(token: PlanToken): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(token)), {
    alphabet: 'base64url',
  });
}

function decodePlanToken(encoded: string, sequenceId: string): PlanToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(
        base64ToBytes(encoded, { alphabet: 'base64url' })
      )
    );
  } catch {
    parsed = null;
  }
  const token = planTokenSchema.safeParse(parsed);
  if (!token.success) {
    throw new ValidationError(
      'Not a plan token. Pass the planToken from plan_generation or retry_failed_work.'
    );
  }
  if (token.data.sequenceId !== sequenceId) {
    throw new NotFoundError('Plan not found for this sequence');
  }
  return token.data;
}

type Actor = { userId: string; teamId: string };

const shotList = z.array(z.string());
/** What a stale/missing plan does, per stage. */
const generationWorkSchema = z.object({
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
/** What a retry plan starts; `full` is the storyboard fallback, made visible. */
const retryWorkSchema = z.object({
  retryType: z.enum(['smart', 'full']),
  images: z.array(z.object({ shotId: z.string(), model: z.string() })),
  motion: z.array(z.object({ shotId: z.string(), model: z.string() })),
  music: z.boolean(),
  musicPrompt: z.boolean(),
});
/** Every plan's work. */
export const planWorkSchema = z.union([generationWorkSchema, retryWorkSchema]);
type PlanWork = z.infer<typeof planWorkSchema>;

/**
 * One request, prepared: what it would do and cost, and how to launch it.
 * The digest material is the part that must not move between plan and run.
 */
type Prepared = {
  sequence: Sequence;
  digestMaterial: unknown;
  /** For display and the digest; null when a component has no price. */
  estimateMicros: Microdollars | null;
  /** What the balance must cover: the known parts, never skipped. */
  creditCheckMicros: Microdollars;
  /** Whose keys waive the check; the editor's rule for the same run. */
  creditProviders: readonly Provider[];
  hasWork: boolean;
  /** A live storyboard run blocks it; reported by plan, refused by execute. */
  needsIdleSequence: boolean;
  work: () => Promise<PlanWork>;
  /**
   * Start the work under `runKey` (deduplication id), reporting each run as
   * it starts so a throw part-way still names the runs that did.
   */
  launch: (
    runKey: string,
    onLaunched: (workflowRunId: string) => Promise<void>
  ) => Promise<void>;
};

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
 * What runs and what it costs, without display fields: every target (ids,
 * flags, pinned versions, input hashes, models), music, skips and the
 * render-affecting sequence settings.
 */
function planMaterial(plan: UpdateStalePlan) {
  return {
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
  };
}

/** Update all / Continue: freeze the plan and price it as the editor does. */
async function prepareGeneration(
  scopedDb: ScopedDb,
  actor: Actor,
  sequence: Sequence,
  request: Extract<GenerationRequest, { mode: 'stale' | 'missing' }>
): Promise<Prepared> {
  const shotIds = await shotIdsFor(scopedDb, sequence.id, request.target);
  const inFlight = async () => [
    ...new Set(
      (await computeGenerationPlan(scopedDb, sequence.id))
        .filter(
          (u) => u.state === 'running' && (!shotIds || shotIds.includes(u.id))
        )
        .map((u) => u.id)
    ),
  ];
  const hasWork = (plan: UpdateStalePlan) =>
    plan.targets.length > 0 ||
    (plan.music !== null && (plan.music.regenPrompt || plan.music.regenTrack));

  if (request.mode === 'stale') {
    // The editor's own gate and plan: processing check and credit floor.
    const { plan, creditFloorMicros } = await prepareUpdateStale({
      scopedDb,
      userId: actor.userId,
      sequence,
      depth: request.depth,
      shotIds,
    });
    const estimateMicros = buildUpdateStalePreview(
      plan,
      await getEffectiveFalPricing(),
      sequence.musicModel
    ).costByLevel[request.depth];
    return {
      sequence,
      digestMaterial: planMaterial(plan),
      estimateMicros,
      // The editor's rule: the floor, not the estimate.
      creditCheckMicros: creditFloorMicros,
      creditProviders: UPDATE_STALE_CREDIT_PROVIDERS,
      hasWork: hasWork(plan),
      needsIdleSequence: false,
      work: async () => summarize(plan, await inFlight()),
      launch: async (runKey, onLaunched) => {
        await onLaunched(
          await launchUpdateStale({
            userId: actor.userId,
            teamId: actor.teamId,
            sequenceId: sequence.id,
            plan,
            runKey,
          })
        );
      },
    };
  }

  if (request.target.kind !== 'sequence') {
    throw new ValidationError(
      'mode "missing" (Continue) plans the whole sequence. Omit sceneIds/shotIds, or use mode "stale" for scenes or shots.'
    );
  }
  // The editor's gate and work list, with the switches as saved.
  const { work, stopAt, estimate } = await prepareContinue({
    scopedDb,
    sequence,
    stopAt: request.stopAt,
    requested: {
      generateStartFrames: sequence.generateStartFrames,
      generateVoices: sequence.generateVoices,
    },
    draftMotion: sequence.draftMotion,
  });
  const plan = await computePlan({
    scopedDb,
    sequenceId: sequence.id,
    units: work.map(({ kind, id }) => ({ kind, id })),
    userId: actor.userId,
  });
  return {
    sequence,
    digestMaterial: { ...planMaterial(plan), stopAt },
    estimateMicros: estimate.priced ? estimate.micros : null,
    // The editor checks the partial sum when a part has no price; so do we.
    creditCheckMicros: estimate.micros,
    creditProviders: CONTINUE_CREDIT_PROVIDERS,
    hasWork: hasWork(plan),
    // prepareContinue refused a running sequence; execute re-prepares.
    needsIdleSequence: false,
    work: async () => summarize(plan, await inFlight()),
    // The storyboard mutex is the launch-once guard here: a repeat while the
    // run is live is GENERATION_IN_PROGRESS, and after it PLAN_CHANGED.
    launch: async (_runKey, onLaunched) => {
      const { workflowRunId } = await triggerContinue(scopedDb, {
        userId: actor.userId,
        teamId: actor.teamId,
        sequence,
        plan,
        stopAt,
      });
      await onLaunched(workflowRunId);
    },
  };
}

/** Smart retry, planned by a dry run of the same code that launches it. */
async function prepareRetry(
  scopedDb: ScopedDb,
  actor: Actor,
  sequence: Sequence,
  request: Extract<GenerationRequest, { mode: 'retry' }>
): Promise<Prepared> {
  const context = {
    sequence,
    user: { id: actor.userId },
    teamId: actor.teamId,
    scopedDb,
  };
  const smartOnly = request.retry === 'smart';
  const { planned } = await executeSmartRetry(context, {
    dryRun: true,
    smartOnly,
  });
  const { estimateMicros, ...work } = planned;
  return {
    sequence,
    digestMaterial: planned,
    estimateMicros,
    creditCheckMicros: estimateMicros,
    creditProviders: ['fal', 'openrouter'],
    hasWork: true,
    needsIdleSequence: true,
    work: async () => work,
    launch: async (runKey, onLaunched) => {
      await executeSmartRetry(context, { smartOnly, onLaunched, runKey });
    },
  };
}

/** The mutex refusals are plain Errors; give them a code the agent can act on. */
async function withRunCodes<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof GenerationInProgressError ||
      error instanceof GenerationStatusUnknownError
    ) {
      throw new OpenStoryError(error.message, 'GENERATION_IN_PROGRESS', 409);
    }
    throw error;
  }
}

async function prepare(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  request: GenerationRequest
): Promise<Prepared> {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  return withRunCodes(() =>
    request.mode === 'retry'
      ? prepareRetry(scopedDb, actor, sequence, request)
      : prepareGeneration(scopedDb, actor, sequence, request)
  );
}

/**
 * Binds the request, what runs, its estimate. Dates are left out and
 * `undefined` optionals dropped, so a touched timestamp does not change it.
 * Live pricing is in the estimate, so a price change fails the compare too.
 */
function digestOf(request: GenerationRequest, prepared: Prepared) {
  const material = JSON.stringify(
    {
      request,
      material: prepared.digestMaterial,
      estimateMicros: prepared.estimateMicros,
    },
    function (this: Record<string, unknown>, key: string, value: unknown) {
      return this[key] instanceof Date ? undefined : value;
    }
  );
  return sha256Hex(JSON.parse(material));
}

async function checkCredits(
  scopedDb: ScopedDb,
  prepared: Pick<Prepared, 'creditCheckMicros' | 'creditProviders'>
) {
  if (prepared.creditCheckMicros > 0) {
    await requireCredits(scopedDb, prepared.creditCheckMicros, {
      providers: [...prepared.creditProviders],
    });
  }
}

export async function planGeneration(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  request: GenerationRequest
) {
  const prepared = await prepare(scopedDb, actor, sequenceId, request);
  const work = await prepared.work();
  const blockers: { code: string; message: string }[] = [];
  if (prepared.needsIdleSequence && prepared.sequence.status === 'processing') {
    blockers.push({
      code: 'GENERATION_IN_PROGRESS',
      message: 'A run is generating this sequence; execute after it finishes.',
    });
  }
  if (!prepared.hasWork) {
    blockers.push({ code: 'NOTHING_TO_DO', message: 'Nothing to generate.' });
  }
  // Reported, not thrown: funds can still change before execute.
  try {
    await checkCredits(scopedDb, prepared);
  } catch (error) {
    if (!(error instanceof OpenStoryError)) throw error;
    blockers.push({ code: error.code, message: error.message });
  }
  const digest = await digestOf(request, prepared);
  // Short enough to fit the instance-id limit behind the sequence id and a
  // hashed shot id; 48 random bits is plenty for one sequence's plans.
  const key = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  return {
    planToken: encodePlanToken({ v: 1, sequenceId, request, digest, key }),
    sequenceId,
    digest,
    estimate: {
      micros: prepared.estimateMicros,
      usd:
        prepared.estimateMicros === null ? null : prepared.estimateMicros / 1e6,
    },
    work,
    blockers,
  };
}

/**
 * Execute an approved plan. The runs are keyed on the token, so a repeat
 * re-triggers the same ids and gets the same runs back, never a second
 * launch; once that work has moved the sequence on, the repeat is
 * `PLAN_CHANGED` and the agent checks the sequence instead.
 */
export async function executeGeneration(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  planToken: string
) {
  const token = decodePlanToken(planToken, sequenceId);
  const { request } = token;
  const prepared = await prepare(scopedDb, actor, sequenceId, request);
  if ((await digestOf(request, prepared)) !== token.digest) {
    throw new ConflictError(
      'The work changed since it was planned — or an earlier call already started it. Check get_sequence_status; if work is still owed, plan it again and approve the new plan.',
      { code: 'PLAN_CHANGED' }
    );
  }
  if (!prepared.hasWork) throw new ValidationError('Nothing to generate.');
  if (prepared.needsIdleSequence && prepared.sequence.status === 'processing') {
    throw new OpenStoryError(
      'A run is generating this sequence; execute after it finishes.',
      'GENERATION_IN_PROGRESS',
      409
    );
  }
  await checkCredits(scopedDb, prepared);

  // Every run this plan starts carries the sequence id (status requires it
  // before reading a caller-supplied run id) and the plan's key.
  const workflowRunIds: string[] = [];
  try {
    await withRunCodes(() =>
      prepared.launch(`${sequenceId}-plan-${token.key}`, async (runId) => {
        workflowRunIds.push(runId);
      })
    );
  } catch (error) {
    // The runs that did start are running and paid for: name them, so the
    // agent polls them instead of planning the same work again.
    if (workflowRunIds.length > 0 && error instanceof Error) {
      throw new OpenStoryError(
        `${error.message} Runs that did start: ${workflowRunIds.join(', ')}. Poll them with get_operation_status; do not plan the same work again.`,
        'LAUNCH_INCOMPLETE',
        409,
        { workflowRunIds }
      );
    }
    throw error;
  }
  return {
    sequenceId,
    workflowRunIds,
    pollAfterSeconds: OPERATION_POLL_SECONDS,
  };
}

/**
 * The state of the runs an execute returned — not a sequence aggregate.
 * Terminal: `completed`, `partially_failed`, `failed`. Not terminal:
 * `running`, and `unknown` (a run could not be read; keep polling, and
 * check get_sequence_status if it stays unknown).
 */
export async function getOperationStatus(
  scopedDb: ScopedDb,
  sequenceId: string,
  workflowRunIds: string[]
) {
  const sequence = await productionAccess(scopedDb).sequence(sequenceId);
  // The ids are caller-supplied: every run this feature starts embeds the
  // sequence id, so anything else is not this sequence's run.
  for (const runId of workflowRunIds) {
    if (!runId.includes(sequenceId)) {
      throw new NotFoundError('Run not found for this sequence');
    }
  }
  const runs = await Promise.all(
    workflowRunIds.map((runId) =>
      workflowNameFromRunId(runId) === 'update-stale-shots'
        ? readUpdateStaleRun(sequenceId, runId)
        : getWorkflowRunOutcome(runId)
    )
  );
  const base = {
    sequenceId,
    workflowRunIds,
    pollAfterSeconds: OPERATION_POLL_SECONDS,
  };
  if (runs.some((r) => r.state === 'running')) {
    return { ...base, state: 'running', terminal: false };
  }
  if (runs.some((r) => r.state === 'unknown')) {
    return { ...base, state: 'unknown', terminal: false };
  }
  const errors = runs.flatMap((r) => (r.state === 'failed' ? [r.error] : []));
  if (errors.length === runs.length) {
    return {
      ...base,
      state: 'failed',
      terminal: true,
      error: errors.join('; '),
    };
  }
  // Update all reports its own per-shot outcome. Continue and retry runs
  // report run-level success; what is failed on the sequence now is listed
  // so the agent can plan a retry for it.
  const results = runs.flatMap((r) => ('result' in r ? [r.result] : []));
  const failures =
    results.length > 0
      ? results.flatMap((r) => r.failures)
      : (
          (await readProductionStatus(scopedDb, sequence, true)).failures ?? []
        ).flatMap((f) =>
          f.shotId
            ? [{ shotId: f.shotId, stage: f.stage, error: f.error ?? 'failed' }]
            : []
        );
  const skipped = results.flatMap((r) => r.skipped);
  return {
    ...base,
    state:
      failures.length > 0 || errors.length > 0
        ? 'partially_failed'
        : 'completed',
    terminal: true,
    failures,
    skipped,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}

/**
 * Export (#1461): what starting an export of the current cut would do, and
 * starting it. Exports spend no credits and `startExport` already reuses a
 * ready MP4 of the cut or joins its live render, so there is no plan to
 * approve — only a live render of a DIFFERENT cut is refused here (REST
 * joins it), since joining it would hand back an MP4 without the latest
 * edits.
 */
export async function planExport(scopedDb: ScopedDb, sequenceId: string) {
  const cut = await resolveExportCut(scopedDb, sequenceId);
  return {
    sequenceId,
    sourceShotsHash: cut.sourceShotsHash,
    ...(await previewExport(scopedDb, sequenceId, cut)),
  };
}

export async function startExportOperation(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string
) {
  const cut = await resolveExportCut(scopedDb, sequenceId);
  const preview = await previewExport(scopedDb, sequenceId, cut);
  if (preview.action === 'busy_other_cut') {
    throw new OpenStoryError(
      'An export of an earlier cut is rendering; start this one after it finishes.',
      'EXPORT_BUSY',
      409
    );
  }
  const { row, workflowRunId } = await startExport(scopedDb, {
    userId: actor.userId,
    teamId: actor.teamId,
    sequenceId,
    cut,
  });
  return {
    sequenceId,
    exportId: row.id,
    status: row.status,
    action: preview.action,
    workflowRunId,
  };
}
