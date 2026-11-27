import { createBillingMethods } from '@/billing/server/db/billing';
import type { GatewayTextModel } from '@/gateway/server/catalog';
import { micros } from '@/billing/money';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditReservations,
  credits,
  gatewayModels,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import {
  chat,
  EventType,
  type AdapterYieldChunk,
  type AnyTextAdapter,
  type TokenUsage,
} from '@tanstack/ai';
import { resolveDebugOption } from '@tanstack/ai/adapter-internals';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createGrokText } from '@tanstack/ai-grok';
import { createOpenRouterText } from '@tanstack/ai-openrouter';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeGatewayModel } from '@/gateway/server/db/gateway-models';
import type { ResolvedLlmKey } from '@/models/server/db/api-keys';
import {
  forCall,
  openstoryText,
  withTextGateway,
  type TextMeter,
} from './text';

// $1/M input, $10/M output, $0.10/M cached: 1,000 in + 100 out = 2,000 micros.
const CARD = rateCardSchema.parse({
  examples: [],
  source: {
    url: 'https://docs.example.com/pricing',
    hash: 'a'.repeat(64),
    extractedAt: '2026-11-01T00:00:00.000Z',
  },
  inputs: {
    input_tokens: { param: 'input_tokens', bound: 'usage', kind: 'number' },
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
    cache_read_tokens: {
      param: 'cache_read_tokens',
      bound: 'usage',
      kind: 'number',
      default: 0,
    },
    web_searches: {
      param: 'web_searches',
      bound: 'usage',
      kind: 'number',
      default: 0,
    },
  },
  tables: {
    rate: {
      base: {
        input_tokens: 1e-6,
        output_tokens: 1e-5,
        cache_read_tokens: 1e-7,
        web_searches: 0.01,
      },
    },
  },
  price: {
    '+': [
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'web_searches',
    ].map((v) => ({
      '*': [{ var: v }, { lookup: { table: 'rate', keys: ['base', v] } }],
    })),
  },
});

const MODEL: GatewayTextModel = {
  provider: 'openrouter',
  id: 'vendor/model',
  name: 'Model',
  kind: 'text',
  endpointId: 'chat/completions',
  card: CARD,
};

let db: Database;
let close: () => Promise<void>;
let organizationId = '';
let billing: ReturnType<typeof createBillingMethods>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

beforeEach(async () => {
  await db.delete(chargeLines);
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(credits);
  organizationId = generateId();
  const userId = generateId();
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: organizationId });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  await db.insert(credits).values({ organizationId, balance: 10_000_000 });
  billing = createBillingMethods(db, organizationId, userId);
});

/** A request's meter on the card route; override for a run or the direct route. */
const meter = (over: Partial<TextMeter> = {}): TextMeter => ({
  via: 'openrouter',
  card: { registryId: 'vendor/model', model: MODEL },
  organizationId,
  billing,
  run: null,
  oauthClientId: null,
  chargeKey: null,
  whenShort: 'refuse',
  describe: (model) => `LLM analysis (${model})`,
  resolve: () => Promise.reject(new Error('no re-run')),
  ...over,
});

const USAGE = (): TokenUsage => ({
  promptTokens: 1000,
  completionTokens: 100,
  totalTokens: 1100,
});

function adapter(chunks: () => AdapterYieldChunk[]): AnyTextAdapter & {
  calls: number;
} {
  const fake = {
    kind: 'text' as const,
    name: 'fake',
    model: 'vendor/model',
    calls: 0,
    '~types': {
      providerOptions: {},
      inputModalities: ['text'],
      messageMetadataByModality: {},
      toolCapabilities: {},
      toolCallMetadata: {},
      systemPromptMetadata: {},
    },
    async *chatStream() {
      fake.calls++;
      yield* chunks();
    },
    async structuredOutput() {
      fake.calls++;
      return { data: { ok: true }, rawText: '{}', usage: USAGE() };
    },
  };
  return fake;
}

const run = (runId = 'r', usage: TokenUsage = USAGE()): AdapterYieldChunk[] => [
  { type: EventType.RUN_STARTED, runId, threadId: 't', timestamp: 0 },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'm',
    delta: 'hello',
    timestamp: 0,
  },
  {
    type: EventType.RUN_FINISHED,
    runId,
    threadId: 't',
    timestamp: 0,
    finishReason: 'stop',
    usage,
  },
];

