/**
 * Environment utility functions for checking feature availability
 * based on environment variables and deployment context.
 *
 * IMPORTANT: All functions use lazy evaluation to support Cloudflare Workers
 * where process.env is only populated at request time.
 */

import { getEnv } from '#env';

/**
 * Server-side application URL
 * Used by Better Auth, webhooks, and internal API calls
 * Lazily evaluated to support Cloudflare Workers
 */
export function getServerAppUrl(request: Request): string {
  const url = new URL(request.url);
  return url.origin;
}

/**
 * Get production deployment app URL
 * Used for OAuth redirects on preview branches.
 * If VITE_APP_URL env var is set, use that as the canonical production URL.
 * Otherwise fall back to the request origin.
 */
export function getProductionDeploymentAppUrl(request: Request): string {
  const envAppUrl = getEnv().VITE_APP_URL;
  if (envAppUrl) {
    return envAppUrl.replace(/\/$/, '');
  }

  return getServerAppUrl(request);
}

function hostnameFromHostHeader(host: string): string {
  return (host.split(':')[0] ?? host).toLowerCase();
}

function isLoopbackOrBareIp(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/**
 * Is this request being served on a local/network-dev host (localhost or a
 * bare IP)? Real deployments — wherever they are hosted — are always reached
 * by hostname, never a bare IP or localhost.
 *
 * Every present host signal must be local. `X-Forwarded-Host` is not
 * authoritative: a public `Host` with `X-Forwarded-Host: localhost` is how a
 * tunnel request would re-enable the fixed OTP, and a loopback `Host` with a
 * public forwarded host is the shape of some reverse proxies. Fail closed if
 * either is a hostname.
 *
 * This is a host-based, env-independent signal. Unlike IS_PREVIEW_DEPLOYMENT,
 * it does not rely on VITE_APP_URL / NODE_ENV being present in the worker env
 * (they are only declared under wrangler.jsonc [env.test].vars, so they are
 * undefined in production and in the e2e-built worker alike).
 */
export function isLocalRequestHost(request: Request): boolean {
  const hosts = [
    request.headers.get('host'),
    request.headers.get('x-forwarded-host'),
  ].filter((value): value is string => Boolean(value));
  if (hosts.length === 0) return false;
  return hosts.every((host) =>
    isLoopbackOrBareIp(hostnameFromHostHeader(host))
  );
}
