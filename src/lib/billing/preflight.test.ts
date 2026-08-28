/**
 * requireCredits BYOK bypass — a fal key must satisfy the openrouter
 * requirement too, since LLM calls route through fal's OpenRouter endpoint
 * (issue #895). Regression: fal-only teams were blocked with "Insufficient
 * credits for script enhancement".
 */

import { micros } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';
import { describe, expect, it, vi } from 'vitest';
import {
  releaseReservationOnThrow,
  requireCredits,
  reserveRunCredits,
} from './preflight';

function fakeScopedDb(opts: {
  keys: Array<'fal' | 'openrouter'>;
  invalidKeys?: Array<'fal' | 'openrouter'>;
  canAfford?: boolean;
}): ScopedDb {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal stub of the two methods requireCredits touches
  return {
    apiKeys: {
      hasUsableKey: (provider: 'fal' | 'openrouter') =>
        Promise.resolve(
          opts.keys.includes(provider) && !opts.invalidKeys?.includes(provider)
        ),
    },
    billing: {
      hasEnoughCredits: () => Promise.resolve(opts.canAfford ?? false),
      createReservation: () =>
        Promise.resolve(
          opts.canAfford
            ? {
                ok: true as const,
                reservationId: 'res_1',
                remaining: COST,
                replay: false,
              }
            : { ok: false as const }
        ),
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

  it('defaults to requiring a fal key when providers is omitted', async () => {
    await expect(
      requireCredits(fakeScopedDb({ keys: ['fal'] }), COST)
    ).resolves.toBeUndefined();
    await expect(
      requireCredits(fakeScopedDb({ keys: ['openrouter'] }), COST)
    ).rejects.toThrow(InsufficientCreditsError);
  });
});

describe('reserveRunCredits', () => {
  it('returns undefined for BYOK fal keys', async () => {
    const db = fakeScopedDb({ keys: ['fal'] });
    await expect(reserveRunCredits(db, COST)).resolves.toBeUndefined();
  });

  it('creates an envelope when the team can pay', async () => {
    const db = fakeScopedDb({ keys: [], canAfford: true });
    await expect(reserveRunCredits(db, COST)).resolves.toBe('res_1');
  });

  it('throws when available funds cannot cover the estimate', async () => {
    const db = fakeScopedDb({ keys: [] });
    await expect(reserveRunCredits(db, COST)).rejects.toThrow(
      InsufficientCreditsError
    );
  });
});

describe('releaseReservationOnThrow', () => {
  it('zeros the hold when the wrapped work throws', async () => {
    const zeroReservation = vi.fn().mockResolvedValue(undefined);

    await expect(
      releaseReservationOnThrow(
        { billing: { zeroReservation } },
        'res_1',
        async () => {
          throw new Error('trigger failed');
        }
      )
    ).rejects.toThrow('trigger failed');

    expect(zeroReservation).toHaveBeenCalledWith('res_1');
  });

  it('leaves the hold when the wrapped work succeeds', async () => {
    const zeroReservation = vi.fn().mockResolvedValue(undefined);

    await expect(
      releaseReservationOnThrow(
        { billing: { zeroReservation } },
        'res_1',
        async () => 'ok'
      )
    ).resolves.toBe('ok');

    expect(zeroReservation).not.toHaveBeenCalled();
  });

  it('still throws when there is no hold to release', async () => {
    const zeroReservation = vi.fn();

    await expect(
      releaseReservationOnThrow(
        { billing: { zeroReservation } },
        undefined,
        async () => {
          throw new Error('trigger failed');
        }
      )
    ).rejects.toThrow('trigger failed');

    expect(zeroReservation).not.toHaveBeenCalled();
  });
});
