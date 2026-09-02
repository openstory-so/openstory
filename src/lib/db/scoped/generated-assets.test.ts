/**
 * Behavioural tests for the scoped `generated_assets` layer (#458) against a
 * real migrated in-memory D1 (libsql), mirroring the `video-variants.test.ts`
 * harness.
 *
 * Pins the team boundary (reads filter on teamId, writes inject
 * teamId/userId), newest-first listing with activity/endpoint filters +
 * keyset cursor, and the status lifecycle
 * (`queued` → `running` → `completed`/`failed`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/shared/id';
import type { Database } from '@/lib/db/client';
import {
  GENERATED_ASSET_ACTIVITIES,
  generatedAssets,
  teams,
  user,
  type NewGeneratedAsset,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createGeneratedAssetsMethods } from './generated-assets';

let client: Client;
let db: Database;
let methods: ReturnType<typeof createGeneratedAssetsMethods>;
let otherTeamMethods: ReturnType<typeof createGeneratedAssetsMethods>;

const USER_ID = 'user-1';
let teamId = '';
let otherTeamId = '';

async function seed() {
  await db.delete(generatedAssets);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  otherTeamId = generateId();

  await db.insert(user).values([{ id: USER_ID, name: 'U', email: 'u@e.com' }]);
  await db.insert(teams).values([
    { id: teamId, name: 'T', slug: `t-${teamId}` },
    { id: otherTeamId, name: 'O', slug: `o-${otherTeamId}` },
  ]);
}

function assetInput(
  overrides: Partial<Omit<NewGeneratedAsset, 'teamId' | 'userId'>> = {}
): Omit<NewGeneratedAsset, 'teamId' | 'userId'> {
  return {
    provider: 'fal',
    endpointId: 'fal-ai/flux-1/dev',
    activity: 'image',
    modelName: 'FLUX.1 [dev]',
    input: { prompt: 'a red fox' },
    status: 'queued',
    ...overrides,
  };
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
  methods = createGeneratedAssetsMethods(db, teamId, USER_ID);
  otherTeamMethods = createGeneratedAssetsMethods(db, otherTeamId, USER_ID);
});

describe('insert', () => {
  it('injects teamId/userId and returns the row', async () => {
    const row = await methods.insert(assetInput());
    expect(row.teamId).toBe(teamId);
    expect(row.userId).toBe(USER_ID);
    expect(row.status).toBe('queued');
    expect(row.input).toEqual({ prompt: 'a red fox' });
    expect(row.outputs).toBeNull();
    expect(row.id).toBeTruthy();
  });
});

describe('list', () => {
  it('is team-scoped and newest-first', async () => {
    const first = await methods.insert(assetInput());
    const second = await methods.insert(assetInput());
    await otherTeamMethods.insert(assetInput());

    const { assets, nextCursor } = await methods.list();
    expect(assets.map((a) => a.id)).toEqual([second.id, first.id]);
    expect(nextCursor).toBeNull();
  });

  it('filters by activity and endpointId', async () => {
    // One asset per activity, so each filter isolates exactly one row.
    const byActivity = new Map<string, string>();
    for (const activity of GENERATED_ASSET_ACTIVITIES) {
      const row = await methods.insert(
        assetInput({ activity, endpointId: `fal-ai/${activity}-model` })
      );
      byActivity.set(activity, row.id);
    }

    for (const activity of GENERATED_ASSET_ACTIVITIES) {
      const { assets } = await methods.list({ activity });
      expect(assets.map((a) => a.id)).toEqual([byActivity.get(activity)]);
    }

    const { assets } = await methods.list({
      endpointId: 'fal-ai/video-model',
    });
    expect(assets.map((a) => a.id)).toEqual([byActivity.get('video')]);
  });

  it('paginates newest-first with a keyset cursor', async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push(await methods.insert(assetInput()));
    }
    const newestFirst = rows.map((r) => r.id).reverse();

    const page1 = await methods.list({ limit: 2 });
    expect(page1.assets.map((a) => a.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.nextCursor).toBe(newestFirst[1]);

    const page2 = await methods.list({
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.assets.map((a) => a.id)).toEqual(newestFirst.slice(2, 4));

    const page3 = await methods.list({
      limit: 2,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.assets.map((a) => a.id)).toEqual(newestFirst.slice(4));
    expect(page3.nextCursor).toBeNull();
  });
});

describe('getById', () => {
  it('returns own-team rows and hides other teams', async () => {
    const row = await methods.insert(assetInput());
    const foreign = await otherTeamMethods.insert(assetInput());

    expect((await methods.getById(row.id))?.id).toBe(row.id);
    expect(await methods.getById(foreign.id)).toBeNull();
  });
});

describe('status lifecycle', () => {
  it('queued → running → completed stores outputs and clears error', async () => {
    const row = await methods.insert(assetInput());

    await methods.setWorkflowRunId(row.id, 'wf-run-1');
    await methods.markRunning(row.id);
    let current = await methods.getById(row.id);
    expect(current?.status).toBe('running');
    expect(current?.workflowRunId).toBe('wf-run-1');

    const outputs = [
      {
        url: '/r2/thumbnails/teams/t/assets/a/output-0.png',
        contentType: 'image/png',
      },
    ];
    await methods.markCompleted(row.id, { outputs });
    current = await methods.getById(row.id);
    expect(current?.status).toBe('completed');
    expect(current?.outputs).toEqual(outputs);
    expect(current?.costMicros).toBeNull();
    expect(current?.error).toBeNull();
  });

  it('queued → running → failed records the error', async () => {
    const row = await methods.insert(assetInput());
    await methods.markRunning(row.id);
    await methods.markFailed(row.id, 'Model rejected the input (422)');

    const current = await methods.getById(row.id);
    expect(current?.status).toBe('failed');
    expect(current?.error).toBe('Model rejected the input (422)');
    expect(current?.outputs).toBeNull();
  });

  it('scopes writes to the team (a foreign markFailed throws, row untouched)', async () => {
    const row = await methods.insert(assetInput());
    // Throwing (not a silent no-op) — a zero-row status write means the
    // workflow would otherwise "succeed" with nothing persisted.
    await expect(
      otherTeamMethods.markFailed(row.id, 'cross-team write')
    ).rejects.toThrow(/not found for this team/);

    const current = await methods.getById(row.id);
    expect(current?.status).toBe('queued');
    expect(current?.error).toBeNull();
  });

  it('throws on status writes to a nonexistent row', async () => {
    await expect(
      methods.markRunning('01J00000000000000000000000')
    ).rejects.toThrow(/not found for this team/);
  });
});
