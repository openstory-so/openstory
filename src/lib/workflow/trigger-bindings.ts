/**
 * Maps trigger paths (the URL fragment passed to `triggerWorkflow`) to the
 * env binding name declared in `wrangler.jsonc`. Every workflow is a
 * Cloudflare Workflow — `triggerWorkflow` resolves the binding here and calls
 * `binding.create()`.
 *
 * To add a new workflow:
 *   1. Add the `class_name` + `binding` to `wrangler.jsonc` under `workflows[]`
 *   2. Re-export the entrypoint class from `src/server.ts` so the bundler
 *      includes it.
 *   3. Add an entry here.
 */

import type { CloudflareEnv } from '@/lib/workflow/types';
import { isInstanceAlreadyExistsError } from '@/lib/workflow/errors';
import { buildInstanceId } from '@/lib/workflow/instance-id';
import { disposeRpcStub } from '@/lib/workflow/rpc-dispose';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'trigger-bindings']);

const TRIGGER_TO_BINDING: Record<string, keyof CloudflareEnv> = {
  image: 'IMAGE_WORKFLOW',
  'element-vision': 'ELEMENT_VISION_WORKFLOW',
  'element-sheet': 'ELEMENT_SHEET_WORKFLOW',
  music: 'MUSIC_WORKFLOW',
  motion: 'MOTION_WORKFLOW',
  'motion-batch': 'MOTION_BATCH_WORKFLOW',
  'character-sheet': 'CHARACTER_SHEET_WORKFLOW',
  'location-sheet': 'LOCATION_SHEET_WORKFLOW',
  'library-talent-sheet': 'LIBRARY_TALENT_SHEET_WORKFLOW',
  'library-location-sheet': 'LIBRARY_LOCATION_SHEET_WORKFLOW',
  'variant-image': 'SHOT_VARIANT_WORKFLOW',
  'upscale-variant': 'UPSCALE_SHOT_VARIANT_WORKFLOW',
  'frame-prompt': 'FRAME_PROMPT_WORKFLOW',
  'motion-prompt': 'MOTION_PROMPT_WORKFLOW',
  'music-prompt': 'MUSIC_PROMPT_WORKFLOW',
  'recast-character': 'RECAST_CHARACTER_WORKFLOW',
  'location-matching': 'LOCATION_MATCHING_WORKFLOW',
  'shot-images': 'SHOT_IMAGES_WORKFLOW',
  'talent-matching': 'TALENT_MATCHING_WORKFLOW',
  'character-sheet-from-bible': 'CHARACTER_BIBLE_WORKFLOW',
  'location-sheet-from-bible': 'LOCATION_BIBLE_WORKFLOW',
  'frame-prompts-batch': 'FRAME_PROMPT_BATCH_WORKFLOW',
  'motion-prompts-batch': 'MOTION_PROMPT_BATCH_WORKFLOW',
  'motion-music-prompts': 'MOTION_MUSIC_PROMPTS_WORKFLOW',
  'regenerate-shots': 'REGENERATE_SHOTS_WORKFLOW',
  'update-stale-shots': 'UPDATE_STALE_SHOTS_WORKFLOW',
  'recast-location': 'RECAST_LOCATION_WORKFLOW',
  'replace-element': 'REPLACE_ELEMENT_WORKFLOW',
  'scene-split': 'SCENE_SPLIT_WORKFLOW',
  storyboard: 'STORYBOARD_WORKFLOW',
  'analyze-script': 'ANALYZE_SCRIPT_WORKFLOW',
  'sequence-export': 'SEQUENCE_EXPORT_WORKFLOW',
  asset: 'ASSET_WORKFLOW',
};

export type CfTriggerResult = { workflowRunId: string };

function normaliseTriggerPath(triggerPath: string): string {
  return triggerPath.startsWith('/') ? triggerPath.slice(1) : triggerPath;
}

function isWorkflowBinding(value: unknown): value is Workflow<unknown> {
  return typeof value === 'object' && value !== null && 'create' in value;
}

/**
 * Look up the CF binding for a trigger path. Throws when the path is unknown
 * or the binding is missing — both are deploy/config errors (a workflow with
 * no `wrangler.jsonc` entry, or `bun cf:typegen` not run), not runtime states
 * we should silently swallow.
 */
export function getCfBindingForTriggerPath(
  triggerPath: string,
  env: CloudflareEnv
): Workflow<unknown> {
  const key = normaliseTriggerPath(triggerPath);
  const bindingName = TRIGGER_TO_BINDING[key];
  if (!bindingName) {
    throw new Error(
      `[triggerWorkflow] no workflow binding mapped for trigger path '${key}'. Add it to TRIGGER_TO_BINDING in src/lib/workflow/trigger-bindings.ts.`
    );
  }
  const binding = env[bindingName];
  if (!isWorkflowBinding(binding)) {
    throw new Error(
      `[triggerWorkflow] binding '${String(bindingName)}' for '${key}' is missing or not a Workflow binding. ` +
        `Check wrangler.jsonc and ensure 'bun cf:typegen' has been run.`
    );
  }
  return binding;
}

