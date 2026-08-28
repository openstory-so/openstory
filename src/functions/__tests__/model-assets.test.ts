/**
 * Tests for the generated-asset create flow (#458).
 *
 * `createGeneratedAsset` is the trust + billing boundary, so the ordering is
 * what we pin: live-schema validation FIRST (a rejected input must never
 * reach `requireCredits`), the credit gate SECOND (a broke team leaves no
 * row), then row insert → workflow trigger → run-id persistence.
 *
 * Uses the house vi.doMock + dynamic-import pattern: `#db-client` is a real
 * migrated in-memory D1 (libsql), the modelschemas fetch / credit gate /
 * workflow trigger are recorded fakes.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import type { Database } from '@/lib/db/client';
import {
  generatedAssets,
  teams,
  user,
  type GeneratedAssetInput,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { ModelInputJsonSchema } from '@/lib/models/schema-fetch';

let db: Database;

const mockFetchModelInputSchema = vi.fn();
const mockRequireCredits = vi.fn();
const mockTriggerWorkflow = vi.fn();
const mockRequireGenerationAllowed = vi.fn();

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/lib/models/schema-fetch', () => ({
  fetchModelInputSchema: mockFetchModelInputSchema,
}));
vi.doMock('@/lib/billing/preflight', () => ({
  requireCredits: mockRequireCredits,
}));
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('@/lib/compliance/generation-gate', () => ({
  requireGenerationAllowed: mockRequireGenerationAllowed,
}));

// Dynamic imports so the mocks apply (static imports would be hoisted above
// vi.doMock and bypass them).
const { createGeneratedAsset, validateAssetInput } =
  await import('@/lib/models/generated-assets');
const { createScopedDb } = await import('@/lib/db/scoped');

/** A realistic fal input schema slice (flux-style). */
const FLUX_SCHEMA: ModelInputJsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    num_images: { type: 'integer', minimum: 1, maximum: 4 },
  },
  required: ['prompt'],
};

const TEAM_ID = generateId();
const USER_ID = 'user-1';

beforeAll(async () => {
  const client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  await db.insert(user).values([{ id: USER_ID, name: 'U', email: 'u@e.com' }]);
  await db.insert(teams).values([{ id: TEAM_ID, name: 'T', slug: 't' }]);
});

beforeEach(async () => {
  await db.delete(generatedAssets);
  vi.clearAllMocks();
  mockFetchModelInputSchema.mockResolvedValue(FLUX_SCHEMA);
  mockRequireCredits.mockResolvedValue(undefined);
  mockTriggerWorkflow.mockResolvedValue('wf-run-1');
  mockRequireGenerationAllowed.mockResolvedValue(undefined);
});

function createData(input: GeneratedAssetInput) {
  return {
    endpointId: 'fal-ai/flux-1/dev',
    activity: 'image' as const,
    modelName: 'FLUX.1 [dev]',
    input,
  };
}

describe('validateAssetInput', () => {
  it('accepts input matching the schema', () => {
    expect(
      validateAssetInput(FLUX_SCHEMA, { prompt: 'a red fox', num_images: 2 })
    ).toEqual({ success: true });
  });

  it('rejects a missing required field with a pathed issue', () => {
    const result = validateAssetInput(FLUX_SCHEMA, { num_images: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path === 'prompt')).toBe(true);
    }
  });

  it('rejects a wrong-typed field', () => {
    const result = validateAssetInput(FLUX_SCHEMA, {
      prompt: 'ok',
      num_images: 'two',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path === 'num_images')).toBe(true);
    }
  });

  it('rejects out-of-range numbers', () => {
    const result = validateAssetInput(FLUX_SCHEMA, {
      prompt: 'ok',
      num_images: 99,
    });
    expect(result.success).toBe(false);
  });

  it('passes unknown keys through (JSON Schema default: additionalProperties allowed)', () => {
    // Pins the trust-boundary behavior on the platform-key spend path: keys
    // the schema doesn't mention are forwarded to fal verbatim, matching
    // JSON Schema semantics (fal is authoritative for rejecting them).
    expect(
      validateAssetInput(FLUX_SCHEMA, { prompt: 'ok', unexpected_key: 42 })
    ).toEqual({ success: true });
  });

  it('throws (not "invalid input") when the schema itself cannot be converted', () => {
    const badSchema: ModelInputJsonSchema = {
      type: 'object',
      properties: { x: { type: 'weird' } },
    };
    expect(() => validateAssetInput(badSchema, { x: 1 })).toThrow();
  });
});

