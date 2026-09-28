/**
 * One id per isolate, logged on each request so a memory death can be joined
 * to the other requests that shared the heap.
 *
 * Workers hold console output until the request ends, and a finished request
 * has already flushed under outcome ok. The line has to be written on that
 * request, before it awaits. Cloudflare attaches the URL to the log record;
 * the message carries only this id and a route template, never a path id.
 *
 * Workerd rejects `crypto.randomUUID()` at module scope, so the id is minted
 * on the first handler call and reused for the life of the isolate.
 */

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'isolate']);

let cachedIsolateId: string | undefined;

/** Stable for the life of this isolate. A new isolate mints a new one. */
export function getIsolateId(): string {
  cachedIsolateId ??= crypto.randomUUID();
  return cachedIsolateId;
}

const ULID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ROUTE_CLASS_LENGTH = 120;

/**
 * `fullPath` values from `src/routeTree.gen.ts`, trailing slashes removed.
 * `isolate-stamp.test.ts` fails when a route is added and this list is not.
 */
export const ROUTE_FULL_PATHS = [
  '/',
  '/.well-known/$',
  '/admin',
  '/admin/moderation',
  '/admin/usage',
  '/api/auth/$',
  '/api/billing/webhook',
  '/api/openrouter/callback',
  '/api/realtime',
  '/api/storage/multipart',
  '/api/storage/upload',
  '/api/test',
  '/api/test/character',
  '/api/test/image',
  '/api/test/location',
  '/api/test/sequence',
  '/api/test/shot',
  '/api/test/style',
  '/api/test/talent',
  '/api/test/user',
  '/api/test/verify',
  '/api/v1',
  '/api/v1/device/code',
  '/api/v1/device/token',
  '/api/v1/openapi.json',
  '/api/v1/scripts/enhance',
  '/api/v1/sequences',
  '/api/v1/sequences/$id',
  '/api/v1/sequences/$id/exports',
  '/api/v1/styles',
  '/api/v1/styles/$id',
  '/credits',
  '/device',
  '/docs',
  '/docs/$',
  '/docs/dependency-graph',
  '/docs/faq',
  '/docs/llms.md',
  '/gallery',
  '/gift/$code',
  '/images',
  '/llms.txt',
  '/locations',
  '/locations/$locationId',
  '/login',
  '/mcp',
  '/meta/og',
  '/meta/og-github',
  '/meta/og-linkedin',
  '/models',
  '/models/$',
  '/models/family/$',
  '/oauth/consent',
  '/oauth/consent-start',
  '/oauth/login',
  '/pricing',
  '/privacy',
  '/r2/$',
  '/report',
  '/robots.txt',
  '/sequences',
  '/sequences/$id',
  '/sequences/$id/cast',
  '/sequences/$id/cast/$characterId',
  '/sequences/$id/elements',
  '/sequences/$id/elements/$elementId',
  '/sequences/$id/locations',
  '/sequences/$id/locations/$locationId',
  '/sequences/$id/music',
  '/sequences/$id/scenes',
  '/sequences/$id/script',
  '/sequences/$id/theatre',
  '/sequences/new',
  '/sequences/new/scenes',
  '/settings',
  '/settings/api-keys',
  '/settings/developer',
  '/settings/passkeys',
  '/sitemap.xml',
  '/studio',
  '/styles',
  '/talent',
  '/talent/$id',
  '/terms',
  '/verify',
  '/videos',
] as const;

type RouteSegment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'splat' };

type CompiledRoute = {
  segments: RouteSegment[];
  staticCount: number;
};

function compileRoute(fullPath: string): CompiledRoute {
  const segments: RouteSegment[] = fullPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === '$') return { kind: 'splat' };
      if (segment.startsWith('$'))
        return { kind: 'param', name: segment.slice(1) };
      return { kind: 'static', value: segment };
    });
  return {
    segments,
    staticCount: segments.filter((segment) => segment.kind === 'static').length,
  };
}

const STATIC_PATHS = new Set<string>(
  ROUTE_FULL_PATHS.filter((path) => !path.includes('$'))
);

// More static segments first, so `/models/family/$` beats `/models/$`.
const DYNAMIC_ROUTES = ROUTE_FULL_PATHS.filter((path) => path.includes('$'))
  .map(compileRoute)
  .sort(
    (left, right) =>
      right.staticCount - left.staticCount ||
      right.segments.length - left.segments.length
  );

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function isIdSegment(segment: string): boolean {
  return ULID_SEGMENT.test(segment) || UUID_SEGMENT.test(segment);
}

function matchDynamic(parts: string[]): string | null {
  for (const route of DYNAMIC_ROUTES) {
    const rendered: string[] = [];
    let index = 0;
    let matched = true;
    for (const segment of route.segments) {
      if (segment.kind === 'splat') {
        if (index >= parts.length) {
          matched = false;
          break;
        }
        rendered.push('*');
        index = parts.length;
        break;
      }
      const part = parts[index];
      if (part === undefined) {
        matched = false;
        break;
      }
      if (segment.kind === 'param') rendered.push(`:${segment.name}`);
      else if (segment.value === part) rendered.push(part);
      else {
        matched = false;
        break;
      }
      index += 1;
    }
    if (matched && index === parts.length) return `/${rendered.join('/')}`;
  }
  return null;
}

function realtimeClass(url: URL): string {
  const channels = (url.searchParams.get('channels') ?? '')
    .split(',')
    .filter((channel) => channel.length > 0);
  let billing = false;
  let shot = false;
  for (const channel of channels) {
    if (channel.startsWith('billing:')) billing = true;
    else if (channel.startsWith('shot-prompt:')) shot = true;
  }
  if (billing && shot) return 'realtime-mixed';
  if (billing) return 'realtime-billing';
  if (shot) return 'realtime-shot';
  return 'realtime-other';
}

/**
 * A stable class for the request. Query strings are dropped. A file route's
 * dynamic segments become their param names (`/gift/$code` → `/gift/:code`).
 * A splat becomes `*`. Realtime is classified by channel kind.
 */
export function requestRouteClass(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  const { pathname } = parsed;
  if (pathname === '/api/realtime') return realtimeClass(parsed);
  if (pathname.startsWith('/_serverFn/')) return 'serverFn';
  if (pathname === '/assets' || pathname.startsWith('/assets/')) return 'asset';
  const path = normalizePath(pathname);
  if (path === '/' || path === '') return 'home';
  if (STATIC_PATHS.has(path)) return path;
  const parts = path.split('/').filter((segment) => segment.length > 0);
  const dynamic = matchDynamic(parts);
  if (dynamic !== null) return dynamic;
  const masked = parts.map((segment) =>
    isIdSegment(segment) ? ':id' : segment
  );
  if (masked.length === 0) return 'home';
  return `/${masked.join('/')}`;
}

function clampRouteClass(routeClass: string): string {
  const trimmed = routeClass.trim();
  if (trimmed.length === 0) return 'unknown';
  return trimmed.slice(0, MAX_ROUTE_CLASS_LENGTH);
}

export function isolateStampMessage(routeClass: string): string {
  return `[isolate] ${getIsolateId()} ${clampRouteClass(routeClass)}`;
}

export function logIsolateStamp(routeClass: string): void {
  const route = clampRouteClass(routeClass);
  logger.info(`[isolate] ${getIsolateId()} ${route}`, {
    isolateId: getIsolateId(),
    routeClass: route,
  });
}
