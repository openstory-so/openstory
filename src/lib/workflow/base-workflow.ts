/**
 * Base class for Cloudflare Workflows entrypoints.
 *
 * Wraps `run()` with a sanitized failure handler that mirrors the QStash
 * `failureFunction` contract — when the workflow body throws, the wrapper
 * extracts a friendly message, calls a subclass-supplied `onFailure` (typed),
 * and rethrows so CF marks the instance as `errored`.
 *
 * Subclasses implement `runImpl(event, step, scopedDb)` and optionally
 * `onFailure({ event, error, scopedDb })`. The base class:
 *   - Validates `userId` / `teamId` on the payload (same contract as
 *     `createScopedWorkflow`'s teamId middleware).
 *   - Builds a `ScopedDb` from the payload and hands it to both `runImpl`
 *     and `onFailure`.
 *   - Sanitizes the error message and emits it in a `step.do('emit-failure')`
 *     so the failure write itself benefits from retries + step durability.
 */

import { getEnv } from '#env';
import { getDb } from '#db-client';
import { configureFalProxyFromEnv } from '@/lib/ai/fal-config';
import { ensureLocalModelPricingSeeded } from '@/lib/db/seed-model-pricing';
import { createScopedDb } from '@/lib/db/scoped';
import {
  toWorkflowScopedDb,
  type WorkflowScopedDb,
} from '@/lib/db/scoped-workflow';
import {
  isEngineAbortError,
  isRecipientInFiniteStateError,
  WorkflowValidationError,
} from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type { UserWorkflowContext } from '@/lib/workflow/types';
import {
  notifyParent,
  notifyParentOfFailure,
  type ParentNotifyHint,
} from '@/lib/workflow/await-child';
import type { CloudflareEnv } from '@/lib/workflow/types';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { flushAnalytics } from '@/lib/observability/flush-analytics';
import { getLogger, serializeError } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'cf', 'base']);

async function zeroOwnedReservation(
  payload: UserWorkflowContext,
  scopedDb: WorkflowScopedDb
): Promise<void> {
  if (!payload.ownsReservation || !payload.reservationId) return;
  try {
    await scopedDb.billing.zeroReservation(payload.reservationId);
  } catch (err) {
    logger.error(
      `[${payload.reservationId}] Failed to zero owned reservation:`,
      { err }
    );
  }
}

let e2ePricingSeed: Promise<unknown> | null = null;

async function ensureE2eModelPricing(): Promise<void> {
  if (getEnv().E2E_TEST !== 'true') return;
  e2ePricingSeed ??= ensureLocalModelPricingSeeded(getDb());
  await e2ePricingSeed;
}

/**
 * Read the `_parent` notify hint a parent workflow injects via
 * `spawnAndAwaitChild`. The runtime payload may carry the slot even though
 * the typed `T` doesn't include it (Pattern 3 injects it as an addition).
 */
function extractParentHint(payload: unknown): ParentNotifyHint | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime-injected slot not part of the typed payload shape
  const hint = (payload as { _parent?: ParentNotifyHint })._parent;
  if (!hint) return undefined;
  if (
    typeof hint.bindingName === 'string' &&
    typeof hint.parentInstanceId === 'string' &&
    typeof hint.eventType === 'string'
  ) {
    return hint;
  }
  return undefined;
}

export type OpenStoryFailureContext<T extends UserWorkflowContext> = {
  event: Readonly<WorkflowEvent<T>>;
  error: string;
  scopedDb: WorkflowScopedDb;
};

export abstract class OpenStoryWorkflowEntrypoint<
  T extends UserWorkflowContext,
