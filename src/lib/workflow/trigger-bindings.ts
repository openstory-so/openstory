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
  studio: 'STUDIO_WORKFLOW',
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
 * Extract the workflow (trigger) name from a stored run id. Two id shapes
 * exist:
 *
 *   - Top-level runs (`buildInstanceId`): `${envSlug}_${workflowName}_${suffix}`
 *     — the name is the second underscore-delimited segment.
 *   - Child runs (`buildChildInstanceId`): the sanitized semantic child id,
 *     `${workflowName}_${...}_r${hash}` (child ids are built as
 *     `<trigger-key>:<...>` and `:` sanitizes to `_`) — the name is the FIRST
 *     segment. Without this branch the reconciler treated every parent-spawned
 *     child render as unresolvable and false-failed it mid-flight.
 *
 * Segment[1] is tried first so top-level ids can never be misread as child
 * ids. Returns null when neither segment maps (legacy QStash ids, E2E mock
 * ids).
 */
export function workflowNameFromRunId(runId: string): string | null {
  const segments = runId.split('_');
  for (const segment of [segments[1], segments[0]]) {
    if (segment && segment in TRIGGER_TO_BINDING) return segment;
  }
  return null;
}

/**
 * Resolve the CF binding for a stored workflow run id, used by the
 * reconciler to query instance status. Returns null for ids that don't map
 * to a known workflow (see {@link workflowNameFromRunId}), so callers can
 * treat them as unresolvable.
 */
export function getCfBindingForRunId(
  runId: string,
  env: CloudflareEnv
): Workflow<unknown> | null {
  const workflowName = workflowNameFromRunId(runId);
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
 * stable across user requests. `unknown` is excluded too — rethrow rather than
 * trust an id we can't verify.
 *
 * Excluded from reuse is not the same as terminal: see `triggerCfWorkflow` for
 * what each excluded status does next.
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
 * How many instance ids one deduplication key may burn through. Each
 * generation past the first is a fresh paid job, so the cap is what stops a
 * deterministic failure (a prompt the content checker will always flag) from
 * re-spawning until the step's retry budget runs out. Three = the original plus
 * two retries, matching the reseed budget #881 uses on the render path.
 */
const MAX_TRIGGER_GENERATIONS = 3;

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

async function createInstance<T extends Rpc.Serializable<T>>(
  binding: Workflow<T>,
  id: string,
  body: T
): Promise<CfTriggerResult> {
  // The created WorkflowInstance is an RPC result; dispose it after reading
  // its id so the runtime doesn't warn about an undisposed result.
  const instance = await binding.create({ id, params: body });
  try {
    return { workflowRunId: instance.id };
  } finally {
    disposeRpcStub(instance);
  }
}

/**
 * Trigger a workflow.
 *
 * With a `deduplicationId`, the id is deterministic and an
 * `instance.already_exists` rejection is expected — typically a `step.do`
 * replay re-running its closure. What happens next depends on the existing
 * instance:
 *
 *   - alive or complete (REUSABLE_INSTANCE_STATUSES) → reuse its id. This is
 *     the double-billing guard: a replay must not spawn a second paid job.
 *   - `errored` → the id is a tombstone. The instance will never do the work,
 *     and every retry of the calling step lands on the same corpse, so the
 *     failure is permanently unretryable (#1149: one content-flagged preview
 *     image took down whole sequences this way). Advance to the next
 *     generation id and actually retry, up to MAX_TRIGGER_GENERATIONS.
 *   - `terminated` → someone cancelled this run (`terminateSingleArtifactRun`,
 *     #1085). Re-spawning would resurrect cancelled work, so it stays a
 *     rethrow.
 *   - `unknown`, or the status lookup itself failed → we cannot tell whether a
 *     live instance is already doing this work. Rethrow rather than risk
 *     paying for it twice.
 *
 * Generation probing is deterministic, so it stays replay-safe: a later attempt
 * walks the same ids in the same order and stops at the first reusable one.
 * The random-suffix path (no `deduplicationId`) can't collide legitimately, so
 * it always rethrows.
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

  if (!deduplicationId) {
    return createInstance(
      binding,
      buildInstanceId({
        env,
        workflowName,
        suffix: `${Date.now()}-${crypto.randomUUID()}`,
      }),
      body
    );
  }

  let lastError: unknown;
  for (
    let generation = 1;
    generation <= MAX_TRIGGER_GENERATIONS;
    generation++
  ) {
    const id = buildInstanceId({
      env,
      workflowName,
      suffix: deduplicationId,
      generation,
    });
    try {
      return await createInstance(binding, id, body);
    } catch (error) {
      if (!isInstanceAlreadyExistsError(error)) throw error;
      lastError = error;

      const status = await getInstanceStatus(binding, id);
      if (status !== null && REUSABLE_INSTANCE_STATUSES.has(status)) {
        logger.info(
          `[triggerCfWorkflow] ${id} already exists (${status}); reusing existing instance for '${workflowName}'`
        );
        return { workflowRunId: id };
      }
      if (status !== 'errored') {
        logger.warn(
          `[triggerCfWorkflow] ${id} already exists but is not reusable (status: ${status ?? 'unavailable'}); rethrowing for '${workflowName}'`
        );
        throw error;
      }
      logger.warn(
        `[triggerCfWorkflow] ${id} already exists and errored; advancing to generation ${generation + 1} for '${workflowName}'`
      );
    }
  }

  throw new Error(
    `[triggerCfWorkflow] '${workflowName}' exhausted ${MAX_TRIGGER_GENERATIONS} instance generations for deduplication id '${deduplicationId}' — every one errored`,
    { cause: lastError }
  );
}
