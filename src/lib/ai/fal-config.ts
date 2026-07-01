import { createFalClient, fal, type RequestMiddleware } from '@fal-ai/client';

const FAL_HOSTS = new Set([
  'fal.run',
  'queue.fal.run',
  'rest.fal.ai',
  'rest.alpha.fal.ai',
  'gateway.fal.ai',
]);

let configured = false;

function buildProxyMiddleware(proxyUrl: string): RequestMiddleware {
  const proxy = new URL(proxyUrl);
  return async (request) => {
    const original = new URL(request.url);
    if (!FAL_HOSTS.has(original.hostname)) return request;

    const rewritten = new URL(proxy.toString());
    rewritten.pathname = proxy.pathname.replace(/\/$/, '') + original.pathname;
    rewritten.search = original.search;

    return {
      ...request,
      url: rewritten.toString(),
      headers: {
        ...request.headers,
        'x-fal-target-host': original.hostname,
      },
    };
  };
}

function composeMiddleware(
  proxy: RequestMiddleware,
  caller: RequestMiddleware | undefined
): RequestMiddleware {
  if (!caller) return proxy;
  return async (req) => proxy(await caller(req));
}

/**
 * Routes server-side fal.ai traffic through a proxy when FAL_PROXY_URL is set.
 *
 * fal-client's built-in `proxyUrl` only activates in the browser — see
 * `@fal-ai/client/src/middleware.ts` (`withProxy` no-ops when `window` is
 * undefined). Workflows run server-side, so we install a `requestMiddleware`
 * that rewrites fal hosts to the proxy origin while preserving the original
 * pathname. The proxy receives the original host via `x-fal-target-host`.
 *
 * The `@tanstack/ai-fal` adapters call `fal.config({ credentials })` on the
 * singleton and would otherwise wipe any `requestMiddleware` we set, so we
 * monkey-patch `fal.config` to compose ours back in. Per-request clients that
 * need the same routing should use `createProxiedFalClient(...)`; direct
 * `@fal-ai/client` clients intentionally bypass this singleton patch.
 */
export function configureFalProxyFromEnv(): void {
  if (configured) return;
  configured = true;
  const proxyUrl = process.env.FAL_PROXY_URL;
  if (!proxyUrl) return;

  const middleware = buildProxyMiddleware(proxyUrl);

  const originalConfig = fal.config.bind(fal);
  fal.config = (config) => {
    return originalConfig({
      ...config,
      requestMiddleware: composeMiddleware(
        middleware,
        config.requestMiddleware
      ),
    });
  };
  fal.config({});
}

/**
 * Creates a per-request fal client that also respects FAL_PROXY_URL.
 *
 * Use this for script/tooling clients with their own credentials. Some runtime
 * storage shims intentionally use the upstream client directly because fal
 * storage-initiate calls should not be recorded by aimock.
 */
export function createProxiedFalClient(
  config: NonNullable<Parameters<typeof createFalClient>[0]>
): ReturnType<typeof createFalClient> {
  const proxyUrl = process.env.FAL_PROXY_URL;
  if (!proxyUrl) return createFalClient(config);

  return createFalClient({
    ...config,
    requestMiddleware: composeMiddleware(
      buildProxyMiddleware(proxyUrl),
      config.requestMiddleware
    ),
  });
}
