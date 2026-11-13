/** `GET /api/v1/gateway/jobs/$id`: organization-scoped, so another organization's job is a 404. */

import { NotFoundError } from '@/platform/errors';
import { longPoll } from '@/platform/server/api-v1/wait';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayJob } from '@/platform/server/db/schema';
import {
  gatewayJobDocument,
  isTerminalGatewayJob,
  type GatewayJobResource,
} from '@/gateway/server/api-documents';

type GatewayJobsDb = Pick<ScopedDb, 'gatewayJobs'>;

/** The job's document, with the charge lines its organization paid once it succeeded. */
export async function gatewayJobResource(
  scopedDb: GatewayJobsDb,
  job: GatewayJob,
  origin: string
): Promise<GatewayJobResource> {
  const lines =
    job.status === 'succeeded'
      ? await scopedDb.gatewayJobs.getChargeLines(job.id)
      : [];
  return gatewayJobDocument(job, lines, origin);
}

export async function readGatewayJob(
  scopedDb: GatewayJobsDb,
  id: string,
  opts: { origin: string; waitMs: number; signal?: AbortSignal }
): Promise<GatewayJobResource> {
  const { value: job } = await longPoll({
    waitMs: opts.waitMs,
    signal: opts.signal,
    load: () => scopedDb.gatewayJobs.getById(id),
    cursor: (row) => (row ? `${row.status}:${row.updatedAt.getTime()}` : ''),
    done: (row) => !row || isTerminalGatewayJob(row),
  });
  if (!job) throw new NotFoundError('Gateway job not found');
  return gatewayJobResource(scopedDb, job, opts.origin);
}
