/**
 * Reload once when a lazy chunk fails to import after a deploy (#1395).
 *
 * A deploy replaces every hashed chunk filename, but an already-loaded tab
 * still points at the old ones. The next lazy import — a route chunk on
 * navigation, a `React.lazy` component — 404s, and the user sits on
 * "Something went wrong" until they refresh by hand.
 *
 * Vite's preload helper wraps every dynamic import and dispatches a
 * cancelable `vite:preloadError` when one fails, so a single window listener
 * covers all of them. Reloading fetches fresh HTML, which points at chunks
 * that exist.
 */

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'chunk-reload']);

const KEY = 'os:chunk-reloaded-at';

// Long enough that a genuinely broken deploy can't reload-loop, short enough
// that a long-lived tab still gets its one reload on the *next* deploy.
const COOLDOWN_MS = 10_000;

const CHUNK_ERROR = /dynamically imported module|module script failed/i;

function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return CHUNK_ERROR.test(message);
}

/** Returns true when it triggered a reload. */
export function reloadOnceForChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;
  const now = Date.now();
  try {
    if (now - Number(globalThis.sessionStorage.getItem(KEY) ?? 0) < COOLDOWN_MS)
      return false;
    globalThis.sessionStorage.setItem(KEY, String(now));
  } catch {
    // No sessionStorage means no loop guard — show the error instead.
    return false;
  }
  logger.warn('stale chunk after deploy, reloading', { err: error });
  globalThis.location.reload();
  return true;
}

export function installChunkReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForChunkError(event.payload)) event.preventDefault();
  });
}
