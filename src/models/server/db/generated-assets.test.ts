/**
 * Behavioural tests for the scoped `generated_assets` layer (#458) against a
 * real migrated in-memory D1 (`src/platform/server/db/test-d1.ts`), mirroring the `video-variants.test.ts`
 * harness.
 *
 * Pins the organization boundary (reads filter on organizationId, writes inject
 * organizationId/userId), newest-first listing with activity/endpoint filters +
 * keyset cursor, and the status lifecycle
 * (`queued` → `running` → `completed`/`failed`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  GENERATED_ASSET_ACTIVITIES,
  generatedAssets,
  organization,
  user,
  type NewGeneratedAsset,
} from '@/platform/server/db/schema';
import { createGeneratedAssetsMethods } from './generated-assets';

let closeDb: () => Promise<void>;
let db: Database;
let methods: ReturnType<typeof createGeneratedAssetsMethods>;
let otherOrganizationMethods: ReturnType<typeof createGeneratedAssetsMethods>;

const USER_ID = 'user-1';
let organizationId = '';
let otherOrganizationId = '';

async function seed() {
  await db.delete(generatedAssets);
  await db.delete(organization);
  await db.delete(user);

  organizationId = generateId();
  otherOrganizationId = generateId();

  await db.insert(user).values([{ id: USER_ID, name: 'U', email: 'u@e.com' }]);
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: `t-${organizationId}` },
    { id: otherOrganizationId, name: 'O', slug: `o-${otherOrganizationId}` },
  ]);
}

function assetInput(
  overrides: Partial<Omit<NewGeneratedAsset, 'organizationId' | 'userId'>> = {}
): Omit<NewGeneratedAsset, 'organizationId' | 'userId'> {
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
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await seed();
  methods = createGeneratedAssetsMethods(db, organizationId, USER_ID);
  otherOrganizationMethods = createGeneratedAssetsMethods(
    db,
    otherOrganizationId,
    USER_ID
  );
});

describe('insert', () => {
  it('injects organizationId/userId and returns the row', async () => {
    const row = await methods.insert(assetInput());
    expect(row.organizationId).toBe(organizationId);
    expect(row.userId).toBe(USER_ID);
    expect(row.status).toBe('queued');
    expect(row.input).toEqual({ prompt: 'a red fox' });
    expect(row.outputs).toBeNull();
    expect(row.id).toBeTruthy();
  });
});

describe('list', () => {
  it('is organization-scoped and newest-first', async () => {
    const first = await methods.insert(assetInput());
    const second = await methods.insert(assetInput());
    await otherOrganizationMethods.insert(assetInput());

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
  it('returns own-organization rows and hides other organizations', async () => {
    const row = await methods.insert(assetInput());
    const foreign = await otherOrganizationMethods.insert(assetInput());

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
    // Inserted as 'fal' before any via is known; completion records the via
    // the run actually rendered on (#1681).
    expect(current?.provider).toBe('fal');
    await methods.markCompleted(row.id, { outputs, provider: 'byteplus' });
    current = await methods.getById(row.id);
    expect(current?.status).toBe('completed');
    expect(current?.provider).toBe('byteplus');
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

  it('scopes writes to the organization (a foreign markFailed throws, row untouched)', async () => {
    const row = await methods.insert(assetInput());
    // Throwing (not a silent no-op) — a zero-row status write means the
    // workflow would otherwise "succeed" with nothing persisted.
    await expect(
      otherOrganizationMethods.markFailed(row.id, 'cross-organization write')
    ).rejects.toThrow(/not found for this organization/);

    const current = await methods.getById(row.id);
    expect(current?.status).toBe('queued');
    expect(current?.error).toBeNull();
  });

  it('throws on status writes to a nonexistent row', async () => {
    await expect(
      methods.markRunning('01J00000000000000000000000')
    ).rejects.toThrow(/not found for this organization/);
  });
});