async function descriptions() {
  const rows = await db
    .select({ description: transactions.description })
    .from(transactions)
    .where(eq(transactions.organizationId, organizationId));
  return rows.map((r) => r.description);
}

async function ledger() {
  const rows = await db
    .select({ amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.organizationId, organizationId));
  const holds = await db
    .select({ remaining: creditReservations.remainingAmount })
    .from(creditReservations);
  return {
    charges: rows.map((r) => -r.amount),
    held: holds.reduce((sum, h) => sum + h.remaining, 0),
    holds: holds.length,
  };
}

const OPTIONS = {
  model: 'vendor/model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  modelOptions: { maxTokens: 1000 },
  threadId: 't',
  logger: resolveDebugOption(false),
};

function meterOf(key: ResolvedLlmKey): TextMeter {
  if ('uncharged' in key.meter) throw new Error('unmetered key');
  return key.meter;
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    // drain
  }
}

describe('openstoryText on the card route', () => {
  it('holds before the call and charges the card once, with the model on every line', async () => {
    const inner = adapter(() => run());
    await drain(
      openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS)
    );
    expect(await ledger()).toEqual({ charges: [2000], held: 0, holds: 1 });
    const lines = await db.select().from(chargeLines);
    expect(lines.map((l) => l.sku)).toEqual(
      lines.map(() => 'openrouter/vendor/model')
    );
  });

  it('prices cached tokens at the card lever, not the input rate', async () => {
    const inner = adapter(() =>
      run('r', { ...USAGE(), promptTokensDetails: { cachedTokens: 1000 } })
    );
    await drain(
      openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS)
    );
    // 1,000 cached at $0.10/M = 100 micros, plus 100 out = 1,000.
    expect((await ledger()).charges).toEqual([1100]);
  });

  it('prices OpenRouter web searches on the card lever', async () => {
    const inner = adapter(() =>
      run('r', {
        ...USAGE(),
        providerUsageDetails: {
          serverToolUseDetails: { webSearchRequests: 2 },
        },
      })
    );
    await drain(
      openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS)
    );
    expect((await ledger()).charges).toEqual([22_000]);
  });

  it('charges what streamed when cut off, and releases the rest', async () => {
    const inner = adapter(() => run());
    for await (const chunk of openstoryText(
      inner,
      meter(),
      'vendor/model'
    ).chatStream(OPTIONS)) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) break;
    }
    // 'hi' prompt ~9 tokens estimated, 'hello' ~2 tokens out: priced on tokens, not bytes.
    const { charges, held } = await ledger();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toBeGreaterThan(0);
    expect(charges[0]).toBeLessThan(100);
    expect(held).toBe(0);
  });

  /** A run's call cut off after one content chunk; returns its charge. */
  const cutOffCharge = async (delta: string, maxTokens: number) => {
    const inner = adapter(() => [
      { type: EventType.RUN_STARTED, runId: 'r', threadId: 't', timestamp: 0 },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'm',
        delta,
        timestamp: 0,
      },
    ]);
    for await (const chunk of openstoryText(
      inner,
      meter({ run: { runReservationId: null } }),
      'vendor/model'
    ).chatStream({ ...OPTIONS, modelOptions: { maxTokens } })) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) break;
    }
    const { charges } = await ledger();
    return charges.at(-1) ?? 0;
  };

  it('estimates an uncounted cut-off at UTF-8 bytes / 3: over for English, about right for CJK', async () => {
    // 3,600 bytes each = 1,200 output tokens = 12,000 micros, plus a few input tokens.
    const english = await cutOffCharge('hello world!'.repeat(300), 10_000);
    const cjk = await cutOffCharge('你好'.repeat(600), 10_000);
    expect(english).toBe(cjk);
    expect(english).toBeGreaterThanOrEqual(12_000);
    expect(english).toBeLessThan(12_100);
    // Never below the real count: ~900 tokens of English, ~1,200 of CJK.
    expect(english).toBeGreaterThan(9_000);
  });

  it('caps a cut-off call inside a run at what its output bound would have held', async () => {
    const long = 'x'.repeat(40_000);
    const inner = adapter(() => [
      { type: EventType.RUN_STARTED, runId: 'r', threadId: 't', timestamp: 0 },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'm',
        delta: long,
        timestamp: 0,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'm',
        delta: long,
        timestamp: 0,
      },
    ]);
    let seen = 0;
    for await (const chunk of openstoryText(
      inner,
      meter({ run: { runReservationId: null } }),
      'vendor/model'
    ).chatStream({ ...OPTIONS, modelOptions: { maxTokens: 100 } })) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && ++seen === 2) break;
    }
    // 20,000 tokens streamed past a 100-token bound: charged as 100 out (1,000) plus the estimated input.
    const { charges } = await ledger();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toBeGreaterThanOrEqual(1000);
    expect(charges[0]).toBeLessThan(1100);
  });

  it('charges the prompt when the caller disconnects before any text, and releases the rest', async () => {
    const inner = adapter(() => run());
    for await (const chunk of openstoryText(
      inner,
      meter(),
      'vendor/model'
    ).chatStream(OPTIONS)) {
      if (chunk.type === EventType.RUN_STARTED) break;
    }
    const { charges, held } = await ledger();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toBeGreaterThan(0);
    expect(held).toBe(0);
  });

  it('charges the prompt when the caller aborts before any text', async () => {
    const inner = adapter(() => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      throw abort;
    });
    await expect(
      drain(openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS))
    ).rejects.toThrow('aborted');
    expect((await ledger()).charges).toHaveLength(1);
  });

  it('charges nothing when the provider throws before any content', async () => {
    const inner = adapter(() => {
      throw new Error('400 Bad Request');
    });
    await expect(
      drain(openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS))
    ).rejects.toThrow('400');
    expect(await ledger()).toEqual({ charges: [], held: 0, holds: 1 });
  });

  it('charges nothing when the provider refuses before any content', async () => {
    const inner = adapter(() => [
      {
        type: EventType.RUN_ERROR,
        message: 'User location is not supported',
        timestamp: 0,
      },
    ]);
    await drain(
      openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS)
    );
    expect(await ledger()).toEqual({ charges: [], held: 0, holds: 1 });
  });

  it('charges structured output once', async () => {
    await openstoryText(
      adapter(() => []),
      meter(),
      'vendor/model'
    ).structuredOutput({ chatOptions: OPTIONS, outputSchema: {} });
    expect((await ledger()).charges).toEqual([2000]);
  });

  it('refuses before the provider call when the organization cannot cover the hold', async () => {
    await db
      .update(credits)
      .set({ balance: 0 })
      .where(eq(credits.organizationId, organizationId));
    const inner = adapter(() => run());
    await expect(
      drain(openstoryText(inner, meter(), 'vendor/model').chatStream(OPTIONS))
    ).rejects.toThrow('Insufficient credits');
    expect(inner.calls).toBe(0);
  });

  it('refuses a request with no output budget before holding or calling', async () => {
    const inner = adapter(() => run());
    await expect(
      drain(
        openstoryText(inner, meter(), 'vendor/model').chatStream({
          ...OPTIONS,
          modelOptions: {},
        })
      )
    ).rejects.toThrow('output budget');
    expect(inner.calls).toBe(0);
    expect((await ledger()).holds).toBe(0);
  });

  it('charges each agent-loop turn of chat() once', async () => {
    const inner = adapter(() => run(generateId()));
    await drain(
      chat({
        adapter: openstoryText(inner, meter(), 'vendor/model'),
        threadId: 't',
        messages: [{ role: 'user', content: 'hi' }],
        modelOptions: { maxTokens: 1000 },
      })
    );
    expect(inner.calls).toBe(1);
    expect((await ledger()).charges).toEqual([2000]);
  });

  it('draws on the run reservation with no hold of its own, and leaves it open', async () => {
    const reserved = await billing.createReservation(micros(50_000), {
      idempotencyKey: 'run',
    });
    if (!reserved.ok) throw new Error('no run reservation');
    const inner = adapter(() => run());
    await drain(
      openstoryText(
        inner,
        meter({ run: { runReservationId: reserved.reservationId } }),
        'vendor/model'
      ).chatStream({ ...OPTIONS, modelOptions: {} })
    );
    expect(await ledger()).toEqual({ charges: [2000], held: 48_000, holds: 1 });
  });

  it('charges a run with no reservation with no hold before the call', async () => {
    const inner = adapter(() => run());
    await drain(
      openstoryText(
        inner,
        meter({ run: { runReservationId: null } }),
        'vendor/model'
      ).chatStream({ ...OPTIONS, modelOptions: {} })
    );
    expect(await ledger()).toEqual({ charges: [2000], held: 0, holds: 1 });
  });

  it('holds an inline image at a fixed count, not its bytes, and passes the request through untouched', async () => {
    const seen: unknown[] = [];
    const inner = adapter(() => run());
    const spy = Object.assign(inner, {
      async *chatStream(options: unknown) {
        seen.push(options);
        yield* run();
      },
    });
    const options = {
      ...OPTIONS,
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'data' as const,
                value: 'A'.repeat(2_000_000),
                mimeType: 'image/png',
              },
            },
          ],
        },
      ],
      modelOptions: { maxTokens: 10, plugins: [{ id: 'web' }] },
      outputSchema: { type: 'object' },
    };
    await drain(
      openstoryText(spy, meter(), 'vendor/model').chatStream(options)
    );
    expect(seen).toEqual([options]);
    expect(seen[0]).toBe(options);
    const [reservation] = await db
      .select({ amount: creditReservations.originalAmount })
      .from(creditReservations);
    // About 4,096 input tokens and 10 output at $1/M and $10/M, not 2M bytes.
    expect(reservation?.amount).toBeLessThan(5_000);
  });
});

