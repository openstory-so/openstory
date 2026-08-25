/**
 * Route error boundary → PostHog (#1283).
 *
 * An error a boundary catches never reaches `window.onerror`, so PostHog's
 * exception autocapture missed every "Something went wrong" screen (the
 * insertBefore/removeChild crashes). TanStack Router's `defaultOnCatch` runs
 * from the route boundary's `componentDidCatch` — every route level, root
 * included — with React's component stack.
 *
 * PostHog inits in a provider effect, so a boundary hit during the first
 * render queues until the SDK's `loaded` callback calls `flushReactErrors`.
 */

import { errorCode } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import posthog from 'posthog-js';
import type { ErrorInfo } from 'react';

const logger = getLogger(['openstory', 'ui', 'react-errors']);

type Pending = [error: unknown, props: Record<string, unknown>];

// Bounded: without a PostHog token the SDK never loads, so this never drains.
const MAX_PENDING = 20;
const pending: Pending[] = [];

export function captureRouteError(error: unknown, info: ErrorInfo): void {
  // A 404 from a stale link renders the not-found page; not an app error.
  if (errorCode(error) === 'NOT_FOUND') return;
  const props = {
    component_stack: info.componentStack ?? null,
    // Chrome translate leaves these wrappers; lets the dashboard split
    // translate-induced failures from real ones.
    page_translated:
      typeof document !== 'undefined' &&
      document.querySelector('font[style*="vertical-align: inherit"]') !== null,
  };
  logger.error('route boundary caught error', { err: error, ...props });
  if (posthog.__loaded) {
    posthog.captureException(error, props);
  } else if (pending.length < MAX_PENDING) {
    pending.push([error, props]);
  }
}

export function flushReactErrors(): void {
  for (const [error, props] of pending.splice(0)) {
    posthog.captureException(error, props);
  }
}
