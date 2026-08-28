/**
 * Timeout helpers for fal.ai calls that still lack activity-level controls.
 *
 * Media activities (`generateImage` / `generateAudio` / `generateVideo`) use
 * native `timeout` on `@tanstack/ai@0.44+` (TanStack/ai#981 / PR #1047). This
 * module remains for paths that talk to fal outside those activities:
 * - `getVideoJobStatus` / raw `fal.queue.*` (no activity timeout option)
 * - low-level `falQueueFetch` helpers
 *
 * A hung connection without a bound can stall a Cloudflare Workflow step
 * indefinitely so its retry policy never fires (#826).
 */

/** Wall-clock budget for a fal.subscribe()-style image or audio generation. */
export const FAL_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Per-call budget for short fal operations (queue submit, status, result).
 * Motion / asset workflows already budget total poll time across steps; this
 * only bounds a single hung HTTP request so a dead connection can't freeze
 * one step forever.
 */
export const FAL_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

export function falTimeoutMessage(label: string, timeoutMs: number): string {
  return `${label} timed out after ${Math.round(timeoutMs / 1000)}s`;
}

export function createFalTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(falTimeoutMessage(label, timeoutMs));
}

/**
 * Returns true when `error` (or its abort reason) is one of our timeout
 * failures — used so callers can rethrow a clean message after the fal client
 * wraps the abort.
 */
export function isFalTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/timed out after \d+s$/.test(error.message)) return true;
  const reason = (error as Error & { cause?: unknown }).cause;
  if (reason instanceof Error && /timed out after \d+s$/.test(reason.message)) {
    return true;
  }
  return false;
}

/**
 * `fetch` that aborts once a wall-clock deadline is reached.
 *
 * Create a fresh instance per generation/call so concurrent work does not
 * share a deadline. Each individual request inherits the remaining budget:
 * a hung connection cannot outlive the deadline, and an infinite poll loop
 * of successful short responses still fails when the overall budget expires.
 */
export function createDeadlineFetch(
  timeoutMs: number,
  label: string
): typeof fetch {
  const deadline = Date.now() + timeoutMs;

  return async (input, init) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw createFalTimeoutError(label, timeoutMs);
    }

    const controller = new AbortController();
    const parentSignal = init?.signal;

    const abortFromParent = () => {
      controller.abort(parentSignal?.reason);
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        const reason = parentSignal.reason;
        throw reason instanceof Error
          ? reason
          : new DOMException('The operation was aborted.', 'AbortError');
      }
      parentSignal.addEventListener('abort', abortFromParent, { once: true });
    }

    const timer = setTimeout(() => {
      controller.abort(createFalTimeoutError(label, timeoutMs));
    }, remaining);

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      // Prefer the abort reason (timeout or parent cancel) over a bare
      // AbortError so workflow `statusError` / step retries show why the
      // call failed (#826).
      if (
        isFalTimeoutError(controller.signal.reason) ||
        isFalTimeoutError(error)
      ) {
        throw createFalTimeoutError(label, timeoutMs);
      }
      if (controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}
