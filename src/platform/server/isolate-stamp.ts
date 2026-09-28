/**
 * One id per isolate, logged on each request so a memory death can be joined
 * to the other requests that shared the heap.
 *
 * Workers hold console output until the request ends, and a finished request
 * has already flushed under outcome ok. The line has to be written on that
 * request, before it awaits. Cloudflare attaches the URL to the log record;
 * the message carries only this id and a route class, never a path id.
 */

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'isolate']);

/** Stable for the life of this isolate. A new isolate mints a new one. */
export const isolateId: string = crypto.randomUUID();

const ULID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ROUTE_CLASS_LENGTH = 120;

function isIdSegment(segment: string): boolean {
  return ULID_SEGMENT.test(segment) || UUID_SEGMENT.test(segment);
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
 * A stable class for the request. Query strings are dropped. Id-shaped path
 * segments collapse to `:id`. Realtime is classified by channel kind.
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
  if (pathname.startsWith('/r2/')) return 'r2';
  if (pathname === '/' || pathname === '') return 'home';
  const parts = pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (isIdSegment(segment) ? ':id' : segment));
  if (parts.length === 0) return 'home';
  return `/${parts.join('/')}`;
}

function clampRouteClass(routeClass: string): string {
  const trimmed = routeClass.trim();
  if (trimmed.length === 0) return 'unknown';
  return trimmed.slice(0, MAX_ROUTE_CLASS_LENGTH);
}

export function isolateStampMessage(routeClass: string): string {
  return `[isolate] ${isolateId} ${clampRouteClass(routeClass)}`;
}

export function logIsolateStamp(routeClass: string): void {
  const route = clampRouteClass(routeClass);
  logger.info(isolateStampMessage(route), { isolateId, routeClass: route });
}
