/**
 * `?wait=` long-polling for `/api/v1`.
 *
 * Agents routinely create something, then want to "see the result" — but they
 * rarely have a sleep tool of their own, so they busy-poll (burning rate limit)
 * or give up too early. `?wait=60s` lets the *server* hold the request open and
 * return the moment the resource changes (or reaches a terminal state), up to a
 * cap. It also gives an agent a window to catch logs/activity that appear soon
 * after an action.
 *
 * Accepted forms: `30` (seconds), `45s`, `2m`, `1500ms`. Clamped to
 * [0, MAX_WAIT_MS]; `0`/absent means "return immediately" (normal GET). A
 * present-but-unparseable value is rejected (so an agent that mis-guesses the
 * syntax learns via a 400 rather than a silent downgrade to a busy-poll).
 */

import { ValidationError } from '@/shared/errors';

const MAX_WAIT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Parse a `wait` value into clamped ms.
 *   - absent (null / empty / whitespace) → `0` (immediate, valid)
 *   - valid (`"60s"`, `"2m"`, `"1500ms"`, `"30"`) → clamped `[0, MAX_WAIT_MS]`
 *   - present but malformed (`"soon"`, `"-5"`, `"30x"`) → `null`
 */
export function parseWaitParam(raw: string | null | undefined): number | null {
  if (raw == null) return 0;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return 0;
  const match = /^(\d+)(ms|s|m)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const ms =
    unit === 'ms' ? value : unit === 'm' ? value * 60_000 : value * 1_000;
  return Math.min(Math.max(ms, 0), MAX_WAIT_MS);
}

/**
 * Read and parse the `wait` query param, throwing a 400 `ValidationError` when
 * it's present but unparseable. Call this BEFORE any side effects so a bad
 * `wait` fails fast.
 */
export function getWaitMs(request: Request): number {
  const ms = parseWaitParam(new URL(request.url).searchParams.get('wait'));
  if (ms === null) {
    throw new ValidationError(
      'Invalid "wait" parameter. Use a duration like "60s", "2m", "1500ms", or a number of seconds (capped at 90s).'
    );
  }
  return ms;
}

/** Abort-aware sleep. Resolves early (does not reject) if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export type LongPollOptions<T> = {
  /** Total time to wait. `0` returns after the first load. */
  waitMs: number;
  /** Load the current resource value. Called once per poll. */
  load: () => Promise<T>;
  /** Change-detection key; polling returns when it differs from the baseline. */
  cursor: (value: T) => string;
  /** Terminal predicate; polling returns immediately when true. */
  done: (value: T) => boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to a real abort-aware sleep. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
};

export type LongPollResult<T> = {
  value: T;
  /** True if the cursor advanced from the baseline during the wait. */
  changed: boolean;
  /** True if the terminal predicate held when we returned. */
  done: boolean;
  waitedMs: number;
};

/**
 * Poll `load` until the resource reaches a terminal state, its `cursor` changes
 * from the first read, the deadline passes, or the request aborts. Returns the
 * latest value either way (a long-poll never errors on timeout — it just returns
 * the current snapshot).
 */
export async function longPoll<T>(
  opts: LongPollOptions<T>
): Promise<LongPollResult<T>> {
  const {
    waitMs,
    load,
    cursor,
    done,
    signal,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleepFn = sleep,
    now = Date.now,
  } = opts;

  const start = now();
  let value = await load();

  if (waitMs <= 0 || done(value)) {
    return {
      value,
      changed: false,
      done: done(value),
      waitedMs: now() - start,
    };
  }

  const baseline = cursor(value);
  const deadline = start + waitMs;

  while (now() < deadline && !signal?.aborted) {
    const remaining = deadline - now();
    await sleepFn(Math.min(pollIntervalMs, remaining), signal);
    if (signal?.aborted) break;
    value = await load();
    if (done(value) || cursor(value) !== baseline) {
      return {
        value,
        changed: cursor(value) !== baseline,
        done: done(value),
        waitedMs: now() - start,
      };
    }
  }

  return {
    value,
    changed: cursor(value) !== baseline,
    done: done(value),
    waitedMs: now() - start,
  };
}
