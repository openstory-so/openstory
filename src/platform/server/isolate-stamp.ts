/**
 * One id per isolate, logged on each invocation so a memory death can be
 * joined to the other requests that shared the heap (#1894).
 *
 * Workers hold console output until the request ends, and a finished request
 * has already flushed under outcome ok. The line has to be written on that
 * request, before it awaits. Cloudflare attaches the URL to a fetch's log
 * record, so the message carries only the id — no path, no channel id.
 *
 * Workerd rejects `crypto.randomUUID()` at module scope, so the id is minted
 * on the first handler call and reused for the life of the isolate.
 */

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'isolate']);

let cachedIsolateId: string | undefined;

/** Stable for the life of this isolate. A new isolate mints a new one. */
export function getIsolateId(): string {
  cachedIsolateId ??= crypto.randomUUID();
  return cachedIsolateId;
}

/** `label` names invocations that carry no URL: `cron`, `workflow:<Class>`. */
export function logIsolateStamp(label?: string): void {
  const isolateId = getIsolateId();
  logger.info(
    label ? `[isolate] ${isolateId} ${label}` : `[isolate] ${isolateId}`,
    {
      isolateId,
    }
  );
}
