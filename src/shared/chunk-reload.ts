/**
 * Reload once when a lazy chunk fails to import after a deploy (#1395).
 *
 * A deploy replaces every hashed chunk filename, but an already-loaded tab
 * still points at the old ones. The next lazy import — a route chunk on
 * navigation, a `React.lazy` component — 404s, and the user sits on
 * "Something went wrong" until they refresh by hand. Reloading fetches fresh
 * HTML, which points at chunks that exist; there is no lighter repair, since
 * the missing chunk is what the render needed.
 *
 * Vite's preload helper wraps every dynamic import and dispatches a cancelable
 * `vite:preloadError` when either the dep preload or the module import
 * rejects — so the event already *means* "a chunk failed to load". We
 * deliberately don't sniff the error message on top of it: the wording is
 * browser-specific ("Failed to fetch dynamically imported module" /
 * "Importing a module script failed"), so a matcher can only ever go stale
 * and silently stop firing.
 */

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'chunk-reload']);

const KEY = 'os:chunk-reloaded-at';

// Not a guess about deploy timing: a successful reload *removes* the stale
// URLs, so staleness cannot recur. This only asks "did I already try this
// remedy on this page?" — bounding a broken deploy to one wasted reload
// instead of a loop. Anything longer than a page load would do.
const RETRY_WINDOW_MS = 10_000;

export function installChunkReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    const now = Date.now();
    try {
      if (now - Number(sessionStorage.getItem(KEY) ?? 0) < RETRY_WINDOW_MS)
        return;
      sessionStorage.setItem(KEY, String(now));
    } catch {
      // No sessionStorage means no loop guard — surface the error instead.
      return;
    }
    logger.warn('stale chunk after deploy, reloading', { err: event.payload });
    event.preventDefault(); // Suppress the throw; we're leaving the page.
    location.reload();
  });
}
