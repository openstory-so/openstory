import { fal, type RequestMiddleware } from '@fal-ai/client';
import { configureFalClient } from '@tanstack/ai-fal';

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
 * monkey-patch `fal.config` to compose ours back in. Since 1.1.1 the
 * adapters do not use that singleton: their own client calls `fetch` and
 * only honours `proxyUrl` in a browser. Wrapping `globalThis.fetch` is what
 * reaches those calls. Callers that build a per-request client via
 * `@fal-ai/client`'s `createFalClient(...)` get an independent client whose
 * config closure this monkey-patch can't touch. The two call sites that do
 * (`src/platform/server/storage/external-url.ts` and
 * `scripts/verify-fal-costs.ts`) bypass the proxy intentionally — see the
 * rationale comments there (#890).
 */
export function rewriteFalUrl(
  url: string,
  proxyUrl: string
): { url: string; host: string } | undefined {
  let original: URL;
  try {
    original = new URL(url);
  } catch {
    return undefined;
  }
  if (!FAL_HOSTS.has(original.hostname)) return undefined;
  const proxy = new URL(proxyUrl);
  const rewritten = new URL(proxy.toString());
  rewritten.pathname = proxy.pathname.replace(/\/$/, '') + original.pathname;
  rewritten.search = original.search;
  return { url: rewritten.toString(), host: original.hostname };
}

function installFetchProxy(proxyUrl: string): void {
  const base = globalThis.fetch.bind(globalThis);
  const proxied: typeof fetch = async (input, init) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const rewritten = rewriteFalUrl(raw, proxyUrl);
    if (!rewritten) return base(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set('x-fal-target-host', rewritten.host);
    const nextInit = { ...init, headers };
    if (input instanceof Request) {
      return base(new Request(rewritten.url, input), nextInit);
    }
    return base(rewritten.url, nextInit);
  };
  globalThis.fetch = proxied;
}

export function configureFalProxyFromEnv(): void {
  if (configured) return;
  configured = true;
  const proxyUrl = process.env.FAL_PROXY_URL;
  if (!proxyUrl) return;

  installFetchProxy(proxyUrl);
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
  // `fal.config({})` would install the proxy with the default fetch, which
  // never reads `x-fal-billable-units`. Aimock replays that header (from
  // fixture `billableUnits`) so `@tanstack/ai-fal` can set `usage.billed`
  // — without the billing fetch wrap, e2e stills bill $0 even when
  // `model_pricing` is seeded. Adapters call `configureFalClient` again with
  // the real key; this first call only has to install the wrap.
  configureFalClient({
    apiKey: process.env.FAL_KEY || 'e2e-fal-billing-capture',
  });
}