describe('openstoryText on the direct route', () => {
  // OpenRouter's own bill for the call: what `llmCostFromUsage` charges today.
  const billed = (): TokenUsage => ({ ...USAGE(), cost: 0.0015 });

  it('charges a caller disconnect with no usage on its estimated tokens (native Grok rates)', async () => {
    const inner = adapter(() => run());
    for await (const chunk of openstoryText(
      inner,
      meter({ card: null, via: 'xai' }),
      'x-ai/grok-4.7'
    ).chatStream(OPTIONS)) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) break;
    }
    const { charges } = await ledger();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toBeGreaterThan(0);
  });

  it('charges nothing on the direct route when the provider throws before any text', async () => {
    const inner = adapter(() => {
      throw new Error('400 Bad Request');
    });
    await expect(
      drain(
        openstoryText(
          inner,
          meter({ card: null, via: 'xai' }),
          'x-ai/grok-4.7'
        ).chatStream(OPTIONS)
      )
    ).rejects.toThrow('400');
    expect((await ledger()).charges).toEqual([]);
  });

  it('charges a request once at the provider cost, with no hold', async () => {
    const inner = adapter(() => run('r', billed()));
    await drain(
      openstoryText(inner, meter({ card: null }), 'vendor/model').chatStream(
        OPTIONS
      )
    );
    expect(await ledger()).toEqual({ charges: [1500], held: 0, holds: 0 });
  });

  it('captures against the run reservation', async () => {
    const reserved = await billing.createReservation(micros(50_000), {
      idempotencyKey: 'run',
    });
    if (!reserved.ok) throw new Error('no run reservation');
    const inner = adapter(() => run('r', billed()));
    await drain(
      openstoryText(
        inner,
        meter({
          card: null,
          run: { runReservationId: reserved.reservationId },
        }),
        'vendor/model'
      ).chatStream(OPTIONS)
    );
    expect(await ledger()).toEqual({ charges: [1500], held: 48_500, holds: 1 });
  });

  it('prices a priority-tier request as OpenRouter billed it, not on the card', async () => {
    const inner = adapter(() => run('r', billed()));
    await drain(
      openstoryText(inner, meter(), 'vendor/model').chatStream({
        ...OPTIONS,
        modelOptions: { maxTokens: 1000, serviceTier: 'priority' },
      })
    );
    expect(await ledger()).toEqual({ charges: [1500], held: 0, holds: 0 });
  });

  it('charges a repeated single-call site once under its charge key', async () => {
    const charged = forCall(
      {
        key: 'k',
        source: 'platform',
        via: 'openrouter',
        meter: meter({ card: null }),
      },
      {
        describe: (m) => `Talent vision (${m})`,
        chargeKey: 'likeness:https://example.com/a.png',
      }
    );
    for (let i = 0; i < 2; i++) {
      const inner = adapter(() => run('r', billed()));
      await drain(
        openstoryText(inner, meterOf(charged), 'vendor/model').chatStream(
          OPTIONS
        )
      );
    }
    expect((await ledger()).charges).toEqual([1500]);
  });
});

