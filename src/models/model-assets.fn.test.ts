/**
 * The Models page create flow (#458, #2433): a platform-key run is held by
 * the gateway and linked to its job; an own fal key runs unbilled; a refusal
 * leaves no row and no hold.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  creditReservations,
  credits,
  gatewayJobs,
  generatedAssets,
  organization,
  user,
  type GeneratedAssetInput,
} from '@/platform/server/db/schema';
import type { ModelInputJsonSchema } from '@/models/server/schema-fetch';
import type { GatewayModel } from '@/gateway/server/catalog';
import { rateCardSchema } from '@modelschemas/rate-card/schema';

let db: Database;
let closeDb: () => Promise<void>;

const mockFetchModelInputSchema = vi.fn();
const mockTriggerWorkflow = vi.fn();
const mockRequireGenerationAllowed = vi.fn();
const mockGetGatewayModel = vi.fn();

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/models/server/schema-fetch', () => ({
  fetchModelInputSchema: mockFetchModelInputSchema,
}));
vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: mockRequireGenerationAllowed,
}));
vi.doMock('@/gateway/server/catalog', () => ({
  getGatewayModel: mockGetGatewayModel,
}));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: { grok: { configured: () => true } },
}));

const { createGeneratedAsset, validateAssetInput } =
  await import('@/models/server/generated-assets');
const { createScopedDb } = await import('@/platform/server/db/scoped');

/** A realistic fal input schema slice (flux-style). */
const FLUX_SCHEMA: ModelInputJsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    num_images: { type: 'integer', minimum: 1, maximum: 4 },
  },
  required: ['prompt'],
};

// $0.02 an image.
const GROK: GatewayModel = {
  provider: 'grok',
  id: 'grok-imagine-image',
  name: 'Grok Imagine',
  kind: 'image',
  endpointId: 'v1/images/generations',
  card: rateCardSchema.parse({
    inputs: {},
    tables: {},
    price: 0.02,
    examples: [],
    source: {
      url: 'https://docs.example.com/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-11-01T00:00:00.000Z',
    },
  }),
  inputSchema: {
    type: 'object',
    properties: { model: { type: 'string' }, prompt: { type: 'string' } },
    required: ['prompt'],
  },
};

const ORGANIZATION_ID = generateId();
const USER_ID = 'user-1';
const REQUEST = { ipAddress: null, userAgent: null };

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values([{ id: USER_ID, name: 'U', email: 'u@e.com' }]);
  await db
    .insert(organization)
    .values([{ id: ORGANIZATION_ID, name: 'T', slug: 't' }]);
  await db
    .insert(credits)
    .values({ organizationId: ORGANIZATION_ID, balance: 100_000_000 });
});

afterAll(() => closeDb());

beforeEach(async () => {
  await db.delete(generatedAssets);
  await db.delete(creditReservations);
  await db.delete(gatewayJobs);
  vi.clearAllMocks();
  mockFetchModelInputSchema.mockResolvedValue(FLUX_SCHEMA);
  mockTriggerWorkflow.mockResolvedValue('wf-run-1');
  mockRequireGenerationAllowed.mockResolvedValue(undefined);
  mockGetGatewayModel.mockResolvedValue(GROK);
});

function scoped(ownFalKey: boolean) {
  const scopedDb = createScopedDb(ORGANIZATION_ID, USER_ID);
  vi.spyOn(scopedDb.apiKeys, 'hasUsableKey').mockResolvedValue(ownFalKey);
  return scopedDb;
}

function grokData(input: GeneratedAssetInput) {
  return {
    provider: 'grok' as const,
    endpointId: GROK.id,
    activity: 'image' as const,
    modelName: GROK.name,
    input,
  };
}

function falData(input: GeneratedAssetInput) {
  return {
    provider: 'fal' as const,
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
  it('holds a platform-key run on the gateway and links the row to its job', async () => {
    const result = await createGeneratedAsset(
      scoped(false),
      grokData({ prompt: 'Mara wipes her hands on a rag' }),
      REQUEST
    );
    if (!result.ok) throw new Error('refused');

    const [job] = await db.select().from(gatewayJobs);
    expect(job?.idempotencyKey).toBe(`asset:${result.id}`);
    expect(job?.workflowRunId).toBe('wf-run-1');
    const [row] = await db.select().from(generatedAssets);
    expect(row).toMatchObject({
      provider: 'openstory',
      gatewayJobId: job?.id,
      workflowRunId: 'wf-run-1',
    });
    // Held once, at the card price.
    const holds = await db.select().from(creditReservations);
    expect(holds.map((hold) => hold.remainingAmount)).toEqual([
      expect.any(Number),
    ]);
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/asset',
      expect.objectContaining({
        assetId: result.id,
        route: { via: 'openstory', model: GROK },
      }),
      { deduplicationId: `asset-${result.id}` }
    );
  });

  it('runs an own fal key directly: no gateway job, no hold', async () => {
    const result = await createGeneratedAsset(
      scoped(true),
      falData({ prompt: 'a red fox' }),
      REQUEST
    );
    if (!result.ok) throw new Error('refused');

    expect(mockGetGatewayModel).not.toHaveBeenCalled();
    expect(mockFetchModelInputSchema).toHaveBeenCalledWith(
      'fal-ai/flux-1/dev',
      'image'
    );
    expect(await db.select().from(gatewayJobs)).toEqual([]);
    expect(await db.select().from(creditReservations)).toEqual([]);
    const [row] = await db.select().from(generatedAssets);
    expect(row).toMatchObject({ provider: 'fal', gatewayJobId: null });
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/asset',
      expect.objectContaining({
        route: { via: 'fal', endpointId: 'fal-ai/flux-1/dev' },
      }),
      { deduplicationId: `asset-${result.id}` }
    );
  });

  it("returns the hold's validation issues and leaves no row, job or hold", async () => {
    const result = await createGeneratedAsset(
      scoped(false),
      grokData({ caption: 'no prompt' }),
      REQUEST
    );
    expect(result.ok).toBe(false);
    expect(await db.select().from(generatedAssets)).toEqual([]);
    expect(await db.select().from(gatewayJobs)).toEqual([]);
    expect(await db.select().from(creditReservations)).toEqual([]);
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a restricted account with an own key, leaving no row', async () => {
    const { AccountRestrictedError } = await import('@/platform/errors');
    mockRequireGenerationAllowed.mockRejectedValue(
      new AccountRestrictedError('paused')
    );
    await expect(
      createGeneratedAsset(scoped(true), falData({ prompt: 'ok' }), REQUEST)
    ).rejects.toBeInstanceOf(AccountRestrictedError);
    expect(await db.select().from(generatedAssets)).toEqual([]);
  });

  it('fails the row and the job and lets the hold go when the trigger throws', async () => {
    mockTriggerWorkflow.mockRejectedValueOnce(new Error('binding exploded'));
    await expect(
      createGeneratedAsset(
        scoped(false),
        grokData({ prompt: 'a red fox' }),
        REQUEST
      )
    ).rejects.toThrow('binding exploded');

    const [row] = await db.select().from(generatedAssets);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe(
      "This image couldn't start. You weren't charged. Try again."
    );
    const [job] = await db.select().from(gatewayJobs);
    expect(job?.status).toBe('failed');
    const [hold] = await db.select().from(creditReservations);
    expect(hold?.remainingAmount).toBe(0);
  });
});
