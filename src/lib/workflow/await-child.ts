/**
 * Sub-workflow await helper (Pattern 3 from the investigation).
 *
 * CF Workflows has no `context.invoke()`-equivalent that returns the child's
 * value. This helper composes the documented primitives — `BINDING.create()`,
 * `step.waitForEvent`, and `WorkflowInstance.sendEvent` — into the same
 * "spawn child, await result" shape we get from QStash.
 *
 * Parent side:
 *
 *   const childOutput = await spawnAndAwaitChild(step, {
 *     binding: env.IMAGE_WORKFLOW,
 *     parentBinding: env.STORYBOARD_WORKFLOW,
 *     parentInstanceId: event.instanceId,
 *     childId: 'image:seq-123:shot-7',
 *     childPayload: { ...input, _parent: { ... } },
 *     name: 'spawn-image-7',
 *     timeout: '30 minutes',
 *   });
 *
 * Child side — last step before the workflow returns:
 *
 *   await notifyParent(step, env, event.payload._parent, output);
 *
 * The child's `_parent` slot carries the parent's binding name, instance id,
 * and event type so the leaf workflow doesn't need to know who its caller is.
 */

import { simpleHash } from '@/shared/utils/hash';
import { getLogger } from '@/shared/observability/logger';
import {
  isInstanceAlreadyExistsError,
  isRecipientInFiniteStateError,
} from '@/lib/workflow/errors';
import { disposeRpcStub } from '@/lib/workflow/rpc-dispose';
import type { CloudflareEnv } from '@/lib/workflow/types';
import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'await-child']);

const DEFAULT_TIMEOUT: WorkflowSleepDuration = '30 minutes';

/** Cloudflare's hard limit on workflow instance ids. */
const MAX_INSTANCE_ID_LENGTH = 100;

/**
 * Cloudflare Workflows enforces `^[a-zA-Z0-9_-]+$` on instance IDs. Callers
 * typically pass semantic ids like `image:seq-123:shot-7` with colons —
 * normalise to underscores so `binding.create({ id })` doesn't throw
 * "Workflow instance has invalid id". Truncate to 100 chars (CF limit).
 */
function sanitizeChildId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, MAX_INSTANCE_ID_LENGTH);
}

/**
 * Build the instance id CF creates the child under. Two distinct uniqueness
 * requirements:
 *
 *   1. **Per sibling** — `semanticChildId` already carries the shot/scene id,
 *      so two fan-out children of the same parent run never collide.
 *   2. **Per parent run** — without this, regenerating (a *fresh* parent run
 *      reusing the same semantic `childId`) calls `binding.create({ id })` with
 *      an id a *prior* run already used. CF keeps completed instances around
 *      and rejects the reuse with `instance.already_exists` — permanently, so
 *      the spawn step exhausts its retries and the child never runs. This is
 *      the "regenerate motion → Instance already exists" bug.
 *
 * The parent's instance id is globally unique per run, so a short hash of it is
 * a stable per-run discriminator. We keep the readable semantic id as the head
 * (so the CF dashboard stays debuggable) and append `_r<hash>`. If the combined
 * string would blow CF's 100-char limit, fall back to hashing the full
 * `(parent, child)` tuple so neither the sibling key nor the run key is
 * silently truncated into a collision.
 *
 * Note the event type (parent↔child rendezvous) is *not* run-scoped: an event
 * is delivered to one specific parent instance via `binding.get(id).sendEvent`,
 * so the sibling-unique event type already can't cross runs. Only the
 * `create()` id needs the run discriminator.
 */
export function buildChildInstanceId(
  semanticChildId: string,
  parentInstanceId: string
): string {
  const semantic = semanticChildId.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const runTag = `r${simpleHash(parentInstanceId)}`;
  const room = MAX_INSTANCE_ID_LENGTH - runTag.length - 1; // 1 for the `_` join
  if (semantic.length <= room) {
    return `${semantic}_${runTag}`;
  }
  // Semantic id too long to keep whole alongside the run tag. Hash the full
  // tuple so the truncated sibling key can't collide, keep a readable head.
  const digest = simpleHash(`${parentInstanceId}${semanticChildId}`);
  const head = semantic.slice(0, MAX_INSTANCE_ID_LENGTH - digest.length - 2);
  return `${head}__${digest}`;
}

