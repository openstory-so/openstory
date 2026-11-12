/** `scopedDb.gatewayJobs` on the real migrations: scoping, idempotency keys, guarded writes. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import { credits, organization, user } from '@/platform/server/db/schema';
import { createBillingMethods } from '@/billing/server/db/billing';
import { micros } from '@/billing/money';
import type { GatewayJobInput } from '@/gateway/schema';
import { createGatewayJobsMethods } from './gateway-jobs';

let closeDb: () => Promise<void>;
let db: Database;
const organizationId = generateId();
const otherOrganizationId = generateId();
const userId = generateId();

const input: GatewayJobInput = {
  kind: 'image',
  model: 'gpt_image_2',
  prompt: 'a fox',
  aspectRatio: '16:9',
  referenceImageUrls: [],
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: otherOrganizationId, name: 'O', slug: 'o' },
  ]);
});

afterAll(async () => {
  await closeDb();
});

describe('gateway jobs rows', () => {
  it('reads only its own organization’s jobs', async () => {
    const own = createGatewayJobsMethods(db, organizationId, userId);
    const other = createGatewayJobsMethods(db, otherOrganizationId, userId);
    const { job, created } = await own.create({
      input,
      idempotencyKey: null,
      oauthClientId: 'client-1',
    });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      organizationId,
      userId,
      kind: 'image',
      modelKey: 'gpt_image_2',
      status: 'queued',
      oauthClientId: 'client-1',
      input,
    });
    expect((await own.getById(job.id))?.id).toBe(job.id);
    expect(await other.getById(job.id)).toBeNull();

    // Another organization's writes land on nothing.
    await other.markFailed(job.id, { code: 'X', message: 'x' });
    expect((await own.getById(job.id))?.status).toBe('queued');
  });

  it('binds an idempotency key once per organization', async () => {
    const own = createGatewayJobsMethods(db, organizationId, userId);
    const other = createGatewayJobsMethods(db, otherOrganizationId, userId);
    const first = await own.create({
      input,
      idempotencyKey: 'key-1',
      oauthClientId: null,
    });
    const again = await own.create({
      input,
      idempotencyKey: 'key-1',
      oauthClientId: null,
    });
    expect(again).toEqual({ job: first.job, created: false });
    expect((await own.getByIdempotencyKey('key-1', null))?.id).toBe(
      first.job.id
    );

    // The same key in another organization is its own job.
    const theirs = await other.create({
      input,
      idempotencyKey: 'key-1',
      oauthClientId: null,
    });
    expect(theirs.created).toBe(true);
    expect(theirs.job.id).not.toBe(first.job.id);

    // Unkeyed submits never collide.
    const a = await own.create({
      input,
      idempotencyKey: null,
      oauthClientId: null,
    });
    const b = await own.create({
      input,
      idempotencyKey: null,
      oauthClientId: null,
    });
    expect(a.created && b.created).toBe(true);
  });

  it('runs, stamps and settles a job once', async () => {
    const own = createGatewayJobsMethods(db, organizationId, userId);
    const { job } = await own.create({
      input,
      idempotencyKey: null,
      oauthClientId: null,
    });
    await own.attachRun(job.id, {
      reservationId: 'res-1',
      workflowRunId: 'run-1',
    });
    await own.markRunning(job.id);
    await own.stampProviderJob(job.id, { via: 'fal', providerJobId: 'p-1' });
    const outputs = [
      { url: '/r2/a.png', path: 'a.png', contentType: 'image/png' },
    ];
    await own.markSucceeded(job.id, { outputs, costMicros: 1200, via: 'fal' });
    const done = await own.getById(job.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      reservationId: 'res-1',
      workflowRunId: 'run-1',
      providerJobId: 'p-1',
      via: 'fal',
      outputs,
      costMicros: 1200,
      error: null,
    });
    expect(done?.completedAt).toBeInstanceOf(Date);

    // A late failure cannot overwrite a settled job.
    await own.markFailed(job.id, { code: 'GENERATION_FAILED', message: 'x' });
    expect((await own.getById(job.id))?.status).toBe('succeeded');
  });

  it('deletes only a job that never started', async () => {
    const own = createGatewayJobsMethods(db, organizationId, userId);
    const unstarted = await own.create({
      input,
      idempotencyKey: 'drop-me',
      oauthClientId: null,
    });
    await own.deleteUnstarted(unstarted.job.id);
    expect(await own.getById(unstarted.job.id)).toBeNull();
    expect(await own.getByIdempotencyKey('drop-me', null)).toBeNull();

    const started = await own.create({
      input,
      idempotencyKey: null,
      oauthClientId: null,
    });
    await own.attachRun(started.job.id, {
      reservationId: null,
      workflowRunId: 'run-2',
    });
    await own.deleteUnstarted(started.job.id);
    expect((await own.getById(started.job.id))?.id).toBe(started.job.id);
  });

  it('a settle step re-run after the success keeps the cost equal to the lines', async () => {
    const own = createGatewayJobsMethods(db, organizationId, userId);
    const billing = createBillingMethods(db, organizationId, userId);
    const { job } = await own.create({
      input,
      idempotencyKey: null,
      oauthClientId: null,
    });
    await own.markRunning(job.id);
    const outputs = [
      { url: '/r2/b.png', path: 'b.png', contentType: 'image/png' },
    ];
    await own.recordOutputs(job.id, { outputs, via: 'fal' });
    // A zeroed hold and an empty wallet: the first attempt debits nothing.
    const setBalance = (balance: number) =>
      db
        .insert(credits)
        .values({ organizationId, balance })
        .onConflictDoUpdate({
          target: credits.organizationId,
          set: { balance },
        });
    await setBalance(1_000);
    const held = await billing.createReservation(micros(1_000), {
      idempotencyKey: `gateway:${job.id}`,
    });
    if (!held.ok) throw new Error('fixture reservation failed');
    await billing.zeroReservation(held.reservationId);
    await setBalance(0);
    const settle = async () => {
      const settled = await billing.settleReservation(
        held.reservationId,
        [{ kind: 'provider_cost', amountMicros: micros(4_000) }],
        {
          idempotencyKey: `${job.id}:gateway-settle`,
          attribution: { gatewayJobId: job.id },
        }
      );
      if (!settled.ok) throw new Error('missing');
      await own.markSucceeded(job.id, {
        outputs,
        via: 'fal',
        costMicros: settled.captured,
      });
    };
    await settle();
    expect((await own.getById(job.id))?.costMicros).toBe(0);

    // The step body ran but its result was lost; a top-up lands before the re-run.
    await setBalance(10_000);
    await settle();

    const lines = await own.getChargeLines(job.id);
    expect(lines).toEqual([{ kind: 'provider_cost', amountMicros: 4_000 }]);
    expect((await own.getById(job.id))?.costMicros).toBe(4_000);
  });
});

describe('caller isolation within one organization', () => {
  const jobs = () => createGatewayJobsMethods(db, organizationId, userId);

  it("an OAuth client reads only its own jobs; an osk_ key reads the organization's", async () => {
    const a = await jobs().create({
      input,
      idempotencyKey: null,
      oauthClientId: 'app-a',
    });
    const own = await jobs().create({
      input,
      idempotencyKey: null,
      oauthClientId: null,
    });
    expect((await jobs().getForCaller(a.job.id, 'app-a'))?.id).toBe(a.job.id);
    expect(await jobs().getForCaller(a.job.id, 'app-b')).toBeNull();
    expect(await jobs().getForCaller(own.job.id, 'app-a')).toBeNull();
    expect((await jobs().getForCaller(a.job.id, null))?.id).toBe(a.job.id);
    expect((await jobs().getForCaller(own.job.id, null))?.id).toBe(own.job.id);
  });

  it('gives each client and the organization its own Idempotency-Key space', async () => {
    const a = await jobs().create({
      input,
      idempotencyKey: 'shared-key',
      oauthClientId: 'app-a',
    });
    const b = await jobs().create({
      input,
      idempotencyKey: 'shared-key',
      oauthClientId: 'app-b',
    });
    const key = await jobs().create({
      input,
      idempotencyKey: 'shared-key',
      oauthClientId: null,
    });
    expect([a.created, b.created, key.created]).toEqual([true, true, true]);
    expect(new Set([a.job.id, b.job.id, key.job.id]).size).toBe(3);
    expect((await jobs().getByIdempotencyKey('shared-key', 'app-b'))?.id).toBe(
      b.job.id
    );
    expect((await jobs().getByIdempotencyKey('shared-key', null))?.id).toBe(
      key.job.id
    );
    const again = await jobs().create({
      input,
      idempotencyKey: 'shared-key',
      oauthClientId: 'app-a',
    });
    expect(again).toMatchObject({ created: false, job: { id: a.job.id } });
  });
});
