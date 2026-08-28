/**
 * Non-retryable error for validation failures.
 * Used when input is invalid, missing required fields, or fails validation rules.
 *
 * The Cloudflare base class (`OpenStoryWorkflowEntrypoint`) detects this type
 * at the `runImpl` boundary and re-throws it as a `NonRetryableError` so the
 * workflow engine fails the instance immediately instead of retrying.
 *
 * @example
 * throw new WorkflowValidationError('Script is too short (minimum 50 characters)');
 */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return '';
}

/**
 * True when the platform is tearing the instance down mid-run — a transient
 * interruption after which CF RESUMES the instance from its persisted step
 * cache, not a workflow failure. Two spellings:
 *   - `Aborting engine: Grace period complete` — engine restart (#839,
 *     2026-06-06 mass-abort cascade).
 *   - `Durable Object reset because its code was updated` — a Worker deploy
 *     evicting the isolate under an in-flight step (#1331, 2026-08-26: 16
 *     user-visible failures across 6 deploys).
 * The base class must not run `onFailure` (which would mark user-facing rows
 * failed) or notify the parent of failure. Matched on message text — the
 * thrown value's class isn't part of the public API — and on the full phrase,
 * because a true positive here skips onFailure AND parent notification, so an
 * app error that merely mentions a grace period or a reset must never match.
 */
export function isEngineAbortError(error: unknown): boolean {
  return /aborting engine|grace period complete|reset because its code was updated/i.test(
    errorMessage(error)
  );
}

/**
 * True when `sendEvent` was rejected because the target instance already
 * reached a finite state — `(instance.in_finite_state) Instance reached a
 * finite state, cannot send events to it`. Happens when a child outlives its
 * parent's `waitForEvent` timeout: the parent is errored, so notifying it is
 * permanently impossible. The child's own work has already landed in the DB,
 * so this must not be treated as a child failure. See issue #839.
 */
export function isRecipientInFiniteStateError(error: unknown): boolean {
  return /in_finite_state|finite state/i.test(errorMessage(error));
}

/**
 * CF surfaces a reused instance id as `(instance.already_exists) Instance
 * already exists`. Match on the message defensively (the thrown value's class
 * isn't part of the public API) so an in-run durable retry — where `create()`
 * succeeded but the step's result wasn't persisted before a crash — is treated
 * as success instead of a hard failure. Anchored on the `instance` token so an
 * unrelated "already exists" error (user, bucket, table…) from another layer
 * is never misclassified as a duplicate workflow instance.
 */
export function isInstanceAlreadyExistsError(error: unknown): boolean {
  return /instance\.already_exists|instance already exists/i.test(
    errorMessage(error)
  );
}
