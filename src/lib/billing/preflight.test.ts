/**
 * requireCredits BYOK bypass — a fal key must satisfy the openrouter
 * requirement too, since LLM calls route through fal's OpenRouter endpoint
 * (issue #895). Regression: fal-only teams were blocked with "Insufficient
 * credits for script enhancement". An LLMTR key covers the same requirement:
 * it fronts most of the registry directly.
 */

import { micros } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';
import { describe, expect, it } from 'vitest';
import { requireCredits } from './preflight';

type StubProvider = 'fal' | 'openrouter' | 'llmtr';

function fakeScopedDb(opts: {
  keys: Array<StubProvider>;
  invalidKeys?: Array<StubProvider>;
  canAfford?: boolean;
}): ScopedDb {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal stub of the two methods requireCredits touches
  return {
    apiKeys: {
      hasUsableKey: (provider: StubProvider) =>
        Promise.resolve(
          opts.keys.includes(provider) && !opts.invalidKeys?.includes(provider)
        ),
    },
    billing: {
      hasEnoughCredits: () => Promise.resolve(opts.canAfford ?? false),
    },
  } as unknown as ScopedDb;
}

const COST = micros(1000);

describe('requireCredits BYOK coverage', () => {
  it('passes with only a fal key when openrouter is required (routes via fal)', async () => {
    const db = fakeScopedDb({ keys: ['fal'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('still requires credits when only an openrouter key exists but fal is required', async () => {
    const db = fakeScopedDb({ keys: ['openrouter'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('passes with both keys', async () => {
    const db = fakeScopedDb({ keys: ['fal', 'openrouter'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('falls through to the credit check (and passes) when affordable', async () => {
    const db = fakeScopedDb({ keys: [], canAfford: true });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('throws the custom message when no keys and no credits', async () => {
    const db = fakeScopedDb({ keys: [] });
    await expect(
      requireCredits(db, COST, {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to create sequences',
      })
    ).rejects.toThrow('Insufficient credits to create sequences');
  });

  it('does not let an invalid fal key bypass the credit check', async () => {
    // An invalid key is skipped by resolveKey/resolveLlmKey at call time —
    // the platform key would pay — so preflight must fall through to credits.
    const db = fakeScopedDb({ keys: ['fal'], invalidKeys: ['fal'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('passes with only a fal key for an LLM-only preflight', async () => {
    const db = fakeScopedDb({ keys: ['fal'] });
    await expect(
      requireCredits(db, COST, { providers: ['openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('passes with only an LLMTR key when openrouter is required', async () => {
    const db = fakeScopedDb({ keys: ['llmtr'] });
    await expect(
      requireCredits(db, COST, { providers: ['openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('still requires credits for fal work when only an LLMTR key exists', async () => {
    // LLMTR covers LLM calls, not image/video/audio — those are fal's.
    const db = fakeScopedDb({ keys: ['llmtr'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('does not let an invalid LLMTR key bypass the credit check', async () => {
    const db = fakeScopedDb({ keys: ['llmtr'], invalidKeys: ['llmtr'] });
    await expect(
      requireCredits(db, COST, { providers: ['openrouter'] })
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('defaults to requiring a fal key when providers is omitted', async () => {
    await expect(
      requireCredits(fakeScopedDb({ keys: ['fal'] }), COST)
    ).resolves.toBeUndefined();
    await expect(
      requireCredits(fakeScopedDb({ keys: ['openrouter'] }), COST)
    ).rejects.toThrow(InsufficientCreditsError);
  });
});
