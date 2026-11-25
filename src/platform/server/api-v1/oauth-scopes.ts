/**
 * Which OAuth scope a `/api/v1` request needs (#1456).
 *
 * Only OAuth bearer tokens are scoped; an `osk_` key has the full API. Cheap
 * reads need `sequences:read`; edits and exports need `sequences:write`;
 * anything that spends credits needs `generate`; every `/gateway` request,
 * reads included, needs `models:invoke`.
 */

import type { OAuthApiScope } from '@/platform/server/auth/oauth-scopes';
import { API_V1_BASE } from './hal';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths (relative to `/api/v1`) whose mutations spend credits. */
const GENERATE_PATHS = [/^\/sequences\/?$/, /^\/scripts\/enhance\/?$/];

/**
 * The scope required for `request`, or `null` when the route is public
 * (root discovery, OpenAPI document, device-code login).
 */
export function requiredOAuthScope(request: Request): OAuthApiScope | null {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(API_V1_BASE)) return null;
  // Read as the router matches: case-insensitive, decoded, empty segments dropped.
  const relative = routerPath(pathname.slice(API_V1_BASE.length)) || '/';
  const method = request.method.toUpperCase();

  if (
    relative === '/' ||
    relative.startsWith('/openapi.json') ||
    relative.startsWith('/device/')
  ) {
    return null;
  }
  if (relative === '/gateway' || relative.startsWith('/gateway/')) {
    return 'models:invoke';
  }
  if (!MUTATING_METHODS.has(method)) return 'sequences:read';
  if (GENERATE_PATHS.some((pattern) => pattern.test(relative))) {
    return 'generate';
  }
  return 'sequences:write';
}

function routerPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // Malformed escapes: match on the raw path.
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/');
}
