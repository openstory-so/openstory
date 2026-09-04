import { PostHogIdentify } from '@/components/observability/posthog-identify';
import { sessionQueryOptions } from '@/lib/auth/session-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { installChunkReload } from '@/lib/chunk-reload';
import { configureLogging } from '@/lib/observability/logger';
import { flushReactErrors } from '@/lib/observability/react-errors';
import { PostHogProvider } from '@posthog/react';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { RealtimeContext, RealtimeProvider } from '@/lib/realtime/client';
import { lazy, useEffect, useState, type FC } from 'react';

configureLogging();
installChunkReload();

// Wrap the entire lazy() in import.meta.env.DEV so Vite dead-code-eliminates
// the dynamic imports before rollup tries to resolve them. This prevents
// @tanstack/ai-devtools-core's Solid.js transitive imports from breaking the build.
const TanStackDevtoolsLazy: FC =
  import.meta.env.DEV && !import.meta.env.VITE_DISABLE_DEVTOOLS
    ? lazy(async () => {
        const [
          { TanStackDevtools },
          { ReactQueryDevtoolsPanel },
          { TanStackRouterDevtoolsPanel },
          { aiDevtoolsPlugin },
        ] = await Promise.all([
          import('@tanstack/react-devtools'),
          import('@tanstack/react-query-devtools'),
          import('@tanstack/react-router-devtools'),
          import('@tanstack/react-ai-devtools'),
        ]);

        return {
          default: () => (
            <TanStackDevtools
              plugins={[
                {
                  name: 'TanStack Query',
                  render: <ReactQueryDevtoolsPanel />,
                  defaultOpen: true,
                },
                {
                  name: 'TanStack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                  defaultOpen: false,
                },
                aiDevtoolsPlugin(),
              ]}
            />
          ),
        };
      })
    : () => null;

type ProvidersProps = {
  children: React.ReactNode;
  queryClient: QueryClient;
};

const ObservabilityProvider: FC<{
  children: React.ReactNode;
  queryClient: QueryClient;
}> = ({ children, queryClient }) => {
  const posthogToken =
    process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
    import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const apiHost =
    process.env.VITE_PUBLIC_POSTHOG_HOST ||
    import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
    'https://us.posthog.com';

  if (!posthogToken || !apiHost) {
    return children;
  }

  // Bootstrap PostHog with the already-authenticated user (session is
  // SSR-hydrated into the query cache for _app routes). Without this the SDK
  // starts anonymous, so the first page-load events (pageview, web vitals,
  // autocapture) are stamped with the anon device id — and PostHog won't merge
  // a fresh anon device into an already-identified distinct_id, leaving those
  // events unattributed. Bootstrapping starts the SDK already-identified so
  // they carry `user.id` from the first event. PostHogIdentify still handles
  // login/logout transitions within a session.
  const user = queryClient.getQueryData(sessionQueryOptions.queryKey)?.user;

  return (
    <PostHogProvider
      apiKey={posthogToken}
      options={{
        api_host: apiHost,
        defaults: '2025-05-24',
        capture_exceptions: true,
        loaded: flushReactErrors,
        debug: false,
        ...(user && {
          bootstrap: { distinctID: user.id, isIdentifiedID: true },
        }),
      }}
    >
      {children}
    </PostHogProvider>
  );
};

/**
 * Diagnostic kill-switch for the realtime SSE subscription.
 *
 * The stream is now held open by a per-channel Durable Object (#802), so the
 * old reconnect-loop pathology (request-isolate handlers couldn't hold an SSE
 * stream open, so it opened → closed → reconnected forever) is gone. The switch
 * is retained as a general diagnostic to rule realtime out when chasing
 * request-starvation or connection issues.
 *
 * Toggle WITHOUT a rebuild on a deployed preview:
 *   localStorage.setItem('os:disable-realtime', '1'); location.reload();
 * Or at build time: VITE_DISABLE_REALTIME=true.
 */
function useRealtimeEnabled(): boolean {
  const buildDisabled = import.meta.env.VITE_DISABLE_REALTIME === 'true';
  // Default enabled on first render (SSR-safe); apply the localStorage
  // override after mount to avoid a hydration mismatch.
  const [runtimeDisabled, setRuntimeDisabled] = useState(false);
  useEffect(() => {
    try {
      setRuntimeDisabled(
        globalThis.localStorage.getItem('os:disable-realtime') === '1'
      );
    } catch {
      // localStorage unavailable — leave realtime enabled.
    }
  }, []);
  return !buildDisabled && !runtimeDisabled;
}

export function Providers({ children, queryClient }: ProvidersProps) {
  const realtimeEnabled = useRealtimeEnabled();
  return (
    <ObservabilityProvider queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <PostHogIdentify />
          {realtimeEnabled ? (
            <RealtimeProvider>{children}</RealtimeProvider>
          ) : (
            // Stub context so consumers (useRealtime) don't throw; nothing ever
            // registers a channel, so no EventSource is ever opened.
            <RealtimeContext.Provider
              value={{
                status: 'disconnected',
                register: () => {},
                unregister: () => {},
              }}
            >
              {children}
            </RealtimeContext.Provider>
          )}
          <TanStackDevtoolsLazy />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ObservabilityProvider>
  );
}