describe('an unfunded request that runs free (#1567)', () => {
  const setBalance = (balance: number) =>
    db
      .update(credits)
      .set({ balance })
      .where(eq(credits.organizationId, organizationId));
  // maxTokens 32,000 at $10/M holds about 320,000 micros: more than $0.10.
  const enhance = (over: Partial<TextMeter> = {}) =>
    drain(
      openstoryText(
        adapter(() => run('r', { ...USAGE(), cost: 0.0015 })),
        meter({ whenShort: 'run free', ...over }),
        'vendor/model'
      ).chatStream({ ...OPTIONS, modelOptions: { maxTokens: 32_000 } })
    );

  it.each([
    ['$0', 0],
    ['$0.10', 100_000],
  ])(
    'runs free at %s on the card route, with no hold left and no charge',
    async (_label, balance) => {
      await setBalance(balance);
      await enhance();
      expect(await ledger()).toMatchObject({ charges: [], held: 0 });
    }
  );

  it('runs free at $0 on the direct route, never below zero', async () => {
    await setBalance(0);
    await enhance({ card: null });
    expect((await ledger()).charges).toEqual([]);
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.organizationId, organizationId));
    expect(row?.balance).toBe(0);
  });

  it('is charged as usual when funded, on both routes', async () => {
    await enhance();
    await enhance({ card: null });
    expect((await ledger()).charges).toEqual([2000, 1500]);
  });

  it('a request that must refuse still refuses at $0.10', async () => {
    await setBalance(100_000);
    await expect(enhance({ whenShort: 'refuse' })).rejects.toThrow(
      'Insufficient credits'
    );
  });
});