describe('createGeneratedAsset', () => {
  it('rejects a restricted account BEFORE the credit gate, leaving no row', async () => {
    const { AccountRestrictedError } = await import('@/lib/errors');
    mockRequireGenerationAllowed.mockRejectedValue(
      new AccountRestrictedError('paused')
    );
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    await expect(
      createGeneratedAsset(scopedDb, createData({ prompt: 'ok' }))
    ).rejects.toBeInstanceOf(AccountRestrictedError);

    expect(mockRequireCredits).not.toHaveBeenCalled();
    const rows = await db.select().from(generatedAssets);
    expect(rows).toHaveLength(0);
  });

  it('rejects invalid input BEFORE the credit gate, leaving no row', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    const result = await createGeneratedAsset(
      scopedDb,
      createData({ num_images: 2 })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'prompt')).toBe(true);
    }
    expect(mockRequireCredits).not.toHaveBeenCalled();
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
    expect(await db.select().from(generatedAssets)).toEqual([]);
  });

  it('stops at the credit gate without inserting a row', async () => {
    mockRequireCredits.mockRejectedValueOnce(
      new Error('Insufficient credits for image generation')
    );
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    await expect(
      createGeneratedAsset(scopedDb, createData({ prompt: 'a red fox' }))
    ).rejects.toThrow('Insufficient credits');

    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
    expect(await db.select().from(generatedAssets)).toEqual([]);
  });

  it('happy path: reserves the row, triggers /asset, stores the run id', async () => {
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    const result = await createGeneratedAsset(
      scopedDb,
      createData({ prompt: 'a red fox', num_images: 2 })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflowRunId).toBe('wf-run-1');

    // Validation used the SERVER-fetched schema, not a client-sent one.
    expect(mockFetchModelInputSchema).toHaveBeenCalledWith(
      'fal-ai/flux-1/dev',
      'image'
    );

    const rows = await db.select().from(generatedAssets);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.id).toBe(result.id);
    expect(row?.teamId).toBe(TEAM_ID);
    expect(row?.userId).toBe(USER_ID);
    expect(row?.provider).toBe('fal');
    expect(row?.status).toBe('queued');
    expect(row?.input).toEqual({ prompt: 'a red fox', num_images: 2 });
    expect(row?.workflowRunId).toBe('wf-run-1');

    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/asset',
      {
        userId: USER_ID,
        teamId: TEAM_ID,
        assetId: result.id,
        endpointId: 'fal-ai/flux-1/dev',
        activity: 'image',
        input: { prompt: 'a red fox', num_images: 2 },
      },
      { deduplicationId: `asset-${result.id}` }
    );
  });

  it('marks the row failed (and rethrows) when the workflow trigger throws', async () => {
    mockTriggerWorkflow.mockRejectedValueOnce(new Error('binding exploded'));
    const scopedDb = createScopedDb(TEAM_ID, USER_ID);

    await expect(
      createGeneratedAsset(scopedDb, createData({ prompt: 'a red fox' }))
    ).rejects.toThrow('binding exploded');

    // Without this the row would sit 'queued' forever with no workflowRunId
    // — invisible to the verified reconciler pass.
    const rows = await db.select().from(generatedAssets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toMatch(/could not be started/);
    expect(rows[0]?.workflowRunId).toBeNull();
  });
});