/**
 * Slot the parent injects into the child's payload so the child knows who
 * to notify. Payload size cost: ~150 bytes.
 */
export type ParentNotifyHint = {
  /** Binding name on `env` (uppercase, matches wrangler.jsonc). */
  bindingName: keyof CloudflareEnv;
  parentInstanceId: string;
  /** Unique event type for this spawn — `${childWorkflowName}-done:${childId}`. */
  eventType: string;
};

type ChildOutcome<TOutput> =
  | { status: 'ok'; output: TOutput }
  | { status: 'failed'; error: string };

/**
 * A workflow binding viewed as a child target: its payload is the child's
 * input plus the `_parent` notify slot this helper injects. Callers pass
 * their `env.*_WORKFLOW` binding directly — `Workflow<TInput>` is assignable
 * because a binding that accepts `TInput` accepts `TInput & {_parent}`.
 */
type ChildWorkflowBinding<TInput> = Workflow<
  TInput & { _parent: ParentNotifyHint }
>;

type SpawnAndAwaitArgs<TInput> = {
  binding: ChildWorkflowBinding<TInput>;
  parentBindingName: keyof CloudflareEnv;
  parentInstanceId: string;
  childId: string;
  childPayload: TInput;
  /** Step name for the spawn `step.do`. */
  spawnStepName: string;
  /** Step name for the `step.waitForEvent`. */
  awaitStepName: string;
  /** Defaults to 30 minutes — long enough for the slowest leaf (motion). */
  timeout?: WorkflowSleepDuration;
};

/**
 * Spawn a child workflow and block until it `sendEvent`s back with its
 * output (or until the timeout expires). The child must call
 * {@link notifyParent} as its last step.
 *
 * Returns the child's typed output. Throws if the child never sends the
 * event (timeout) — the caller should wrap in try/catch if a timed-out
 * child should not fail the parent.
 */