describe('the transaction description', () => {
  const platformKey = (over: Partial<TextMeter> = {}): ResolvedLlmKey => ({
    key: 'k',
    source: 'platform',
    via: 'openrouter',
    meter: meter(over),
  });

  it("keeps each call site's wording, on both routes", async () => {
    const shortening = forCall(platformKey(), {
      describe: () => 'Prompt shortening (vendor/model)',
    });
    const assistant = forCall(platformKey({ card: null }), {
      describe: (m) => `Assistant (${m})`,
    });
    for (const key of [shortening, assistant]) {
      await drain(
        openstoryText(
          adapter(() => run('r', { ...USAGE(), cost: 0.0015 })),
          meterOf(key),
          'vendor/model'
        ).chatStream(OPTIONS)
      );
    }
    expect(new Set(await descriptions())).toEqual(
      new Set(['Assistant (vendor/model)', 'Prompt shortening (vendor/model)'])
    );
  });

  it('keeps the wording on a re-run resolved through the meter', async () => {
    const key = forCall(platformKey({ resolve: async () => platformKey() }), {
      describe: (m) => `Watched a clip (${m})`,
    });
    const rerun = await meterOf(key).resolve('vendor/model');
    await drain(
      openstoryText(
        adapter(() => run()),
        meterOf(rerun),
        'vendor/model'
      ).chatStream(OPTIONS)
    );
    expect(await descriptions()).toEqual(['Watched a clip (vendor/model)']);
  });

  it('refuses a metered call that names no purpose before the provider call', () => {
    const inner = adapter(() => run());
    expect(() =>
      openstoryText(inner, meter({ describe: null }), 'vendor/model')
    ).toThrow(/must name what it is for/);
    expect(inner.calls).toBe(0);
  });
});

