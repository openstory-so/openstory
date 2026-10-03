/**
 * Read a workflow run's terminal outcome, including its returned output.
 *
 * `resolveRunState` (reconcile.ts) answers "is this row still in flight?" for
 * the cron sweep and deliberately discards the output. This is the other half:
 * user-facing callers that need to know *what the run reported* — how much
 * succeeded, what failed — and not merely that it stopped. Both are mappers
 * over `readInstanceStatus`, so they agree on what a missing instance means.
 *
 * The output is returned as `unknown` on purpose. Callers own its shape and
 * should validate it (zod) rather than have this helper assert a type it
 * cannot check.
 */

import { getEnv } from '#env';
import { disposeRpcStub } from './rpc-dispose';
import { isInstanceNotFoundError } from './errors';
import {
  getCfBindingForRunId,
  workflowNameFromRunId,
} from './trigger-bindings';
import type { CloudflareEnv } from './types';

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'run-outcome']);

export type WorkflowRunOutcome =
  /** Queued, running, paused or waiting — no verdict yet. */
  | { state: 'running' }
  /** Reached the end of `runImpl`; `output` is whatever it returned. */
  | { state: 'complete'; output: unknown }
  /** `errored` or `terminated`, or the instance no longer exists. */
  | { state: 'failed'; error: string }
  /**
   * The lookup itself failed, or the id doesn't map to a known binding (a
   * legacy run id, or the mock id `triggerWorkflow` hands back under
   * `E2E_TEST`). Distinct from `failed`: we have no verdict, so callers must
   * not report an error the user can't act on.
   */
  | { state: 'unknown' };

/**
 * Workflows that produce exactly ONE artifact — safe to terminate when that
 * artifact's pending claim is cancelled (#1085). Parent orchestrators
 * (update-stale-shots) are deliberately excluded: their run id is stamped on
 * every claim they own, and terminating the parent would kill sibling shots'
 * work. For parent-owned claims, cancellation is data-only — the running
 * child discards its output against the cancelled row's status guard.
 */
const SINGLE_ARTIFACT_WORKFLOWS = new Set(['shot-spec-rewrite', 'image']);

/**
 * Best-effort terminate of a single-artifact workflow run. Returns false —
 * never throws — when the id is empty, unknown, not a single-artifact
 * workflow, or the RPC fails; cancellation stays valid as a data-only state
 * in all of those cases.
 */
export async function terminateSingleArtifactRun(
  runId: string | null
): Promise<boolean> {
  if (!runId) return false;
  // Handles both top-level and parent-spawned child id shapes — an Update-all
  // chained image child IS a single-artifact run and must be terminable.
  const workflowName = workflowNameFromRunId(runId);
  if (!workflowName || !SINGLE_ARTIFACT_WORKFLOWS.has(workflowName)) {
    return false;
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const env = getEnv() as unknown as CloudflareEnv;
  const binding = getCfBindingForRunId(runId, env);
  if (!binding) return false;
  try {
    const instance = await binding.get(runId);
    try {
      await instance.terminate();
      return true;
    } finally {
      disposeRpcStub(instance);
    }
  } catch (error) {
    logger.warn(`Failed to terminate workflow run ${runId}:`, {
      data: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

export type InstanceRead =
  /** The engine's status; `error` is its `{ name, message }` flattened. */
  | { kind: 'read'; status: string; output: unknown; error: string | null }
  /** The id maps to no workflow binding (legacy id, E2E mock id). */
  | { kind: 'no_binding' }
  /** The lookup threw for a reason other than not-found; logged. */
  | { kind: 'unreadable' };

/**
 * The one read of a workflow instance's status. An instance the engine no
 * longer has (`instance.not_found`: retention ran out, or it lived in another
 * dev server) reads as `errored`: it is not running, and reading it as
 * unreadable left the generation mutex and pollers waiting on it for good.
 */
export async function readInstanceStatus(runId: string): Promise<InstanceRead> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const env = getEnv() as unknown as CloudflareEnv;
  const binding = getCfBindingForRunId(runId, env);
  if (!binding) return { kind: 'no_binding' };

  try {
    // `binding.get()` hands back a WorkflowInstance RPC result; dispose it
    // once the read is done so the runtime doesn't warn about a leaked result.
    const instance = await binding.get(runId);
    try {
      const { status, output, error } = await instance.status();
      return {
        kind: 'read',
        status,
        output,
        // Engine error shape is { name, message } — flatten it, same as
        // await-child.ts does at its step boundary.
        error: error ? `${error.name}: ${error.message}` : null,
      };
    } finally {
      disposeRpcStub(instance);
    }
  } catch (error) {
    if (isInstanceNotFoundError(error)) {
      return {
        kind: 'read',
        status: 'errored',
        output: undefined,
        error: 'Instance no longer exists',
      };
    }
    logger.error(`Failed to read workflow ${runId}:`, {
      data: error instanceof Error ? error.message : error,
    });
    return { kind: 'unreadable' };
  }
}

export async function getWorkflowRunOutcome(
  runId: string
): Promise<WorkflowRunOutcome> {
  if (runId === '') return { state: 'unknown' };
  const read = await readInstanceStatus(runId);
  if (read.kind !== 'read') return { state: 'unknown' };
  if (read.status === 'complete') {
    return { state: 'complete', output: read.output };
  }
  if (read.status === 'errored' || read.status === 'terminated') {
    return { state: 'failed', error: read.error ?? `Run ${read.status}` };
  }
  return { state: 'running' };
}
