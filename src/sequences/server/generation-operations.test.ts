/**
 * Agent plan → execute → status (#1460) on migrated SQLite, so sequence,
 * scene and shot access is the real team scope. The editor's planners,
 * pricing, credit check and launchers are mocked: their behaviour has its
 * own tests; these pin the contract around them.
 */

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
// oxlint-disable-next-line boundaries/no-raw-db -- substitute the isolated in-memory DB at the factory boundary
import { getDb } from '#db-client';
import type { Database } from '@/platform/server/db/client';
import { relations } from '@/platform/server/db/schema/relations';
import {
  scenes,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
// oxlint-disable-next-line boundaries/no-scoped-factory -- exercise the real team scope, not mocked authorization
import { createScopedDb } from '@/platform/server/db/scoped';
import { dbSceneId } from '@/shots/scene-id';
import { asStub } from '@/test/as-stub';
import type { UpdateStalePlan } from '@/shots/server/update-stale-plan';
import { InsufficientCreditsError } from '@/platform/errors';

vi.mock('#db-client', () => ({ getDb: vi.fn() }));

const planUpdateAll = vi.fn();
const computePlan = vi.fn();
const launchUpdateStale = vi.fn();
const readUpdateStaleRun = vi.fn();
const getWorkflowRunOutcome = vi.fn();
const triggerContinue = vi.fn();
const requireCredits = vi.fn();
const continueFromPlan = vi.fn();
vi.doMock('@/shots/server/update-stale-plan', () => ({
  planUpdateAll,
  computePlan,
}));
vi.doMock('@/sequences/server/generation-plan', () => ({
  computeGenerationPlan: vi.fn(async () => []),
}));
vi.doMock('@/shots/server/update-stale-preview', () => ({
  buildUpdateStalePreview: () => ({ costByLevel: { images: 2_500_000 } }),
}));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
vi.doMock('@/billing/server/preflight', () => ({ requireCredits }));
vi.doMock('@/platform/server/workflow/run-outcome', () => ({
  getWorkflowRunOutcome,
}));
const getSequenceRejectingActiveRun = vi.fn();
const readProductionStatus = vi.fn();
const realLaunchers =
  await vi.importActual<typeof import('./launchers')>('./launchers');
vi.doMock('./launchers', () => ({
  ...realLaunchers,
  triggerContinue,
  getSequenceRejectingActiveRun,
}));
vi.doMock('./production-status', () => ({ readProductionStatus }));
const executeSmartRetry = vi.fn();
vi.doMock('./smart-retry', () => ({ executeSmartRetry }));
const resolveExportCut = vi.fn();
const previewExport = vi.fn();
const startExport = vi.fn();
vi.doMock('./export', () => ({ resolveExportCut, previewExport, startExport }));
vi.doMock('@/billing/cost-estimation', () => ({
  estimateImageCost: () => 400_000,
  gateEstimate: (micros: number) => micros,
}));
// prepareContinue is the lock check, the work list and the estimate.
vi.doMock('./continue-plan', () => ({
  CONTINUE_CREDIT_PROVIDERS: ['fal', 'openrouter'],
  prepareContinue: vi.fn(
    async (args: { sequence: { id: string }; stopAt: unknown }) => {
      await getSequenceRejectingActiveRun(undefined, args.sequence.id);
      const { work, stopAt } = continueFromPlan(args);
      return { work, stopAt, estimate: { micros: 1_000_000, priced: true } };
    }
  ),
}));

// The real shared gate (processing check, credit floor) over the mocks above.
const realUpdateStaleRun = await vi.importActual<
  typeof import('@/shots/server/update-stale-run')
>('@/shots/server/update-stale-run');
vi.doMock('@/shots/server/update-stale-run', () => ({
  prepareUpdateStale: realUpdateStaleRun.prepareUpdateStale,
  UPDATE_STALE_CREDIT_PROVIDERS:
    realUpdateStaleRun.UPDATE_STALE_CREDIT_PROVIDERS,
  launchUpdateStale,
  readUpdateStaleRun,
}));

const {
  executeGeneration,
  getOperationStatus,
  planExport,
  planGeneration,
  startExportOperation,
} = await import('./generation-operations');

let client: Client;
let db: Database;
let teamId: string;
let userId: string;
let sequenceId: string;
let sceneId: string;
let shotId: string;
/** Run ids as the launchers mint them: workflow name, then a suffix with the sequence id. */
let updateAllRun: string;
let storyboardRun: string;

function stalePlan(over: Record<string, unknown> = {}): UpdateStalePlan {
  return asStub<UpdateStalePlan>({
    sequence: { imageModel: 'nano_banana_2', videoModel: 'wan_i2v' },
    targets: [
      {
        shotId,
        imageModel: 'nano_banana_2',
        usesStartFrame: true,
        regenImage: true,
        imageLiveHash: 'hash-a',
      },
    ],
    music: null,
    skipped: [],
    plannedAt: new Date(),
    renderOptions: undefined,
    ...over,
  });
}

const stale = {
  mode: 'stale' as const,
  depth: 'images' as const,
  target: { kind: 'sequence' as const },
};
const missing = {
  mode: 'missing' as const,
  stopAt: 'images' as const,
  target: { kind: 'sequence' as const },
};

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  vi.mocked(getDb).mockReturnValue(db);
});
afterAll(() => client.close());

