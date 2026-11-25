/**
 * ElevenLabs Music on the `openstory` gateway, on the real migrations: the
 * provider's own body, held and charged there once, a retried step gets the
 * same track, and the caller is handed no cost to book.
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
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  credits,
  gatewayJobs,
  organization,
  user,
} from '@/platform/server/db/schema';
import type { GatewayModel } from '@/gateway/server/catalog';
import type { GatewayStart } from '@/gateway/server/providers';
import { rateCardSchema } from '@modelschemas/rate-card/schema';

let db: Database;
let closeDb: () => Promise<void>;

const start = vi.fn<(...args: unknown[]) => Promise<GatewayStart>>();
vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: {
    elevenlabs: { configured: () => true, start, poll: vi.fn() },
  },
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));
vi.doMock('@/gateway/server/storage', () => ({
  storeGatewayOutput: vi.fn(
    async (params: { folder: string; index: number }) => {
      const path = `teams/x/${params.folder}/output-${params.index}.mp3`;
      return { url: `/r2/${path}`, path, contentType: 'audio/mpeg' };
    }
  ),
}));
vi.doMock('@/platform/server/observability/ai-otel', () => ({
  recordMediaGenerationSpan: vi.fn(),
}));

const { generateMusic } = await import('./music-generation');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

/** A test fixture: no ElevenLabs card exists upstream yet (TanStack/schemas#756). */
const MUSIC: GatewayModel = {
  provider: 'elevenlabs',
  id: 'music_v2_5',
  name: 'Eleven Music',
  kind: 'audio',
  endpointId: 'v1/music',
  // $0.05 a track.
  card: rateCardSchema.parse({
    inputs: {},
    tables: {},
    price: 0.05,
    examples: [],
    source: {
      url: 'https://docs.example.com/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-11-01T00:00:00.000Z',
    },
  }),
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      prompt: { type: 'string' },
      music_length_ms: { type: 'integer' },
      force_instrumental: { type: 'boolean' },
    },
    required: ['prompt'],
  },
};

const START_BALANCE = 100_000_000;
const organizationId = generateId();
const userId = generateId();

function music(idempotencyKey: string) {
  return generateMusic({
    prompt: 'A slow ferry horn under rain, low strings',
    duration: 30,
    model: 'elevenlabs_music',
    gateway: {
      scopedDb: toWorkflowScopedDb(createScopedDb(organizationId, userId)),
      model: MUSIC,
      runId: 'music_run-1',
      idempotencyKey,
    },
  });
}

async function balanceDrop() {
  const [wallet] = await db
    .select()
    .from(credits)
    .where(eq(credits.organizationId, organizationId));
  return START_BALANCE - (wallet?.balance ?? 0);
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: 't' });
  await db.insert(credits).values({ organizationId, balance: START_BALANCE });
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ELEVENLABS_API_KEY', 'el-test');
  start.mockResolvedValue({
    result: {
      media: [{ base64: 'AQID', contentType: 'audio/mpeg' }],
      usage: null,
      requestId: null,
    },
  });
});

describe('ElevenLabs Music on the gateway', () => {
  it("sends the provider's body, is charged once, and books nothing on the caller", async () => {
    const first = await music('music_run-1:generate-music');
    const again = await music('music_run-1:generate-music');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toEqual({
      model_id: 'music_v2_5',
      prompt: 'A slow ferry horn under rain, low strings',
      music_length_ms: 30_000,
      force_instrumental: true,
    });
    expect(again.storagePath).toBe(first.storagePath);
    // Zero is what skips the workflow's own `deductWorkflowCredits`.
    expect(first.metadata.cost).toBe(0);
    expect(await balanceDrop()).toBe(50_000);
    const [line] = await db.select().from(chargeLines);
    expect(line?.amountMicros).toBe(50_000);
    await db.delete(chargeLines);
    await db.delete(gatewayJobs);
  });
});
