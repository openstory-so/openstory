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
 * Used by Better Auth, QStash webhooks, and internal API calls
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

function isProductionDeployment(request: Request): boolean {
  return (
    !isLocalDevelopment() &&
    getProductionDeploymentAppUrl(request) === getServerAppUrl(request)
  );
}

/**
 * Check if this is a preview deployment.
 * Preview if: VITE_APP_URL is explicitly empty, or VITE_APP_URL doesn't match the request origin.
 */
export function isPreviewDeployment(request: Request): boolean {
  if (isLocalDevelopment()) return false;

  const envAppUrl = getEnv().VITE_APP_URL;

  // VITE_APP_URL explicitly set to empty string or not set = preview branch
  if (!envAppUrl) return true;

  // Otherwise check VITE_APP_URL to see if it's a PR url
  if (envAppUrl.includes('pr-')) {
    return true;
  }

  return !isProductionDeployment(request);
}

/**
 * Check if we're running in local development environment
 */
function isLocalDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

/**
 * Is this request being served on a local/network-dev host (localhost or a
 * bare IP)? Mirrors the local-access check in src/routes/__root.tsx: real
 * deployments — wherever they are hosted — are always reached by hostname,
 * never a bare IP or localhost.
 *
 * This is a host-based, env-independent signal. Unlike isProductionDeployment(),
 * it does not rely on VITE_APP_URL / NODE_ENV being present in the worker env
 * (they are only declared under wrangler.jsonc [env.test].vars, so they are
 * undefined in production and in the e2e-built worker alike).
 */
export function isLocalRequestHost(request: Request): boolean {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;
  const hostname = (host.split(':')[0] ?? host).toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/**
 * Is Google OAuth configured (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET set)?
 * Single source of truth for Google sign-in availability: gates both the
 * better-auth socialProviders registration (src/lib/auth/config.ts) and the
 * login form's Google button (via getAuthOptionsFn). Environments
 * without the secrets — local dev by default, PR previews (whose hosts have
 * no registered OAuth redirect URIs, so the deploy workflow doesn't push
 * them) — simply don't offer Google.
 */
export function isGoogleAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