beforeEach(async () => {
  vi.clearAllMocks();
  teamId = generateId();
  userId = generateId();
  sequenceId = generateId();
  sceneId = generateId();
  shotId = generateId();
  updateAllRun = `local_update-stale-shots_${sequenceId}-plan-k`;
  storyboardRun = `local_storyboard_storyboard-${sequenceId}-k`;
  const styleId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: teamId });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@test.invalid` });
  await db.insert(styles).values({
    id: styleId,
    teamId,
    name: 's',
    config: {
      mood: 'neutral',
      artStyle: 'cinematic',
      lighting: 'natural',
      colorPalette: ['#000'],
      cameraWork: 'static',
      referenceFilms: [],
      colorGrading: 'neutral',
    },
  });
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId,
    status: 'completed',
  });
  await db
    .insert(scenes)
    .values({ id: dbSceneId(sceneId), sequenceId, orderIndex: 0 });
  await db.insert(shots).values({
    id: shotId,
    sequenceId,
    sceneId: dbSceneId(sceneId),
    shotNumber: 1,
  });
  planUpdateAll.mockImplementation(async () => stalePlan());
  launchUpdateStale.mockImplementation(async () => updateAllRun);
  continueFromPlan.mockReturnValue({
    work: [{ kind: 'still', id: shotId }],
    stopAt: 'images',
  });
  computePlan.mockImplementation(async () => stalePlan());
  triggerContinue.mockImplementation(async () => ({
    workflowRunId: storyboardRun,
  }));
  readProductionStatus.mockResolvedValue({ failures: [] });
});

const scoped = () => createScopedDb(teamId, userId);
const actor = () => ({ userId, teamId });
const execute = (planToken: string, db = scoped()) =>
  executeGeneration(db, actor(), sequenceId, planToken);

describe('plan_generation', () => {
  it('is deterministic, writes no generation, and reports blockers instead of throwing', async () => {
    requireCredits.mockRejectedValueOnce(new InsufficientCreditsError());
    const first = await planGeneration(scoped(), actor(), sequenceId, stale);
    const second = await planGeneration(scoped(), actor(), sequenceId, stale);
    expect(first.digest).toBe(second.digest);
    // Same work, a different key: each approval launches its own runs.
    expect(first.planToken).not.toBe(second.planToken);
    expect(first.estimate).toEqual({ micros: 2_500_000, usd: 2.5 });
    expect(first.work).toMatchObject({ stages: { images: [shotId] } });
    expect(first.blockers.map((b) => b.code)).toEqual(['INSUFFICIENT_CREDITS']);
    expect(launchUpdateStale).not.toHaveBeenCalled();
  });

  it('expands scene targets to their shots and rejects foreign or wrong-type IDs', async () => {
    await planGeneration(scoped(), actor(), sequenceId, {
      ...stale,
      target: { kind: 'scenes', sceneIds: [sceneId] },
    });
    expect(planUpdateAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ shotIds: [shotId] })
    );
    for (const target of [
      { kind: 'shots' as const, shotIds: [sceneId] },
      { kind: 'scenes' as const, sceneIds: [shotId] },
      { kind: 'shots' as const, shotIds: [generateId()] },
    ]) {
      await expect(
        planGeneration(scoped(), actor(), sequenceId, { ...stale, target })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(
      planGeneration(
        createScopedDb(generateId(), userId),
        actor(),
        sequenceId,
        stale
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a plan of 200 shot ids round-trips through its token (past the old 4 KiB cap)', async () => {
    const shotIds = Array.from({ length: 200 }, () => generateId());
    await db.insert(shots).values(
      shotIds.map((id, i) => ({
        id,
        sequenceId,
        sceneId: dbSceneId(sceneId),
        shotNumber: i + 2,
      }))
    );
    const { planToken } = await planGeneration(scoped(), actor(), sequenceId, {
      ...stale,
      target: { kind: 'shots', shotIds },
    });
    expect(planToken.length).toBeGreaterThan(4096);
    expect(await execute(planToken)).toMatchObject({
      workflowRunIds: [updateAllRun],
    });
    expect(planUpdateAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ shotIds })
    );
  });

  it('refuses missing (Continue) work for anything but the whole sequence', async () => {
    await expect(
      planGeneration(scoped(), actor(), sequenceId, {
        ...missing,
        target: { kind: 'shots', shotIds: [shotId] },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('execute_generation', () => {
  it('launches under the plan key, and a repeat re-sends the same key so the trigger reuses the runs', async () => {
    const { planToken } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    const [a, b] = await Promise.all([execute(planToken), execute(planToken)]);
    const again = await execute(planToken);
    const keys = launchUpdateStale.mock.calls.map(([input]) => input.runKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(new RegExp(`^${sequenceId}-plan-[0-9a-f]{12}$`));
    for (const op of [a, b, again]) {
      expect(op).toEqual({
        sequenceId,
        workflowRunIds: [updateAllRun],
        pollAfterSeconds: 15,
      });
    }
  });

  it('tolerates a moved timestamp but refuses changed work, a foreign token and garbage', async () => {
    const { planToken } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    planUpdateAll.mockResolvedValueOnce(
      stalePlan({ plannedAt: new Date(Date.now() + 60_000) })
    );
    expect(await execute(planToken)).toMatchObject({
      workflowRunIds: [updateAllRun],
    });

    planUpdateAll.mockResolvedValueOnce(
      stalePlan({
        targets: stalePlan().targets.map((t) => ({
          ...t,
          imageLiveHash: 'hash-b',
        })),
      })
    );
    await expect(execute(planToken)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { code: 'PLAN_CHANGED' },
    });

    await expect(
      executeGeneration(scoped(), actor(), generateId(), planToken)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(execute('not-a-token')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      execute(planToken, createScopedDb(generateId(), userId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(launchUpdateStale).toHaveBeenCalledTimes(1);
  });

  it('rechecks credits at execute and launches nothing when they fall short', async () => {
    const { planToken } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    requireCredits.mockRejectedValueOnce(new InsufficientCreditsError());
    await expect(execute(planToken)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(launchUpdateStale).not.toHaveBeenCalled();
  });

  it('credit-checks the one-image floor when the estimate has no price', async () => {
    const preview = await import('@/shots/server/update-stale-preview');
    vi.spyOn(preview, 'buildUpdateStalePreview').mockReturnValue(
      asStub({ costByLevel: { images: null } })
    );
    const plan = await planGeneration(scoped(), actor(), sequenceId, stale);
    expect(plan.estimate).toEqual({ micros: null, usd: null });
    expect(requireCredits).toHaveBeenLastCalledWith(
      expect.anything(),
      400_000,
      expect.anything()
    );
    vi.mocked(preview.buildUpdateStalePreview).mockRestore();
  });

  it('refuses while the sequence is processing, with the editor’s own rule, and stays executable after', async () => {
    const { planToken } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    await db
      .update(sequences)
      .set({ status: 'processing' })
      .where(eq(sequences.id, sequenceId));
    await expect(execute(planToken)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(getSequenceRejectingActiveRun).not.toHaveBeenCalled();
    await db
      .update(sequences)
      .set({ status: 'completed' })
      .where(eq(sequences.id, sequenceId));
    expect(await execute(planToken)).toMatchObject({
      workflowRunIds: [updateAllRun],
    });
  });

  it('runs Continue through the storyboard launcher and gives its mutex refusal a code', async () => {
    const { planToken } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      missing
    );
    expect(await execute(planToken)).toMatchObject({
      workflowRunIds: [storyboardRun],
    });
    expect(triggerContinue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stopAt: 'images' })
    );
    // A repeat while that run is live: the mutex, as a code the agent reads.
    getSequenceRejectingActiveRun.mockRejectedValueOnce(
      new realLaunchers.GenerationInProgressError()
    );
    await expect(execute(planToken)).rejects.toMatchObject({
      code: 'GENERATION_IN_PROGRESS',
    });
    expect(triggerContinue).toHaveBeenCalledTimes(1);
  });
});

describe('get_operation_status', () => {
  const status = (runIds: string[], db = scoped()) =>
    getOperationStatus(db, sequenceId, runIds);

  it('reports an Update all run’s own per-shot outcome', async () => {
    readUpdateStaleRun.mockResolvedValueOnce({ state: 'running' });
    expect(await status([updateAllRun])).toMatchObject({
      state: 'running',
      terminal: false,
      pollAfterSeconds: 15,
    });
    readUpdateStaleRun.mockResolvedValueOnce({
      state: 'complete',
      result: {
        failures: [{ shotId, stage: 'image', error: 'safety' }],
        skipped: [{ shotId: 'other', reason: 'in flight' }],
      },
    });
    expect(await status([updateAllRun])).toMatchObject({
      state: 'partially_failed',
      terminal: true,
      failures: [{ shotId, stage: 'image' }],
      skipped: [{ shotId: 'other' }],
    });
    expect(readUpdateStaleRun).toHaveBeenCalledWith(sequenceId, updateAllRun);
    expect(getWorkflowRunOutcome).not.toHaveBeenCalled();
  });

  it('refuses a run id that is not this sequence’s, and another team’s sequence', async () => {
    await expect(
      status([`local_update-stale-shots_${generateId()}-plan-k`])
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      status([updateAllRun], createScopedDb(generateId(), userId))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(readUpdateStaleRun).not.toHaveBeenCalled();
  });

  it('reports a Continue run from its outcome plus what is failed on the sequence now', async () => {
    getWorkflowRunOutcome.mockResolvedValueOnce({
      state: 'complete',
      output: null,
    });
    readProductionStatus.mockResolvedValueOnce({
      failures: [
        { stage: 'image', id: 'f1', shotId, error: 'safety' },
        { stage: 'sequence', id: sequenceId, error: 'ignored: no shot' },
      ],
    });
    expect(await status([storyboardRun])).toMatchObject({
      state: 'partially_failed',
      terminal: true,
      failures: [{ shotId, stage: 'image', error: 'safety' }],
    });
    getWorkflowRunOutcome.mockResolvedValueOnce({
      state: 'complete',
      output: null,
    });
    expect(await status([storyboardRun])).toMatchObject({
      state: 'completed',
      terminal: true,
      failures: [],
    });
  });

  it('aggregates several runs: any running wins, then unknown, all failed is failed', async () => {
    const image = `local_image_${sequenceId}-plan-k-h1`;
    const motion = `local_motion-batch_${sequenceId}-plan-k-motion`;
    getWorkflowRunOutcome
      .mockResolvedValueOnce({ state: 'failed', error: 'boom' })
      .mockResolvedValueOnce({ state: 'running' });
    expect(await status([image, motion])).toMatchObject({
      state: 'running',
      terminal: false,
    });
    getWorkflowRunOutcome
      .mockResolvedValueOnce({ state: 'unknown' })
      .mockResolvedValueOnce({ state: 'complete', output: null });
    expect(await status([image, motion])).toMatchObject({
      state: 'unknown',
      terminal: false,
    });
    getWorkflowRunOutcome
      .mockResolvedValueOnce({ state: 'failed', error: 'boom' })
      .mockResolvedValueOnce({ state: 'complete', output: null });
    expect(await status([image, motion])).toMatchObject({
      state: 'partially_failed',
      terminal: true,
      error: 'boom',
    });
    getWorkflowRunOutcome
      .mockResolvedValueOnce({ state: 'failed', error: 'boom' })
      .mockResolvedValueOnce({ state: 'failed', error: 'bang' });
    expect(await status([image, motion])).toMatchObject({
      state: 'failed',
      terminal: true,
      error: 'boom; bang',
    });
  });
});

describe('planned retry (#1461)', () => {
  const retryPlan = {
    retryType: 'smart',
    images: [{ shotId: 'shot-a', model: 'nano_banana_2' }],
    motion: [{ shotId: 'shot-b', model: 'wan_i2v' }],
    music: false,
    musicPrompt: false,
    estimateMicros: 900_000,
  };
  const retry = { mode: 'retry' as const, retry: 'smart' as const };

  it('plans by dry run and launches under the plan key, reporting every run', async () => {
    // ElevenLabs music in the plan: the launch reserves it against platform
    // credits, so the plan's check must not let a fal key waive it.
    executeSmartRetry.mockResolvedValue({
      planned: retryPlan,
      creditProviders: [],
    });
    const plan = await planGeneration(scoped(), actor(), sequenceId, retry);
    expect(executeSmartRetry).toHaveBeenLastCalledWith(expect.anything(), {
      dryRun: true,
      smartOnly: true,
    });
    expect(plan.work).toMatchObject({
      retryType: 'smart',
      images: retryPlan.images,
    });
    expect(plan.estimate.micros).toBe(900_000);
    expect(requireCredits).toHaveBeenLastCalledWith(
      expect.anything(),
      900_000,
      { providers: [] }
    );

    executeSmartRetry.mockImplementation(
      async (
        _ctx,
        opts: { dryRun?: boolean; onLaunched?: (id: string) => Promise<void> }
      ) => {
        if (!opts.dryRun) {
          await opts.onLaunched?.('image-run');
          await opts.onLaunched?.('motion-run');
        }
        return { planned: retryPlan, creditProviders: [] };
      }
    );
    expect(await execute(plan.planToken)).toMatchObject({
      workflowRunIds: ['image-run', 'motion-run'],
    });
    const launch = executeSmartRetry.mock.calls.find(
      ([, opts]) => !opts.dryRun
    );
    expect(launch?.[1]).toMatchObject({
      smartOnly: true,
      runKey: expect.stringMatching(
        new RegExp(`^${sequenceId}-plan-[0-9a-f]{12}$`)
      ),
    });
  });

  it('names the runs that did start when a launch throws part-way', async () => {
    executeSmartRetry.mockImplementation(
      async (
        _ctx,
        opts: { dryRun?: boolean; onLaunched?: (id: string) => Promise<void> }
      ) => {
        if (!opts.dryRun) {
          await opts.onLaunched?.('image-run');
          throw new Error('motion trigger failed');
        }
        return { planned: retryPlan, creditProviders: ['fal'] };
      }
    );
    const plan = await planGeneration(scoped(), actor(), sequenceId, {
      mode: 'retry',
      retry: 'full_if_required',
    });
    await expect(execute(plan.planToken)).rejects.toMatchObject({
      code: 'LAUNCH_INCOMPLETE',
      message: expect.stringContaining('motion trigger failed'),
      details: { workflowRunIds: ['image-run'] },
    });
  });

  it('refuses a retry whose failures changed since planning, and one while a run is live', async () => {
    executeSmartRetry.mockResolvedValueOnce({
      planned: retryPlan,
      creditProviders: ['fal'],
    });
    const plan = await planGeneration(scoped(), actor(), sequenceId, retry);
    executeSmartRetry.mockResolvedValueOnce({
      planned: { ...retryPlan, images: [] },
      creditProviders: ['fal'],
    });
    await expect(execute(plan.planToken)).rejects.toMatchObject({
      details: { code: 'PLAN_CHANGED' },
    });
    executeSmartRetry.mockRejectedValueOnce(
      new realLaunchers.GenerationInProgressError()
    );
    await expect(execute(plan.planToken)).rejects.toMatchObject({
      code: 'GENERATION_IN_PROGRESS',
    });
  });
});

describe('export (#1461)', () => {
  const cut = { scenes: [], musicUrl: null, sourceShotsHash: 'cut-1' };

  it('previews the cut and starts the export through the shared service', async () => {
    resolveExportCut.mockResolvedValue(cut);
    previewExport.mockResolvedValue({ action: 'render', exportId: null });
    expect(await planExport(scoped(), sequenceId)).toEqual({
      sequenceId,
      sourceShotsHash: 'cut-1',
      action: 'render',
      exportId: null,
    });
    expect(startExport).not.toHaveBeenCalled();

    const exportId = generateId();
    // The action is the start's own, never a separate preview's: a concurrent
    // coalesce reports what actually happened.
    startExport.mockResolvedValue({
      row: { id: exportId, status: 'processing' },
      workflowRunId: null,
      action: 'join_in_flight',
    });
    expect(await startExportOperation(scoped(), actor(), sequenceId)).toEqual({
      sequenceId,
      exportId,
      status: 'processing',
      action: 'join_in_flight',
      workflowRunId: null,
    });
    expect(startExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sequenceId, cut, refuseOtherCut: true })
    );
    expect(previewExport).toHaveBeenCalledTimes(1);
  });
});
