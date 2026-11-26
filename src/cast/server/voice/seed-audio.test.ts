/**
 * A Seed take on the `openstory` gateway, on the real migrations: held and
 * charged there once per take, a retried step reuses its take, a retake is a
 * new job, and the caller is handed no Seed ledger line.
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
import { micros } from '@/billing/money';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditReservations,
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
    byteplus: { configured: () => true, start, poll: vi.fn() },
  },
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));
const stored = new Map<string, Uint8Array<ArrayBuffer>>();
vi.doMock('@/gateway/server/storage', () => ({
  storeGatewayOutput: vi.fn(
    async (params: {
      media: { base64: string };
      folder: string;
      index: number;
    }) => {
      const path = `audio/${params.folder}/output-${params.index}.wav`;
      stored.set(
        path,
        Uint8Array.from(atob(params.media.base64), (c) => c.charCodeAt(0))
      );
      return { url: `/r2/${path}`, path, contentType: 'audio/wav' };
    }
  ),
}));
vi.doMock('#storage', () => ({
  readStorageObject: vi.fn(async (key: string) => {
    const bytes = stored.get(key);
    return bytes ? { bytes, contentType: 'audio/wav' } : null;
  }),
}));

vi.doMock('@/models/server/byteplus-governor', () => ({
  acquireSeedSpeechToken: vi.fn(async () => undefined),
}));

const { seedRecorderFor, seedCharge } = await import('./seed-audio');
const { gatewayRouteKey } = await import('@/gateway/server/route');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

const SEED: GatewayModel = {
  provider: 'byteplus',
  id: 'seed-audio-1.0',
  name: 'Seed Audio',
  kind: 'audio',
  endpointId: 'tts/create',
  // $0.02 a take.
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
    properties: {
      model: { type: 'string' },
      text_prompt: { type: 'string' },
      references: { type: 'array' },
      audio_config: { type: 'object' },
    },
    required: ['model', 'text_prompt'],
  },
};
// A cloned voice: the trusted caller's references travel inline.
const BODY = {
  model: 'seed-audio-1.0',
  text_prompt: '@Audio1 says the port engine is done for',
  references: [{ audio_data: 'UklGRg==' }],
};

const START_BALANCE = 100_000_000;
const organizationId = generateId();
const userId = generateId();

const ROUTES = {
  [gatewayRouteKey('byteplus', 'seed-audio-1.0')]: {
    via: 'openstory' as const,
    model: JSON.stringify(SEED),
  },
};

function recorder(
  idempotencyKey: string,
  routes = ROUTES,
  reservationId: string | undefined = undefined
) {
  return seedRecorderFor({
    routes,
    scopedDb: toWorkflowScopedDb(createScopedDb(organizationId, userId)),
    runId: 'voice_run-1',
    reservationId,
    idempotencyKey,
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

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(chargeLines);
  await db.delete(gatewayJobs);
  await db
    .update(credits)
    .set({ balance: START_BALANCE })
    .where(eq(credits.organizationId, organizationId));
  let call = 0;
  start.mockImplementation(async () => ({
    result: {
      media: [{ base64: btoa(`take-${++call}`), contentType: 'audio/wav' }],
      usage: null,
      requestId: null,
    },
  }));
});

describe('a Seed take on the gateway', () => {
  it('is charged once, and a retried step gets the same take back', async () => {
    const first = await recorder('run-1:read:1')(BODY, 1);
    const again = await recorder('run-1:read:1')(BODY, 1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(again.wav)).toBe('take-1');
    expect(again.wav).toEqual(first.wav);
    // The gateway charged it: the caller books no Seed line.
    expect(first.billedSeconds).toBeNull();
    expect(seedCharge(first.billedSeconds)).toEqual([]);
    expect(await balanceDrop()).toBe(20_000);
  });

  it('charges the run reservation once and takes no hold of its own inside a run that reserved', async () => {
    await db.delete(creditReservations);
    const held = await createScopedDb(
      organizationId,
      userId
    ).billing.createReservation(micros(50_000), {
      idempotencyKey: `voice-run:${generateId()}`,
    });
    if (!held.ok) throw new Error('no run reservation');
    const take = recorder('run-3:read:1', ROUTES, held.reservationId);
    await take(BODY, 1);
    await take(BODY, 1);
    expect(start).toHaveBeenCalledTimes(1);
    const holds = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.organizationId, organizationId));
    expect(holds.map((hold) => hold.id)).toContain(held.reservationId);
    expect(
      holds.filter((hold) => hold.idempotencyKey?.startsWith('gateway:'))
    ).toHaveLength(0);
    expect(
      holds.find((hold) => hold.id === held.reservationId)?.remainingAmount
    ).toBe(30_000);
    expect(await balanceDrop()).toBe(20_000);
  });

  it('records a retake as a new job', async () => {
    const record = recorder('run-2:read:1');
    const one = await record(BODY, 1);
    const two = await record(BODY, 2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(two.wav)).not.toBe(
      new TextDecoder().decode(one.wav)
    );
    expect(await balanceDrop()).toBe(40_000);
  });

  it('runs a payload with no routes on the platform key, as before the deploy', async () => {
    vi.stubEnv('SEED_SPEECH_API_KEY', 'seed-test');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ audio: btoa('direct-take'), original_duration: 4 })
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const take = await seedRecorderFor({
      routes: undefined,
      scopedDb: toWorkflowScopedDb(createScopedDb(organizationId, userId)),
      runId: 'voice_run-old',
      reservationId: undefined,
      idempotencyKey: 'voice_run-old:read:1',
    })(BODY, 1);
    vi.unstubAllGlobals();
    expect(start).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(take.billedSeconds).toBe(4);
    expect(await balanceDrop()).toBe(0);
  });

  it('books the platform-key take on the caller', () => {
    expect(seedCharge(4)).toEqual([
      expect.objectContaining({ endpointId: 'seed-audio', costMicros: 10_000 }),
    ]);
  });
});
