/** AssetGenerationWorkflow on the gateway route, on the real migrations: a retried `generate` step stores and charges once. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  credits,
  gatewayJobs,
  generatedAssets,
  organization,
  user,
} from '@/platform/server/db/schema';
import type { GatewayModel } from '@/gateway/server/catalog';
import type { GatewayStart } from '@/gateway/server/providers';
import type { AssetGenerationWorkflowInput } from '@/platform/server/workflow/types';
import { asStub } from '@/test/as-stub';
import { rateCardSchema } from '@modelschemas/rate-card/schema';

let db: Database;
let closeDb: () => Promise<void>;

const start = vi.fn<(...args: unknown[]) => Promise<GatewayStart>>();
vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('#env', () => ({
  getEnv: () => ({ XAI_API_KEY: 'platform-xai', E2E_TEST: undefined }),
}));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: { grok: { configured: () => true, start, poll: vi.fn() } },
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));
const storeGatewayOutput = vi.fn(async () => ({
  url: '/r2/a.png',
  path: 'a.png',
  contentType: 'image/png',
}));
vi.doMock('@/gateway/server/storage', () => ({ storeGatewayOutput }));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  extractPromptForProvenance: () => null,
  recordProvenance: vi.fn(async () => 'prov-1'),
}));

const { AssetGenerationWorkflow } = await import('./asset-generation-workflow');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

const organizationId = generateId();
const userId = generateId();
const assetId = generateId();

const MODEL: GatewayModel = {
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
  },
};

type Event = Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>;

class Probe extends AssetGenerationWorkflow {
  runBody(event: Event, step: WorkflowStep) {
    return this.runImpl(
      event,
      step,
      toWorkflowScopedDb(createScopedDb(organizationId, userId))
    );
  }
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: 't' });
  await db.insert(credits).values({ organizationId, balance: 100_000_000 });
  await db.insert(generatedAssets).values({
    id: assetId,
    organizationId,
    userId,
    provider: 'openstory',
    endpointId: MODEL.id,
    activity: 'image',
    modelName: MODEL.name,
    input: { prompt: 'Mara signs the log' },
  });
});

afterAll(async () => {
  await closeDb();
});

describe('AssetGenerationWorkflow on the gateway route', () => {
  it('returns the stored outputs from a retried generate step without storing or charging twice', async () => {
    start.mockResolvedValue({
      result: {
        media: [{ url: 'https://imgen.x.ai/a.png', contentType: null }],
        usage: null,
        requestId: null,
      },
    });
    // `generate` finishes, its checkpoint is lost, and it runs again.
    const replaying = asStub<WorkflowStep>({
      do: async (name: string, fn: () => Promise<unknown>) => {
        if (name === 'generate') await fn();
        return fn();
      },
      sleep: async () => {},
    });
    type Ctor = ConstructorParameters<typeof Probe>;
    const workflow = new Probe(asStub<Ctor[0]>(undefined), asStub<Ctor[1]>({}));
    const result = await workflow.runBody(
      {
        payload: {
          userId,
          organizationId,
          assetId,
          activity: 'image',
          input: { prompt: 'Mara signs the log' },
          route: {
            via: 'openstory',
            model: MODEL,
            hold: { jobId: 'unused', reservationId: 'unused' },
          },
        },
        instanceId: 'run-1',
        workflowName: 'asset',
        timestamp: new Date(0),
      },
      replaying
    );

    expect(result.outputs).toEqual([
      { url: '/r2/a.png', contentType: 'image/png' },
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(storeGatewayOutput).toHaveBeenCalledTimes(1);
    const jobs = await db.select().from(gatewayJobs);
    expect(jobs).toHaveLength(1);
    const lines = await db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.gatewayJobId, jobs[0]?.id ?? ''));
    expect(lines.map((line) => line.amountMicros)).toEqual([20_000]);
  });
});
