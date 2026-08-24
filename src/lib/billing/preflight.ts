/**
 * Pre-flight Billing Check
 * Shared utility for server functions to verify credit availability
 * before triggering workflows. Skips check if team has own BYOK keys.
 */

import type { Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';

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

type Provider = 'fal' | 'openrouter';

/**
 * Keys that cover LLM calls without touching credits. fal routes LLM traffic
 * through its OpenRouter endpoint (#895); LLMTR fronts most of the registry
 * directly. Either one satisfies an `openrouter` requirement.
 */
const LLM_COVERAGE_PROVIDERS = ['fal', 'llmtr'] as const;

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
  } = {}
): Promise<void> {
  const providers = opts.providers ?? ['fal'];

  // Check if team has all required BYOK keys (any missing = need credits).
  // A fal or LLMTR key also satisfies the openrouter requirement — see
  // {@link LLM_COVERAGE_PROVIDERS}.
  // `hasUsableKey` (not `hasKey`): a key flagged invalid is skipped by
  // resolveKey/resolveLlmKey at call time — the platform key pays — so it
  // must not bypass the credit check here.
  const keyChecks = await Promise.all(
    providers.map(async (provider) => {
      if (await scopedDb.apiKeys.hasUsableKey(provider)) return true;
      if (provider !== 'openrouter') return false;
      const covers = await Promise.all(
        LLM_COVERAGE_PROVIDERS.map((p) => scopedDb.apiKeys.hasUsableKey(p))
      );
      return covers.some(Boolean);
    })
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
