import { getEnv } from '#env';
import {
  getCfBindingForTriggerPath,
  triggerCfWorkflow,
} from '@/lib/workflow/trigger-bindings';
import type { CloudflareEnv } from '@/lib/workflow/types';
import {
  assertCanGenerate,
  assertCanWrite,
  resolveEnforcementState,
  type EnforcementRow,
} from '@/lib/compliance/enforcement';
import { loadComplianceRecords } from '@/lib/db/scoped';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'client']);

/**
 * Triggers that produce nothing new and so survive a generation pause.
 *
 * An export stitches assets the account already made and already paid for.
 * Blocking it under `generation_suspended` would mean a portrait complaint about
 * one clip also holds the user's unrelated finished work hostage — which is the
 * disproportionality the separate `generation_suspended` /
 * `account_suspended` rungs exist to avoid. These still require write access,
 * so a fully suspended (read-only) account cannot run them.
 */
const WRITE_ONLY_TRIGGERS = new Set(['sequence-export']);

/**
 * Refuse to start durable work for a restricted account.
 *
 * Reads the account's enforcement rows and resolves them with the shared
 * policy, so this agrees with the banner the user sees and with the gate at the
 * entry points. Throws `AccountRestrictedError` (403).
 *
 * **This is a live D1 read.** Request-path callers load via
 * `loadComplianceRecords`. Mid-run callers (regenerate-shots, scene-split,
 * shot-images) pass rows from `scopedDb.liveRead.compliance.listEnforcementFor`
 * so the read is catalogued as a spawn-time billing guard. The ban must stop
 * work that has not started yet. Suspending an account mid-fan-out fails the
 * parent with children partly spawned — correct for a ban. Child spawns via
 * `spawnAndAwaitChild` use `binding.create()` directly and are not gated here.
 */
async function assertTriggerAllowed(
  urlPath: string,
  body: { userId: string; teamId: string },
  enforcementRows?: readonly EnforcementRow[]
): Promise<void> {
  const enforcement =
    enforcementRows ??
    (await loadComplianceRecords(body.userId, body.teamId)).enforcement;
  const state = resolveEnforcementState(enforcement);
  const key = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  if (WRITE_ONLY_TRIGGERS.has(key)) {
    assertCanWrite(state);
    return;
  }
  assertCanGenerate(state);
}

/**
 * Trigger a durable workflow.
 *
 * Every workflow runs on Cloudflare Workflows: this resolves the binding for
 * `urlPath` and calls `binding.create()`. Returns the workflow instance id
 * (persisted as `workflowRunId` on the relevant DB row).
 *
 * `options.deduplicationId` becomes the instance id suffix — pass a stable
 * value to make a trigger idempotent. `label`/`retries`/`retryDelay` are
 * accepted for backwards-compatibility with existing call sites but are no-ops
 * under Cloudflare Workflows (retry policy is configured per `step.do`/on the
 * workflow class; observability comes from the instance id + tail logs).
 */
export async function triggerWorkflow<
  T extends { userId: string; teamId: string },
>(
  urlPath: string,
  body: T,
  options?: {
    deduplicationId?: string;
    label?: string;
    retries?: number;
    retryDelay?: string;
    /**
     * Mid-run: rows from `scopedDb.liveRead.compliance.listEnforcementFor`.
     * Request-path callers omit this and the gate loads the rows itself.
     */
    enforcement?: readonly EnforcementRow[];
  }
): Promise<string> {
  logger.info('[TriggerWorkflow]', { url: urlPath, body, options });

  // Enforcement backstop (#1180). Every generation in the app funnels through
  // here, and the payload carries `userId`/`teamId` by contract — so this is the
  // one place a restricted account cannot start durable work.
  await assertTriggerAllowed(urlPath, body, options?.enforcement);

  const env = getEnv();
  if (env.E2E_TEST === 'true' && env.E2E_FULL_PIPELINE !== 'true') {
    const mockId = options?.deduplicationId ?? `mock-${Date.now()}`;
    logger.info(`Skipping workflow trigger: ${urlPath} (mock ID: ${mockId})`);
    return mockId;
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const cfEnv = env as unknown as CloudflareEnv;
  const binding = getCfBindingForTriggerPath(urlPath, cfEnv);
  const result = await triggerCfWorkflow({
    binding,
    triggerPath: urlPath,
    body,
    env: cfEnv,
    deduplicationId: options?.deduplicationId,
  });
  logger.info('[TriggerWorkflow] Response', { result });
  return result.workflowRunId;
}
