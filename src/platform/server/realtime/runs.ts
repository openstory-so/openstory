/**
 * Open workflow runs on a sequence's realtime channel (#2113).
 *
 * The Durable Object keeps the rows. These helpers are the only callers:
 * the workflow base reports start and end, and the chip reads the list
 * after the stream connects. A report throws; the base retries inside the
 * step and then swallows, so the generation still finishes. A failed read
 * returns null so the chip keeps the list it already has. An empty array
 * means no open runs.
 */

import { getEnv } from '#env';

import type { WorkflowRun } from '@/platform/realtime/schema';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'realtime', 'runs']);

function channelStub(channel: string) {
  const namespace = getEnv().REALTIME;
  return namespace.get(namespace.idFromName(channel));
}

async function postRun(
  channel: string,
  path: 'started' | 'ended',
  body: unknown
): Promise<void> {
  const response = await channelStub(channel).fetch(
    `https://realtime.do/runs/${path}?channel=${encodeURIComponent(channel)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    throw new Error(
      `realtime run ${path} failed for "${channel}" (${response.status})`
    );
  }
}

export async function reportRunStarted(
  channel: string,
  run: WorkflowRun
): Promise<void> {
  await postRun(channel, 'started', run);
}

export async function reportRunEnded(
  channel: string,
  instanceId: string
): Promise<void> {
  await postRun(channel, 'ended', { instanceId });
}

export async function getChannelRuns(
  channel: string
): Promise<WorkflowRun[] | null> {
  try {
    const response = await channelStub(channel).fetch(
      `https://realtime.do/runs?channel=${encodeURIComponent(channel)}`
    );
    if (!response.ok) {
      logger.warn(`realtime runs fetch failed for "${channel}"`, {
        status: response.status,
      });
      return null;
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      logger.warn(`realtime runs fetch returned a non-array for "${channel}"`);
      return null;
    }
    return body.flatMap((row) => (isWorkflowRun(row) ? [row] : []));
  } catch (error) {
    logger.warn(`realtime runs fetch threw for "${channel}"`, { err: error });
    return null;
  }
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (typeof value !== 'object' || value === null) return false;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- narrowed to a non-null object; fields are checked below
  const row = value as Record<string, unknown>;
  return (
    typeof row.instanceId === 'string' &&
    typeof row.binding === 'string' &&
    typeof row.className === 'string' &&
    typeof row.label === 'string' &&
    (row.parentInstanceId === null ||
      typeof row.parentInstanceId === 'string') &&
    typeof row.startedAt === 'number'
  );
}