/**
 * Resolve the CF binding for a stored workflow run id, used by the
 * reconciler to query instance status. Run ids built by `buildInstanceId`
 * have the shape `${envSlug}_${workflowName}_${suffix}` — the workflow name
 * is the second underscore-delimited segment. Returns null for ids that don't
 * map to a known workflow (e.g. legacy QStash run ids), so callers can treat
 * them as unresolvable.
 */
export function getCfBindingForRunId(
  runId: string,
  env: CloudflareEnv
): Workflow<unknown> | null {
  const segments = runId.split('_');
  const workflowName = segments[1];
  if (!workflowName) return null;
  const bindingName = TRIGGER_TO_BINDING[workflowName];
  if (!bindingName) return null;
  const binding = env[bindingName];
  return isWorkflowBinding(binding) ? binding : null;
}

/**
 * Instance states an `already_exists` rejection may legitimately stand in
 * for: the prior instance is still making progress, or already finished its
 * work, so reusing its id is success. `errored`/`terminated` are excluded —
 * that instance will never do the work, and pretending it was enqueued turns
 * a loud failure into a silent no-op. This matters because deduplication ids
 * are not always run-scoped: `shotPromptDedupId`/`musicPromptDedupId` are
 * stable across user requests, so a failed instance would otherwise pin every
 * retry to a dead id for CF's 30-day retention window. `unknown` is excluded
 * too — rethrow rather than trust an id we can't verify.
 */
const REUSABLE_INSTANCE_STATUSES: ReadonlySet<InstanceStatus['status']> =
  new Set([
    'queued',
    'running',
    'paused',
    'waiting',
    'waitingForPause',
    'complete',
  ]);

/**
 * Status of an existing instance, or null when the lookup itself fails — the
 * caller treats null as "not reusable" and rethrows its original error, so a
 * transient lookup failure stays loud rather than minting a fake success.
 */
async function getInstanceStatus<T>(
  binding: Workflow<T>,
  id: string
): Promise<InstanceStatus['status'] | null> {
  try {
    // `binding.get()` returns a WorkflowInstance RPC result; dispose it once
    // we've read the status so the runtime doesn't warn the result leaked.
    const instance = await binding.get(id);
    try {
      return (await instance.status()).status;
    } finally {
      disposeRpcStub(instance);
    }
  } catch {
    return null;
  }
}

/**
 * Trigger a workflow.
 */
export async function triggerCfWorkflow<T extends Rpc.Serializable<T>>({
  binding,
  triggerPath,
  body,
  env,
  deduplicationId,
}: {
  binding: Workflow<T>;
  triggerPath: string;
  body: T;
  env: CloudflareEnv;
  deduplicationId?: string;
}): Promise<CfTriggerResult> {
  const workflowName = normaliseTriggerPath(triggerPath);
  const id = buildInstanceId({
    env,
    workflowName,
    suffix: deduplicationId ?? `${Date.now()}-${crypto.randomUUID()}`,
  });

  try {
    // The created WorkflowInstance is an RPC result; dispose it after reading
    // its id so the runtime doesn't warn about an undisposed result.
    const instance = await binding.create({ id, params: body });
    try {
      return { workflowRunId: instance.id };
    } finally {
      disposeRpcStub(instance);
    }
  } catch (error) {
    // A deterministic id (caller passed `deduplicationId`) hitting
    // `instance.already_exists` usually means a prior attempt of this same
    // logical trigger — typically a `step.do` replay — already created the
    // instance, so the trigger should succeed instead of burning the step's
    // retry budget on a permanent error. But only when the existing instance
    // is verifiably alive or complete (see REUSABLE_INSTANCE_STATUSES):
    // reusing an errored/terminated instance would silently report "enqueued"
    // for work that will never happen. The random-suffix path can't collide
    // legitimately, so it always rethrows.
    if (deduplicationId && isInstanceAlreadyExistsError(error)) {
      const status = await getInstanceStatus(binding, id);
      if (status !== null && REUSABLE_INSTANCE_STATUSES.has(status)) {
        logger.info(
          `[triggerCfWorkflow] ${id} already exists (${status}); reusing existing instance for '${workflowName}'`
        );
        return { workflowRunId: id };
      }
      logger.warn(
        `[triggerCfWorkflow] ${id} already exists but is not reusable (status: ${status ?? 'unavailable'}); rethrowing for '${workflowName}'`
      );
    }
    throw error;
  }
}