export async function spawnAndAwaitChild<TInput, TOutput>(
  step: WorkflowStep,
  args: SpawnAndAwaitArgs<TInput>
): Promise<TOutput> {
  // The generated env types say bindings are always present, but they're
  // derived from wrangler.jsonc at typegen time — deploy-time config patching
  // (PR previews) or a missing env-block entry can still leave the binding
  // unbound at runtime. One defensive guard here replaces per-call-site checks.
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard against wrangler.jsonc drift
  if (!args.binding) {
    throw new Error(
      `[spawnAndAwaitChild] workflow binding missing on env for childId '${args.childId}'; check the workflows[] blocks in wrangler.jsonc`
    );
  }
  // Event type is keyed off the *semantic* sibling id (shot/scene) — it only
  // has to disambiguate siblings within one parent, since each send targets a
  // specific parent instance. The create() id additionally needs a per-run
  // discriminator so a regenerate doesn't reuse a prior run's instance id.
  const eventType = buildEventType(args.binding, sanitizeChildId(args.childId));
  const childInstanceId = buildChildInstanceId(
    args.childId,
    args.parentInstanceId
  );

  await step.do(args.spawnStepName, async () => {
    try {
      // `binding.create()` returns a WorkflowInstance RPC result on every child
      // spawn; dispose it (we don't need the handle here) or the runtime warns
      // about the leaked result — fires on every child spawn, a primary source
      // of the #933 warning burst.
      const instance = await args.binding.create({
        id: childInstanceId,
        params: {
          ...args.childPayload,
          _parent: {
            bindingName: args.parentBindingName,
            parentInstanceId: args.parentInstanceId,
            eventType,
          },
        },
      });
      disposeRpcStub(instance);
    } catch (error) {
      if (!isInstanceAlreadyExistsError(error)) throw error;
      // A prior attempt of *this* step already created the instance (durable
      // retry after create() landed but before the step result persisted).
      // The id embeds parentInstanceId, so the existing instance belongs to
      // this run and will notify us — proceed to waitForEvent instead of
      // burning retries on a permanent error.
      logger.info(
        `[spawnAndAwaitChild] ${childInstanceId} already exists; reusing this run's instance`
      );
    }
    return { childInstanceId, eventType };
  });

  // step.waitForEvent's generic is constrained to Rpc.Serializable, but
  // `TOutput` is whatever the child workflow returns — by construction that's
  // serializable JSON (workflow results are persisted by CF either way), so
  // we widen to `unknown` at the call site and narrow back via the discriminant.
  let event: { payload: unknown };
  try {
    event = await step.waitForEvent<{ status: 'ok' | 'failed' }>(
      args.awaitStepName,
      {
        type: eventType,
        timeout: args.timeout ?? DEFAULT_TIMEOUT,
      }
    );
  } catch (waitError) {
    // The notify can be lost or land after the deadline even when the child's
    // work succeeded: under the June 7 90-sequence burst a location-bible
    // child finished in 5 minutes but its notify-parent didn't reach the
    // parent within the 30-minute window, failing a sequence whose work was
    // already done. The engine records every instance's terminal status +
    // output (the child's runImpl return — the same value notifyParent would
    // have delivered), so before failing the parent, ask it directly.
    const child = await step.do(
      `${args.awaitStepName}-status-fallback`,
      async () => {
        // `binding.get()` returns a WorkflowInstance RPC result; dispose it once
        // the status read is done so the runtime doesn't warn about a leak.
        // Everything returned below is already flattened to plain JSON, so no
        // stub escapes the step boundary.
        const instance = await args.binding.get(childInstanceId);
        try {
          const { status, output, error } = await instance.status();
          return {
            status,
            // Engine error shape is { name, message }; flatten to a string for
            // the step's serializable return.
            error: error ? `${error.name}: ${error.message}` : null,
            // The output is the child's JSON-serializable runImpl return; carry
            // it through the step boundary as JSON text (absent while the
            // instance is still in flight).
            outputJson: output === undefined ? null : JSON.stringify(output),
          };
        } finally {
          disposeRpcStub(instance);
        }
      }
    );
    if (child.status === 'complete') {
      logger.warn(
        `[spawnAndAwaitChild] ${args.awaitStepName} timed out but child ${childInstanceId} completed; recovering its output from instance status`
      );
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the recovered output is the child's runImpl return value, the same TOutput notifyParent would have delivered
      return (
        child.outputJson === null ? undefined : JSON.parse(child.outputJson)
      ) as TOutput;
    }
    if (child.status === 'errored' || child.status === 'terminated') {
      throw new Error(
        `Child workflow ${args.childId} failed: ${child.error ?? 'no error detail'}`
      );
    }
    // Still queued/running/paused — the await budget is genuinely exhausted.
    throw waitError;
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- payload shape is enforced by notifyParent / notifyParentOfFailure which are the only senders for this event type
  const outcome = event.payload as ChildOutcome<TOutput>;

  if (outcome.status === 'failed') {
    throw new Error(`Child workflow ${args.childId} failed: ${outcome.error}`);
  }
  return outcome.output;
}

/**
 * Send the child's output back to the parent. Call this as the child's
 * last step. The base class wraps `runImpl` failures and routes them
 * through `notifyParentOfFailure` automatically.
 */
export async function notifyParent<TOutput>(
  step: WorkflowStep,
  env: CloudflareEnv,
  hint: ParentNotifyHint | undefined,
  output: TOutput
): Promise<void> {
  if (!hint) return;
  await step.do('notify-parent', async () => {
    // `resolveParentInstance` (via `binding.get()`) returns a WorkflowInstance
    // RPC result; dispose it after the sendEvent so it doesn't leak. Fires on
    // every child completion — a primary source of the #933 warning burst.
    const parent = await resolveParentInstance(env, hint);
    try {
      await sendEventFailFast(parent, {
        type: hint.eventType,
        payload: { status: 'ok', output } satisfies ChildOutcome<TOutput>,
      });
    } finally {
      disposeRpcStub(parent);
    }
  });
}

/**
 * Notify the parent that this child failed. Mirrors {@link notifyParent}: the
 * `sendEvent` runs inside a durable `step.do`, so a transient delivery blip is
 * retried by the engine instead of silently stranding the parent on its
 * `waitForEvent` timeout. Unlike the success path, this MAY throw once retries
 * are exhausted — the base class catches that so a dead parent can't mask the
 * original `runImpl` error.
 */
export async function notifyParentOfFailure(
  step: WorkflowStep,
  env: CloudflareEnv,
  hint: ParentNotifyHint | undefined,
  error: string
): Promise<void> {
  if (!hint) return;
  await step.do('notify-parent-failure', async () => {
    // Dispose the WorkflowInstance RPC result after the sendEvent (see notifyParent).
    const parent = await resolveParentInstance(env, hint);
    try {
      await sendEventFailFast(parent, {
        type: hint.eventType,
        payload: { status: 'failed', error } satisfies ChildOutcome<never>,
      });
    } finally {
      disposeRpcStub(parent);
    }
  });
}

/**
 * `sendEvent` to a parent that already reached a finite state (errored after
 * its `waitForEvent` timeout, completed, terminated) fails with
 * `(instance.in_finite_state)` — permanently. Re-throw as `NonRetryableError`
 * so the wrapping `step.do` fails immediately instead of burning its full
 * retry budget on an unreachable recipient. The original message is preserved
 * so `isRecipientInFiniteStateError` still matches at the base-class boundary.
 */
async function sendEventFailFast(
  parent: WorkflowInstance,
  event: { type: string; payload: ChildOutcome<unknown> }
): Promise<void> {
  try {
    await parent.sendEvent(event);
  } catch (error) {
    if (isRecipientInFiniteStateError(error)) {
      throw new NonRetryableError(
        error instanceof Error ? error.message : String(error),
        'ParentInFiniteState'
      );
    }
    throw error;
  }
}

async function resolveParentInstance(
  env: CloudflareEnv,
  hint: ParentNotifyHint
): Promise<WorkflowInstance> {
  const binding = env[hint.bindingName];
  if (!isWorkflowBinding(binding)) {
    throw new Error(
      `Parent binding '${String(hint.bindingName)}' is not a Workflow binding on env`
    );
  }
  return binding.get(hint.parentInstanceId);
}

function isWorkflowBinding(value: unknown): value is Workflow<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'create' in value &&
    'get' in value
  );
}

/**
 * Cloudflare validates event types against `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`
 * (letters, digits, hyphen, underscore; max 100 chars). Periods and colons are
 * rejected with `workflow.invalid_event_type`, which deterministically fails
 * `sendEvent` (no retry can recover) and leaves the parent's `waitForEvent`
 * hanging until timeout. Map any invalid char to `_`, guarantee a valid first
 * char, and truncate.
 */
export function sanitizeEventType(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
  return /^[a-zA-Z0-9_]/.test(cleaned) ? cleaned : `w_${cleaned}`.slice(0, 100);
}

/**
 * Build the unique event type for a parent→child wait. Including the child
 * ID guarantees two siblings (e.g. fan-out over N scenes) get distinct
 * events and the parent's `waitForEvent` cannot match the wrong sibling.
 */
function buildEventType(binding: Workflow<unknown>, childId: string): string {
  // The binding has no name accessor; we use the constructor name as a
  // best-effort qualifier and rely on `childId` for uniqueness. Join with
  // hyphens (not `:`) and sanitize — `binding.constructor.name` can be a
  // minified identifier (e.g. containing `$`) and the colon is itself invalid.
  const qualifier = binding.constructor.name || 'workflow';
  return sanitizeEventType(`${qualifier}-done-${childId}`);
}
