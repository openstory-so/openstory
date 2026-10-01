/**
 * Agent plan → execute → status (#1460) on migrated SQLite, so the plan row's
 * `planned` → `executing` step is the real guarded UPDATE. The editor's
 * planners, pricing, credit check and launchers are mocked: their behaviour
 * has its own tests; these pin the contract around them.
 */

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
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
  generationPlans,
  scenes,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
// oxlint-disable-next-line boundaries/no-scoped-factory -- exercise the real team-scoped plan rows, not mocked authorization
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
vi.doMock('@/shots/server/update-stale-run', () => ({
  launchUpdateStale,
  readUpdateStaleRun,
}));
vi.doMock('./launchers', () => ({ triggerContinue }));
vi.doMock('./continue-plan', () => ({
  continueFromPlan,
  estimateContinueCost: vi.fn(async () => ({
    micros: 1_000_000,
    priced: true,
  })),
}));

const { executeGeneration, getOperationStatus, planGeneration } =
  await import('./generation-operations');

let client: Client;
let db: Database;
let teamId: string;
let userId: string;
let sequenceId: string;
let sceneId: string;
let shotId: string;

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
  launchUpdateStale.mockResolvedValue(`run-${sequenceId}`);
});

const scoped = () => createScopedDb(teamId, userId);
const actor = () => ({ userId, teamId });

describe('plan_generation', () => {
  it('is deterministic, writes no generation, and reports blockers instead of throwing', async () => {
    requireCredits.mockRejectedValueOnce(new InsufficientCreditsError());
    const first = await planGeneration(scoped(), actor(), sequenceId, stale);
    const second = await planGeneration(scoped(), actor(), sequenceId, stale);
    expect(first.digest).toBe(second.digest);
    expect(first.planId).not.toBe(second.planId);
    expect(first.estimate).toEqual({
      micros: 2_500_000,
      usd: 2.5,
      complete: true,
    });
    expect(first.work.stages.images).toEqual([shotId]);
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

  it('refuses missing (Continue) work for anything but the whole sequence', async () => {
    await expect(
      planGeneration(scoped(), actor(), sequenceId, {
        mode: 'missing',
        stopAt: 'images',
        target: { kind: 'shots', shotIds: [shotId] },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('execute_generation', () => {
  it('launches once for repeated and concurrent executes and returns one operation', async () => {
    const { planId } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    const [a, b] = await Promise.all([
      executeGeneration(scoped(), actor(), sequenceId, planId),
      executeGeneration(scoped(), actor(), sequenceId, planId),
    ]);
    const again = await executeGeneration(
      scoped(),
      actor(),
      sequenceId,
      planId
    );
    expect(launchUpdateStale).toHaveBeenCalledTimes(1);
    expect(launchUpdateStale).toHaveBeenCalledWith(
      expect.objectContaining({ runKey: `${sequenceId}-plan-${planId}` })
    );
    for (const op of [a, b, again]) expect(op.operationId).toBe(planId);
    expect(again).toMatchObject({
      status: 'launched',
      workflowRunIds: [`run-${sequenceId}`],
    });
  });

  it('tolerates a moved timestamp but refuses changed work, expiry and other callers', async () => {
    const { planId } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    planUpdateAll.mockResolvedValueOnce(
      stalePlan({ plannedAt: new Date(Date.now() + 60_000) })
    );
    await expect(
      executeGeneration(
        scoped(),
        { userId: generateId(), teamId },
        sequenceId,
        planId
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      executeGeneration(
        createScopedDb(teamId, userId),
        actor(),
        generateId(),
        planId
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await executeGeneration(scoped(), actor(), sequenceId, planId)
    ).toMatchObject({ status: 'launched' });

    const moved = await planGeneration(scoped(), actor(), sequenceId, stale);
    planUpdateAll.mockResolvedValueOnce(
      stalePlan({
        targets: stalePlan().targets.map((t) => ({
          ...t,
          imageLiveHash: 'hash-b',
        })),
      })
    );
    await expect(
      executeGeneration(scoped(), actor(), sequenceId, moved.planId)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { code: 'PLAN_CHANGED' },
    });

    const old = await planGeneration(scoped(), actor(), sequenceId, stale);
    await db
      .update(generationPlans)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(
      executeGeneration(scoped(), actor(), sequenceId, old.planId)
    ).rejects.toMatchObject({ code: 'PLAN_EXPIRED' });
    expect(launchUpdateStale).toHaveBeenCalledTimes(1);
  });

  it('rechecks credits at execute and launches nothing when they fall short', async () => {
    const { planId } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    requireCredits.mockRejectedValueOnce(new InsufficientCreditsError());
    await expect(
      executeGeneration(scoped(), actor(), sequenceId, planId)
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(launchUpdateStale).not.toHaveBeenCalled();
    expect(
      await getOperationStatus(scoped(), sequenceId, planId)
    ).toMatchObject({ state: 'not_started', terminal: false });
  });

  it('records a failed dispatch and never relaunches it', async () => {
    const { planId } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    launchUpdateStale.mockRejectedValueOnce(new Error('binding down'));
    await expect(
      executeGeneration(scoped(), actor(), sequenceId, planId)
    ).rejects.toThrow('binding down');
    expect(
      await executeGeneration(scoped(), actor(), sequenceId, planId)
    ).toMatchObject({ status: 'dispatch_failed', workflowRunIds: [] });
    expect(launchUpdateStale).toHaveBeenCalledTimes(1);
    expect(
      await getOperationStatus(scoped(), sequenceId, planId)
    ).toMatchObject({
      state: 'dispatch_failed',
      terminal: true,
      error: 'binding down',
    });
  });

  it('runs Continue work through the storyboard launcher', async () => {
    continueFromPlan.mockReturnValue({
      work: [{ kind: 'still', id: shotId }],
      stopAt: 'images',
    });
    computePlan.mockResolvedValue(stalePlan());
    triggerContinue.mockResolvedValue({ workflowRunId: 'storyboard-run' });
    const { planId } = await planGeneration(scoped(), actor(), sequenceId, {
      mode: 'missing',
      stopAt: 'images',
      target: { kind: 'sequence' },
    });
    expect(
      await executeGeneration(scoped(), actor(), sequenceId, planId)
    ).toMatchObject({ workflowRunIds: ['storyboard-run'] });
    expect(triggerContinue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stopAt: 'images' })
    );
  });
});

describe('get_operation_status', () => {
  it('reports this run’s per-shot outcome and hides other sequences’ operations', async () => {
    const { planId } = await planGeneration(
      scoped(),
      actor(),
      sequenceId,
      stale
    );
    await executeGeneration(scoped(), actor(), sequenceId, planId);
    readUpdateStaleRun.mockResolvedValueOnce({ state: 'running' });
    expect(
      await getOperationStatus(scoped(), sequenceId, planId)
    ).toMatchObject({
      state: 'running',
      terminal: false,
      pollAfterSeconds: 15,
    });
    readUpdateStaleRun.mockResolvedValueOnce({
      state: 'complete',
      result: {
        failures: [{ shotId, stage: 'image', error: 'safety' }],
        skipped: [],
      },
    });
    expect(
      await getOperationStatus(scoped(), sequenceId, planId)
    ).toMatchObject({
      state: 'partially_failed',
      terminal: true,
      failures: [{ shotId, stage: 'image' }],
      targeted: { targetShotIds: [shotId] },
    });
    await expect(
      getOperationStatus(
        createScopedDb(generateId(), userId),
        sequenceId,
        planId
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
