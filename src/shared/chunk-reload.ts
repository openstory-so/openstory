/**
 * Reload once when a deploy leaves this tab pointing at chunks that are gone
 * or no longer match (#1395, #1513).
 *
 * A deploy replaces every hashed chunk filename, but an already-loaded tab
 * still points at the old ones. The user sits on "Something went wrong" until
 * they refresh by hand. Reloading fetches fresh HTML, which points at chunks
 * that exist; there is no lighter repair, since the missing chunk is what the
 * render needed.
 *
 * Two arrival paths, because staleness has two shapes:
 *
 * 1. The chunk 404s. Vite's preload helper wraps every dynamic import and
 *    dispatches a cancelable `vite:preloadError` when either the dep preload
 *    or the module import rejects — so the event already *means* "a chunk
 *    failed to load". We deliberately don't sniff the error message on top of
 *    it: the wording is browser-specific ("Failed to fetch dynamically
 *    imported module" / "Importing a module script failed"), so a matcher can
 *    only ever go stale and silently stop firing.
 *
 * 2. The chunk *imports* and has the wrong shape. Start's code splitting loads
 *    a route through `lazyRouteComponent(importer, 'component')`; against a
 *    cached-but-mismatched chunk the import resolves to something without the
 *    expected export and the router throws `Cannot read properties of
 *    undefined (reading 'component')`. No preload event fires — nothing
 *    failed to load — so the route boundary is the only place to catch it
 *    (`reloadOnStaleRouteChunk`, called from `captureRouteError`).
 *
 * The second path has to match on *something*, and the least fragile signal is
 * the frame's file: Vite names that chunk after the module it splits at, so
 * the stack carries `/assets/lazyRouteComponent-<hash>.js`. That is a build
 * artifact of the router's own file layout, not a browser-authored message,
 * so it doesn't drift the way the path-1 wording would.
 */

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'chunk-reload']);

const KEY = 'os:chunk-reloaded-at';

// Not a guess about deploy timing: a successful reload *removes* the stale
// URLs, so staleness cannot recur. This only asks "did I already try this
// remedy on this page?" — bounding a broken deploy to one wasted reload
// instead of a loop. Anything longer than a page load would do.
const RETRY_WINDOW_MS = 10_000;

/**
 * True when this page load may spend its one reload. Shared by both arrival
 * paths so a 404 chunk and a mismatched one can't each burn a reload.
 */
function claimReload(): boolean {
  const now = Date.now();
  try {
    if (now - Number(sessionStorage.getItem(KEY) ?? 0) < RETRY_WINDOW_MS)
      return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // No sessionStorage means no loop guard — surface the error instead.
    return false;
  }
  return true;
}

export function installChunkReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    if (!claimReload()) return;
    logger.warn('stale chunk after deploy, reloading', { err: event.payload });
    event.preventDefault(); // Suppress the throw; we're leaving the page.
    location.reload();
  });
}

/** Reload once if `error` looks like a route chunk that loaded but mismatched. */
export function reloadOnStaleRouteChunk(error: unknown): void {
  const stack = error instanceof Error ? error.stack : undefined;
  if (!stack?.includes('lazyRouteComponent')) return;
  if (!claimReload()) return;
  logger.warn('stale route chunk after deploy, reloading', { err: error });
  location.reload();
}
