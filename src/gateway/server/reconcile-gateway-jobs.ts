/** The 5-minute cron's gateway pass: a job whose run and `onFailure` both died is ended here. */

import { getDb } from '#db-client';
import {
  resolveRunState,
  STALE_THRESHOLD_MS,
} from '@/platform/server/workflow/reconcile';
import {
  createGatewayJobsMethods,
  listStaleGatewayJobs,
} from '@/gateway/server/db/gateway-jobs';

const MAX_ROWS_PER_PASS = 100;

/** Ends each stale live job whose run is over; `markFailed` keeps a charged job succeeded. Returns how many. */
export async function reconcileGatewayJobs(): Promise<number> {
  const db = getDb();
  const stale = await listStaleGatewayJobs(
    db,
    new Date(Date.now() - STALE_THRESHOLD_MS),
    MAX_ROWS_PER_PASS
  );
  let ended = 0;
  for (const job of stale) {
    const state = await resolveRunState(job.runId);
    if (state === null || state === 'unknown') continue;
    await createGatewayJobsMethods(
      db,
      job.organizationId,
      job.userId
    ).markFailed(job.id, {
      code: 'GENERATION_FAILED',
      message: `Swept: the run is ${state} and wrote no outcome`,
    });
    ended++;
  }
  return ended;
}
