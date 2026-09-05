/**
 * Shared helper for resolving a stale workflow run via Cloudflare Workflows.
 *
 * Used by the cron-driven sweep in `src/lib/cron/reconcile-all.ts`, which
 * is the single source of truth for healing rows stuck in 'generating' /
 * 'merging' / 'analyzing'. Most failures self-heal — the workflow base class
 * writes a terminal status on error — so this only catches rows whose
 * workflow died without persisting its outcome.
 */

import { getEnv } from '#env';
import { getCfBindingForRunId } from '@/lib/workflow/trigger-bindings';
import { disposeRpcStub } from '@/lib/workflow/rpc-dispose';
import type { CloudflareEnv } from '@/lib/workflow/types';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'reconcile']);

export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Resolve a stale workflow run via its Cloudflare Workflow instance status.
 *
 * Returns:
 *   - 'failed'    when the runId is empty, or doesn't resolve to a known
 *                 workflow binding (e.g. a legacy QStash run id from before the
 *                 cutover — the row is already stale, so fail it for retry),
 *                 or the instance reports `errored` / `terminated`.
 *   - 'completed' when the instance reports `complete`.
 *   - null        when the instance is genuinely still in flight
 *                 (queued/running/paused/waiting).
 *   - 'unknown'   when the status lookup itself threw (transient API blip or
 *                 evicted instance) — we can't say whether a run is live.
 *                 Errors are logged, not propagated.
 *
 * Both `null` and `'unknown'` mean "don't write a terminal status", but
 * callers that surface state to users (the generation mutex) must not claim
 * a run is in progress on `'unknown'` — there may be no run at all.
 * Reconciler passes treat both as "skip and retry next sweep."
 */
export async function resolveRunState(
  runId: string
): Promise<'failed' | 'completed' | 'unknown' | null> {
  if (runId === '') return 'failed';

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const env = getEnv() as unknown as CloudflareEnv;
  const binding = getCfBindingForRunId(runId, env);
  if (!binding) return 'failed';

  try {
    // `binding.get()` hands back a WorkflowInstance RPC result; dispose it once
    // the status read is done so the runtime doesn't warn about a leaked result.
    const instance = await binding.get(runId);
    try {
      const { status } = await instance.status();
      if (status === 'complete') return 'completed';
      if (status === 'errored' || status === 'terminated') return 'failed';
      return null;
    } finally {
      disposeRpcStub(instance);
    }
  } catch (error) {
    logger.error(`Failed to check workflow ${runId}:`, {
      data: error instanceof Error ? error.message : error,
    });
    return 'unknown';
  }
}
