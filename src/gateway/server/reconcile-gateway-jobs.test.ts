/** The cron's gateway pass: a stale live job whose run is over is ended; a live run or a fresh row is left. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { gatewayJobs, organization, user } from '@/platform/server/db/schema';
import { createGatewayJobsMethods } from './db/gateway-jobs';

let db: Database;
let closeDb: () => Promise<void>;
const organizationId = generateId();
const userId = generateId();

const runStates: Record<string, 'failed' | 'completed' | 'unknown' | null> = {
  'run-dead': 'failed',
  'run-live': null,
  'run-blip': 'unknown',
};
vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/platform/server/workflow/reconcile', () => ({
  STALE_THRESHOLD_MS: 5 * 60 * 1000,
  resolveRunState: vi.fn(async (runId: string) => runStates[runId] ?? null),
}));
const { reconcileGatewayJobs } = await import('./reconcile-gateway-jobs');

async function runningJob(runId: string, ageMs: number): Promise<string> {
  const jobs = createGatewayJobsMethods(db, organizationId, userId);
  const { job } = await jobs.create({
    kind: 'image',
    modelKey: 'grok-imagine-image',
    via: 'xai',
    input: { model: 'grok-imagine-image', prompt: 'Mara in the engine room' },
    idempotencyKey: null,
    oauthClientId: null,
  });
  await jobs.attachRun(job.id, { reservationId: null, workflowRunId: runId });
  await jobs.markRunning(job.id);
  await db
    .update(gatewayJobs)
    .set({ updatedAt: new Date(Date.now() - ageMs) })
    .where(eq(gatewayJobs.id, job.id));
  return job.id;
}

async function statusOf(id: string) {
  const [row] = await db
    .select({ status: gatewayJobs.status, error: gatewayJobs.error })
    .from(gatewayJobs)
    .where(eq(gatewayJobs.id, id));
  return row;
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: 't' });
});

afterAll(async () => {
  await closeDb();
});

describe('reconcileGatewayJobs', () => {
  it('fails a stale job whose run died, and leaves the rest', async () => {
    const hour = 60 * 60 * 1000;
    const dead = await runningJob('run-dead', hour);
    const live = await runningJob('run-live', hour);
    const blip = await runningJob('run-blip', hour);
    const fresh = await runningJob('run-dead', 0);

    expect(await reconcileGatewayJobs()).toBe(1);
    expect(await statusOf(dead)).toEqual({
      status: 'failed',
      error: {
        code: 'GENERATION_FAILED',
        message: 'Swept: the run is failed and wrote no outcome',
      },
    });
    for (const id of [live, blip, fresh]) {
      expect((await statusOf(id))?.status).toBe('running');
    }
  });
});
