import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { DefaultNotFound } from './components/error/default-not-found';
import { captureRouteError } from './lib/observability/react-errors';
import { getQueryClient } from './lib/query-client';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const queryClient = getQueryClient();

  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    context: { queryClient },
    defaultNotFoundComponent: DefaultNotFound,
    // Boundary-caught errors never hit window.onerror; this is how they reach
    // PostHog, with the component stack (#1283).
    defaultOnCatch: captureRouteError,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}
