/**
 * Read a workflow run's terminal outcome, including its returned output.
 *
 * `resolveRunState` (reconcile.ts) answers "is this row still in flight?" for
 * the cron sweep and deliberately discards the output. This is the other half:
 * user-facing callers that need to know *what the run reported* — how much
 * succeeded, what failed — and not merely that it stopped.
 *
 * The output is returned as `unknown` on purpose. Callers own its shape and
 * should validate it (zod) rather than have this helper assert a type it
 * cannot check.
 */

import { getEnv } from '#env';
import { disposeRpcStub } from '@/lib/workflow/rpc-dispose';
import { getCfBindingForRunId } from '@/lib/workflow/trigger-bindings';
import type { CloudflareEnv } from '@/lib/workflow/types';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'run-outcome']);

export type WorkflowRunOutcome =
  /** Queued, running, paused or waiting — no verdict yet. */
  | { state: 'running' }
  /** Reached the end of `runImpl`; `output` is whatever it returned. */
  | { state: 'complete'; output: unknown }
  /** `errored` or `terminated`. */
  | { state: 'failed'; error: string }
  /**
   * The lookup itself failed, or the id doesn't map to a known binding (a
   * legacy run id, or the mock id `triggerWorkflow` hands back under
   * `E2E_TEST`). Distinct from `failed`: we have no verdict, so callers must
   * not report an error the user can't act on.
   */
  | { state: 'unknown' };

export async function getWorkflowRunOutcome(
  runId: string
): Promise<WorkflowRunOutcome> {
  if (runId === '') return { state: 'unknown' };

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const env = getEnv() as unknown as CloudflareEnv;
  const binding = getCfBindingForRunId(runId, env);
  if (!binding) return { state: 'unknown' };

  try {
    // `binding.get()` hands back a WorkflowInstance RPC result; dispose it
    // once the read is done so the runtime doesn't warn about a leaked result.
    const instance = await binding.get(runId);
    try {
      const { status, output, error } = await instance.status();
      if (status === 'complete') return { state: 'complete', output };
      if (status === 'errored' || status === 'terminated') {
        // Engine error shape is { name, message } — flatten it, same as
        // await-child.ts does at its step boundary.
        return {
          state: 'failed',
          error: error ? `${error.name}: ${error.message}` : `Run ${status}`,
        };
      }
      return { state: 'running' };
    } finally {
      disposeRpcStub(instance);
    }
  } catch (error) {
    logger.error(`Failed to read workflow outcome for ${runId}:`, {
      data: error instanceof Error ? error.message : error,
    });
    return { state: 'unknown' };
  }
}
