import { createBillingMethods } from '@/billing/server/db/billing';
import type { GatewayTextModel } from '@/gateway/server/catalog';
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
  chargedByGateway,
  isTokenUsage,
  openstoryText,
  withTextGateway,
  type TextGateway,
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
  gateway = {
    registryId: 'vendor/model',
    model: MODEL,
    maxOutputTokens: 1000,
    organizationId,
    billing: createBillingMethods(db, organizationId, userId),
  };
});

let gateway: TextGateway;

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

const run = (runId = 'r'): AdapterYieldChunk[] => [
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
    usage: USAGE(),
  },
];

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
  threadId: 't',
  logger: resolveDebugOption(false),
};

describe('openstoryText', () => {
  it('holds before the call and charges the card on the reported usage once', async () => {
    const inner = adapter(() => run());
    const seen: AdapterYieldChunk[] = [];
    for await (const chunk of openstoryText(inner, gateway).chatStream(
      OPTIONS
    )) {
      seen.push(chunk);
    }
    expect(seen).toHaveLength(3);
    expect(await ledger()).toEqual({ charges: [2000], held: 0, holds: 1 });
    const finished = seen.at(-1);
    const usage: unknown =
      finished?.type === EventType.RUN_FINISHED ? finished.usage : undefined;
    expect(isTokenUsage(usage) && chargedByGateway(usage)).toBe(true);
  });

  it('prices cached tokens at the card lever, not the input rate', async () => {
    const inner = adapter(() =>
      run().map((c) =>
        c.type === EventType.RUN_FINISHED
          ? {
              ...c,
              usage: {
                ...USAGE(),
                promptTokensDetails: { cachedTokens: 1000 },
              },
            }
          : c
      )
    );
    for await (const _ of openstoryText(inner, gateway).chatStream(OPTIONS)) {
      // drain
    }
    // 1,000 cached at $0.10/M = 100 micros, plus 100 out = 1,000.
    expect((await ledger()).charges).toEqual([1100]);
  });

  it('charges what streamed when cut off, and releases the rest', async () => {
    const inner = adapter(() => run());
    for await (const chunk of openstoryText(inner, gateway).chatStream(
      OPTIONS
    )) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) break;
    }
    const { charges, held } = await ledger();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toBeGreaterThan(0);
    expect(held).toBe(0);
  });

  it('charges nothing when the provider refuses before any content', async () => {
    const inner = adapter(() => [
      {
        type: EventType.RUN_ERROR,
        message: 'User location is not supported',
        timestamp: 0,
      },
    ]);
    for await (const _ of openstoryText(inner, gateway).chatStream(OPTIONS)) {
      // drain
    }
    expect(await ledger()).toEqual({ charges: [], held: 0, holds: 1 });
  });

  it('charges structured output once', async () => {
    const result = await openstoryText(
      adapter(() => []),
      gateway
    ).structuredOutput({ chatOptions: OPTIONS, outputSchema: {} });
    expect(chargedByGateway(result.usage)).toBe(true);
    expect((await ledger()).charges).toEqual([2000]);
  });

  it('refuses before the provider call when the organization cannot cover the hold', async () => {
    await db
      .update(credits)
      .set({ balance: 0 })
      .where(eq(credits.organizationId, organizationId));
    const inner = adapter(() => run());
    await expect(async () => {
      for await (const _ of openstoryText(inner, gateway).chatStream(OPTIONS)) {
        // drain
      }
    }).rejects.toThrow('Insufficient credits');
    expect(inner.calls).toBe(0);
  });

  it('charges each agent-loop turn of chat() once, and the marker reaches usage listeners', async () => {
    const inner = adapter(() => run(generateId()));
    const usages: TokenUsage[] = [];
    for await (const _ of chat({
      adapter: openstoryText(inner, gateway),
      threadId: 't',
      messages: [{ role: 'user', content: 'hi' }],
      middleware: [{ onUsage: (_ctx, usage) => void usages.push(usage) }],
    })) {
      // drain
    }
    expect(inner.calls).toBe(1);
    expect((await ledger()).charges).toEqual([2000]);
    expect(usages.length).toBeGreaterThan(0);
    expect(usages.every(chargedByGateway)).toBe(true);
  });
});

describe('withTextGateway', () => {
  const key = (
    source: 'organization' | 'platform',
    via: ResolvedLlmKey['via']
  ): ResolvedLlmKey => ({ key: 'k', source, via });
  const route = (resolved: ResolvedLlmKey) =>
    withTextGateway(
      { resolveLlmKey: async (_model?: string) => resolved },
      { db, organizationId, billing: gateway.billing }
    ).resolveLlmKey('vendor/model');

  beforeEach(async () => {
    await db.delete(gatewayModels);
    await storeGatewayModel(db, MODEL, new Date());
  });

  it('routes a platform OpenRouter key whose model has a card', async () => {
    const resolved = await route(key('platform', 'openrouter'));
    expect(resolved.gateway?.model.id).toBe('vendor/model');
  });

  it('leaves own keys, LLMTR and fal direct and uncharged', async () => {
    for (const resolved of [
      key('organization', 'openrouter'),
      key('organization', 'llmtr'),
      key('organization', 'xai'),
      key('platform', 'fal'),
    ]) {
      expect((await route(resolved)).gateway).toBeUndefined();
    }
  });

  it('stays direct when the snapshot has no card for the model', async () => {
    await db.delete(gatewayModels);
    expect(
      (await route(key('platform', 'openrouter'))).gateway
    ).toBeUndefined();
  });
});

describe('openstoryText over each route', () => {
  const finished = (usage: TokenUsage): AdapterYieldChunk[] =>
    run().map((c) => (c.type === EventType.RUN_FINISHED ? { ...c, usage } : c));

  it('prices OpenRouter web searches on the card lever', async () => {
    const inner = adapter(() =>
      finished({
        ...USAGE(),
        providerUsageDetails: {
          serverToolUseDetails: { webSearchRequests: 2 },
        },
      })
    );
    for await (const _ of openstoryText(inner, gateway).chatStream(OPTIONS)) {
      // drain
    }
    expect((await ledger()).charges).toEqual([22_000]);
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
    for await (const _ of openstoryText(spy, gateway).chatStream(options)) {
      // drain
    }
    expect(seen).toEqual([options]);
    expect(seen[0]).toBe(options);
    const [reservation] = await db
      .select({ amount: creditReservations.originalAmount })
      .from(creditReservations);
    // About 4,096 input tokens and 10 output at $1/M and $10/M, not 2M bytes.
    expect(reservation?.amount).toBeLessThan(5_000);
  });

  it('keeps the identity and capabilities of the real OpenRouter, xAI and Google adapters', () => {
    for (const inner of [
      createOpenRouterText('anthropic/claude-sonnet-5.5', 'k'),
      createGrokText('grok-4.7', 'k'),
      createGeminiChat('gemini-3.8-flash', 'k'),
    ]) {
      const wrapped = openstoryText(inner, gateway);
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
