import { FREE_SEQUENCE_LIMIT } from '@/billing/free-sketch';
import type { ScopedDb } from '@/platform/server/db/scoped';

export type FundsDb = {
  apiKeys: Pick<ScopedDb['apiKeys'], 'hasUsableKey'>;
  billing: Pick<ScopedDb['billing'], 'getAvailable' | 'getBillingSettings'>;
};

/** No credits, no fal key, no auto top-up: the same test as the client billing gate. */
export async function isUnfunded(scopedDb: FundsDb): Promise<boolean> {
  const [funds, hasFalKey, settings] = await Promise.all([
    scopedDb.billing.getAvailable(),
    scopedDb.apiKeys.hasUsableKey('fal'),
    scopedDb.billing.getBillingSettings(),
  ]);
  const hasAutoTopUp =
    settings.autoTopUpEnabled &&
    !!settings.stripeCustomerId &&
    !settings.autoTopUpFailedAt;
  return funds.available <= 0 && !hasFalKey && !hasAutoTopUp;
}

/** Free sketches this organization may still start; 0 once it has funds. */
export async function freeSequencesLeft(scopedDb: FundsDb): Promise<number> {
  if (!(await isUnfunded(scopedDb))) return 0;
  const { freeSequencesUsed } = await scopedDb.billing.getBillingSettings();
  return Math.max(FREE_SEQUENCE_LIMIT - freeSequencesUsed, 0);
}
