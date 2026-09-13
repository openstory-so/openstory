/**
 * Reload once after a deploy leaves this tab on stale assets (#1395, #1557).
 *
 * Two failure modes share one cooldown:
 *
 * 1. A lazy chunk 404s (`vite:preloadError`). Vite's preload helper wraps
 *    every dynamic import, so one window listener covers them. We don't sniff
 *    the error message: the wording is browser-specific.
 * 2. A server function id from the previous build 404s with
 *    `x-os-stale-server-fn`. TanStack Start would otherwise treat the bare
 *    `HTTPError` JSON as the call's payload and resolve `undefined`.
 *
 * Reloading fetches fresh HTML. The page keeps running for a beat after
 * `location.reload()`; `isReloadPending` lets the route boundary stay quiet.
 */

import { getLogger } from '@/platform/logger';
import { STALE_SERVER_FN_HEADER } from '@/platform/stale-server-fn';

const logger = getLogger(['openstory', 'ui', 'chunk-reload']);

const KEY = 'os:chunk-reloaded-at';

// Not a guess about deploy timing: a successful reload *removes* the stale
// URLs, so staleness cannot recur. This only asks "did I already try this
// remedy on this page?" — bounding a broken deploy to one wasted reload
// instead of a loop. Anything longer than a page load would do.
const RETRY_WINDOW_MS = 10_000;

let reloadPending = false;

/** True once this page has called `location.reload()` and is on its way out. */
export function isReloadPending(): boolean {
  return reloadPending;
}

function tryReload(reason: string, err?: unknown): boolean {
  const now = Date.now();
  try {
    if (now - Number(sessionStorage.getItem(KEY) ?? 0) < RETRY_WINDOW_MS) {
      return false;
    }
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // No sessionStorage means no loop guard — surface the error instead.
    return false;
  }
  logger.warn(reason, err ? { err } : undefined);
  reloadPending = true;
  location.reload();
  return true;
}

export function installChunkReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    if (tryReload('stale chunk after deploy, reloading', event.payload)) {
      event.preventDefault(); // Suppress the throw; we're leaving the page.
    }
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await origFetch(input, init);
    if (response.headers.get(STALE_SERVER_FN_HEADER) !== '1') return response;
    if (tryReload('stale server function after deploy, reloading')) {
      // Don't let Start treat the 404 body as the fn result.
      return new Promise(() => {});
    }
    return response;
  };
}