> extends WorkflowEntrypoint<CloudflareEnv, T> {
  /**
   * Subclasses implement workflow logic here. Receives the same `event` /
   * `step` the engine hands to `run()`, plus a `WorkflowScopedDb` bound to the
   * payload's `(teamId, userId)` — the full write surface, but reads only via
   * the enumerated `liveRead` escape hatch. Everything else must be
   * snapshotted onto the payload by the server fn that triggered the run.
   */
  protected abstract runImpl(
    event: Readonly<WorkflowEvent<T>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<unknown>;

  /**
   * Optional failure hook. Runs inside a `step.do('emit-failure')` so the
   * cleanup write itself is retried by the engine; if it still throws after
   * its retry budget the error is logged and swallowed (the cron reconciler
   * is the backstop). The original error is rethrown after this returns —
   * the workflow ends in `errored` state.
   */
  protected onFailure?(
    failure: OpenStoryFailureContext<T>
  ): Promise<void> | void;

  override async run(
    event: Readonly<WorkflowEvent<T>>,
    step: WorkflowStep
  ): Promise<unknown> {
    if (!event.payload.teamId || !event.payload.userId) {
      throw new Error(
        `[${this.constructor.name}] payload missing teamId or userId — every workflow extending OpenStoryWorkflowEntrypoint must include both`
      );
    }

    const scopedDb = toWorkflowScopedDb(
      createScopedDb(event.payload.teamId, event.payload.userId)
    );

    // Install the fal→proxy middleware on the global `fal` singleton before any
    // step runs a fal adapter. In E2E this routes fal.run / queue.fal.run to the
    // aimock proxy (FAL_PROXY_URL); in prod it's a no-op (FAL_PROXY_URL unset).
    // The QStash-era base-workflow did this at the top of run(); the CF Workflows
    // rewrite (a8011203) dropped it, so workflow fal calls bypassed aimock and
    // hit real endpoints even in replay. Idempotent (module-flag guarded), so
    // running it per workflow invocation / retry is safe. See lib/ai/fal-config.
    configureFalProxyFromEnv();
    // Workflow isolates never run the fetch handler's self-seed. Replay
    // stills bill $0 (and spam `reportMissingBillingCost`) when this
    // isolate's D1 has no `model_pricing` rows.
    await ensureE2eModelPricing();

    // Pull the parent notify hint once — used on both success and failure
    // paths so a parent's `spawnAndAwaitChild` always sees a terminal event.
    const parentHint = extractParentHint(event.payload);

    try {
      const result = await this.runImpl(event, step, scopedDb);
      await zeroOwnedReservation(event.payload, scopedDb);

      // Notify the parent on success (Pattern 3 fan-in). No-op for top-level
      // workflows that weren't spawned via spawnAndAwaitChild.
      if (parentHint) {
        try {
          await notifyParent(step, this.env, parentHint, result);
        } catch (notifyError) {
          if (!isRecipientInFiniteStateError(notifyError)) throw notifyError;
          // The parent already reached a finite state (typically: its
          // waitForEvent timed out and it errored). This child's work is done
          // and persisted — failing the child here would retroactively mark
          // completed work as failed (issue #839). Log and return normally.
          logger.warn(
            `[${this.constructor.name}] parent ${parentHint.parentInstanceId} already in a finite state; work completed, skipping notify`,
            { err: notifyError }
          );
        }
      }
      return result;
    } catch (error) {
      // Engine shutdown ("Aborting engine: Grace period complete") is a
      // transient interruption — CF resumes the instance from its step cache
      // afterwards. Running onFailure here would mark user-facing rows failed
      // for work that is about to continue, and notifying the parent of
      // failure would poison its waitForEvent. Rethrow untouched. (#839)
      if (isEngineAbortError(error)) {
        logger.warn(
          `[${this.constructor.name}] engine aborted mid-run (transient — instance resumes): ${sanitizeFailResponse(error)}`,
          { err: error }
        );
        throw error;
      }

      const sanitized = sanitizeFailResponse(error);
      // Sanitized message inline in the headline; `err` carries the full
      // original error (with stack) plus its `.cause` chain as a structured
      // property — so a wrapped driver error (e.g. D1 under DrizzleQueryError)
      // is logged rather than dropped. Note the chain is only intact if the
      // error hasn't already crossed a CF step boundary (#864).
      logger.error(`[${this.constructor.name}] Failure: ${sanitized}`, {
        err: serializeError(error),
      });

      if (this.onFailure || event.payload.ownsReservation) {
        // Wrap in step.do so cleanup retries on its own merits. The catch
        // sits OUTSIDE the step — catching inside would make the step
        // succeed on the first attempt and silently skip the engine's
        // retries. If cleanup still fails after its retry budget, log and
        // swallow: the original error must stay the instance's terminal
        // state, and a row stranded by the failed cleanup (e.g. a sequence
        // left 'processing') is healed by the cron reconciler via its
        // persisted workflowRunId (see lib/cron/reconcile-all.ts).
        try {
          await step.do('emit-failure', async () => {
            await zeroOwnedReservation(event.payload, scopedDb);
            await this.onFailure?.({ event, error: sanitized, scopedDb });
          });
        } catch (cleanupError) {
          // An engine abort mid-cleanup is the same transient interruption
          // as one mid-run: rethrow untouched so CF resumes the instance,
          // instead of mislabelling it a cleanup failure and notifying the
          // parent of a failure that is about to continue. (#839)
          if (isEngineAbortError(cleanupError)) throw cleanupError;
          logger.error(
            `[${this.constructor.name}] onFailure handler itself failed:`,
            {
              err: cleanupError,
            }
          );
        }
      }

      // Notify the parent on failure too — otherwise a parent's
      // `step.waitForEvent` would hang until its timeout. The send is durable
      // (retried inside its own step.do); if delivery is still impossible after
      // retries we swallow here so it can't mask the original error.
      if (parentHint) {
        try {
          await notifyParentOfFailure(step, this.env, parentHint, sanitized);
        } catch (notifyError) {
          if (isRecipientInFiniteStateError(notifyError)) {
            // Expected when the parent's waitForEvent already timed out —
            // nothing left to notify. Warn (not error) to keep the error
            // stream meaningful. (#839)
            logger.warn(
              `[${this.constructor.name}] parent ${parentHint.parentInstanceId} already in a finite state; failure notification skipped`,
              { err: notifyError }
            );
          } else {
            logger.error(
              `[${this.constructor.name}] failure notification to parent exhausted retries`,
              { err: notifyError }
            );
          }
        }
      }

      // `WorkflowValidationError` is a plain Error subclass, which CF treats as
      // retryable — so without this re-wrap CF would retry validation throws up
      // to the step's retry limit (10× by default). Re-throw as CF's
      // `NonRetryableError` so the instance fails immediately.
      if (error instanceof WorkflowValidationError) {
        throw new NonRetryableError(sanitized, error.name);
      }
      throw error;
    } finally {
      // Push buffered PostHog events + AI OTel spans before this invocation's
      // isolate is torn down. Nothing else covers workflows: the other flush
      // callers are the server-fn middleware, the request middleware, and the
      // auth route — and almost every instrumented LLM/media call in the app
      // runs in here, not in any of those. Without this the spans sit in the
      // BatchSpanProcessor buffer and die with the isolate.
      //
      // Awaited directly rather than routed through `#flush-scheduler`: that
      // indirection exists to keep the flush off a request's critical path
      // (#770), which is a latency concern workflows don't have. `run()` has
      // no response to block, and awaiting is deterministic where `waitUntil`
      // is not. `flushAnalytics` never rejects, so this cannot mask the error
      // being propagated on the throw path.
      //
      // Residual gap: a workflow that hibernates mid-run can still lose the
      // spans buffered by the isolate it hibernated from — `run()` re-executes
      // from the top on resume, so this `finally` only covers the invocation
      // that reaches a terminal state. The processor's own timer is what
      // covers the rest.
      await flushAnalytics();
    }
  }
}
