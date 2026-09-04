/**
 * Which OAuth scope a `/api/v1` request needs (#1456).
 *
 * Only OAuth bearer tokens are scoped; an `osk_` key has the full API. Cheap
 * reads need `sequences:read`; edits and exports need `sequences:write`;
 * anything that spends credits needs `generate`.
 */

import type { OAuthApiScope } from '@/lib/auth/oauth-scopes';
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
  const relative = pathname.slice(API_V1_BASE.length) || '/';
  const method = request.method.toUpperCase();

  if (
    relative === '/' ||
    relative.startsWith('/openapi.json') ||
    relative.startsWith('/device/')
  ) {
    return null;
  }
  if (!MUTATING_METHODS.has(method)) return 'sequences:read';
  if (GENERATE_PATHS.some((pattern) => pattern.test(relative))) {
    return 'generate';
  }
  return 'sequences:write';
}
