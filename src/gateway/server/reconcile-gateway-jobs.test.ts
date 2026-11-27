/** The cron's gateway pass: a stale live job whose run is over is ended; a live run or a fresh row is left. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  creditReservations,
  credits,
  gatewayJobs,
  organization,
  user,
} from '@/platform/server/db/schema';
import { createBillingMethods } from '@/billing/server/db/billing';
import { micros } from '@/billing/money';
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
const resolveRunState = vi.fn(async (runId: string) => {
  if (runId === 'run-throws') throw new Error('engine unreachable');
  return runStates[runId] ?? null;
});
vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/platform/server/workflow/reconcile', () => ({
  STALE_THRESHOLD_MS: 5 * 60 * 1000,
  resolveRunState,
}));
const { reconcileGatewayJobs } = await import('./reconcile-gateway-jobs');

/** A running job holding $0.001, last touched `ageMs` ago. */
async function runningJob(runId: string, ageMs: number) {
  const jobs = createGatewayJobsMethods(db, organizationId, userId);
  const { job } = await jobs.create({
    kind: 'image',
    modelKey: 'grok-imagine-image',
    via: 'xai',
    input: { model: 'grok-imagine-image', prompt: 'Mara in the engine room' },
    idempotencyKey: null,
    oauthClientId: null,
    platformFeeBps: 0,
  });
  const held = await createBillingMethods(
    db,
    organizationId,
    userId
  ).createReservation(micros(1_000), { idempotencyKey: `gateway:${job.id}` });
  if (!held.ok) throw new Error('fixture reservation failed');
  await jobs.attachRun(job.id, {
    reservationId: held.reservationId,
    workflowRunId: runId,
  });
  await jobs.markRunning(job.id);
  await db
    .update(gatewayJobs)
    .set({ updatedAt: new Date(Date.now() - ageMs) })
    .where(eq(gatewayJobs.id, job.id));
  return { id: job.id, reservationId: held.reservationId };
}

async function heldOn(reservationId: string) {
  const [row] = await db
    .select({ remaining: creditReservations.remainingAmount })
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId));
  return row?.remaining;
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
  await db.insert(credits).values({ organizationId, balance: 1_000_000 });
});

afterAll(async () => {
  await closeDb();
});

describe('reconcileGatewayJobs', () => {
  it('fails a stale job whose run died and zeroes its hold, and leaves the rest', async () => {
    const hour = 60 * 60 * 1000;
    const dead = await runningJob('run-dead', hour);
    const live = await runningJob('run-live', hour);
    const blip = await runningJob('run-blip', hour);
    const fresh = await runningJob('run-dead', 0);

    expect(await reconcileGatewayJobs()).toBe(1);
    expect(await statusOf(dead.id)).toEqual({
      status: 'failed',
      error: {
        code: 'GENERATION_FAILED',
        message: 'Swept: the run is failed and wrote no outcome',
      },
    });
    expect(await heldOn(dead.reservationId)).toBe(0);
    for (const job of [live, blip, fresh]) {
      expect((await statusOf(job.id))?.status).toBe('running');
      expect(await heldOn(job.reservationId)).toBe(1_000);
    }
    // A second pass finds nothing left to change.
    expect(await reconcileGatewayJobs()).toBe(0);
  });

  it('keeps going past a row that throws', async () => {
    const hour = 60 * 60 * 1000;
    const broken = await runningJob('run-throws', 2 * hour);
    const dead = await runningJob('run-dead', hour);

    expect(await reconcileGatewayJobs()).toBe(1);
    expect((await statusOf(broken.id))?.status).toBe('running');
    expect((await statusOf(dead.id))?.status).toBe('failed');
    expect(await heldOn(dead.reservationId)).toBe(0);
  });
});
