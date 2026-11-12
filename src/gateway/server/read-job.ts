/** `GET /api/v1/gateway/jobs/$id`: organization-scoped, so another organization's job is a 404. */

import { NotFoundError } from '@/platform/errors';
import { longPoll } from '@/platform/server/api-v1/wait';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  gatewayJobDocument,
  isTerminalGatewayJob,
  type GatewayJobResource,
} from '@/gateway/server/api-documents';

export async function readGatewayJob(
  scopedDb: Pick<ScopedDb, 'gatewayJobs'>,
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
  return gatewayJobDocument(job, opts.origin);
}