describe('withTextGateway', () => {
  const key = (
    source: 'organization' | 'platform',
    via: ResolvedLlmKey['via']
  ): ResolvedLlmKey =>
    source === 'organization'
      ? { key: 'k', source, via, meter: { uncharged: 'own key' } }
      : { key: 'k', source, via, meter: { uncharged: 'no organization' } };
  const keys = (resolved: ResolvedLlmKey) =>
    withTextGateway(
      { resolveLlmKey: async (_model?: string) => resolved },
      { db, organizationId, billing }
    );

  beforeEach(async () => {
    await db.delete(gatewayModels);
    await storeGatewayModel(db, MODEL, new Date());
  });

  it('meters a platform OpenRouter key on its card', async () => {
    const resolved = await keys(key('platform', 'openrouter')).resolveLlmKey(
      'vendor/model'
    );
    expect(meterOf(resolved).card?.model.id).toBe('vendor/model');
    expect(meterOf(resolved).run).toBeNull();
  });

  it('carries the run reservation for a workflow run', async () => {
    const resolved = await keys(key('platform', 'openrouter')).resolveRunLlmKey(
      'vendor/model',
      'res-1'
    );
    expect(meterOf(resolved).run).toEqual({ runReservationId: 'res-1' });
  });

  it('leaves own keys unmetered and marked own key, so they are never charged', async () => {
    for (const resolved of [
      key('organization', 'openrouter'),
      key('organization', 'llmtr'),
      key('organization', 'xai'),
    ]) {
      expect(
        (await keys(resolved).resolveLlmKey('vendor/model')).meter
      ).toEqual({ uncharged: 'own key' });
    }
  });

  it('routes direct when the snapshot card is for a provider whose platform key this server lacks', async () => {
    // A Gemini card is held, but with no Google platform key the call resolves on OpenRouter.
    await storeGatewayModel(
      db,
      { ...MODEL, provider: 'gemini', id: 'gemini-3.8-flash' },
      new Date()
    );
    const resolved = await keys(key('platform', 'openrouter')).resolveLlmKey(
      'google/gemini-3.8-flash'
    );
    expect(meterOf(resolved).card).toBeNull();
    const google = await keys(key('platform', 'google')).resolveLlmKey(
      'google/gemini-3.8-flash'
    );
    expect(meterOf(google).card?.model.provider).toBe('gemini');
  });

  it('meters platform fal, and a model with no card, on the direct route', async () => {
    expect(
      meterOf(await keys(key('platform', 'fal')).resolveLlmKey('vendor/model'))
        .card
    ).toBeNull();
    await db.delete(gatewayModels);
    const resolved = await keys(key('platform', 'openrouter')).resolveLlmKey(
      'vendor/model'
    );
    expect(meterOf(resolved).card).toBeNull();
  });
});

describe('openstoryText fails closed', () => {
  it('refuses an adapter method it cannot meter, such as compact, without calling it', () => {
    let compacted = 0;
    const inner = {
      ...adapter(() => run()),
      compact: async () => {
        compacted++;
        return [];
      },
    };
    const wrapped = openstoryText(inner, meter(), 'vendor/model');
    expect(() => wrapped.compact()).toThrow(/compact cannot be metered/);
    expect(compacted).toBe(0);
  });
});

describe('openstoryText over each provider adapter', () => {
  it('keeps the identity and capabilities of the real OpenRouter, xAI and Google adapters', () => {
    for (const inner of [
      createOpenRouterText('anthropic/claude-sonnet-5.5', 'k'),
      createGrokText('grok-4.7', 'k'),
      createGeminiChat('gemini-3.8-flash', 'k'),
    ]) {
      const wrapped = openstoryText(inner, meter(), inner.model);
      expect(wrapped.name).toBe(inner.name);
      expect(wrapped.model).toBe(inner.model);
      expect(wrapped.supportsFileSources).toBe(inner.supportsFileSources);
      expect(wrapped.supportsCombinedToolsAndSchema()).toBe(
        inner.supportsCombinedToolsAndSchema()
      );
      expect(wrapped.chatStream).not.toBe(inner.chatStream);
      expect(Boolean(wrapped.structuredOutputStream)).toBe(
        Boolean(inner.structuredOutputStream)
      );
    }
  });
});
