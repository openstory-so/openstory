/**
 * Pre-flight Billing Check
 * Shared utility for server functions to verify credit availability
 * before triggering workflows. Skips check if team has own BYOK keys.
 */

import { llmtrTextModel } from '@/lib/ai/llmtr';
import type { Microdollars } from '@/shared/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/shared/errors';
import { generateId } from '@/shared/id';
import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'billing', 'preflight']);

/**
 * The two live checks a preflight makes: whether the team can pay, and whether
 * it has its own key (in which case it doesn't need to). Narrowed so a
 * workflow passes `scopedDb.liveRead` — a balance read at charge time is one
 * of the sanctioned live reads.
 */
export type PreflightScopedDb = {
  apiKeys: Pick<ScopedDb['apiKeys'], 'hasUsableKey'>;
  billing: Pick<ScopedDb['billing'], 'hasEnoughCredits'>;
};

type ReservationPreflightScopedDb = {
  apiKeys: Pick<ScopedDb['apiKeys'], 'hasUsableKey'>;
  billing: Pick<ScopedDb['billing'], 'hasEnoughCredits' | 'createReservation'>;
};

type Provider = 'fal' | 'openrouter';

async function coversProvider(
  scopedDb: PreflightScopedDb,
  provider: Provider,
  llmModel?: string
): Promise<boolean> {
  if (await scopedDb.apiKeys.hasUsableKey(provider)) return true;
  if (provider !== 'openrouter') return false;
  if (await scopedDb.apiKeys.hasUsableKey('fal')) return true;
  // LLMTR only covers models it actually maps. Fal's OpenRouter proxy
  // carries the whole registry; LLMTR does not.
  if (!llmModel || !llmtrTextModel(llmModel)) return false;
  return scopedDb.apiKeys.hasUsableKey('llmtr');
}

/**
 * Verify a team can afford a generation before triggering it.
 * Skips the check entirely if the team has BYOK keys for all required providers.
 *
 * @param scopedDb - Scoped DB context for the team
 * @param estimatedCostMicros - Estimated raw cost in Microdollars
 * @param providers - Which BYOK providers bypass the check (default: ['fal'])
 * @param errorMessage - Custom error message for insufficient credits
 *
 * @throws InsufficientCreditsError if team lacks credits and has no BYOK keys
 */
export async function requireCredits(
  scopedDb: PreflightScopedDb,
  estimatedCostMicros: Microdollars,
  opts: {
    providers?: Provider[];
    errorMessage?: string;
    llmModel?: string;
  } = {}
): Promise<void> {
  const providers = opts.providers ?? ['fal'];

  // `hasUsableKey` (not `hasKey`): a key flagged invalid is skipped by
  // resolveKey/resolveLlmKey at call time — the platform key pays — so it
  // must not bypass the credit check here.
  const keyChecks = await Promise.all(
    providers.map((provider) =>
      coversProvider(scopedDb, provider, opts.llmModel)
    )
  );
  const hasAllKeys = keyChecks.every(Boolean);

  if (hasAllKeys) return;

  const canAfford =
    await scopedDb.billing.hasEnoughCredits(estimatedCostMicros);
  if (!canAfford) {
    throw new InsufficientCreditsError(
      opts.errorMessage ?? 'Insufficient credits'
    );
  }
}

/**
 * Create a run envelope instead of a read-only preflight. Returns undefined
 * when BYOK skips the hold. Throws InsufficientCreditsError if available
 * funds cannot cover the estimate.
 */
export async function reserveRunCredits(
  scopedDb: ReservationPreflightScopedDb,
  estimatedCostMicros: Microdollars,
  opts: {
    providers?: Provider[];
    errorMessage?: string;
    sequenceId?: string;
    idempotencyKey?: string;
    llmModel?: string;
  } = {}
): Promise<string | undefined> {
  const providers = opts.providers ?? ['fal'];
  const keyChecks = await Promise.all(
    providers.map((provider) =>
      coversProvider(scopedDb, provider, opts.llmModel)
    )
  );
  if (keyChecks.every(Boolean)) return undefined;

  const result = await scopedDb.billing.createReservation(estimatedCostMicros, {
    idempotencyKey: opts.idempotencyKey ?? generateId(),
    sequenceId: opts.sequenceId,
  });
  if (!result.ok) {
    throw new InsufficientCreditsError(
      opts.errorMessage ?? 'Insufficient credits'
    );
  }
  return result.reservationId;
}

type ReservationReleaseDb = {
  billing: Pick<ScopedDb['billing'], 'zeroReservation'>;
};

/**
 * Zero this hold if work after `reserveRunCredits` throws. On success,
 * leftover stays for the run to capture; release is the parent's
 * success/`onFailure` path, not this helper.
 */
export async function releaseReservationOnThrow<T>(
  scopedDb: ReservationReleaseDb,
  reservationId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (reservationId) {
      try {
        await scopedDb.billing.zeroReservation(reservationId);
      } catch (releaseError) {
        logger.error('Failed to zero reservation after trigger error', {
          err: releaseError,
          reservationId,
        });
      }
    }
    throw error;
  }
}
