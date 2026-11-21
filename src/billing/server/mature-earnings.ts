/**
 * Hourly earnings sweep (docs/architecture/model-gateway.md § Earnings).
 * A pending earning past its hold is claimed (pending → matured, guarded),
 * then credited to the payee's wallet under one idempotency key per
 * earning, so a repeated or concurrent sweep credits it exactly once. A
 * claim whose credit was lost is retried by the next sweep under the same key.
 */

import { getDb } from '#db-client';
import { type Microdollars, micros } from '@/billing/money';
import { createBillingMethods } from '@/billing/server/db/billing';
import {
  claimDueEarning,
  findEarningCredit,
  listDueEarningIds,
  listUncreditedEarnings,
  recordEarningCredit,
  type ClaimedEarning,
} from '@/billing/server/db/earnings';
import type { Database } from '@/platform/server/db/client';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cron', 'mature-earnings']);

/**
 * Cron expression — must match `wrangler.jsonc` `triggers.crons` (default AND
 * production blocks); `scheduled()` in `src/server.ts` routes on it.
 */
export const MATURE_EARNINGS_CRON = '11 * * * *';

/** Earnings per sweep; the rest wait an hour. */
const BATCH = 200;
/** A claim this old with no credit recorded is retried. */
const RETRY_AFTER_MS = 10 * 60 * 1000;

/** The billing methods take a user; a sweep acts as none and writes null. */
const NO_USER = '';

export type MatureEarningsSummary = {
  matured: number;
  credited: Microdollars;
  retried: number;
};

async function credit(db: Database, earning: ClaimedEarning): Promise<number> {
  const billing = createBillingMethods(
    db,
    earning.payeeOrganizationId,
    NO_USER
  );
  const transactionId = await billing.creditEarning(earning);
  if (transactionId) return earning.amountMicros;
  // Nothing written: a credit under the key already landed, so link it.
  const prior = await findEarningCredit(db, earning);
  if (prior) await recordEarningCredit(db, earning.id, prior);
  return 0;
}

export async function matureEarnings(
  deps: { db?: Database; now?: Date } = {}
): Promise<MatureEarningsSummary> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const summary: MatureEarningsSummary = {
    matured: 0,
    credited: micros(0),
    retried: 0,
  };
  const creditOrLog = async (earning: ClaimedEarning) => {
    try {
      summary.credited = micros(summary.credited + (await credit(db, earning)));
    } catch (error) {
      // Claimed and uncredited: the next sweep retries it under the same key.
      logger.error('earning credit failed', {
        earningId: earning.id,
        err: error,
      });
    }
  };
  for (const id of await listDueEarningIds(db, now, BATCH)) {
    const claimed = await claimDueEarning(db, id, now);
    if (!claimed) continue;
    summary.matured += 1;
    await creditOrLog(claimed);
  }
  const stale = new Date(now.getTime() - RETRY_AFTER_MS);
  for (const earning of await listUncreditedEarnings(db, stale, BATCH)) {
    summary.retried += 1;
    await creditOrLog(earning);
  }
  logger.info('earnings matured', summary);
  return summary;
}
