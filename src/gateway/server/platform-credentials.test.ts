/**
 * A gateway job spends platform keys only. The credentials hold no database
 * handle, so an organization's own key cannot be reached; the workflow source
 * never touches `scopedDb.credentials` or `scopedDb.apiKeys`.
 */

import { readFileSync } from 'node:fs';
import type { AnyTextAdapter } from '@tanstack/ai';
import { describe, expect, it, vi } from 'vitest';

const env: Record<string, string | undefined> = {
  FAL_KEY: 'platform-fal',
  GEMINI_API_KEY: 'platform-gemini',
  XAI_API_KEY: '',
  OPENROUTER_KEY: 'platform-openrouter',
};
vi.doMock('#env', () => ({ getEnv: () => env }));

const { platformOnlyCredentials } = await import('./platform-credentials');

describe('platformOnlyCredentials', () => {
  const credentials = platformOnlyCredentials({
    organizationId: 'org-1',
    userId: 'user-1',
  });

  it('resolves the platform key, marked platform', async () => {
    expect(await credentials.resolveKey('fal')).toEqual({
      key: 'platform-fal',
      source: 'platform',
    });
    expect(await credentials.resolveOptionalKey('google')).toEqual({
      key: 'platform-gemini',
      source: 'platform',
    });
  });

  it('never falls back to an organization key the platform lacks', async () => {
    expect(await credentials.resolveOptionalKey('xai')).toBeUndefined();
    expect(await credentials.resolveOptionalKey('llmtr')).toBeUndefined();
    await expect(credentials.resolveKey('xai')).rejects.toThrow(
      'No platform key for provider: xai'
    );
  });

  it('carries the run identity and nothing else', () => {
    expect(Object.keys(credentials).sort()).toEqual([
      'organizationId',
      'resolveKey',
      'resolveOptionalKey',
      'userId',
    ]);
  });
});

describe('gateway sources', () => {
  it('never reach organization credentials', () => {
    for (const path of [
      'src/gateway/server/workflows/gateway-generation-workflow.ts',
      'src/gateway/server/submit-job.ts',
      'src/gateway/server/providers.ts',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/scopedDb\s*\.\s*credentials/);
      expect(source, path).not.toMatch(/scopedDb\s*\.\s*apiKeys/);
    }
  });
});

describe('withPlatformLlmKey (the gateway submit likeness check)', () => {
  it('charges the organization once per checked URL, on the platform key', async () => {
    const { createTestDb } = await import('@/platform/server/db/test-d1');
    const { createBillingMethods } =
      await import('@/billing/server/db/billing');
    const { credits, organization, transactions, user } =
      await import('@/platform/server/db/schema');
    const { generateId } = await import('@/platform/id');
    const { eq } = await import('drizzle-orm');
    const { EventType } = await import('@tanstack/ai');
    const { resolveDebugOption } =
      await import('@tanstack/ai/adapter-internals');
    const { chargedOnceAs, openstoryText, withTextGateway } =
      await import('./text');
    const { withPlatformLlmKey } = await import('./platform-credentials');

    const { db, close } = await createTestDb();
    try {
      const organizationId = generateId();
      const userId = generateId();
      await db
        .insert(organization)
        .values({ id: organizationId, name: 'T', slug: organizationId });
      await db
        .insert(user)
        .values({ id: userId, name: 'U', email: `${userId}@example.com` });
      await db.insert(credits).values({ organizationId, balance: 10_000_000 });
      const billing = createBillingMethods(db, organizationId, userId);
      const apiKeys = withTextGateway(
        {
          // The organization's own key: the likeness check must never spend it.
          resolveLlmKey: async (_model?: string) => ({
            key: 'org-openrouter',
            source: 'organization' as const,
            via: 'openrouter' as const,
            meter: { uncharged: 'own key' as const },
          }),
        },
        { db, organizationId, billing }
      );

      const key = await withPlatformLlmKey({ apiKeys }).apiKeys.resolveLlmKey(
        'vendor/model'
      );
      expect(key.key).toBe('platform-openrouter');
      expect('uncharged' in key.meter).toBe(false);

      const once = chargedOnceAs(key, 'likeness:https://example.com/a.png');
      const usage = {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        cost: 0.0015,
      };
      const inner: AnyTextAdapter = {
        kind: 'text' as const,
        name: 'fake',
        model: 'vendor/model',
        '~types': {
          providerOptions: {},
          inputModalities: ['text'],
          messageMetadataByModality: {},
          toolCapabilities: {},
          toolCallMetadata: {},
          systemPromptMetadata: {},
        },
        async *chatStream() {
          yield {
            type: EventType.RUN_FINISHED,
            runId: 'r',
            threadId: 't',
            timestamp: 0,
            finishReason: 'stop' as const,
            usage,
          };
        },
        async structuredOutput() {
          return { data: {}, rawText: '{}', usage };
        },
      };
      // A repeated check of the same upload is charged once.
      for (let i = 0; i < 2; i++) {
        if ('uncharged' in once.meter) throw new Error('unmetered');
        for await (const _ of openstoryText(
          inner,
          once.meter,
          'vendor/model'
        ).chatStream({
          model: 'vendor/model',
          messages: [{ role: 'user', content: 'hi' }],
          modelOptions: { maxTokens: 100 },
          threadId: 't',
          logger: resolveDebugOption(false),
        })) {
          // drain
        }
      }
      const rows = await db
        .select({ amount: transactions.amount })
        .from(transactions)
        .where(eq(transactions.organizationId, organizationId));
      expect(rows.map((r) => -r.amount)).toEqual([1500]);
    } finally {
      await close();
    }
  });
});
