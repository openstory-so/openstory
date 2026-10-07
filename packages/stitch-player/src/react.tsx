/**
 * The React entry: `StitchedPlayer`, safe to import anywhere, including a
 * server render.
 *
 * `@videojs/react` constructs an `AbortController` at module scope, which
 * server runtimes such as Cloudflare Workers reject on import. So this module
 * never imports it: the real surface comes in through a dynamic import that
 * only runs on the client. `lazy()` alone would not do — React calls the
 * loader during a server render — so the element is not rendered at all
 * until the component is on the client (`useIsClient`: a server snapshot of
 * false, a client snapshot of true, no effect and no hydration mismatch).
 */

import { lazy, Suspense, useSyncExternalStore, type ReactNode } from 'react';
import type { StitchedPlayerSurfaceProps } from './stitched-player-surface';

export type { StitchedPlayerSurfaceProps } from './stitched-player-surface';

const Surface = lazy(() =>
  import('./stitched-player-surface').then((m) => ({
    default: m.StitchedPlayerSurface,
  }))
);

const noop = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    noop,
    () => true,
    () => false
  );

export type StitchedPlayerProps = StitchedPlayerSurfaceProps & {
  /** Shown on the server and until the surface's code has loaded. */
  fallback?: ReactNode;
};

export const StitchedPlayer: React.FC<StitchedPlayerProps> = ({
  fallback = null,
  ...props
}) => {
  if (!useIsClient()) return fallback;
  return (
    <Suspense fallback={fallback}>
      <Surface {...props} />
    </Suspense>
  );
};
